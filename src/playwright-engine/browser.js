'use strict';

const { chromium } = require('playwright');
const { makeLogger } = require('../utils/logger');
const { loadSession } = require('../account-manager/session-manager');
const { getProxyForAccount } = require('../account-manager/index');
const { getDb } = require('../database/db');
const fs = require('fs');

const log = makeLogger('Browser');

// ----------------------------------------------------------------
// Prevent >1 browser per account simultaneously
// ----------------------------------------------------------------

const _activeBrowsers = new Set();
const MAX_CONCURRENT  = parseInt(process.env.MAX_CONCURRENT_BROWSERS ?? '4', 10);

function isAccountBusy(accountId) {
  return _activeBrowsers.has(accountId);
}

function isConcurrencyFull() {
  return _activeBrowsers.size >= MAX_CONCURRENT;
}

function markBusy(accountId) {
  _activeBrowsers.add(accountId);
}

function markFree(accountId) {
  _activeBrowsers.delete(accountId);
}

// ----------------------------------------------------------------
// Device profiles (desktop only for social automation)
// ----------------------------------------------------------------

const DESKTOP_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

const ANON_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver',
  'America/Toronto', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Amsterdam',
  'Asia/Tokyo', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kolkata',
  'Australia/Sydney', 'America/Sao_Paulo',
];

const ANON_LOCALES = [
  ['en-US', 'en-US,en;q=0.9'],
  ['en-GB', 'en-GB,en;q=0.9'],
  ['en-AU', 'en-AU,en;q=0.9'],
  ['de-DE', 'de-DE,de;q=0.9,en;q=0.8'],
  ['fr-FR', 'fr-FR,fr;q=0.9,en;q=0.8'],
  ['pt-BR', 'pt-BR,pt;q=0.9,en;q=0.8'],
  ['es-ES', 'es-ES,es;q=0.9,en;q=0.8'],
  ['ja-JP', 'ja-JP,ja;q=0.9,en;q=0.8'],
];

const GPU_PAIRS = [
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)',  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)',    'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Intel Inc.',           'Intel Iris OpenGL Engine'],
  ['Apple',                'Apple M1'],
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ----------------------------------------------------------------
// Fingerprint helpers
// ----------------------------------------------------------------

function _platformFromUA(ua) {
  if (/Macintosh/.test(ua)) return 'MacIntel';
  if (/Linux/.test(ua))     return 'Linux x86_64';
  return 'Win32';
}

function _languagesFromLocale(locale) {
  const base = locale.split('-')[0];
  if (base === 'en') return [locale, 'en'];
  return [locale, base, 'en-US', 'en'];
}

// ----------------------------------------------------------------
// Build the fingerprint init script injected via addInitScript
// opts (for ghost): { locale, hardwareConcurrency, deviceMemory }
// ----------------------------------------------------------------

function buildFingerprintScript(seed, viewport, ua, gpuPair, opts = {}) {
  const platform  = _platformFromUA(ua);
  const locale    = opts.locale ?? 'en-US';
  const languages = _languagesFromLocale(locale);
  const hwConc    = opts.hardwareConcurrency ?? randInt(4, 16);
  const devMem    = opts.deviceMemory        ?? pick([4, 8, 16]);

  return `
(function() {
  const _seed = ${seed};
  let _s = _seed;
  function _rand() {
    _s = (_s ^ (_s << 13)) >>> 0;
    _s = (_s ^ (_s >>> 7)) >>> 0;
    _s = (_s ^ (_s << 17)) >>> 0;
    return _s / 4294967296;
  }

  // 1. Navigator — disable automation flags + consistent identity
  Object.defineProperty(navigator, 'webdriver',           { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'languages',           { get: () => ${JSON.stringify(languages)} });
  Object.defineProperty(navigator, 'platform',            { get: () => '${platform}' });
  Object.defineProperty(navigator, 'vendor',              { get: () => 'Google Inc.' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${hwConc} });
  Object.defineProperty(navigator, 'deviceMemory',        { get: () => ${devMem} });
  Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });

  // 2. Plugins (PDF viewer mocks)
  const _plugins = [
    { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 0 },
    { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 0 },
    { name: 'Native Client',      filename: 'internal-nacl-plugin', description: '', length: 0 },
  ];
  _plugins.item      = i => _plugins[i];
  _plugins.namedItem = n => _plugins.find(p => p.name === n) || null;
  _plugins.refresh   = () => {};
  Object.defineProperty(navigator, 'plugins',   { get: () => _plugins });
  Object.defineProperty(navigator, 'mimeTypes', { get: () => ({ length: 2, item: () => null, namedItem: () => null }) });

  // 3. window.chrome
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
        },
        runtime: {
          connect: () => {}, sendMessage: () => {},
          PlatformOs:   { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux' },
          PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
          id: undefined,
        },
        csi: () => {},
        loadTimes: () => ({
          commitLoadTime: Date.now() / 1000 - _rand() * 2,
          connectionInfo: 'h2', finishDocumentLoadTime: 0, finishLoadTime: 0,
          firstPaintAfterLoadTime: 0, firstPaintTime: 0, navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - _rand() * 3,
          startLoadTime: Date.now() / 1000 - _rand() * 2.5,
          wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true,
        }),
      },
      writable: false, configurable: false,
    });
  }

  // 4. Canvas noise
  const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type) {
    const ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const img = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < img.data.length; i += 64) {
          img.data[i]   = (img.data[i]   + Math.round((_rand() - 0.5) * 2)) & 0xff;
          img.data[i+1] = (img.data[i+1] + Math.round((_rand() - 0.5) * 2)) & 0xff;
        }
        ctx.putImageData(img, 0, 0);
      } catch(_) {}
    }
    return _origToDataURL.apply(this, arguments);
  };
  const _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
    const data = _origGetImageData.apply(this, arguments);
    for (let i = 0; i < Math.min(data.data.length, 128); i += 4) {
      data.data[i] = (data.data[i] + Math.round((_rand() - 0.5) * 1)) & 0xff;
    }
    return data;
  };

  // 5. WebGL GPU — spoof both basic (VENDOR/RENDERER) and unmasked extension params
  const _gpuVendor   = '${gpuPair[0]}';
  const _gpuRenderer = '${gpuPair[1]}';
  const _patchWebGL  = (ctx) => {
    if (!ctx) return;
    const _orig = ctx.getParameter.bind(ctx);
    ctx.getParameter = function(p) {
      if (p === 0x1F00 || p === 7424) return 'WebKit';      // VENDOR (basic)
      if (p === 0x1F01 || p === 7425) return _gpuRenderer;  // RENDERER (basic) — hides SwiftShader/llvmpipe
      if (p === 37445)                return _gpuVendor;     // UNMASKED_VENDOR_WEBGL
      if (p === 37446)                return _gpuRenderer;   // UNMASKED_RENDERER_WEBGL
      return _orig(p);
    };
    // Spoof getSupportedExtensions to include real-GPU extensions
    const _origExts = ctx.getSupportedExtensions?.bind(ctx);
    if (_origExts) {
      ctx.getSupportedExtensions = function() {
        const exts = _origExts() || [];
        if (!exts.includes('WEBGL_debug_renderer_info')) exts.push('WEBGL_debug_renderer_info');
        return exts;
      };
    }
  };
  const _origGetCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type) {
    const ctx = _origGetCtx.apply(this, arguments);
    if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') _patchWebGL(ctx);
    return ctx;
  };

  // 6. Audio context noise
  try {
    const _origGCD = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function() {
      const data = _origGCD.apply(this, arguments);
      for (let i = 0; i < Math.min(data.length, 50); i++) data[i] += (_rand() - 0.5) * 5e-8;
      return data;
    };
  } catch(_) {}

  // 7. Battery — level drifts naturally based on time-of-day + ghost base level
  try {
    const _battBase   = ${opts.batteryBase ?? 0.65};
    const _hourOfDay  = new Date().getHours();
    // Morning (6-9h): charging. Evening (18-23h): discharging. Other: mixed.
    const _isCharging = _hourOfDay >= 6 && _hourOfDay <= 9 ? true
                      : _hourOfDay >= 18 ? false
                      : _rand() > 0.45;
    const _battLevel  = Math.min(1.0, Math.max(0.08,
      _battBase + (_isCharging ? _rand() * 0.15 : -_rand() * 0.1)
    ));
    Object.defineProperty(navigator, 'getBattery', {
      value: () => Promise.resolve({
        charging:        _isCharging,
        chargingTime:    _isCharging ? Math.floor(1200 + _rand() * 3600) : Infinity,
        dischargingTime: _isCharging ? Infinity : Math.floor(3600 + _rand() * 14400),
        level:           Math.round(_battLevel * 100) / 100,
        addEventListener: () => {}, removeEventListener: () => {},
        dispatchEvent: () => {},
      }),
      writable: false, configurable: false,
    });
  } catch(_) {}

  // 8. Network info — consistent type per ghost
  try {
    const _connType = '${opts.connectionType ?? 'wifi'}';
    const _isWifi   = _connType === 'wifi';
    Object.defineProperty(navigator, 'connection', { get: () => ({
      downlink:      _isWifi ? 50 + _rand() * 150 : 5 + _rand() * 20,
      effectiveType: _isWifi ? '4g' : '4g',
      rtt:           Math.floor(_isWifi ? 5 + _rand() * 25 : 40 + _rand() * 80),
      saveData:      false,
      type:          _connType,
      addEventListener: () => {}, removeEventListener: () => {},
    })});
  } catch(_) {}

  // 9. Permissions
  try {
    const _origQ = Permissions.prototype.query;
    Permissions.prototype.query = function(desc) {
      const sensitive = ['notifications','push','midi','camera','microphone','speaker','device-info',
        'background-sync','bluetooth','persistent-storage','ambient-light-sensor',
        'accelerometer','gyroscope','magnetometer','clipboard-read','clipboard-write'];
      if (sensitive.includes(desc.name))
        return Promise.resolve({ state: 'prompt', onchange: null, addEventListener: () => {} });
      return _origQ.call(this, desc);
    };
  } catch(_) {}

  // 10. Screen dimensions — match viewport exactly
  try {
    Object.defineProperty(screen, 'width',       { get: () => ${viewport.width}  });
    Object.defineProperty(screen, 'height',      { get: () => ${viewport.height} });
    Object.defineProperty(screen, 'availWidth',  { get: () => ${viewport.width}  });
    Object.defineProperty(screen, 'availHeight', { get: () => ${viewport.height - 40} });
    Object.defineProperty(screen, 'colorDepth',  { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth',  { get: () => 24 });
    Object.defineProperty(window, 'outerWidth',  { get: () => ${viewport.width}  });
    Object.defineProperty(window, 'outerHeight', { get: () => ${viewport.height} });
  } catch(_) {}

  // 11. Document visibility — headless returns 'hidden' by default
  try {
    Object.defineProperty(document, 'hasFocus',        { value: () => true });
    Object.defineProperty(document, 'hidden',          { get: () => false });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch(_) {}

  // 12. WebRTC — strip STUN servers to prevent IP leak via ICE candidates
  try {
    const _Orig = window.RTCPeerConnection;
    if (_Orig) {
      window.RTCPeerConnection = function(cfg) {
        return new _Orig(Object.assign({}, cfg, { iceServers: [] }));
      };
      window.RTCPeerConnection.prototype     = _Orig.prototype;
      window.webkitRTCPeerConnection         = window.RTCPeerConnection;
    }
  } catch(_) {}

  // 13. Media devices — mock basic laptop devices (no label = permission not granted)
  try {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
        { deviceId: '', groupId: 'grp1', kind: 'audioinput',  label: '' },
        { deviceId: '', groupId: 'grp1', kind: 'audiooutput', label: '' },
        { deviceId: '', groupId: 'grp2', kind: 'videoinput',  label: '' },
      ]);
    }
  } catch(_) {}

  // 14. Font spoofing — claim common system fonts are installed
  // Headless has a minimal font set; this prevents canvas measureText detection
  try {
    const _COMMON_FONTS = [
      'Arial','Arial Black','Arial Narrow','Calibri','Cambria','Comic Sans MS',
      'Courier New','Georgia','Helvetica','Impact','Lucida Console','Lucida Sans',
      'Microsoft Sans Serif','Palatino Linotype','Segoe UI','Tahoma','Times New Roman',
      'Trebuchet MS','Verdana','Wingdings',
    ];
    if (typeof CSSFontFaceSet !== 'undefined') {
      const _origCheck = CSSFontFaceSet.prototype.check;
      CSSFontFaceSet.prototype.check = function(font, text) {
        const name = font.replace(/^[\d.]+px\s+/, '').replace(/['"]/g, '').trim();
        if (_COMMON_FONTS.some(f => name.toLowerCase().includes(f.toLowerCase()))) return true;
        return _origCheck ? _origCheck.call(this, font, text) : false;
      };
    }
  } catch(_) {}

  // 15. History length — inject plausible prior navigation count
  // (natural navigation in executeGhostView builds it further)
  try {
    if (history.length <= 1) {
      const _fakeStops = Math.floor(2 + _rand() * 4); // 2–5 prior pages
      for (let _i = 0; _i < _fakeStops; _i++) {
        history.pushState({}, '', window.location.href);
      }
    }
  } catch(_) {}

})();
  `;
}

// ----------------------------------------------------------------
// Launch browser for a specific account
// Returns { browser, context, page } — caller MUST call cleanup()
// ----------------------------------------------------------------

async function launchForAccount(accountId, platform) {
  if (isAccountBusy(accountId)) {
    throw new Error(`Account ${accountId} already has a running browser instance`);
  }
  if (isConcurrencyFull()) {
    throw new Error(`Concurrent browser limit reached (${MAX_CONCURRENT}). Try again later.`);
  }

  const proxy = getProxyForAccount(accountId);
  const viewport = pick(DESKTOP_VIEWPORTS);
  const ua = pick(USER_AGENTS);
  const gpuPair = pick(GPU_PAIRS);
  const seed = randInt(100000, 999999999);

  log.info('Launching browser', { accountId, platform, proxy: proxy?.host ?? 'none' });

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-extensions',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI,VizDisplayCompositor',
      '--disable-ipc-flooding-protection',
      '--password-store=basic',
      '--use-mock-keychain',
      `--window-size=${viewport.width},${viewport.height}`,
    ],
  };

  if (proxy) {
    launchOptions.proxy = {
      server:   `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  }

  const browser = await chromium.launch(launchOptions);

  const contextOptions = {
    viewport,
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: null,
    permissions: [],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };

  // Load saved storageState if available
  const storageState = loadSession(accountId, platform);
  if (storageState) {
    contextOptions.storageState = storageState;
    log.debug('Loaded existing session', { accountId, platform });
  }

  const context = await browser.newContext(contextOptions);
  await context.addInitScript(buildFingerprintScript(seed, viewport, ua, gpuPair));

  const page = await context.newPage();

  // Intercept and block unnecessary resources (images/fonts in non-critical paths)
  // Disabled by default — enable per-action if needed for speed

  markBusy(accountId);
  log.info('Browser ready', { accountId, platform });

  return {
    browser,
    context,
    page,
    cleanup: async () => {
      try {
        await browser.close();
      } finally {
        markFree(accountId);
        log.debug('Browser closed', { accountId });
      }
    },
  };
}

// ----------------------------------------------------------------
// Launch an anonymous browser (no account, no session)
// Uses concurrency slot so anon + account browsers share the cap
// ----------------------------------------------------------------

let _anonSeq = 0;

// Cached residential proxy pool — refreshed every 60 seconds
let _residentialProxies = null;
let _residentialCacheAt  = 0;

function _getResidentialProxies() {
  const now = Date.now();
  if (!_residentialProxies || now - _residentialCacheAt > 60_000) {
    try {
      _residentialProxies = getDb().prepare(
        `SELECT * FROM proxies WHERE proxy_type='residential' AND status='active'`
      ).all();
      _residentialCacheAt = now;
    } catch (_) {
      _residentialProxies = [];
    }
  }
  return _residentialProxies;
}

// In-memory proxy failure tracker — resets on process restart
// Proxies with PROXY_SKIP_THRESHOLD failures within PROXY_SKIP_WINDOW_MS
// are deprioritised (we fall back to them only if nothing else is available)
const _proxyFailures  = new Map();
const PROXY_SKIP_THRESHOLD = 3;
const PROXY_SKIP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function recordProxyFailure(proxyId) {
  if (!proxyId) return;
  const now   = Date.now();
  const entry = _proxyFailures.get(proxyId) ?? { count: 0, lastAt: 0 };
  if (now - entry.lastAt > PROXY_SKIP_WINDOW_MS) entry.count = 0; // window expired
  entry.count++;
  entry.lastAt = now;
  _proxyFailures.set(proxyId, entry);
  if (entry.count >= PROXY_SKIP_THRESHOLD) {
    log.warn('Proxy temporarily deprioritised after repeated failures', { proxyId, count: entry.count });
  }
}

function _isProxyBad(proxyId) {
  const entry = _proxyFailures.get(proxyId);
  if (!entry || entry.count < PROXY_SKIP_THRESHOLD) return false;
  return Date.now() - entry.lastAt <= PROXY_SKIP_WINDOW_MS;
}

// Pick proxy that matches ghost's region (timezone geo) when possible
// Skips proxies with too many recent failures unless there's no alternative
function _pickProxyForRegion(region) {
  const all = _getResidentialProxies();
  if (!all.length) return null;

  const good     = all.filter(p => !_isProxyBad(p.id));
  const pool     = good.length > 0 ? good : all;           // fallback to all if every proxy is bad
  const matching = pool.filter(p => p.geo_region === region);
  return matching.length > 0 ? pick(matching) : pick(pool);
}

async function launchAnonymous() {
  if (isConcurrencyFull()) {
    throw new Error(`Concurrent browser limit reached (${MAX_CONCURRENT}). Try again later.`);
  }

  const anonId = `anon_${++_anonSeq}`;
  const viewport = pick(DESKTOP_VIEWPORTS);
  const ua = pick(USER_AGENTS);
  const gpuPair = pick(GPU_PAIRS);
  const seed = randInt(100000, 999999999);

  const residentials = _getResidentialProxies();
  const proxy = residentials.length > 0 ? pick(residentials) : null;

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--disable-infobars',
      '--disable-extensions', '--disable-default-apps', '--no-first-run',
      '--no-default-browser-check', '--disable-features=TranslateUI,VizDisplayCompositor',
      '--disable-ipc-flooding-protection', '--password-store=basic', '--use-mock-keychain',
      `--window-size=${viewport.width},${viewport.height}`,
    ],
  };

  if (proxy) {
    launchOptions.proxy = {
      server:   `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  }

  const timezone = pick(ANON_TIMEZONES);
  const [locale, acceptLang] = pick(ANON_LOCALES);

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport,
    userAgent: ua,
    locale,
    timezoneId: timezone,
    extraHTTPHeaders: { 'Accept-Language': acceptLang },
  });
  await context.addInitScript(buildFingerprintScript(seed, viewport, ua, gpuPair));
  const page = await context.newPage();

  markBusy(anonId);
  log.info('Launched anonymous browser', { proxy: proxy ? `${proxy.host}:${proxy.port}` : 'datacenter' });

  return {
    browser, context, page,
    proxyId: proxy?.id ?? null,
    cleanup: async () => {
      try { await browser.close(); } finally { markFree(anonId); }
    },
  };
}

// ----------------------------------------------------------------
// Launch browser as a specific ghost
// Ghost identity: fixed fingerprint + persistent storageState
// Proxy: random residential from pool (not fixed to ghost)
// ----------------------------------------------------------------

async function launchWithGhost(ghostId) {
  if (isConcurrencyFull()) {
    throw new Error(`Concurrent browser limit reached (${MAX_CONCURRENT}). Try again later.`);
  }

  const gm    = require('../ghost/manager');
  const ghost = getDb().prepare('SELECT * FROM ghost_profiles WHERE id=?').get(ghostId);
  if (!ghost) throw new Error(`Ghost ${ghostId} not found`);

  const fp = JSON.parse(ghost.fingerprint_json);

  // Pick proxy that matches ghost's geo region (timezone)
  const proxy = _pickProxyForRegion(fp.region ?? null);

  const slotId = `ghost_${ghostId}`;

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--disable-infobars',
      '--disable-extensions', '--disable-default-apps', '--no-first-run',
      '--no-default-browser-check', '--disable-features=TranslateUI,VizDisplayCompositor',
      '--disable-ipc-flooding-protection', '--password-store=basic', '--use-mock-keychain',
      '--disable-rtc-smoothness-algorithm', '--disable-webrtc-hw-encoding',
      '--disable-webrtc-hw-decoding', '--enforce-webrtc-ip-permission-check',
      `--window-size=${fp.viewport.width},${fp.viewport.height}`,
    ],
  };

  if (proxy) {
    launchOptions.proxy = {
      server:   `${proxy.protocol}://${proxy.host}:${proxy.port}`,
      username: proxy.username ?? undefined,
      password: proxy.password ?? undefined,
    };
  }

  const gpuPair      = [fp.gpuVendor, fp.gpuRenderer];
  const storageState = gm.loadStorageState(ghostId);

  const browser  = await chromium.launch(launchOptions);
  const ctxOpts  = {
    viewport:    fp.viewport,
    userAgent:   fp.userAgent,
    locale:      fp.locale,
    timezoneId:  fp.timezone,
    extraHTTPHeaders: { 'Accept-Language': fp.acceptLanguage },
  };
  if (storageState) ctxOpts.storageState = storageState;

  const context = await browser.newContext(ctxOpts);
  await context.addInitScript(buildFingerprintScript(fp.canvasSeed, fp.viewport, fp.userAgent, gpuPair, {
    locale:              fp.locale,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory:        fp.deviceMemory,
    connectionType:      fp.connectionType ?? 'wifi',
    batteryBase:         fp.batteryBase    ?? 0.65,
  }));
  const page = await context.newPage();

  markBusy(slotId);
  log.info('Ghost browser launched', {
    ghostId,
    proxy: proxy ? `${proxy.host}:${proxy.port}` : 'datacenter',
  });

  // Robust cleanup: force-kills the browser process if close() hangs
  const cleanup = async () => {
    try {
      await Promise.race([
        browser.close(),
        new Promise(r => setTimeout(r, 8_000)), // 8s max to close gracefully
      ]);
    } catch (_) {}
    try { browser.process()?.kill(); } catch (_) {} // force-kill if still alive
    markFree(slotId);
    log.debug('Ghost browser closed', { ghostId });
  };

  return {
    browser, context, page, ghost,
    proxyId: proxy?.id ?? null,
    cleanup,
  };
}

module.exports = { launchForAccount, launchAnonymous, launchWithGhost, isAccountBusy, isConcurrencyFull, recordProxyFailure };
