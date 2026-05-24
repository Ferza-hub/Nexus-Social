'use strict';

const crypto = require('crypto');

const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'nexus2024';
const _tokens = new Set();

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

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function loginHandler(req, res) {
  const { password } = req.body;
  if (password !== PANEL_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ token: generateToken() });
}

module.exports = { requireAuth, loginHandler, revokeToken, validateToken };
