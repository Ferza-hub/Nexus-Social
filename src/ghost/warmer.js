'use strict';

const { getDb }    = require('../database/db');
const { makeLogger } = require('../utils/logger');
const gm = require('./manager');

const log = makeLogger('GhostWarmer');

const MAX_WARMUP_ATTEMPTS  = parseInt(process.env.GHOST_WARMUP_RETRIES      ?? '3',      10);
const WARMUP_CONCURRENCY   = parseInt(process.env.GHOST_WARMUP_CONCURRENCY  ?? '2',      10);
// Hard wall-clock limit per attempt — fires even if Playwright hangs at socket level.
// Proxy CONNECT tunnels can stall indefinitely; page.goto timeout alone is not enough.
const ATTEMPT_HARD_TIMEOUT = parseInt(process.env.GHOST_ATTEMPT_TIMEOUT_MS  ?? '90000',  10);

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
// Single ghost warmup — retries up to MAX_WARMUP_ATTEMPTS
// Each attempt gets a fresh random proxy, so a bad proxy auto-rotates
// ----------------------------------------------------------------

async function warmupGhost(ghostId) {
  const { launchWithGhost, recordProxyFailure } = require('../playwright-engine/browser');

  const ghost = getDb().prepare('SELECT * FROM ghost_profiles WHERE id=?').get(ghostId);
  if (!ghost) throw new Error(`Ghost ${ghostId} not found`);
  if (ghost.status === 'ready') return { success: true, skipped: true };

  gm.setStatus(ghostId, 'warming');
  log.info('Warming ghost', { ghostId });

  for (let attempt = 1; attempt <= MAX_WARMUP_ATTEMPTS; attempt++) {
    let session = null;
    let proxyId = null;

    // Hard wall-clock timeout — fires even if Playwright is stuck at socket level.
    // We keep `session` in the outer scope so cleanup can run after the race.
    const attemptWork = async () => {
      session = await launchWithGhost(ghostId);
      proxyId = session.proxyId ?? null;
      const { page, context } = session;

      // ── Step 1: Land on YouTube, collect base cookies ──────────────
      await page.goto('https://www.youtube.com/', {
        waitUntil: 'domcontentloaded', timeout: 40_000,
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

          const isPaused = await page.evaluate(() => document.querySelector('video')?.paused ?? true).catch(() => true);
          if (isPaused) await page.click('#movie_player, video').catch(() => {});

          await delay(randInt(15_000, 25_000)); // 15-25s (was 35s — keep within hard timeout)

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
        await delay(randInt(1500, 2500));
      } catch (_) {}

      // ── Save the ghost's soul ───────────────────────────────────────
      const state = await context.storageState();
      gm.saveStorageState(ghostId, state);
      gm.logAction(ghostId, 'youtube', 'warmup', 'success');
    };

    try {
      await Promise.race([
        attemptWork(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Hard timeout ${ATTEMPT_HARD_TIMEOUT}ms`)), ATTEMPT_HARD_TIMEOUT)
        ),
      ]);

      log.info('Ghost ready', { ghostId, attempt });
      return { success: true };

    } catch (err) {
      const isNetErr = /timeout|net::|ECONNREFUSED|ECONNRESET|ERR_/i.test(err.message);
      log.warn(`Warmup attempt ${attempt}/${MAX_WARMUP_ATTEMPTS} failed`, { ghostId, err: err.message });

      // Penalise the proxy that caused a network/timeout failure
      if (proxyId && isNetErr) recordProxyFailure(proxyId);

      if (attempt >= MAX_WARMUP_ATTEMPTS) {
        gm.setStatus(ghostId, 'cold');
        gm.logAction(ghostId, 'youtube', 'warmup', 'failed', err.message);
        return { success: false, reason: err.message };
      }
      // Exponential backoff before retry — cleanup happens in finally first
    } finally {
      // cleanup() force-kills the browser process even if it's stuck
      if (session) await session.cleanup().catch(() => {});
    }

    // Backoff runs after finally (browser already killed)
    await delay(attempt * randInt(3000, 6000));
  }
}

// ----------------------------------------------------------------
// Batch warmup — N concurrent workers, each ghost tries up to
// MAX_WARMUP_ATTEMPTS times before giving up
// ----------------------------------------------------------------

const _warmupQueue = new Set();

async function warmupBatch(count = 0) {
  const cold = count > 0
    ? getDb().prepare(`SELECT id FROM ghost_profiles WHERE status='cold' LIMIT ?`).all(count)
    : getDb().prepare(`SELECT id FROM ghost_profiles WHERE status='cold'`).all();

  const queue = cold.filter(({ id }) => !_warmupQueue.has(id));
  log.info('Warmup batch started', { requested: count, found: queue.length, concurrency: WARMUP_CONCURRENCY });

  let done = 0;
  let cursor = 0; // shared index; safe because JS is single-threaded

  async function worker() {
    while (cursor < queue.length) {
      const { id } = queue[cursor++];
      _warmupQueue.add(id);
      try {
        const r = await warmupGhost(id);
        if (r.success && !r.skipped) done++;
      } catch (_) {
      } finally {
        _warmupQueue.delete(id);
      }
      // Small gap between each ghost on this worker
      if (cursor < queue.length) await delay(randInt(4000, 8000));
    }
  }

  await Promise.all(Array.from({ length: WARMUP_CONCURRENCY }, worker));

  log.info('Warmup batch done', { warmed: done, total: queue.length });
  return { warmed: done, total: queue.length };
}

function isWarming(ghostId) {
  return _warmupQueue.has(ghostId);
}

module.exports = { warmupGhost, warmupBatch, isWarming };
