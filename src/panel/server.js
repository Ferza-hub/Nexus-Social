'use strict';

require('dotenv').config();
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');

const { requireAuth, loginHandler, changePasswordHandler } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../../public')));

// Auth
app.post('/api/auth/login', loginHandler);
app.post('/api/auth/change-password', requireAuth, changePasswordHandler);

// All API routes require auth
app.use('/api/analytics', requireAuth, require('./routes/analytics'));
app.use('/api/proxies',   requireAuth, require('./routes/proxies'));
app.use('/api/settings',  requireAuth, require('./routes/settings'));
app.use('/api/traffic',   requireAuth, require('./routes/traffic'));
app.use('/api/accounts',  requireAuth, require('./routes/accounts'));
app.use('/api/logs',      requireAuth, require('./routes/logs'));

// SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../../public/index.html')));

function startPanel() {
  app.listen(PORT, () => {
    console.log(`[Panel] Running on http://localhost:${PORT}`);
  });
}

module.exports = { startPanel };
