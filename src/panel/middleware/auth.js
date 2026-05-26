'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

let _password = process.env.PANEL_PASSWORD || 'nexus2024';
const _tokens  = new Set();

function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  _tokens.add(token);
  return token;
}

function validateToken(token) {
  return token && _tokens.has(token);
}

function revokeToken(token) {
  _tokens.delete(token);
}

function revokeAllTokens() {
  _tokens.clear();
}

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function loginHandler(req, res) {
  const { password } = req.body;
  if (password !== _password) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ token: generateToken() });
}

function changePasswordHandler(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (currentPassword !== _password) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  _password = newPassword;

  // Persist to .env so password survives restart
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    let content = fs.readFileSync(envPath, 'utf8');
    if (/^PANEL_PASSWORD=.*/m.test(content)) {
      content = content.replace(/^PANEL_PASSWORD=.*/m, `PANEL_PASSWORD=${newPassword}`);
    } else {
      content += `\nPANEL_PASSWORD=${newPassword}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (_) {
    // .env not writable — password updated in memory only until restart
  }

  // Revoke all sessions — client must re-login with new password
  revokeAllTokens();

  res.json({ ok: true });
}

module.exports = { requireAuth, loginHandler, changePasswordHandler, revokeToken, validateToken };
