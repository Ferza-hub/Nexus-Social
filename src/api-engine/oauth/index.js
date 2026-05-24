'use strict';

// OAuth token manager — save, load, refresh tokens per account/platform
// Each platform module handles its own auth URL + callback logic;
// this module owns the token store (oauth_tokens table).

const { getDb } = require('../../database/db');
const { makeLogger } = require('../../utils/logger');

const log = makeLogger('OAuthManager');

// ----------------------------------------------------------------
// Lazy-load platform modules to avoid circular deps
// ----------------------------------------------------------------

const PROVIDERS = {
  instagram: () => require('./instagram'),
  twitter:   () => require('./twitter'),
  youtube:   () => require('./youtube'),
  tiktok:    () => require('./tiktok'),
  linkedin:  () => require('./linkedin'),
};

// ----------------------------------------------------------------
// Token CRUD
// ----------------------------------------------------------------

function saveToken(accountId, platform, { accessToken, refreshToken, expiresAt, scope, meta }) {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO oauth_tokens (account_id, platform, access_token, refresh_token, expires_at, scope, meta_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, platform) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, refresh_token),
      expires_at    = excluded.expires_at,
      scope         = excluded.scope,
      meta_json     = excluded.meta_json,
      updated_at    = excluded.updated_at
  `).run(
    accountId, platform,
    accessToken,
    refreshToken ?? null,
    expiresAt    ? new Date(expiresAt).toISOString() : null,
    scope        ?? null,
    meta         ? JSON.stringify(meta) : null,
    now,
  );

  log.info('Token saved', { accountId, platform });
}

function loadToken(accountId, platform) {
  const row = getDb().prepare(`
    SELECT * FROM oauth_tokens WHERE account_id = ? AND platform = ?
  `).get(accountId, platform);

  if (!row) return null;

  return {
    ...row,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    isExpired: row.expires_at ? new Date(row.expires_at) <= new Date() : false,
  };
}

function deleteToken(accountId, platform) {
  getDb().prepare(`DELETE FROM oauth_tokens WHERE account_id = ? AND platform = ?`)
    .run(accountId, platform);
  log.info('Token deleted', { accountId, platform });
}

// ----------------------------------------------------------------
// Get a valid (auto-refreshed) access token
// ----------------------------------------------------------------

async function getValidToken(accountId, platform) {
  const token = loadToken(accountId, platform);
  if (!token) throw new Error(`No OAuth token for account ${accountId} on ${platform}`);

  if (token.isExpired && token.refresh_token) {
    log.info('Token expired — refreshing', { accountId, platform });
    const provider = PROVIDERS[platform]?.();
    if (!provider?.refreshToken) throw new Error(`Platform ${platform} does not support token refresh`);

    const fresh = await provider.refreshToken(token.refresh_token);
    saveToken(accountId, platform, fresh);
    return fresh.accessToken;
  }

  return token.access_token;
}

// ----------------------------------------------------------------
// Generate OAuth URL for a platform (called from panel)
// ----------------------------------------------------------------

function getAuthUrl(platform, accountId, redirectUri) {
  const provider = PROVIDERS[platform]?.();
  if (!provider?.getAuthUrl) throw new Error(`Unknown OAuth platform: ${platform}`);
  return provider.getAuthUrl(accountId, redirectUri);
}

// ----------------------------------------------------------------
// Handle OAuth callback — exchange code for token
// ----------------------------------------------------------------

async function handleCallback(platform, accountId, code, redirectUri, extra) {
  const provider = PROVIDERS[platform]?.();
  if (!provider?.exchangeCode) throw new Error(`Unknown OAuth platform: ${platform}`);

  const tokenData = await provider.exchangeCode(code, redirectUri, extra);
  saveToken(accountId, platform, tokenData);
  return tokenData;
}

module.exports = { saveToken, loadToken, deleteToken, getValidToken, getAuthUrl, handleCallback };
