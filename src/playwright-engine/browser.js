'use strict';

const { chromium } = require('playwright');
const { makeLogger } = require('../utils/logger');
const { loadSession } = require('../account-manager/session-manager');
const { getProxyForAccount } = require('../account-manager/index');

const log = makeLogger('Browser');

// ----------------------------------------------------------------
// Prevent >1 browser per account simultaneously
// ----------------------------------------------------------------

const _activeBrowsers = new Set();

function isAccountBusy(accountId) {
  return _activeBrowsers.has(accountId);
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
// Build the fingerprint init script injected via addInitScript
// Inherited from nexus-playwright pattern
// ----------------------------------------------------------------

function buildFingerprintScript(seed, viewport, ua, gpuPair) {
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

  // 1. Navigator — disable automation flags
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'languages',          { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'platform',           { get: () => 'Win32' });
  Object.defineProperty(navigator, 'vendor',             { get: () => 'Google Inc.' });
  Object.defineProperty(navigator, 'hardwareConcurrency',{ get: () => ${randInt(4, 16)} });
  Object.defineProperty(navigator, 'deviceMemory',       { get: () => ${pick([4, 8, 16])} });
  Object.defineProperty(navigator, 'maxTouchPoints',     { get: () => 0 });

  // 2. Plugins (PDF viewer mocks)
  const _plugins = [
    { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 0 },
    { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 0 },
    { name: 'Native Client',      filename: 'internal-nacl-plugin', description: '', length: 0 },
  ];
  _plugins.item      = i => _plugins[i];
  _plugins.namedItem = n => _plugins.find(p => p.name === n) || null;
  _plugins.refresh   = () => {};
  Object.defineProperty(navigator, 'plugins', { get: () => _plugins });
  Object.defineProperty(navigator, 'mimeTypes', { get: () => ({ length: 2, item: () => null, namedItem: () => null }) });

  // 3. window.chrome (simulate real Chrome environment)
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
        },
        runtime: {
          connect: () => {},
          sendMessage: () => {},
          PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux' },
          PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
          id: undefined,
        },
        csi: () => {},
        loadTimes: () => ({
          commitLoadTime: Date.now() / 1000 - _rand() * 2,
          connectionInfo: 'h2',
          finishDocumentLoadTime: 0,
          finishLoadTime: 0,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: 0,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - _rand() * 3,
          startLoadTime: Date.now() / 1000 - _rand() * 2.5,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        }),
      },
      writable: false,
      configurable: false,
    });
  }

  // 4. Canvas — per-session imperceptible noise
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

  // 5. WebGL — realistic GPU vendor/renderer
  const _gpuVendor   = '${gpuPair[0]}';
  const _gpuRenderer = '${gpuPair[1]}';

  const _patchWebGL = (ctx) => {
    if (!ctx) return;
    const _origGP = ctx.getParameter.bind(ctx);
    ctx.getParameter = function(param) {
      if (param === 37445) return _gpuVendor;   // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return _gpuRenderer; // UNMASKED_RENDERER_WEBGL
      return _origGP(param);
    };
  };

  const _origGetCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type) {
    const ctx = _origGetCtx.apply(this, arguments);
    if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
      _patchWebGL(ctx);
    }
    return ctx;
  };

  // 6. Audio context — negligible float noise
  try {
    const _origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function() {
      const data = _origGetChannelData.apply(this, arguments);
      for (let i = 0; i < Math.min(data.length, 50); i++) {
        data[i] += (_rand() - 0.5) * 5e-8;
      }
      return data;
    };
  } catch(_) {}

  // 7. Battery API mock
  try {
    Object.defineProperty(navigator, 'getBattery', {
      value: () => Promise.resolve({
        charging: _rand() > 0.25,
        chargingTime: 0,
        dischargingTime: Math.floor(4000 + _rand() * 14400),
        level: 0.3 + _rand() * 0.7,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      writable: false,
      configurable: false,
    });
  } catch(_) {}

  // 8. Network info
  try {
    const _conn = {
      downlink: 10 + _rand() * 90,
      effectiveType: '4g',
      rtt: Math.floor(10 + _rand() * 40),
      saveData: false,
      type: 'wifi',
      addEventListener: () => {},
    };
    Object.defineProperty(navigator, 'connection', { get: () => _conn });
  } catch(_) {}

  // 9. Permissions — return 'prompt' for sensitive APIs
  try {
    const _origQuery = Permissions.prototype.query;
    Permissions.prototype.query = function(desc) {
      const sensitive = ['notifications','push','midi','camera','microphone','speaker','device-info','background-sync','bluetooth','persistent-storage','ambient-light-sensor','accelerometer','gyroscope','magnetometer','clipboard-read','clipboard-write'];
      if (sensitive.includes(desc.name)) {
        return Promise.resolve({ state: 'prompt', onchange: null, addEventListener: () => {} });
      }
      return _origQuery.call(this, desc);
    };
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

module.exports = { launchForAccount, isAccountBusy };
