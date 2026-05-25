# Account Manager

File: `src/account-manager/index.js` · `session-manager.js` · `rate-limiter.js` · `warmup-scheduler.js` · `health-monitor.js`

Account Manager adalah **layer pertama dan paling kritis**. Semua operasi harus melewati `canAct()` sebelum menjalankan aksi apapun.

---

## `src/account-manager/index.js`

Public API surface Account Manager. Import dari sini, bukan dari modul internal.

```javascript
const am = require('./account-manager/index');
```

### Account CRUD

---

#### `addAccount(options)` → `number`

Menambah akun baru ke database dan menginisialisasi warmup schedule.

| Parameter | Type | Required | Deskripsi |
|---|---|---|---|
| `username` | string | ✓ | Username akun |
| `password` | string | ✓ | Password |
| `email` | string | — | Email |
| `phone` | string | — | Nomor telepon |
| `platform` | string | ✓ | `instagram` \| `tiktok` \| `twitter` \| `youtube` \| `facebook` \| `threads` |
| `proxyId` | number | — | ID proxy dari tabel `proxies` |
| `twoFaSecret` | string | — | TOTP base32 secret |
| `notes` | string | — | Catatan |

**Returns:** `number` — ID akun yang baru dibuat

**Side effects:**
- Insert ke tabel `accounts` dengan `status = 'new'`
- Memanggil `warmup.initWarmup(accountId, platform)` → insert ke `warmup_schedules`, set status → `'warming'`

**Example:**
```javascript
const id = am.addAccount({
  username: 'myaccount',
  password: 'secret123',
  platform: 'instagram',
  twoFaSecret: 'JBSWY3DPEHPK3PXP',
});
```

---

#### `getAccount(accountId)` → `Account | undefined`

Mengambil satu akun berdasarkan ID.

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |

**Returns:** Row dari tabel `accounts` atau `undefined` jika tidak ada.

---

#### `listAccounts(platform?, status?)` → `Account[]`

Mengambil daftar akun dengan filter opsional.

| Parameter | Type | Deskripsi |
|---|---|---|
| `platform` | string \| null | Filter by platform |
| `status` | string \| null | Filter by status |

**Returns:** Array of account rows, diurutkan by `created_at DESC`.

**Example:**
```javascript
const active = am.listAccounts('instagram', 'active');
const all    = am.listAccounts();
```

---

### Proxy Management

---

#### `addProxy(options)` → `number`

Menambah proxy baru.

| Parameter | Type | Required | Deskripsi |
|---|---|---|---|
| `host` | string | ✓ | IP atau hostname |
| `port` | number | ✓ | Port |
| `username` | string | — | Auth username |
| `password` | string | — | Auth password |
| `protocol` | string | — | `http` (default) \| `https` \| `socks5` |

**Returns:** `number` — ID proxy yang baru dibuat.

---

#### `assignProxy(accountId, proxyId)` → `void`

Assign proxy ke akun. **Memastikan 1 proxy = 1 akun** — throw `Error` jika proxy sudah assigned ke akun lain.

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |
| `proxyId` | number | ID proxy |

**Throws:** `Error` jika proxy sudah assigned ke akun lain.

**Example:**
```javascript
try {
  am.assignProxy(1, 5);
} catch (err) {
  console.log(err.message); // "Proxy 5 is already assigned to account 3"
}
```

---

#### `getProxyForAccount(accountId)` → `Proxy | undefined`

Mengambil proxy yang di-assign ke akun. Hanya mengembalikan proxy dengan `status = 'active'`.

---

### Pre-Action Gate

---

#### `canAct(accountId, platform, actionType)` → `GateResult`

**Pintu masuk utama sebelum setiap aksi.** Memeriksa:

1. Apakah akun ada
2. Status akun (`disabled` → block, `flagged` → block)
3. Jika `status = 'warming'`: cek warmup phase cap
4. Rate limit (hour + day counter)

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |
| `platform` | string | Platform |
| `actionType` | string | `follow` \| `unfollow` \| `like` \| `comment` \| `story_view` \| `dm` \| `watch_reel` |

**Returns:** `GateResult`

```typescript
type GateResult =
  | { allowed: true;  hourCount: number; dayCount: number }
  | { allowed: false; reason: string;    cap?: number; count?: number; phase?: string }
```

**Reasons untuk `allowed: false`:**

| Reason | Penyebab |
|---|---|
| `account_not_found` | ID tidak ada di DB |
| `account_disabled` | Status `disabled` |
| `account_flagged` | Status `flagged` |
| `warmup_phase_restricts_action` | Action tidak diizinkan di fase warmup saat ini |
| `warmup_daily_cap` | Sudah mencapai batas hari untuk fase warmup |
| `hour_limit` | Sudah mencapai batas per jam |
| `day_limit` | Sudah mencapai batas per hari |

**Example:**
```javascript
const result = am.canAct(1, 'instagram', 'follow');
if (!result.allowed) {
  console.log(`Blocked: ${result.reason}`);
  return;
}
// safe to proceed
```

---

### Re-exported Sub-modules

```javascript
am.session  // session-manager module
am.limits   // rate-limiter module
am.warmup   // warmup-scheduler module
am.health   // health-monitor module
```

---

## `src/account-manager/session-manager.js`

Mengelola Playwright `storageState` per akun. Setiap session disimpan sebagai file JSON di `data/sessions/{platform}/{accountId}.json`.

### Exports

---

#### `saveSession(accountId, platform, storageState)` → `string`

Menyimpan storageState Playwright ke disk dan update record di DB.

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |
| `platform` | string | Platform |
| `storageState` | object | Object storageState dari `context.storageState()` |

**Returns:** `string` — Path file yang disimpan.

**Side effects:**
- Tulis file JSON ke `data/sessions/{platform}/{accountId}.json`
- Upsert record di tabel `sessions` dengan `expires_at = now + 29 hari`
- Update `accounts.last_active_at`

---

#### `loadSession(accountId, platform)` → `StorageState | null`

Load storageState dari disk. Validasi sebelum mengembalikan.

Mengembalikan `null` jika:
- Tidak ada record di DB
- `is_valid = 0`
- Session sudah expire (`expires_at <= now`)
- File tidak ada di disk
- File JSON tidak bisa di-parse

**Side effects jika invalid:** memanggil `invalidateSession()`.

---

#### `invalidateSession(accountId, platform)` → `void`

Tandai session sebagai invalid dan set status akun ke `'flagged'`.

Dipanggil otomatis oleh `loadSession()` saat session tidak valid, atau secara manual saat deteksi challenge/disabled.

---

#### `getExpiringAccounts(withinDays?)` → `Account[]`

Mengembalikan akun yang sessionnya akan expire dalam `withinDays` hari ke depan.

| Parameter | Type | Default | Deskripsi |
|---|---|---|---|
| `withinDays` | number | `3` | Threshold hari |

Digunakan untuk proactive session refresh sebelum expire.

---

#### `deleteSession(accountId, platform)` → `void`

Hapus file session dari disk dan hapus record dari DB. Digunakan saat akun dihapus.

---

## `src/account-manager/rate-limiter.js`

Tracking counter aksi per akun per platform dengan reset otomatis setiap jam dan setiap hari.

### Konstanta

```javascript
const LIMITS = {
  follow:      { hour: 20,  day: 150 },
  unfollow:    { hour: 20,  day: 150 },
  like:        { hour: 50,  day: 300 },
  comment:     { hour: 15,  day: 100 },
  story_view:  { hour: null, day: 500 },
  dm:          { hour: null, day: 50  },
  watch_reel:  { hour: null, day: 500 },
};
```

`null` berarti tidak ada limit untuk interval tersebut.

### Exports

---

#### `canPerform(accountId, platform, actionType)` → `RateResult`

Cek apakah aksi diizinkan berdasarkan counter saat ini. **Tidak** mengincrement counter.

Sebelum cek, otomatis reset counter jika window sudah lewat.

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |
| `platform` | string | Platform |
| `actionType` | string | Tipe aksi |

**Returns:**
```typescript
type RateResult =
  | { allowed: true;  hourCount: number; dayCount: number }
  | { allowed: false; reason: 'hour_limit' | 'day_limit'; count: number; limit: number }
```

---

#### `recordAction(accountId, platform, actionType)` → `{ hour_count, day_count }`

Increment counter jam dan hari untuk aksi. Dipanggil **setelah** aksi berhasil.

Otomatis membuat row baru di `rate_limits` jika belum ada (`INSERT OR IGNORE`).

---

#### `reduceQuota(accountId, platform, actionType, percent?)` → `void`

Paksa `day_count` ke nilai yang memotong sisa kuota sebesar `percent%`.

Dipanggil otomatis saat `health-monitor` mendeteksi `action_block`.

| Parameter | Type | Default | Deskripsi |
|---|---|---|---|
| `accountId` | number | — | — |
| `platform` | string | — | — |
| `actionType` | string | — | — |
| `percent` | number | `50` | Persentase pengurangan |

**Contoh:** `reduceQuota(1, 'instagram', 'follow', 50)` dengan limit 150/hari akan set `day_count = 75`, tersisa hanya 75 follow.

---

#### `getUsage(accountId, platform)` → `UsageMap`

Mengembalikan penggunaan saat ini untuk semua action types.

**Returns:**
```javascript
{
  follow: {
    hour: { count: 5, limit: 20, reset_at: '...' },
    day:  { count: 30, limit: 150, reset_at: '...' },
    last_action_at: '2026-05-24T10:00:00.000Z'
  },
  like: { ... },
  // ...
}
```

---

## `src/account-manager/warmup-scheduler.js`

State machine warmup untuk akun baru. Akun baru **wajib** melewati warmup sebelum full automation.

### Warmup Phases

| Phase | Hari | Max Like/hari | Max Follow/hari | Max Comment/hari |
|---|---|---|---|---|
| `login_only` | 1–3 | 0 | 0 | 0 |
| `light` | 4–7 | 15 | 10 | 0 |
| `medium` | 8–14 | 50 | 50 | 5 |
| `full` | 15+ | (quota normal) | (quota normal) | (quota normal) |

### Exports

---

#### `initWarmup(accountId, platform)` → `void`

Inisialisasi warmup schedule untuk akun baru. Dipanggil otomatis oleh `addAccount()`.

- Insert row ke `warmup_schedules` dengan `current_day = 1`, `current_phase = 'login_only'`
- Set `accounts.status = 'warming'`

---

#### `advanceWarmupDay(accountId, platform)` → `WarmupRow | null`

Naikkan satu hari warmup dan update phase jika perlu.

Dipanggil oleh `runDailyAdvancement()` setiap tengah malam.

**Side effects jika hari ≥ 15:**
- Set `warmup_schedules.completed = 1`
- Set `accounts.status = 'active'`

**Returns:** Row `warmup_schedules` yang sudah diupdate, atau `null` jika tidak ada warmup aktif.

---

#### `runDailyAdvancement()` → `void`

Loop semua akun dengan `status = 'warming'` dan panggil `advanceWarmupDay()` untuk masing-masing.

Dipanggil oleh cron `0 0 * * *` (setiap tengah malam) di `health-monitor.js`.

---

#### `getWarmupLimits(accountId, platform)` → `WarmupLimits | null`

Mengambil batas aksi saat ini berdasarkan fase warmup.

**Returns `null` jika:** akun tidak dalam warmup atau sudah `completed`.

**Returns:**
```javascript
{
  phase: 'light',
  day: 5,
  maxLikes: 15,
  maxFollows: 10,
  maxComments: 0
}
```

---

#### `restartWarmup(accountId, platform)` → `void`

Reset warmup setelah recovery. Mundur 7 hari dari posisi saat ini (minimum hari 1).

Dipanggil oleh `health-monitor.js` saat akun flagged sudah 24 jam.

---

#### `phaseForDay(day)` → `Phase`

Helper murni — mengembalikan phase untuk hari tertentu.

```javascript
phaseForDay(1)  // { name: 'login_only', minDay: 1, maxDay: 3, likes: 0, ... }
phaseForDay(5)  // { name: 'light', ... }
phaseForDay(10) // { name: 'medium', ... }
phaseForDay(20) // { name: 'full', ... }
```

---

## `src/account-manager/health-monitor.js`

Monitor kesehatan akun dengan cron setiap 30 menit. Merespons events secara otomatis untuk melindungi akun dari ban.

### Auto-Response per Event

| Event | Response |
|---|---|
| `challenge` | `setStatus('flagged')` + `invalidateSession()` |
| `captcha` | `setStatus('flagged')` + `invalidateSession()` |
| `action_block` | `reduceQuota(50%)` untuk semua action types |
| `unusual_activity` | `setStatus('flagged')` (pause 24 jam) |
| `disabled` | `setStatus('disabled')` + `invalidateSession()` |
| `login_required` | `invalidateSession()` |

### Exports

---

#### `logEvent(accountId, platform, eventType, message?)` → `void`

Catat event kesehatan dan trigger response otomatis jika bukan `'ok'`.

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |
| `platform` | string | Platform |
| `eventType` | string | `ok` \| `challenge` \| `captcha` \| `action_block` \| `unusual_activity` \| `disabled` \| `login_required` \| `warning` |
| `message` | string | Pesan detail opsional |

**Side effects:** Insert ke `health_logs`, trigger auto-response handler jika bukan `'ok'`.

**Example:**
```javascript
// Dari platform module saat deteksi challenge
am.health.logEvent(accountId, 'instagram', 'action_block', 'Follow action blocked');

// Heartbeat normal
am.health.logEvent(accountId, 'instagram', 'ok');
```

---

#### `runHealthCheck()` → `void`

Satu siklus health check:
1. Ambil semua akun `status IN ('active', 'warming')`
2. Cek event negatif dalam 30 menit terakhir
3. Log heartbeat `'ok'` untuk akun yang bersih
4. Panggil `recoverFlaggedAccounts()`

---

#### `getAccountHealth(accountId, platform, limit?)` → `HealthLog[]`

Mengambil riwayat event kesehatan terbaru untuk satu akun.

| Parameter | Type | Default | Deskripsi |
|---|---|---|---|
| `accountId` | number | — | — |
| `platform` | string | — | — |
| `limit` | number | `20` | Jumlah event yang dikembalikan |

---

#### `getAlerts()` → `Alert[]`

Mengambil semua event negatif dalam 24 jam terakhir, di-join dengan data akun.

Digunakan oleh panel analytics dan `/api/accounts/alerts/all`.

---

#### `startMonitor()` → `void`

Mulai semua cron jobs:

| Cron | Schedule | Job |
|---|---|---|
| Health check | `process.env.HEALTH_CHECK_CRON` (default: `*/30 * * * *`) | `runHealthCheck()` |
| Warmup advancement | `0 0 * * *` (tengah malam) | `runDailyAdvancement()` |

Aman dipanggil berkali-kali (guard `_started` flag).
