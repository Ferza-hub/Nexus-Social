'use strict';

// Focused unit tests for the two most critical functions:
//   canAct()        — pre-action gate combining status, warmup, rate, and cooldown checks
//   generateTOTP()  — RFC 6238 inline TOTP implementation

require('dotenv').config();
const assert = require('assert');

const { getDb, closeDb } = require('../src/database/db');
const { runMigrations }  = require('../src/database/schema');
const am                 = require('../src/account-manager/index');
const { recordAction }   = require('../src/account-manager/rate-limiter');
const { generateTOTP }   = require('../src/playwright-engine/platforms/instagram');

const db = getDb();
runMigrations(db);

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (err) { console.log(`  ✗  ${name}: ${err.message}`); failed++; }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function forceStatus(accountId, status) {
  db.prepare(`UPDATE accounts SET status=?, updated_at=? WHERE id=?`)
    .run(status, new Date().toISOString(), accountId);
}

function forceWarmupPhase(accountId, platform, day, phase, likes, follows, comments) {
  db.prepare(`
    UPDATE warmup_schedules SET current_day=?, current_phase=?,
      max_likes_day=?, max_follows_day=?, max_comments_day=?, completed=0
    WHERE account_id=? AND platform=?
  `).run(day, phase, likes, follows, comments, accountId, platform);
}

function insertActionBlock(accountId, platform, hoursAgo = 0) {
  const ts = new Date(Date.now() - hoursAgo * 3600000).toISOString();
  db.prepare(`INSERT INTO health_logs (account_id, platform, event_type, message, created_at) VALUES (?,?,?,?,?)`)
    .run(accountId, platform, 'action_block', 'test block', ts);
}

function forceDayCount(accountId, platform, actionType, count) {
  const now = new Date().toISOString();
  const nextHour = new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString();
  const midnight = new Date(new Date().setHours(24, 0, 0, 0)).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO rate_limits
      (account_id, platform, action_type, hour_count, day_count, hour_reset_at, day_reset_at, last_action_at)
    VALUES (?,?,?,0,?,?,?,?)
  `).run(accountId, platform, actionType, count, nextHour, midnight, now);
}

// ----------------------------------------------------------------
// Setup — shared test account
// ----------------------------------------------------------------

let accId;
console.log('\n[canAct — setup]');

test('create test account', () => {
  accId = am.addAccount({ username: 'canact_test', password: 'pw', platform: 'instagram' });
  assert(accId > 0);
});

// ----------------------------------------------------------------
// canAct: account status checks
// ----------------------------------------------------------------
console.log('\n[canAct — account status]');

test('account_not_found for invalid ID', () => {
  const r = am.canAct(999999, 'instagram', 'like');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'account_not_found');
});

test('account_disabled blocks all actions', () => {
  forceStatus(accId, 'disabled');
  const r = am.canAct(accId, 'instagram', 'follow');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'account_disabled');
  forceStatus(accId, 'warming');
});

test('account_flagged blocks all actions', () => {
  forceStatus(accId, 'flagged');
  const r = am.canAct(accId, 'instagram', 'like');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'account_flagged');
  forceStatus(accId, 'warming');
});

// ----------------------------------------------------------------
// canAct: action_block cooldown (2 hours)
// ----------------------------------------------------------------
console.log('\n[canAct — action_block cooldown]');

test('action_block within 2h → action_block_cooldown', () => {
  forceStatus(accId, 'active');
  db.prepare(`UPDATE warmup_schedules SET completed=1 WHERE account_id=?`).run(accId);
  insertActionBlock(accId, 'instagram', 1); // 1 hour ago
  const r = am.canAct(accId, 'instagram', 'like');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'action_block_cooldown');
});

test('action_block older than 2h → allowed (no cooldown)', () => {
  // Clear recent logs and insert old one
  db.prepare(`DELETE FROM health_logs WHERE account_id=? AND event_type='action_block'`).run(accId);
  insertActionBlock(accId, 'instagram', 3); // 3 hours ago — outside window
  const r = am.canAct(accId, 'instagram', 'like');
  assert(r.allowed, `Expected allowed, got: ${r.reason}`);
  // Clean up
  db.prepare(`DELETE FROM health_logs WHERE account_id=? AND event_type='action_block'`).run(accId);
});

// ----------------------------------------------------------------
// canAct: warmup phase caps
// ----------------------------------------------------------------
console.log('\n[canAct — warmup phases]');

test('login_only phase blocks follow (cap=0)', () => {
  forceStatus(accId, 'warming');
  db.prepare(`UPDATE warmup_schedules SET completed=0 WHERE account_id=?`).run(accId);
  forceWarmupPhase(accId, 'instagram', 1, 'login_only', 0, 0, 0);
  const r = am.canAct(accId, 'instagram', 'follow');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'warmup_phase_restricts_action');
  assert.strictEqual(r.phase, 'login_only');
});

test('login_only phase blocks like (cap=0)', () => {
  const r = am.canAct(accId, 'instagram', 'like');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'warmup_phase_restricts_action');
});

test('light phase allows like when under cap', () => {
  forceWarmupPhase(accId, 'instagram', 5, 'light', 15, 10, 0);
  forceDayCount(accId, 'instagram', 'like', 0);
  const r = am.canAct(accId, 'instagram', 'like');
  assert(r.allowed, `Expected allowed, got: ${r.reason}`);
});

test('light phase warmup_daily_cap when at like limit (15)', () => {
  forceDayCount(accId, 'instagram', 'like', 15); // at cap
  const r = am.canAct(accId, 'instagram', 'like');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'warmup_daily_cap');
  assert.strictEqual(r.cap, 15);
  assert.strictEqual(r.count, 15);
});

test('light phase blocks comment (cap=0)', () => {
  const r = am.canAct(accId, 'instagram', 'comment');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'warmup_phase_restricts_action');
});

test('medium phase allows comment when under cap (5)', () => {
  forceWarmupPhase(accId, 'instagram', 10, 'medium', 50, 50, 5);
  forceDayCount(accId, 'instagram', 'comment', 3);
  const r = am.canAct(accId, 'instagram', 'comment');
  assert(r.allowed, `Expected allowed, got: ${r.reason}`);
});

// ----------------------------------------------------------------
// canAct: rate limits (active account, warmup completed)
// ----------------------------------------------------------------
console.log('\n[canAct — rate limits]');

test('active account with quota available → allowed with counts', () => {
  forceStatus(accId, 'active');
  db.prepare(`UPDATE warmup_schedules SET completed=1 WHERE account_id=?`).run(accId);
  forceDayCount(accId, 'instagram', 'follow', 10);
  const r = am.canAct(accId, 'instagram', 'follow');
  assert(r.allowed, `Expected allowed, got: ${r.reason}`);
  assert(typeof r.hourCount === 'number');
  assert(typeof r.dayCount === 'number');
});

test('day_limit blocks when day_count >= 150 (follow)', () => {
  forceDayCount(accId, 'instagram', 'follow', 150); // at day limit
  const r = am.canAct(accId, 'instagram', 'follow');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'day_limit');
  assert.strictEqual(r.count, 150);
  assert.strictEqual(r.limit, 150);
});

test('hour_limit blocks when hour_count >= 20 (follow)', () => {
  // Reset day count but force hour count via recordAction mock
  forceDayCount(accId, 'instagram', 'follow', 5);
  db.prepare(`UPDATE rate_limits SET hour_count=20 WHERE account_id=? AND platform=? AND action_type=?`)
    .run(accId, 'instagram', 'follow');
  const r = am.canAct(accId, 'instagram', 'follow');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'hour_limit');
});

test('story_view has no hour limit (null)', () => {
  forceDayCount(accId, 'instagram', 'story_view', 0);
  db.prepare(`UPDATE rate_limits SET hour_count=100 WHERE account_id=? AND platform=? AND action_type=?`)
    .run(accId, 'instagram', 'story_view').catch?.(() => {});
  // Insert or update story_view with very high hour count — should still allow (no hour limit)
  db.prepare(`
    INSERT OR REPLACE INTO rate_limits
      (account_id, platform, action_type, hour_count, day_count, hour_reset_at, day_reset_at, last_action_at)
    VALUES (?,?,?,100,0,datetime('now','+1 hour'),datetime('now','+1 day'),datetime('now'))
  `).run(accId, 'instagram', 'story_view');
  const r = am.canAct(accId, 'instagram', 'story_view');
  assert(r.allowed, `story_view should have no hour limit, got: ${r.reason}`);
});

// ----------------------------------------------------------------
// generateTOTP
// ----------------------------------------------------------------
console.log('\n[generateTOTP — RFC 6238]');

test('returns a 6-character numeric string', () => {
  const otp = generateTOTP('JBSWY3DPEHPK3PXP');
  assert.strictEqual(typeof otp, 'string');
  assert.strictEqual(otp.length, 6);
  assert(/^\d{6}$/.test(otp), `Expected 6 digits, got: ${otp}`);
});

test('consistent within same 30-second window', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const otp1 = generateTOTP(secret);
  const otp2 = generateTOTP(secret);
  assert.strictEqual(otp1, otp2, 'OTP should be stable within same time step');
});

test('RFC 6238 Appendix B test vector — TOTP-SHA1 at T=59s', () => {
  // RFC 6238 secret: "12345678901234567890" as ASCII bytes
  // Base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  // T_step = floor(59/30) = 1
  // RFC 6238 8-digit TOTP = 94287082 → 6-digit = 94287082 % 1000000 = 287082
  const savedNow = Date.now;
  Date.now = () => 59 * 1000; // freeze to T=59s
  try {
    const otp = generateTOTP('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.strictEqual(otp, '287082', `RFC 6238 vector failed: expected 287082, got ${otp}`);
  } finally {
    Date.now = savedNow;
  }
});

test('RFC 6238 Appendix B test vector — T=1111111109s (T_step=37037036)', () => {
  // RFC 6238 8-digit TOTP = 07081804 → 6-digit = 07081804 % 1000000 = 081804
  const savedNow = Date.now;
  Date.now = () => 1111111109 * 1000;
  try {
    const otp = generateTOTP('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.strictEqual(otp, '081804', `RFC 6238 vector failed: expected 081804, got ${otp}`);
  } finally {
    Date.now = savedNow;
  }
});

test('handles lowercase and spaces in secret', () => {
  const secret = 'jbswy3dp ehpk3pxp'; // lowercase + space
  const otpLower = generateTOTP(secret);
  const otpUpper = generateTOTP('JBSWY3DPEHPK3PXP');
  assert.strictEqual(otpLower, otpUpper, 'Lowercase/spaced secret should produce same OTP');
});

test('different time steps produce different OTPs', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const savedNow = Date.now;
  Date.now = () => 0;    // T_step = 0
  const otp0 = generateTOTP(secret);
  Date.now = () => 30000; // T_step = 1
  const otp1 = generateTOTP(secret);
  Date.now = savedNow;
  assert.notStrictEqual(otp0, otp1, 'Different time steps should (almost always) produce different OTPs');
});

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
closeDb();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);
