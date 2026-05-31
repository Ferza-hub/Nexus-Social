'use strict';

const { executeAction } = require('../playwright-engine/index');
const { getDb }         = require('../database/db');
const { makeLogger }    = require('../utils/logger');

const log = makeLogger('TrafficRunner');

// In-memory stop signals — keyed by job id
const _active = new Map();

// ----------------------------------------------------------------
// Action map: what Playwright action each traffic type maps to
// canRepeat = same account can perform this action multiple times
// ----------------------------------------------------------------

const TRAFFIC_ACTIONS = {
  instagram: {
    views:     { action: 'watch_reel',  paramKey: 'reelUrl',     canRepeat: true  },
    likes:     { action: 'like_post',   paramKey: 'postUrl',     canRepeat: false },
    followers: { action: 'follow',      paramKey: 'username',    canRepeat: false },
  },
  tiktok: {
    views:     { action: 'watch_video', paramKey: 'videoUrl',    canRepeat: true  },
    likes:     { action: 'like_video',  paramKey: 'videoUrl',    canRepeat: false },
    followers: { action: 'follow',      paramKey: 'username',    canRepeat: false },
  },
  twitter: {
    likes:     { action: 'like_post',   paramKey: 'tweetUrl',    canRepeat: false },
    followers: { action: 'follow',      paramKey: 'username',    canRepeat: false },
  },
  youtube: {
    views:     { action: 'watch_video', paramKey: 'videoUrl',    canRepeat: true  },
    likes:     { action: 'like_video',  paramKey: 'videoUrl',    canRepeat: false },
    followers: { action: 'subscribe',   paramKey: 'channelUrl',  canRepeat: false },
  },
  facebook: {
    views:     { action: 'watch_reel',  paramKey: 'reelUrl',     canRepeat: true  },
    likes:     { action: 'like_post',   paramKey: 'postUrl',     canRepeat: false },
    followers: { action: 'follow',      paramKey: 'profileUrl',  canRepeat: false },
  },
  threads: {
    likes:     { action: 'like_post',   paramKey: 'postUrl',     canRepeat: false },
    followers: { action: 'follow',      paramKey: 'username',    canRepeat: false },
  },
};

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Extract username from profile URL for follower actions
function extractTarget(platform, actionType, input) {
  if (actionType !== 'followers') return input.trim();

  const patterns = {
    instagram: /instagram\.com\/(?:@)?([^/?#\s]+)/,
    tiktok:    /tiktok\.com\/@?([^/?#\s]+)/,
    twitter:   /(?:twitter|x)\.com\/([^/?#\s]+)/,
    facebook:  /facebook\.com\/(?:@)?([^/?#\s]+)/,
    threads:   /threads\.net\/(?:@)?([^/?#\s]+)/,
  };

  const m = input.trim().match(patterns[platform] ?? /$/);
  return m ? m[1].replace(/^@/, '') : input.trim().replace(/^@/, '');
}

// Shuffle array in-place (Fisher-Yates) for diverse account ordering
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ----------------------------------------------------------------
// Main runner — called async, does not block server
// ----------------------------------------------------------------

async function runJob(jobId) {
  const db = getDb();
  let stopped = false;
  _active.set(jobId, { stop: () => { stopped = true; } });

  db.prepare("UPDATE traffic_jobs SET status='running', started_at=?, updated_at=? WHERE id=?")
    .run(new Date().toISOString(), new Date().toISOString(), jobId);

  try {
    const job = db.prepare('SELECT * FROM traffic_jobs WHERE id=?').get(jobId);
    if (!job) return;

    const actionDef = TRAFFIC_ACTIONS[job.platform]?.[job.action_type];
    if (!actionDef) {
      log.error('Unknown action type', { jobId, platform: job.platform, action_type: job.action_type });
      db.prepare("UPDATE traffic_jobs SET status='failed', updated_at=? WHERE id=?")
        .run(new Date().toISOString(), jobId);
      return;
    }

    // Get active accounts, randomly ordered so we don't always start with the same account
    const accounts = shuffle(
      db.prepare("SELECT * FROM accounts WHERE platform=? AND status='active'").all(job.platform)
    );

    if (accounts.length === 0) {
      log.warn('No active accounts', { jobId, platform: job.platform });
      db.prepare("UPDATE traffic_jobs SET status='failed', updated_at=? WHERE id=?")
        .run(new Date().toISOString(), jobId);
      return;
    }

    const targetValue = extractTarget(job.platform, job.action_type, job.target_value);
    const params = { [actionDef.paramKey]: targetValue };

    let completed = 0;
    let idx = 0;

    log.info('Job started', { jobId, platform: job.platform, action: actionDef.action, target: targetValue, total: job.target_count, accounts: accounts.length });

    while (completed < job.target_count && !stopped) {
      // For non-repeatable actions, stop when all accounts exhausted
      if (!actionDef.canRepeat && idx >= accounts.length) {
        log.info('All accounts used for non-repeatable action', { jobId, completed });
        break;
      }

      const account = accounts[idx % accounts.length];
      idx++;

      log.debug('Executing action', { jobId, accountId: account.id, username: account.username, action: actionDef.action });

      const result = await executeAction(account.id, job.platform, actionDef.action, params);

      const logStatus = result.success ? 'success' : (result.blocked ? 'skipped' : 'failed');
      db.prepare(
        'INSERT INTO traffic_logs (job_id, account_id, platform, action, status, message, created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(jobId, account.id, job.platform, actionDef.action, logStatus,
            result.reason ?? result.message ?? null, new Date().toISOString());

      if (result.success) {
        completed++;
        db.prepare('UPDATE traffic_jobs SET completed_count=?, updated_at=? WHERE id=?')
          .run(completed, new Date().toISOString(), jobId);
        log.debug('Action succeeded', { jobId, completed, total: job.target_count });
      } else {
        log.debug('Action skipped/failed', { jobId, accountId: account.id, reason: result.reason ?? result.message });
      }

      // Natural inter-action pause — mimics human browsing patterns
      if (!stopped && completed < job.target_count) {
        const pause = randInt(3000, 9000);
        await delay(pause);
      }
    }

    const finalStatus = stopped ? 'paused' : 'completed';
    db.prepare('UPDATE traffic_jobs SET status=?, completed_at=?, updated_at=? WHERE id=?')
      .run(finalStatus, new Date().toISOString(), new Date().toISOString(), jobId);

    log.info('Job finished', { jobId, completed, finalStatus });

  } catch (err) {
    log.error('Job threw unhandled error', { jobId, err: err.message });
    db.prepare("UPDATE traffic_jobs SET status='failed', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), jobId);
  } finally {
    _active.delete(jobId);
  }
}

function stopJob(jobId) {
  _active.get(jobId)?.stop();
}

function isRunning(jobId) {
  return _active.has(jobId);
}

module.exports = { runJob, stopJob, isRunning, TRAFFIC_ACTIONS };
