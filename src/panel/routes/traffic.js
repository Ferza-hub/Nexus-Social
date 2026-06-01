'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');
const { runJob, stopJob, isRunning, TRAFFIC_ACTIONS } = require('../../traffic/runner');

const router = Router();

// GET /api/traffic — list recent jobs
router.get('/', (req, res) => {
  try {
    res.json(getDb().prepare('SELECT * FROM traffic_jobs ORDER BY created_at DESC LIMIT 100').all());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/traffic/actions — supported platform/action combinations
router.get('/actions', (_req, res) => {
  const out = {};
  for (const [platform, actions] of Object.entries(TRAFFIC_ACTIONS)) {
    out[platform] = Object.keys(actions);
  }
  res.json(out);
});

// POST /api/traffic — create and start a traffic job
// Body: { platform, action_type, target_value, count }
router.post('/', async (req, res) => {
  try {
    const { platform, action_type, target_value, count = 10 } = req.body;

    if (!platform || !action_type || !target_value) {
      return res.status(400).json({ error: 'platform, action_type, target_value required' });
    }

    if (!TRAFFIC_ACTIONS[platform]?.[action_type]) {
      return res.status(400).json({ error: `"${action_type}" not supported for ${platform}` });
    }

    const n = Number(count);
    if (!n || n < 1) return res.status(400).json({ error: 'count must be ≥ 1' });

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO traffic_jobs (platform, action_type, target_value, target_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(platform, action_type, target_value.trim(), n,
           new Date().toISOString(), new Date().toISOString());

    const jobId = Number(result.lastInsertRowid);
    runJob(jobId).catch(err => console.error('[TrafficRunner] unhandled:', err.message));

    res.json({ id: jobId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/traffic/:id — status + recent logs
router.get('/:id', (req, res) => {
  try {
    const db  = getDb();
    const job = db.prepare('SELECT * FROM traffic_jobs WHERE id=?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const logs = db.prepare(
      'SELECT * FROM traffic_logs WHERE job_id=? ORDER BY created_at DESC LIMIT 30'
    ).all(req.params.id);

    res.json({ ...job, is_running: isRunning(Number(req.params.id)), recent_logs: logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/traffic/:id/stop
router.post('/:id/stop', (req, res) => {
  try {
    stopJob(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/traffic/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    stopJob(Number(req.params.id));
    db.prepare('DELETE FROM traffic_logs WHERE job_id=?').run(req.params.id);
    db.prepare('DELETE FROM traffic_jobs WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
