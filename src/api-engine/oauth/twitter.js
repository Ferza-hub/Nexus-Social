'use strict';

// Twitter/X — OAuth 2.0 PKCE
// Docs: https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code
// Requires: Twitter App with OAuth 2.0 enabled (read+write)

const crypto = require('crypto');

const CLIENT_ID     = process.env.TWITTER_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
const API_BASE      = 'https://api.twitter.com/2';

const SCOPES = 'tweet.read tweet.write users.read follows.read follows.write like.read like.write offline.access';

// In-memory PKCE store — verifier keyed by accountId
// (For multi-instance deployments, store in DB instead)
const _pkceStore = new Map();

function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function getAuthUrl(accountId, redirectUri) {
  const { verifier, challenge } = generatePKCE();
  const state = `${accountId}_${crypto.randomBytes(8).toString('hex')}`;
  _pkceStore.set(String(accountId), { verifier, state });

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             CLIENT_ID,
    redirect_uri:          redirectUri,
    scope:                 SCOPES,
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  return `https://twitter.com/i/oauth2/authorize?${params}`;
}

async function exchangeCode(code, redirectUri, { accountId }) {
  const pkce = _pkceStore.get(String(accountId));
  if (!pkce) throw new Error('PKCE verifier not found — auth flow expired');
  _pkceStore.delete(String(accountId));

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
    },
    body: new URLSearchParams({
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
      code_verifier: pkce.verifier,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt:    data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scope:        data.scope,
  };
}

async function refreshToken(token) {
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: token,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? token,
    expiresAt:    data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scope:        data.scope,
  };
}

module.exports = { getAuthUrl, exchangeCode, refreshToken, API_BASE };
