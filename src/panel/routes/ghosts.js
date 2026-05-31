'use strict';

const { Router } = require('express');
const gm      = require('../../ghost/manager');
const warmer  = require('../../ghost/warmer');

const router = Router();

// GET /api/ghosts/stats
router.get('/stats', (req, res) => {
  try { res.json(gm.getStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ghosts
router.get('/', (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    res.json(gm.getGhosts({ status, limit: Number(limit) }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ghosts — create N ghosts
router.post('/', (req, res) => {
  try {
    const count = Math.min(Number(req.body.count ?? 10), 200);
    if (!count || count < 1) return res.status(400).json({ error: 'count must be ≥ 1' });
    const ids = gm.createGhosts(count);
    res.status(201).json({ created: ids.length, ids });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ghosts/warmup — warmup batch of cold ghosts (async)
router.post('/warmup', (req, res) => {
  try {
    const count = Math.min(Number(req.body.count ?? 5), 20);
    warmer.warmupBatch(count).catch(err =>
      console.error('[GhostWarmer] batch error:', err.message)
    );
    res.json({ ok: true, message: `Warming up to ${count} ghosts in background` });
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
