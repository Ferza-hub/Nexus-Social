'use strict';

// Account Manager — public surface
// Import from here, not from individual modules

const sessionManager  = require('./session-manager');
const rateLimiter     = require('./rate-limiter');
const warmupScheduler = require('./warmup-scheduler');
const healthMonitor   = require('./health-monitor');
const { getDb }       = require('../database/db');
const { makeLogger }  = require('../utils/logger');

const log = makeLogger('AccountManager');

// ----------------------------------------------------------------
// Account CRUD
// ----------------------------------------------------------------

function addAccount({ username, password, email, phone, platform, proxyId, twoFaSecret, notes, accountRole = 'managed' }) {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO accounts (username, password, email, phone, platform, proxy_id, two_fa_secret, notes, account_role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, password, email ?? null, phone ?? null, platform, proxyId ?? null, twoFaSecret ?? null, notes ?? null, accountRole, now, now);

  const accountId = result.lastInsertRowid;
  if (accountRole !== 'traffic') {
    warmupScheduler.initWarmup(accountId, platform);
  }

  log.info('Account added', { accountId, username, platform });
  return accountId;
}

function getAccount(accountId) {
  return getDb().prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
}

function listAccounts(platform = null, status = null) {
  const db = getDb();
  let query = `SELECT * FROM accounts WHERE 1=1`;
  const params = [];

  if (platform) { query += ` AND platform = ?`; params.push(platform); }
  if (status)   { query += ` AND status = ?`;   params.push(status); }

  query += ` ORDER BY created_at DESC`;
  return db.prepare(query).all(...params);
}

// ----------------------------------------------------------------
// Proxy management
// ----------------------------------------------------------------

function addProxy({ host, port, username, password, protocol = 'http', proxyType = 'dedicated' }) {
  const db = getDb();
  const type = proxyType === 'residential' ? 'residential' : 'dedicated';
  const result = db.prepare(`
    INSERT INTO proxies (host, port, username, password, protocol, proxy_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(host, port, username ?? null, password ?? null, protocol, type);

  log.info('Proxy added', { id: result.lastInsertRowid, host, port, type });
  return result.lastInsertRowid;
}

function assignProxy(accountId, proxyId) {
  const db = getDb();

  // Enforce 1-proxy-1-account
  const existing = db.prepare(`SELECT assigned_account_id FROM proxies WHERE id = ?`).get(proxyId);
  if (existing?.assigned_account_id && existing.assigned_account_id !== accountId) {
    throw new Error(`Proxy ${proxyId} is already assigned to account ${existing.assigned_account_id}`);
  }

  db.prepare(`UPDATE proxies SET assigned_account_id = ? WHERE id = ?`).run(accountId, proxyId);
  db.prepare(`UPDATE accounts SET proxy_id = ?, updated_at = ? WHERE id = ?`)
    .run(proxyId, new Date().toISOString(), accountId);

  log.info('Proxy assigned', { accountId, proxyId });
}

function getProxyForAccount(accountId) {
  return getDb().prepare(`
    SELECT p.* FROM proxies p
    JOIN accounts a ON a.proxy_id = p.id
    WHERE a.id = ? AND p.status = 'active'
  `).get(accountId);
}

// ----------------------------------------------------------------
// Pre-action gate: warmup limits + rate limits combined
// ----------------------------------------------------------------

function canAct(accountId, platform, actionType) {
  const account = getAccount(accountId);
  if (!account) return { allowed: false, reason: 'account_not_found' };
  if (account.status === 'disabled') return { allowed: false, reason: 'account_disabled' };
  if (account.status === 'flagged')  return { allowed: false, reason: 'account_flagged' };

  // 2-hour cooldown after action_block — no actions until window passes
  // datetime() wrapper normalises both 'YYYY-MM-DD HH:MM:SS' and ISO 'T' formats
  const recentBlock = getDb().prepare(`
    SELECT id FROM health_logs
    WHERE account_id = ? AND platform = ? AND event_type = 'action_block'
    AND datetime(created_at) >= datetime('now', '-2 hours')
    LIMIT 1
  `).get(accountId, platform);
  if (recentBlock) return { allowed: false, reason: 'action_block_cooldown' };

  // Warmup caps override normal limits for warming accounts
  if (account.status === 'warming') {
    const warmup = warmupScheduler.getWarmupLimits(accountId, platform);
    if (warmup) {
      const capMap = { like: warmup.maxLikes, follow: warmup.maxFollows, unfollow: warmup.maxFollows, comment: warmup.maxComments };
      const cap = capMap[actionType];

      if (cap === 0) return { allowed: false, reason: 'warmup_phase_restricts_action', phase: warmup.phase };

      if (cap !== undefined && cap !== null) {
        const { getDb } = require('../database/db');
        const db = getDb();
        const row = db.prepare(`
          SELECT day_count FROM rate_limits
          WHERE account_id = ? AND platform = ? AND action_type = ?
        `).get(accountId, platform, actionType);

        if (row && row.day_count >= cap) {
          return { allowed: false, reason: 'warmup_daily_cap', cap, count: row.day_count };
        }
      }
    }
  }

  return rateLimiter.canPerform(accountId, platform, actionType);
}

module.exports = {
  // Account
  addAccount,
  getAccount,
  listAccounts,
  // Proxy
  addProxy,
  assignProxy,
  getProxyForAccount,
  // Gate
  canAct,
  // Re-exports
  session:  sessionManager,
  limits:   rateLimiter,
  warmup:   warmupScheduler,
  health:   healthMonitor,
};
