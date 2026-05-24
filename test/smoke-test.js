'use strict';

require('dotenv').config();
const assert = require('assert');

const { getDb, closeDb } = require('../src/database/db');
const { runMigrations } = require('../src/database/schema');
const am = require('../src/account-manager/index');
const { canPerform, recordAction, getUsage } = require('../src/account-manager/rate-limiter');
const { loadSession, saveSession, getExpiringAccounts } = require('../src/account-manager/session-manager');
const { getWarmupLimits, phaseForDay } = require('../src/account-manager/warmup-scheduler');
const { logEvent, getAccountHealth, getAlerts } = require('../src/account-manager/health-monitor');

const db = getDb();
runMigrations(db);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗  ${name}: ${err.message}`);
    failed++;
  }
}

// ----------------------------------------------------------------
// 1. Schema
// ----------------------------------------------------------------
console.log('\n[Schema]');
test('all tables exist', () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  for (const t of ['accounts','proxies','sessions','rate_limits','health_logs','warmup_schedules']) {
    assert(tables.includes(t), `Missing table: ${t}`);
  }
});

// ----------------------------------------------------------------
// 2. Account + Proxy
// ----------------------------------------------------------------
console.log('\n[AccountManager]');

let accountId, proxyId;

test('add proxy', () => {
  proxyId = am.addProxy({ host: '1.2.3.4', port: 8080, username: 'u', password: 'p' });
  assert(proxyId > 0);
});

test('add account (instagram)', () => {
  accountId = am.addAccount({
    username: 'test_user_1',
    password: 'secret123',
    email: 'test@example.com',
    platform: 'instagram',
  });
  assert(accountId > 0);
});

test('account status = warming after init', () => {
  const acc = am.getAccount(accountId);
  assert.strictEqual(acc.status, 'warming');
});

test('assign proxy (dedicated)', () => {
  am.assignProxy(accountId, proxyId);
  const proxy = am.getProxyForAccount(accountId);
  assert.strictEqual(proxy.host, '1.2.3.4');
});

test('cannot assign same proxy to another account', () => {
  const id2 = am.addAccount({ username: 'test_user_2', password: 'x', platform: 'instagram' });
  assert.throws(() => am.assignProxy(id2, proxyId), /already assigned/);
});

test('list accounts returns results', () => {
  const list = am.listAccounts('instagram');
  assert(list.length >= 1);
});

// ----------------------------------------------------------------
// 3. Warmup phases
// ----------------------------------------------------------------
console.log('\n[WarmupScheduler]');

test('phase day 1 = login_only', () => {
  assert.strictEqual(phaseForDay(1).name, 'login_only');
});
test('phase day 4 = light', () => {
  assert.strictEqual(phaseForDay(4).name, 'light');
});
test('phase day 8 = medium', () => {
  assert.strictEqual(phaseForDay(8).name, 'medium');
});
test('phase day 15 = full', () => {
  assert.strictEqual(phaseForDay(15).name, 'full');
});

test('warmup limits exist for warming account', () => {
  const limits = getWarmupLimits(accountId, 'instagram');
  assert(limits !== null);
  assert.strictEqual(limits.phase, 'login_only');
  assert.strictEqual(limits.maxLikes, 0);
  assert.strictEqual(limits.maxFollows, 0);
});

// ----------------------------------------------------------------
// 4. Rate Limiter
// ----------------------------------------------------------------
console.log('\n[RateLimiter]');

test('canPerform allows first action', () => {
  const result = canPerform(accountId, 'instagram', 'like');
  assert(result.allowed, `Expected allowed, got: ${result.reason}`);
});

test('recordAction increments counters', () => {
  recordAction(accountId, 'instagram', 'like');
  const usage = getUsage(accountId, 'instagram');
  assert.strictEqual(usage.like.hour.count, 1);
  assert.strictEqual(usage.like.day.count, 1);
});

test('getUsage returns all tracked actions', () => {
  const usage = getUsage(accountId, 'instagram');
  assert(typeof usage === 'object');
});

// ----------------------------------------------------------------
// 5. canAct gate (warmup-aware)
// ----------------------------------------------------------------
console.log('\n[canAct gate]');

test('warming account: like blocked by warmup phase login_only', () => {
  // Day 1 warmup → maxLikes = 0
  const result = am.canAct(accountId, 'instagram', 'like');
  assert(!result.allowed, `Expected blocked, got allowed`);
  assert.match(result.reason, /warmup/);
});

test('active account: like allowed', () => {
  db.prepare(`UPDATE accounts SET status = 'active' WHERE id = ?`).run(accountId);
  // Override warmup schedule to completed
  db.prepare(`UPDATE warmup_schedules SET completed = 1 WHERE account_id = ?`).run(accountId);
  const result = am.canAct(accountId, 'instagram', 'like');
  assert(result.allowed, `Expected allowed, got: ${result.reason}`);
});

test('flagged account: all actions blocked', () => {
  db.prepare(`UPDATE accounts SET status = 'flagged' WHERE id = ?`).run(accountId);
  const result = am.canAct(accountId, 'instagram', 'like');
  assert(!result.allowed);
  assert.strictEqual(result.reason, 'account_flagged');
  db.prepare(`UPDATE accounts SET status = 'active' WHERE id = ?`).run(accountId);
});

// ----------------------------------------------------------------
// 6. Session Manager
// ----------------------------------------------------------------
console.log('\n[SessionManager]');

test('save and load session', () => {
  const state = { cookies: [{ name: 'sessionid', value: 'abc123', domain: '.instagram.com' }], origins: [] };
  saveSession(accountId, 'instagram', state);
  const loaded = loadSession(accountId, 'instagram');
  assert.deepStrictEqual(loaded.cookies[0].value, 'abc123');
});

test('invalidate session returns null on load', () => {
  const { invalidateSession } = require('../src/account-manager/session-manager');
  invalidateSession(accountId, 'instagram');
  db.prepare(`UPDATE accounts SET status = 'active' WHERE id = ?`).run(accountId);
  const loaded = loadSession(accountId, 'instagram');
  assert.strictEqual(loaded, null);
});

test('getExpiringAccounts returns list', () => {
  const list = getExpiringAccounts(40);
  assert(Array.isArray(list));
});

// ----------------------------------------------------------------
// 7. Health Monitor
// ----------------------------------------------------------------
console.log('\n[HealthMonitor]');

test('logEvent ok records without changing status', () => {
  db.prepare(`UPDATE accounts SET status = 'active' WHERE id = ?`).run(accountId);
  logEvent(accountId, 'instagram', 'ok', 'test heartbeat');
  const acc = am.getAccount(accountId);
  assert.strictEqual(acc.status, 'active');
});

test('logEvent action_block reduces quota', () => {
  db.prepare(`UPDATE accounts SET status = 'active' WHERE id = ?`).run(accountId);
  logEvent(accountId, 'instagram', 'action_block', 'follow action blocked');
  const health = getAccountHealth(accountId, 'instagram', 5);
  const event = health.find(h => h.event_type === 'action_block');
  assert(event, 'action_block event not found in logs');
});

test('logEvent disabled flags account as disabled', () => {
  logEvent(accountId, 'instagram', 'disabled', 'Account permanently disabled');
  const acc = am.getAccount(accountId);
  assert.strictEqual(acc.status, 'disabled');
});

test('getAlerts returns recent events', () => {
  const alerts = getAlerts();
  assert(Array.isArray(alerts));
  assert(alerts.length >= 1);
});

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
closeDb();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);
