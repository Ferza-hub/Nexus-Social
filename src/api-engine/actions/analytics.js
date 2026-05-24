'use strict';

const { getValidToken } = require('../oauth/index');
const { makeLogger } = require('../../utils/logger');

const log = makeLogger('ApiAnalytics');

// ----------------------------------------------------------------
// Instagram — insights via Graph API
// ----------------------------------------------------------------

async function _igAnalytics(accountId) {
  const { getIgBusinessAccountId, API_BASE } = require('../oauth/instagram');
  const token = await getValidToken(accountId, 'instagram');
  const { igAccountId, pageToken } = await getIgBusinessAccountId(token);

  const fields = 'followers_count,media_count,profile_views,reach,impressions,accounts_engaged';
  const res = await fetch(
    `${API_BASE}/${igAccountId}/insights?metric=reach,impressions,profile_views&period=day&access_token=${pageToken}`
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  // Basic account info
  const infoRes = await fetch(
    `${API_BASE}/${igAccountId}?fields=followers_count,media_count&access_token=${pageToken}`
  );
  const info = await infoRes.json();

  return {
    followers:   info.followers_count ?? null,
    mediaCount:  info.media_count ?? null,
    insights:    data.data ?? [],
  };
}

// ----------------------------------------------------------------
// Twitter — account metrics via API v2
// ----------------------------------------------------------------

async function _twitterAnalytics(accountId) {
  const { API_BASE } = require('../oauth/twitter');
  const token = await getValidToken(accountId, 'twitter');

  const meRes = await fetch(`${API_BASE}/users/me?user.fields=public_metrics`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const me = await meRes.json();
  if (me.errors) throw new Error(me.errors[0].message);

  return {
    followers:  me.data?.public_metrics?.followers_count ?? null,
    following:  me.data?.public_metrics?.following_count ?? null,
    tweets:     me.data?.public_metrics?.tweet_count ?? null,
    username:   me.data?.username ?? null,
  };
}

// ----------------------------------------------------------------
// YouTube — channel stats
// ----------------------------------------------------------------

async function _youtubeAnalytics(accountId) {
  const token = await getValidToken(accountId, 'youtube');
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true',
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const stats = data.items?.[0]?.statistics ?? {};
  return {
    subscribers:   parseInt(stats.subscriberCount ?? 0),
    views:         parseInt(stats.viewCount ?? 0),
    videos:        parseInt(stats.videoCount ?? 0),
  };
}

// ----------------------------------------------------------------
// getAnalytics — dispatch by platform
// ----------------------------------------------------------------

const ANALYTICS_MAP = {
  instagram: _igAnalytics,
  twitter:   _twitterAnalytics,
  youtube:   _youtubeAnalytics,
};

async function getAnalytics(accountId, platform) {
  const fn = ANALYTICS_MAP[platform];
  if (!fn) return { success: false, error: `Analytics not supported for platform: ${platform}` };

  try {
    const data = await fn(accountId);
    return { success: true, platform, ...data };
  } catch (err) {
    log.error('Analytics failed', { accountId, platform, err: err.message });
    return { success: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// getFollowers — return follower usernames/ids for targeting
// ----------------------------------------------------------------

async function getFollowers(accountId, platform, { limit = 100 } = {}) {
  try {
    if (platform === 'twitter') {
      const { API_BASE } = require('../oauth/twitter');
      const token = await getValidToken(accountId, platform);

      // Get own user ID
      const meRes = await fetch(`${API_BASE}/users/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const me = await meRes.json();
      const userId = me.data?.id;

      const res = await fetch(`${API_BASE}/users/${userId}/followers?max_results=${Math.min(limit, 1000)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      return { success: true, followers: data.data ?? [] };
    }

    if (platform === 'instagram') {
      const { getIgBusinessAccountId, API_BASE } = require('../oauth/instagram');
      const token = await getValidToken(accountId, platform);
      const { igAccountId, pageToken } = await getIgBusinessAccountId(token);

      const res = await fetch(
        `${API_BASE}/${igAccountId}/followers?access_token=${pageToken}&limit=${Math.min(limit, 50)}`
      );
      const data = await res.json();
      return { success: true, followers: data.data ?? [] };
    }

    return { success: false, error: `getFollowers not implemented for: ${platform}` };
  } catch (err) {
    log.error('getFollowers failed', { accountId, platform, err: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { getAnalytics, getFollowers };
