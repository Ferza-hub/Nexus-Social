'use strict';

const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('YouTube');
const BASE_URL = 'https://www.youtube.com';

// ----------------------------------------------------------------
// Selectors
// ----------------------------------------------------------------

const SEL = {
  avatar:           '#avatar-btn, #avatar-container',

  // Popups
  consent_accept:   'button[aria-label="Accept all"]',
  consent_eom:      '.eom-buttons button:first-child',
  dismiss:          '#dismiss-button, paper-button[dialog-dismiss], tp-yt-paper-button[aria-label="No thanks"]',
  age_gate:         'button:has-text("I understand and wish to proceed")',

  // Player
  video_el:         'video',
  movie_player:     '#movie_player',

  // Like
  like_btn:         'ytd-like-button-renderer button[aria-label*="like"], ytd-segmented-like-dislike-button-renderer button[aria-label*="like"]',
  liked_state:      'ytd-like-button-renderer button[aria-pressed="true"]',

  // Subscribe
  subscribe_btn:    '#subscribe-button button:not([aria-label*="Subscribed"]), ytd-subscribe-button-renderer button:not([aria-label*="Subscribed"])',
  subscribed_state: '#subscribe-button button[aria-label*="Subscribed"], ytd-subscribe-button-renderer button[aria-label*="Subscribed"]',
  notif_skip:       'ytd-popup-container button[aria-label*="No thanks"], yt-icon-button.notification-pref-button',

  // Comments
  comment_box:      '#contenteditable-root[contenteditable="true"]',
  comment_submit:   '#submit-button',

  // Search
  search_input:     'input[name="search_query"], input#search',
  search_results:   'ytd-video-renderer a#video-title, ytd-video-renderer h3 a[href*="watch"]',

  // Feed
  feed_video:       'ytd-rich-item-renderer',
};

const POPUP_SELS = [
  SEL.consent_accept,
  SEL.consent_eom,
  SEL.dismiss,
  SEL.age_gate,
];

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  if (url.includes('accounts.google.com/signin/v2/challenge')) return 'challenge';
  if (text.includes('account has been suspended') || text.includes('account has been disabled')) return 'disabled';
  if (text.includes('Too many requests') || text.includes('quota exceeded'))  return 'action_block';
  if (url.includes('/sorry/') || text.includes('unusual traffic'))           return 'challenge';
  return null;
}

async function _dismissPopups(page) {
  for (const sel of POPUP_SELS) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); await h.delay(600); }
    } catch (_) {}
  }
}

// Actual video duration from <video> element; returns seconds or null
async function _getDuration(page) {
  return page.evaluate(() => {
    const d = document.querySelector('video')?.duration;
    return (d && isFinite(d) && d > 5) ? d : null;
  }).catch(() => null);
}

// Click player centre or press 'k' to start playback
async function _ensurePlaying(page) {
  try {
    await page.waitForSelector(SEL.video_el, { timeout: 8000 });
    const isPaused = await page.evaluate(() => document.querySelector('video')?.paused ?? true);
    if (!isPaused) return;
    const player = await page.$(SEL.movie_player);
    const box    = player ? await player.boundingBox() : null;
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await page.keyboard.press('k');
    }
    await h.delay(h.randInt(500, 1000));
  } catch (_) {}
}

// Watch for `watchMs` ms with natural pause/resume + mouse idle
async function _watchSegmented(page, watchMs) {
  const segments = h.randInt(3, 6);
  const segMs    = Math.floor(watchMs / segments);
  const vp       = page.viewportSize() ?? { width: 1366, height: 768 };

  for (let seg = 0; seg < segments; seg++) {
    await h.delay(segMs);

    // Natural pause (25% chance, not on last segment)
    if (seg < segments - 1 && Math.random() < 0.25) {
      await page.keyboard.press('k');                      // pause
      await h.delay(h.randInt(2000, 7000));
      await page.keyboard.press('k');                      // resume
    }

    // Idle mouse movement (40% chance)
    if (Math.random() < 0.4) {
      await page.mouse.move(
        h.randInt(80, vp.width - 80),
        h.randInt(80, vp.height - 80),
        { steps: h.randInt(5, 15) },
      );
    }

    // At ~60% mark: peek at comments, then scroll back up
    if (seg === Math.floor(segments * 0.6) && Math.random() < 0.35) {
      await h.humanScroll(page, { scrolls: h.randInt(2, 4) });
      await h.delay(h.randInt(1500, 3500));
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await h.delay(h.randInt(600, 1200));
    }
  }
}

// ----------------------------------------------------------------
// 1. login — Google / YouTube sign-in
// ----------------------------------------------------------------

async function login(page, account) {
  log.info('Logging in', { username: account.email ?? account.username });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Already logged in?
  if (await page.$(SEL.avatar)) {
    log.info('Already logged in', { username: account.email ?? account.username });
    return { success: true };
  }

  // Navigate to sign-in
  const signInLink = page.locator('a[href*="accounts.google.com"], ytd-button-renderer a[href*="accounts.google"]').first();
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
  await h.humanType(page, 'input[type="email"]', account.email ?? account.username);
  await h.delay(h.randInt(400, 800));
  await page.locator('#identifierNext').first().click();
  await h.waitForLoad(page, 15000);
  await h.delay(h.randInt(800, 1500));

  const pwField = await page.$('input[type="password"]');
  if (!pwField) return { success: false, event: 'login_required' };

  await h.humanType(page, 'input[type="password"]', account.password);
  await h.delay(h.randInt(600, 1200));
  await page.locator('#passwordNext').first().click();
  await h.waitForLoad(page, 20000);

  // TOTP if needed
  const otpField = await page.$('input[id="totpPin"], input[aria-label*="code"]');
  if (otpField) {
    if (!account.two_fa_secret) return { success: false, event: 'challenge' };
    const { generateTOTP } = require('./instagram');
    const otp = generateTOTP(account.two_fa_secret);
    await h.humanType(page, 'input[id="totpPin"], input[aria-label*="code"]', otp);
    await h.delay(h.randInt(500, 900));
    const nextBtn = page.locator('#totpNext, button:has-text("Next")').first();
    if (await nextBtn.count() > 0) await nextBtn.click();
    await h.waitForLoad(page, 15000);
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  if (!await page.$('button#avatar-btn, #avatar-container')) {
    return { success: false, event: 'login_required' };
  }

  log.info('Login successful', { username: account.email ?? account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. watchVideo
//    Plays to watchPct% of actual video duration.
//    clickThrough=true skips navigation (already on the video page).
// ----------------------------------------------------------------

async function watchVideo(page, videoUrl, { watchPct = null, watchMs: watchMsOverride = null, clickThrough = false, referer = null } = {}) {
  log.debug('watchVideo', { videoUrl, clickThrough });

  if (!clickThrough) {
    const gotoOpts = { waitUntil: 'domcontentloaded', timeout: 20000 };
    if (referer) gotoOpts.referer = referer;
    await page.goto(videoUrl, gotoOpts);
    await h.waitForLoad(page);
    await h.preAction();
  }

  await _dismissPopups(page);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  await _ensurePlaying(page);

  let watchMs;
  if (watchMsOverride !== null) {
    watchMs = watchMsOverride;
  } else {
    const duration = await _getDuration(page);
    const pct      = watchPct ?? (h.randInt(45, 80) / 100);
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
// URL utilities — used by ghost system and anonymous view
// ----------------------------------------------------------------

function cleanUrl(url) {
  try {
    const u = new URL(url);
    // youtu.be short links
    if (u.hostname === 'youtu.be') {
      return `https://www.youtube.com/watch?v=${u.pathname.slice(1).split('?')[0]}`;
    }
    // Shorts → regular watch URL (Shorts page blocks headless playback)
    if (u.pathname.includes('/shorts/')) {
      const id = u.pathname.split('/shorts/')[1]?.split('?')[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    ['si', 'feature', 'pp', 'ab_channel'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch (_) { return url; }
}

function extractId(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.get('v'))         return u.searchParams.get('v');
    if (u.pathname.includes('/shorts/')) return u.pathname.split('/shorts/')[1]?.split('?')[0];
    if (u.hostname === 'youtu.be')       return u.pathname.slice(1).split('?')[0];
    return null;
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// 3. searchAndWatch
//    YouTube homepage → type keyword → reach target video → watchVideo
//
//    opts.targetUrl (ghost mode): search builds organic referrer, then
//      navigate to the specific target video (click from results if found,
//      direct nav if not). Referrer chain: search results → target video.
//
//    without targetUrl: click a random top result (normal account use).
// ----------------------------------------------------------------

async function searchAndWatch(page, keyword, opts = {}) {
  const { watchPct = null, targetUrl = null, clickThrough = false } = opts;
  log.debug('searchAndWatch', { keyword, targetUrl: targetUrl ? '(set)' : null });

  if (!clickThrough) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await h.waitForLoad(page);
    await h.preAction();
    await _dismissPopups(page);
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Type keyword into search box
  const searchBox = await page.$(SEL.search_input);
  if (!searchBox) return { success: false, event: 'warning', message: 'Search box not found' };

  await h.scrollToElementHandle(page, searchBox);
  await searchBox.click();
  await h.delay(h.randInt(400, 900));

  for (const ch of keyword) {
    await page.keyboard.type(ch);
    await h.typingPause();
  }
  await h.delay(h.randInt(400, 800));
  await page.keyboard.press('Enter');
  await h.waitForLoad(page, 15000);
  await h.delay(h.randInt(1500, 3500));

  // Browse results naturally (builds session intent signal)
  await h.humanScroll(page, { scrolls: h.randInt(2, 4) });
  await h.delay(h.randInt(1000, 2500));

  if (targetUrl) {
    // Ghost path: try to find target video in results and click it (organic);
    // fall back to direct navigation if not visible (search page = referrer).
    const videoId = extractId(targetUrl);
    let navigated = false;

    if (videoId) {
      try {
        const link = await page.$(`a[href*="${videoId}"]`);
        if (link) {
          const box = await link.boundingBox().catch(() => null);
          if (box) {
            await h.moveMouseTo(
              page,
              box.x + h.randInt(5, Math.max(6, box.width  - 5)),
              box.y + h.randInt(3, Math.max(4, box.height - 3)),
            );
            await h.delay(h.randInt(150, 400));
          }
          await link.click();
          navigated = true;
          await h.waitForLoad(page, 20000);
          await h.delay(h.randInt(2000, 4000));
        }
      } catch (_) {}
    }

    if (!navigated) {
      // Not in results → navigate directly; search page is still the referrer
      await page.goto(cleanUrl(targetUrl), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await h.delay(h.randInt(2000, 4000));
    }

  } else {
    // Normal path: click one of the top 5 results
    const results = await page.$$(SEL.search_results);
    if (results.length === 0) {
      return { success: false, event: 'warning', message: 'No search results found' };
    }
    const chosen = results[h.randInt(0, Math.min(results.length - 1, 4))];
    const box    = await chosen.boundingBox().catch(() => null);
    if (box) {
      await h.moveMouseTo(page, box.x + box.width / 2, box.y + box.height / 2);
      await h.shortPause();
    }
    await chosen.click();
    await h.waitForLoad(page, 20000);
    await h.delay(h.randInt(2000, 4000));
  }

  // Watch whatever video we landed on
  return watchVideo(page, page.url(), { watchPct, clickThrough: true });
}

// ----------------------------------------------------------------
// 4. scrollFeed
//    Browse homepage, hover over thumbnails, occasionally click & peek
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

    // Hover a random thumbnail
    const cards = page.locator(SEL.feed_video);
    const cnt   = await cards.count();
    if (cnt > 0) {
      const card = cards.nth(h.randInt(0, Math.min(cnt - 1, 8)));
      const el   = await card.elementHandle().catch(() => null);
      if (el) {
        const cb = await el.boundingBox().catch(() => null);
        if (cb) await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      }
    }

    // 20% chance: click a video and watch for a short peek (10-25s)
    if (Math.random() < 0.2) {
      const link = page.locator(SEL.feed_video).nth(h.randInt(0, 4));
      const a    = link.locator('a#video-title').first();
      if (await a.count() > 0) {
        await a.click();
        await h.waitForLoad(page, 15000);
        await h.delay(h.randInt(2000, 4000));
        await _dismissPopups(page);
        await _ensurePlaying(page);
        await h.delay(h.randInt(10_000, 25_000));
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await h.delay(h.randInt(1500, 3000));
      }
    }

    await h.delay(h.randInt(1500, 4000));
  }

  return { success: true };
}

// ----------------------------------------------------------------
// 5. subscribeChannel
// ----------------------------------------------------------------

async function subscribeChannel(page, channelUrl) {
  log.debug('subscribeChannel', { channelUrl });

  await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  if (await page.$(SEL.subscribed_state)) return { success: true, alreadySubscribed: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const subBtn = page.locator(SEL.subscribe_btn).first();
  if (await subBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Subscribe button not found' };
  }

  await h.scrollToElementHandle(page, await subBtn.elementHandle());
  await h.preAction();
  await subBtn.click();
  await h.delay(h.randInt(800, 1500));

  // Dismiss "turn on notifications" popup
  try {
    const notifSkip = page.locator(SEL.notif_skip).first();
    if (await notifSkip.count() > 0) {
      await notifSkip.click();
      await h.delay(500);
    }
  } catch (_) {}

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('subscribeChannel done', { channelUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 6. likeVideo
//    Watches 15-30 s first (natural), then likes
// ----------------------------------------------------------------

async function likeVideo(page, videoUrl) {
  log.debug('likeVideo', { videoUrl });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  if (await page.$(SEL.liked_state)) return { success: true, alreadyLiked: true };

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Watch a bit before liking (looks more natural)
  await _ensurePlaying(page);
  await h.delay(h.randInt(15_000, 30_000));

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

  log.debug('likeVideo done', { videoUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 7. commentVideo
// ----------------------------------------------------------------

async function commentVideo(page, videoUrl, text) {
  log.debug('commentVideo', { videoUrl });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();
  await _dismissPopups(page);

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  await h.humanScroll(page, { scrolls: h.randInt(3, 6) });
  await h.delay(h.randInt(1000, 2000));

  const commentBox = page.locator(SEL.comment_box).first();
  if (await commentBox.count() === 0) {
    return { success: false, event: 'warning', message: 'Comment box not found' };
  }

  await commentBox.click();
  await h.shortPause();

  for (const char of text) {
    await page.keyboard.type(char);
    await h.typingPause();
    if (char === ' ' && Math.random() < 0.25) await h.delay(h.randInt(100, 350));
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

  log.debug('commentVideo done', { videoUrl });
  await h.postAction();
  return { success: true };
}

module.exports = {
  login,
  watchVideo,
  searchAndWatch,
  scrollFeed,
  subscribeChannel,
  likeVideo,
  commentVideo,
  checkForDetection,
  // URL utilities for ghost / anonymous view systems
  cleanUrl,
  extractId,
};
