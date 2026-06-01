'use strict';

const { getDb } = require('./db');

const SCHEMA = `
-- ---------------------------------------------------------------
-- proxies — residential pool, shared across all ephemeral ghosts
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proxies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host            TEXT    NOT NULL,
  port            INTEGER NOT NULL,
  username        TEXT,
  password        TEXT,
  protocol        TEXT    NOT NULL DEFAULT 'http' CHECK(protocol IN ('http','https','socks5')),
  status          TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','banned')),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME
);

-- ---------------------------------------------------------------
-- accounts — minimal credential store, one row per platform login.
-- These are "keys" only: credentials + cached session file.
-- No warmup phases, rate limits, or health tracking.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  platform           TEXT    NOT NULL,
  email              TEXT    NOT NULL,
  password           TEXT    NOT NULL,
  storage_state_path TEXT,
  status             TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','expired')),
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at       DATETIME
);

-- ---------------------------------------------------------------
-- traffic_jobs + logs
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

  addCol('proxies',  'proxy_type',         `TEXT NOT NULL DEFAULT 'residential'`);
  addCol('proxies',  'geo_region',         `TEXT`);

  // accounts table — add columns missing from pre-refactor schema
  addCol('accounts', 'platform',           `TEXT NOT NULL DEFAULT 'unknown'`);
  addCol('accounts', 'email',              `TEXT NOT NULL DEFAULT ''`);
  addCol('accounts', 'password',           `TEXT NOT NULL DEFAULT ''`);
  addCol('accounts', 'storage_state_path', `TEXT`);
  addCol('accounts', 'status',             `TEXT NOT NULL DEFAULT 'active'`);
  addCol('accounts', 'last_used_at',       `DATETIME`);
}

module.exports = { runMigrations };
