'use strict';

const { Router } = require('express');
const am = require('../../account-manager/index');
const { logEvent, getAccountHealth, getAlerts } = require('../../account-manager/health-monitor');
const { loginAndSaveSession } = require('../../playwright-engine/index');
const { hasActiveSession } = require('../../account-manager/session-manager');
const { hasActiveSession } = require('../../account-manager/session-manager');
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
        password:       undefined, // never expose
        two_fa_secret:  undefined,
        warmup:         warmup ?? null,
        api_connected:  !!hasToken,
        session_active: hasActiveSession(acc.id, acc.platform),
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
    const { username, password, email, phone, platform, proxyId, twoFaSecret, notes, skipWarmup } = req.body;
    if (!username || !password || !platform) {
      return res.status(400).json({ error: 'username, password, platform required' });
    }
    const exists = getDb().prepare(`SELECT id FROM accounts WHERE username = ? AND platform = ?`).get(username, platform);
    if (exists) {
      return res.status(409).json({ error: `@${username} on ${platform} already exists (id: ${exists.id})` });
    }
    const id = am.addAccount({ username, password, email, phone, platform, proxyId, twoFaSecret, notes, skipWarmup: !!skipWarmup });
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounts/:id/connect — trigger Playwright login + save session
router.post('/:id/connect', async (req, res) => {
  try {
    const acc = am.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    if (acc.status === 'disabled') return res.status(400).json({ error: 'Account is disabled' });

    const result = await loginAndSaveSession(acc.id, acc.platform);
    if (!result.success) {
      return res.status(400).json({ error: result.event ?? result.reason ?? 'Login failed' });
    }

    res.json({ ok: true, session_active: hasActiveSession(acc.id, acc.platform) });
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

module.exports = router;
