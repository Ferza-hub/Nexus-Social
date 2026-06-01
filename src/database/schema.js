'use strict';

const { getDb } = require('./db');

// Only the tables the ghost-pool architecture needs.
// Account management tables (accounts, sessions, campaigns, etc.) are
// intentionally absent — the ghost pool replaces that entire layer.
const SCHEMA = `
-- ---------------------------------------------------------------
-- proxies — shared pool, ghosts pick by geo region
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proxies (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  host                TEXT    NOT NULL,
  port                INTEGER NOT NULL,
  username            TEXT,
  password            TEXT,
  protocol            TEXT    NOT NULL DEFAULT 'http' CHECK(protocol IN ('http','https','socks5')),
  status              TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','banned')),
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at     DATETIME
);

-- ---------------------------------------------------------------
-- traffic_jobs + logs — job lifecycle and per-execution records
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traffic_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT    NOT NULL,
  action_type     TEXT    NOT NULL,
  target_value    TEXT    NOT NULL,
  target_count    INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','running','completed','failed','paused')),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at      DATETIME,
  completed_at    DATETIME
);

CREATE TABLE IF NOT EXISTS traffic_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES traffic_jobs(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL DEFAULT 0,
  platform   TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK(status IN ('success','failed','skipped')),
  message    TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_traffic_jobs_status ON traffic_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_traffic_logs_job    ON traffic_logs(job_id, created_at);
`;

function runMigrations(db) {
  db.exec(SCHEMA);

  const addCol = (table, col, def) => {
    try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  };

  // Proxy extensions
  addCol('proxies', 'proxy_type', `TEXT NOT NULL DEFAULT 'residential'`);
  addCol('proxies', 'geo_region', `TEXT`);

  // Ghost profiles tables — platform-specific anonymous/authenticated ghost pool
  db.exec(`
    CREATE TABLE IF NOT EXISTS ghost_profiles (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint_json    TEXT    NOT NULL,
      storage_state_path  TEXT,
      status              TEXT    NOT NULL DEFAULT 'cold'
                          CHECK(status IN ('cold','warming','ready','retired')),
      warmup_done         INTEGER NOT NULL DEFAULT 0,
      use_count           INTEGER NOT NULL DEFAULT 0,
      use_today           INTEGER NOT NULL DEFAULT 0,
      today_date          TEXT,
      last_used_at        DATETIME,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ghost_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ghost_id   INTEGER NOT NULL REFERENCES ghost_profiles(id) ON DELETE CASCADE,
      platform   TEXT    NOT NULL,
      action     TEXT    NOT NULL,
      status     TEXT    NOT NULL CHECK(status IN ('success','failed')),
      message    TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ghost_profiles_status ON ghost_profiles(status, last_used_at);
    CREATE INDEX IF NOT EXISTS idx_ghost_logs_ghost      ON ghost_logs(ghost_id, created_at);
  `);

  // Ghost profile extensions (additive — must run after CREATE TABLE above)
  addCol('ghost_profiles', 'platform',         `TEXT NOT NULL DEFAULT 'youtube'`);
  addCol('ghost_profiles', 'credentials_json', `TEXT`);
}

module.exports = { runMigrations };
