'use strict';

const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('TikTok');

const BASE_URL = 'https://www.tiktok.com';

// ----------------------------------------------------------------
// Selector registry
// ----------------------------------------------------------------

const SEL = {
  // Login
  email_login_btn:    'a:has-text("Use phone / email / username"), div:has-text("Use phone / email / username")',
  email_tab:          'a:has-text("Email"), span:has-text("Email")',
  email_input:        'input[name="username"], input[type="email"], input[placeholder*="Email"]',
  password_input:     'input[type="password"]',
  login_submit:       'button[type="submit"], button[data-e2e="login-button"]',

  // Feed / FYP
  video_card:         '[data-e2e="recommend-list-item-container"], [class*="DivVideoFeedV2"]',

  // Video interactions
  like_btn:           '[data-e2e="like-icon"], [data-e2e="video-like-btn"]',
  liked_btn:          '[data-e2e="unlike-icon"]',
  comment_btn:        '[data-e2e="comment-icon"]',
  comment_input:      '[data-e2e="comment-input"]',
  comment_submit:     '[data-e2e="comment-post"]',
  follow_btn:         '[data-e2e="follow-button"]:not([data-e2e="unfollow-button"]), button:has-text("Follow"):not(:has-text("Following"))',
  following_badge:    '[data-e2e="unfollow-button"], button:has-text("Following")',

  // FYP scroll container
  fyp_container:      '[data-e2e="recommend-list"], [class*="DivMainFeed"]',

  // OAuth
  google_oauth_btn:   '[data-e2e="channel-item-google"], a:has-text("Continue with Google"), div:has-text("Continue with Google"):not(p)',
  facebook_oauth_btn: '[data-e2e="channel-item-facebook"], a:has-text("Continue with Facebook"), div:has-text("Continue with Facebook"):not(p)',
};

// ----------------------------------------------------------------
// Detection helper
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  if (url.includes('/login') && !url.includes('/accounts')) return null; // expected during login
  if (text.includes('Too many attempts') || text.includes('too many requests')) return 'action_block';
  if (text.includes('suspended') || text.includes('Your account was banned')) return 'disabled';
  if (url.includes('/challenge') || text.includes('verify')) return 'challenge';
  return null;
}

// ----------------------------------------------------------------
// 1a. _googleOAuthFlow — shared Google OAuth credential flow
// ----------------------------------------------------------------

async function _googleOAuthFlow(authPage, account) {
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await h.delay(h.randInt(1500, 2500));

  // Handle "use another account" picker
  const otherAcct = authPage.locator('li:has-text("Use another account"), div:has-text("Use another account")').first();
  if (await otherAcct.count() > 0) { await otherAcct.click(); await h.waitForLoad(authPage); }

  const emailInput = authPage.locator('input[type="email"]').first();
  if (await emailInput.count() > 0) {
    await h.humanType(authPage, 'input[type="email"]', account.email ?? account.username);
    await h.delay(h.randInt(600, 1000));
    await authPage.locator('#identifierNext button, button:has-text("Next")').first().click();
    await h.waitForLoad(authPage, 15000);
    await h.delay(h.randInt(1000, 2000));
  }

  const pwInput = authPage.locator('input[type="password"]:visible').first();
  if (await pwInput.count() > 0) {
    await h.humanType(authPage, 'input[type="password"]:visible', account.password);
    await h.delay(h.randInt(600, 1000));
    await authPage.locator('#passwordNext button, button:has-text("Next")').first().click();
    await h.waitForLoad(authPage, 20000);
  }

  // TOTP if needed
  const totpInput = authPage.locator('input[id*="totpPin"], input[name="totpPin"], input[aria-label*="code"]:visible').first();
  if (await totpInput.count() > 0 && account.two_fa_secret) {
    const { generateTOTP } = require('./instagram');
    await h.humanType(authPage, 'input[id*="totpPin"], input[name="totpPin"]', generateTOTP(account.two_fa_secret));
    await authPage.locator('button:has-text("Next"), button:has-text("Verify")').first().click();
    await h.waitForLoad(authPage, 15000);
  }
}

// ----------------------------------------------------------------
// 1b. loginWithGoogle — Google OAuth for TikTok
// ----------------------------------------------------------------

async function loginWithGoogle(page, account) {
  log.info('Logging in via Google OAuth', { username: account.email ?? account.username });

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Allow all")').first();
  if (await cookieBtn.count() > 0) { await cookieBtn.click(); await h.shortPause(); }

  const googleBtn = page.locator(SEL.google_oauth_btn).first();
  if (await googleBtn.count() === 0) return { success: false, event: 'login_required', message: 'Google login button not found on TikTok' };

  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await googleBtn.click();
  const popup = await popupPromise;

  await _googleOAuthFlow(popup ?? page, account);

  if (popup) {
    await popup.waitForEvent('close', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await h.delay(h.randInt(2000, 3500));
  }

  const url = page.url();
  if (url.includes('/login')) return { success: false, event: 'login_required' };

  log.info('Google OAuth login successful for TikTok', { username: account.email ?? account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 1c. loginWithFacebook — Facebook OAuth for TikTok
// ----------------------------------------------------------------

async function loginWithFacebook(page, account) {
  log.info('Logging in via Facebook OAuth for TikTok', { username: account.username });

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Allow all")').first();
  if (await cookieBtn.count() > 0) { await cookieBtn.click(); await h.shortPause(); }

  const fbBtn = page.locator(SEL.facebook_oauth_btn).first();
  if (await fbBtn.count() === 0) return { success: false, event: 'login_required', message: 'Facebook login button not found on TikTok' };

  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await fbBtn.click();
  const popup = await popupPromise;

  const authPage = popup ?? page;
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await h.delay(h.randInt(1500, 2500));

  const emailField = await authPage.$('input[id="email"], input[name="email"]');
  if (emailField) {
    await h.humanType(authPage, 'input[id="email"], input[name="email"]', account.email ?? account.username);
    await h.delay(h.randInt(500, 900));
    await h.humanType(authPage, 'input[id="pass"], input[name="pass"]', account.password);
    await h.delay(h.randInt(600, 1000));
    const loginBtn = authPage.locator('button[name="login"]').first();
    if (await loginBtn.count() > 0) await loginBtn.click();
    else await authPage.keyboard.press('Enter');
    await h.waitForLoad(authPage, 20000);
  }

  const continueBtn = authPage.locator('button:has-text("Continue"), button:has-text("OK")').first();
  if (await continueBtn.count() > 0) {
    await h.delay(h.randInt(800, 1500));
    await continueBtn.click();
    await h.waitForLoad(authPage, 15000);
  }

  if (popup) {
    await popup.waitForEvent('close', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await h.delay(h.randInt(1000, 2000));
  }

  const url = page.url();
  if (url.includes('/login')) return { success: false, event: 'login_required' };

  log.info('Facebook OAuth login successful for TikTok', { username: account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 1. login
// ----------------------------------------------------------------

async function login(page, account) {
  if (account.login_method === 'google')   return loginWithGoogle(page, account);
  if (account.login_method === 'facebook') return loginWithFacebook(page, account);
  // default: email/password
  log.info('Logging in', { username: account.username });

  await page.goto(`${BASE_URL}/login/phone-or-email/email`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Accept cookies if present
  const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Allow all")').first();
  if (await cookieBtn.count() > 0) {
    await cookieBtn.click();
    await h.shortPause();
  }

  await h.humanType(page, SEL.email_input, account.email ?? account.username);
  await h.delay(h.randInt(400, 800));
  await h.humanType(page, SEL.password_input, account.password);
  await h.delay(h.randInt(600, 1200));
  await h.humanClick(page, SEL.login_submit);
  await h.waitForLoad(page, 20000);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const currentUrl = page.url();
  if (currentUrl.includes('/login')) {
    return { success: false, event: 'login_required' };
  }

  log.info('Login successful', { username: account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. watchVideo — watch a video for a random percentage of duration
// ----------------------------------------------------------------

async function watchVideo(page, videoUrl, { referer = null } = {}) {
  log.debug('Watching video', { videoUrl });

  const gotoOpts = { waitUntil: 'domcontentloaded', timeout: 20000 };
  if (referer) gotoOpts.referer = referer;
  await page.goto(videoUrl, gotoOpts);
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Watch 20–90% of a typical 15–60s video
  const watchMs = h.randInt(8000, 45000);
  await h.delay(watchMs);

  // Natural scroll on page sometimes
  if (Math.random() < 0.3) {
    await h.humanScroll(page, { scrolls: h.randInt(1, 2) });
  }

  log.debug('Video watched', { videoUrl, watchMs });
  return { success: true };
}

// ----------------------------------------------------------------
// 3. likeVideo
// ----------------------------------------------------------------

async function likeVideo(page, videoUrl) {
  log.debug('Liking video', { videoUrl });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Check already liked
  const alreadyLiked = await page.$(SEL.liked_btn);
  if (alreadyLiked) return { success: true, alreadyLiked: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  await h.humanClick(page, SEL.like_btn);
  await h.delay(h.randInt(600, 1200));

  const nowLiked = await page.$(SEL.liked_btn);
  if (!nowLiked) {
    const d2 = await checkForDetection(page);
    if (d2) return { success: false, event: d2 };
  }

  log.debug('Video liked', { videoUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 4. followUser
// ----------------------------------------------------------------

async function followUser(page, username) {
  log.debug('Following user', { username });

  await page.goto(`${BASE_URL}/@${username}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const alreadyFollowing = await page.$(SEL.following_badge);
  if (alreadyFollowing) return { success: true, alreadyFollowing: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const followBtn = page.locator(SEL.follow_btn).first();
  if (await followBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Follow button not found' };
  }

  await h.scrollToElementHandle(page, await followBtn.elementHandle());
  await h.preAction();
  await followBtn.click();
  await h.delay(h.randInt(800, 1500));

  const nowFollowing = await page.$(SEL.following_badge);
  if (!nowFollowing) {
    const d2 = await checkForDetection(page);
    if (d2) return { success: false, event: d2 };
  }

  log.debug('Follow successful', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 5. commentVideo
// ----------------------------------------------------------------

async function commentVideo(page, videoUrl, text) {
  log.debug('Commenting on video', { videoUrl });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Open comment section
  const commentBtn = page.locator(SEL.comment_btn).first();
  if (await commentBtn.count() > 0) {
    await commentBtn.click();
    await h.delay(h.randInt(800, 1500));
  }

  const commentInput = page.locator(SEL.comment_input).first();
  if (await commentInput.count() === 0) {
    return { success: false, event: 'warning', message: 'Comment input not found' };
  }

  await commentInput.click();
  await h.shortPause();

  for (const char of text) {
    await page.keyboard.type(char);
    await h.typingPause();
  }

  await h.delay(h.randInt(600, 1200));

  const submitBtn = page.locator(SEL.comment_submit).first();
  if (await submitBtn.count() > 0) {
    await submitBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await h.delay(h.randInt(1000, 2000));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Comment posted', { videoUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 6. scrollFYP — For You Page natural scrolling
// ----------------------------------------------------------------

async function scrollFYP(page, { seconds = null } = {}) {
  const duration = seconds ?? h.randInt(30, 120);
  log.debug('Scrolling FYP', { duration });

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const start = Date.now();
  while (Date.now() - start < duration * 1000) {
    // TikTok FYP uses swipe — simulate via keyboard or scroll
    await page.keyboard.press('ArrowDown');
    await h.delay(h.randInt(500, 1500));

    // Watch the video for a bit
    const watchMs = h.randInt(5000, 20000);
    if (Date.now() - start + watchMs < duration * 1000) {
      await h.delay(watchMs);
    } else {
      break;
    }
  }

  return { success: true };
}

module.exports = {
  login,
  loginWithGoogle,
  loginWithFacebook,
  watchVideo,
  likeVideo,
  followUser,
  commentVideo,
  scrollFYP,
  checkForDetection,
};
