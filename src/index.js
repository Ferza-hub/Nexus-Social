'use strict';

require('dotenv').config();
const { getDb, closeDb } = require('./database/db');
const { runMigrations } = require('./database/schema');
const { startMonitor } = require('./account-manager/health-monitor');
const { startRunner }  = require('./api-engine/scheduler/runner');
const { startPanel }   = require('./panel/server');
const { makeLogger }   = require('./utils/logger');

const log = makeLogger('Nexus');

function main() {
  log.info('Nexus Social starting...');

  const db = getDb();
  runMigrations(db);
  log.info('Database ready.');

  startMonitor();   // Phase 1.5 — health cron every 30min
  startRunner();    // Phase 3.3 — post queue + campaign runner
  startPanel();     // Phase 4   — web panel

  log.info('All systems up.');
}

process.on('SIGINT',  () => { log.info('Shutting down (SIGINT)');  closeDb(); process.exit(0); });
process.on('SIGTERM', () => { log.info('Shutting down (SIGTERM)'); closeDb(); process.exit(0); });

main();
