'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');

const router = Router();

// GET /api/proxies?type=residential|dedicated
router.get('/', (req, res) => {
  try {
    const { type } = req.query;
    const typeFilter = type ? `AND proxy_type=?` : '';
    const args = type ? [type] : [];
    const rows = getDb().prepare(`
      SELECT * FROM proxies WHERE 1=1 ${typeFilter} ORDER BY created_at DESC
    `).all(...args);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/proxies/residential/count
router.get('/residential/count', (req, res) => {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active
      FROM proxies WHERE proxy_type='residential'
    `).get();
    res.json({ total: row?.total ?? 0, active: row?.active ?? 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/proxies — add single proxy
// Body: { host, port, username, password, protocol, proxy_type, geo_region }
router.post('/', (req, res) => {
  try {
    const { host, port, username, password, protocol = 'http', proxy_type = 'residential', geo_region } = req.body;
    if (!host || !port) return res.status(400).json({ error: 'host and port required' });
    const db     = getDb();
    const result = db.prepare(`
      INSERT INTO proxies (host, port, username, password, protocol, proxy_type, geo_region)
      VALUES (?,?,?,?,?,?,?)
    `).run(host, Number(port), username ?? null, password ?? null, protocol, proxy_type, geo_region ?? null);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/proxies/bulk — import from host:port:user:pass lines
// Body: { lines: [...], protocol, proxy_type, geo_region }
router.post('/bulk', (req, res) => {
  try {
    const { lines, protocol = 'http', proxy_type = 'residential', geo_region } = req.body;
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be an array' });

    const db       = getDb();
    const inserted = [];
    const errors   = [];

    const stmt = db.prepare(`
      INSERT INTO proxies (host, port, username, password, protocol, proxy_type, geo_region)
      VALUES (?,?,?,?,?,?,?)
    `);

    for (const line of lines) {
      const parts = String(line).trim().split(':');
      if (parts.length < 2) { errors.push(`Invalid: ${line}`); continue; }
      const [host, rawPort, username, password] = parts;
      if (!host || isNaN(Number(rawPort))) { errors.push(`Invalid: ${line}`); continue; }
      try {
        const r = stmt.run(host, Number(rawPort), username ?? null, password ?? null,
                           protocol, proxy_type, geo_region ?? null);
        inserted.push(Number(r.lastInsertRowid));
      } catch (e) {
        errors.push(`${line}: ${e.message}`);
      }
    }

    res.json({ inserted: inserted.length, ids: inserted, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/proxies/:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive', 'banned'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|inactive|banned' });
    }
    getDb().prepare('UPDATE proxies SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/proxies/:id
router.delete('/:id', (req, res) => {
  try {
    getDb().prepare('DELETE FROM proxies WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
