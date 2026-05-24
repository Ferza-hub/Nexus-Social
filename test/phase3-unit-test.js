'use strict';

require('dotenv').config();
const assert = require('assert');

const { getDb, closeDb } = require('../src/database/db');
const { runMigrations } = require('../src/database/schema');
const q = require('../src/api-engine/scheduler/queue');
const { schedulePost } = require('../src/api-engine/actions/post');
const { saveToken, loadToken, deleteToken } = require('../src/api-engine/oauth/index');
const am = require('../src/account-manager/index');

const db = getDb();
runMigrations(db);

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (err) { console.log(`  ✗  ${name}: ${err.message}`); failed++; }
}

// ----------------------------------------------------------------
// Schema additions
// ----------------------------------------------------------------
console.log('\n[New tables]');

test('oauth_tokens table exists', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_tokens'`).get();
  assert(row, 'oauth_tokens table missing');
});

test('campaigns table exists', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'`).get();
  assert(row, 'campaigns table missing');
});

test('post_queue table exists', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='post_queue'`).get();
  assert(row, 'post_queue table missing');
});

test('campaign_logs table exists', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_logs'`).get();
  assert(row, 'campaign_logs table missing');
});

// ----------------------------------------------------------------
// OAuth token store
// ----------------------------------------------------------------
console.log('\n[OAuth token store]');

let accId;

test('create test account', () => {
  accId = am.addAccount({ username: 'phase3_test', password: 'pw', platform: 'instagram' });
  assert(accId > 0);
});

test('save token', () => {
  saveToken(accId, 'instagram', {
    accessToken:  'tok_abc123',
    refreshToken: 'ref_xyz',
    expiresAt:    new Date(Date.now() + 3600000),
    scope:        'instagram_basic',
  });
});

test('load token returns correct data', () => {
  const tok = loadToken(accId, 'instagram');
  assert(tok, 'token not found');
  assert.strictEqual(tok.access_token, 'tok_abc123');
  assert.strictEqual(tok.isExpired, false);
});

test('delete token', () => {
  deleteToken(accId, 'instagram');
  const tok = loadToken(accId, 'instagram');
  assert.strictEqual(tok, null);
});

test('expired token flagged correctly', () => {
  saveToken(accId, 'instagram', {
    accessToken: 'old_tok',
    expiresAt:   new Date(Date.now() - 1000), // already expired
  });
  const tok = loadToken(accId, 'instagram');
  assert(tok.isExpired, 'Expected isExpired=true');
  deleteToken(accId, 'instagram');
});

// ----------------------------------------------------------------
// Campaign CRUD
// ----------------------------------------------------------------
console.log('\n[Campaign management]');

let campaignId;

test('create campaign', () => {
  campaignId = q.createCampaign({
    name: 'Test Growth',
    accountId: accId,
    platform: 'instagram',
    type: 'growth',
    config: { action: 'follow', target: { type: 'hashtag', value: 'photography' }, dailyGoal: 20 },
    targetCount: 100,
  });
  assert(campaignId > 0);
});

test('getCampaign returns correct data', () => {
  const c = q.getCampaign(campaignId);
  assert(c, 'campaign not found');
  assert.strictEqual(c.type, 'growth');
  assert.strictEqual(c.status, 'draft');
});

test('setCampaignStatus → running', () => {
  q.setCampaignStatus(campaignId, 'running');
  const c = q.getCampaign(campaignId);
  assert.strictEqual(c.status, 'running');
  assert(c.started_at, 'started_at should be set');
});

test('incrementCampaignCount', () => {
  q.incrementCampaignCount(campaignId);
  q.incrementCampaignCount(campaignId);
  const c = q.getCampaign(campaignId);
  assert.strictEqual(c.completed_count, 2);
});

test('logCampaignAction and getCampaignLogs', () => {
  q.logCampaignAction(campaignId, accId, 'follow', 'success', 'followed @user1');
  q.logCampaignAction(campaignId, accId, 'follow', 'blocked', 'rate limit');
  const logs = q.getCampaignLogs(campaignId);
  assert(logs.length >= 2);
});

test('listCampaigns returns running campaign', () => {
  const list = q.listCampaigns('running');
  assert(list.some(c => c.id === campaignId));
});

test('setCampaignStatus → completed', () => {
  q.setCampaignStatus(campaignId, 'completed');
  const c = q.getCampaign(campaignId);
  assert.strictEqual(c.status, 'completed');
  assert(c.completed_at);
});

// ----------------------------------------------------------------
// Post queue
// ----------------------------------------------------------------
console.log('\n[Post queue]');

let postQueueId;

test('schedulePost adds to queue', () => {
  const future = new Date(Date.now() + 60000).toISOString();
  postQueueId = schedulePost(accId, 'instagram',
    { type: 'photo', caption: 'Hello world', mediaUrls: ['https://example.com/img.jpg'] },
    future, null);
  assert(postQueueId > 0);
});

test('listQueue returns scheduled post', () => {
  const list = q.listQueue(accId, 'pending');
  assert(list.some(i => i.id === postQueueId));
});

test('markPostRunning changes status', () => {
  q.markPostRunning(postQueueId);
  const list = q.listQueue(accId, 'running');
  assert(list.some(i => i.id === postQueueId));
});

test('markPostDone sets status and result', () => {
  q.markPostDone(postQueueId, { postId: 'IG_123' });
  const list = q.listQueue(accId, 'done');
  assert(list.some(i => i.id === postQueueId));
});

test('cancelPost sets status to cancelled', () => {
  const id2 = schedulePost(accId, 'instagram',
    { type: 'photo', caption: 'Cancel me' },
    new Date(Date.now() + 3600000).toISOString());
  q.cancelPost(id2);
  const list = q.listQueue(accId, 'cancelled');
  assert(list.some(i => i.id === id2));
});

// ----------------------------------------------------------------
// Panel modules load
// ----------------------------------------------------------------
console.log('\n[Panel modules]');

test('panel server module loads', () => {
  const server = require('../src/panel/server');
  assert(typeof server.startPanel === 'function');
});

test('all panel routes load', () => {
  const routes = ['accounts','campaigns','proxies','schedule','analytics','logs','oauth'];
  for (const r of routes) {
    const mod = require(`../src/panel/routes/${r}`);
    assert(mod && mod.stack, `Route ${r} not an Express router`);
  }
});

test('api engine index exports all public methods', () => {
  const api = require('../src/api-engine/index');
  const expected = ['oauth','publishPost','schedulePost','deletePost','getAnalytics','getFollowers','replyComment','startRunner','queue'];
  for (const m of expected) {
    assert(api[m], `Missing export: ${m}`);
  }
});

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
closeDb();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);
