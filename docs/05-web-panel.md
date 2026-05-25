# Web Panel

File: `src/panel/server.js` · `middleware/auth.js` · `routes/*.js` · `public/`

Web panel berbasis Express + vanilla HTML/CSS/JS tanpa build step. Berjalan pada port 3001 (default).

**URL akses:** `http://server-ip:3001`

---

## `src/panel/server.js`

Entry point Express application. Meng-compose semua middleware dan routes.

### Setup

```javascript
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../../public')));
```

### Route Mounting

| Path | Auth | Module |
|---|---|---|
| `POST /api/auth/login` | — | `loginHandler` |
| `/api/oauth/*` | — | `routes/oauth.js` (OAuth callback tidak boleh require auth) |
| `/api/accounts/*` | ✓ | `routes/accounts.js` |
| `/api/campaigns/*` | ✓ | `routes/campaigns.js` |
| `/api/proxies/*` | ✓ | `routes/proxies.js` |
| `/api/schedule/*` | ✓ | `routes/schedule.js` |
| `/api/analytics/*` | ✓ | `routes/analytics.js` |
| `/api/logs/*` | ✓ | `routes/logs.js` |
| `GET *` | — | SPA fallback → `public/index.html` |

### `startPanel()` → `void`

`app.listen(PORT)`. Dipanggil dari `src/index.js`.

---

## `src/panel/middleware/auth.js`

Token-based authentication menggunakan in-memory Set.

### Mekanisme

1. `POST /api/auth/login` dengan password → `generateToken()` → return token string
2. Semua request API selanjutnya harus sertakan token di:
   - Header: `X-Auth-Token: {token}`
   - Query param: `?token={token}`
3. Token disimpan di `Set` di memory process — hilang saat restart

### Exports

---

#### `loginHandler(req, res)`

Validasi `req.body.password` terhadap `process.env.PANEL_PASSWORD` (default: `nexus2024`).

**Request:**
```json
{ "password": "your-password" }
```

**Response (200):**
```json
{ "token": "a3f8c2..." }
```

**Response (401):**
```json
{ "error": "Invalid password" }
```

---

#### `requireAuth(req, res, next)`

Express middleware. Baca token dari `req.headers['x-auth-token']` atau `req.query.token`. Return 401 jika tidak valid.

---

#### `validateToken(token)` → `boolean`

Cek apakah token ada di `_tokens` Set.

---

#### `revokeToken(token)` → `void`

Hapus token dari Set (logout).

---

## API Routes

### `src/panel/routes/accounts.js`

| Method | Path | Deskripsi |
|---|---|---|
| `GET` | `/api/accounts` | List semua akun dengan warmup info dan api_connected status |
| `POST` | `/api/accounts` | Tambah akun baru |
| `DELETE` | `/api/accounts/:id` | Hapus akun (cascade delete sessions, rate_limits, dll) |
| `GET` | `/api/accounts/:id/health` | 50 health log terbaru |
| `GET` | `/api/accounts/:id/usage` | Rate limit usage saat ini per action type |
| `POST` | `/api/accounts/:id/warmup/restart` | Restart warmup schedule (mundur 7 hari) |
| `GET` | `/api/accounts/alerts/all` | Semua event negatif dalam 24 jam terakhir |

**`GET /api/accounts` response:**
```javascript
[{
  id, username, platform, status, email, phone,
  proxy_id, warmup_day, notes, created_at, updated_at, last_active_at,
  // password dan two_fa_secret TIDAK dikembalikan
  warmup: { current_day, current_phase, max_likes_day, ... } | null,
  api_connected: boolean  // true jika ada oauth_tokens record
}]
```

**`POST /api/accounts` body:**
```json
{
  "username": "myaccount",
  "password": "secret",
  "platform": "instagram",
  "email": "optional@example.com",
  "phone": "optional",
  "twoFaSecret": "JBSWY3DPEHPK3PXP",
  "proxyId": 5,
  "notes": "optional"
}
```

---

### `src/panel/routes/campaigns.js`

| Method | Path | Deskripsi |
|---|---|---|
| `GET` | `/api/campaigns` | List campaigns (filter by `?status=`) |
| `POST` | `/api/campaigns` | Buat campaign baru |
| `GET` | `/api/campaigns/:id` | Detail satu campaign |
| `PATCH` | `/api/campaigns/:id/status` | Update status campaign |
| `GET` | `/api/campaigns/:id/logs` | Action logs campaign |
| `DELETE` | `/api/campaigns/:id` | Hapus campaign |

**`POST /api/campaigns` body:**
```json
{
  "name": "My Growth Campaign",
  "accountId": 1,
  "platform": "instagram",
  "type": "growth",
  "config": {
    "action": "follow",
    "target": { "type": "hashtag", "value": "photography" },
    "dailyGoal": 20
  },
  "targetCount": 500
}
```

**`PATCH /api/campaigns/:id/status` body:**
```json
{ "status": "running" }
```

Status yang valid: `draft` → `running` → `paused` → `completed` | `failed`.

---

### `src/panel/routes/proxies.js`

| Method | Path | Deskripsi |
|---|---|---|
| `GET` | `/api/proxies` | List semua proxy |
| `POST` | `/api/proxies` | Tambah satu proxy |
| `POST` | `/api/proxies/bulk` | Import banyak proxy sekaligus |
| `PATCH` | `/api/proxies/:id/status` | Update status proxy |
| `POST` | `/api/proxies/:id/assign/:accountId` | Assign proxy ke akun |
| `DELETE` | `/api/proxies/:id` | Hapus proxy |

**`POST /api/proxies` body:**
```json
{
  "host": "123.456.789.0",
  "port": 1080,
  "username": "proxyuser",
  "password": "proxypass",
  "protocol": "socks5"
}
```

**`POST /api/proxies/bulk` body:**

Format teks, satu proxy per baris: `host:port:username:password`

```
123.456.789.0:1080:user1:pass1
234.567.890.1:3128:user2:pass2
```

`username` dan `password` opsional (format minimal: `host:port`).

---

### `src/panel/routes/schedule.js`

| Method | Path | Deskripsi |
|---|---|---|
| `GET` | `/api/schedule` | List post queue (filter by `?accountId=`, `?status=`) |
| `POST` | `/api/schedule` | Schedule post baru |
| `DELETE` | `/api/schedule/:id` | Cancel scheduled post |

**`POST /api/schedule` body:**
```json
{
  "accountId": 1,
  "platform": "instagram",
  "content": {
    "type": "photo",
    "caption": "Hello world!",
    "mediaUrls": ["https://example.com/img.jpg"],
    "hashtags": ["travel", "photography"]
  },
  "scheduledAt": "2026-05-26T10:00:00Z",
  "campaignId": null
}
```

---

### `src/panel/routes/analytics.js`

| Method | Path | Deskripsi |
|---|---|---|
| `GET` | `/api/analytics` | Dashboard stats agregat |
| `GET` | `/api/analytics/account/:id` | Fetch analytics langsung dari platform API |

**`GET /api/analytics` response (stats dashboard):**
```javascript
{
  totalAccounts: number,
  activeAccounts: number,
  warmingAccounts: number,
  flaggedAccounts: number,
  runningCampaigns: number,
  pendingPosts: number,
  actionsToday: {
    follow: number,
    like: number,
    comment: number,
    // ... per action type
  },
  recentAlerts: Alert[]  // getAlerts() — 24 jam terakhir
}
```

**`GET /api/analytics/account/:id`** memanggil `getAnalytics(accountId, platform)` dari API Engine. Membutuhkan OAuth token aktif.

---

### `src/panel/routes/logs.js`

| Method | Path | Deskripsi |
|---|---|---|
| `GET` | `/api/logs` | Unified activity feed |
| `GET` | `/api/logs/stream` | Server-Sent Events (real-time) |

**`GET /api/logs` query params:**

| Param | Nilai | Deskripsi |
|---|---|---|
| `type` | `health` \| `campaign` \| (tidak ada) | Filter source. Default: combined |
| `platform` | string | Filter by platform |
| `limit` | number (max 500) | Jumlah baris (default 100) |

**Response format (combined):**
```javascript
[{
  source: 'health' | 'campaign',
  id: number,
  account_id: number,
  username: string,
  platform: string,
  action: string,     // event_type (health) atau action name (campaign)
  status: string,     // '' untuk health, 'success'|'failed'|... untuk campaign
  message: string,
  created_at: string
}]
```

**`GET /api/logs/stream` — Server-Sent Events:**

Koneksi persistent yang mengirim events real-time.

```javascript
// Client-side usage:
const es = new EventSource('/api/logs/stream?token=xxx');
es.onmessage = (e) => {
  const log = JSON.parse(e.data);
  console.log(log.event_type, log.message);
};
```

**Implementasi:** Poll `health_logs WHERE id > lastId` setiap 2 detik. Kirim baris baru sebagai `data: {JSON}\n\n`. Clear interval saat `req.on('close')`.

---

### `src/panel/routes/oauth.js`

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| `GET` | `/api/oauth/:platform/url` | ✓ | Generate OAuth authorization URL |
| `GET` | `/api/oauth/callback/:platform` | — | Handle OAuth callback dari platform |
| `GET` | `/api/oauth/status/:platform` | ✓ | Cek status token (valid/expired/missing) |
| `DELETE` | `/api/oauth/:platform` | ✓ | Hapus token (disconnect platform) |

**`GET /api/oauth/:platform/url?accountId=1`:**
```json
{ "url": "https://instagram.com/oauth/authorize?..." }
```

**`GET /api/oauth/callback/:platform?code=xxx&state=xxx`:**
- Tukar code dengan token via `handleCallback()`
- Redirect ke `/` (panel) dengan sukses

**`GET /api/oauth/status/:platform?accountId=1`:**
```json
{
  "connected": true,
  "isExpired": false,
  "expires_at": "2026-07-20T10:00:00.000Z"
}
```

---

## Frontend (`public/`)

SPA vanilla HTML/CSS/JS tanpa build step atau framework.

### `public/index.html`

Shell SPA dengan struktur:
- `<nav>` sidebar dengan link ke setiap halaman
- `<main id="app">` container untuk konten halaman
- `#modal-overlay` untuk modal dialog
- `#toast-container` untuk notifikasi
- Script tags: `api.js` → `modal.js` → `toast.js` → `app.js` → semua page files

---

### `public/css/app.css`

Dark theme GitHub-inspired menggunakan CSS custom properties:

```css
--bg-0:   #0d1117  /* Background utama */
--bg-1:   #161b22  /* Card/panel background */
--bg-2:   #21262d  /* Input/table row background */
--border: #30363d  /* Border color */
--text-1: #c9d1d9  /* Primary text */
--text-2: #8b949e  /* Secondary text */
--accent: #388bfd  /* Brand accent (blue) */
--green:  #3fb950
--red:    #f85149
--yellow: #d29922
```

**Komponen yang di-style:** badges (status colors), buttons, tables, modal overlay, toast notifications, log entries (color per event type), progress bars, form inputs.

---

### `public/js/api.js`

`API` singleton untuk semua komunikasi dengan backend.

**Token storage:** `localStorage['nx_token']`

```javascript
API.login(password)              // POST /api/auth/login, simpan token
API.get(path)                    // GET /api/{path} dengan auth header
API.post(path, body)             // POST /api/{path}
API.patch(path, body)            // PATCH /api/{path}
API.delete(path)                 // DELETE /api/{path}
API.getToken()                   // Return stored token
API.clearToken()                 // Logout — hapus token dari localStorage
```

Semua method return `Promise`. Throw jika response non-2xx.

---

### `public/js/app.js`

SPA router sederhana.

```javascript
const PAGES = {
  accounts:  () => AccountsPage.render(),
  campaigns: () => CampaignsPage.render(),
  scheduler: () => SchedulerPage.render(),
  proxies:   () => ProxiesPage.render(),
  analytics: () => AnalyticsPage.render(),
  logs:      () => LogsPage.render(),
};

navigate(page)  // Load page ke #app container
```

**Login flow:** Jika tidak ada token di localStorage, tampilkan login form. Setelah sukses, redirect ke `accounts`.

---

### `public/js/components/modal.js`

```javascript
Modal.open(title, htmlContent)   // Tampilkan modal dengan konten HTML
Modal.close()                    // Tutup modal
Modal.confirm(message, callback) // Konfirmasi dialog dengan tombol Yes/No
```

---

### `public/js/components/toast.js`

Notifikasi non-blocking yang auto-dismiss setelah 3 detik:

```javascript
Toast.success(message)  // Green toast
Toast.error(message)    // Red toast
Toast.info(message)     // Blue toast
```

---

### Halaman Frontend

| File | Fitur Utama |
|---|---|
| `pages/accounts.js` | Table akun dengan status badge; form tambah akun; warmup progress bar; modal detail (health logs + rate usage) |
| `pages/campaigns.js` | Table campaign dengan progress bar; form buat campaign (GROWTH/CONTENT/HYBRID); tombol pause/resume/stop; modal logs |
| `pages/scheduler.js` | Calendar-style list scheduled posts; form jadwal post (caption + media URL + hashtags + datetime); tombol cancel |
| `pages/proxies.js` | Table proxy dengan status; form tambah single/bulk import; tombol assign ke akun; ban/unban |
| `pages/analytics.js` | Stats cards (total akun, aktif, warning); running campaigns progress; recent alerts table; actions today per type |
| `pages/logs.js` | Unified log feed dengan filter; tombol toggle SSE live stream; color-coded per event type |

---

## Cara Akses Panel

```bash
# Start server
npm start

# Akses via browser
http://localhost:3001

# Login dengan password dari .env
PANEL_PASSWORD=your_password_here
```

**Default password:** `nexus2024` (ganti sebelum deploy ke production via `PANEL_PASSWORD` env var).
