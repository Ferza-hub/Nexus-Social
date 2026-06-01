'use strict';

const { Router } = require('express');
const { getDb }  = require('../../database/db');

const router = Router();

// GET /api/analytics — dashboard summary
router.get('/', (req, res) => {
  try {
    const db = getDb();

    // Ghost pool by platform
    const ghostPool = db.prepare(`
      SELECT platform,
        COUNT(*)                                              AS total,
        SUM(CASE WHEN status='ready'   THEN 1 ELSE 0 END)   AS ready,
        SUM(CASE WHEN status='cold'    THEN 1 ELSE 0 END)   AS cold,
        SUM(CASE WHEN status='warming' THEN 1 ELSE 0 END)   AS warming,
        SUM(CASE WHEN status='retired' THEN 1 ELSE 0 END)   AS retired,
        SUM(use_count)                                        AS total_uses
      FROM ghost_profiles GROUP BY platform
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

    // Recent ghost activity
    const recentActivity = db.prepare(`
      SELECT gl.ghost_id, gl.platform, gl.action, gl.status, gl.message, gl.created_at
      FROM ghost_logs gl ORDER BY gl.created_at DESC LIMIT 20
    `).all();

    res.json({ ghostPool, jobs: jobsByStatus, deliveredToday, recentActivity });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
