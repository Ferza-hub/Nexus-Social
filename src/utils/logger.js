'use strict';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(level, context, message, meta) {
  if (LOG_LEVELS[level] > currentLevel) return;
  const prefix = `[${timestamp()}] [${level.toUpperCase()}] [${context}]`;
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`${prefix} ${message}${metaStr}`);
}

function makeLogger(context) {
  return {
    error: (msg, meta) => log('error', context, msg, meta),
    warn:  (msg, meta) => log('warn',  context, msg, meta),
    info:  (msg, meta) => log('info',  context, msg, meta),
    debug: (msg, meta) => log('debug', context, msg, meta),
  };
}

module.exports = { makeLogger };
