'use strict';

const { getValidToken } = require('../oauth/index');
const { makeLogger } = require('../../utils/logger');

const log = makeLogger('ApiEngagement');

// ----------------------------------------------------------------
// replyComment — reply to a comment on a post
// ----------------------------------------------------------------

async function replyComment(accountId, platform, { commentId, message, postId }) {
  try {
    if (platform === 'instagram') {
      const { getIgBusinessAccountId, API_BASE } = require('../oauth/instagram');
      const token = await getValidToken(accountId, platform);
      const { igAccountId, pageToken } = await getIgBusinessAccountId(token);

      const res = await fetch(`${API_BASE}/${commentId}/replies`, {
        method: 'POST',
        body: new URLSearchParams({ message, access_token: pageToken }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return { success: true, replyId: data.id };
    }

    if (platform === 'twitter') {
      const { API_BASE } = require('../oauth/twitter');
      const token = await getValidToken(accountId, platform);

      const res = await fetch(`${API_BASE}/tweets`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          text: message,
          reply: { in_reply_to_tweet_id: commentId ?? postId },
        }),
      });
      const data = await res.json();
      if (data.errors) throw new Error(data.errors[0].message);
      return { success: true, replyId: data.data.id };
    }

    if (platform === 'youtube') {
      const token = await getValidToken(accountId, platform);
      const res = await fetch(
        'https://www.googleapis.com/youtube/v3/comments?part=snippet',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            snippet: {
              parentId:    commentId,
              textOriginal: message,
            },
          }),
        }
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return { success: true, replyId: data.id };
    }

    return { success: false, error: `replyComment not implemented for: ${platform}` };
  } catch (err) {
    log.error('replyComment failed', { accountId, platform, commentId, err: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { replyComment };
