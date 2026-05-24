'use strict';

require('dotenv').config();
const cron = require('node-cron');
const { getDb } = require('../database/db');
const { makeLogger } = require('../utils/logger');
const { invalidateSession } = require('./session-manager');
const { reduceQuota, LIMITS } = require('./rate-limiter');
const { restartWarmup } = require('./warmup-scheduler');

const log = makeLogger('HealthMonitor');

// ----------------------------------------------------------------
// Event types and their automatic responses
// ----------------------------------------------------------------

const EVENT_HANDLERS = {
  challenge: (db, account) => {
    log.warn('Challenge/captcha detected — pausing account', { id: account.id, username: account.username });
    setStatus(db, account.id, 'flagged');
    invalidateSession(account.id, account.platform);
  },

  captcha: (db, account) => {
    log.warn('Captcha detected — pausing account', { id: account.id, username: account.username });
    setStatus(db, account.id, 'flagged');
    invalidateSession(account.id, account.platform);
  },

  action_block: (db, account) => {
    log.warn('Action block detected — reducing quota 50%', { id: account.id, username: account.username });
    for (const actionType of Object.keys(LIMITS)) {
      reduceQuota(account.id, account.platform, actionType, 50);
    }
  },

  unusual_activity: (db, account) => {
    log.warn('Unusual activity warning — pausing 24h', { id: account.id, username: account.username });
    setStatus(db, account.id, 'flagged');
  },

  disabled: (db, account) => {
    log.error('Account disabled!', { id: account.id, username: account.username, platform: account.platform });
    setStatus(db, account.id, 'disabled');
    invalidateSession(account.id, account.platform);
  },

  login_required: (db, account) => {
    log.warn('Login required', { id: account.id, username: account.username });
    invalidateSession(account.id, account.platform);
  },
};

function setStatus(db, accountId, status) {
  db.prepare(`UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), accountId);
}

// ----------------------------------------------------------------
// Log a health event and trigger the automatic response
// ----------------------------------------------------------------

function logEvent(accountId, platform, eventType, message = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO health_logs (account_id, platform, event_type, message)
    VALUES (?, ?, ?, ?)
  `).run(accountId, platform, eventType, message);

  if (eventType === 'ok') return;

  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  if (!account) return;

  const handler = EVENT_HANDLERS[eventType];
  if (handler) {
    handler(db, account);
  } else {
    log.warn(`Unhandled event type: ${eventType}`, { accountId, platform });
  }
}

// ----------------------------------------------------------------
// Recovery: attempt to bring flagged accounts back to active
// Called by cron — checks flagged_since duration
// ----------------------------------------------------------------

function recoverFlaggedAccounts() {
  const db = getDb();
  const flaggedAccounts = db.prepare(`
    SELECT a.id, a.username, a.platform,
           MAX(hl.created_at) as last_event,
           hl.event_type
    FROM accounts a
    JOIN health_logs hl ON hl.account_id = a.id
    WHERE a.status = 'flagged'
      AND hl.event_type IN ('unusual_activity','action_block','challenge','captcha')
    GROUP BY a.id
  `).all();

  const now = Date.now();
  const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h pause minimum

  for (const account of flaggedAccounts) {
    if (!account.last_event) continue;
    const flaggedSince = new Date(account.last_event).getTime();

    if (now - flaggedSince >= RECOVERY_WINDOW_MS) {
      log.info('Attempting account recovery', { id: account.id, username: account.username });
      setStatus(db, account.id, 'recovery');
      restartWarmup(account.id, account.platform);

      db.prepare(`INSERT INTO health_logs (account_id, platform, event_type, message) VALUES (?, ?, 'ok', ?)`)
        .run(account.id, account.platform, 'Automatic recovery initiated after 24h pause');
    }
  }
}

// ----------------------------------------------------------------
// Main health check cycle — called every 30 min by cron
// Examines recent activity for warning signals
// ----------------------------------------------------------------

function runHealthCheck() {
  const db = getDb();
  log.info('Running health check cycle...');

  const activeAccounts = db.prepare(`
    SELECT id, username, platform FROM accounts
    WHERE status IN ('active','warming')
  `).all();

  log.info(`Checking ${activeAccounts.length} active/warming account(s)`);

  for (const account of activeAccounts) {
    // Check for recent negative events in the last check window
    const recentEvent = db.prepare(`
      SELECT event_type, message, created_at FROM health_logs
      WHERE account_id = ? AND platform = ?
        AND event_type NOT IN ('ok')
        AND created_at >= datetime('now', '-30 minutes')
      ORDER BY created_at DESC LIMIT 1
    `).get(account.id, account.platform);

    if (recentEvent) {
      log.warn('Recent negative event found during health check', {
        id: account.id,
        username: account.username,
        event: recentEvent.event_type,
      });
      // Handler already ran when logEvent was called — just re-log for visibility
    } else {
      // Log ok heartbeat for active accounts
      db.prepare(`
        INSERT INTO health_logs (account_id, platform, event_type, message)
        VALUES (?, ?, 'ok', 'Health check passed')
      `).run(account.id, account.platform);
    }
  }

  recoverFlaggedAccounts();
  log.info('Health check cycle complete');
}

// ----------------------------------------------------------------
// Get last N health events for an account
// ----------------------------------------------------------------

function getAccountHealth(accountId, platform, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT event_type, message, created_at
    FROM health_logs
    WHERE account_id = ? AND platform = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(accountId, platform, limit);
}

// ----------------------------------------------------------------
// Get all accounts with concerning recent events
// ----------------------------------------------------------------

function getAlerts() {
  const db = getDb();
  return db.prepare(`
    SELECT a.id, a.username, a.platform, a.status,
           hl.event_type, hl.message, hl.created_at
    FROM health_logs hl
    JOIN accounts a ON a.id = hl.account_id
    WHERE hl.event_type NOT IN ('ok')
      AND hl.created_at >= datetime('now', '-24 hours')
    ORDER BY hl.created_at DESC
  `).all();
}

// ----------------------------------------------------------------
// Start the cron scheduler (every 30 minutes)
// ----------------------------------------------------------------

function startMonitor() {
  const cronExpr = process.env.HEALTH_CHECK_CRON || '*/30 * * * *';
  const warmupCron = process.env.WARMUP_CRON || '0 * * * *';

  log.info(`Health monitor starting — cron: ${cronExpr}`);

  cron.schedule(cronExpr, () => {
    try {
      runHealthCheck();
    } catch (err) {
      log.error('Health check failed', { err: err.message });
    }
  });

  // Daily warmup advancement at midnight
  cron.schedule('0 0 * * *', () => {
    try {
      const { runDailyAdvancement } = require('./warmup-scheduler');
      runDailyAdvancement();
    } catch (err) {
      log.error('Warmup advancement failed', { err: err.message });
    }
  });

  log.info('Monitors scheduled.');
}

// ----------------------------------------------------------------
// CLI: node health-monitor.js --once
// ----------------------------------------------------------------

if (require.main === module) {
  const runOnce = process.argv.includes('--once');
  if (runOnce) {
    runHealthCheck();
    process.exit(0);
  } else {
    startMonitor();
  }
}

module.exports = {
  logEvent,
  runHealthCheck,
  getAccountHealth,
  getAlerts,
  startMonitor,
};
