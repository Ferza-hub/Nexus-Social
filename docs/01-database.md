# Database Layer

File: `src/database/db.js` · `src/database/schema.js` · `src/database/setup.js`

---

## `src/database/db.js`

Singleton SQLite connection. Menggunakan WAL journal mode dan foreign keys enabled.

### Exports

---

### `getDb()` → `Database`

Mengembalikan instance SQLite yang aktif. Membuat koneksi baru jika belum ada.

**Behavior:**
- Membuat direktori `data/` jika belum ada
- Membuka file DB dari `process.env.DB_PATH` (default: `data/nexus.db`)
- Set `PRAGMA journal_mode = WAL`
- Set `PRAGMA foreign_keys = ON`
- Set `PRAGMA synchronous = NORMAL`
- Singleton — hanya satu instance sepanjang process lifecycle

**Returns:** `Database` — instance better-sqlite3

**Example:**
```javascript
const { getDb } = require('./database/db');
const db = getDb();
const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(1);
```

---

### `closeDb()` → `void`

Menutup koneksi SQLite dan reset singleton ke `null`.

Dipanggil pada `SIGINT` / `SIGTERM` di `src/index.js`.

**Example:**
```javascript
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
```

---

## `src/database/schema.js`

DDL untuk semua tabel dan index. Menggunakan `CREATE TABLE IF NOT EXISTS` sehingga aman dijalankan berulang kali (idempotent).

### Exports

---

### `runMigrations(db)` → `void`

Menjalankan seluruh DDL schema. Dipanggil di startup dan di test suite.

| Parameter | Type | Deskripsi |
|---|---|---|
| `db` | `Database` | Instance better-sqlite3 dari `getDb()` |

**Example:**
```javascript
const { getDb } = require('./database/db');
const { runMigrations } = require('./database/schema');

const db = getDb();
runMigrations(db); // buat semua tabel jika belum ada
```

---

### Tabel: `accounts`

Menyimpan kredensial dan status setiap akun sosial media.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `username` | TEXT NOT NULL | Username akun |
| `password` | TEXT NOT NULL | Password (plain — enkripsi opsional di level aplikasi) |
| `email` | TEXT | Email akun |
| `phone` | TEXT | Nomor telepon |
| `platform` | TEXT NOT NULL | `instagram` \| `tiktok` \| `twitter` \| `youtube` \| `facebook` \| `threads` |
| `status` | TEXT DEFAULT `new` | `new` \| `warming` \| `active` \| `flagged` \| `recovery` \| `disabled` |
| `proxy_id` | INTEGER FK | Referensi ke `proxies.id` |
| `two_fa_secret` | TEXT | Base32 TOTP secret untuk 2FA |
| `warmup_day` | INTEGER DEFAULT 0 | Hari warmup saat ini |
| `notes` | TEXT | Catatan bebas |
| `created_at` | DATETIME | Waktu dibuat |
| `updated_at` | DATETIME | Waktu update terakhir |
| `last_active_at` | DATETIME | Waktu terakhir aktif |

---

### Tabel: `proxies`

Proxy dedicated per akun. Satu proxy **tidak boleh** digunakan lebih dari satu akun.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `host` | TEXT NOT NULL | IP atau hostname proxy |
| `port` | INTEGER NOT NULL | Port |
| `username` | TEXT | Auth username |
| `password` | TEXT | Auth password |
| `protocol` | TEXT DEFAULT `http` | `http` \| `https` \| `socks5` |
| `status` | TEXT DEFAULT `active` | `active` \| `inactive` \| `banned` |
| `assigned_account_id` | INTEGER UNIQUE | FK ke `accounts.id` — UNIQUE memastikan 1 proxy = 1 akun |
| `created_at` | DATETIME | — |
| `last_checked_at` | DATETIME | Waktu terakhir dicek |

---

### Tabel: `sessions`

Menyimpan path ke file `storageState` Playwright per akun per platform.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `account_id` | INTEGER NOT NULL FK | Referensi ke `accounts.id` (CASCADE DELETE) |
| `platform` | TEXT NOT NULL | Platform name |
| `storage_state_path` | TEXT NOT NULL | Path absolut ke file JSON storageState |
| `is_valid` | INTEGER DEFAULT 1 | `1` = valid, `0` = expired/invalidated |
| `created_at` | DATETIME | — |
| `updated_at` | DATETIME | — |
| `expires_at` | DATETIME | Tanggal session expire (default 29 hari) |

**Constraint:** `UNIQUE(account_id, platform)`

---

### Tabel: `rate_limits`

Counter aksi per akun per platform per action type. Direset otomatis tiap jam dan tiap hari.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `account_id` | INTEGER NOT NULL FK | — |
| `platform` | TEXT NOT NULL | — |
| `action_type` | TEXT NOT NULL | `follow` \| `unfollow` \| `like` \| `comment` \| `story_view` \| `dm` \| `watch_reel` |
| `hour_count` | INTEGER DEFAULT 0 | Aksi dalam 1 jam terakhir |
| `day_count` | INTEGER DEFAULT 0 | Aksi dalam 1 hari terakhir |
| `hour_reset_at` | DATETIME | Waktu reset counter jam |
| `day_reset_at` | DATETIME | Waktu reset counter hari |
| `last_action_at` | DATETIME | Waktu aksi terakhir |

**Constraint:** `UNIQUE(account_id, platform, action_type)`

---

### Tabel: `health_logs`

Log setiap event kesehatan akun. Digunakan untuk deteksi early warning dan audit trail.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `account_id` | INTEGER NOT NULL FK | — |
| `platform` | TEXT NOT NULL | — |
| `event_type` | TEXT NOT NULL | `ok` \| `challenge` \| `captcha` \| `action_block` \| `unusual_activity` \| `disabled` \| `login_required` \| `warning` |
| `message` | TEXT | Pesan detail opsional |
| `created_at` | DATETIME | — |

---

### Tabel: `warmup_schedules`

Jadwal warmup dan batas aksi per hari untuk akun baru.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `account_id` | INTEGER NOT NULL FK | — |
| `platform` | TEXT NOT NULL | — |
| `started_at` | DATETIME | Tanggal warmup dimulai |
| `current_day` | INTEGER DEFAULT 1 | Hari warmup saat ini (1–15+) |
| `current_phase` | TEXT DEFAULT `login_only` | `login_only` \| `light` \| `medium` \| `full` |
| `max_likes_day` | INTEGER DEFAULT 0 | Batas like per hari di fase ini |
| `max_follows_day` | INTEGER DEFAULT 0 | Batas follow per hari |
| `max_comments_day` | INTEGER DEFAULT 0 | Batas comment per hari |
| `completed` | INTEGER DEFAULT 0 | `1` jika sudah lulus ke full automation |

**Constraint:** `UNIQUE(account_id, platform)`

---

### Tabel: `oauth_tokens`

Token OAuth API per akun per platform.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `account_id` | INTEGER NOT NULL FK | — |
| `platform` | TEXT NOT NULL | — |
| `access_token` | TEXT NOT NULL | Bearer token |
| `refresh_token` | TEXT | Refresh token (null jika platform tidak support) |
| `expires_at` | DATETIME | Waktu token expire |
| `scope` | TEXT | OAuth scopes yang disetujui |
| `meta_json` | TEXT | Data tambahan platform-specific (e.g. TikTok `open_id`) |
| `updated_at` | DATETIME | — |

**Constraint:** `UNIQUE(account_id, platform)`

---

### Tabel: `campaigns`

Campaign automation (growth / content / hybrid).

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `name` | TEXT NOT NULL | Nama campaign |
| `account_id` | INTEGER NOT NULL FK | Akun yang menjalankan |
| `platform` | TEXT NOT NULL | Target platform |
| `type` | TEXT NOT NULL | `growth` \| `content` \| `hybrid` |
| `status` | TEXT DEFAULT `draft` | `draft` \| `running` \| `paused` \| `completed` \| `failed` |
| `config_json` | TEXT DEFAULT `{}` | Konfigurasi campaign (lihat format di runner.js) |
| `target_count` | INTEGER | Target jumlah aksi (null = unlimited) |
| `completed_count` | INTEGER DEFAULT 0 | Aksi yang sudah berhasil |
| `started_at` | DATETIME | Set saat status → running |
| `completed_at` | DATETIME | Set saat status → completed/failed |

---

### Tabel: `campaign_logs`

Log setiap aksi individual dalam campaign.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `campaign_id` | INTEGER NOT NULL FK | — |
| `account_id` | INTEGER NOT NULL | — |
| `action` | TEXT NOT NULL | Nama aksi yang dijalankan |
| `status` | TEXT NOT NULL | `success` \| `failed` \| `skipped` \| `blocked` |
| `message` | TEXT | Detail tambahan |
| `created_at` | DATETIME | — |

---

### Tabel: `post_queue`

Queue post yang dijadwalkan untuk dipublish via API engine.

| Kolom | Type | Deskripsi |
|---|---|---|
| `id` | INTEGER PK | — |
| `account_id` | INTEGER NOT NULL FK | — |
| `platform` | TEXT NOT NULL | — |
| `campaign_id` | INTEGER FK | Campaign terkait (nullable) |
| `content_json` | TEXT NOT NULL | Object konten (lihat format di `publishPost`) |
| `scheduled_at` | DATETIME NOT NULL | Waktu eksekusi |
| `status` | TEXT DEFAULT `pending` | `pending` \| `running` \| `done` \| `failed` \| `cancelled` |
| `retry_count` | INTEGER DEFAULT 0 | Jumlah retry yang sudah dilakukan |
| `max_retries` | INTEGER DEFAULT 3 | Maksimum retry sebelum permanent failed |
| `result_json` | TEXT | Result dari publish (e.g. `{ postId: "123" }`) |

---

### Index

| Index | Tabel | Kolom |
|---|---|---|
| `idx_accounts_platform_status` | accounts | platform, status |
| `idx_rate_limits_account` | rate_limits | account_id, platform |
| `idx_health_logs_account` | health_logs | account_id, created_at |
| `idx_sessions_account` | sessions | account_id, is_valid |
| `idx_campaigns_status` | campaigns | status, platform |
| `idx_post_queue_scheduled` | post_queue | scheduled_at, status |
| `idx_campaign_logs_campaign` | campaign_logs | campaign_id, created_at |

---

## `src/database/setup.js`

CLI runner untuk inisialisasi database.

```bash
node src/database/setup.js
```

Urutan: `getDb()` → `runMigrations(db)` → `closeDb()`. Aman dijalankan berkali-kali (idempotent).

---

## `src/utils/logger.js`

Structured logger sederhana tanpa dependency eksternal.

### `makeLogger(context)` → `Logger`

Membuat logger instance dengan context prefix tetap.

| Parameter | Type | Deskripsi |
|---|---|---|
| `context` | `string` | Label yang muncul di setiap log line, e.g. `'SessionManager'` |

**Returns:** Object dengan method `error`, `warn`, `info`, `debug`.

**Format output:**
```
[2026-05-24 19:16:31] [INFO] [SessionManager] Session saved {"accountId":1,"platform":"instagram"}
```

**Log levels** (dikontrol via `process.env.LOG_LEVEL`):

| Level | Value | Tampil jika LOG_LEVEL ≥ |
|---|---|---|
| `error` | 0 | selalu |
| `warn` | 1 | `warn` |
| `info` | 2 | `info` (default) |
| `debug` | 3 | `debug` |

**Methods:**

| Method | Signature | Deskripsi |
|---|---|---|
| `error` | `(msg, meta?)` | Error kritis |
| `warn` | `(msg, meta?)` | Warning |
| `info` | `(msg, meta?)` | Info umum |
| `debug` | `(msg, meta?)` | Debug detail |

`meta` — object opsional, di-serialize ke JSON dan di-append ke log line.

**Example:**
```javascript
const { makeLogger } = require('./utils/logger');
const log = makeLogger('MyModule');

log.info('Starting', { accountId: 1 });
// [2026-05-24 10:00:00] [INFO] [MyModule] Starting {"accountId":1}

log.error('Failed', { err: 'timeout' });
// [2026-05-24 10:00:01] [ERROR] [MyModule] Failed {"err":"timeout"}
```
