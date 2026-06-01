'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');

const router = Router();

// GET /api/logs?platform=facebook&action=warmup&status=success&limit=100
router.get('/', (req, res) => {
  try {
    const { platform, action, status, limit = 100 } = req.query;
    const db   = getDb();
    const lim  = Math.min(Number(limit), 500);
    const cond = [];
    const args = [];

    if (platform) { cond.push('gl.platform=?'); args.push(platform); }
    if (action)   { cond.push('gl.action=?');   args.push(action);   }
    if (status)   { cond.push('gl.status=?');   args.push(status);   }

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT gl.id, gl.ghost_id, gp.platform AS ghost_platform, gl.platform,
             gl.action, gl.status, gl.message, gl.created_at
      FROM ghost_logs gl
      JOIN ghost_profiles gp ON gp.id = gl.ghost_id
      ${where}
      ORDER BY gl.created_at DESC LIMIT ?
    `).all(...args, lim);

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/logs/stream — SSE real-time tail of ghost_logs
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const db = getDb();
  let lastId = db.prepare('SELECT MAX(id) as id FROM ghost_logs').get()?.id ?? 0;

  const interval = setInterval(() => {
    try {
      const rows = db.prepare(
        'SELECT * FROM ghost_logs WHERE id > ? ORDER BY id ASC LIMIT 20'
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
