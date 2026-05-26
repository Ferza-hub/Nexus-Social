'use strict';

// Human behavior simulation layer
//
// Two modes:
//   Normal    — full random delays, Bezier mouse, miss-click simulation
//   Speed     — cosmetic waits removed, functional minimums preserved
//
// "Functional" delays keep actions from racing ahead of the DOM.
// They are never zeroed — only reduced to a safe floor.

let _speedMode = (process.env.SPEED_MODE === 'true');

function setSpeedMode(enabled) {
  _speedMode = !!enabled;
}

function isSpeedMode() {
  return _speedMode;
}

// full random range in normal mode; min value in speed mode
function randInt(min, max) {
  if (_speedMode) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ----------------------------------------------------------------
// Action timing
//
//   preAction  — cosmetic "thinking" pause before starting   → skipped in speed mode
//   postAction — cooldown after completing an action         → skipped in speed mode
//   shortPause — functional settle time after a click/scroll → 80ms floor
//   typingPause— per-character typing rhythm                 → 15ms floor
// ----------------------------------------------------------------

async function preAction() {
  if (_speedMode) return;
  await delay(randInt(800, 3000));
}

async function postAction() {
  if (_speedMode) return;
  await delay(randInt(2000, 8000));
}

async function shortPause() {
  await delay(_speedMode ? 80 : randInt(300, 800));
}

async function typingPause() {
  await delay(_speedMode ? 15 : randInt(50, 180));
}

// ----------------------------------------------------------------
// Bezier curve mouse movement
// Speed mode: 3 steps instead of 8-20, no inter-step delay
// ----------------------------------------------------------------

function bezierPoint(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

async function moveMouseTo(page, targetX, targetY) {
  const currentPos = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));

  const steps = _speedMode ? 3 : randInt(8, 20);
  const cx1 = currentPos.x + randInt(-150, 150);
  const cy1 = currentPos.y + randInt(-150, 150);
  const cx2 = targetX + randInt(-100, 100);
  const cy2 = targetY + randInt(-100, 100);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(bezierPoint(t, currentPos.x, cx1, cx2, targetX));
    const y = Math.round(bezierPoint(t, currentPos.y, cy1, cy2, targetY));
    await page.mouse.move(x, y);
    if (!_speedMode) await delay(randInt(5, 25));
  }
}

// ----------------------------------------------------------------
// Scroll to element — always executes for correct DOM position,
// settle time reduced to 120ms in speed mode
// ----------------------------------------------------------------

async function scrollToElement(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, selector);
  await delay(_speedMode ? 120 : randInt(400, 900));
}

async function scrollToElementHandle(page, elementHandle) {
  await elementHandle.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await delay(_speedMode ? 120 : randInt(400, 900));
}

// ----------------------------------------------------------------
// Click — miss-click simulation disabled in speed mode
// ----------------------------------------------------------------

async function humanClick(page, selector, { missChance = 0.08 } = {}) {
  const el = await page.waitForSelector(selector, { timeout: 10000 });
  await scrollToElementHandle(page, el);

  const box = await el.boundingBox();
  if (!box) throw new Error(`No bounding box for: ${selector}`);

  const targetX = box.x + box.width  / 2 + randInt(-3, 3);
  const targetY = box.y + box.height / 2 + randInt(-3, 3);

  await moveMouseTo(page, targetX, targetY);
  await shortPause();

  // Miss-click disabled in speed mode — wastes time with no quality benefit
  if (!_speedMode && Math.random() < missChance) {
    await page.mouse.click(targetX + randInt(-15, 15), targetY + randInt(-10, 10));
    await delay(randInt(300, 600));
    await moveMouseTo(page, targetX, targetY);
    await shortPause();
  }

  await page.mouse.click(targetX, targetY);
}

// ----------------------------------------------------------------
// Type — character delay reduced in speed mode, word pauses removed
// ----------------------------------------------------------------

async function humanType(page, selector, text) {
  await humanClick(page, selector, { missChance: 0 });
  await shortPause();

  for (const char of text) {
    await page.keyboard.type(char);
    await typingPause();

    if (!_speedMode && char === ' ' && Math.random() < 0.3) {
      await delay(randInt(100, 400));
    }
  }
}

// ----------------------------------------------------------------
// Scroll feed — idle reading pauses removed in speed mode
// ----------------------------------------------------------------

async function humanScroll(page, { scrolls = null, totalPx = null } = {}) {
  const count = scrolls ?? randInt(3, 12);
  let scrolled = 0;
  const target = totalPx ?? randInt(800, 4000);

  for (let i = 0; i < count; i++) {
    const goBack = !_speedMode && Math.random() < 0.15 && scrolled > 200;
    const amount = goBack ? -randInt(80, 200) : randInt(80, 350);

    await page.mouse.wheel(0, amount);
    scrolled += amount;

    await delay(_speedMode ? 80 : randInt(200, 800));

    // Reading simulation — skipped in speed mode
    if (!_speedMode && Math.random() < 0.1) {
      await delay(randInt(800, 3000));
    }

    if (!goBack && scrolled >= target) break;
  }
}

// ----------------------------------------------------------------
// Page load wait — never modified, always functional
// ----------------------------------------------------------------

async function waitForLoad(page, timeout = 15000) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } catch (_) {
    // timeout on networkidle is OK — page may have long-poll connections
  }
}

module.exports = {
  randInt,
  randFloat,
  delay,
  preAction,
  postAction,
  shortPause,
  typingPause,
  moveMouseTo,
  scrollToElement,
  scrollToElementHandle,
  humanClick,
  humanType,
  humanScroll,
  waitForLoad,
  setSpeedMode,
  isSpeedMode,
};
