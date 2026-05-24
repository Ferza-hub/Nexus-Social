'use strict';

const { makeLogger } = require('../utils/logger');
const { launchForAccount, isAccountBusy } = require('./browser');
const { saveSession } = require('../account-manager/session-manager');
const am = require('../account-manager/index');

const instagram = require('./platforms/instagram');
const tiktok    = require('./platforms/tiktok');

const log = makeLogger('PlaywrightEngine');

// ----------------------------------------------------------------
// Platform module registry
// ----------------------------------------------------------------

const PLATFORMS = {
  instagram,
  tiktok,
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
  },
  tiktok: {
    login:         { fn: 'login',        rateType: null },
    watch_video:   { fn: 'watchVideo',   rateType: 'watch_reel' },
    like_video:    { fn: 'likeVideo',    rateType: 'like' },
    follow:        { fn: 'followUser',   rateType: 'follow' },
    comment:       { fn: 'commentVideo', rateType: 'comment' },
    scroll_fyp:    { fn: 'scrollFYP',    rateType: null },
  },
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

  // ---- 2. Prevent concurrent browser instances ----
  if (isAccountBusy(accountId)) {
    log.warn('Account busy — skipping', { accountId, platform, action });
    return { success: false, reason: 'account_busy' };
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
  return [];
}

// ----------------------------------------------------------------
// Convenience: run login + save session for a fresh account
// ----------------------------------------------------------------

async function loginAndSaveSession(accountId, platform) {
  return executeAction(accountId, platform, 'login');
}

module.exports = {
  executeAction,
  loginAndSaveSession,
};
