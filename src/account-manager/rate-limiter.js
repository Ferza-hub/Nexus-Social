'use strict';

const { getDb } = require('../database/db');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('RateLimiter');

// ----------------------------------------------------------------
// Hard limits per action type (from roadmap)
// ----------------------------------------------------------------

const LIMITS = {
  follow:      { hour: 20,  day: 150 },
  unfollow:    { hour: 20,  day: 150 },
  like:        { hour: 50,  day: 300 },
  comment:     { hour: 15,  day: 100 },
  story_view:  { hour: null, day: 500 },
  dm:          { hour: null, day: 50  },
  watch_reel:  { hour: null, day: 500 },
};

// ----------------------------------------------------------------
// Ensure a rate_limits row exists for this account/platform/action
// ----------------------------------------------------------------

function ensureRow(db, accountId, platform, actionType) {
  const now = new Date().toISOString();
  const nextHour = new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString();
  const midnight = new Date(new Date().setHours(24, 0, 0, 0)).toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO rate_limits
      (account_id, platform, action_type, hour_count, day_count, hour_reset_at, day_reset_at)
    VALUES (?, ?, ?, 0, 0, ?, ?)
  `).run(accountId, platform, actionType, nextHour, midnight);
}

// ----------------------------------------------------------------
// Reset counters if the reset window has passed
// ----------------------------------------------------------------

function resetIfNeeded(db, accountId, platform, actionType) {
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE rate_limits
    SET hour_count = 0, hour_reset_at = datetime(hour_reset_at, '+1 hour')
    WHERE account_id = ? AND platform = ? AND action_type = ?
      AND hour_reset_at IS NOT NULL AND hour_reset_at <= ?
  `).run(accountId, platform, actionType, now);

  db.prepare(`
    UPDATE rate_limits
    SET day_count = 0, day_reset_at = datetime(day_reset_at, '+1 day')
    WHERE account_id = ? AND platform = ? AND action_type = ?
      AND day_reset_at IS NOT NULL AND day_reset_at <= ?
  `).run(accountId, platform, actionType, now);
}

// ----------------------------------------------------------------
// Check if an action is allowed (does NOT increment)
// ----------------------------------------------------------------

function canPerform(accountId, platform, actionType) {
  const limits = LIMITS[actionType];
  if (!limits) throw new Error(`Unknown action type: ${actionType}`);

  const db = getDb();
  ensureRow(db, accountId, platform, actionType);
  resetIfNeeded(db, accountId, platform, actionType);

  const row = db.prepare(`
    SELECT hour_count, day_count FROM rate_limits
    WHERE account_id = ? AND platform = ? AND action_type = ?
  `).get(accountId, platform, actionType);

  if (limits.hour !== null && row.hour_count >= limits.hour) {
    log.debug('Hourly limit reached', { accountId, platform, actionType, count: row.hour_count, limit: limits.hour });
    return { allowed: false, reason: 'hour_limit', count: row.hour_count, limit: limits.hour };
  }

  if (limits.day !== null && row.day_count >= limits.day) {
    log.debug('Daily limit reached', { accountId, platform, actionType, count: row.day_count, limit: limits.day });
    return { allowed: false, reason: 'day_limit', count: row.day_count, limit: limits.day };
  }

  return { allowed: true, hourCount: row.hour_count, dayCount: row.day_count };
}

// ----------------------------------------------------------------
// Record an action (increments counters)
// ----------------------------------------------------------------

function recordAction(accountId, platform, actionType) {
  const db = getDb();
  ensureRow(db, accountId, platform, actionType);
  resetIfNeeded(db, accountId, platform, actionType);

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE rate_limits
    SET hour_count = hour_count + 1,
        day_count  = day_count  + 1,
        last_action_at = ?
    WHERE account_id = ? AND platform = ? AND action_type = ?
  `).run(now, accountId, platform, actionType);

  const row = db.prepare(`
    SELECT hour_count, day_count FROM rate_limits
    WHERE account_id = ? AND platform = ? AND action_type = ?
  `).get(accountId, platform, actionType);

  log.debug('Action recorded', { accountId, platform, actionType, hour: row.hour_count, day: row.day_count });
  return row;
}

// ----------------------------------------------------------------
// Reduce daily quota by percent (e.g. on action_block detection)
// ----------------------------------------------------------------

function reduceQuota(accountId, platform, actionType, percent = 50) {
  const limits = LIMITS[actionType];
  if (!limits) return;
  const db = getDb();

  // Force day_count halfway to limit so remaining quota is halved
  const newCount = Math.floor(limits.day * (percent / 100));
  db.prepare(`
    UPDATE rate_limits
    SET day_count = MAX(day_count, ?)
    WHERE account_id = ? AND platform = ? AND action_type = ?
  `).run(newCount, accountId, platform, actionType);

  log.warn(`Quota reduced by ${percent}%`, { accountId, platform, actionType, forcedDayCount: newCount });
}

// ----------------------------------------------------------------
// Get current usage summary for an account
// ----------------------------------------------------------------

function getUsage(accountId, platform) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT action_type, hour_count, day_count, hour_reset_at, day_reset_at, last_action_at
    FROM rate_limits
    WHERE account_id = ? AND platform = ?
  `).all(accountId, platform);

  return rows.reduce((acc, r) => {
    acc[r.action_type] = {
      hour: { count: r.hour_count, limit: LIMITS[r.action_type]?.hour ?? null, reset_at: r.hour_reset_at },
      day:  { count: r.day_count,  limit: LIMITS[r.action_type]?.day  ?? null, reset_at: r.day_reset_at },
      last_action_at: r.last_action_at,
    };
    return acc;
  }, {});
}

module.exports = { canPerform, recordAction, reduceQuota, getUsage, LIMITS };
