'use strict';

const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('Twitter');

const BASE_URL = 'https://x.com';

// ----------------------------------------------------------------
// Selector registry — X.com uses data-testid extensively
// ----------------------------------------------------------------

const SEL = {
  // Login flow
  username_input:    'input[autocomplete="username"], input[name="text"]',
  next_button:       '[role="button"]:has-text("Next"), [data-testid="LoginForm_Login_Button"]',
  password_input:    'input[name="password"], input[type="password"]',
  login_button:      '[data-testid="LoginForm_Login_Button"], [role="button"]:has-text("Log in")',
  // Verification code (email/phone challenge)
  challenge_input:   'input[data-testid="ocfEnterTextTextInput"], input[name="text"]',
  challenge_button:  '[data-testid="ocfEnterTextNextButton"]',

  // Feed
  tweet_article:     'article[data-testid="tweet"]',
  tweet_text:        '[data-testid="tweetText"]',

  // Interactions
  like_button:       '[data-testid="like"]',
  unlike_button:     '[data-testid="unlike"]',
  reply_button:      '[data-testid="reply"]',
  retweet_button:    '[data-testid="retweet"]',
  retweet_confirm:   '[data-testid="retweetConfirm"]',

  // Compose / reply
  tweet_textarea:    '[data-testid="tweetTextarea_0"], [role="textbox"][aria-label*="Tweet"]',
  tweet_submit:      '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',

  // Follow / unfollow
  follow_button:     '[data-testid$="-follow"]',
  following_button:  '[data-testid$="-unfollow"]',
  unfollow_confirm:  '[data-testid="confirmationSheetConfirm"]',

  // Search
  search_input:      '[data-testid="SearchBox_Search_Input"], input[aria-label*="Search"]',
};

// ----------------------------------------------------------------
// Detection helper
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  if (url.includes('/account/suspended') || text.includes('Your account is suspended')) {
    return 'disabled';
  }
  if (url.includes('/challenge') || text.includes('Verify your identity')) {
    return 'challenge';
  }
  if (text.includes('You are over the daily limit') || text.includes('rate limit exceeded')) {
    return 'action_block';
  }
  if (text.includes('Something went wrong') && url.includes('/login')) {
    return 'login_required';
  }
  return null;
}

// ----------------------------------------------------------------
// 1. login
// ----------------------------------------------------------------

async function login(page, account) {
  log.info('Logging in', { username: account.username });

  await page.goto(`${BASE_URL}/i/flow/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Step 1: Enter username / email
  await h.humanType(page, SEL.username_input, account.email ?? account.username);
  await h.delay(h.randInt(500, 1000));

  const nextBtn = page.locator(SEL.next_button).first();
  if (await nextBtn.count() > 0) {
    await nextBtn.click();
    await h.waitForLoad(page, 10000);
  }

  await h.delay(h.randInt(800, 1500));

  // Step 2: Handle phone/email challenge (X sometimes asks before password)
  const challengeInput = await page.$(SEL.challenge_input);
  if (challengeInput) {
    const challengeValue = account.phone ?? account.email ?? account.username;
    log.info('Identity challenge detected', { username: account.username });
    await h.humanType(page, SEL.challenge_input, challengeValue);
    await h.delay(h.randInt(400, 800));
    const challengeBtn = page.locator(SEL.challenge_button).first();
    if (await challengeBtn.count() > 0) {
      await challengeBtn.click();
      await h.waitForLoad(page, 10000);
    }
    await h.delay(h.randInt(600, 1200));
  }

  // Step 3: Enter password
  await h.humanType(page, SEL.password_input, account.password);
  await h.delay(h.randInt(600, 1200));

  const loginBtn = page.locator(SEL.login_button).first();
  if (await loginBtn.count() > 0) {
    await loginBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await h.waitForLoad(page, 20000);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
    return { success: false, event: 'login_required' };
  }

  log.info('Login successful', { username: account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. scrollFeed — scroll home timeline naturally
// ----------------------------------------------------------------

async function scrollFeed(page, { seconds = null } = {}) {
  const duration = seconds ?? h.randInt(30, 120);
  log.debug('Scrolling feed', { duration });

  await page.goto(`${BASE_URL}/home`, { waitUntil: 'domcontentloaded', timeout: 20000 });
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
// 3. likePost — like a tweet by URL
// ----------------------------------------------------------------

async function likePost(page, tweetUrl) {
  log.debug('Liking tweet', { tweetUrl });

  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Already liked?
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
  await h.delay(h.randInt(600, 1200));

  const nowLiked = await page.$(SEL.unlike_button);
  if (!nowLiked) {
    const d2 = await checkForDetection(page);
    if (d2) return { success: false, event: d2 };
    return { success: false, event: 'action_block' };
  }

  log.debug('Tweet liked', { tweetUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 4. followUser
// ----------------------------------------------------------------

async function followUser(page, username) {
  log.debug('Following user', { username });

  await page.goto(`${BASE_URL}/${username}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const alreadyFollowing = await page.$(SEL.following_button);
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

  const nowFollowing = await page.$(SEL.following_button);
  if (!nowFollowing) {
    const d2 = await checkForDetection(page);
    if (d2) return { success: false, event: d2 };
    return { success: false, event: 'warning', message: 'Follow may not have registered' };
  }

  log.debug('Follow successful', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 5. unfollowUser
// ----------------------------------------------------------------

async function unfollowUser(page, username) {
  log.debug('Unfollowing user', { username });

  await page.goto(`${BASE_URL}/${username}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const followingBtn = page.locator(SEL.following_button).first();
  if (await followingBtn.count() === 0) {
    return { success: true, notFollowing: true };
  }

  await h.scrollToElementHandle(page, await followingBtn.elementHandle());
  await h.shortPause();
  await followingBtn.click();
  await h.delay(h.randInt(600, 1200));

  // Confirm unfollow dialog
  const confirmBtn = page.locator(SEL.unfollow_confirm).first();
  if (await confirmBtn.count() > 0) {
    await h.delay(h.randInt(400, 900));
    await confirmBtn.click();
    await h.delay(h.randInt(500, 1000));
  }

  log.debug('Unfollow successful', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 6. replyTweet
// ----------------------------------------------------------------

async function replyTweet(page, tweetUrl, text) {
  log.debug('Replying to tweet', { tweetUrl });

  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Click reply button on the main tweet (first article)
  const replyBtn = page.locator(SEL.reply_button).first();
  if (await replyBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Reply button not found' };
  }

  await h.scrollToElementHandle(page, await replyBtn.elementHandle());
  await h.shortPause();
  await replyBtn.click();
  await h.delay(h.randInt(800, 1500));

  // Type reply in the compose textarea
  const textarea = page.locator(SEL.tweet_textarea).first();
  if (await textarea.count() === 0) {
    return { success: false, event: 'warning', message: 'Reply textarea not found' };
  }

  await textarea.click();
  await h.shortPause();

  for (const char of text) {
    await page.keyboard.type(char);
    await h.typingPause();
    if (char === ' ' && Math.random() < 0.25) {
      await h.delay(h.randInt(100, 350));
    }
  }

  await h.delay(h.randInt(600, 1200));

  const submitBtn = page.locator(SEL.tweet_submit).first();
  if (await submitBtn.count() > 0) {
    await submitBtn.click();
  } else {
    await page.keyboard.press('Control+Enter');
  }

  await h.delay(h.randInt(1000, 2000));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Reply posted', { tweetUrl });
  await h.postAction();
  return { success: true };
}

module.exports = {
  login,
  scrollFeed,
  likePost,
  followUser,
  unfollowUser,
  replyTweet,
  checkForDetection,
};
