'use strict';

const { Router } = require('express');
const { setSpeedMode, isSpeedMode } = require('../../playwright-engine/human');

const router = Router();

// GET /api/settings
router.get('/', (req, res) => {
  res.json({
    speed_mode: isSpeedMode(),
  });
});

// POST /api/settings
router.post('/', (req, res) => {
  const { speed_mode } = req.body;
  if (speed_mode !== undefined) {
    setSpeedMode(speed_mode);
  }
  res.json({ speed_mode: isSpeedMode() });
});

module.exports = router;
