'use strict';

const { executeGhostView, executeGhostAction } = require('../playwright-engine/index');
const { getDb }      = require('../database/db');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('TrafficRunner');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BROWSERS ?? '4', 10);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ----------------------------------------------------------------
// Action definitions — all traffic goes through the ghost pool.
//
// type 'view'   → executeGhostView(ghostPlatform, targetValue)
//   Ghost is matched by platform (anonymous for youtube, authenticated
//   for all others).
//
// type 'action' → executeGhostAction(ghostPlatform, action, params)
//   Ghost must have credentials_json (authenticated session).
//   buildParams maps the raw target_value string to the right param key.
// ----------------------------------------------------------------

const TRAFFIC_ACTIONS = {
  youtube: {
    views:     { type: 'view',   ghostPlatform: 'youtube' },
  },
  facebook: {
    views:     { type: 'view',   ghostPlatform: 'facebook' },
    likes:     { type: 'action', ghostPlatform: 'facebook', action: 'like_post',   buildParams: v => ({ postUrl: v })    },
    followers: { type: 'action', ghostPlatform: 'facebook', action: 'follow_page', buildParams: v => ({ profileUrl: v }) },
  },
  instagram: {
    views:     { type: 'action', ghostPlatform: 'instagram', action: 'watch_reel', buildParams: v => ({ reelUrl: v })   },
    likes:     { type: 'action', ghostPlatform: 'instagram', action: 'like_post',  buildParams: v => ({ postUrl: v })   },
    followers: { type: 'action', ghostPlatform: 'instagram', action: 'follow',     buildParams: v => ({ username: v })  },
  },
  tiktok: {
    views:     { type: 'action', ghostPlatform: 'tiktok', action: 'watch_video',  buildParams: v => ({ videoUrl: v })  },
    likes:     { type: 'action', ghostPlatform: 'tiktok', action: 'like_video',   buildParams: v => ({ videoUrl: v })  },
    followers: { type: 'action', ghostPlatform: 'tiktok', action: 'follow',       buildParams: v => ({ username: v })  },
  },
  twitter: {
    likes:     { type: 'action', ghostPlatform: 'twitter', action: 'like_post',   buildParams: v => ({ tweetUrl: v })  },
    followers: { type: 'action', ghostPlatform: 'twitter', action: 'follow',      buildParams: v => ({ username: v })  },
  },
  threads: {
    likes:     { type: 'action', ghostPlatform: 'threads', action: 'like_post',   buildParams: v => ({ postUrl: v })   },
    followers: { type: 'action', ghostPlatform: 'threads', action: 'follow',      buildParams: v => ({ username: v })  },
  },
};

// In-memory stop signals keyed by job id
const _active = new Map();

// ----------------------------------------------------------------
// Main runner — called async, does not block server
// ----------------------------------------------------------------

async function runJob(jobId) {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM traffic_jobs WHERE id=?').get(jobId);
  if (!job) return;

  const actionDef = TRAFFIC_ACTIONS[job.platform]?.[job.action_type];
  if (!actionDef) {
    db.prepare(`UPDATE traffic_jobs SET status='failed', updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), jobId);
    return;
  }

  db.prepare(`UPDATE traffic_jobs SET status='running', started_at=?, updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), new Date().toISOString(), jobId);

  _active.set(jobId, true);

  let done   = 0;
  let streak = 0; // consecutive non-success results

  const logEntry = (status, message) => {
    try {
      db.prepare(
        `INSERT INTO traffic_logs (job_id, account_id, platform, action, status, message, created_at)
         VALUES (?,0,?,?,?,?,?)`
      ).run(jobId, job.platform, job.action_type, status, message ?? null, new Date().toISOString());
    } catch (_) {}
  };

  const worker = async () => {
    while (_active.has(jobId) && done < job.target_count) {
      if (streak >= 10) break;

      let result;
      try {
        if (actionDef.type === 'view') {
          result = await executeGhostView(actionDef.ghostPlatform, job.target_value);
        } else {
          const params = actionDef.buildParams(job.target_value);
          result = await executeGhostAction(actionDef.ghostPlatform, actionDef.action, params);
        }
      } catch (err) {
        result = { success: false, reason: err.message };
      }

      if (result.success) {
        done++;
        streak = 0;
        db.prepare('UPDATE traffic_jobs SET completed_count=?, updated_at=? WHERE id=?')
          .run(done, new Date().toISOString(), jobId);
        logEntry('success', null);
        log.debug('Action done', { jobId, done, target: job.target_count });
      } else if (result.reason === 'no_ghost_available') {
        logEntry('skipped', 'no_ghost_available');
        await delay(randInt(10_000, 20_000)); // wait for a ghost to become available
      } else {
        streak++;
        logEntry('failed', result.reason ?? result.error ?? null);
        log.debug('Action failed', { jobId, streak, reason: result.reason });
      }

      if (_active.has(jobId) && done < job.target_count) {
        await delay(randInt(500, 2000));
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
  } catch (err) {
    log.error('Worker threw', { jobId, err: err.message });
  }

  if (_active.has(jobId)) {
    const status = done >= job.target_count ? 'completed' : (streak >= 10 ? 'failed' : 'paused');
    db.prepare(`UPDATE traffic_jobs SET status=?, completed_at=?, updated_at=? WHERE id=?`)
      .run(status, new Date().toISOString(), new Date().toISOString(), jobId);
    _active.delete(jobId);
  } else {
    // Stopped externally
    db.prepare(`UPDATE traffic_jobs SET status='paused', updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), jobId);
  }

  log.info('Job finished', { jobId, done, target: job.target_count });
}

function stopJob(jobId) {
  _active.delete(jobId);
}

function isRunning(jobId) {
  return _active.has(jobId);
}

module.exports = { runJob, stopJob, isRunning, TRAFFIC_ACTIONS };
