# API Engine

File: `src/api-engine/index.js` · `oauth/index.js` · `oauth/{platform}.js` · `actions/post.js` · `actions/analytics.js` · `actions/engagement.js` · `scheduler/queue.js` · `scheduler/runner.js`

API Engine mengelola OAuth tokens, publishing konten via platform API resmi, dan scheduler untuk post queue + campaign automation.

---

## `src/api-engine/index.js`

Public surface API Engine. Import dari sini.

```javascript
const api = require('./api-engine/index');
```

### Exports

```javascript
api.oauth          // Token manager (saveToken, loadToken, getValidToken, ...)
api.publishPost    // Immediate publish via platform API
api.schedulePost   // Add to post_queue
api.deletePost     // Delete existing post
api.getAnalytics   // Platform analytics (followers, reach, impressions)
api.getFollowers   // Follower list
api.replyComment   // Reply to comment
api.startRunner    // Start cron scheduler
api.queue          // post_queue + campaign CRUD module
```

---

## `src/api-engine/oauth/index.js`

Token manager untuk semua platform OAuth. Menyimpan token di tabel `oauth_tokens`, auto-refresh saat expire.

### Provider Registry

Platform modules di-lazy-load untuk menghindari circular dependency:

```javascript
const PROVIDERS = {
  instagram: () => require('./instagram'),
  twitter:   () => require('./twitter'),
  youtube:   () => require('./youtube'),
  tiktok:    () => require('./tiktok'),
  linkedin:  () => require('./linkedin'),
};
```

### Exports

---

#### `saveToken(accountId, platform, tokenData)` → `void`

Simpan atau update token di DB via `INSERT OR CONFLICT DO UPDATE`.

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |
| `platform` | string | Platform |
| `tokenData.accessToken` | string | Bearer token |
| `tokenData.refreshToken` | string \| undefined | Refresh token (null jika tidak ada) |
| `tokenData.expiresAt` | Date | Waktu expire |
| `tokenData.scope` | string | OAuth scopes |
| `tokenData.meta` | object | Data platform-specific (e.g. TikTok `openId`) |

**Catatan:** Jika `refreshToken` baru adalah `null`, nilai lama dipertahankan (`COALESCE`).

---

#### `loadToken(accountId, platform)` → `TokenRow | null`

Load token dari DB. Menambahkan field computed `isExpired`.

**Returns:**
```javascript
{
  id, account_id, platform,
  access_token, refresh_token,
  expires_at, scope, meta_json,
  meta: { /* parsed meta_json */ },
  isExpired: boolean  // true jika expires_at <= now
}
```

Returns `null` jika tidak ada record.

---

#### `deleteToken(accountId, platform)` → `void`

Hapus token dari tabel `oauth_tokens`.

---

#### `getValidToken(accountId, platform)` → `Promise<string>`

Ambil access token yang valid. Auto-refresh jika expired dan refresh token tersedia.

**Flow:**
1. `loadToken()` — throw jika tidak ada
2. Jika `isExpired && refresh_token`: panggil `provider.refreshToken()` → `saveToken()` → return token baru
3. Return `access_token` yang ada

**Throws:** `Error` jika tidak ada token, atau platform tidak support refresh.

---

#### `getAuthUrl(platform, accountId, redirectUri)` → `string`

Generate OAuth authorization URL untuk redirect user ke platform.

Delegates ke `provider.getAuthUrl(accountId, redirectUri)`.

---

#### `handleCallback(platform, accountId, code, redirectUri, extra)` → `Promise<TokenData>`

Handle OAuth callback — tukar authorization code dengan access token, lalu simpan ke DB.

Delegates ke `provider.exchangeCode(code, redirectUri, extra)` → `saveToken()`.

---

## OAuth Providers

Semua provider mengekspos 3 fungsi: `getAuthUrl`, `exchangeCode`, `refreshToken` (kecuali Instagram yang tidak support refresh).

### `src/api-engine/oauth/instagram.js` — Meta Graph API

| Detail | Nilai |
|---|---|
| Flow | Authorization Code |
| Token lifetime | 60 hari (long-lived token) |
| Refresh | Tidak tersedia — `exchangeCode` langsung minta long-lived token |
| Scopes | `instagram_basic,instagram_content_publish,pages_read_engagement` |

**`getAuthUrl(accountId, redirectUri)`** → URL ke `facebook.com/dialog/oauth`.

**`exchangeCode(code, redirectUri)`:**
1. POST ke `/oauth/access_token` untuk short-lived token
2. GET ke `/oauth/access_token?grant_type=fb_exchange_token` untuk long-lived token (60 hari)

**`getIgBusinessAccountId(accessToken)`:** Helper untuk mendapatkan IG business account ID dan page access token dari `/me/accounts`.

---

### `src/api-engine/oauth/twitter.js` — OAuth 2.0 PKCE

| Detail | Nilai |
|---|---|
| Flow | OAuth 2.0 PKCE |
| Token lifetime | ~2 jam |
| Refresh | Tersedia via `offline.access` scope |

**PKCE Store:** In-memory `Map` `_pkceStore` menyimpan `{ codeVerifier, state }` per `accountId`.

**`getAuthUrl(accountId, redirectUri)`:**
1. Generate `code_verifier` (random 32 bytes, base64url)
2. Generate `code_challenge` = base64url(SHA256(verifier))
3. Simpan ke `_pkceStore[accountId]`
4. Return URL ke `twitter.com/i/oauth2/authorize`

**`exchangeCode(code, redirectUri, { accountId })`:** POST ke `/2/oauth2/token` dengan `code_verifier` dari `_pkceStore`.

**`refreshToken(refresh_token)`:** POST ke `/2/oauth2/token` dengan `grant_type=refresh_token`.

---

### `src/api-engine/oauth/youtube.js` — Google OAuth 2.0

| Detail | Nilai |
|---|---|
| Flow | Authorization Code |
| Token lifetime | 1 jam |
| Refresh | Tersedia (`access_type=offline`) |

**`getAuthUrl(accountId, redirectUri)`:** URL ke `accounts.google.com/o/oauth2/v2/auth` dengan `access_type=offline&prompt=consent`.

**`exchangeCode(code, redirectUri)`:** POST ke `oauth2.googleapis.com/token`.

**`refreshToken(refresh_token)`:** POST ke `oauth2.googleapis.com/token` dengan `grant_type=refresh_token`. Refresh token lama dipertahankan.

---

### `src/api-engine/oauth/tiktok.js` — TikTok for Developers

| Detail | Nilai |
|---|---|
| Flow | Authorization Code |
| Token lifetime | 24 jam |
| Refresh | Tersedia |

**`getAuthUrl(accountId, redirectUri)`:** URL ke `www.tiktok.com/v2/auth/authorize/`.

**`exchangeCode(code, redirectUri)`:** POST ke `open.tiktokapis.com/v2/oauth/token/`. Menyimpan `open_id` ke `meta.openId`.

**`refreshToken(refresh_token)`:** POST ke `open.tiktokapis.com/v2/oauth/token/` dengan `grant_type=refresh_token`.

---

### `src/api-engine/oauth/linkedin.js` — LinkedIn OAuth 2.0

| Detail | Nilai |
|---|---|
| Flow | Authorization Code |
| Token lifetime | 60 hari |
| Refresh | Tersedia |

**`getAuthUrl(accountId, redirectUri)`:** URL ke `linkedin.com/oauth/v2/authorization`.

**`exchangeCode(code, redirectUri)`:** POST ke `linkedin.com/oauth/v2/accessToken`.

---

## `src/api-engine/actions/post.js`

### Content Format

Format object `content` per platform:

**Instagram:**
```javascript
{
  type: 'photo' | 'carousel',
  mediaUrls: ['https://...'],  // 1 URL untuk photo, multi untuk carousel
  caption: 'Teks caption',
  hashtags: ['tag1', 'tag2'],  // Ditambahkan setelah caption
}
```

**Twitter:**
```javascript
{
  text: 'Tweet text',
  hashtags: ['tag1', 'tag2'],
}
```

**YouTube:**
```javascript
{
  title: 'Judul video',
  description: 'Deskripsi',
  videoUrl: 'https://...',     // Video akan di-fetch dan di-upload
  tags: ['tag1'],
  privacyStatus: 'public',     // default: 'public'
}
```

**TikTok:**
```javascript
{
  videoUrl: 'https://...',     // TikTok PULL_FROM_URL
  title: 'Judul / caption',
  hashtags: ['tag1'],
}
```

**LinkedIn:**
```javascript
{
  text: 'Post text',
  mediaUrl: 'https://...',     // Optional
  mediaType: 'image' | 'video', // Jika ada mediaUrl
}
```

### Exports

---

#### `publishPost(accountId, platform, content)` → `Promise<{ success, postId? }>`

Publish post langsung via platform API. Dispatch ke publisher internal berdasarkan platform.

**Instagram flow (photo):**
1. `getValidToken()` → get IG Business Account ID via `/me/accounts`
2. POST ke `/{igAccountId}/media` → `container.id`
3. POST ke `/{igAccountId}/media_publish` → `{ postId: result.id }`

**Instagram flow (carousel):**
1. Buat container per media item (concurrent)
2. Buat carousel container dengan `CAROUSEL` media type
3. Publish carousel container

**Twitter flow:** POST ke `/2/tweets` dengan Bearer token.

**YouTube flow:**
1. POST metadata ke resumable upload endpoint → `location` header
2. Fetch video bytes dari `videoUrl`
3. PUT video bytes ke upload URL

**TikTok flow:** POST ke `open.tiktokapis.com/v2/post/publish/video/init/` dengan `source: PULL_FROM_URL`.

**LinkedIn flow:**
1. GET `/v2/userinfo` → `urn:li:person:{sub}`
2. POST ke `/v2/ugcPosts` dengan `lifecycleState: PUBLISHED`

---

#### `schedulePost(accountId, platform, content, scheduledAt, campaignId?)` → `number`

Insert ke tabel `post_queue`. Return ID queue item.

| Parameter | Type | Deskripsi |
|---|---|---|
| `accountId` | number | ID akun |
| `platform` | string | Platform |
| `content` | object | Content object (format per platform di atas) |
| `scheduledAt` | string | ISO datetime eksekusi |
| `campaignId` | number \| null | Campaign terkait (optional) |

---

#### `deletePost(accountId, platform, postId)` → `Promise<{ success }>`

Hapus post via platform API. Support: Twitter (`DELETE /2/tweets/{id}`), Instagram (`DELETE /{postId}`).

---

## `src/api-engine/actions/analytics.js`

---

#### `getAnalytics(accountId, platform)` → `Promise<AnalyticsData>`

Fetch analytics dari platform API. Support: Instagram, Twitter, YouTube.

**Instagram:** GET `/{igAccountId}/insights` (followers_count, reach, impressions via `fields` param).

**Twitter:** GET `/2/users/me` dengan `user.fields=public_metrics`.

**YouTube:** GET `youtube.googleapis.com/youtube/v3/channels?part=statistics`.

**Returns:**
```javascript
{
  followers: number,
  reach: number | null,
  impressions: number | null,
  platform_raw: { /* raw API response */ }
}
```

---

#### `getFollowers(accountId, platform)` → `Promise<string[]>`

Fetch list follower. Support: Instagram (via `/followers` edge), Twitter (via `/2/users/{id}/followers`).

---

## `src/api-engine/actions/engagement.js`

---

#### `replyComment(accountId, platform, { commentId, message })` → `Promise<{ success }>`

Reply ke comment via platform API. Support: Instagram (`POST /{commentId}/replies`), Twitter (`POST /2/tweets` dengan `reply.in_reply_to_tweet_id`), YouTube (`POST youtube/v3/comments`).

---

## `src/api-engine/scheduler/queue.js`

CRUD untuk `post_queue` dan `campaigns`.

### Post Queue

---

#### `getPendingPosts()` → `QueueItem[]`

Ambil maksimal 20 post dengan `status = 'pending'` dan `scheduled_at <= now`, diurutkan by `scheduled_at ASC`.

---

#### `markPostRunning(id)` → `void`

Set `status = 'running'`.

---

#### `markPostDone(id, resultJson)` → `void`

Set `status = 'done'`, simpan `result_json`.

---

#### `markPostFailed(id, error)` → `void`

Increment `retry_count`. Jika `retry_count < max_retries`: set status kembali ke `'pending'`, reschedule `+5 menit`. Jika `retry_count >= max_retries`: set `status = 'failed'` (permanent).

---

#### `cancelPost(id)` → `void`

Set `status = 'cancelled'`.

---

#### `listQueue(accountId?, status?, limit = 50)` → `QueueItem[]`

List post queue dengan filter opsional. Diurutkan by `scheduled_at ASC`.

---

### Campaign Management

---

#### `createCampaign({ name, accountId, platform, type, config, targetCount })` → `number`

Insert kampanye baru dengan `status = 'draft'`. Return ID.

| Parameter | Type | Deskripsi |
|---|---|---|
| `name` | string | Nama campaign |
| `accountId` | number | Akun yang menjalankan |
| `platform` | string | Target platform |
| `type` | string | `'growth'` \| `'content'` \| `'hybrid'` |
| `config` | object | Konfigurasi (lihat runner.js) |
| `targetCount` | number \| null | Target aksi total |

---

#### `getCampaign(id)` → `Campaign | undefined`

Ambil satu campaign di-join dengan `accounts` (username, platform).

---

#### `listCampaigns(status?)` → `Campaign[]`

List campaigns dengan filter status opsional. Di-join dengan `accounts`. Diurutkan by `created_at DESC`.

---

#### `setCampaignStatus(id, status)` → `void`

Update status campaign. Side effects:
- `status = 'running'` → set `started_at = COALESCE(started_at, now)` (tidak overwrite jika sudah ada)
- `status = 'completed'` atau `'failed'` → set `completed_at = now`

---

#### `incrementCampaignCount(id)` → `void`

Increment `completed_count` sebesar 1.

---

#### `logCampaignAction(campaignId, accountId, action, status, message?)` → `void`

Insert satu baris ke `campaign_logs`.

| `status` | Makna |
|---|---|
| `'success'` | Aksi berhasil |
| `'failed'` | Aksi gagal |
| `'skipped'` | Aksi di-skip |
| `'blocked'` | Blocked oleh rate limit atau detection |

---

#### `getCampaignLogs(campaignId, limit = 100)` → `CampaignLog[]`

Ambil log campaign terbaru, diurutkan by `created_at DESC`.

---

## `src/api-engine/scheduler/runner.js`

Cron dispatcher untuk post queue dan campaigns. Menggunakan lazy-load untuk menghindari circular dependency dengan playwright engine.

### Cron Jobs

| Schedule | Job | Fungsi |
|---|---|---|
| `* * * * *` (60s) | Drain post queue | `drainPostQueue()` |
| `*/30 * * * * *` (30s) | Process campaigns | `processCampaigns()` |

### `startRunner()` → `void`

Mulai semua cron jobs. Guard `_started` flag memastikan tidak double-start.

### `drainPostQueue()` → `Promise<void>`

Loop `getPendingPosts()` (max 20), untuk setiap item:
1. `markPostRunning(id)`
2. `publishPost(account_id, platform, content)`
3. Success → `markPostDone()` + `logCampaignAction('success')` + `incrementCampaignCount()`
4. Fail → `markPostFailed()` + `logCampaignAction('failed')`

### `processCampaigns()` → `Promise<void>`

Loop `listCampaigns('running')`, skip jika sudah ada di `_runningCampaigns` Set:
- `type = 'growth'` → `runGrowthCampaign()`
- `type = 'hybrid'` → `runHybridCampaign()`
- `type = 'content'` → ditangani sepenuhnya oleh `drainPostQueue()` (tidak diproses di sini)

### `runGrowthCampaign(campaign)` → `Promise<void>`

Jalankan GROWTH campaign via Playwright.

**Config format:**
```javascript
{
  action: 'follow' | 'like_post' | 'comment' | 'unfollow' | 'like_video' | 'watch_video',
  target: {
    type: 'hashtag' | 'competitor' | 'explore',
    value: 'photography'  // hashtag string atau username
  },
  dailyGoal: 20  // Target aksi per hari
}
```

**Flow:**
1. Discover targets via `_discoverTargets()` (hashtag/competitor/explore)
2. Loop `min(targets.length, dailyGoal - completed_count)` aksi
3. `executeAction(accountId, platform, action, params)` per target
4. `blocked` → log + break (rate limit habis)
5. Detection event (`result.event`) → `setCampaignStatus('paused')` + break
6. Setelah loop: cek jika `completed_count >= target_count` → `setCampaignStatus('completed')`

### `runHybridCampaign(campaign)` → `Promise<void>`

Jalankan HYBRID campaign (API publish + Playwright boost).

**Config format:**
```javascript
{
  publish: {
    content: { /* content object */ },
    scheduledAt: '2026-05-25T10:00:00Z'  // optional — jika tidak ada, publish langsung
  },
  boost: {
    /* config sama seperti growth campaign */
    dailyGoal: 50
  }
}
```

**Flow:**
1. Jika `publish.scheduledAt` ada: `schedulePost()` ke post_queue
2. Jika tidak: `publishPost()` langsung
3. Jika `boost` config ada: `runGrowthCampaign(boostCampaign)`

### `_discoverTargets(accountId, platform, action, target)` → `Promise<string[]>`

Launch browser session (via `launchForAccount`) untuk scraping targets. Cleanup dalam `finally` block.

| `target.type` | `platform` | Discovery function |
|---|---|---|
| `hashtag` + `like_post`/`comment` | instagram | `ig.hashtagPosts()` |
| `hashtag` + `follow` | instagram | `ig.hashtagPosts()` (post URLs sebagai proxy untuk username) |
| `competitor` | instagram | `ig.competitorFollowers()` |
| `explore` | instagram | `ig.explorePosts()` |
| `hashtag` | tiktok | `tt.hashtagVideos()` |

### `_buildParams(action, target)` → `object`

Map action + target string ke params object untuk `executeAction()`:

```javascript
'like_post'  → { postUrl: target }
'comment'    → { postUrl: target, text: '🔥' }
'follow'     → { username: target }
'like_video' → { videoUrl: target }
```
