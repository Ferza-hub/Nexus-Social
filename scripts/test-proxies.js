'use strict';

/**
 * Test every residential proxy against YouTube.
 * Reports which ones work, marks dead ones inactive so warmup skips them.
 *
 * Usage:
 *   node scripts/test-proxies.js            -- test all, mark dead ones inactive
 *   node scripts/test-proxies.js --dry-run  -- test only, don't touch DB
 */

const { chromium } = require('playwright');
const path = require('path');

// Bootstrap the DB (same as the main app does)
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/nexus.db');
const { getDb }         = require('../src/database/db');
const { runMigrations } = require('../src/database/schema');

const DRY_RUN  = process.argv.includes('--dry-run');
const TIMEOUT  = 15_000;   // 15s per proxy — faster than warmup's 45s
const PARALLEL = 4;        // test 4 proxies simultaneously

async function testProxy(proxy) {
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (proxy.host) {
    launchOpts.proxy = {
      server:   `${proxy.protocol ?? 'http'}://${proxy.host}:${proxy.port}`,
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  }

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
    const ctx  = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await ctx.newPage();
    const t0   = Date.now();
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    const ms   = Date.now() - t0;
    // Check we actually landed on YouTube (not a proxy error page)
    const title = await page.title().catch(() => '');
    const ok    = /youtube/i.test(title);
    return ok ? { ok: true, ms } : { ok: false, err: `Bad title: "${title}"` };
  } catch (e) {
    return { ok: false, err: e.message.slice(0, 100) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  runMigrations(getDb());

  const proxies = getDb().prepare(
    `SELECT * FROM proxies WHERE proxy_type='residential' ORDER BY id`
  ).all();

  if (proxies.length === 0) {
    console.log('No residential proxies found. Add them in the panel first.');
    process.exit(0);
  }

  console.log(`\nTesting ${proxies.length} residential proxies against YouTube`);
  console.log(`Timeout: ${TIMEOUT / 1000}s per proxy | Parallel: ${PARALLEL}`);
  if (DRY_RUN) console.log('(dry-run — DB will NOT be modified)\n');
  else         console.log('(failed proxies will be marked inactive)\n');

  const results = [];
  // Process in parallel batches
  for (let i = 0; i < proxies.length; i += PARALLEL) {
    const batch = proxies.slice(i, i + PARALLEL);
    const batchResults = await Promise.all(batch.map(async p => {
      process.stdout.write(`  [${String(p.id).padStart(3)}] ${p.host}:${p.port} → `);
      const r = await testProxy(p);
      if (r.ok) {
        console.log(`\x1b[32m✓ ${r.ms}ms\x1b[0m`);
      } else {
        const isTimeout = /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(r.err);
        console.log(`\x1b[31m✗ ${r.err}\x1b[0m`);
        if (isTimeout && !DRY_RUN && p.status === 'active') {
          getDb().prepare(`UPDATE proxies SET status='inactive' WHERE id=?`).run(p.id);
          console.log(`       → marked inactive (can re-enable in panel)`);
        }
      }
      return { proxy: p, ...r };
    }));
    results.push(...batchResults);
  }

  const good = results.filter(r => r.ok);
  const bad  = results.filter(r => !r.ok);

  console.log('\n─────────────────────────────────────────');
  console.log(`Result: \x1b[32m${good.length} working\x1b[0m / \x1b[31m${bad.length} dead\x1b[0m out of ${proxies.length} proxies`);
  if (good.length > 0) {
    const avgMs = Math.round(good.reduce((s, r) => s + r.ms, 0) / good.length);
    console.log(`Avg latency (good): ${avgMs}ms`);
    console.log('Good proxies:', good.map(r => `${r.proxy.host}:${r.proxy.port}`).join(', '));
  }
  if (bad.length > 0 && !DRY_RUN) {
    console.log(`\n${bad.length} proxies marked inactive. Re-enable them in Panel → Proxies if needed.`);
  }
  console.log('─────────────────────────────────────────\n');

  // Warmup recommendation
  const readyGhosts = getDb().prepare(`SELECT COUNT(*) AS n FROM ghost_profiles WHERE status='ready'`).get().n;
  const coldGhosts  = getDb().prepare(`SELECT COUNT(*) AS n FROM ghost_profiles WHERE status='cold'`).get().n;
  if (coldGhosts > 0 && good.length > 0) {
    console.log(`Next: ${coldGhosts} cold ghosts + ${good.length} working proxies →`);
    console.log(`  pm2 restart nexus-social && then click "Warmup Cold" in the panel`);
  } else if (good.length === 0) {
    console.log('No working proxies found. Try different residential providers.');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
