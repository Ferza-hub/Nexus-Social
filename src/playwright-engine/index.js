'use strict';

const path = require('path');
const fs   = require('fs');
const { makeLogger }      = require('../utils/logger');
const { launchEphemeral, launchWithSession, isConcurrencyFull, recordProxyFailure } = require('./browser');
const { getDb }           = require('../database/db');

const instagram = require('./platforms/instagram');
const tiktok    = require('./platforms/tiktok');
const twitter   = require('./platforms/twitter');
const youtube   = require('./platforms/youtube');
const threads   = require('./platforms/threads');
const facebook  = require('./platforms/facebook');

const log = makeLogger('PlaywrightEngine');

const PLATFORMS = { instagram, tiktok, twitter, youtube, threads, facebook };

// ----------------------------------------------------------------
// Action map — used by executeGhostAction to resolve fn + args
// ----------------------------------------------------------------

const ACTION_MAP = {
  instagram: {
    watch_reel:  { fn: 'watchReel',    args: p => [p.reelUrl]             },
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
    unfollow:    { fn: 'unfollowUser', args: p => [p.username]            },
    comment:     { fn: 'commentPost',  args: p => [p.postUrl, p.text]     },
  },
  tiktok: {
    watch_video: { fn: 'watchVideo',   args: p => [p.videoUrl]            },
    like_video:  { fn: 'likeVideo',    args: p => [p.videoUrl]            },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
    comment:     { fn: 'commentVideo', args: p => [p.videoUrl, p.text]    },
  },
  twitter: {
    like_post:   { fn: 'likePost',     args: p => [p.tweetUrl]            },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
  },
  youtube: {
    watch_video: { fn: 'watchVideo',   args: p => [youtube.cleanUrl(p.videoUrl), p] },
    like_video:  { fn: 'likeVideo',    args: p => [p.videoUrl]            },
    subscribe:   { fn: 'subscribeChannel', args: p => [p.channelUrl]      },
    comment:     { fn: 'commentVideo', args: p => [p.videoUrl, p.text]    },
  },
  threads: {
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow:      { fn: 'followUser',   args: p => [p.username]            },
  },
  facebook: {
    watch_video: { fn: 'watchVideo',   args: p => [p.videoUrl]            },
    watch_reel:  { fn: 'watchReel',    args: p => [p]                     },
    like_post:   { fn: 'likePost',     args: p => [p.postUrl]             },
    follow_page: { fn: 'followPage',   args: p => [p.profileUrl]          },
    comment:     { fn: 'comment',      args: p => [p.postUrl, p.text]     },
  },
};

// ----------------------------------------------------------------
// Key account helpers — round-robin from accounts table
// ----------------------------------------------------------------

const SESSION_DIR = process.env.SESSION_DIR ?? path.join(__dirname, '../../data/sessions');

function _getAccount(platform) {
  const db   = getDb();
  const acct = db.prepare(`
    SELECT * FROM accounts
    WHERE platform=? AND status='active'
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1
  `).get(platform);
  if (!acct) return null;
  db.prepare('UPDATE accounts SET last_used_at=? WHERE id=?')
    .run(new Date().toISOString(), acct.id);
  return acct;
}

function _sessionPath(accountId) {
  const dir = path.join(SESSION_DIR, String(accountId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'session.json');
}

function _saveSession(accountId, state) {
  const filePath = _sessionPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(state));
  getDb().prepare('UPDATE accounts SET storage_state_path=? WHERE id=?').run(filePath, accountId);
}

// ----------------------------------------------------------------
// Quick platform entry — one homepage visit to pick up cookies and
// set a referrer chain before hitting the target URL.
// Kept to 2-4 seconds: ghost rotation + diverse fingerprints is
// the organic signal; per-ghost history building is not needed.
// ----------------------------------------------------------------

const _PLATFORM_HOMES = {
  youtube:   'https://www.youtube.com/',
  facebook:  'https://www.facebook.com/',
  instagram: 'https://www.instagram.com/',
  tiktok:    'https://www.tiktok.com/',
  twitter:   'https://x.com/',
  threads:   'https://www.threads.net/',
};

function _ri(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function _delay(ms)    { return new Promise(r => setTimeout(r, ms)); }

async function _quickEntry(page, platform) {
  const home = _PLATFORM_HOMES[platform];
  if (!home) return;
  try {
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await _delay(_ri(1_500, 3_000));
  } catch (_) {}
}

// ----------------------------------------------------------------
// _checkLoggedIn — navigate to platform and verify session
// ----------------------------------------------------------------

async function _checkLoggedIn(page, platform) {
  try {
    if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/accounts/login') && !page.url().includes('/challenge');
    }
    if (platform === 'tiktok') {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !(await page.$('a[href*="/login"]'));
    }
    if (platform === 'twitter') {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/flow/login') && !page.url().includes('/login');
    }
    if (platform === 'youtube') {
      await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !!(await page.$('button#avatar-btn, #avatar-container'));
    }
    if (platform === 'threads') {
      await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/login');
    }
    if (platform === 'facebook') {
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      return !page.url().includes('/login') && !page.url().includes('login.php');
    }
    return true;
  } catch (_) { return false; }
}

// ----------------------------------------------------------------
// executeGhostView — ephemeral browser, quick platform entry, then
// watch 15-60 seconds (countable by the platform).
// No persistent identity. Ghost is born and dies for this one task.
// ----------------------------------------------------------------

async function executeGhostView(platform, url) {
  let session = null;
  try {
    session = await launchEphemeral();
    const { page, proxyId } = session;

    await _quickEntry(page, platform);

    const watchMs = _ri(15_000, 60_000);

    if (platform === 'youtube') {
      await youtube.watchVideo(page, youtube.cleanUrl(url), { watchMs });
    } else if (platform === 'facebook') {
      await facebook.watchVideo(page, url, { watchMs });
    } else if (platform === 'instagram') {
      await instagram.watchReel(page, url);
    } else if (platform === 'tiktok') {
      await tiktok.watchVideo(page, url);
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await _delay(watchMs);
    }

    log.info('Ghost view done', { platform });
    return { success: true };

  } catch (err) {
    const isNetErr = /timeout|net::|ECONNREFUSED|ECONNRESET|ERR_/i.test(err.message);
    if (isNetErr && session?.proxyId) recordProxyFailure(session.proxyId);
    log.warn('Ghost view failed', { platform, err: err.message });
    return { success: false, reason: err.message };
  } finally {
    if (session) await session.cleanup();
  }
}

// ----------------------------------------------------------------
// executeGhostAction — load key account session, spawn ephemeral
// browser with that session, execute action, close.
// Auth cookies are re-saved only when a re-login happens.
// ----------------------------------------------------------------

async function executeGhostAction(platform, action, params = {}) {
  const platformModule = PLATFORMS[platform];
  if (!platformModule) return { success: false, reason: `unknown_platform:${platform}` };

  const actionDef = ACTION_MAP[platform]?.[action];
  if (!actionDef) return { success: false, reason: `unknown_action:${action}` };

  const account = _getAccount(platform);
  if (!account) return { success: false, reason: 'no_key_account' };

  let session = null;
  try {
    session = await launchWithSession(account.storage_state_path);
    const { page, context } = session;

    const loggedIn = await _checkLoggedIn(page, platform);
    if (!loggedIn) {
      log.info('Key account session expired — re-logging in', { accountId: account.id, platform });
      const creds = { email: account.email, password: account.password, username: account.email };
      const loginR = await platformModule.login(page, creds);
      if (!loginR.success) {
        getDb().prepare("UPDATE accounts SET status='expired' WHERE id=?").run(account.id);
        return { success: false, reason: `relogin_failed:${loginR.event}` };
      }
      // Persist fresh session so next launch doesn't need to re-login
      const state = await context.storageState();
      _saveSession(account.id, state);
    }

    const fn     = platformModule[actionDef.fn];
    const args   = actionDef.args(params);
    const result = await fn(page, ...args);

    if (!result.success && result.event) {
      log.warn('Ghost action detection', { accountId: account.id, platform, action, event: result.event });
      if (['disabled', 'challenge'].includes(result.event)) {
        getDb().prepare("UPDATE accounts SET status='expired' WHERE id=?").run(account.id);
      }
      return result;
    }

    log.info('Ghost action done', { platform, action });
    return result;

  } catch (err) {
    log.error('Ghost action error', { accountId: account.id, platform, action, err: err.message });
    return { success: false, error: err.message };
  } finally {
    if (session) await session.cleanup(); // browser closes; no state saved
  }
}

module.exports = { executeGhostView, executeGhostAction };
