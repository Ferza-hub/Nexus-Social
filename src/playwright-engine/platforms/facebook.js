'use strict';

const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('Facebook');
const BASE_URL = 'https://www.facebook.com';

// ----------------------------------------------------------------
// Selectors
// ----------------------------------------------------------------

const SEL = {
  // Auth
  email_input:      'input[name="email"]',
  password_input:   'input[name="pass"]',
  login_button:     'button[name="login"], [data-testid="royal_login_button"]',

  // Popups / consent
  cookie_decline:   '[data-cookiebanner="accept_only_essential_button"], button[title*="Only allow"]',
  cookie_accept:    '[aria-label="Allow all cookies"], button[title="Allow all cookies"]',
  modal_close:      '[aria-label="Close"], [data-testid="close-button"]',
  notif_not_now:    'button:has-text("Not Now"), [aria-label="Not Now"]',

  // Feed
  post_article:     '[role="article"], div[data-pagelet*="FeedUnit"]',

  // Like / React
  like_btn:         '[aria-label="Like"], [aria-label*="React to"]',
  liked_indicator:  '[aria-label="Remove Like"], [aria-pressed="true"][aria-label*="Like"]',

  // Comment
  comment_btn:      '[aria-label="Comment"], [aria-label="Leave a comment"]',
  comment_input:    '[aria-label="Write a comment…"], [role="textbox"][aria-label*="comment"]',

  // Follow / Page
  follow_btn:       '[aria-label="Follow"], button:has-text("Follow"):not(:has-text("Following")):not(:has-text("Unfollow"))',
  following_badge:  '[aria-label="Following"], button:has-text("Following")',
  add_friend_btn:   '[aria-label="Add friend"]',

  // Video
  video_el:         'video',
  video_play_btn:   '[aria-label="Play"], [aria-label*="play"]',

  // Reels — Facebook uses a similar vertical scroll player
  reels_container:  '[role="main"]',
};

const POPUP_SELS = [
  SEL.notif_not_now,
  SEL.modal_close,
];

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  if (url.includes('/checkpoint/') || text.includes('Your account has been locked'))    return 'challenge';
  if (text.includes('account has been disabled') || text.includes('permanently disabled')) return 'disabled';
  if (text.includes('temporarily blocked') || text.includes("You're Temporarily Blocked")) return 'action_block';
  if (url.includes('/login') && text.includes('incorrect'))                              return 'login_required';
  return null;
}

async function _dismissPopups(page) {
  // Cookie banner first
  for (const sel of [SEL.cookie_decline, SEL.cookie_accept]) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); await h.delay(700); break; }
    } catch (_) {}
  }
  // Other modals
  for (const sel of POPUP_SELS) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); await h.delay(500); }
    } catch (_) {}
  }
}

// Actual video duration from <video>; returns seconds or null
async function _getDuration(page) {
  return page.evaluate(() => {
    const d = document.querySelector('video')?.duration;
    return (d && isFinite(d) && d > 3) ? d : null;
  }).catch(() => null);
}

// Try to start video playback
async function _ensurePlaying(page) {
  try {
    await page.waitForSelector(SEL.video_el, { timeout: 6000 });
    const isPaused = await page.evaluate(() => document.querySelector('video')?.paused ?? true);
    if (!isPaused) return;
    // Try aria-label play button first, then click video element
    const playBtn = page.locator(SEL.video_play_btn).first();
    if (await playBtn.count() > 0) {
      await playBtn.click();
    } else {
      const vid = await page.$('video');
      if (vid) {
        const box = await vid.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
    await h.delay(h.randInt(500, 1200));
  } catch (_) {}
}

// Watch for totalMs ms with idle mouse & occasional scroll peek
async function _watchSegmented(page, totalMs) {
  const segments = h.randInt(3, 5);
  const segMs    = Math.floor(totalMs / segments);
  const vp       = page.viewportSize() ?? { width: 1366, height: 768 };

  for (let seg = 0; seg < segments; seg++) {
    await h.delay(segMs);

    // Idle mouse (35% chance)
    if (Math.random() < 0.35) {
      await page.mouse.move(
        h.randInt(80, vp.width - 80),
        h.randInt(80, vp.height - 80),
        { steps: h.randInt(5, 12) },
      );
    }
  }
}

// ----------------------------------------------------------------
// 1. login
// ----------------------------------------------------------------

async function login(page, account) {
  log.info('Logging in', { username: account.email ?? account.username });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await _dismissPopups(page);
  await h.preAction();

  const currentUrl = page.url();
  if (!currentUrl.includes('/login') && !currentUrl.includes('login.php')) {
    log.info('Already logged in');
    return { success: true };
  }

  await h.humanType(page, SEL.email_input, account.email ?? account.username);
  await h.delay(h.randInt(400, 900));
  await h.humanType(page, SEL.password_input, account.password);
  await h.delay(h.randInt(600, 1200));
  await h.humanClick(page, SEL.login_button);
  await h.waitForLoad(page, 20000);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const afterUrl = page.url();
  if (afterUrl.includes('/login') || afterUrl.includes('login.php')) {
    return { success: false, event: 'login_required' };
  }

  // Dismiss first-visit popups
  await _dismissPopups(page);

  log.info('Login successful', { username: account.email ?? account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. watchReel
//    Opens facebook.com/reels/, watches N reels with realistic duration.
//    Navigates between reels via keyboard ArrowDown.
// ----------------------------------------------------------------

async function watchReel(page, { reelCount = null, maxMs = null } = {}) {
  const count   = reelCount ?? h.randInt(3, 8);
  const budget  = maxMs    ?? 180_000; // 3-min session cap
  log.debug('watchReel', { count, budget });

  await page.goto(`${BASE_URL}/reels/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  let watched  = 0;
  const tStart = Date.now();

  for (let i = 0; i < count; i++) {
    if (Date.now() - tStart >= budget) break;

    // Try to start the current reel
    await _ensurePlaying(page);
    await h.delay(h.randInt(800, 1500)); // let it buffer

    // Actual reel duration (most are 15-90s)
    const duration = await _getDuration(page);
    let watchMs;
    if (duration) {
      // Watch 80-100% of reel — reels are meant to be watched fully
      watchMs = Math.round(duration * (0.8 + Math.random() * 0.2) * 1000);
      watchMs = Math.min(watchMs, 90_000);
    } else {
      watchMs = h.randInt(15_000, 45_000);
    }

    // Cap remaining budget
    watchMs = Math.min(watchMs, budget - (Date.now() - tStart));
    if (watchMs < 5000) break;

    log.debug(`Reel ${i + 1}/${count}`, { duration, watchMs });
    await _watchSegmented(page, watchMs);
    watched++;

    // Advance to next reel
    if (i < count - 1) {
      // Try ArrowDown, then fallback to scroll
      await page.keyboard.press('ArrowDown');
      await h.delay(h.randInt(1000, 2000));

      // If ArrowDown didn't work, use scroll
      const stillSameUrl = page.url().includes('/reels/');
      if (stillSameUrl) {
        await page.mouse.wheel(0, h.randInt(600, 900));
        await h.delay(h.randInt(800, 1500));
      }
    }
  }

  log.debug('watchReel done', { watched });
  return { success: true, reelsWatched: watched };
}

// ----------------------------------------------------------------
// 3. watchVideo
//    Watches a specific Facebook video post to X% of actual duration.
// ----------------------------------------------------------------

async function watchVideo(page, videoUrl, { watchMs: watchMsOverride = null, referer = null } = {}) {
  log.debug('watchVideo', { videoUrl });

  const gotoOpts = { waitUntil: 'domcontentloaded', timeout: 25000 };
  if (referer) gotoOpts.referer = referer;
  await page.goto(videoUrl, gotoOpts);
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  await _ensurePlaying(page);
  await h.delay(h.randInt(1000, 2000)); // let it buffer

  let watchMs;
  if (watchMsOverride !== null) {
    watchMs = watchMsOverride;
  } else {
    const duration = await _getDuration(page);
    const pct      = h.randInt(55, 85) / 100;
    if (duration) {
      watchMs = Math.round(duration * pct * 1000);
      watchMs = Math.min(watchMs, 300_000);
      watchMs = Math.max(watchMs, 15_000);
    } else {
      watchMs = h.randInt(20_000, 90_000);
    }
  }

  log.debug('Watch plan', { duration, pct, watchMs });
  await _watchSegmented(page, watchMs);

  log.debug('watchVideo done', { videoUrl, watchMs });
  return { success: true, watchMs };
}

// ----------------------------------------------------------------
// 4. scrollFeed
//    Scroll the news feed — pause on posts, simulate reading
// ----------------------------------------------------------------

async function scrollFeed(page, { seconds = null } = {}) {
  const duration = (seconds ?? h.randInt(30, 120)) * 1000;
  log.debug('scrollFeed', { duration });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const start = Date.now();
  while (Date.now() - start < duration) {
    await h.humanScroll(page, { scrolls: h.randInt(2, 4) });

    // Pause on an article (reading simulation)
    const articles = page.locator(SEL.post_article);
    const cnt      = await articles.count();
    if (cnt > 0) {
      const art = articles.nth(h.randInt(0, Math.min(cnt - 1, 5)));
      const el  = await art.elementHandle().catch(() => null);
      if (el) {
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          // Move mouse to centre of article
          await page.mouse.move(box.x + box.width / 2, box.y + h.randInt(40, box.height - 40));
          // Reading pause
          await h.delay(h.randInt(1500, 4500));
        }
      }
    }

    await h.delay(h.randInt(500, 2000));
  }

  return { success: true };
}

// ----------------------------------------------------------------
// 5. likePost
//    Scrolls to Like button and clicks with a Like react
// ----------------------------------------------------------------

async function likePost(page, postUrl) {
  log.debug('likePost', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  if (await page.$(SEL.liked_indicator)) return { success: true, alreadyLiked: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Scroll to the post first (reading simulation)
  await h.humanScroll(page, { scrolls: h.randInt(2, 4) });
  await h.delay(h.randInt(1500, 3500));

  const likeBtn = page.locator(SEL.like_btn).first();
  if (await likeBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Like button not found' };
  }

  await h.scrollToElementHandle(page, await likeBtn.elementHandle());
  await h.shortPause();
  await likeBtn.click();
  await h.delay(h.randInt(600, 1200));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('likePost done', { postUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 6. followPage
//    Follows a Facebook Page (creator/brand).
//    Uses Follow button — not "Add Friend" (for Pages, not personal profiles).
// ----------------------------------------------------------------

async function followPage(page, profileUrl) {
  log.debug('followPage', { profileUrl });

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  if (await page.$(SEL.following_badge)) return { success: true, alreadyFollowing: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Prefer Follow button (Pages); Add Friend is for personal profiles
  let actionBtn = page.locator(SEL.follow_btn).first();
  if (await actionBtn.count() === 0) {
    actionBtn = page.locator(SEL.add_friend_btn).first();
  }

  if (await actionBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Follow button not found' };
  }

  await h.scrollToElementHandle(page, await actionBtn.elementHandle());
  await h.preAction();
  await actionBtn.click();
  await h.delay(h.randInt(800, 1600));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('followPage done', { profileUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 7. comment (kept for completeness)
// ----------------------------------------------------------------

async function comment(page, postUrl, text) {
  log.debug('comment', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const commentBtn = page.locator(SEL.comment_btn).first();
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

  log.debug('comment done', { postUrl });
  await h.postAction();
  return { success: true };
}

// Legacy alias (used by existing routes)
const followUser = followPage;

module.exports = {
  login,
  watchReel,
  watchVideo,
  scrollFeed,
  likePost,
  followPage,
  followUser,
  comment,
  checkForDetection,
};
