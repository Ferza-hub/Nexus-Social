'use strict';

const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('YouTube');

const BASE_URL = 'https://www.youtube.com';

// ----------------------------------------------------------------
// Selector registry
// ----------------------------------------------------------------

const SEL = {
  // Google login flow
  sign_in_link:     'a[href*="accounts.google.com"], ytd-button-renderer a[href*="accounts.google"]',
  email_input:      'input[type="email"]',
  email_next:       '#identifierNext',
  password_input:   'input[type="password"]',
  password_next:    '#passwordNext',
  // 2FA / challenge
  otp_input:        'input[id="totpPin"], input[aria-label*="code"]',
  otp_next:         '#totpNext, button:has-text("Next")',

  // Video page
  like_button:      'ytd-like-button-renderer button[aria-label*="like this"], ytd-segmented-like-dislike-button-renderer button[aria-label*="like"]',
  liked_state:      'ytd-like-button-renderer button[aria-pressed="true"], ytd-toggle-button-renderer[is-toggled]',
  subscribe_button: '#subscribe-button button, ytd-subscribe-button-renderer button:not([aria-label*="Subscribed"])',
  subscribed_state: '#subscribe-button button[aria-label*="Subscribed"], ytd-subscribe-button-renderer button[aria-label*="Subscribed"]',
  // Confirm unsubscribe dialog
  confirm_unsub:    'yt-button-renderer[dialog-confirm] button, tp-yt-paper-dialog button:has-text("Unsubscribe")',

  // Comments
  comment_section:  'ytd-comments#comments',
  comment_box:      '#contenteditable-root[contenteditable="true"], #placeholder-area',
  comment_submit:   '#submit-button',
  sort_comments:    'yt-sort-filter-sub-menu-renderer',

  // Share
  share_button:     'button[aria-label="Share"], ytd-button-renderer button:has-text("Share")',
  share_copy_link:  'button[aria-label="Copy link"], yt-copy-link-renderer button',

  // Feed
  video_renderer:   'ytd-rich-item-renderer, ytd-compact-video-renderer',
  video_link:       'a#video-title',

  // Search
  search_input:     'input#search',
  search_submit:    'button#search-icon-legacy',
};

// ----------------------------------------------------------------
// Detection
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  if (url.includes('accounts.google.com/signin/v2/challenge')) return 'challenge';
  if (text.includes('This account has been suspended') || text.includes('disabled')) return 'disabled';
  if (text.includes('quota') || text.includes('Too many requests')) return 'action_block';
  if (url.includes('/sorry/') || text.includes('unusual traffic')) return 'challenge';
  return null;
}

// ----------------------------------------------------------------
// 1. login — Google account login via YouTube sign-in flow
// ----------------------------------------------------------------

async function login(page, account) {
  log.info('Logging in', { username: account.email ?? account.username });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Check if already logged in (avatar appears)
  const avatar = await page.$('button#avatar-btn, #avatar-container');
  if (avatar) {
    log.info('Already logged in', { username: account.email ?? account.username });
    return { success: true };
  }

  // Click "Sign in"
  const signInLink = page.locator(SEL.sign_in_link).first();
  if (await signInLink.count() > 0) {
    await signInLink.click();
    await h.waitForLoad(page, 15000);
  } else {
    await page.goto('https://accounts.google.com/ServiceLogin?service=youtube', {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await h.waitForLoad(page);
  }

  await h.preAction();

  // Step 1: email
  await h.humanType(page, SEL.email_input, account.email ?? account.username);
  await h.delay(h.randInt(400, 800));
  await page.locator(SEL.email_next).first().click();
  await h.waitForLoad(page, 15000);
  await h.delay(h.randInt(800, 1500));

  // Step 2: password
  const pwField = await page.$(SEL.password_input);
  if (!pwField) return { success: false, event: 'login_required' };

  await h.humanType(page, SEL.password_input, account.password);
  await h.delay(h.randInt(600, 1200));
  await page.locator(SEL.password_next).first().click();
  await h.waitForLoad(page, 20000);

  // Step 3: TOTP/2FA if needed
  const otpField = await page.$(SEL.otp_input);
  if (otpField) {
    if (!account.two_fa_secret) return { success: false, event: 'challenge' };
    const { generateTOTP } = require('./instagram');
    const otp = generateTOTP(account.two_fa_secret);
    await h.humanType(page, SEL.otp_input, otp);
    await h.delay(h.randInt(500, 900));
    const otpNext = page.locator(SEL.otp_next).first();
    if (await otpNext.count() > 0) await otpNext.click();
    await h.waitForLoad(page, 15000);
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Verify by checking avatar
  const loggedIn = await page.$('button#avatar-btn, #avatar-container');
  if (!loggedIn) return { success: false, event: 'login_required' };

  log.info('Login successful', { username: account.email ?? account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. watchVideo
// ----------------------------------------------------------------

async function watchVideo(page, videoUrl) {
  log.debug('Watching video', { videoUrl });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Click play if paused
  const playBtn = page.locator('button.ytp-play-button[aria-label*="Play"]').first();
  if (await playBtn.count() > 0) {
    await playBtn.click().catch(() => {});
  }

  // Watch 20–90% of a typical video duration (simulate realistic session)
  const watchMs = h.randInt(15000, 90000);
  await h.delay(watchMs);

  // Occasional scroll to comments section (natural)
  if (Math.random() < 0.35) {
    await h.humanScroll(page, { scrolls: h.randInt(2, 5) });
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

  // Already liked?
  const alreadyLiked = await page.$(SEL.liked_state);
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

  log.debug('Video liked', { videoUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 4. subscribeChannel  (rateType = 'follow')
// ----------------------------------------------------------------

async function subscribeChannel(page, channelUrl) {
  log.debug('Subscribing to channel', { channelUrl });

  await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Already subscribed?
  const alreadySub = await page.$(SEL.subscribed_state);
  if (alreadySub) return { success: true, alreadySubscribed: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const subBtn = page.locator(SEL.subscribe_button).first();
  if (await subBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Subscribe button not found' };
  }

  await h.scrollToElementHandle(page, await subBtn.elementHandle());
  await h.preAction();
  await subBtn.click();
  await h.delay(h.randInt(800, 1500));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Subscribed', { channelUrl });
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

  // Scroll down to reveal comment section
  await h.humanScroll(page, { scrolls: h.randInt(3, 6) });
  await h.delay(h.randInt(1000, 2000));

  // Click the comment box to activate it
  const commentBox = page.locator(SEL.comment_box).first();
  if (await commentBox.count() === 0) {
    return { success: false, event: 'warning', message: 'Comment box not found' };
  }

  await commentBox.click();
  await h.shortPause();

  for (const char of text) {
    await page.keyboard.type(char);
    await h.typingPause();
    if (char === ' ' && Math.random() < 0.25) {
      await h.delay(h.randInt(100, 350));
    }
  }

  await h.delay(h.randInt(700, 1300));

  const submitBtn = page.locator(SEL.comment_submit).first();
  if (await submitBtn.count() > 0) {
    await submitBtn.click();
  } else {
    await page.keyboard.press('Control+Enter');
  }

  await h.delay(h.randInt(1000, 2000));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Comment posted', { videoUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 6. scrollFeed — browse home/subscription feed
// ----------------------------------------------------------------

async function scrollFeed(page, { seconds = null } = {}) {
  const duration = seconds ?? h.randInt(30, 120);
  log.debug('Scrolling YouTube feed', { duration });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const start = Date.now();
  while (Date.now() - start < duration * 1000) {
    await h.humanScroll(page, { scrolls: h.randInt(2, 4) });

    // Hover over a random video to simulate browsing
    const videos = page.locator(SEL.video_renderer);
    const count  = await videos.count();
    if (count > 0) {
      const pick = videos.nth(h.randInt(0, Math.min(count - 1, 8)));
      const el   = await pick.elementHandle().catch(() => null);
      if (el) {
        const box = await el.boundingBox().catch(() => null);
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
    }

    await h.delay(h.randInt(2000, 5000));
  }

  return { success: true };
}

// ----------------------------------------------------------------
// shareVideo — opens share panel and copies link (registers as share event)
// ----------------------------------------------------------------

async function shareVideo(page, videoUrl) {
  log.debug('Sharing video', { videoUrl });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
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

  // Click "Copy link" — registers the share interaction server-side
  const copyBtn = page.locator(SEL.share_copy_link).first();
  if (await copyBtn.count() > 0) {
    await copyBtn.click();
    await h.delay(h.randInt(500, 1000));
  }

  // Dismiss panel with Escape
  await page.keyboard.press('Escape');

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Video shared', { videoUrl });
  await h.postAction();
  return { success: true };
}

module.exports = {
  login,
  watchVideo,
  likeVideo,
  subscribeChannel,
  commentVideo,
  scrollFeed,
  shareVideo,
  checkForDetection,
};
