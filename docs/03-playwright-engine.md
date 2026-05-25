# Playwright Engine

File: `src/playwright-engine/browser.js` · `human.js` · `index.js` · `target-discovery.js` · `platforms/instagram.js` · `platforms/tiktok.js`

Playwright Engine mengotomatisasi interaksi browser dengan fingerpritng stealth dan human behavior simulation. Semua aksi dijalankan melalui `executeAction()` sebagai single entry point.

---

## `src/playwright-engine/browser.js`

Mengelola lifecycle Chromium browser per akun. Memastikan tidak ada lebih dari satu browser aktif per akun secara bersamaan.

### Konstanta

#### `DESKTOP_VIEWPORTS`

Pool viewport desktop yang dipilih secara acak per sesi:

```javascript
[
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
]
```

#### `USER_AGENTS`

Pool 4 Chrome user agent string (Windows/Mac/Linux, Chrome 122–124) yang dipilih secara acak.

#### `GPU_PAIRS`

Pool 5 pasangan `[vendor, renderer]` WebGL yang realistis:

```javascript
[
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ...)'],
  ['Google Inc. (Intel)',  'ANGLE (Intel, Intel(R) UHD Graphics 620 ...)'],
  ['Google Inc. (AMD)',    'ANGLE (AMD, AMD Radeon RX 5700 XT ...)'],
  ['Intel Inc.',           'Intel Iris OpenGL Engine'],
  ['Apple',                'Apple M1'],
]
```

### Busy Guard

Module-level `_activeBrowsers` Set mencegah concurrency:

```javascript
const _activeBrowsers = new Set();
isAccountBusy(accountId) // → boolean
```

`launchForAccount()` throw jika `isAccountBusy(accountId)` adalah `true`. `markFree()` dipanggil dalam `cleanup()`.

### `buildFingerprintScript(seed, viewport, ua, gpuPair)` → `string`

Menghasilkan JavaScript string yang diinjeksikan ke setiap page via `context.addInitScript()`. Script berjalan sebelum kode halaman apapun.

**Seed:** integer acak 6–9 digit. Digunakan oleh PRNG XORshift di dalam script untuk menghasilkan noise yang konsisten per sesi namun berbeda antar sesi.

**9 patch yang diterapkan:**

| Patch | Target | Efek |
|---|---|---|
| 1 | `navigator.webdriver` | `undefined` (bukan `true`) |
| 1 | `navigator.languages` | `['en-US', 'en']` |
| 1 | `navigator.platform` | `'Win32'` |
| 1 | `navigator.hardwareConcurrency` | Random 4–16 |
| 1 | `navigator.deviceMemory` | Random dari `[4, 8, 16]` |
| 2 | `navigator.plugins` | 3 Chrome PDF viewer mock entries |
| 3 | `window.chrome` | `{ app, runtime, csi, loadTimes }` object |
| 4 | `HTMLCanvasElement.prototype.toDataURL` | ±1 noise pada pixel tiap 64 byte |
| 4 | `CanvasRenderingContext2D.prototype.getImageData` | ±0.5 noise pada 128 byte pertama |
| 5 | `WebGL getParameter` | Vendor/renderer dari `gpuPair` (param 37445/37446) |
| 6 | `AudioBuffer.prototype.getChannelData` | ±5e-8 float noise pada 50 sample pertama |
| 7 | `navigator.getBattery` | Mock: charging 75% chance, level 0.3–1.0 |
| 8 | `navigator.connection` | 4G WiFi profile (downlink 10–100, rtt 10–50) |
| 9 | `Permissions.prototype.query` | Return `'prompt'` untuk 15 sensitive APIs |

### `launchForAccount(accountId, platform)` → `{ browser, context, page, cleanup }`

Satu-satunya cara untuk membuat browser instance di Nexus Social.

**Urutan eksekusi:**

1. Cek `isAccountBusy(accountId)` — throw jika sudah ada browser aktif
2. Load proxy dari `getProxyForAccount(accountId)` (boleh `null`)
3. Pilih acak: viewport, user agent, GPU pair
4. Generate seed acak 100000–999999999
5. Launch `chromium.launch()` dengan stealth args
6. Load `storageState` dari `loadSession()` jika ada
7. `browser.newContext()` dengan viewport, UA, locale `en-US`, timezone `America/New_York`
8. `context.addInitScript(buildFingerprintScript(...))`
9. `context.newPage()`
10. `markBusy(accountId)`
11. Return `{ browser, context, page, cleanup }`

**Chromium launch args:**

```
--no-sandbox
--disable-setuid-sandbox
--disable-dev-shm-usage
--disable-blink-features=AutomationControlled
--disable-infobars
--disable-extensions
--disable-default-apps
--no-first-run
--no-default-browser-check
--disable-features=TranslateUI,VizDisplayCompositor
--disable-ipc-flooding-protection
--password-store=basic
--use-mock-keychain
--window-size={width},{height}
```

**`cleanup()`:** Close browser → `markFree(accountId)`. Selalu dipanggil di `finally` block oleh `executeAction()`.

---

## `src/playwright-engine/human.js`

Layer simulasi perilaku manusia. Semua delay menggunakan `randInt(min, max)` — tidak ada delay hardcoded.

### Utility

---

#### `randInt(min, max)` → `number`

Integer acak inklusif antara `min` dan `max`.

#### `randFloat(min, max)` → `number`

Float acak antara `min` dan `max`.

#### `delay(ms)` → `Promise`

`setTimeout` wrapped sebagai Promise.

---

### Delays

---

#### `preAction()` → `Promise`

Delay sebelum aksi: `rand(800, 3000)` ms.

#### `postAction()` → `Promise`

Delay setelah aksi selesai: `rand(2000, 8000)` ms.

#### `shortPause()` → `Promise`

Pause singkat antar langkah: `rand(300, 800)` ms.

#### `typingPause()` → `Promise`

Delay antar karakter saat mengetik: `rand(50, 180)` ms per karakter.

---

### Mouse Movement

---

#### `moveMouseTo(page, targetX, targetY)` → `Promise`

Gerakkan mouse via kurva Bezier kubik dari posisi saat ini ke target.

**Detail:**
- Langkah: `rand(8, 20)` steps
- Control points cx1/cy1: posisi awal ± rand(-150, 150)
- Control points cx2/cy2: target ± rand(-100, 100)
- Delay per step: `rand(5, 25)` ms
- Formula: `P(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃`

#### `scrollToElement(page, selector)` → `Promise`

Scroll halaman agar elemen masuk ke tengah viewport (`scrollIntoView behavior: smooth, block: center`), lalu tunggu `rand(400, 900)` ms.

#### `scrollToElementHandle(page, elementHandle)` → `Promise`

Sama seperti `scrollToElement` tapi menerima Playwright `ElementHandle` langsung.

---

### Click & Type

---

#### `humanClick(page, selector, { missChance = 0.08 })` → `Promise`

Klik elemen dengan gerakan mouse Bezier dan simulasi miss-click opsional.

**Urutan:**
1. `waitForSelector(selector, { timeout: 10000 })`
2. `scrollToElementHandle()`
3. Hitung target = center bounding box + rand(-3, 3) jitter
4. `moveMouseTo()` ke target
5. `shortPause()`
6. 8% chance: miss-click ke ±15px, delay 300–600ms, koreksi ke target
7. `page.mouse.click(targetX, targetY)`

#### `humanType(page, selector, text)` → `Promise`

Ketik teks dengan delay per karakter dan micro-pause antar kata.

**Urutan:**
1. `humanClick(selector, { missChance: 0 })`
2. `shortPause()`
3. Loop per karakter: `keyboard.type(char)` + `typingPause()`
4. 30% chance pause `rand(100, 400)` ms jika karakter adalah spasi

---

### Scroll

---

#### `humanScroll(page, { scrolls?, totalPx? })` → `Promise`

Scroll natural dengan variasi kecepatan dan kadang balik ke atas.

| Parameter | Default | Deskripsi |
|---|---|---|
| `scrolls` | `rand(3, 12)` | Jumlah scroll event |
| `totalPx` | `rand(800, 4000)` | Target total pixel |

**Behavior:**
- 15% chance scroll ke atas jika sudah turun >200px: `-rand(80, 200)` px
- Scroll normal: `rand(80, 350)` px ke bawah
- Delay antar scroll: `rand(200, 800)` ms
- 10% chance idle pause (baca simulasi): `rand(800, 3000)` ms
- Berhenti jika total pixel tercapai

---

### Navigation

---

#### `waitForLoad(page, timeout = 15000)` → `Promise`

Tunggu `domcontentloaded` lalu `networkidle` (timeout 5s, diabaikan jika gagal). Safe untuk halaman dengan long-poll connection.

---

## `src/playwright-engine/index.js`

Orchestrator utama. `executeAction()` adalah satu-satunya entry point untuk menjalankan aksi Playwright dari modul lain.

### `ACTION_MAP`

Registry aksi per platform. Memetakan action name ke platform module function dan rate limit type:

```javascript
ACTION_MAP = {
  instagram: {
    login:       { fn: 'login',        rateType: null },
    scroll_feed: { fn: 'scrollFeed',   rateType: null },
    watch_story: { fn: 'watchStory',   rateType: 'story_view' },
    like_post:   { fn: 'likePost',     rateType: 'like' },
    follow:      { fn: 'followUser',   rateType: 'follow' },
    unfollow:    { fn: 'unfollowUser', rateType: 'unfollow' },
    comment:     { fn: 'commentPost',  rateType: 'comment' },
    watch_reel:  { fn: 'watchReel',    rateType: 'watch_reel' },
    dm:          { fn: 'sendDM',       rateType: 'dm' },
  },
  tiktok: {
    login:       { fn: 'login',        rateType: null },
    watch_video: { fn: 'watchVideo',   rateType: 'watch_reel' },
    like_video:  { fn: 'likeVideo',    rateType: 'like' },
    follow:      { fn: 'followUser',   rateType: 'follow' },
    comment:     { fn: 'commentVideo', rateType: 'comment' },
    scroll_fyp:  { fn: 'scrollFYP',   rateType: null },
  },
}
```

`rateType: null` berarti aksi tidak ditracking di rate_limits (login, scroll).

### `executeAction(accountId, platform, action, params)` → `Result`

**Returns:**
```typescript
type Result =
  | { success: true }
  | { success: false; blocked?: boolean; reason?: string }
  | { success: false; event?: string; message?: string }
  | { success: false; error?: string }
```

**7 langkah eksekusi:**

| Langkah | Deskripsi |
|---|---|
| 1. canAct() gate | `am.canAct()` jika `rateType != null`; cek status akun jika `rateType == null` |
| 2. Busy check | `isAccountBusy()` — return `account_busy` jika sudah ada browser aktif |
| 3. Ensure logged in | Navigasi ke homepage, cek URL. Jika belum login, auto `login()` + `saveSession()` |
| 4. Execute action | `platformModule[actionDef.fn](page, ...args)` |
| 5. Detection check | Jika `result.event` ada → `logEvent()` ke health monitor |
| 6. Record + save | `recordAction()` + `saveSession()` pada success |
| 7. Cleanup | `session.cleanup()` selalu di `finally` block |

**`_buildArgs(action, platform, account, params)`:** Internal helper memetakan `params` object ke positional args sesuai signature tiap function.

### `loginAndSaveSession(accountId, platform)` → `Result`

Shortcut untuk `executeAction(accountId, platform, 'login')`. Digunakan untuk inisialisasi session akun baru.

---

## `src/playwright-engine/target-discovery.js`

Scraping target untuk campaigns. Menggunakan Playwright page yang sudah login.

### `ig` — Instagram Discovery

---

#### `ig.hashtagPosts(page, hashtag, { limit = 30 })` → `string[]`

Scrape post URLs dari halaman hashtag Instagram.

- Navigate ke `instagram.com/explore/tags/{hashtag}/`
- Loop scroll + collect `a[href*="/p/"]` sampai `limit` atau 10 attempts
- Filter URL dengan regex `/\/p\/[\w-]+\/?$/`
- **Returns:** array post URL unik, maksimal `limit`

#### `ig.competitorFollowers(page, username, { limit = 50 })` → `string[]`

Scrape usernames dari follower list profil competitor.

- Navigate ke `instagram.com/{username}/followers/`
- Loop scroll di dalam `[role="dialog"]` sampai `limit` atau 15 attempts
- Extract anchor hrefs lalu strip domain dan trailing slash
- **Returns:** array username string

#### `ig.explorePosts(page, { limit = 20 })` → `string[]`

Scrape post URLs dari halaman Explore Instagram.

- Navigate ke `instagram.com/explore/`
- Loop scroll + collect `a[href*="/p/"]` sampai `limit` atau 8 attempts
- **Returns:** array post URL unik

---

### `tt` — TikTok Discovery

---

#### `tt.hashtagVideos(page, hashtag, { limit = 20 })` → `string[]`

Scrape video URLs dari halaman hashtag TikTok.

- Navigate ke `tiktok.com/tag/{hashtag}`
- Loop scroll + collect `a[href*="/video/"]` dengan regex `/\/video\/\d+/`
- **Returns:** array video URL unik, maksimal `limit`

---

## `src/playwright-engine/platforms/instagram.js`

Implementasi 9 aksi Instagram dengan TOTP inline dan selector registry terpusat.

### `SEL` — Selector Registry

Object konstanta berisi semua CSS selector. Diperbarui di satu tempat jika Instagram mengubah DOM:

```javascript
const SEL = {
  username_input: 'input[name="username"]',
  password_input: 'input[name="password"]',
  login_button:   'button[type="submit"]',
  two_fa_input:   'input[name="verificationCode"], input[aria-label*="Security code"], ...',
  like_button:    'svg[aria-label="Like"], [aria-label="Like"][role="button"]',
  unlike_button:  'svg[aria-label="Unlike"], ...',
  follow_button:  'button._acan._acap._acat._acaw, header button:has-text("Follow"):not(...)',
  following_button: 'button:has-text("Following"), ...',
  // ... (25 selector total)
}
```

### `generateTOTP(base32Secret)` → `string`

Implementasi TOTP RFC 6238 tanpa external dependency. Menggunakan Node.js `crypto` built-in.

**Algoritma:**
1. Decode base32 secret ke Buffer (alphabet `A-Z2-7`)
2. Hitung time counter: `Math.floor(Date.now() / 30000)` sebagai BigInt64 big-endian
3. HMAC-SHA1(key=secretBytes, message=timeBuf)
4. Dynamic truncation: offset = `digest[19] & 0x0f`
5. Extract 4 bytes dari offset, mask high bit: `code & 0x7fffffff`
6. `code % 1_000_000`, padStart(6, '0')

**Returns:** 6-digit OTP string.

### `checkForDetection(page)` → `string | null`

Analisis URL dan body text untuk mendeteksi tanda-tanda pembatasan:

| Return | Trigger |
|---|---|
| `'challenge'` | URL mengandung `/challenge` atau `/accounts/suspended` |
| `'challenge'` | Text: `suspicious login` atau `Unusual Login Attempt` |
| `'action_block'` | Text: `Action Blocked`, `action has been blocked`, `Try Again Later` |
| `'disabled'` | URL mengandung `/accounts/disabled` |
| `null` | Tidak ada deteksi |

### Actions

---

#### `login(page, account)` → `{ success, event? }`

| Parameter | Type | Deskripsi |
|---|---|---|
| `page` | Page | Playwright page |
| `account` | Account | Row dari tabel `accounts` |

**Flow:**
1. Navigate ke `/accounts/login/`
2. Dismiss cookie consent jika ada
3. `humanType()` username + password
4. Click submit, `waitForLoad(20000)`
5. Jika 2FA form muncul: `generateTOTP(account.two_fa_secret)` → type → submit
6. Dismiss "Save login info?" dialog jika ada
7. Dismiss notifications dialog jika ada
8. `checkForDetection()` → return event jika terdeteksi
9. Verifikasi URL tidak redirect ke `/accounts/login`

#### `scrollFeed(page, { seconds? })` → `{ success: true }`

Scroll home feed selama `seconds` detik (default `rand(30, 120)`). Memanggil `humanScroll()` dalam loop sampai durasi habis.

#### `watchStory(page, username)` → `{ success, event? }`

View story user tertentu. Tap 1–5 frame dengan `rand(3000, 12000)` ms per frame.

#### `likePost(page, postUrl)` → `{ success, event?, alreadyLiked? }`

Navigate ke post URL. Cek jika sudah dilike (ada `unlike_button`). Click like button. Verifikasi dengan cek `unlike_button` setelah klik.

#### `followUser(page, username)` → `{ success, event?, alreadyFollowing? }`

Navigate ke profil. Cek jika sudah follow. Temukan Follow button via `header button` filter `hasText: /^Follow$/`. Verifikasi dengan cek `following_button`.

#### `unfollowUser(page, username)` → `{ success, event?, notFollowing? }`

Navigate ke profil. Click `following_button`. Confirm dialog unfollow. Tidak ada verifikasi post-unfollow.

#### `commentPost(page, postUrl, text)` → `{ success, event? }`

Navigate ke post. Click comment icon. Click textarea. `humanType()` teks. Submit via button atau Enter.

#### `watchReel(page, reelUrl)` → `{ success, event? }`

Navigate ke reel URL. Tunggu `rand(8000, 22000)` ms. 40% chance melakukan scroll setelah menonton.

#### `sendDM(page, username, message)` → `{ success, event? }`

Navigate ke `/direct/new/`. Type username di search. Click hasil. Click Next. Type message. Click Send atau tekan Enter.

---

## `src/playwright-engine/platforms/tiktok.js`

Implementasi 6 aksi TikTok.

### `SEL` — Selector Registry

```javascript
const SEL = {
  email_input:      'input[name="username"], input[type="email"], ...',
  password_input:   'input[type="password"]',
  like_btn:         '[data-e2e="like-icon"], [data-e2e="video-like-btn"]',
  liked_btn:        '[data-e2e="unlike-icon"]',
  follow_btn:       '[data-e2e="follow-button"]:not([data-e2e="unfollow-button"]), ...',
  following_badge:  '[data-e2e="unfollow-button"], button:has-text("Following")',
  // ...
}
```

### `checkForDetection(page)` → `string | null`

| Return | Trigger |
|---|---|
| `'action_block'` | Text: `Too many attempts`, `too many requests` |
| `'disabled'` | Text: `suspended`, `Your account was banned` |
| `'challenge'` | URL `/challenge` atau text `verify` |
| `null` | Tidak ada deteksi |

### Actions

---

#### `login(page, account)` → `{ success, event? }`

Navigate ke `/login/phone-or-email/email`. Type email + password. Dismiss cookie consent. Verifikasi URL tidak di `/login`.

#### `watchVideo(page, videoUrl)` → `{ success, event? }`

Navigate ke video URL. Tunggu `rand(8000, 45000)` ms (20–90% durasi video 15–60s). 30% chance scroll setelah menonton.

#### `likeVideo(page, videoUrl)` → `{ success, event?, alreadyLiked? }`

Navigate ke video. Cek `liked_btn`. Click `like_btn`. Verifikasi `liked_btn` muncul.

#### `followUser(page, username)` → `{ success, event?, alreadyFollowing? }`

Navigate ke `tiktok.com/@{username}`. Cek `following_badge`. Click follow button. Verifikasi `following_badge` muncul.

#### `commentVideo(page, videoUrl, text)` → `{ success, event? }`

Navigate ke video. Click comment icon. Click input. `humanType()` teks. Submit via button atau Enter.

#### `scrollFYP(page, { seconds? })` → `{ success: true }`

Scroll For You Page selama `seconds` detik (default `rand(30, 120)`). Tekan `ArrowDown` per video dengan watch time `rand(5000, 20000)` ms.
