'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');

const router = Router();

// GET /api/analytics — dashboard summary
router.get('/', (req, res) => {
  try {
    const db = getDb();

    // Key accounts by platform
    const accounts = db.prepare(`
      SELECT platform,
        COUNT(*)                                                AS total,
        SUM(CASE WHEN status='active'   THEN 1 ELSE 0 END)    AS active,
        SUM(CASE WHEN status='expired'  THEN 1 ELSE 0 END)    AS expired,
        SUM(CASE WHEN status='inactive' THEN 1 ELSE 0 END)    AS inactive
      FROM accounts GROUP BY platform
    `).all();

    // Traffic jobs summary
    const jobsByStatus = db.prepare(`
      SELECT status, COUNT(*) AS n FROM traffic_jobs GROUP BY status
    `).all().reduce((acc, r) => { acc[r.status] = r.n; return acc; }, {});

    // Traffic delivered today (by platform + action)
    const deliveredToday = db.prepare(`
      SELECT platform, action_type,
             SUM(completed_count) AS completed,
             SUM(target_count)    AS target
      FROM traffic_jobs
      WHERE date(created_at) = date('now')
      GROUP BY platform, action_type
    `).all();

    // Recent traffic log activity
    const recentActivity = db.prepare(`
      SELECT tl.id, tl.job_id, tl.platform, tl.action, tl.status, tl.message, tl.created_at
      FROM traffic_logs tl ORDER BY tl.created_at DESC LIMIT 20
    `).all();

    res.json({ accounts, jobs: jobsByStatus, deliveredToday, recentActivity });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
