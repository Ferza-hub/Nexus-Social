'use strict';

const path = require('path');
const fs   = require('fs');
const { getDb } = require('../database/db');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('GhostManager');

const STORAGE_DIR = path.join(__dirname, '../../data/ghosts');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ----------------------------------------------------------------
// Fingerprint generation — fixed per ghost, never changes
// ----------------------------------------------------------------

const _UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

const _VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

// [timezone, locale, acceptLanguage, region]
const _TIMEZONES = [
  ['America/New_York',    'en-US', 'en-US,en;q=0.9',          'us'],
  ['America/Chicago',     'en-US', 'en-US,en;q=0.9',          'us'],
  ['America/Los_Angeles', 'en-US', 'en-US,en;q=0.9',          'us'],
  ['America/Toronto',     'en-CA', 'en-CA,en;q=0.9,fr;q=0.8', 'us'],
  ['Europe/London',       'en-GB', 'en-GB,en;q=0.9',          'eu'],
  ['Europe/Berlin',       'de-DE', 'de-DE,de;q=0.9,en;q=0.8', 'eu'],
  ['Europe/Paris',        'fr-FR', 'fr-FR,fr;q=0.9,en;q=0.8', 'eu'],
  ['Asia/Singapore',      'en-SG', 'en-SG,en;q=0.9',          'as'],
  ['Australia/Sydney',    'en-AU', 'en-AU,en;q=0.9',          'au'],
  ['America/Sao_Paulo',   'pt-BR', 'pt-BR,pt;q=0.9,en;q=0.8', 'br'],
  ['Asia/Jakarta',        'id-ID', 'id-ID,id;q=0.9,en;q=0.8', 'as'],
  ['Asia/Kuala_Lumpur',   'ms-MY', 'ms-MY,ms;q=0.9,en;q=0.8', 'as'],
];

const _GPUS = [
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)',  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)',    'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Intel Inc.',           'Intel Iris OpenGL Engine'],
];

const _HW = [
  { concurrency: 4,  memory: 4  },
  { concurrency: 8,  memory: 8  },
  { concurrency: 8,  memory: 16 },
  { concurrency: 12, memory: 16 },
];

function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function _randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateFingerprint() {
  const [timezone, locale, acceptLanguage, region] = _pick(_TIMEZONES);
  const hw      = _pick(_HW);
  const gpuPair = _pick(_GPUS);
  return {
    userAgent:           _pick(_UAS),
    viewport:            _pick(_VIEWPORTS),
    timezone,
    locale,
    acceptLanguage,
    region,                                          // for proxy geo matching
    gpuVendor:           gpuPair[0],
    gpuRenderer:         gpuPair[1],
    canvasSeed:          _randInt(100_000, 999_999_999),
    hardwareConcurrency: hw.concurrency,
    deviceMemory:        hw.memory,
    connectionType:      _pick(['wifi', 'wifi', 'wifi', '4g']), // 75% wifi
    batteryBase:         Math.round((0.3 + Math.random() * 0.65) * 100) / 100, // 0.30–0.95
  };
}

// ----------------------------------------------------------------
// CRUD
// ----------------------------------------------------------------

// platform   : 'youtube' | 'facebook' (extensible)
// credentials: { email, password } or array thereof — required for Facebook ghosts.
//              If array, each ghost gets credentials[i % arr.length].
//              YouTube ghosts are anonymous — credentials can be omitted.
function createGhosts(count = 10, { platform = 'youtube', credentials = null } = {}) {
  const db      = getDb();
  const ids     = [];
  const now     = new Date().toISOString();
  const credsArr = Array.isArray(credentials)
    ? credentials
    : (credentials ? [credentials] : []);

  for (let i = 0; i < count; i++) {
    const fp   = generateFingerprint();
    const cred = credsArr.length ? credsArr[i % credsArr.length] : null;
    const result = db.prepare(
      `INSERT INTO ghost_profiles
         (fingerprint_json, credentials_json, platform, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`
    ).run(JSON.stringify(fp), cred ? JSON.stringify(cred) : null, platform, 'cold', now, now);
    ids.push(Number(result.lastInsertRowid));
  }

  log.info('Ghosts created', { count: ids.length, platform });
  return ids;
}

function getGhosts({ limit = 100, status, platform } = {}) {
  const db         = getDb();
  const conditions = [];
  const args       = [];
  if (status)   { conditions.push('status=?');   args.push(status);   }
  if (platform) { conditions.push('platform=?'); args.push(platform); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM ghost_profiles ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, limit);
}

function getStats(platform = null) {
  const where = platform ? 'WHERE platform=?' : '';
  const args  = platform ? [platform] : [];
  return getDb().prepare(`
    SELECT
      COUNT(*)                                                AS total,
      SUM(CASE WHEN status='ready'   THEN 1 ELSE 0 END)     AS ready,
      SUM(CASE WHEN status='cold'    THEN 1 ELSE 0 END)     AS cold,
      SUM(CASE WHEN status='warming' THEN 1 ELSE 0 END)     AS warming,
      SUM(CASE WHEN status='retired' THEN 1 ELSE 0 END)     AS retired,
      SUM(use_count)                                         AS total_uses
    FROM ghost_profiles ${where}
  `).get(...args);
}

function deleteGhost(ghostId) {
  const db    = getDb();
  const ghost = db.prepare('SELECT storage_state_path FROM ghost_profiles WHERE id=?').get(ghostId);
  if (ghost?.storage_state_path) {
    try { fs.unlinkSync(ghost.storage_state_path); } catch (_) {}
  }
  db.prepare('DELETE FROM ghost_profiles WHERE id=?').run(ghostId);
}

// ----------------------------------------------------------------
// Session lifecycle
// ----------------------------------------------------------------

const MAX_PER_DAY = parseInt(process.env.GHOST_MAX_USES_PER_DAY ?? '8', 10);
const REST_MINUTES = parseInt(process.env.GHOST_REST_MINUTES ?? '45', 10);

// Atomic pick-and-claim: sets last_used_at = NOW on selection so
// concurrent workers can't double-pick the same ghost identity.
// (better-sqlite3 is synchronous — no async race between SELECT and UPDATE)
function pickGhost(platform = 'youtube') {
  const db         = getDb();
  const today      = new Date().toISOString().slice(0, 10);
  const restCutoff = new Date(Date.now() - REST_MINUTES * 60_000).toISOString();
  const now        = new Date().toISOString();

  const ghost = db.prepare(`
    SELECT * FROM ghost_profiles
    WHERE status = 'ready'
    AND platform = ?
    AND (last_used_at IS NULL OR last_used_at < ?)
    AND (today_date IS NULL OR today_date != ? OR use_today < ?)
    ORDER BY last_used_at ASC
    LIMIT 1
  `).get(platform, restCutoff, today, MAX_PER_DAY);

  if (!ghost) return null;

  db.prepare('UPDATE ghost_profiles SET last_used_at=?, updated_at=? WHERE id=?')
    .run(now, now, ghost.id);

  return ghost;
}

function recordUse(ghostId) {
  const db    = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date().toISOString();
  const ghost = db.prepare('SELECT today_date, use_today FROM ghost_profiles WHERE id=?').get(ghostId);
  const useToday = ghost?.today_date === today ? (ghost.use_today + 1) : 1;

  db.prepare(`
    UPDATE ghost_profiles
    SET use_count=use_count+1, use_today=?, today_date=?, last_used_at=?, updated_at=?
    WHERE id=?
  `).run(useToday, today, now, now, ghostId);
}

function setStatus(ghostId, status) {
  getDb().prepare('UPDATE ghost_profiles SET status=?, updated_at=? WHERE id=?')
    .run(status, new Date().toISOString(), ghostId);
}

// ----------------------------------------------------------------
// StorageState I/O — ghost's persistent memory
// ----------------------------------------------------------------

function saveStorageState(ghostId, state) {
  const filePath = path.join(STORAGE_DIR, `ghost_${ghostId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(state));
  const now = new Date().toISOString();
  // Set last_used_at = NOW so REST_MINUTES cooldown applies before first view.
  // Ghost just finished a warmup session — treat it as a "use" to avoid
  // two rapid YouTube sessions from the same browser identity.
  getDb().prepare(
    `UPDATE ghost_profiles
     SET storage_state_path=?, status='ready', warmup_done=1, last_used_at=?, updated_at=?
     WHERE id=?`
  ).run(filePath, now, now, ghostId);
}

function loadStorageState(ghostId) {
  const ghost = getDb().prepare('SELECT storage_state_path FROM ghost_profiles WHERE id=?').get(ghostId);
  if (!ghost?.storage_state_path) return undefined;
  try {
    return JSON.parse(fs.readFileSync(ghost.storage_state_path, 'utf8'));
  } catch (_) {
    return undefined;
  }
}

// ----------------------------------------------------------------
// Logging
// ----------------------------------------------------------------

function logAction(ghostId, platform, action, status, message = null) {
  getDb().prepare(
    `INSERT INTO ghost_logs (ghost_id, platform, action, status, message, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(ghostId, platform, action, status, message, new Date().toISOString());
}

module.exports = {
  generateFingerprint,
  createGhosts,
  getGhosts,
  getStats,
  deleteGhost,
  pickGhost,
  recordUse,
  setStatus,
  saveStorageState,
  loadStorageState,
  logAction,
};
