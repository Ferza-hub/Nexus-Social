'use strict';

const { Router } = require('express');
const gm      = require('../../ghost/manager');
const warmer  = require('../../ghost/warmer');

const router = Router();

// GET /api/ghosts/stats?platform=youtube|facebook
router.get('/stats', (req, res) => {
  try {
    const { platform } = req.query;
    res.json(gm.getStats(platform ?? null));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ghosts?status=ready&platform=youtube&limit=50
router.get('/', (req, res) => {
  try {
    const { status, platform, limit = 50 } = req.query;
    res.json(gm.getGhosts({ status, platform, limit: Number(limit) }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ghosts — create N YouTube (anonymous) ghosts
// Body: { count: 10 }
router.post('/', (req, res) => {
  try {
    const count = Math.min(Number(req.body.count ?? 10), 200);
    if (!count || count < 1) return res.status(400).json({ error: 'count must be ≥ 1' });
    const ids = gm.createGhosts(count, { platform: 'youtube' });
    res.status(201).json({ created: ids.length, ids, platform: 'youtube' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ghosts/facebook — seed Facebook ghosts from account credentials.
// Each credential becomes one ghost with its own browser fingerprint.
// Body: { credentials: [{ email, password }, ...] }
router.post('/facebook', (req, res) => {
  try {
    const { credentials } = req.body;
    if (!Array.isArray(credentials) || credentials.length === 0) {
      return res.status(400).json({ error: 'credentials must be a non-empty array of { email, password }' });
    }
    for (const c of credentials) {
      if (!c.email || !c.password) {
        return res.status(400).json({ error: 'each credential must have email and password' });
      }
    }
    const ids = gm.createGhosts(credentials.length, { platform: 'facebook', credentials });
    res.status(201).json({ created: ids.length, ids, platform: 'facebook' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ghosts/warmup — warmup cold ghosts (async, no cap)
// Body: { count: 0, platform: 'youtube' }  (count=0 → all cold of that platform)
router.post('/warmup', (req, res) => {
  try {
    const count    = Number(req.body.count ?? 0);
    const platform = req.body.platform ?? null;
    warmer.warmupBatch(count, platform).catch(err =>
      console.error('[GhostWarmer] batch error:', err.message)
    );
    const target = platform ? `${platform} ` : '';
    const msg    = count > 0
      ? `Warming up to ${count} cold ${target}ghosts in background`
      : `Warming up all cold ${target}ghosts in background`;
    res.json({ ok: true, message: msg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ghosts/:id/warmup — warmup single ghost
router.post('/:id/warmup', (req, res) => {
  try {
    const ghostId = Number(req.params.id);
    warmer.warmupGhost(ghostId).catch(err =>
      console.error('[GhostWarmer] single error:', err.message)
    );
    res.json({ ok: true, message: `Ghost ${ghostId} warming up in background` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/ghosts/:id
router.delete('/:id', (req, res) => {
  try {
    gm.deleteGhost(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/ghosts — delete all retired/cold ghosts
router.delete('/', (req, res) => {
  try {
    const { status = 'retired' } = req.query;
    const allowed = ['cold', 'retired'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Can only bulk-delete cold or retired ghosts' });
    const { changes } = require('../../database/db').getDb()
      .prepare(`DELETE FROM ghost_profiles WHERE status=?`).run(status);
    res.json({ deleted: changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
