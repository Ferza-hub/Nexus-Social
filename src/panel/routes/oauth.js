'use strict';

const { Router } = require('express');
const { getAuthUrl, handleCallback, loadToken, deleteToken } = require('../../api-engine/oauth/index');

const router = Router();

function callbackUri(req, platform) {
  const base = process.env.PANEL_URL || `http://localhost:${process.env.PORT || 3001}`;
  return `${base}/api/oauth/callback/${platform}`;
}

// GET /api/oauth/:platform/url?accountId=X
router.get('/:platform/url', (req, res) => {
  try {
    const { platform } = req.params;
    const { accountId }  = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const url = getAuthUrl(platform, Number(accountId), callbackUri(req, platform));
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/oauth/callback/:platform?code=X&state=X
router.get('/callback/:platform', async (req, res) => {
  const { platform } = req.params;
  const { code, state } = req.query;
  const accountId = parseInt(state?.split('_')[0] ?? '0');

  if (!code || !accountId) {
    return res.status(400).send('<h2>OAuth Error: missing code or state</h2>');
  }

  try {
    await handleCallback(platform, accountId, code, callbackUri(req, platform), { accountId });
    res.send(`<h2>✅ ${platform} connected!</h2><p>Account #${accountId} authorized. You can close this tab.</p>`);
  } catch (err) {
    res.status(500).send(`<h2>OAuth Error</h2><p>${err.message}</p>`);
  }
});

// GET /api/oauth/status/:platform?accountId=X
router.get('/status/:platform', (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const token = loadToken(Number(accountId), req.params.platform);
    res.json({
      connected:  !!token,
      expired:     token?.isExpired ?? null,
      expires_at:  token?.expires_at ?? null,
      scope:       token?.scope ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/oauth/:platform?accountId=X
router.delete('/:platform', (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    deleteToken(Number(accountId), req.params.platform);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
