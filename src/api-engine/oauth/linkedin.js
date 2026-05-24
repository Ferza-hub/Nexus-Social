'use strict';

// LinkedIn OAuth 2.0
// Docs: https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow

const CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const TOKEN_URL     = 'https://www.linkedin.com/oauth/v2/accessToken';

const SCOPES = 'openid profile email w_member_social r_organization_social';

function getAuthUrl(accountId, redirectUri) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  redirectUri,
    state:         String(accountId),
    scope:         SCOPES,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt:    new Date(Date.now() + (data.expires_in ?? 5184000) * 1000),
    scope:        SCOPES,
  };
}

async function refreshToken(token) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: token,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? token,
    expiresAt:    new Date(Date.now() + (data.expires_in ?? 5184000) * 1000),
    scope:        SCOPES,
  };
}

module.exports = { getAuthUrl, exchangeCode, refreshToken };
