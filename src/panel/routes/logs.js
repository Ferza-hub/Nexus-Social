'use strict';

const { Router } = require('express');
const { getDb } = require('../../database/db');

const router = Router();

// GET /api/logs — unified activity feed (health + campaign)
router.get('/', (req, res) => {
  try {
    const { type, platform, limit = 100 } = req.query;
    const db = getDb();
    const lim = Math.min(Number(limit), 500);

    if (!type || type === 'health') {
      let q = `
        SELECT 'health' as source, hl.id, hl.account_id, a.username, hl.platform,
               hl.event_type as action, hl.message, hl.created_at
        FROM health_logs hl JOIN accounts a ON a.id = hl.account_id WHERE 1=1
      `;
      const p = [];
      if (platform) { q += ` AND hl.platform=?`; p.push(platform); }
      q += ` ORDER BY hl.created_at DESC LIMIT ?`; p.push(lim);
      return res.json(db.prepare(q).all(...p));
    }

    if (type === 'campaign') {
      let q = `
        SELECT 'campaign' as source, cl.id, cl.campaign_id, c.name as campaign_name,
               cl.account_id, cl.action, cl.status, cl.message, cl.created_at
        FROM campaign_logs cl JOIN campaigns c ON c.id = cl.campaign_id WHERE 1=1
      `;
      const p = [];
      if (platform) { q += ` AND c.platform=?`; p.push(platform); }
      q += ` ORDER BY cl.created_at DESC LIMIT ?`; p.push(lim);
      return res.json(db.prepare(q).all(...p));
    }

    // Combined
    const health = db.prepare(`
      SELECT 'health' as source, hl.id, hl.account_id, a.username, hl.platform,
             hl.event_type as action, '' as status, hl.message, hl.created_at
      FROM health_logs hl JOIN accounts a ON a.id = hl.account_id
      ORDER BY hl.created_at DESC LIMIT ?
    `).all(Math.floor(lim / 2));

    const campaigns = db.prepare(`
      SELECT 'campaign' as source, cl.id, cl.account_id, '' as username, c.platform,
             cl.action, cl.status, cl.message, cl.created_at
      FROM campaign_logs cl JOIN campaigns c ON c.id = cl.campaign_id
      ORDER BY cl.created_at DESC LIMIT ?
    `).all(Math.floor(lim / 2));

    const combined = [...health, ...campaigns].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    ).slice(0, lim);

    res.json(combined);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stream — Server-Sent Events for real-time log tail
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const db = getDb();
  let lastId = db.prepare(`SELECT MAX(id) as id FROM health_logs`).get()?.id ?? 0;

  const interval = setInterval(() => {
    try {
      const rows = db.prepare(`
        SELECT hl.*, a.username FROM health_logs hl
        JOIN accounts a ON a.id = hl.account_id
        WHERE hl.id > ? ORDER BY hl.id ASC LIMIT 20
      `).all(lastId);

      for (const row of rows) {
        res.write(`data: ${JSON.stringify(row)}\n\n`);
        lastId = row.id;
      }
    } catch (_) {}
  }, 2000);

  req.on('close', () => clearInterval(interval));
});

module.exports = router;
