'use strict';

const { Router } = require('express');
const { getDb } = require('../../database/db');
const { getAnalytics } = require('../../api-engine/actions/analytics');
const am = require('../../account-manager/index');

const router = Router();

// GET /api/analytics — dashboard summary
router.get('/', (req, res) => {
  try {
    const db = getDb();

    const totalAccounts   = db.prepare(`SELECT COUNT(*) as n FROM accounts`).get().n;
    const activeAccounts  = db.prepare(`SELECT COUNT(*) as n FROM accounts WHERE status='active'`).get().n;
    const warmingAccounts = db.prepare(`SELECT COUNT(*) as n FROM accounts WHERE status='warming'`).get().n;
    const flaggedAccounts = db.prepare(`SELECT COUNT(*) as n FROM accounts WHERE status IN ('flagged','recovery')`).get().n;

    const totalCampaigns   = db.prepare(`SELECT COUNT(*) as n FROM campaigns`).get().n;
    const runningCampaigns = db.prepare(`SELECT COUNT(*) as n FROM campaigns WHERE status='running'`).get().n;

    const totalPosts    = db.prepare(`SELECT COUNT(*) as n FROM post_queue`).get().n;
    const pendingPosts  = db.prepare(`SELECT COUNT(*) as n FROM post_queue WHERE status='pending'`).get().n;
    const publishedPosts = db.prepare(`SELECT COUNT(*) as n FROM post_queue WHERE status='done'`).get().n;

    const actionsToday = db.prepare(`
      SELECT action_type, SUM(day_count) as total
      FROM rate_limits
      WHERE day_reset_at > datetime('now')
      GROUP BY action_type
    `).all();

    const recentLogs = db.prepare(`
      SELECT hl.*, a.username FROM health_logs hl
      JOIN accounts a ON a.id = hl.account_id
      WHERE hl.event_type != 'ok'
      ORDER BY hl.created_at DESC LIMIT 10
    `).all();

    const campaignProgress = db.prepare(`
      SELECT id, name, type, status, completed_count, target_count, platform
      FROM campaigns WHERE status IN ('running','paused')
      ORDER BY updated_at DESC LIMIT 10
    `).all();

    res.json({
      accounts: { total: totalAccounts, active: activeAccounts, warming: warmingAccounts, flagged: flaggedAccounts },
      campaigns: { total: totalCampaigns, running: runningCampaigns },
      posts: { total: totalPosts, pending: pendingPosts, published: publishedPosts },
      actionsToday,
      recentAlerts: recentLogs,
      campaignProgress,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/account/:id — per-account API analytics
router.get('/account/:id', async (req, res) => {
  try {
    const acc = am.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    const result = await getAnalytics(acc.id, acc.platform);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
