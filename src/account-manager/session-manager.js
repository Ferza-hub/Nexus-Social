'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database/db');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('SessionManager');
const SESSION_DIR = process.env.SESSION_DIR || path.join(process.cwd(), 'data', 'sessions');

// ----------------------------------------------------------------
// Path helpers
// ----------------------------------------------------------------

function sessionPath(platform, accountId) {
  const dir = path.join(SESSION_DIR, platform);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${accountId}.json`);
}

// ----------------------------------------------------------------
// Save storageState returned by Playwright to disk + DB record
// ----------------------------------------------------------------

function saveSession(accountId, platform, storageState) {
  const filePath = sessionPath(platform, accountId);
  fs.writeFileSync(filePath, JSON.stringify(storageState, null, 2), 'utf-8');

  const db = getDb();
  const now = new Date().toISOString();
  // Sessions expire after 29 days — refresh before that
  const expiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (account_id, platform, storage_state_path, is_valid, updated_at, expires_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(account_id, platform) DO UPDATE SET
      storage_state_path = excluded.storage_state_path,
      is_valid           = 1,
      updated_at         = excluded.updated_at,
      expires_at         = excluded.expires_at
  `).run(accountId, platform, filePath, now, expiresAt);

  db.prepare(`UPDATE accounts SET last_active_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, accountId);

  log.info(`Session saved`, { accountId, platform });
  return filePath;
}

// ----------------------------------------------------------------
// Load storageState from disk — returns null if missing/invalid
// ----------------------------------------------------------------

function loadSession(accountId, platform) {
  const db = getDb();
  const row = db.prepare(`
    SELECT storage_state_path, is_valid, expires_at
    FROM sessions
    WHERE account_id = ? AND platform = ?
  `).get(accountId, platform);

  if (!row) {
    log.debug('No session record found', { accountId, platform });
    return null;
  }

  if (!row.is_valid) {
    log.warn('Session marked invalid — re-login required', { accountId, platform });
    return null;
  }

  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    log.warn('Session expired — re-login required', { accountId, platform });
    invalidateSession(accountId, platform);
    return null;
  }

  if (!fs.existsSync(row.storage_state_path)) {
    log.warn('Session file missing on disk', { accountId, platform, path: row.storage_state_path });
    invalidateSession(accountId, platform);
    return null;
  }

  try {
    const state = JSON.parse(fs.readFileSync(row.storage_state_path, 'utf-8'));
    log.debug('Session loaded', { accountId, platform });
    return state;
  } catch (err) {
    log.error('Failed to parse session file', { accountId, platform, err: err.message });
    invalidateSession(accountId, platform);
    return null;
  }
}

// ----------------------------------------------------------------
// Flag a session as invalid → triggers re-login next run
// ----------------------------------------------------------------

function invalidateSession(accountId, platform) {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET is_valid = 0, updated_at = ?
    WHERE account_id = ? AND platform = ?
  `).run(new Date().toISOString(), accountId, platform);

  db.prepare(`
    UPDATE accounts SET status = 'flagged', updated_at = ?
    WHERE id = ? AND status NOT IN ('disabled')
  `).run(new Date().toISOString(), accountId);

  log.warn('Session invalidated — account flagged for re-login', { accountId, platform });
}

// ----------------------------------------------------------------
// Return accounts whose session expires within the next 3 days
// ----------------------------------------------------------------

function getExpiringAccounts(withinDays = 3) {
  const db = getDb();
  const threshold = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT s.account_id, s.platform, s.expires_at, a.username
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.is_valid = 1
      AND s.expires_at IS NOT NULL
      AND s.expires_at <= ?
  `).all(threshold);
}

// ----------------------------------------------------------------
// Delete session file + DB record (used on account removal)
// ----------------------------------------------------------------

function deleteSession(accountId, platform) {
  const db = getDb();
  const row = db.prepare(`
    SELECT storage_state_path FROM sessions WHERE account_id = ? AND platform = ?
  `).get(accountId, platform);

  if (row && fs.existsSync(row.storage_state_path)) {
    fs.unlinkSync(row.storage_state_path);
  }

  db.prepare(`DELETE FROM sessions WHERE account_id = ? AND platform = ?`)
    .run(accountId, platform);

  log.info('Session deleted', { accountId, platform });
}

module.exports = {
  saveSession,
  loadSession,
  invalidateSession,
  getExpiringAccounts,
  deleteSession,
  hasActiveSession,
};

function hasActiveSession(accountId, platform) {
  const row = getDb().prepare(`
    SELECT is_valid, expires_at FROM sessions
    WHERE account_id = ? AND platform = ? AND is_valid = 1
  `).get(accountId, platform);
  if (!row) return false;
  return new Date(row.expires_at) > new Date();
}
