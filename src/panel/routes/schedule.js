'use strict';

const { Router } = require('express');
const { schedulePost, deletePost: apiDeletePost } = require('../../api-engine/actions/post');
const q = require('../../api-engine/scheduler/queue');

const router = Router();

// GET /api/schedule
router.get('/', (req, res) => {
  try {
    const { accountId, status } = req.query;
    const items = q.listQueue(accountId ? Number(accountId) : null, status || null);
    res.json(items.map(i => ({ ...i, content: JSON.parse(i.content_json), content_json: undefined })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedule
router.post('/', (req, res) => {
  try {
    const { accountId, platform, content, scheduledAt, campaignId } = req.body;
    if (!accountId || !platform || !content || !scheduledAt) {
      return res.status(400).json({ error: 'accountId, platform, content, scheduledAt required' });
    }
    const id = schedulePost(Number(accountId), platform, content, scheduledAt, campaignId ?? null);
    res.status(201).json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/schedule/:id
router.delete('/:id', (req, res) => {
  try {
    q.cancelPost(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
