'use strict';

const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('Facebook');

const BASE_URL = 'https://www.facebook.com';

// ----------------------------------------------------------------
// Selector registry
// ----------------------------------------------------------------

const SEL = {
  // Login
  email_input:      'input[name="email"]',
  password_input:   'input[name="pass"]',
  login_button:     'button[name="login"], [data-testid="royal_login_button"]',

  // Cookie consent
  cookie_accept:    'button[title="Allow all cookies"], [aria-label="Allow all cookies"]',
  cookie_decline:   'button[title*="Only allow"], [data-cookiebanner="accept_only_essential_button"]',

  // Feed
  post_article:     '[role="article"], div[data-pagelet*="FeedUnit"]',

  // Reactions / like
  like_button:      '[aria-label="Like"], [aria-label*="React"]',
  liked_indicator:  '[aria-label="Remove Like"], [aria-pressed="true"][aria-label*="Like"]',

  // Comment
  comment_button:   '[aria-label="Comment"], [aria-label="Leave a comment"]',
  comment_input:    '[aria-label="Write a comment…"], [role="textbox"][aria-label*="comment"]',
  comment_submit:   '[aria-label="Comment"], button:has-text("Post")',

  // Follow / friend (follow is for Pages; friend request for profiles)
  follow_button:    '[aria-label="Follow"], button:has-text("Follow"):not(:has-text("Following"))',
  following_badge:  '[aria-label="Following"], button:has-text("Following")',
  add_friend_btn:   '[aria-label="Add friend"]',
  friend_sent_btn:  '[aria-label="Cancel friend request"], button:has-text("Requested")',

  // Profile
  cover_photo:      '[data-pagelet="ProfileTilesFeed"]',
};

// ----------------------------------------------------------------
// Detection
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  if (url.includes('/checkpoint/') || text.includes('Your account has been locked')) return 'challenge';
  if (text.includes('Your account has been disabled') || text.includes('permanently disabled')) return 'disabled';
  if (text.includes('temporarily blocked') || text.includes("You're Temporarily Blocked")) return 'action_block';
  if (url.includes('/login') && (text.includes('incorrect') || text.includes("password you entered"))) {
    return 'login_required';
  }
  return null;
}

// ----------------------------------------------------------------
// 1. login
// ----------------------------------------------------------------

async function login(page, account) {
  log.info('Logging in', { username: account.email ?? account.username });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Dismiss cookie consent
  const cookieBtn = page.locator(SEL.cookie_decline + ', ' + SEL.cookie_accept).first();
  if (await cookieBtn.count() > 0) {
    await cookieBtn.click();
    await h.shortPause();
  }

  await h.humanType(page, SEL.email_input, account.email ?? account.username);
  await h.delay(h.randInt(400, 900));
  await h.humanType(page, SEL.password_input, account.password);
  await h.delay(h.randInt(600, 1200));
  await h.humanClick(page, SEL.login_button);
  await h.waitForLoad(page, 20000);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Verify logged in: feed or home page should load
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('login.php')) {
    return { success: false, event: 'login_required' };
  }

  log.info('Login successful', { username: account.email ?? account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. scrollFeed
// ----------------------------------------------------------------

async function scrollFeed(page, { seconds = null } = {}) {
  const duration = seconds ?? h.randInt(30, 120);
  log.debug('Scrolling Facebook feed', { duration });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const start = Date.now();
  while (Date.now() - start < duration * 1000) {
    await h.humanScroll(page, { scrolls: h.randInt(2, 5) });
    await h.delay(h.randInt(1500, 4500));
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

  const alreadyLiked = await page.$(SEL.liked_indicator);
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
  await h.delay(h.randInt(600, 1200));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Post liked', { postUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 4. followUser — follow a Facebook Page or profile
// ----------------------------------------------------------------

async function followUser(page, profileUrl) {
  log.debug('Following', { profileUrl });

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const alreadyFollowing = await page.$(SEL.following_badge);
  if (alreadyFollowing) return { success: true, alreadyFollowing: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Try Follow button first (Pages), then Add Friend (profiles)
  let actionBtn = page.locator(SEL.follow_button).first();
  if (await actionBtn.count() === 0) {
    actionBtn = page.locator(SEL.add_friend_btn).first();
  }

  if (await actionBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Follow/Add Friend button not found' };
  }

  await h.scrollToElementHandle(page, await actionBtn.elementHandle());
  await h.preAction();
  await actionBtn.click();
  await h.delay(h.randInt(800, 1600));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Follow action completed', { profileUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 5. comment
// ----------------------------------------------------------------

async function comment(page, postUrl, text) {
  log.debug('Commenting on post', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Click Comment button to focus the input
  const commentBtn = page.locator(SEL.comment_button).first();
  if (await commentBtn.count() > 0) {
    await h.scrollToElementHandle(page, await commentBtn.elementHandle());
    await commentBtn.click();
    await h.delay(h.randInt(600, 1200));
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
  await page.keyboard.press('Enter');
  await h.delay(h.randInt(1000, 2000));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Comment posted', { postUrl });
  await h.postAction();
  return { success: true };
}

module.exports = {
  login,
  scrollFeed,
  likePost,
  followUser,
  comment,
  checkForDetection,
};
