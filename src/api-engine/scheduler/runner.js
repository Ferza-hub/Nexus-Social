'use strict';

// Campaign + post-queue cron runner
//
//  Every 30s: process running GROWTH / HYBRID campaigns (Playwright actions)
//  Every 60s: drain post_queue (CONTENT / HYBRID publish)
//  Every 5min: auto-complete finished campaigns

require('dotenv').config();
const cron = require('node-cron');
const { makeLogger } = require('../../utils/logger');
const { publishPost } = require('../actions/post');
const q = require('./queue');

const log = makeLogger('Runner');

// Lazy-load playwright engine to avoid circular dep at startup
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../../playwright-engine/index');
  return _engine;
}

let _discovery = null;
function discovery() {
  if (!_discovery) _discovery = require('../../playwright-engine/target-discovery');
  return _discovery;
}

const _runningCampaigns = new Set();

// ----------------------------------------------------------------
// Post Queue — drain scheduled posts
// ----------------------------------------------------------------

async function drainPostQueue() {
  const pending = q.getPendingPosts();
  if (!pending.length) return;

  log.debug(`Draining ${pending.length} queued post(s)`);

  for (const item of pending) {
    q.markPostRunning(item.id);
    const content = JSON.parse(item.content_json);

    try {
      const result = await publishPost(item.account_id, item.platform, content);
      if (result.success) {
        q.markPostDone(item.id, result);
        if (item.campaign_id) {
          q.logCampaignAction(item.campaign_id, item.account_id, 'publish', 'success', `postId: ${result.postId}`);
          q.incrementCampaignCount(item.campaign_id);
        }
      } else {
        q.markPostFailed(item.id, result.error);
        if (item.campaign_id) {
          q.logCampaignAction(item.campaign_id, item.account_id, 'publish', 'failed', result.error);
        }
      }
    } catch (err) {
      q.markPostFailed(item.id, err.message);
      log.error('Post queue item threw', { id: item.id, err: err.message });
    }
  }
}

// ----------------------------------------------------------------
// GROWTH campaign runner — Playwright-based follow/like/comment
// ----------------------------------------------------------------

async function runGrowthCampaign(campaign) {
  if (_runningCampaigns.has(campaign.id)) return;
  _runningCampaigns.add(campaign.id);

  const config = JSON.parse(campaign.config_json ?? '{}');
  const { action = 'follow', target = {}, dailyGoal = 20 } = config;
  const { accountId } = { accountId: campaign.account_id };
  const platform = campaign.platform;

  log.info('Running GROWTH campaign', { id: campaign.id, name: campaign.name, action });

  try {
    // Get targets
    let targets = [];
    if (target.type === 'hashtag' && target.value) {
      if (action === 'like_post') {
        // Need a temp browser to discover — use existing session
        const result = await engine().executeAction(accountId, platform, 'scroll_feed', {});
        // For now, append hashtag posts from a discovery browser session
        targets = await _discoverTargets(accountId, platform, action, target);
      } else {
        targets = await _discoverTargets(accountId, platform, action, target);
      }
    }

    const batchSize = Math.min(targets.length, dailyGoal - campaign.completed_count);

    for (let i = 0; i < batchSize; i++) {
      const tgt = targets[i];
      const params = _buildParams(action, tgt);

      const result = await engine().executeAction(accountId, platform, action, params);

      if (result.blocked) {
        q.logCampaignAction(campaign.id, accountId, action, 'blocked', result.reason);
        break; // Rate limit — stop this batch
      }

      const status = result.success ? 'success' : 'failed';
      q.logCampaignAction(campaign.id, accountId, action, status,
        result.error ?? result.message ?? null);

      if (result.success) {
        q.incrementCampaignCount(campaign.id);
      }

      if (result.event) {
        // Detection — pause campaign
        log.warn('Detection event during campaign — pausing', { campaignId: campaign.id, event: result.event });
        q.setCampaignStatus(campaign.id, 'paused');
        break;
      }
    }

    // Check if campaign reached target
    const updated = q.getCampaign(campaign.id);
    if (updated && updated.target_count && updated.completed_count >= updated.target_count) {
      q.setCampaignStatus(campaign.id, 'completed');
      log.info('Campaign completed', { id: campaign.id, name: campaign.name });
    }

  } catch (err) {
    log.error('GROWTH campaign error', { id: campaign.id, err: err.message });
    q.logCampaignAction(campaign.id, campaign.account_id, 'error', 'failed', err.message);
  } finally {
    _runningCampaigns.delete(campaign.id);
  }
}

// ----------------------------------------------------------------
// HYBRID campaign runner — publish via API then boost via Playwright
// ----------------------------------------------------------------

async function runHybridCampaign(campaign) {
  if (_runningCampaigns.has(campaign.id)) return;
  _runningCampaigns.add(campaign.id);

  const config = JSON.parse(campaign.config_json ?? '{}');
  const { publish: publishConfig, boost: boostConfig } = config;

  log.info('Running HYBRID campaign', { id: campaign.id, name: campaign.name });

  try {
    // Step 1: publish via API (add to queue or run immediately)
    if (publishConfig && publishConfig.scheduledAt) {
      const { schedulePost } = require('../actions/post');
      schedulePost(campaign.account_id, campaign.platform, publishConfig.content, publishConfig.scheduledAt, campaign.id);
      q.logCampaignAction(campaign.id, campaign.account_id, 'schedule_publish', 'success', `Scheduled: ${publishConfig.scheduledAt}`);
    } else if (publishConfig?.content) {
      const result = await publishPost(campaign.account_id, campaign.platform, publishConfig.content);
      q.logCampaignAction(campaign.id, campaign.account_id, 'publish', result.success ? 'success' : 'failed', result.error ?? null);
      if (result.success) q.incrementCampaignCount(campaign.id);
    }

    // Step 2: Playwright boost (run as GROWTH sub-campaign)
    if (boostConfig) {
      const boostCampaign = {
        id:           campaign.id,
        account_id:   campaign.account_id,
        platform:     campaign.platform,
        config_json:  JSON.stringify(boostConfig),
        completed_count: campaign.completed_count,
        target_count:    boostConfig.dailyGoal ?? 50,
        name:            campaign.name + ' [boost]',
      };
      await runGrowthCampaign(boostCampaign);
    }
  } catch (err) {
    log.error('HYBRID campaign error', { id: campaign.id, err: err.message });
  } finally {
    _runningCampaigns.delete(campaign.id);
  }
}

// ----------------------------------------------------------------
// Campaign dispatch — pick up running campaigns
// ----------------------------------------------------------------

async function processCampaigns() {
  const running = q.listCampaigns('running');
  if (!running.length) return;

  log.debug(`Processing ${running.length} running campaign(s)`);

  for (const campaign of running) {
    if (_runningCampaigns.has(campaign.id)) continue;

    if (campaign.type === 'growth') {
      runGrowthCampaign(campaign).catch(err =>
        log.error('Campaign runner threw', { id: campaign.id, err: err.message })
      );
    } else if (campaign.type === 'hybrid') {
      runHybridCampaign(campaign).catch(err =>
        log.error('Hybrid campaign threw', { id: campaign.id, err: err.message })
      );
    }
    // CONTENT campaigns are handled purely via post_queue
  }
}

// ----------------------------------------------------------------
// Target discovery helper
// ----------------------------------------------------------------

async function _discoverTargets(accountId, platform, action, target) {
  try {
    if (platform === 'instagram') {
      // Use a browser session to discover targets
      let page, context, cleanup;
      const { launchForAccount } = require('../../playwright-engine/browser');
      const sess = await launchForAccount(accountId, platform);
      page = sess.page; context = sess.context; cleanup = sess.cleanup;
      try {
        if (target.type === 'hashtag') {
          if (action === 'like_post' || action === 'comment') {
            return await discovery().ig.hashtagPosts(page, target.value, { limit: 30 });
          }
          if (action === 'follow') {
            // Get posters from hashtag
            const posts = await discovery().ig.hashtagPosts(page, target.value, { limit: 20 });
            return posts; // Will follow post authors
          }
        }
        if (target.type === 'competitor') {
          return await discovery().ig.competitorFollowers(page, target.value, { limit: 50 });
        }
        if (target.type === 'explore') {
          return await discovery().ig.explorePosts(page, { limit: 20 });
        }
      } finally {
        await cleanup();
      }
    }
    if (platform === 'tiktok' && target.type === 'hashtag') {
      let page, cleanup;
      const { launchForAccount } = require('../../playwright-engine/browser');
      const sess = await launchForAccount(accountId, platform);
      page = sess.page; cleanup = sess.cleanup;
      try {
        return await discovery().tt.hashtagVideos(page, target.value, { limit: 20 });
      } finally {
        await cleanup();
      }
    }
  } catch (err) {
    log.error('Target discovery failed', { accountId, platform, err: err.message });
  }
  return [];
}

// ----------------------------------------------------------------
// Map action + target URL → executeAction params
// ----------------------------------------------------------------

function _buildParams(action, target) {
  switch (action) {
    case 'like_post':    return { postUrl: target };
    case 'comment':      return { postUrl: target, text: '🔥' }; // Default text — override in config
    case 'follow':       return { username: target };
    case 'unfollow':     return { username: target };
    case 'like_video':   return { videoUrl: target };
    case 'watch_video':  return { videoUrl: target };
    default:             return {};
  }
}

// ----------------------------------------------------------------
// Start all crons
// ----------------------------------------------------------------

let _started = false;

function startRunner() {
  if (_started) return;
  _started = true;

  // Post queue — every 60 seconds
  cron.schedule('* * * * *', () => {
    drainPostQueue().catch(err => log.error('Queue drain error', { err: err.message }));
  });

  // Campaign runner — every 30 seconds
  cron.schedule('*/30 * * * * *', () => {
    processCampaigns().catch(err => log.error('Campaign runner error', { err: err.message }));
  });

  log.info('Scheduler started (post queue: 60s, campaigns: 30s)');
}

module.exports = { startRunner, drainPostQueue, processCampaigns };
