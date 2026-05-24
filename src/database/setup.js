'use strict';

require('dotenv').config();
const { getDb, closeDb } = require('./db');
const { runMigrations } = require('./schema');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('Setup');

function setup() {
  const db = getDb();
  log.info('Running schema migrations...');
  runMigrations(db);
  log.info('Schema ready.');
  closeDb();
}

setup();
