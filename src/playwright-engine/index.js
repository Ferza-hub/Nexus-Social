'use strict';

const { makeLogger } = require('../utils/logger');
const { launchForAccount, launchAnonymous, launchWithGhost, isAccountBusy, isConcurrencyFull } = require('./browser');
const gm = require('../ghost/manager');
const { saveSession } = require('../account-manager/session-manager');
const am = require('../account-manager/index');

const instagram = require('./platforms/instagram');
const tiktok    = require('./platforms/tiktok');
const twitter   = require('./platforms/twitter');
const youtube   = require('./platforms/youtube');
const threads   = require('./platforms/threads');
const facebook  = require('./platforms/facebook');

const log = makeLogger('PlaywrightEngine');

// ----------------------------------------------------------------
// Platform module registry
// ----------------------------------------------------------------

const PLATFORMS = {
  instagram,
  tiktok,
  twitter,
  youtube,
  threads,
  facebook,
};

// ----------------------------------------------------------------
// Action definitions: which platform module method to call,
// and which rate_limit action_type to record
// ----------------------------------------------------------------

const ACTION_MAP = {
  instagram: {
    login:         { fn: 'login',        rateType: null },
    scroll_feed:   { fn: 'scrollFeed',   rateType: null },
    watch_story:   { fn: 'watchStory',   rateType: 'story_view' },
    like_post:     { fn: 'likePost',     rateType: 'like' },
    follow:        { fn: 'followUser',   rateType: 'follow' },
    unfollow:      { fn: 'unfollowUser', rateType: 'unfollow' },
    comment:       { fn: 'commentPost',  rateType: 'comment' },
    watch_reel:    { fn: 'watchReel',    rateType: 'watch_reel' },
    dm:            { fn: 'sendDM',       rateType: 'dm' },
    post_reel:     { fn: 'postReel',     rateType: null },
    post_story:    { fn: 'postStory',    rateType: null },
  },
  tiktok: {
    login:         { fn: 'login',        rateType: null },
    watch_video:   { fn: 'watchVideo',   rateType: 'watch_reel' },
    like_video:    { fn: 'likeVideo',    rateType: 'like' },
    follow:        { fn: 'followUser',   rateType: 'follow' },
    comment:       { fn: 'commentVideo', rateType: 'comment' },
    scroll_fyp:    { fn: 'scrollFYP',    rateType: null },
  },
  twitter: {
    login:         { fn: 'login',        rateType: null },
    scroll_feed:   { fn: 'scrollFeed',   rateType: null },
    like_post:     { fn: 'likePost',     rateType: 'like' },
    follow:        { fn: 'followUser',   rateType: 'follow' },
    unfollow:      { fn: 'unfollowUser', rateType: 'unfollow' },
    reply_tweet:   { fn: 'replyTweet',   rateType: 'comment' },
  },
  youtube: {
    login:          { fn: 'login',            rateType: null },
    scroll_feed:    { fn: 'scrollFeed',       rateType: null },
    watch_video:    { fn: 'watchVideo',       rateType: 'watch_reel' },
    search_watch:   { fn: 'searchAndWatch',   rateType: 'watch_reel' },
    like_video:     { fn: 'likeVideo',        rateType: 'like' },
    subscribe:      { fn: 'subscribeChannel', rateType: 'follow' },
    comment:        { fn: 'commentVideo',     rateType: 'comment' },
  },
  threads: {
    login:         { fn: 'login',        rateType: null },
    scroll_feed:   { fn: 'scrollFeed',   rateType: null },
    like_post:     { fn: 'likePost',     rateType: 'like' },
    follow:        { fn: 'followUser',   rateType: 'follow' },
    unfollow:      { fn: 'unfollowUser', rateType: 'unfollow' },
    comment:       { fn: 'comment',      rateType: 'comment' },
  },
  facebook: {
    login:         { fn: 'login',        rateType: null },
    scroll_feed:   { fn: 'scrollFeed',   rateType: null },
    watch_video:   { fn: 'watchVideo',   rateType: 'watch_reel' },
    watch_reel:    { fn: 'watchReel',    rateType: 'watch_reel' },
    like_post:     { fn: 'likePost',     rateType: 'like' },
    follow:        { fn: 'followUser',   rateType: 'follow' },
    follow_page:   { fn: 'followPage',   rateType: 'follow' },
    comment:       { fn: 'comment',      rateType: 'comment' },
  },
  // instagram additions (already has entries above — merge here)
};

// ----------------------------------------------------------------
// Core executor: run one action for one account
//
//   accountId : number
//   platform  : 'instagram' | 'tiktok' | ...
//   action    : action name from ACTION_MAP
//   params    : additional arguments to pass to the platform fn
//
// Returns { success, event?, message?, ... }
// ----------------------------------------------------------------

async function executeAction(accountId, platform, action, params = {}) {
  const platformModule = PLATFORMS[platform];
  if (!platformModule) throw new Error(`Unknown platform: ${platform}`);

  const actionDef = ACTION_MAP[platform]?.[action];
  if (!actionDef) throw new Error(`Unknown action "${action}" for platform "${platform}"`);

  // ---- 1. Pre-action gate ----
  if (actionDef.rateType) {
    const gate = am.canAct(accountId, platform, actionDef.rateType);
    if (!gate.allowed) {
      log.debug('Action blocked by gate', { accountId, platform, action, reason: gate.reason });
      return { success: false, blocked: true, reason: gate.reason };
    }
  } else {
    // For non-rate-limited actions (login, scroll) — still check status
    const account = am.getAccount(accountId);
    if (!account) return { success: false, reason: 'account_not_found' };
    if (account.status === 'disabled') return { success: false, reason: 'account_disabled' };
  }

  // ---- 2. Prevent concurrent browser instances + global cap ----
  if (isAccountBusy(accountId)) {
    log.warn('Account busy — skipping', { accountId, platform, action });
    return { success: false, reason: 'account_busy' };
  }
  if (isConcurrencyFull()) {
    log.warn('Concurrency limit reached — skipping', { accountId, platform, action });
    return { success: false, reason: 'concurrency_limit' };
  }

  const account = am.getAccount(accountId);
  if (!account) return { success: false, reason: 'account_not_found' };

  let session = null;
  try {
    session = await launchForAccount(accountId, platform);
    const { page, context } = session;

    // ---- 3. Ensure logged in ----
    if (action !== 'login') {
      const isLoggedIn = await _checkLoggedIn(page, platform);
      if (!isLoggedIn) {
        log.info('Session expired — re-logging in', { accountId, platform });
        const loginResult = await platformModule.login(page, account);
        if (!loginResult.success) {
          am.health.logEvent(accountId, platform, loginResult.event ?? 'login_required', 'Auto re-login failed');
          return loginResult;
        }
        // Save fresh session
        const state = await context.storageState();
        saveSession(accountId, platform, state);
      }
    }

    // ---- 4. Execute the action ----
    const fn   = platformModule[actionDef.fn];
    const args = _buildArgs(action, platform, account, params);
    const result = await fn(page, ...args);

    // ---- 5. Handle detection events ----
    if (!result.success && result.event) {
      am.health.logEvent(accountId, platform, result.event, result.message ?? null);
      log.warn('Action returned detection event', { accountId, platform, action, event: result.event });
      return result;
    }

    // ---- 6. Save updated session + record action ----
    if (result.success) {
      if (actionDef.rateType) {
        am.limits.recordAction(accountId, platform, actionDef.rateType);
      }
      // Persist fresh session state after any successful action
      const state = await context.storageState();
      saveSession(accountId, platform, state);
    }

    return result;

  } catch (err) {
    log.error('Action threw error', { accountId, platform, action, err: err.message });
    am.health.logEvent(accountId, platform, 'warning', `Action error: ${err.message}`);
    return { success: false, error: err.message };

  } finally {
    if (session) await session.cleanup();
  }
}

// ----------------------------------------------------------------
// Check if the page is already in an authenticated state
// ----------------------------------------------------------------

async function _checkLoggedIn(page, platform) {
  try {
    if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const url = page.url();
      return !url.includes('/accounts/login') && !url.includes('/challenge');
    }
    if (platform === 'tiktok') {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const loginBtn = await page.$('a[href*="/login"]');
      return !loginBtn;
    }
    if (platform === 'twitter') {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
      return !page.url().includes('/i/flow/login') && !page.url().includes('/login');
    }
    if (platform === 'youtube') {
      await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const avatar = await page.$('button#avatar-btn, #avatar-container');
      return !!avatar;
    }
    if (platform === 'threads') {
      await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      return !page.url().includes('/login');
    }
    if (platform === 'facebook') {
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      return !page.url().includes('/login') && !page.url().includes('login.php');
    }
    return true;
  } catch (_) {
    return false;
  }
}

// ----------------------------------------------------------------
// Map params object → positional args for each action function
// Each platform function signature: (page, ...args)
// ----------------------------------------------------------------

function _buildArgs(action, platform, account, params) {
  if (platform === 'instagram') {
    switch (action) {
      case 'login':       return [account];
      case 'scroll_feed': return [params];
      case 'watch_story': return [params.username];
      case 'like_post':   return [params.postUrl];
      case 'follow':      return [params.username];
      case 'unfollow':    return [params.username];
      case 'comment':     return [params.postUrl, params.text];
      case 'watch_reel':  return [params.reelUrl];
      case 'dm':          return [params.username, params.message];
    }
  }
  if (platform === 'tiktok') {
    switch (action) {
      case 'login':       return [account];
      case 'watch_video': return [params.videoUrl];
      case 'like_video':  return [params.videoUrl];
      case 'follow':      return [params.username];
      case 'comment':     return [params.videoUrl, params.text];
      case 'scroll_fyp':  return [params];
    }
  }
  if (platform === 'twitter') {
    switch (action) {
      case 'login':        return [account];
      case 'scroll_feed':  return [params];
      case 'like_post':    return [params.tweetUrl];
      case 'follow':       return [params.username];
      case 'unfollow':     return [params.username];
      case 'reply_tweet':  return [params.tweetUrl, params.text];
    }
  }
  if (platform === 'youtube') {
    switch (action) {
      case 'login':         return [account];
      case 'scroll_feed':   return [params];
      case 'watch_video':   return [params.videoUrl, params];         // (page, url, opts{watchPct})
      case 'search_watch':  return [params.keyword, params];          // (page, keyword, opts{watchPct})
      case 'like_video':    return [params.videoUrl];
      case 'subscribe':     return [params.channelUrl];
      case 'comment':       return [params.videoUrl, params.text];
    }
  }
  if (platform === 'threads') {
    switch (action) {
      case 'login':        return [account];
      case 'scroll_feed':  return [params];
      case 'like_post':    return [params.postUrl];
      case 'follow':       return [params.username];
      case 'unfollow':     return [params.username];
      case 'comment':      return [params.postUrl, params.text];
    }
  }
  if (platform === 'facebook') {
    switch (action) {
      case 'login':        return [account];
      case 'scroll_feed':  return [params];
      case 'watch_video':  return [params.videoUrl];
      case 'watch_reel':   return [params];                           // { reelCount, maxMs }
      case 'like_post':    return [params.postUrl];
      case 'follow':       return [params.profileUrl];
      case 'follow_page':  return [params.profileUrl];
      case 'comment':      return [params.postUrl, params.text];
    }
  }
  // instagram post_reel / post_story additions
  if (platform === 'instagram') {
    switch (action) {
      case 'post_reel':    return [params];  // { videoPath, caption, hashtags }
      case 'post_story':   return [params];  // { mediaPath }
    }
  }
  return [];
}

// ----------------------------------------------------------------
// Anonymous view — no account needed, fresh throwaway browser
// ----------------------------------------------------------------

const _REFERRERS = {
  facebook:  ['https://www.google.com/', 'https://l.facebook.com/', null, null, 'https://www.facebook.com/'],
  instagram: ['https://www.google.com/', null, null, 'https://l.instagram.com/', 'https://www.facebook.com/'],
  tiktok:    ['https://www.google.com/', null, null, 'https://vm.tiktok.com/', 'https://www.tiktok.com/'],
  youtube:   ['https://www.google.com/', 'https://www.google.com/', null, 'https://m.youtube.com/'],
  twitter:   ['https://www.google.com/', null, 'https://t.co/', null, 'https://www.twitter.com/'],
  threads:   ['https://www.google.com/', null, null, 'https://www.instagram.com/', 'https://l.threads.net/'],
};

const _DISMISS_SELECTORS = {
  facebook:  ['[aria-label="Close"]', 'div[role="dialog"] [aria-label="Close"]', '[data-testid="close-button"]', 'div[role="dialog"] button:has-text("Close")'],
  instagram: ['[aria-label="Close"]', 'button:has-text("Not now")', 'div[role="dialog"] [aria-label="Close"]'],
  tiktok:    ['[data-e2e="modal-close-inner-button"]', 'button:has-text("Later")', 'button:has-text("Skip")'],
  twitter:   ['[aria-label="Close"]', 'div[data-testid="sheetDialog"] [aria-label="Close"]'],
  youtube:   [
    // EU cookie consent
    'button[aria-label="Accept all"]',
    'button[aria-label="Reject all"]',
    '.eom-buttons button:first-child',
    // Age gate / sign-in nag
    '#dismiss-button',
    'paper-button[dialog-dismiss]',
    'tp-yt-paper-button[aria-label="No thanks"]',
  ],
  threads:   ['[aria-label="Close"]'],
};

async function executeAnonymousView(platform, url) {
  let session = null;
  try {
    session = await launchAnonymous();
    const { page } = session;

    const targetUrl = platform === 'youtube' ? youtube.cleanUrl(url) : url;

    const refList = _REFERRERS[platform] ?? [null];
    const referer = refList[Math.floor(Math.random() * refList.length)] ?? undefined;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000, referer });

    // Wait a bit longer for YouTube's heavy SPA to settle
    const popupWait = platform === 'youtube' ? 3000 : 1500;
    await new Promise(r => setTimeout(r, popupWait));

    // Dismiss popups — try all selectors, not just the first match
    for (const sel of (_DISMISS_SELECTORS[platform] ?? [])) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (_) {}
    }

    // YouTube-specific: ensure video plays
    if (platform === 'youtube') {
      try {
        await page.waitForSelector('video', { timeout: 8000 });
        const isPaused = await page.evaluate(() => {
          const v = document.querySelector('video');
          return v ? v.paused : true;
        });
        if (isPaused) {
          // Try clicking the player to start playback
          await page.click('#movie_player, .html5-video-player, video').catch(() => {});
          await new Promise(r => setTimeout(r, 800));
        }
      } catch (_) {}
    }

    // Natural scroll while "watching"
    const scrolls = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < scrolls; i++) {
      await page.mouse.wheel(0, Math.floor(Math.random() * 120 + 40));
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1000 + 300)));
    }

    const watchMs = Math.floor(Math.random() * 7000 + 3000); // 3–10s
    await new Promise(r => setTimeout(r, watchMs));

    log.info('Anonymous view completed', { platform, watchMs });
    return { success: true };
  } catch (err) {
    log.warn('Anonymous view failed', { platform, url, err: err.message });
    return { success: false, reason: err.message };
  } finally {
    if (session) await session.cleanup();
  }
}

// ----------------------------------------------------------------
// Ghost view — persistent browser identity via storageState
// Delegates to platform modules so watch behaviour is identical to
// account-based sessions (real duration, pause/resume, etc.)
// Falls back to anonymous if no ghost is ready.
// ----------------------------------------------------------------

// Search terms used when ghost does YouTube organic navigation
const _GHOST_YT_TERMS = [
  'funny moments compilation', 'best music mix 2024', 'travel documentary',
  'cooking recipe easy', 'workout at home', 'tech news today',
  'movie review', 'nature sounds relaxing', 'street food tour',
  'gaming highlights', 'diy project', 'science explained',
];

function _ri(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function executeGhostView(platform, url) {
  const ghost = gm.pickGhost();
  if (!ghost) {
    log.debug('No ghost available — falling back to anonymous');
    return executeAnonymousView(platform, url);
  }

  let session = null;
  try {
    session = await launchWithGhost(ghost.id);
    const { page, context } = session;

    if (platform === 'youtube') {
      // Ghost is an anonymous returning visitor — storageState has YouTube cookies.
      // searchAndWatch with targetUrl: organic search referrer → then land on target.
      const isShorts  = url.includes('/shorts/');
      const keyword   = _GHOST_YT_TERMS[_ri(0, _GHOST_YT_TERMS.length - 1)];
      const watchPct  = isShorts ? (_ri(75, 100) / 100) : (_ri(40, 70) / 100);
      await youtube.searchAndWatch(page, keyword, {
        targetUrl: youtube.cleanUrl(url),
        watchPct,
      });

    } else if (platform === 'facebook') {
      // Ghost (no login) can only interact with public video URLs.
      // watchVideo will attempt anonymous viewing; Facebook may redirect to login
      // in which case the ghost view fails gracefully and is logged.
      await facebook.watchVideo(page, url);

    } else {
      // Generic platform: set referrer + navigate + scroll + wait
      const refList = _REFERRERS[platform] ?? [null];
      const referer = refList[_ri(0, refList.length - 1)] ?? undefined;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000, referer });
      await new Promise(r => setTimeout(r, _ri(1500, 3000)));
      for (const sel of (_DISMISS_SELECTORS[platform] ?? [])) {
        try { const el = await page.$(sel); if (el) { await el.click(); await new Promise(r => setTimeout(r, 500)); } } catch (_) {}
      }
      for (let i = 0; i < _ri(1, 3); i++) {
        await page.mouse.wheel(0, _ri(80, 200));
        await new Promise(r => setTimeout(r, _ri(500, 1200)));
      }
      await new Promise(r => setTimeout(r, _ri(8_000, 20_000)));
    }

    // Persist updated storageState — watch history + cookies accumulate each session
    const state = await context.storageState();
    gm.saveStorageState(ghost.id, state);
    gm.recordUse(ghost.id);
    gm.logAction(ghost.id, platform, 'view', 'success');

    log.info('Ghost view done', { ghostId: ghost.id, platform });
    return { success: true };

  } catch (err) {
    log.warn('Ghost view failed', { ghostId: ghost.id, platform, err: err.message });
    gm.logAction(ghost.id, platform, 'view', 'failed', err.message);
    return { success: false, reason: err.message };
  } finally {
    if (session) await session.cleanup();
  }
}

// ----------------------------------------------------------------
// Convenience: run login + save session for a fresh account
// ----------------------------------------------------------------

async function loginAndSaveSession(accountId, platform) {
  return executeAction(accountId, platform, 'login');
}

module.exports = {
  executeAction,
  executeAnonymousView,
  executeGhostView,
  loginAndSaveSession,
};
