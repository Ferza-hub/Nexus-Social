'use strict';

// TikTok for Developers — OAuth 2.0
// Docs: https://developers.tiktok.com/doc/login-kit-web

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;

const SCOPES = 'user.info.basic,video.list,video.upload';

function getAuthUrl(accountId, redirectUri) {
  const csrfState = `${accountId}_${Date.now()}`;
  const params = new URLSearchParams({
    client_key:    CLIENT_KEY,
    response_type: 'code',
    scope:         SCOPES,
    redirect_uri:  redirectUri,
    state:         csrfState,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key:    CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt:    new Date(Date.now() + (data.expires_in ?? 86400) * 1000),
    scope:        data.scope,
    meta:         { openId: data.open_id },
  };
}

async function refreshToken(token) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key:    CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: token,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? token,
    expiresAt:    new Date(Date.now() + (data.expires_in ?? 86400) * 1000),
    scope:        data.scope,
  };
}

module.exports = { getAuthUrl, exchangeCode, refreshToken };
