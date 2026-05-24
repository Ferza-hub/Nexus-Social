'use strict';

const { getDb } = require('../database/db');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('WarmupScheduler');

// ----------------------------------------------------------------
// Warmup phases per roadmap:
//   Day 1–3  : login_only  (scroll, watch story — no actions)
//   Day 4–7  : light       (like 10-20/day, follow 10/day)
//   Day 8–14 : medium      (like 50/day, follow 50/day, comment 5/day)
//   Day 15+  : full        (full quota from LIMITS)
// ----------------------------------------------------------------

const PHASES = [
  { name: 'login_only', minDay: 1,  maxDay: 3,  likes: 0,   follows: 0,  comments: 0  },
  { name: 'light',      minDay: 4,  maxDay: 7,  likes: 15,  follows: 10, comments: 0  },
  { name: 'medium',     minDay: 8,  maxDay: 14, likes: 50,  follows: 50, comments: 5  },
  { name: 'full',       minDay: 15, maxDay: Infinity, likes: null, follows: null, comments: null },
];

function phaseForDay(day) {
  return PHASES.find(p => day >= p.minDay && day <= p.maxDay) || PHASES[PHASES.length - 1];
}

// ----------------------------------------------------------------
// Initialize warmup schedule for a new account
// ----------------------------------------------------------------

function initWarmup(accountId, platform) {
  const db = getDb();
  const phase = phaseForDay(1);

  db.prepare(`
    INSERT OR IGNORE INTO warmup_schedules
      (account_id, platform, current_day, current_phase, max_likes_day, max_follows_day, max_comments_day, completed)
    VALUES (?, ?, 1, ?, ?, ?, ?, 0)
  `).run(accountId, platform, phase.name, phase.likes ?? 0, phase.follows ?? 0, phase.comments ?? 0);

  db.prepare(`UPDATE accounts SET status = 'warming', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), accountId);

  log.info('Warmup initialized', { accountId, platform, phase: phase.name });
}

// ----------------------------------------------------------------
// Advance warmup day (call once per day via cron)
// Returns the new schedule row, or null if account not in warmup
// ----------------------------------------------------------------

function advanceWarmupDay(accountId, platform) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM warmup_schedules
    WHERE account_id = ? AND platform = ? AND completed = 0
  `).get(accountId, platform);

  if (!row) return null;

  const newDay = row.current_day + 1;
  const phase = phaseForDay(newDay);
  const isCompleted = phase.name === 'full' ? 0 : 0; // stays 0; full = graduation
  const graduated = newDay >= 15 && phase.name === 'full';

  db.prepare(`
    UPDATE warmup_schedules
    SET current_day     = ?,
        current_phase   = ?,
        max_likes_day   = ?,
        max_follows_day = ?,
        max_comments_day = ?,
        completed       = ?
    WHERE account_id = ? AND platform = ?
  `).run(
    newDay,
    phase.name,
    phase.likes    ?? 300,
    phase.follows  ?? 150,
    phase.comments ?? 100,
    graduated ? 1 : 0,
    accountId,
    platform,
  );

  if (graduated) {
    db.prepare(`UPDATE accounts SET status = 'active', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), accountId);
    log.info('Account graduated to full automation', { accountId, platform, day: newDay });
  } else {
    log.info('Warmup day advanced', { accountId, platform, day: newDay, phase: phase.name });
  }

  return db.prepare(`SELECT * FROM warmup_schedules WHERE account_id = ? AND platform = ?`)
    .get(accountId, platform);
}

// ----------------------------------------------------------------
// Get current warmup limits for an account
// Returns null if account is not in warmup (already full or no record)
// ----------------------------------------------------------------

function getWarmupLimits(accountId, platform) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM warmup_schedules WHERE account_id = ? AND platform = ?
  `).get(accountId, platform);

  if (!row || row.completed) return null;

  return {
    phase:       row.current_phase,
    day:         row.current_day,
    maxLikes:    row.max_likes_day,
    maxFollows:  row.max_follows_day,
    maxComments: row.max_comments_day,
  };
}

// ----------------------------------------------------------------
// Run daily warmup advancement for ALL warming accounts
// (call this from cron every 24h or at midnight)
// ----------------------------------------------------------------

function runDailyAdvancement() {
  const db = getDb();
  const warmingAccounts = db.prepare(`
    SELECT ws.account_id, ws.platform
    FROM warmup_schedules ws
    JOIN accounts a ON a.id = ws.account_id
    WHERE ws.completed = 0 AND a.status = 'warming'
  `).all();

  log.info(`Advancing ${warmingAccounts.length} warming account(s)`);

  for (const { account_id, platform } of warmingAccounts) {
    try {
      advanceWarmupDay(account_id, platform);
    } catch (err) {
      log.error('Failed to advance warmup', { account_id, platform, err: err.message });
    }
  }
}

// ----------------------------------------------------------------
// Transition account back to warming after recovery
// ----------------------------------------------------------------

function restartWarmup(accountId, platform) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM warmup_schedules WHERE account_id = ? AND platform = ?
  `).get(accountId, platform);

  const resetDay = row ? Math.max(1, row.current_day - 7) : 1;
  const phase = phaseForDay(resetDay);

  if (row) {
    db.prepare(`
      UPDATE warmup_schedules
      SET current_day = ?, current_phase = ?, max_likes_day = ?,
          max_follows_day = ?, max_comments_day = ?, completed = 0
      WHERE account_id = ? AND platform = ?
    `).run(resetDay, phase.name, phase.likes ?? 0, phase.follows ?? 0, phase.comments ?? 0, accountId, platform);
  } else {
    initWarmup(accountId, platform);
  }

  db.prepare(`UPDATE accounts SET status = 'warming', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), accountId);

  log.info('Warmup restarted (recovery)', { accountId, platform, resetDay });
}

module.exports = {
  initWarmup,
  advanceWarmupDay,
  runDailyAdvancement,
  getWarmupLimits,
  restartWarmup,
  phaseForDay,
};
