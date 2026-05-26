# Nexus Social

## Project

Nexus Social is a self-hosted social media automation platform. It solves the problem of managing multiple social accounts across multiple platforms — handling browser sessions, warmup schedules, rate limits, detection avoidance, and content scheduling from a single dark-themed web panel. All engagement actions (likes, follows, comments, scrolling) run through Playwright (stealth Chromium). The API engine handles OAuth-gated operations only (publishing, analytics) and is never used as a substitute for Playwright login.

**Stack:** Node.js >= 18, Playwright 1.44 (Chromium), SQLite via better-sqlite3 (WAL mode), Express 4, node-cron, https-proxy-agent, PM2.

---

## Platforms & Actions

Every entry in `ACTION_MAP` (`src/playwright-engine/index.js`):

| Platform | Actions | Notes |
|---|---|---|
| **instagram** | `login`, `scroll_feed`, `watch_story`, `like_post`, `follow`, `unfollow`, `comment`, `watch_reel`, `dm`, `post_reel`, `post_story` | TOTP 2FA built-in. File-chooser upload for reels/stories. |
| **tiktok** | `login`, `watch_video`, `like_video`, `follow`, `comment`, `scroll_fyp` | `watch_video` maps to `watch_reel` rate type. |
| **twitter** | `login`, `scroll_feed`, `like_post`, `follow`, `unfollow`, `reply_tweet` | Multi-step login with optional phone/email challenge. `reply_tweet` maps to `comment` rate type. |
| **youtube** | `login`, `scroll_feed`, `watch_video`, `like_video`, `subscribe`, `comment`, `share` | Google OAuth login with TOTP. `subscribe` maps to `follow` rate type. `share` has no rate type. |
| **threads** | `login`, `scroll_feed`, `like_post`, `follow`, `unfollow`, `comment` | Uses Instagram credentials + TOTP. Profile URLs: `threads.net/@username`. |
| **facebook** | `login`, `scroll_feed`, `like_post`, `follow`, `comment`, `watch_reel`, `like_reel`, `share` | Cookie consent handling. `follow` covers both Pages (Follow) and profiles (Add Friend). `share` and `like_reel` have no rate type. |

**Rate-counted action types** (shared across platforms): `like`, `follow`, `unfollow`, `comment`, `story_view`, `watch_reel`, `dm`.

Actions with `rateType: null` — `login`, `scroll_feed`, `scroll_fyp`, `post_reel`, `post_story`, `share` — skip rate-limit checks but still respect account status.

---

## How It Works

1. **Add account** — `POST /api/accounts` inserts a record. Without `skipWarmup`, `initWarmup()` runs immediately and status becomes `warming`. With `skipWarmup: true`, status starts as `active` with no warmup record.
2. **Connect session** — clicking Connect in the panel calls `POST /api/accounts/:id/connect`, which runs `executeAction(id, platform, 'login')` via Playwright and saves the resulting `storageState` to disk and the `sessions` table.
3. **Create campaign** — campaign record written to `campaigns` table; the cron runner dispatches actions every 30 seconds.
4. **Engine executes** — `executeAction()` runs a 6-step flow: gate check → concurrency check → launch Chromium with stored proxy and session → verify login state (auto-re-login if expired) → call platform function → record action and persist fresh session.
5. **Guards** — `canAct()` enforces account status, a 2-hour `action_block` cooldown, warmup phase caps, and hourly/daily rate limits before any action runs. The health monitor (cron every 30 min) logs detection events and flags accounts automatically.

---

## Account Lifecycle

Status transitions:

```
new → warming → active → flagged → recovery → active
                       ↘ disabled
```

| Status | Meaning |
|---|---|
| `new` | Created; warmup not yet initialized |
| `warming` | Progressing through warmup phases; reduced action caps apply |
| `active` | Full automation; normal rate limits apply |
| `flagged` | Paused — challenge, captcha, or session expiry detected |
| `recovery` | Post-flagged recovery window |
| `disabled` | Permanently disabled by platform; all actions blocked |

**Warmup phases** (from `PHASES` in `warmup-scheduler.js`):

| Day range | Phase | Likes/day | Follows/day | Comments/day |
|---|---|---|---|---|
| 1 – 3 | `login_only` | 0 | 0 | 0 |
| 4 – 7 | `light` | 15 | 10 | 0 |
| 8 – 14 | `medium` | 50 | 50 | 5 |
| 15+ | `full` | normal quota | normal quota | normal quota |

`runDailyAdvancement()` is called by cron once per day. At day 15 the account graduates: `warmup_schedules.completed = 1` and `accounts.status = 'active'`.

`restartWarmup()` rolls back `current_day` by 7 (`max(1, current_day - 7)`) and re-enters `warming` status.

**Rate limit defaults (per account, per platform):**

| Action | Max/hour | Max/day |
|---|---|---|
| `follow` / `unfollow` | 20 | 150 |
| `like` | 50 | 300 |
| `comment` | 15 | 100 |
| `story_view` | — | 500 |
| `dm` | — | 50 |
| `watch_reel` | — | 500 |

---

## Speed Mode

Speed mode is a global in-process flag (`_speedMode` in `src/playwright-engine/human.js`), toggled at runtime via `POST /api/settings { speed_mode: bool }` or set at startup via the `SPEED_MODE=true` env var.

| Delay type | Normal mode | Speed mode |
|---|---|---|
| `preAction()` — thinking pause before action | 800 – 3 000 ms | Skipped entirely |
| `postAction()` — cooldown after action | 2 000 – 8 000 ms | Skipped entirely |
| `shortPause()` — settle after click/scroll | 300 – 800 ms | 80 ms floor |
| `typingPause()` — per-character delay | 50 – 180 ms | 15 ms floor |
| Word pause at spaces (30% chance) | 100 – 400 ms | Removed |
| Bezier mouse steps | 8 – 20 steps, 5 – 25 ms/step | 3 steps, no inter-step delay |
| `scrollToElement` settle | 400 – 900 ms | 120 ms floor |
| `humanScroll` inter-scroll delay | 200 – 800 ms | 80 ms floor |
| Reading simulation (10% chance) | 800 – 3 000 ms | Removed |
| Back-scroll (15% chance) | Yes | Removed |
| Miss-click simulation (8% chance) | Yes | Removed |
| `waitForLoad()` — page load wait | Always | Always (never modified) |

**Actions that always run at normal speed regardless of global flag** (`INTERACTION_ACTIONS` set):

```
comment, reply_tweet, dm, post_reel, post_story, login
```

Any action on an account with `status === 'warming'` is also forced to normal speed. The override is a temporary restore pattern in `executeAction()` — speed mode is restored in a `finally` block after the action completes.

---

## Web Panel

Served by Express on `PORT` (default 3001). No build step — plain HTML/CSS/JS in `public/`.

Authentication: token-based. `POST /api/auth/login` returns a token stored by the client in memory; all other API routes require `x-auth-token` header.

**Routes mounted in `server.js`:**

| Mount path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/login` | No | Login, returns session token |
| `POST /api/auth/change-password` | Yes | Change password; revokes all active tokens |
| `/api/oauth/*` | No (external redirect) | OAuth URL generation + callback handler |
| `/api/accounts/*` | Yes | Account CRUD, connect, health, usage, warmup |
| `/api/campaigns/*` | Yes | Campaign CRUD, status patch, logs |
| `/api/proxies/*` | Yes | Add/bulk import/assign/ban proxies |
| `/api/schedule/*` | Yes | Post queue management |
| `/api/analytics/*` | Yes | Aggregated stats + per-account platform analytics |
| `/api/logs/*` | Yes | Unified log feed + SSE `/stream` endpoint |
| `/api/settings/*` | Yes | Speed mode GET/POST |
| `GET *` | No | SPA fallback — serves `public/index.html` |

**Key panel features:**

- **Connect button** — shown for any account where `session_active === false`. Clicking calls `POST /api/accounts/:id/connect`, which launches Playwright and runs the login flow. On success, the button is replaced by a green `● Connected` indicator. On failure, a toast shows a mapped plain-English error message.
- **Session indicator** — `session_active: true` shows green `● Connected`; sessions expire after 29 days.
- **Established account toggle** — the Add Account modal exposes `skipWarmup` as a toggle. When checked, the account starts as `active` with no warmup schedule created.
- **Warmup progress bar** — visible while `warmup.completed === false`. Progress = `min(100, round((current_day / 15) * 100))%`.
- **Speed mode toggle** — Settings page reads current state on load; toggle calls `POST /api/settings { speed_mode: bool }` to flip the flag in the running process.
- **Change password** — validates new password is >= 8 characters client-side, then calls `POST /api/auth/change-password`. On success, all tokens are revoked and the page reloads after 1.5 s. The new password is written to `.env` so it survives restart.

---

## Database

SQLite file at `DB_PATH` (default `data/nexus.db`). WAL mode, foreign keys on. 10 tables defined in `src/database/schema.js`:

| Table | Purpose |
|---|---|
| `accounts` | Credentials, platform, status, proxy reference, 2FA secret, warmup day, timestamps |
| `proxies` | Host/port/auth, protocol, status (`active`/`inactive`/`banned`), `assigned_account_id` UNIQUE (1 proxy = 1 account) |
| `sessions` | Playwright `storageState` path per account+platform, validity flag, 29-day expiry |
| `rate_limits` | Hour and day counters per account+platform+action type, with reset timestamps |
| `health_logs` | Event log per account: `ok`, `challenge`, `captcha`, `action_block`, `unusual_activity`, `disabled`, `login_required`, `warning` |
| `warmup_schedules` | Current day, phase, and daily caps (likes/follows/comments) per account; `completed` flag |
| `oauth_tokens` | Access + refresh tokens per account+platform for API engine; expiry, scope, meta JSON |
| `campaigns` | Name, type (`growth`/`content`/`hybrid`), status, config JSON, target and completed counts |
| `campaign_logs` | Per-action results for each campaign run: action, status, message, timestamp |
| `post_queue` | Scheduled posts with content JSON, `scheduled_at`, status, retry count (max 3, reschedule +5 min per retry) |

---

## Configuration

Copy `.env.example` to `.env` and set values before first run.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Express panel port |
| `PANEL_URL` | `http://localhost:3001` | Base URL used in OAuth callbacks |
| `PANEL_PASSWORD` | `nexus2024` | Panel login password — change before deployment |
| `DB_PATH` | `data/nexus.db` | SQLite database file path |
| `SESSION_DIR` | `data/sessions` | Directory for Playwright storageState JSON files |
| `LOG_LEVEL` | `info` | Logger verbosity: `debug`, `info`, `warn`, `error` |
| `MAX_CONCURRENT_BROWSERS` | `4` | Max simultaneous Playwright instances; tune per available RAM |
| `HEALTH_CHECK_CRON` | `*/30 * * * *` | Health monitor cron schedule |
| `SPEED_MODE` | _(unset)_ | Set to `true` to start with speed mode enabled |
| `META_APP_ID` / `META_APP_SECRET` | _(empty)_ | Instagram / Meta Graph API credentials |
| `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` | _(empty)_ | Twitter/X OAuth 2.0 PKCE credentials |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | _(empty)_ | YouTube / Google OAuth 2.0 credentials |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | _(empty)_ | TikTok for Developers credentials |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | _(empty)_ | LinkedIn OAuth 2.0 credentials |

---

## Running

```bash
# Clone and install
git clone https://github.com/Ferza-hub/nexus-social
cd nexus-social
npm install
npm rebuild better-sqlite3   # required if using Node.js v22

# Configure
cp .env.example .env
# Edit .env — at minimum set PANEL_PASSWORD

# Initialize database
npm run setup-db

# Development
npm start

# Development with file-watch reload
npm run dev

# Production via PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup

# Panel: http://server-ip:3001
```

---

## Tests

Four test files in `test/`:

| File | Coverage |
|---|---|
| `smoke-test.js` | Phase 1 — Account Manager (25 tests) |
| `engine-unit-test.js` | Phase 2 — Playwright Engine (12 tests) |
| `phase3-unit-test.js` | Phase 3+4 — API Engine + Web Panel (24 tests) |
| `canact-totp-test.js` | `canAct()` gate + TOTP 2FA flow |

```bash
node test/smoke-test.js
node test/engine-unit-test.js
node test/phase3-unit-test.js
node test/canact-totp-test.js
```
