'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('DB');

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'nexus.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  log.info(`Connected to ${DB_PATH}`);
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
    log.info('Connection closed');
  }
}

module.exports = { getDb, closeDb };
