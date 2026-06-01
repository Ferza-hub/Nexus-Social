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
// Organic history builder — 2-3 min of realistic browsing
// before the actual view, so the target action looks like part
// of a natural session rather than a direct bot hit.
// ----------------------------------------------------------------

const _NEUTRAL_SITES = [
  'https://www.google.com/',
  'https://www.reddit.com/',
  'https://news.ycombinator.com/',
];

const _YT_CONSENT = [
  'button[aria-label="Accept all"]',
  'button[aria-label="Reject all"]',
  '.eom-buttons button:first-child',
  'form[action*="consent"] button:last-child',
];

function _ri(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function _delay(ms)    { return new Promise(r => setTimeout(r, ms)); }

async function _buildOrganic(page, platform) {
  const budget = _ri(90_000, 160_000); // 1.5 – 2.7 min total
  const start  = Date.now();

  // Step 1 — neutral detour (builds browser history, looks like natural navigation)
  try {
    await page.goto(_NEUTRAL_SITES[_ri(0, _NEUTRAL_SITES.length - 1)], {
      waitUntil: 'domcontentloaded', timeout: 15_000,
    });
    await _delay(_ri(5_000, 10_000));
    for (let i = 0; i < _ri(2, 4); i++) {
      await page.mouse.wheel(0, _ri(100, 300));
      await _delay(_ri(800, 2000));
    }
  } catch (_) {}

  if (Date.now() - start > budget * 0.35) return;

  // Step 2 — platform entry (builds platform-specific cookies + referrer chain)
  try {
    if (platform === 'youtube') {
      await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await _delay(_ri(3_000, 5_000));

      for (const sel of _YT_CONSENT) {
        try { const el = await page.$(sel); if (el) { await el.click(); await _delay(800); break; } } catch (_) {}
      }

      for (let i = 0; i < _ri(3, 5); i++) {
        await page.mouse.wheel(0, _ri(120, 350));
        await _delay(_ri(900, 2000));
      }

      // Click and briefly watch one trending video (builds VISITOR_INFO1_LIVE)
      if (Date.now() - start < budget * 0.7) {
        try {
          const thumbs = await page.$$('ytd-rich-item-renderer a#thumbnail[href]');
          if (thumbs.length > 0) {
            await thumbs[_ri(0, Math.min(thumbs.length - 1, 5))].click();
            await _delay(_ri(2_000, 4_000));
            const paused = await page.evaluate(() => document.querySelector('video')?.paused ?? true).catch(() => true);
            if (paused) await page.click('#movie_player, video').catch(() => {});
            const watchFor = Math.min(_ri(20_000, 40_000), budget - (Date.now() - start) - 8_000);
            if (watchFor > 5_000) await _delay(watchFor);
            await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await _delay(_ri(1_500, 3_000));
          }
        } catch (_) {}
      }

    } else if (platform === 'facebook') {
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await _delay(_ri(3_000, 5_000));
      for (let i = 0; i < _ri(2, 4); i++) {
        await page.mouse.wheel(0, _ri(100, 250));
        await _delay(_ri(1_000, 2_500));
      }

    } else if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await _delay(_ri(3_000, 5_000));
      for (let i = 0; i < _ri(2, 3); i++) {
        await page.mouse.wheel(0, _ri(100, 250));
        await _delay(_ri(1_000, 2_000));
      }

    } else if (platform === 'tiktok') {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await _delay(_ri(3_000, 5_000));
      for (let i = 0; i < _ri(2, 4); i++) {
        await page.mouse.wheel(0, _ri(100, 250));
        await _delay(_ri(800, 2_000));
      }

    } else {
      // Generic: stay on neutral page a bit longer
      await _delay(_ri(10_000, 20_000));
    }
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
// executeGhostView — ephemeral browser, organic history, then view.
// No persistent identity. Ghost is born and dies for this one task.
// ----------------------------------------------------------------

async function executeGhostView(platform, url) {
  let session = null;
  try {
    session = await launchEphemeral();
    const { page, proxyId } = session;

    await _buildOrganic(page, platform);

    if (platform === 'youtube') {
      await youtube.watchVideo(page, youtube.cleanUrl(url), { watchPct: _ri(40, 75) / 100 });
    } else if (platform === 'facebook') {
      await facebook.watchVideo(page, url);
    } else if (platform === 'instagram') {
      await instagram.watchReel(page, url);
    } else if (platform === 'tiktok') {
      await tiktok.watchVideo(page, url);
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.mouse.wheel(0, _ri(100, 300));
      await _delay(_ri(15_000, 45_000));
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
