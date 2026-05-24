'use strict';

// Google OAuth 2.0 — YouTube Data API v3
// Docs: https://developers.google.com/youtube/v3/getting-started

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');

function getAuthUrl(accountId, redirectUri) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state:         String(accountId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt:    new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    scope:        data.scope,
  };
}

async function refreshToken(token) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: token,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: token, // Google keeps the same refresh token
    expiresAt:    new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    scope:        data.scope,
  };
}

module.exports = { getAuthUrl, exchangeCode, refreshToken };
