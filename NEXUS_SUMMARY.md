# Nexus Social

> Automated social media engine built on Node.js + Playwright.
> Core philosophy: **Playwright-first, account safety first** — the browser engine drives all automation; the API layer is an auth gate and content publishing supplement only.

---

## Overview

Nexus Social is a self-hosted social media automation platform that orchestrates browser-based (Playwright) actions across six major platforms. It manages account lifecycles with a warmup state machine, enforces per-account rate limits, simulates realistic human behavior to avoid detection, and exposes a dark-themed web panel for full management.

**Tech Stack**

| Layer | Technology |
|---|---|
| Runtime | Node.js >= 18 |
| Browser automation | Playwright (Chromium, stealth-patched) |
| Database | SQLite via better-sqlite3 (WAL mode, FK on) |
| Web Panel | Express 4 + Vanilla HTML/CSS/JS (no build step) |
| Process manager | PM2 (`ecosystem.config.js`) |
| Proxy | https-proxy-agent — dedicated per account |
| Scheduler | node-cron |

**Design principle:** Playwright handles all engagement actions (like, follow, comment, scroll, watch). The API engine handles only OAuth-gated operations (content publishing, analytics) and is never used as a substitute for Playwright login.

---

## Platform Coverage

| Platform | Actions | Notes |
|---|---|---|
| **Instagram** | `login`, `scroll_feed`, `watch_story`, `like_post`, `follow`, `unfollow`, `comment`, `watch_reel`, `dm`, `post_reel`, `post_story` | 11 actions. TOTP 2FA built-in (no external dep). File-chooser upload for reels/stories. |
| **TikTok** | `login`, `watch_video`, `like_video`, `follow`, `comment`, `scroll_fyp` | 6 actions. `watch_video` maps to `watch_reel` rate type. |
| **Twitter/X** | `login`, `scroll_feed`, `like_post`, `follow`, `unfollow`, `reply_tweet` | 6 actions. Multi-step login flow with optional phone/email challenge via `data-testid` selectors. `reply_tweet` maps to `comment` rate type. |
| **YouTube** | `login`, `scroll_feed`, `watch_video`, `like_video`, `subscribe`, `comment`, `share` | 7 actions. Google OAuth login flow with TOTP 2FA. `subscribe` maps to `follow` rate type; `share` has no rate limit. |
| **Threads** | `login`, `scroll_feed`, `like_post`, `follow`, `unfollow`, `comment` | 6 actions. Uses Instagram credentials + TOTP. Profile URLs: `threads.net/@username`. |
| **Facebook** | `login`, `scroll_feed`, `like_post`, `follow`, `comment`, `watch_reel`, `like_reel`, `share` | 8 actions. Cookie consent handling (prefer decline). `follow` supports both Pages (Follow) and profiles (Add Friend). `share` and `like_reel` have no rate type. |

**Rate-counted action types** (shared across platforms): `like`, `follow`, `unfollow`, `comment`, `story_view`, `watch_reel`, `dm`.

Actions with `rateType: null` (login, scroll, post, share) bypass rate-limit checks but still respect account status.

---

## Architecture

Nexus Social is structured into four cooperating phases:

### Phase 1 — Account Manager (`src/account-manager/`)

The safety layer. Manages account lifecycle, warmup progression, session state, rate limits, and health monitoring. All other phases query the Account Manager before acting.

| Module | Responsibility |
|---|---|
| `index.js` | Public API surface: `addAccount`, `canAct()`, proxy management |
| `session-manager.js` | Save/load/invalidate Playwright `storageState` (disk + DB) |
| `rate-limiter.js` | Per-account, per-platform hour + day counters for each action type |
| `warmup-scheduler.js` | State machine `new → warming → active`; daily phase advancement |
| `health-monitor.js` | Cron every 30 min; auto-response to challenge/captcha/block/disabled events |

### Phase 2 — Playwright Engine (`src/playwright-engine/`)

The automation core. Launches stealth Chromium, simulates human behavior, and executes platform-specific actions.

| Module | Responsibility |
|---|---|
| `browser.js` | Launch + stealth patches + fingerprinting; concurrency guard |
| `human.js` | Bezier mouse, delays, scroll, click — normal and speed mode |
| `index.js` | `executeAction()` 8-step orchestrator; `ACTION_MAP` registry |
| `target-discovery.js` | Hashtag/follower/explore scraping for campaign targeting |
| `platforms/*.js` | One module per platform; detection handler per module |

### Phase 3 — API Engine (`src/api-engine/`)

Handles OAuth token management and content publishing via official platform APIs. Used for scheduled posts, analytics, and reply-to-comment operations where Playwright is unnecessary.

| Module | Responsibility |
|---|---|
| `oauth/` | Token manager + per-platform OAuth flows (Meta, Twitter PKCE, Google, TikTok, LinkedIn) |
| `actions/post.js` | `publishPost`, `schedulePost`, `deletePost` |
| `actions/analytics.js` | `getAnalytics`, `getFollowers` |
| `actions/engagement.js` | `replyComment` |
| `scheduler/queue.js` | `post_queue` + campaign CRUD |
| `scheduler/runner.js` | Cron dispatcher: posts every 60 s, campaigns every 30 s |

### Phase 4 — Web Panel (`src/panel/`)

Dark-themed management UI served by Express. Token-based authentication; no framework, no build step.

| Module | Responsibility |
|---|---|
| `server.js` | Express app; static files; route mounting; auth middleware |
| `middleware/auth.js` | Token-based auth; `changePasswordHandler` |
| `routes/accounts.js` | Account CRUD, connect endpoint, health/usage endpoints |
| `routes/settings.js` | Speed mode GET/POST |
| `routes/campaigns.js` | Campaign CRUD + status patch + logs |
| `routes/proxies.js` | Single add + bulk import + assign |
| `routes/schedule.js` | Post queue management |
| `routes/analytics.js` | Stats + per-account platform analytics |
| `routes/logs.js` | Unified log feed + SSE `/stream` endpoint |
| `routes/oauth.js` | OAuth URL generator + callback handler |

---

## Account Management

### Add Account Flow

`POST /api/accounts` accepts: `username`, `password`, `platform`, optional `email`, `phone`, `twoFaSecret`, `notes`, `proxyId`, and `skipWarmup`.

**Duplicate guard:** Before inserting, the route checks `SELECT id FROM accounts WHERE username = ? AND platform = ?`. If a record exists, the request is rejected with HTTP 409 and the message: `@{username} on {platform} already exists (id: {id})`.

**`skipWarmup` toggle (Established account):**
- `skipWarmup: false` (default) — account starts at status `new`, warmup schedule is initialized via `warmupScheduler.initWarmup()`, and status immediately transitions to `warming`.
- `skipWarmup: true` — account starts at status `active` directly. No warmup record is created. Use for accounts that already have platform trust history.

The panel's Add Account modal exposes this as an "Established account" toggle with the label: *"Account already has activity history — skip warmup and start immediately."*

### Status Lifecycle

```
new → warming → active → flagged → recovery → active
                       ↘ disabled
```

| Status | Description |
|---|---|
| `new` | Just created; warmup not yet initialized |
| `warming` | Actively progressing through warmup phases; reduced action caps apply |
| `active` | Full automation allowed; normal rate limits apply |
| `flagged` | Paused — challenge, captcha, or session expiry detected; requires manual review or auto-recovery |
| `recovery` | Post-flagged recovery window |
| `disabled` | Permanently disabled by platform; all actions blocked |

### Warmup Phases

| Day Range | Phase | Likes/day | Follows/day | Comments/day |
|---|---|---|---|---|
| 1 – 3 | `login_only` | 0 | 0 | 0 |
| 4 – 7 | `light` | 15 | 10 | 0 |
| 8 – 14 | `medium` | 50 | 50 | 5 |
| 15+ | `full` | normal quota | normal quota | normal quota |

`runDailyAdvancement()` is called by cron once per day. At day 15 the account graduates: `warmup_schedules.completed = 1` and `accounts.status = 'active'`.

**Recovery restart:** `restartWarmup()` sets `current_day = max(1, current_day - 7)` and transitions status back to `warming`.

### `canAct()` Gate

Every rate-limited action passes through `canAct(accountId, platform, actionType)` before execution:

1. **Account existence** — returns `account_not_found` if missing.
2. **Status check** — blocks if `disabled` or `flagged`.
3. **`action_block` cooldown** — queries `health_logs` for any `action_block` event within the last 2 hours; blocks with `action_block_cooldown` if found.
4. **Warmup caps** — if status is `warming`, retrieves phase limits from `warmup_schedules`. If the cap is `0` for the action type → `warmup_phase_restricts_action`. If daily count has reached the cap → `warmup_daily_cap`.
5. **Normal rate limits** — delegates to `rateLimiter.canPerform()` which enforces both hourly and daily counters.

**Rate limit defaults (per account, per platform)**

| Action | Max/hour | Max/day |
|---|---|---|
| follow / unfollow | 20 | 150 |
| like | 50 | 300 |
| comment | 15 | 100 |
| story_view | — | 500 |
| dm | — | 50 |
| watch_reel | — | 500 |

---

## Playwright Engine

### Browser Fingerprint (9 patches)

Applied via `addInitScript` on every new context:

1. `navigator.webdriver` → `undefined`
2. `navigator.plugins` → PDF viewer mock array
3. `window.chrome` → runtime object stub
4. **Canvas** → per-session seeded RNG pixel noise
5. **WebGL** → one of 6 realistic GPU vendor/renderer pairs
6. **AudioContext** → float noise ±5e-8
7. **Battery API** → mocked state (20–100%)
8. **Network info** → 4G WiFi profile
9. **Permissions API** → returns `'prompt'` for sensitive APIs

Launch flags: `--disable-blink-features=AutomationControlled`, `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-infobars`.

### Human Simulation: Normal vs Speed Mode

| Behavior | Normal Mode | Speed Mode |
|---|---|---|
| `preAction()` — thinking pause before action | 800 – 3 000 ms random | **Skipped entirely** |
| `postAction()` — cooldown after action | 2 000 – 8 000 ms random | **Skipped entirely** |
| `shortPause()` — settle after click/scroll | 300 – 800 ms random | 80 ms floor |
| `typingPause()` — per-character delay | 50 – 180 ms random | 15 ms floor |
| Word pause (space, 30% chance) | 100 – 400 ms | **Removed** |
| Bezier mouse steps | 8 – 20 steps, 5 – 25 ms/step | 3 steps, no inter-step delay |
| `scrollToElement` settle | 400 – 900 ms random | 120 ms floor |
| `humanScroll` inter-scroll delay | 200 – 800 ms random | 80 ms floor |
| Reading simulation (10% chance) | 800 – 3 000 ms extra | **Removed** |
| Back-scroll (15% chance) | Yes | **Removed** |
| Miss-click simulation (8% chance) | Yes | **Removed** |
| Page load `waitForLoad()` | Always runs — never modified | Always runs — never modified |

### Speed Mode Scoping

Speed mode is a global in-process flag (`_speedMode` in `human.js`), toggled via `setSpeedMode(bool)`.

**Automatic override — actions that always run at normal speed regardless of global flag:**

```
INTERACTION_ACTIONS = { comment, reply_tweet, dm, post_reel, post_story, login }
```

Additionally, any action on an account with `status === 'warming'` is forced to normal speed — natural behavior is critical during the trust-building phase.

The override is applied as a temporary restore pattern in `executeAction()`:

```js
const forceNormal = INTERACTION_ACTIONS.has(action) || account.status === 'warming';
if (forceNormal && wasSpeed) setSpeedMode(false);
// ... run action ...
if (forceNormal && wasSpeed) setSpeedMode(true);  // restore in finally
```

### `executeAction()` — 8-Step Flow

1. **`canAct()` gate** — status check, action_block cooldown, warmup caps, rate limits.
2. **`isAccountBusy()` + `isConcurrencyFull()`** — prevents >1 browser per account and enforces `MAX_CONCURRENT_BROWSERS` global cap.
3. **`launchForAccount()`** — opens stealth Chromium with stored proxy and loads saved `storageState`.
4. **`_checkLoggedIn()`** — navigates to platform home and checks URL/element; auto-re-logins if session expired.
5. **Speed mode scoping** — forces normal timing for interaction actions and warming accounts.
6. **Platform function call** — executes the mapped function (e.g. `instagram.likePost(page, postUrl)`).
7. **Detection handling** — if result contains an event (`challenge`, `captcha`, `action_block`, `disabled`), logs to `health_logs` and returns early.
8. **`recordAction()` + `saveSession()`** — increments rate counters and persists fresh `storageState`; browser closed in `finally` block.

### Session Management

**`hasActiveSession(accountId, platform)`** — queries `sessions` table for a row with `is_valid = 1` whose `expires_at` is in the future. Used by the accounts list endpoint to populate the `session_active` field.

Sessions expire after **29 days**. The session file is stored at `data/sessions/{platform}/{accountId}.json` (Playwright `storageState` JSON). On invalidation, the account is flagged to `flagged` status.

**Connect button flow:**
1. Panel renders a `Connect` button for any account where `session_active === false`.
2. Clicking calls `POST /api/accounts/:id/connect`.
3. The route calls `loginAndSaveSession()` → `executeAction(id, platform, 'login')`.
4. On success, the `● Connected` session indicator replaces the button.
5. On failure, a human-readable error toast is shown (maps raw error codes to plain-English messages).

---

## Web Panel

### Route Mounting (`server.js`)

| Mount path | Router file | Auth required |
|---|---|---|
| `POST /api/auth/login` | middleware/auth | No |
| `POST /api/auth/change-password` | middleware/auth | Yes |
| `/api/oauth/*` | routes/oauth | No (external redirect) |
| `/api/accounts/*` | routes/accounts | Yes |
| `/api/campaigns/*` | routes/campaigns | Yes |
| `/api/proxies/*` | routes/proxies | Yes |
| `/api/schedule/*` | routes/schedule | Yes |
| `/api/analytics/*` | routes/analytics | Yes |
| `/api/logs/*` | routes/logs | Yes |
| `/api/settings/*` | routes/settings | Yes |
| `GET *` | SPA fallback | No |

### Settings Page

**Change Password** (`POST /api/auth/change-password`):
- Client validates new password matches and is >= 8 characters before submitting.
- On success, all active sessions are signed out (`API.clearToken()`) and the page reloads after 1.5 s.

**Speed Mode Toggle** (`GET/POST /api/settings`):
- Loads current state on page render; displays `Speed Mode: ON — delays disabled` (amber) or `Speed Mode: OFF — human timing active` (default).
- Toggle change calls `POST /api/settings { speed_mode: bool }` which calls `setSpeedMode()` in the running process.

### Accounts Page

**Session indicator:**
- `session_active: true` → green `● Connected` dot (read-only).
- `session_active: false` → `Connect` button (ghost style).

**Connect button behavior:**
- Button disabled and text changes to `Connecting…` during the async login flow.
- Success: toast + full table reload (button replaced by `● Connected`).
- Failure: toast with mapped user-friendly message; button re-enabled.

**Established account toggle (`skipWarmup`):**
- Rendered in the Add Account modal as a toggle with descriptive label.
- When checked, `skipWarmup: true` is sent in the POST body, causing the account to start as `active` with no warmup schedule created.

**Warmup progress bar:**
- Visible only while `warmup.completed === false`.
- Progress = `min(100, round((current_day / 15) * 100))%`.
- Shows `current_phase · day N` above the bar.

---

## Speed Mode

| Delay Type | Normal Mode | Speed Mode | Preserved? |
|---|---|---|---|
| Pre-action "thinking" pause | 800 – 3 000 ms | 0 ms | No — removed entirely |
| Post-action cooldown | 2 000 – 8 000 ms | 0 ms | No — removed entirely |
| Click settle (`shortPause`) | 300 – 800 ms | 80 ms | Yes — floor kept |
| Per-character typing | 50 – 180 ms | 15 ms | Yes — floor kept |
| Word pause at spaces | 100 – 400 ms | 0 ms | No — removed |
| Bezier mouse movement | 8–20 steps, 5–25 ms/step | 3 steps, 0 ms/step | Partial — path preserved, timing removed |
| Scroll-to-element settle | 400 – 900 ms | 120 ms | Yes — floor kept |
| Inter-scroll delay | 200 – 800 ms | 80 ms | Yes — floor kept |
| Reading pauses (10% chance) | 800 – 3 000 ms | 0 ms | No — removed |
| Back-scroll simulation | Yes (15% chance) | No | No |
| Miss-click simulation | Yes (8% chance) | No | No |
| Page load wait | Always | Always | Yes — never touched |

**What is never affected by speed mode regardless of setting:**
- `waitForLoad()` — always waits for DOM content + networkidle.
- Actions in `INTERACTION_ACTIONS` set: `comment`, `reply_tweet`, `dm`, `post_reel`, `post_story`, `login` — always run at normal timing.
- Any action on a `warming` account — always runs at normal timing.

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Express panel port |
| `PANEL_URL` | `http://localhost:3001` | Base URL (used in OAuth callbacks) |
| `PANEL_PASSWORD` | `nexus2024` | Panel login password — **change before deployment** |
| `DB_PATH` | `data/nexus.db` | SQLite database file path |
| `SESSION_DIR` | `data/sessions` | Directory for Playwright storageState files |
| `LOG_LEVEL` | `info` | Logger verbosity (`debug`, `info`, `warn`, `error`) |
| `MAX_CONCURRENT_BROWSERS` | `4` | Max simultaneous Playwright instances (tune per RAM) |
| `HEALTH_CHECK_CRON` | `*/30 * * * *` | Health monitor schedule |
| `SPEED_MODE` | _(unset)_ | Set to `true` to start with speed mode enabled |
| `META_APP_ID` / `META_APP_SECRET` | _(empty)_ | Instagram/Meta Graph API OAuth credentials |
| `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` | _(empty)_ | Twitter/X OAuth 2.0 PKCE credentials |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | _(empty)_ | YouTube/Google OAuth 2.0 credentials |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | _(empty)_ | TikTok for Developers credentials |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | _(empty)_ | LinkedIn OAuth 2.0 credentials |

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Ferza-hub/nexus-social
cd nexus-social
npm install
npm rebuild better-sqlite3   # required if using Node.js v22

# 2. Configure
cp .env.example .env
# Edit .env: set PANEL_PASSWORD and any OAuth credentials needed

# 3. Initialize database
node src/database/setup.js

# 4. Start (development)
npm start

# 5. Start (production via PM2)
pm2 start ecosystem.config.js
pm2 save
pm2 startup

# Panel: http://server-ip:3001
```

---

## API Endpoints

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | No | Login with panel password; returns token |
| `POST` | `/api/auth/change-password` | Yes | Change panel password; invalidates all sessions |

### Accounts

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/accounts` | Yes | List accounts (filterable by `?platform=` `?status=`); enriched with warmup, api_connected, session_active |
| `POST` | `/api/accounts` | Yes | Add account; supports `skipWarmup` flag; 409 on duplicate |
| `DELETE` | `/api/accounts/:id` | Yes | Delete account |
| `POST` | `/api/accounts/:id/connect` | Yes | Trigger Playwright login and save session |
| `GET` | `/api/accounts/:id/health` | Yes | Last 50 health log events |
| `GET` | `/api/accounts/:id/usage` | Yes | Current hour/day rate counters per action type |
| `POST` | `/api/accounts/:id/warmup/restart` | Yes | Restart warmup (roll back 7 days, re-enter warming) |
| `GET` | `/api/accounts/alerts/all` | Yes | All recent health alerts |

### Campaigns

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/campaigns` | Yes | List all campaigns |
| `POST` | `/api/campaigns` | Yes | Create campaign (GROWTH / CONTENT / HYBRID) |
| `GET` | `/api/campaigns/:id` | Yes | Get single campaign |
| `PATCH` | `/api/campaigns/:id/status` | Yes | Pause / resume / stop |
| `DELETE` | `/api/campaigns/:id` | Yes | Delete campaign |
| `GET` | `/api/campaigns/:id/logs` | Yes | Campaign action logs |

### Proxies

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/proxies` | Yes | List proxies |
| `POST` | `/api/proxies` | Yes | Add single proxy |
| `POST` | `/api/proxies/bulk` | Yes | Bulk import (`host:port:user:pass` per line) |
| `PATCH` | `/api/proxies/:id/status` | Yes | Ban / unban proxy |
| `POST` | `/api/proxies/:id/assign/:accountId` | Yes | Assign proxy to account (enforces 1-proxy-1-account) |
| `DELETE` | `/api/proxies/:id` | Yes | Delete proxy |

### Schedule

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/schedule` | Yes | List scheduled posts |
| `POST` | `/api/schedule` | Yes | Schedule a post (caption, media URL, hashtags, datetime) |
| `DELETE` | `/api/schedule/:id` | Yes | Cancel scheduled post |

### Analytics

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/analytics` | Yes | Aggregated stats dashboard |
| `GET` | `/api/analytics/account/:id` | Yes | Per-account platform analytics (calls platform API live) |

### Logs

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/logs` | Yes | Unified log feed (`?type=health` or `?type=campaign`) |
| `GET` | `/api/logs/stream` | Yes | Server-Sent Events real-time log stream |

### Settings

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/settings` | Yes | Get current settings (speed_mode state) |
| `POST` | `/api/settings` | Yes | Update settings (`{ speed_mode: bool }`) |

### OAuth

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/oauth/:platform/url?accountId=X` | Yes | Generate OAuth authorization URL |
| `GET` | `/api/oauth/callback/:platform` | No | Receive OAuth callback; save token to DB |
| `GET` | `/api/oauth/status/:platform` | Yes | Check token validity for platform |
| `DELETE` | `/api/oauth/:platform` | Yes | Revoke OAuth token |

---

## Database Schema (10 tables)

```
accounts          id · username · password · email · phone · platform
                  status [new|warming|active|flagged|recovery|disabled]
                  proxy_id · two_fa_secret · warmup_day · notes
                  last_active_at · created_at · updated_at

proxies           id · host · port · username · password · protocol
                  status [active|inactive|banned]
                  assigned_account_id (UNIQUE — 1 proxy = 1 account)

sessions          account_id · platform · storage_state_path
                  is_valid · expires_at · updated_at
                  (expires after 29 days; invalidation flags account as flagged)

rate_limits       account_id · platform · action_type
                  hour_count · day_count · hour_reset_at · day_reset_at

health_logs       account_id · platform · event_type · message · created_at

warmup_schedules  account_id · platform · current_day · current_phase
                  max_likes_day · max_follows_day · max_comments_day · completed

oauth_tokens      account_id · platform · access_token · refresh_token
                  expires_at · scope · meta_json

campaigns         name · account_id · platform · type [growth|content|hybrid]
                  status · config_json · target_count · completed_count

campaign_logs     campaign_id · account_id · action · status · message · created_at

post_queue        account_id · platform · campaign_id · content_json
                  scheduled_at · status · retry_count · max_retries
                  (retry up to max_retries=3; reschedule +5 min per retry)
```

---

## Test Suite

```bash
node test/smoke-test.js          # Phase 1 — 25 tests (Account Manager)
node test/engine-unit-test.js    # Phase 2 — 12 tests (Playwright Engine)
node test/phase3-unit-test.js    # Phase 3+4 — 24 tests (API Engine + Web Panel)
```

**Total: 61/61 tests pass**

---

## File Map

```
Nexus-Social/
├── src/
│   ├── index.js                          ← entry point (starts all systems)
│   ├── utils/logger.js                   ← structured logger [context][level]
│   ├── database/
│   │   ├── db.js                         ← SQLite connection (WAL, FK on)
│   │   ├── schema.js                     ← DDL + auto-migration
│   │   └── setup.js                      ← CLI: node src/database/setup.js
│   ├── account-manager/
│   │   ├── index.js                      ← public API + canAct() gate
│   │   ├── session-manager.js            ← save/load/invalidate storageState + hasActiveSession
│   │   ├── rate-limiter.js               ← hour + day counter per action type
│   │   ├── warmup-scheduler.js           ← state machine new→warming→active; PHASES config
│   │   └── health-monitor.js             ← cron 30 min; auto-response per event
│   ├── playwright-engine/
│   │   ├── browser.js                    ← launch + stealth + fingerprint; concurrency guard
│   │   ├── human.js                      ← Bezier mouse, delays, scroll, click; speed mode
│   │   ├── index.js                      ← executeAction() orchestrator; ACTION_MAP
│   │   ├── target-discovery.js           ← hashtag/follower/explore scraping
│   │   └── platforms/
│   │       ├── instagram.js              ← 11 actions + detection handler + TOTP
│   │       ├── tiktok.js                 ← 6 actions + detection handler
│   │       ├── twitter.js                ← 6 actions; multi-step login
│   │       ├── youtube.js                ← 7 actions; Google OAuth login + TOTP
│   │       ├── threads.js                ← 6 actions; Instagram credentials
│   │       └── facebook.js              ← 8 actions; cookie consent handling
│   ├── api-engine/
│   │   ├── index.js                      ← public API surface
│   │   ├── oauth/                        ← token manager + per-platform OAuth flows
│   │   ├── actions/                      ← post, analytics, engagement
│   │   └── scheduler/                    ← post queue + campaign runner (cron)
│   └── panel/
│       ├── server.js                     ← Express + static + auth + route mounting
│       ├── middleware/auth.js            ← token auth + changePasswordHandler
│       └── routes/                       ← accounts, campaigns, proxies, schedule,
│                                           analytics, logs, oauth, settings
├── public/                               ← Panel frontend (no build step)
│   ├── index.html
│   ├── css/app.css                       ← Dark theme
│   └── js/
│       ├── api.js                        ← fetch wrapper + auth token
│       ├── app.js                        ← SPA router
│       ├── components/modal.js, toast.js
│       └── pages/                        ← accounts, campaigns, scheduler,
│                                           proxies, analytics, logs, settings
├── test/
│   ├── smoke-test.js                     ← Phase 1 (25 tests)
│   ├── engine-unit-test.js               ← Phase 2 (12 tests)
│   └── phase3-unit-test.js               ← Phase 3+4 (24 tests)
├── data/
│   └── sessions/{platform}/{id}.json    ← Playwright storageState per account
├── package.json
├── ecosystem.config.js                   ← PM2 config
└── .env.example
```

**Total: ~50 source files · ~7 000 lines of code · 61/61 tests pass**
