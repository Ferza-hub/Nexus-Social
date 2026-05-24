'use strict';

const { getDb } = require('./db');

const SCHEMA = `
-- ---------------------------------------------------------------
-- accounts: kredensial + platform + status akun
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT    NOT NULL,
  password         TEXT    NOT NULL,
  email            TEXT,
  phone            TEXT,
  platform         TEXT    NOT NULL CHECK(platform IN ('instagram','tiktok','twitter','youtube','facebook','threads')),
  status           TEXT    NOT NULL DEFAULT 'new'
                           CHECK(status IN ('new','warming','active','flagged','recovery','disabled')),
  proxy_id         INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  two_fa_secret    TEXT,
  warmup_day       INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at   DATETIME
);

-- ---------------------------------------------------------------
-- proxies: 1 proxy = 1 akun (dedicated)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proxies (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  host                TEXT    NOT NULL,
  port                INTEGER NOT NULL,
  username            TEXT,
  password            TEXT,
  protocol            TEXT    NOT NULL DEFAULT 'http' CHECK(protocol IN ('http','https','socks5')),
  status              TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','banned')),
  assigned_account_id INTEGER UNIQUE,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked_at     DATETIME
);

-- ---------------------------------------------------------------
-- sessions: storageState Playwright per akun
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform           TEXT    NOT NULL,
  storage_state_path TEXT    NOT NULL,
  is_valid           INTEGER NOT NULL DEFAULT 1,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at         DATETIME,
  UNIQUE(account_id, platform)
);

-- ---------------------------------------------------------------
-- rate_limits: counter per akun per platform per action
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform      TEXT    NOT NULL,
  action_type   TEXT    NOT NULL CHECK(action_type IN ('follow','unfollow','like','comment','story_view','dm','watch_reel')),
  hour_count    INTEGER NOT NULL DEFAULT 0,
  day_count     INTEGER NOT NULL DEFAULT 0,
  hour_reset_at DATETIME,
  day_reset_at  DATETIME,
  last_action_at DATETIME,
  UNIQUE(account_id, platform, action_type)
);

-- ---------------------------------------------------------------
-- health_logs: history status akun
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS health_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL,
  event_type   TEXT    NOT NULL CHECK(event_type IN ('ok','challenge','captcha','action_block','unusual_activity','disabled','login_required','warning')),
  message      TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------
-- warmup_schedules: jadwal warmup per akun baru
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warmup_schedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform       TEXT    NOT NULL,
  started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_day    INTEGER NOT NULL DEFAULT 1,
  current_phase  TEXT    NOT NULL DEFAULT 'login_only'
                         CHECK(current_phase IN ('login_only','light','medium','full')),
  max_likes_day  INTEGER NOT NULL DEFAULT 0,
  max_follows_day INTEGER NOT NULL DEFAULT 0,
  max_comments_day INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, platform)
);

-- ---------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_accounts_platform_status ON accounts(platform, status);
CREATE INDEX IF NOT EXISTS idx_rate_limits_account      ON rate_limits(account_id, platform);
CREATE INDEX IF NOT EXISTS idx_health_logs_account      ON health_logs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_account         ON sessions(account_id, is_valid);
`;

function runMigrations(db) {
  db.exec(SCHEMA);
}

module.exports = { runMigrations };
