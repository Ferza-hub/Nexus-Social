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

  // Reels
  reel_like_button:   '[aria-label="Like"][role="button"], [aria-label*="React"][role="button"]',
  reel_liked:         '[aria-label="Remove Like"][role="button"]',
  reel_share_button:  '[aria-label="Send this to friends or post it on your timeline."], [aria-label*="Share"]',
  reel_share_confirm: 'button:has-text("Share to Feed"), button:has-text("Share now")',

  // Share (posts)
  share_button:     '[aria-label="Send this to friends or post it on your timeline."], [data-testid="share_action_button"], [aria-label*="Share"]',
  share_now:        'button:has-text("Share now"), div[role="button"]:has-text("Share now")',

  // Profile
  cover_photo:      '[data-pagelet="ProfileTilesFeed"]',
};

// ----------------------------------------------------------------
// Detection
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  // IP-based or device-based challenge (most common from VPS)
  if (
    url.includes('/checkpoint/') ||
    url.includes('/login/device-based/') ||
    url.includes('/two_step_verification/') ||
    url.includes('/security/') ||
    url.includes('/challenge/')
  ) return 'challenge';

  if (
    text.includes('Your account has been locked') ||
    text.includes('Enter the code we sent') ||
    text.includes('Check your email') ||
    text.includes('verify your identity') ||
    text.includes('Confirm your identity') ||
    text.includes('We detected an unusual login')
  ) return 'challenge';

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

  // Go directly to login page — avoids homepage overlay/redirect noise
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);

  // Cookie consent — Facebook uses many different UIs across regions; try each in sequence
  const COOKIE_BTNS = [
    'button[data-cookiebanner="accept_button"]',
    'button[data-cookiebanner="accept_only_essential_button"]',
    '[aria-label="Allow all cookies"]',
    'button:has-text("Accept All")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept")',
    'button:has-text("Only allow essential cookies")',
  ];
  for (const sel of COOKIE_BTNS) {
    const btn = page.locator(sel).first();
    if (await btn.count() > 0) {
      await btn.click().catch(() => {});
      await h.shortPause();
      break;
    }
  }

  // Wait for login form — if not visible, Facebook has already blocked the IP
  const emailField = page.locator('input[name="email"]').first();
  const formVisible = await emailField.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (!formVisible) {
    const detection = await checkForDetection(page);
    if (detection) return { success: false, event: detection };
    log.warn('Login form not found — likely IP-based challenge', { username: account.email ?? account.username });
    return { success: false, event: 'challenge', message: 'ip_blocked' };
  }

  await h.preAction();
  await h.humanType(page, 'input[name="email"]', account.email ?? account.username);
  await h.delay(h.randInt(400, 900));
  await h.humanType(page, 'input[id="pass"], input[name="pass"]', account.password);
  await h.delay(h.randInt(600, 1200));

  const loginBtn = page.locator('button[name="login"], [data-testid="royal_login_button"], button[type="submit"]').first();
  if (await loginBtn.count() > 0) await loginBtn.click();
  else await page.keyboard.press('Enter');
  await h.waitForLoad(page, 25000);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

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

// ----------------------------------------------------------------
// 6. watchReel
// ----------------------------------------------------------------

async function watchReel(page, reelUrl) {
  log.debug('Watching reel', { reelUrl });

  await page.goto(reelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Watch for a human-like duration
  await h.delay(h.randInt(8000, 30000));

  log.debug('Reel watched', { reelUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 7. likeReel
// ----------------------------------------------------------------

async function likeReel(page, reelUrl) {
  log.debug('Liking reel', { reelUrl });

  await page.goto(reelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const alreadyLiked = await page.$(SEL.reel_liked);
  if (alreadyLiked) return { success: true, alreadyLiked: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const likeBtn = page.locator(SEL.reel_like_button).first();
  if (await likeBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Reel like button not found' };
  }

  await h.scrollToElementHandle(page, await likeBtn.elementHandle());
  await h.shortPause();
  await likeBtn.click();
  await h.delay(h.randInt(600, 1200));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Reel liked', { reelUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 8. sharePost — share a post or reel to own timeline
// ----------------------------------------------------------------

async function sharePost(page, postUrl) {
  log.debug('Sharing post', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const shareBtn = page.locator(SEL.share_button).first();
  if (await shareBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Share button not found' };
  }

  await h.scrollToElementHandle(page, await shareBtn.elementHandle());
  await h.shortPause();
  await shareBtn.click();
  await h.delay(h.randInt(800, 1500));

  // Click "Share now" in the dropdown/modal
  const shareNow = page.locator(SEL.share_now).first();
  if (await shareNow.count() > 0) {
    await shareNow.click();
    await h.delay(h.randInt(1000, 2000));
  }

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Post shared', { postUrl });
  await h.postAction();
  return { success: true };
}

module.exports = {
  login,
  scrollFeed,
  likePost,
  followUser,
  comment,
  watchReel,
  likeReel,
  sharePost,
  checkForDetection,
};
