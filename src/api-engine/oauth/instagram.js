'use strict';

// Meta Graph API — Instagram Business/Creator
// Docs: https://developers.facebook.com/docs/instagram-api
// Requires: Facebook App with instagram_basic + instagram_content_publish permissions

const APP_ID     = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const API_BASE   = 'https://graph.facebook.com/v19.0';

const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'pages_read_engagement',
].join(',');

function getAuthUrl(accountId, redirectUri) {
  const params = new URLSearchParams({
    client_id:     APP_ID,
    redirect_uri:  redirectUri,
    scope:         SCOPES,
    response_type: 'code',
    state:         String(accountId),
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const res = await fetch(`${API_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     APP_ID,
      client_secret: APP_SECRET,
      redirect_uri:  redirectUri,
      code,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  // Exchange short-lived for long-lived token (60 days)
  const longRes = await fetch(
    `${API_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${data.access_token}`
  );
  const longData = await longRes.json();

  return {
    accessToken:  longData.access_token ?? data.access_token,
    refreshToken: null,
    expiresAt:    new Date(Date.now() + (longData.expires_in ?? 5184000) * 1000),
    scope:        SCOPES,
  };
}

// Instagram does not use refresh tokens — must re-auth when expired
async function refreshToken(_refreshToken) {
  throw new Error('Instagram tokens must be manually renewed (no refresh token flow)');
}

// Get Instagram Business Account ID linked to this token
async function getIgBusinessAccountId(accessToken) {
  const res = await fetch(`${API_BASE}/me/accounts?access_token=${accessToken}`);
  const data = await res.json();
  if (!data.data?.length) throw new Error('No Facebook Pages found for this token');

  // Get the IG account linked to the first page
  const pageId    = data.data[0].id;
  const pageToken = data.data[0].access_token;

  const igRes  = await fetch(`${API_BASE}/${pageId}?fields=instagram_business_account&access_token=${pageToken}`);
  const igData = await igRes.json();
  if (!igData.instagram_business_account?.id) throw new Error('No Instagram Business account linked to this Page');

  return { igAccountId: igData.instagram_business_account.id, pageToken };
}

module.exports = { getAuthUrl, exchangeCode, refreshToken, getIgBusinessAccountId, API_BASE };
