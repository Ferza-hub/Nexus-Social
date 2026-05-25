# Nexus Social — Project Summary

> Automated social media engine dibangun di atas Node.js + Playwright.  
> Prinsip utama: **account safety first** — tidak ada automation sebelum account manager solid.

---

## Stack

| Layer | Teknologi |
|---|---|
| Runtime | Node.js ≥ 18 |
| Browser | Playwright (Chromium) |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Panel | Vanilla HTML/CSS/JS — no build step |
| Process | PM2 (`ecosystem.config.js`) |
| Proxy | https-proxy-agent · dedicated per akun |
| Cron | node-cron |
| Panel server | Express 4 |

---

## Struktur File

```
Nexus-Social/
├── src/
│   ├── index.js                          ← entry point (start semua sistem)
│   ├── utils/
│   │   └── logger.js                     ← structured logger [context][level]
│   ├── database/
│   │   ├── db.js                         ← SQLite connection (WAL, FK on)
│   │   ├── schema.js                     ← DDL + auto-migration
│   │   └── setup.js                      ← CLI: node src/database/setup.js
│   ├── account-manager/
│   │   ├── index.js                      ← public API + canAct() gate
│   │   ├── session-manager.js            ← save/load/invalidate storageState
│   │   ├── rate-limiter.js               ← hour + day counter per action
│   │   ├── warmup-scheduler.js           ← state machine new→warming→active
│   │   └── health-monitor.js             ← cron 30min, auto-response per event
│   ├── playwright-engine/
│   │   ├── browser.js                    ← launch + stealth + fingerprint
│   │   ├── human.js                      ← Bezier mouse, delays, scroll, click
│   │   ├── index.js                      ← executeAction() orchestrator
│   │   ├── target-discovery.js           ← hashtag/follower/explore scraping
│   │   └── platforms/
│   │       ├── instagram.js              ← 9 actions + detection handler + TOTP
│   │       └── tiktok.js                 ← 6 actions + detection handler
│   ├── api-engine/
│   │   ├── index.js                      ← public API surface
│   │   ├── oauth/
│   │   │   ├── index.js                  ← token manager (save/load/refresh)
│   │   │   ├── instagram.js              ← Meta Graph API OAuth
│   │   │   ├── twitter.js                ← Twitter OAuth 2.0 PKCE
│   │   │   ├── youtube.js                ← Google OAuth 2.0
│   │   │   ├── tiktok.js                 ← TikTok for Developers OAuth
│   │   │   └── linkedin.js               ← LinkedIn OAuth 2.0
│   │   ├── actions/
│   │   │   ├── post.js                   ← publishPost, schedulePost, deletePost
│   │   │   ├── analytics.js              ← getAnalytics, getFollowers
│   │   │   └── engagement.js             ← replyComment
│   │   └── scheduler/
│   │       ├── queue.js                  ← post_queue + campaign CRUD
│   │       └── runner.js                 ← cron dispatcher (post 60s · campaign 30s)
│   └── panel/
│       ├── server.js                     ← Express + static + auth
│       ├── middleware/
│       │   └── auth.js                   ← token-based auth
│       └── routes/
│           ├── accounts.js
│           ├── campaigns.js
│           ├── proxies.js
│           ├── schedule.js
│           ├── analytics.js
│           ├── logs.js                   ← + SSE /stream endpoint
│           └── oauth.js                  ← OAuth URL generator + callback
├── public/                               ← Panel frontend (no build step)
│   ├── index.html
│   ├── css/app.css                       ← Dark theme (GitHub-inspired)
│   └── js/
│       ├── api.js                        ← fetch wrapper + auth token
│       ├── app.js                        ← SPA router
│       ├── components/
│       │   ├── modal.js
│       │   └── toast.js
│       └── pages/
│           ├── accounts.js
│           ├── campaigns.js
│           ├── scheduler.js
│           ├── proxies.js
│           ├── analytics.js
│           └── logs.js                   ← live SSE log stream
├── test/
│   ├── smoke-test.js                     ← Phase 1 (25 tests)
│   ├── engine-unit-test.js               ← Phase 2 (12 tests)
│   └── phase3-unit-test.js               ← Phase 3+4 (24 tests)
├── data/
│   └── sessions/{platform}/{id}.json     ← Playwright storageState per akun
├── package.json
├── ecosystem.config.js                   ← PM2 config
└── .env.example
```

**Total: 49 file · ~7.000 baris kode · 61/61 tests pass**

---

## Database Schema (8 tabel)

```
accounts          id · username · password · email · phone · platform
                  status [new|warming|active|flagged|recovery|disabled]
                  proxy_id · two_fa_secret · warmup_day

proxies           id · host · port · username · password · protocol
                  status [active|inactive|banned]
                  assigned_account_id (UNIQUE — 1 proxy = 1 akun)

sessions          account_id · platform · storage_state_path
                  is_valid · expires_at

rate_limits       account_id · platform · action_type
                  hour_count · day_count · hour_reset_at · day_reset_at

health_logs       account_id · platform · event_type · message · created_at

warmup_schedules  account_id · platform · current_day · current_phase
                  max_likes_day · max_follows_day · max_comments_day

oauth_tokens      account_id · platform · access_token · refresh_token
                  expires_at · scope · meta_json

campaigns         name · account_id · platform · type [growth|content|hybrid]
                  status · config_json · target_count · completed_count

campaign_logs     campaign_id · account_id · action · status · message

post_queue        account_id · platform · campaign_id · content_json
                  scheduled_at · status · retry_count · max_retries
```

---

## Phase 1 — Account Manager

### Rate Limits (per akun, per platform)

| Action | Max/jam | Max/hari |
|---|---|---|
| follow / unfollow | 20 | 150 |
| like | 50 | 300 |
| comment | 15 | 100 |
| story_view | — | 500 |
| dm | — | 50 |
| watch_reel | — | 500 |

### Warmup Schedule

| Hari | Phase | Like/hari | Follow/hari | Comment/hari |
|---|---|---|---|---|
| 1–3 | `login_only` | 0 | 0 | 0 |
| 4–7 | `light` | 15 | 10 | 0 |
| 8–14 | `medium` | 50 | 50 | 5 |
| 15+ | `full` | quota normal | quota normal | quota normal |

Status machine: `new → warming → active → flagged → recovery → active`

### Health Monitor — Auto-Response

| Event | Response otomatis |
|---|---|
| `challenge` / `captcha` | Pause akun (flagged) + invalidate session |
| `action_block` | Potong semua kuota 50% |
| `unusual_activity` | Pause 24 jam |
| `disabled` | Flag disabled + invalidate session |
| Recovery | Setelah 24 jam → restart warmup dari hari −7 |

---

## Phase 2 — Playwright Engine

### Browser Stealth (inherit dari nexus-playwright)

```
--disable-blink-features=AutomationControlled
--no-sandbox · --disable-dev-shm-usage · --disable-infobars

addInitScript patches:
  navigator.webdriver     → undefined
  navigator.plugins       → PDF viewer mocks
  window.chrome           → runtime object
  Canvas                  → per-session seeded RNG noise
  WebGL                   → 6 realistic GPU vendor/renderer pairs
  AudioContext            → float noise ±5e-8
  Battery API             → mocked state (20–100%)
  Network info            → 4G WiFi profile
  Permissions API         → returns 'prompt' for sensitive APIs
```

### Human Behavior Layer

```
preAction()     rand(800, 3000) ms
postAction()    rand(2000, 8000) ms
shortPause()    rand(300, 800) ms
typingPause()   rand(50, 180) ms per karakter

moveMouseTo()   Bezier curve 8–20 steps, 5–25ms per step
humanClick()    scrollToElement + moveMouseTo + optional miss-click (8%)
humanScroll()   rand(80–350px) per scroll, 15% chance backscroll
humanType()     per-char delay + pause random di spasi
```

### Instagram Module (11 actions)

| Action | Deskripsi |
|---|---|
| `login` | Email/phone + 2FA handler (TOTP built-in, no dep) |
| `scrollFeed` | Scroll home feed dengan human timing |
| `watchStory` | Tap 1–5 frame dengan watch time 3–12s per frame |
| `likePost` | Navigate ke post URL, klik like |
| `followUser` | Navigate ke profil, klik Follow, verifikasi |
| `unfollowUser` | Klik Following → konfirmasi dialog |
| `commentPost` | Buka comment box, humanType, submit |
| `watchReel` | Play reel 8–22s (20–90% durasi) |
| `sendDM` | Search recipient, ketik pesan, kirim |
| `postReel` | Upload video file via file-chooser, tambah caption + hashtag |
| `postStory` | Upload media file via file-chooser, publish ke story |

### TikTok Module (6 actions)

`login` · `watchVideo` · `likeVideo` · `followUser` · `commentVideo` · `scrollFYP`

### Twitter/X Module (6 actions)

`login` · `scrollFeed` · `likePost` · `followUser` · `unfollowUser` · `replyTweet`

Login: multi-step flow (username → Next → optional phone/email challenge → password → Log in), detection via `data-testid` selectors.

### YouTube Module (6 actions)

`login` · `scrollFeed` · `watchVideo` · `likeVideo` · `subscribe` · `comment`

Login: Google OAuth flow (accounts.google.com), TOTP 2FA support. `subscribe` maps to `follow` rate-type, `watchVideo` maps to `watch_reel` rate-type.

### Threads Module (6 actions)

`login` · `scrollFeed` · `likePost` · `followUser` · `unfollowUser` · `comment`

Login: Instagram credentials + 2FA TOTP. Profile URL pattern: `threads.net/@username`.

### Facebook Module (5 actions)

`login` · `scrollFeed` · `likePost` · `followUser` · `comment`

Login: cookie consent handling (prefer decline). `followUser` supports both Pages (Follow button) and profiles (Add Friend button).

### Target Discovery

```
ig.hashtagPosts(page, hashtag, { limit })       → array post URLs
ig.competitorFollowers(page, username, { limit }) → array usernames
ig.explorePosts(page, { limit })                 → array post URLs
tt.hashtagVideos(page, hashtag, { limit })       → array video URLs
```

### executeAction() — Orchestrator

```
1. canAct() gate      → cek status akun + warmup cap + rate limit
2. isAccountBusy()    → cegah >1 browser per akun
3. _checkLoggedIn()   → auto re-login jika session expired
4. platform fn()      → jalankan action
5. checkForDetection()→ challenge/captcha/action_block/disabled
6. recordAction()     → increment rate counter
7. saveSession()      → persist storageState
8. cleanup()          → close browser di finally block
```

---

## Phase 3 — API Engine

### OAuth Providers

| Platform | Flow | Token lifetime |
|---|---|---|
| Instagram / Meta | Authorization Code | 60 hari (long-lived) |
| Twitter / X | OAuth 2.0 PKCE | ~2 jam + refresh |
| YouTube / Google | OAuth 2.0 + refresh | 1 jam + refresh |
| TikTok | Authorization Code | 24 jam + refresh |
| LinkedIn | Authorization Code | 60 hari + refresh |

Connect flow: `GET /api/oauth/:platform/url?accountId=X` → redirect user → callback auto-saves token ke DB.

### API Actions

```javascript
publishPost(accountId, platform, content)
// Instagram: photo/carousel via Graph API container → publish
// Twitter:   POST /2/tweets
// YouTube:   resumable upload → video metadata
// TikTok:    Content Posting API PULL_FROM_URL
// LinkedIn:  ugcPosts API

schedulePost(accountId, platform, content, scheduledAt)
// → inserts to post_queue, dieksekusi cron setiap 60 detik

deletePost(accountId, platform, postId)
getAnalytics(accountId, platform)   // followers, reach, impressions
getFollowers(accountId, platform)   // for targeting
replyComment(accountId, platform, { commentId, message })
```

### Campaign Runner (cron)

| Cron | Job |
|---|---|
| Setiap 60 detik | Drain `post_queue` — eksekusi post yang `scheduled_at ≤ now` |
| Setiap 30 detik | Pick up campaign `status='running'` → dispatch ke engine |

**Campaign types:**

- **GROWTH** — Playwright engine: discover targets (hashtag/competitor/explore) → loop `executeAction()` sampai `target_count` atau rate limit
- **CONTENT** — API engine: semua post masuk `post_queue`, dieksekusi sesuai jadwal
- **HYBRID** — API publish dulu → Playwright boost engagement pada target terkait

**Retry logic:** post gagal → retry hingga `max_retries` (default 3×), reschedule +5 menit per retry.

---

## Phase 4 — Web Panel

**URL:** `http://server-ip:3001`  
**Auth:** password → token disimpan di localStorage

### REST API Endpoints

```
POST   /api/auth/login

GET    /api/accounts
POST   /api/accounts
DELETE /api/accounts/:id
GET    /api/accounts/:id/health
GET    /api/accounts/:id/usage
POST   /api/accounts/:id/warmup/restart

GET    /api/campaigns
POST   /api/campaigns
GET    /api/campaigns/:id
PATCH  /api/campaigns/:id/status
DELETE /api/campaigns/:id
GET    /api/campaigns/:id/logs

GET    /api/proxies
POST   /api/proxies
POST   /api/proxies/bulk            ← format: host:port:user:pass
PATCH  /api/proxies/:id/status
POST   /api/proxies/:id/assign/:accountId
DELETE /api/proxies/:id

GET    /api/schedule
POST   /api/schedule
DELETE /api/schedule/:id

GET    /api/analytics
GET    /api/analytics/account/:id   ← panggil platform API langsung

GET    /api/logs?type=[health|campaign]
GET    /api/logs/stream             ← Server-Sent Events (real-time)

GET    /api/oauth/:platform/url
GET    /api/oauth/callback/:platform
GET    /api/oauth/status/:platform
DELETE /api/oauth/:platform
```

### Halaman Panel

| Halaman | Fitur utama |
|---|---|
| **Accounts** | Tambah akun, warmup progress bar, health log, rate usage per action |
| **Campaigns** | Buat GROWTH/CONTENT/HYBRID, pause/resume/stop, progress bar, logs |
| **Scheduler** | Buat scheduled post (caption + media URL + hashtags + datetime), cancel |
| **Proxies** | Add single / bulk import (host:port:user:pass), assign ke akun, ban/unban |
| **Analytics** | Stats dashboard, active campaign progress, recent alerts, actions today |
| **Logs** | Unified feed health + campaign · toggle **live SSE stream** real-time |

---

## Rules yang Diterapkan

| Rule (dari roadmap) | Implementasi |
|---|---|
| Max 1 browser per akun | `_activeBrowsers Set` di `browser.js` |
| Browser close di `finally` | `session.cleanup()` di finally block |
| Cek rate limit sebelum action | `canAct()` di `executeAction()` |
| Log setiap action | `recordAction()` + `saveSession()` |
| Error → health event | `logEvent()` di catch + detection return |
| Semua delay `rand(min,max)` | `h.randInt()` di semua tempat |
| 1 proxy = 1 akun | `UNIQUE assigned_account_id` + enforcement di `assignProxy()` |
| Tidak share proxy | cek sebelum assign, throw jika sudah occupied |

---

## Cara Setup

```bash
# 1. Clone dan install
git clone https://github.com/Ferza-hub/nexus-social
cd nexus-social
npm install
npm rebuild better-sqlite3   # jika di Node.js v22

# 2. Konfigurasi
cp .env.example .env
# Edit .env: isi PANEL_PASSWORD + OAuth credentials platform yang dipakai

# 3. Init database
node src/database/setup.js

# 4. Start (development)
npm start

# 5. Start (production via PM2)
pm2 start ecosystem.config.js
pm2 save
pm2 startup

# Panel: http://localhost:3001
```

### Environment Variables

```env
PORT=3001
PANEL_PASSWORD=ganti_ini

# Meta / Instagram
META_APP_ID=
META_APP_SECRET=

# Twitter / X
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=

# Google / YouTube
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# TikTok
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=

# LinkedIn
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
```

---

## Test Suite

```bash
node test/smoke-test.js          # Phase 1 — 25 tests
node test/engine-unit-test.js    # Phase 2 — 12 tests
node test/phase3-unit-test.js    # Phase 3+4 — 24 tests
```

**Total: 61/61 tests pass** ✓

---

## Development Branch

```
ferza-hub/nexus-social → branch: claude/nexus-social-roadmap-ZBQ78
```

Commits:
1. `feat(phase-1)` — Account Manager foundation
2. `feat(phase-2)` — Playwright Engine
3. `feat(phase-3+4)` — API Engine + Web Panel
