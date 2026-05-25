'use strict';

const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('Threads');

const BASE_URL = 'https://www.threads.net';

// ----------------------------------------------------------------
// Selector registry
// Threads shares the Instagram login system and uses similar React-based DOM
// ----------------------------------------------------------------

const SEL = {
  // Login
  username_input:   'input[autocomplete="username"], input[name="username"]',
  password_input:   'input[type="password"]',
  login_button:     'div[role="button"]:has-text("Log in"), button[type="submit"]',
  two_fa_input:     'input[aria-label*="Security code"], input[name="verificationCode"]',
  two_fa_submit:    'div[role="button"]:has-text("Confirm"), button[type="submit"]',

  // Feed — Threads uses pressable containers for posts
  post_container:   'div[data-pressable-container="true"], article',

  // Interactions
  like_button:      'svg[aria-label="Like"], div[role="button"][aria-label*="Like"]:not([aria-label*="unlike"])',
  unlike_button:    'svg[aria-label="Unlike"], div[role="button"][aria-label*="Unlike"]',
  reply_button:     'svg[aria-label="Reply"], div[role="button"][aria-label*="Reply"]',
  repost_button:    'svg[aria-label="Repost"], div[role="button"][aria-label*="Repost"]',

  // Follow
  follow_button:    'div[role="button"]:has-text("Follow"):not(:has-text("Following")), button:has-text("Follow"):not(:has-text("Following"))',
  following_badge:  'div[role="button"]:has-text("Following"), button:has-text("Following")',
  unfollow_confirm: 'div[role="button"]:has-text("Unfollow"), button:has-text("Unfollow")',

  // Reply/compose
  reply_textarea:   'div[contenteditable="true"][aria-label*="reply"], div[role="textbox"]',
  post_textarea:    'div[contenteditable="true"][aria-label*="thread"], div[role="textbox"]',
  post_submit:      'div[role="button"]:has-text("Post"), button:has-text("Post")',
};

// ----------------------------------------------------------------
// Detection
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  if (url.includes('/challenge') || text.includes('We suspended your account')) return 'challenge';
  if (text.includes('Your account has been disabled')) return 'disabled';
  if (text.includes('Action Blocked') || text.includes('Try again later')) return 'action_block';
  if (url.includes('/login') && text.includes('incorrect')) return 'login_required';
  return null;
}

// ----------------------------------------------------------------
// 1. login — Threads uses Instagram credentials
// ----------------------------------------------------------------

async function login(page, account) {
  log.info('Logging in', { username: account.username });

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Accept cookies if prompted
  const cookieBtn = page.locator('button:has-text("Allow all cookies"), button:has-text("Accept")').first();
  if (await cookieBtn.count() > 0) {
    await cookieBtn.click();
    await h.shortPause();
  }

  await h.humanType(page, SEL.username_input, account.username);
  await h.delay(h.randInt(400, 800));
  await h.humanType(page, SEL.password_input, account.password);
  await h.delay(h.randInt(600, 1200));
  await h.humanClick(page, SEL.login_button);
  await h.waitForLoad(page, 20000);

  // 2FA
  const twoFaField = await page.$(SEL.two_fa_input);
  if (twoFaField) {
    if (!account.two_fa_secret) return { success: false, event: 'challenge' };
    const { generateTOTP } = require('./instagram');
    const otp = generateTOTP(account.two_fa_secret);
    await h.humanType(page, SEL.two_fa_input, otp);
    await h.delay(h.randInt(400, 800));
    await h.humanClick(page, SEL.two_fa_submit);
    await h.waitForLoad(page, 15000);
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  if (page.url().includes('/login')) return { success: false, event: 'login_required' };

  log.info('Login successful', { username: account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. scrollFeed
// ----------------------------------------------------------------

async function scrollFeed(page, { seconds = null } = {}) {
  const duration = seconds ?? h.randInt(30, 120);
  log.debug('Scrolling Threads feed', { duration });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const start = Date.now();
  while (Date.now() - start < duration * 1000) {
    await h.humanScroll(page, { scrolls: h.randInt(2, 5) });
    await h.delay(h.randInt(1500, 4000));
  }

  return { success: true };
}

// ----------------------------------------------------------------
// 3. likePost
// ----------------------------------------------------------------

async function likePost(page, postUrl) {
  log.debug('Liking post', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const alreadyLiked = await page.$(SEL.unlike_button);
  if (alreadyLiked) return { success: true, alreadyLiked: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const likeBtn = page.locator(SEL.like_button).first();
  if (await likeBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Like button not found' };
  }

  await h.scrollToElementHandle(page, await likeBtn.elementHandle());
  await h.shortPause();
  await likeBtn.click();
  await h.delay(h.randInt(500, 1000));

  log.debug('Post liked', { postUrl });
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

  const followBtn = page.locator(SEL.follow_button).first();
  if (await followBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Follow button not found' };
  }

  await h.scrollToElementHandle(page, await followBtn.elementHandle());
  await h.preAction();
  await followBtn.click();
  await h.delay(h.randInt(800, 1600));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Follow successful', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 5. unfollowUser
// ----------------------------------------------------------------

async function unfollowUser(page, username) {
  log.debug('Unfollowing user', { username });

  await page.goto(`${BASE_URL}/@${username}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const followingBtn = page.locator(SEL.following_badge).first();
  if (await followingBtn.count() === 0) return { success: true, notFollowing: true };

  await followingBtn.click();
  await h.delay(h.randInt(600, 1200));

  const confirmBtn = page.locator(SEL.unfollow_confirm).first();
  if (await confirmBtn.count() > 0) {
    await h.delay(h.randInt(400, 800));
    await confirmBtn.click();
    await h.delay(h.randInt(500, 1000));
  }

  log.debug('Unfollow successful', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 6. comment — reply to a thread post
// ----------------------------------------------------------------

async function comment(page, postUrl, text) {
  log.debug('Commenting on post', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Click reply to open compose box
  const replyBtn = page.locator(SEL.reply_button).first();
  if (await replyBtn.count() > 0) {
    await replyBtn.click();
    await h.delay(h.randInt(600, 1200));
  }

  const textarea = page.locator(SEL.reply_textarea).first();
  if (await textarea.count() === 0) {
    return { success: false, event: 'warning', message: 'Reply textarea not found' };
  }

  await textarea.click();
  await h.shortPause();

  for (const char of text) {
    await page.keyboard.type(char);
    await h.typingPause();
  }

  await h.delay(h.randInt(600, 1200));

  const submitBtn = page.locator(SEL.post_submit).first();
  if (await submitBtn.count() > 0) {
    await submitBtn.click();
  } else {
    await page.keyboard.press('Control+Enter');
  }

  await h.delay(h.randInt(1000, 2000));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Reply posted', { postUrl });
  await h.postAction();
  return { success: true };
}

module.exports = {
  login,
  scrollFeed,
  likePost,
  followUser,
  unfollowUser,
  comment,
  checkForDetection,
};
