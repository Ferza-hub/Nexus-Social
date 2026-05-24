'use strict';

// post_queue CRUD + campaign_logs helpers

const { getDb } = require('../../database/db');
const { makeLogger } = require('../../utils/logger');

const log = makeLogger('Queue');

// ----------------------------------------------------------------
// Post queue
// ----------------------------------------------------------------

function getPendingPosts() {
  return getDb().prepare(`
    SELECT pq.*, a.platform as acct_platform
    FROM post_queue pq
    JOIN accounts a ON a.id = pq.account_id
    WHERE pq.status = 'pending'
      AND pq.scheduled_at <= datetime('now')
    ORDER BY pq.scheduled_at ASC
    LIMIT 20
  `).all();
}

function markPostRunning(id) {
  getDb().prepare(`UPDATE post_queue SET status='running', updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), id);
}

function markPostDone(id, resultJson) {
  getDb().prepare(`UPDATE post_queue SET status='done', result_json=?, updated_at=? WHERE id=?`)
    .run(JSON.stringify(resultJson), new Date().toISOString(), id);
}

function markPostFailed(id, error) {
  const db = getDb();
  const row = db.prepare(`SELECT retry_count, max_retries FROM post_queue WHERE id=?`).get(id);
  if (!row) return;

  const nextRetry = row.retry_count + 1;
  const status    = nextRetry >= row.max_retries ? 'failed' : 'pending';

  db.prepare(`
    UPDATE post_queue
    SET status=?, retry_count=?, updated_at=?,
        scheduled_at = CASE WHEN ? = 'pending' THEN datetime('now', '+5 minutes') ELSE scheduled_at END
    WHERE id=?
  `).run(status, nextRetry, new Date().toISOString(), status, id);

  if (status === 'failed') {
    log.warn('Post permanently failed', { id, error, retries: nextRetry });
  }
}

function cancelPost(id) {
  getDb().prepare(`UPDATE post_queue SET status='cancelled', updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), id);
}

function listQueue(accountId = null, status = null, limit = 50) {
  let q = `SELECT * FROM post_queue WHERE 1=1`;
  const p = [];
  if (accountId) { q += ` AND account_id=?`; p.push(accountId); }
  if (status)    { q += ` AND status=?`;     p.push(status); }
  q += ` ORDER BY scheduled_at ASC LIMIT ?`;
  p.push(limit);
  return getDb().prepare(q).all(...p);
}

// ----------------------------------------------------------------
// Campaign management
// ----------------------------------------------------------------

function listCampaigns(status = null) {
  let q = `
    SELECT c.*, a.username, a.platform as acct_platform
    FROM campaigns c
    JOIN accounts a ON a.id = c.account_id
    WHERE 1=1
  `;
  const p = [];
  if (status) { q += ` AND c.status=?`; p.push(status); }
  q += ` ORDER BY c.created_at DESC`;
  return getDb().prepare(q).all(...p);
}

function getCampaign(id) {
  return getDb().prepare(`
    SELECT c.*, a.username, a.platform as acct_platform
    FROM campaigns c JOIN accounts a ON a.id = c.account_id
    WHERE c.id=?
  `).get(id);
}

function createCampaign({ name, accountId, platform, type, config, targetCount }) {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO campaigns (name, account_id, platform, type, status, config_json, target_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `).run(name, accountId, platform, type, JSON.stringify(config ?? {}), targetCount ?? null, now, now);
  return result.lastInsertRowid;
}

function setCampaignStatus(id, status) {
  const db = getDb();
  const now = new Date().toISOString();
  const extra = status === 'running' ? `, started_at=COALESCE(started_at,?)` : status === 'completed' || status === 'failed' ? `, completed_at=?` : '';
  db.prepare(`UPDATE campaigns SET status=?, updated_at=?${extra} WHERE id=?`)
    .run(status, now, ...(extra ? [now] : []), id);
}

function incrementCampaignCount(id) {
  getDb().prepare(`UPDATE campaigns SET completed_count=completed_count+1, updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), id);
}

// ----------------------------------------------------------------
// Campaign logs
// ----------------------------------------------------------------

function logCampaignAction(campaignId, accountId, action, status, message = null) {
  getDb().prepare(`
    INSERT INTO campaign_logs (campaign_id, account_id, action, status, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(campaignId, accountId, action, status, message);
}

function getCampaignLogs(campaignId, limit = 100) {
  return getDb().prepare(`
    SELECT * FROM campaign_logs WHERE campaign_id=? ORDER BY created_at DESC LIMIT ?
  `).all(campaignId, limit);
}

module.exports = {
  // Post queue
  getPendingPosts, markPostRunning, markPostDone, markPostFailed, cancelPost, listQueue,
  // Campaigns
  listCampaigns, getCampaign, createCampaign, setCampaignStatus, incrementCampaignCount,
  // Campaign logs
  logCampaignAction, getCampaignLogs,
};
