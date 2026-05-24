'use strict';

const { Router } = require('express');
const q = require('../../api-engine/scheduler/queue');

const router = Router();

// GET /api/campaigns
router.get('/', (req, res) => {
  try {
    const campaigns = q.listCampaigns(req.query.status || null);
    res.json(campaigns.map(c => ({
      ...c,
      config: JSON.parse(c.config_json ?? '{}'),
      config_json: undefined,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns
router.post('/', (req, res) => {
  try {
    const { name, accountId, platform, type, config, targetCount } = req.body;
    if (!name || !accountId || !platform || !type) {
      return res.status(400).json({ error: 'name, accountId, platform, type required' });
    }
    const valid = ['growth', 'content', 'hybrid'];
    if (!valid.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${valid.join(', ')}` });
    }
    const id = q.createCampaign({ name, accountId, platform, type, config, targetCount });
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['draft', 'running', 'paused', 'completed', 'failed'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
    }
    q.setCampaignStatus(Number(req.params.id), status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', (req, res) => {
  try {
    const { getDb } = require('../../database/db');
    getDb().prepare(`DELETE FROM campaigns WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/logs
router.get('/:id/logs', (req, res) => {
  try {
    const logs = q.getCampaignLogs(Number(req.params.id), 200);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', (req, res) => {
  try {
    const campaign = q.getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ ...campaign, config: JSON.parse(campaign.config_json ?? '{}'), config_json: undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
