'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');

const router = Router();

// GET /api/logs?platform=facebook&action=like_post&status=success&limit=100
router.get('/', (req, res) => {
  try {
    const { platform, action, status, limit = 100 } = req.query;
    const db   = getDb();
    const lim  = Math.min(Number(limit), 500);
    const cond = [];
    const args = [];

    if (platform) { cond.push('tl.platform=?'); args.push(platform); }
    if (action)   { cond.push('tl.action=?');   args.push(action);   }
    if (status)   { cond.push('tl.status=?');   args.push(status);   }

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT tl.id, tl.job_id, tl.platform, tl.action, tl.status, tl.message, tl.created_at
      FROM traffic_logs tl
      ${where}
      ORDER BY tl.created_at DESC LIMIT ?
    `).all(...args, lim);

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/logs/stream — SSE real-time tail of traffic_logs
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const db = getDb();
  let lastId = db.prepare('SELECT MAX(id) as id FROM traffic_logs').get()?.id ?? 0;

  const interval = setInterval(() => {
    try {
      const rows = db.prepare(
        'SELECT * FROM traffic_logs WHERE id > ? ORDER BY id ASC LIMIT 20'
      ).all(lastId);
      for (const row of rows) {
        res.write(`data: ${JSON.stringify(row)}\n\n`);
        lastId = row.id;
      }
    } catch (_) {}
  }, 2000);

  req.on('close', () => clearInterval(interval));
});

module.exports = router;
