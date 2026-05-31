'use strict';

const { Router } = require('express');
const am = require('../../account-manager/index');
const { logEvent, getAccountHealth, getAlerts } = require('../../account-manager/health-monitor');
const { getUsage } = require('../../account-manager/rate-limiter');
const { runMigrations } = require('../../database/schema');
const { getDb } = require('../../database/db');

const router = Router();

// GET /api/accounts
router.get('/', (req, res) => {
  try {
    const { platform, status } = req.query;
    const accounts = am.listAccounts(platform || null, status || null);
    // Attach warmup info
    const db = getDb();
    const enriched = accounts.map(acc => {
      const warmup = db.prepare(`SELECT * FROM warmup_schedules WHERE account_id=? AND platform=?`)
        .get(acc.id, acc.platform);
      const hasToken = db.prepare(`SELECT 1 FROM oauth_tokens WHERE account_id=? AND platform=?`)
        .get(acc.id, acc.platform);
      return {
        ...acc,
        password:     undefined, // never expose
        two_fa_secret: undefined,
        warmup:       warmup ?? null,
        api_connected: !!hasToken,
      };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts
router.post('/', (req, res) => {
  try {
    const { username, password, email, phone, platform, proxyId, twoFaSecret, notes, accountRole } = req.body;
    if (!username || !platform) {
      return res.status(400).json({ error: 'username and platform required' });
    }
    const id = am.addAccount({ username, password, email, phone, platform, proxyId, twoFaSecret, notes, accountRole });
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accounts/:id
router.delete('/:id', (req, res) => {
  try {
    getDb().prepare(`DELETE FROM accounts WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/health
router.get('/:id/health', (req, res) => {
  try {
    const acc = am.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const logs = getAccountHealth(acc.id, acc.platform, 50);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/usage
router.get('/:id/usage', (req, res) => {
  try {
    const acc = am.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const usage = getUsage(acc.id, acc.platform);
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/warmup/restart
router.post('/:id/warmup/restart', (req, res) => {
  try {
    const acc = am.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    am.warmup.restartWarmup(acc.id, acc.platform);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/alerts
router.get('/alerts/all', (req, res) => {
  try {
    res.json(getAlerts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/accounts/:id/role
router.patch('/:id/role', (req, res) => {
  try {
    const { role } = req.body;
    if (!['managed', 'traffic'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    getDb().prepare('UPDATE accounts SET account_role=?, updated_at=? WHERE id=?')
      .run(role, new Date().toISOString(), req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/bulk-traffic
router.post('/bulk-traffic', async (req, res) => {
  try {
    const { platform, lines } = req.body;
    if (!platform || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'platform and lines required' });
    }

    const results = [];
    for (const line of lines) {
      const [username, password] = line.split(':').map(s => s.trim());
      if (!username || !password) { results.push({ line, ok: false, error: 'invalid format' }); continue; }
      try {
        const id = am.addAccount({ username, password, platform, accountRole: 'traffic' });
        results.push({ line, ok: true, id });
      } catch (err) {
        results.push({ line, ok: false, error: err.message });
      }
    }
    res.json({ results, added: results.filter(r => r.ok).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
