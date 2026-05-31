'use strict';

const { getDb }    = require('../database/db');
const { makeLogger } = require('../utils/logger');
const gm = require('./manager');

const log = makeLogger('GhostWarmer');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr)  { return arr[Math.floor(Math.random() * arr.length)]; }

async function _mouseWander(page, steps = 3) {
  try {
    const vp = page.viewportSize() ?? { width: 1366, height: 768 };
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(
        randInt(80, vp.width - 80),
        randInt(80, vp.height - 80),
        { steps: randInt(8, 20) }
      );
      await delay(randInt(200, 600));
    }
  } catch (_) {}
}

// Innocuous YouTube search terms used during warmup
const WARMUP_SEARCHES = [
  'funny cats', 'cooking tutorial', 'travel vlog 2024',
  'music mix', 'workout routine', 'movie review',
  'tech unboxing', 'nature documentary', 'street food',
  'piano music relaxing',
];

const YT_CONSENT_SELECTORS = [
  'button[aria-label="Accept all"]',
  'button[aria-label="Reject all"]',
  '.eom-buttons button:first-child',
  'form[action*="consent"] button:last-child',
];

// ----------------------------------------------------------------
// Single ghost warmup
// ----------------------------------------------------------------

async function warmupGhost(ghostId) {
  const { launchWithGhost } = require('../playwright-engine/browser');

  const ghost = getDb().prepare('SELECT * FROM ghost_profiles WHERE id=?').get(ghostId);
  if (!ghost) throw new Error(`Ghost ${ghostId} not found`);
  if (ghost.status === 'ready') return { success: true, skipped: true };

  gm.setStatus(ghostId, 'warming');
  log.info('Warming ghost', { ghostId });

  let session = null;
  try {
    session = await launchWithGhost(ghostId);
    const { page, context } = session;

    // ── Step 1: Land on YouTube, collect base cookies ──────────────
    await page.goto('https://www.youtube.com/', {
      waitUntil: 'domcontentloaded', timeout: 45_000,
    });
    await delay(randInt(2000, 4000));

    // Accept cookie consent (EU / global pop-up)
    for (const sel of YT_CONSENT_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await delay(1000); break; }
      } catch (_) {}
    }

    // ── Step 2: Browse trending / homepage ──────────────────────────
    await delay(randInt(2000, 4000));
    await _mouseWander(page, randInt(3, 5));
    for (let i = 0; i < randInt(2, 4); i++) {
      await page.mouse.wheel(0, randInt(120, 400));
      await delay(randInt(700, 1500));
    }
    await _mouseWander(page, 2);

    // ── Step 3: Watch one random trending video ─────────────────────
    try {
      const thumbs = await page.$$('ytd-rich-item-renderer a#thumbnail[href]');
      if (thumbs.length > 0) {
        await thumbs[randInt(0, Math.min(thumbs.length - 1, 6))].click();
        await delay(randInt(3000, 6000));

        // Try to play if paused
        const isPaused = await page.evaluate(() => document.querySelector('video')?.paused ?? true).catch(() => true);
        if (isPaused) await page.click('#movie_player, video').catch(() => {});

        // Watch 15–35 seconds
        await delay(randInt(15_000, 35_000));

        // Light scroll (reading comments gesture)
        await page.mouse.wheel(0, randInt(200, 500));
        await delay(randInt(1500, 3000));

        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await delay(randInt(1500, 2500));
      }
    } catch (_) {}

    // ── Step 4: Search for something random ────────────────────────
    try {
      await page.click('input[name="search_query"]', { timeout: 5000 });
      const q = pick(WARMUP_SEARCHES);
      for (const ch of q) {
        await page.keyboard.type(ch);
        await delay(randInt(60, 160));
      }
      await page.keyboard.press('Enter');
      await delay(randInt(3000, 5000));
      await page.mouse.wheel(0, randInt(200, 500));
      await delay(randInt(2000, 3000));
    } catch (_) {}

    // ── Save the ghost's soul ───────────────────────────────────────
    const state = await context.storageState();
    gm.saveStorageState(ghostId, state);     // marks status='ready'
    gm.logAction(ghostId, 'youtube', 'warmup', 'success');

    log.info('Ghost ready', { ghostId });
    return { success: true };

  } catch (err) {
    log.error('Warmup failed', { ghostId, err: err.message });
    gm.setStatus(ghostId, 'cold');
    gm.logAction(ghostId, 'youtube', 'warmup', 'failed', err.message);
    return { success: false, reason: err.message };
  } finally {
    if (session) await session.cleanup();
  }
}

// ----------------------------------------------------------------
// Batch warmup — sequential, max N ghosts
// ----------------------------------------------------------------

const _warmupQueue = new Set();

async function warmupBatch(count = 0) {
  const cold = count > 0
    ? getDb().prepare(`SELECT id FROM ghost_profiles WHERE status='cold' LIMIT ?`).all(count)
    : getDb().prepare(`SELECT id FROM ghost_profiles WHERE status='cold'`).all();

  log.info('Warmup batch started', { requested: count, found: cold.length });

  let done = 0;
  for (const { id } of cold) {
    if (_warmupQueue.has(id)) continue;
    _warmupQueue.add(id);
    try {
      const r = await warmupGhost(id);
      if (r.success) done++;
    } finally {
      _warmupQueue.delete(id);
    }
    await delay(randInt(5000, 12_000)); // gap between warmups
  }

  log.info('Warmup batch done', { warmed: done });
  return { warmed: done, total: cold.length };
}

function isWarming(ghostId) {
  return _warmupQueue.has(ghostId);
}

module.exports = { warmupGhost, warmupBatch, isWarming };
