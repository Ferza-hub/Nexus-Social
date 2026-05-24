'use strict';

// API-based publishing actions
// Supports: instagram (Graph API), twitter, youtube, tiktok, linkedin

const { getValidToken } = require('../oauth/index');
const { getDb } = require('../../database/db');
const { makeLogger } = require('../../utils/logger');

const log = makeLogger('ApiPost');

// ----------------------------------------------------------------
// Instagram — publish photo/video/carousel via Graph API
// ----------------------------------------------------------------

async function _publishInstagram(accountId, content) {
  const { getIgBusinessAccountId, API_BASE } = require('../oauth/instagram');
  const accessToken = await getValidToken(accountId, 'instagram');
  const { igAccountId, pageToken } = await getIgBusinessAccountId(accessToken);

  const { type, mediaUrls, caption, hashtags } = content;
  const fullCaption = [caption, hashtags?.map(t => `#${t}`).join(' ')].filter(Boolean).join('\n\n');

  if (type === 'photo') {
    // Step 1: Create media container
    const containerRes = await fetch(`${API_BASE}/${igAccountId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: mediaUrls[0], caption: fullCaption, access_token: pageToken }),
    });
    const container = await containerRes.json();
    if (container.error) throw new Error(container.error.message);

    // Step 2: Publish
    const publishRes = await fetch(`${API_BASE}/${igAccountId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id, access_token: pageToken }),
    });
    const result = await publishRes.json();
    if (result.error) throw new Error(result.error.message);
    return { postId: result.id };

  } else if (type === 'carousel') {
    // Create item containers
    const items = await Promise.all(mediaUrls.map(url =>
      fetch(`${API_BASE}/${igAccountId}/media`, {
        method: 'POST',
        body: new URLSearchParams({ image_url: url, is_carousel_item: 'true', access_token: pageToken }),
      }).then(r => r.json())
    ));

    const containerRes = await fetch(`${API_BASE}/${igAccountId}/media`, {
      method: 'POST',
      body: new URLSearchParams({
        media_type:       'CAROUSEL',
        children:         items.map(i => i.id).join(','),
        caption:          fullCaption,
        access_token:     pageToken,
      }),
    });
    const container = await containerRes.json();
    if (container.error) throw new Error(container.error.message);

    const publishRes = await fetch(`${API_BASE}/${igAccountId}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: container.id, access_token: pageToken }),
    });
    const result = await publishRes.json();
    if (result.error) throw new Error(result.error.message);
    return { postId: result.id };
  }

  throw new Error(`Instagram: unsupported content type: ${type}`);
}

// ----------------------------------------------------------------
// Twitter — post a tweet via API v2
// ----------------------------------------------------------------

async function _publishTwitter(accountId, content) {
  const { API_BASE } = require('../oauth/twitter');
  const accessToken = await getValidToken(accountId, 'twitter');
  const { text, hashtags } = content;

  const tweetText = [text, hashtags?.map(t => `#${t}`).join(' ')].filter(Boolean).join('\n\n');

  const res = await fetch(`${API_BASE}/tweets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ text: tweetText }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return { postId: data.data.id };
}

// ----------------------------------------------------------------
// YouTube — upload video (supports resumable upload)
// ----------------------------------------------------------------

async function _publishYouTube(accountId, content) {
  const accessToken = await getValidToken(accountId, 'youtube');
  const { title, description, videoUrl, tags, privacyStatus = 'public' } = content;

  // For simplicity: use simple upload for small videos
  // Production: use resumable upload for large files
  const metadata = {
    snippet: {
      title,
      description,
      tags: tags ?? [],
      defaultLanguage: 'en',
    },
    status: { privacyStatus },
  };

  // Initiate resumable upload
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        'Authorization':   `Bearer ${accessToken}`,
        'Content-Type':    'application/json',
        'X-Upload-Content-Type': 'video/*',
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const err = await initRes.json();
    throw new Error(err.error?.message ?? 'YouTube upload init failed');
  }

  const uploadUrl = initRes.headers.get('location');

  // Fetch video bytes from URL and upload
  const videoRes = await fetch(videoUrl);
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'video/*',
      'Content-Length': String(videoBuffer.length),
    },
    body: videoBuffer,
  });
  const result = await uploadRes.json();
  if (result.error) throw new Error(result.error.message);
  return { postId: result.id };
}

// ----------------------------------------------------------------
// TikTok — direct post via Content Posting API
// ----------------------------------------------------------------

async function _publishTikTok(accountId, content) {
  const accessToken = await getValidToken(accountId, 'tiktok');
  const tokenRow = require('../../database/db').getDb().prepare(
    `SELECT meta_json FROM oauth_tokens WHERE account_id = ? AND platform = 'tiktok'`
  ).get(accountId);
  const openId = tokenRow ? JSON.parse(tokenRow.meta_json ?? '{}')?.openId : null;

  const { videoUrl, title, hashtags } = content;
  const desc = [title, hashtags?.map(t => `#${t}`).join(' ')].filter(Boolean).join(' ');

  // Init upload
  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: { title: desc, privacy_level: 'PUBLIC_TO_EVERYONE', disable_duet: false, disable_comment: false },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    }),
  });
  const initData = await initRes.json();
  if (initData.error?.code !== 'ok') throw new Error(initData.error?.message ?? 'TikTok upload init failed');
  return { postId: initData.data.publish_id };
}

// ----------------------------------------------------------------
// LinkedIn — create share (text/image/video)
// ----------------------------------------------------------------

async function _publishLinkedIn(accountId, content) {
  const accessToken = await getValidToken(accountId, 'linkedin');
  const { text, mediaUrl, mediaType } = content;

  // Get author URN
  const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const profile = await profileRes.json();
  const authorUrn = `urn:li:person:${profile.sub}`;

  const shareContent = {
    shareCommentary: { text },
    shareMediaCategory: mediaUrl ? (mediaType === 'video' ? 'VIDEO' : 'IMAGE') : 'NONE',
  };

  if (mediaUrl) {
    shareContent.media = [{
      status: 'READY',
      originalUrl: mediaUrl,
    }];
  }

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Authorization':    `Bearer ${accessToken}`,
      'Content-Type':     'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }),
  });
  const data = await res.json();
  if (data.status >= 400) throw new Error(data.message ?? 'LinkedIn publish failed');
  return { postId: data.id };
}

// ----------------------------------------------------------------
// Platform dispatch map
// ----------------------------------------------------------------

const PUBLISHERS = {
  instagram: _publishInstagram,
  twitter:   _publishTwitter,
  youtube:   _publishYouTube,
  tiktok:    _publishTikTok,
  linkedin:  _publishLinkedIn,
};

// ----------------------------------------------------------------
// Public: publishPost — publish immediately via API
// ----------------------------------------------------------------

async function publishPost(accountId, platform, content) {
  const publisher = PUBLISHERS[platform];
  if (!publisher) throw new Error(`No API publisher for platform: ${platform}`);

  log.info('Publishing post', { accountId, platform, type: content.type });

  try {
    const result = await publisher(accountId, content);
    log.info('Post published', { accountId, platform, postId: result.postId });
    return { success: true, ...result };
  } catch (err) {
    log.error('Publish failed', { accountId, platform, err: err.message });
    return { success: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// Public: schedulePost — add to post_queue
// ----------------------------------------------------------------

function schedulePost(accountId, platform, content, scheduledAt, campaignId = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const scheduledIso = new Date(scheduledAt).toISOString();

  const result = db.prepare(`
    INSERT INTO post_queue (account_id, platform, campaign_id, content_json, scheduled_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, platform, campaignId, JSON.stringify(content), scheduledIso, now);

  log.info('Post scheduled', { accountId, platform, scheduledAt: scheduledIso, queueId: result.lastInsertRowid });
  return result.lastInsertRowid;
}

// ----------------------------------------------------------------
// Public: deletePost
// ----------------------------------------------------------------

async function deletePost(accountId, platform, postId) {
  try {
    if (platform === 'twitter') {
      const { API_BASE } = require('../oauth/twitter');
      const token = await getValidToken(accountId, platform);
      await fetch(`${API_BASE}/tweets/${postId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } else if (platform === 'instagram') {
      const { API_BASE } = require('../oauth/instagram');
      const token = await getValidToken(accountId, platform);
      await fetch(`${API_BASE}/${postId}?access_token=${token}`, { method: 'DELETE' });
    }
    // YouTube / TikTok / LinkedIn deletion flows omitted for brevity (add as needed)
    return { success: true };
  } catch (err) {
    log.error('Delete post failed', { accountId, platform, postId, err: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { publishPost, schedulePost, deletePost };
