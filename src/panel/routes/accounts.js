'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');

const router = Router();

// GET /api/accounts?platform=facebook
router.get('/', (req, res) => {
  try {
    const { platform } = req.query;
    const db = getDb();
    const rows = platform
      ? db.prepare(`SELECT id, platform, email, status, storage_state_path, created_at, last_used_at
                    FROM accounts WHERE platform=? ORDER BY created_at DESC`).all(platform)
      : db.prepare(`SELECT id, platform, email, status, storage_state_path, created_at, last_used_at
                    FROM accounts ORDER BY platform, created_at DESC`).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts — add key account
// Body: { platform, email, password }
router.post('/', (req, res) => {
  try {
    const { platform, email, password } = req.body;
    if (!platform || !email || !password) {
      return res.status(400).json({ error: 'platform, email and password required' });
    }
    const result = getDb().prepare(
      `INSERT INTO accounts (platform, email, password) VALUES (?,?,?)`
    ).run(platform, email, password);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/bulk — add multiple accounts
// Body: { platform, accounts: [{ email, password }, ...] }
router.post('/bulk', (req, res) => {
  try {
    const { platform, accounts } = req.body;
    if (!platform || !Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ error: 'platform and accounts array required' });
    }
    const db   = getDb();
    const stmt = db.prepare(`INSERT INTO accounts (platform, email, password) VALUES (?,?,?)`);
    const inserted = [];
    const errors   = [];
    for (const a of accounts) {
      if (!a.email || !a.password) { errors.push(`Missing email/password: ${JSON.stringify(a)}`); continue; }
      try {
        const r = stmt.run(platform, a.email, a.password);
        inserted.push(Number(r.lastInsertRowid));
      } catch (e) { errors.push(`${a.email}: ${e.message}`); }
    }
    res.json({ inserted: inserted.length, ids: inserted, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/accounts/:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'status must be active|inactive|expired' });
    }
    getDb().prepare('UPDATE accounts SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounts/:id
router.delete('/:id', (req, res) => {
  try {
    getDb().prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
