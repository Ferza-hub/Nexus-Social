'use strict';

const { Router } = require('express');
const { getDb } = require('../../database/db');
const am = require('../../account-manager/index');

const router = Router();

// GET /api/proxies
router.get('/', (req, res) => {
  try {
    const proxies = getDb().prepare(`
      SELECT p.*, a.username as assigned_to
      FROM proxies p
      LEFT JOIN accounts a ON a.id = p.assigned_account_id
      ORDER BY p.created_at DESC
    `).all();
    res.json(proxies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxies — add single proxy
router.post('/', (req, res) => {
  try {
    const { host, port, username, password, protocol } = req.body;
    if (!host || !port) return res.status(400).json({ error: 'host and port required' });
    const id = am.addProxy({ host, port: Number(port), username, password, protocol });
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxies/bulk — import multiple proxies (host:port:user:pass format)
router.post('/bulk', (req, res) => {
  try {
    const { lines, protocol = 'http' } = req.body;
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be an array' });

    const inserted = [];
    const errors   = [];

    for (const line of lines) {
      const parts = String(line).trim().split(':');
      if (parts.length < 2) { errors.push(`Invalid line: ${line}`); continue; }
      const [host, port, username, password] = parts;
      if (!host || !port || isNaN(Number(port))) { errors.push(`Invalid: ${line}`); continue; }
      try {
        const id = am.addProxy({ host, port: Number(port), username, password, protocol });
        inserted.push(id);
      } catch (e) {
        errors.push(`${line}: ${e.message}`);
      }
    }

    res.json({ inserted: inserted.length, ids: inserted, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/proxies/:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['active', 'inactive', 'banned'];
    if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
    getDb().prepare(`UPDATE proxies SET status=? WHERE id=?`).run(status, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxies/:id/assign/:accountId
router.post('/:id/assign/:accountId', (req, res) => {
  try {
    am.assignProxy(Number(req.params.accountId), Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/proxies/:id
router.delete('/:id', (req, res) => {
  try {
    getDb().prepare(`DELETE FROM proxies WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
