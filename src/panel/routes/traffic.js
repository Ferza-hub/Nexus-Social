'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');
const { runJob, stopJob, isRunning, TRAFFIC_ACTIONS } = require('../../traffic/runner');

const router = Router();

// GET /api/traffic — list recent jobs
router.get('/', (req, res) => {
  try {
    const jobs = getDb().prepare(
      'SELECT * FROM traffic_jobs ORDER BY created_at DESC LIMIT 100'
    ).all();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/traffic/accounts?platform=instagram
router.get('/accounts', (req, res) => {
  try {
    const { platform } = req.query;
    if (!platform) return res.status(400).json({ error: 'platform required' });
    const row = getDb().prepare(
      "SELECT COUNT(*) AS n FROM accounts WHERE platform=? AND status='active' AND account_role='traffic'"
    ).get(platform);
    res.json({ platform, count: row?.n ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/traffic — create and start a traffic job
router.post('/', async (req, res) => {
  try {
    const { platform, action_type, target_value, count = 10 } = req.body;

    if (!platform || !action_type || !target_value) {
      return res.status(400).json({ error: 'platform, action_type, target_value required' });
    }

    const actionDef = TRAFFIC_ACTIONS[platform]?.[action_type];
    if (!actionDef) {
      return res.status(400).json({ error: `"${action_type}" is not supported for ${platform}` });
    }

    const db = getDb();
    const n  = Number(count);
    if (!n || n < 1) return res.status(400).json({ error: 'count must be ≥ 1' });

    // Account check only needed for non-anonymous actions
    let avail = 0;
    if (!actionDef.canAnon) {
      avail = db.prepare(
        "SELECT COUNT(*) AS n FROM accounts WHERE platform=? AND status='active' AND account_role='traffic'"
      ).get(platform)?.n ?? 0;

      if (avail === 0) {
        return res.status(400).json({
          error: `No active ${platform} accounts. Connect accounts first.`,
        });
      }
    }

    const result = db.prepare(`
      INSERT INTO traffic_jobs (platform, action_type, target_value, target_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(platform, action_type, target_value.trim(), n,
           new Date().toISOString(), new Date().toISOString());

    const jobId = result.lastInsertRowid;

    // Fire and forget — runJob updates the DB on its own
    runJob(Number(jobId)).catch(err => {
      console.error('[TrafficRunner] unhandled:', err.message);
    });

    res.json({ id: jobId, accounts_available: avail, anonymous: actionDef.canAnon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/traffic/:id — status + recent logs
router.get('/:id', (req, res) => {
  try {
    const db  = getDb();
    const job = db.prepare('SELECT * FROM traffic_jobs WHERE id=?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const logs = db.prepare(`
      SELECT tl.*, a.username
      FROM traffic_logs tl
      LEFT JOIN accounts a ON a.id = tl.account_id
      WHERE tl.job_id = ?
      ORDER BY tl.created_at DESC
      LIMIT 30
    `).all(req.params.id);

    res.json({ ...job, is_running: isRunning(Number(req.params.id)), recent_logs: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/traffic/:id/stop
router.post('/:id/stop', (req, res) => {
  try {
    stopJob(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
