'use strict';

const { makeLogger } = require('../utils/logger');
const h = require('./human');

const log = makeLogger('TargetDiscovery');

// ----------------------------------------------------------------
// Instagram — discover post URLs and user profiles
// ----------------------------------------------------------------

const ig = {
  // Scrape post URLs from a hashtag page
  async hashtagPosts(page, hashtag, { limit = 30 } = {}) {
    log.info('Discovering hashtag posts', { hashtag, limit });

    await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await h.waitForLoad(page);
    await h.preAction();

    const postUrls = new Set();

    // Scroll and collect links
    let attempts = 0;
    while (postUrls.size < limit && attempts < 10) {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/p/"]'))
          .map(a => a.href)
          .filter(href => /\/p\/[\w-]+\/?$/.test(href));
      });

      for (const url of links) postUrls.add(url);

      if (postUrls.size >= limit) break;

      await h.humanScroll(page, { scrolls: h.randInt(3, 6) });
      await h.delay(h.randInt(1000, 2500));
      attempts++;
    }

    const result = [...postUrls].slice(0, limit);
    log.info('Hashtag posts discovered', { hashtag, count: result.length });
    return result;
  },

  // Get follower usernames from a competitor's profile
  async competitorFollowers(page, username, { limit = 50 } = {}) {
    log.info('Discovering competitor followers', { username, limit });

    await page.goto(`https://www.instagram.com/${username}/followers/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await h.waitForLoad(page);
    await h.preAction();

    const followers = new Set();
    let attempts = 0;

    while (followers.size < limit && attempts < 15) {
      const handles = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="dialog"] a[href^="/"]'))
          .map(a => a.href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, ''))
          .filter(h => h && !h.includes('/') && h.length > 0);
      });

      for (const handle of handles) followers.add(handle);

      if (followers.size >= limit) break;

      // Scroll inside the followers modal
      await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) dialog.scrollTop += 400;
      });
      await h.delay(h.randInt(800, 1500));
      attempts++;
    }

    const result = [...followers].slice(0, limit);
    log.info('Competitor followers discovered', { username, count: result.length });
    return result;
  },

  // Get posts from the explore page
  async explorePosts(page, { limit = 20 } = {}) {
    log.info('Discovering explore posts', { limit });

    await page.goto('https://www.instagram.com/explore/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await h.waitForLoad(page);
    await h.preAction();

    const postUrls = new Set();
    let attempts = 0;

    while (postUrls.size < limit && attempts < 8) {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/p/"]'))
          .map(a => a.href)
          .filter(href => /\/p\/[\w-]+\/?$/.test(href));
      });

      for (const url of links) postUrls.add(url);
      if (postUrls.size >= limit) break;

      await h.humanScroll(page, { scrolls: h.randInt(2, 4) });
      await h.delay(h.randInt(1000, 2000));
      attempts++;
    }

    const result = [...postUrls].slice(0, limit);
    log.info('Explore posts discovered', { count: result.length });
    return result;
  },
};

// ----------------------------------------------------------------
// TikTok — discover video URLs and user profiles
// ----------------------------------------------------------------

const tt = {
  async hashtagVideos(page, hashtag, { limit = 20 } = {}) {
    log.info('Discovering TikTok hashtag videos', { hashtag, limit });

    await page.goto(`https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await h.waitForLoad(page);
    await h.preAction();

    const videoUrls = new Set();
    let attempts = 0;

    while (videoUrls.size < limit && attempts < 8) {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/video/"]'))
          .map(a => a.href)
          .filter(href => /\/video\/\d+/.test(href));
      });

      for (const url of links) videoUrls.add(url);
      if (videoUrls.size >= limit) break;

      await h.humanScroll(page, { scrolls: h.randInt(3, 5) });
      await h.delay(h.randInt(800, 2000));
      attempts++;
    }

    const result = [...videoUrls].slice(0, limit);
    log.info('TikTok hashtag videos discovered', { hashtag, count: result.length });
    return result;
  },
};

module.exports = { ig, tt };
