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
-- oauth_tokens: platform API tokens per akun
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform      TEXT    NOT NULL,
  access_token  TEXT    NOT NULL,
  refresh_token TEXT,
  expires_at    DATETIME,
  scope         TEXT,
  meta_json     TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, platform)
);

-- ---------------------------------------------------------------
-- campaigns: growth / content / hybrid campaigns
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform        TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK(type IN ('growth','content','hybrid')),
  status          TEXT    NOT NULL DEFAULT 'draft'
                          CHECK(status IN ('draft','running','paused','completed','failed')),
  config_json     TEXT    NOT NULL DEFAULT '{}',
  target_count    INTEGER,
  completed_count INTEGER NOT NULL DEFAULT 0,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at      DATETIME,
  completed_at    DATETIME
);

-- ---------------------------------------------------------------
-- campaign_logs: action-level results per campaign run
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL,
  action      TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK(status IN ('success','failed','skipped','blocked')),
  message     TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------
-- post_queue: scheduled content posts (CONTENT / HYBRID)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL,
  campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  content_json TEXT    NOT NULL,
  scheduled_at DATETIME NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','running','done','failed','cancelled')),
  retry_count  INTEGER NOT NULL DEFAULT 0,
  max_retries  INTEGER NOT NULL DEFAULT 3,
  result_json  TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_accounts_platform_status ON accounts(platform, status);
CREATE INDEX IF NOT EXISTS idx_rate_limits_account      ON rate_limits(account_id, platform);
CREATE INDEX IF NOT EXISTS idx_health_logs_account      ON health_logs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_account         ON sessions(account_id, is_valid);
CREATE INDEX IF NOT EXISTS idx_campaigns_status         ON campaigns(status, platform);
CREATE INDEX IF NOT EXISTS idx_post_queue_scheduled     ON post_queue(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_campaign_logs_campaign   ON campaign_logs(campaign_id, created_at);

-- ---------------------------------------------------------------
-- traffic_jobs: instant traffic campaigns (views / likes / follows)
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
  account_id INTEGER NOT NULL,
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

  // Additive column migrations — safe to run on every startup
  const addCol = (table, col, def) => {
    try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  };

  addCol('accounts', 'login_method',  `TEXT NOT NULL DEFAULT 'password'`);
  addCol('accounts', 'account_role',  `TEXT NOT NULL DEFAULT 'managed'`);
  addCol('traffic_jobs', 'account_scope', `TEXT NOT NULL DEFAULT 'traffic'`);
  addCol('proxies', 'proxy_type', `TEXT NOT NULL DEFAULT 'dedicated'`);
}

module.exports = { runMigrations };
