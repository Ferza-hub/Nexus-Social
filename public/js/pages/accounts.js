// Accounts page — seamless connect flow

const AccountsPage = (() => {

  // Platform metadata
  const PLATFORMS = {
    instagram: { label: 'Instagram', emoji: '📸', methods: ['password', 'facebook'] },
    tiktok:    { label: 'TikTok',    emoji: '🎵', methods: ['password', 'google', 'facebook'] },
    twitter:   { label: 'Twitter/X', emoji: '🐦', methods: ['password'] },
    youtube:   { label: 'YouTube',   emoji: '▶️',  methods: ['password'] },
    facebook:  { label: 'Facebook',  emoji: '👥', methods: ['password'] },
    threads:   { label: 'Threads',   emoji: '🧵', methods: ['password'] },
  };

  const METHOD_LABELS = {
    password: { label: 'Username / Password', icon: '🔑' },
    google:   { label: 'Continue with Google',   icon: 'G' },
    facebook: { label: 'Continue with Facebook', icon: 'f' },
  };

  const CONNECT_ERRORS = {
    login_required:   'Wrong credentials — check username and password',
    challenge:        'Platform requires verification (2FA or captcha) — solve it on the app first',
    disabled:         'This account has been disabled by the platform',
    action_block:     'Account is temporarily blocked — try again later',
    account_busy:     'Account browser is already running — wait a moment',
    concurrency_limit:'Too many simultaneous logins — try again shortly',
    account_not_found:'Account not found',
    login_failed:     'Login failed — check credentials and try again',
  };

  // ----------------------------------------------------------------
  // Badges / helpers
  // ----------------------------------------------------------------

  function badge(status) {
    return `<span class="badge badge-${status}">${status}</span>`;
  }

  function sessionBadge(active, accountId, platform) {
    if (active) return `<span class="session-dot session-dot--on">● Connected</span>`;
    return `<button class="btn btn-primary btn-sm"
              onclick="AccountsPage.openConnect({ id: ${accountId}, platform: '${platform}' })">
              Reconnect
            </button>`;
  }

  function warmupBar(warmup) {
    if (!warmup || warmup.completed) return '<span class="text-muted">—</span>';
    const pct = Math.min(100, Math.round((warmup.current_day / 15) * 100));
    return `
      <div style="min-width:80px">
        <div class="text-sm text-muted">${warmup.current_phase} · day ${warmup.current_day}</div>
        <div class="progress-bar mt-1"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  // ----------------------------------------------------------------
  // Table render
  // ----------------------------------------------------------------

  function renderTable(accounts) {
    if (!accounts.length) return `
      <div class="empty-state">
        <div class="empty-icon">📱</div>
        <div>No accounts yet. Click <strong>Connect Account</strong> to get started.</div>
      </div>`;

    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Account</th><th>Platform</th><th>Status</th>
            <th>Session</th><th>Warmup</th><th>API</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${accounts.map(acc => `
              <tr>
                <td class="text-muted text-sm">${acc.id}</td>
                <td>
                  <strong>${acc.username}</strong>
                  ${acc.email ? `<br><span class="text-muted text-sm">${acc.email}</span>` : ''}
                  ${acc.login_method && acc.login_method !== 'password'
                    ? `<br><span class="text-muted text-sm">via ${acc.login_method}</span>` : ''}
                </td>
                <td><span class="tag">${acc.platform}</span></td>
                <td>${badge(acc.status)}</td>
                <td>${sessionBadge(acc.session_active, acc.id, acc.platform)}</td>
                <td>${warmupBar(acc.warmup)}</td>
                <td>${acc.api_connected ? '<span class="text-success">✓</span>' : '<span class="text-muted">—</span>'}</td>
                <td>
                  <div class="flex gap-1">
                    <button class="btn btn-ghost btn-sm" onclick="AccountsPage.showHealth(${acc.id}, '${acc.username}')">Health</button>
                    <button class="btn btn-ghost btn-sm" onclick="AccountsPage.showUsage(${acc.id}, '${acc.username}')">Usage</button>
                    <button class="btn btn-danger btn-sm" onclick="AccountsPage.remove(${acc.id})">✕</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // ----------------------------------------------------------------
  // Page render
  // ----------------------------------------------------------------

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <button class="btn btn-primary" onclick="AccountsPage.openConnect()">+ Connect Account</button>
      </div>
      <div id="accounts-list">Loading...</div>`;
    await reload();
  }

  async function reload() {
    try {
      const accounts = await API.get('/api/accounts');
      document.getElementById('accounts-list').innerHTML = renderTable(accounts);
    } catch (err) {
      Toast.error(err.message);
    }
  }

  // ----------------------------------------------------------------
  // Connect modal
  // ----------------------------------------------------------------

  function openConnect(existing = null) {
    // existing = { id, platform, username, login_method } for reconnect
    const isReconnect = !!existing;
    const defaultPlatform = existing?.platform ?? 'instagram';
    const defaultMethod   = existing?.login_method ?? 'password';

    Modal.open(
      isReconnect ? `Reconnect Account` : 'Connect Account',
      _connectModalHtml(defaultPlatform, defaultMethod, existing),
      { wide: true }
    );

    // Populate dynamic sections
    _refreshMethodOptions(defaultPlatform, defaultMethod);
    _refreshCredentialLabels(defaultMethod);

    // Pre-fill existing account id for reconnect
    if (existing?.id) {
      const hiddenId = document.getElementById('connect-account-id');
      if (hiddenId) hiddenId.value = existing.id;
    }
  }

  function _connectModalHtml(platform, method, existing) {
    const isReconnect = !!existing;

    const platformGrid = isReconnect ? '' : `
      <div class="form-group">
        <label>Platform</label>
        <div id="connect-platform-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:.4rem;margin-top:.35rem">
          ${Object.entries(PLATFORMS).map(([key, p]) => `
            <button type="button"
              class="btn ${key === platform ? 'btn-primary' : 'btn-ghost'} btn-sm"
              style="justify-content:flex-start;gap:.4rem"
              data-platform="${key}"
              onclick="AccountsPage._selectPlatform('${key}', this)">
              ${p.emoji} ${p.label}
            </button>`).join('')}
        </div>
      </div>`;

    return `
      <input type="hidden" id="connect-account-id" value="">
      <input type="hidden" id="connect-platform" value="${platform}">

      ${platformGrid}

      <div class="form-group" id="connect-method-group">
        <label>Login method</label>
        <div id="connect-method-options" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.35rem"></div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label id="connect-username-label">Username or Email</label>
          <input type="text" id="connect-username"
            value="${existing?.username ?? ''}"
            placeholder="@username or email"
            ${isReconnect ? 'readonly style="opacity:.6"' : ''}>
        </div>
        <div class="form-group">
          <label id="connect-password-label">Password</label>
          <input type="password" id="connect-password"
            placeholder="${isReconnect ? '(leave blank to keep stored)' : 'Your password'}">
        </div>
      </div>

      <details style="margin:.25rem 0 .75rem">
        <summary style="cursor:pointer;color:var(--text-muted);font-size:.85rem;user-select:none">
          Advanced options
        </summary>
        <div style="padding-top:.75rem">
          <div class="form-row">
            <div class="form-group">
              <label>2FA Secret <span class="text-muted text-sm">(TOTP base32)</span></label>
              <input type="text" id="connect-2fa" placeholder="JBSWY3DPEHPK3PXP">
            </div>
            <div class="form-group">
              <label>Phone <span class="text-muted text-sm">(optional)</span></label>
              <input type="text" id="connect-phone" placeholder="+1234567890">
            </div>
          </div>
          <div class="form-group">
            <label>Notes</label>
            <input type="text" id="connect-notes">
          </div>
          ${isReconnect ? '' : `
          <div class="form-group" style="background:var(--bg-2);border-radius:6px;padding:.75rem 1rem">
            <label class="toggle-label">
              <div>
                <div style="font-weight:500">Established account</div>
                <div class="text-muted text-sm">Already has activity history — skip warmup period</div>
              </div>
              <div class="toggle-wrap">
                <input type="checkbox" id="connect-skip-warmup">
                <span class="toggle-slider"></span>
              </div>
            </label>
          </div>`}
        </div>
      </details>

      <div id="connect-status" style="display:none;padding:.75rem 1rem;background:var(--bg-2);border-radius:6px;margin-bottom:.75rem">
        <div style="display:flex;align-items:center;gap:.6rem">
          <span id="connect-status-icon" style="font-size:1.1rem">⏳</span>
          <span id="connect-status-msg" style="font-size:.9rem"></span>
        </div>
      </div>

      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" id="connect-submit-btn"
          onclick="AccountsPage._submitConnect()">Connect →</button>
      </div>`;
  }

  function _selectPlatform(platform, btn) {
    document.getElementById('connect-platform').value = platform;
    document.querySelectorAll('#connect-platform-grid button').forEach(b => {
      b.className = b === btn ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
      b.style.justifyContent = 'flex-start';
      b.style.gap = '.4rem';
    });
    _refreshMethodOptions(platform, 'password');
    _refreshCredentialLabels('password');
  }

  function _refreshMethodOptions(platform, selectedMethod) {
    const methods = PLATFORMS[platform]?.methods ?? ['password'];
    const container = document.getElementById('connect-method-options');
    if (!container) return;

    container.innerHTML = methods.map(m => {
      const info = METHOD_LABELS[m];
      const active = m === selectedMethod;
      return `
        <button type="button"
          class="btn ${active ? 'btn-primary' : 'btn-ghost'} btn-sm"
          style="gap:.35rem"
          data-method="${m}"
          onclick="AccountsPage._selectMethod('${m}', this)">
          <span>${info.icon}</span> ${info.label}
        </button>`;
    }).join('');
  }

  function _selectMethod(method, btn) {
    document.querySelectorAll('#connect-method-options button').forEach(b => {
      b.className = b === btn ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
      b.style.gap = '.35rem';
    });
    _refreshCredentialLabels(method);
  }

  function _refreshCredentialLabels(method) {
    const uLabel = document.getElementById('connect-username-label');
    const pLabel = document.getElementById('connect-password-label');
    if (!uLabel || !pLabel) return;
    if (method === 'google') {
      uLabel.textContent = 'Google Email';
      pLabel.textContent = 'Google Password';
    } else if (method === 'facebook') {
      uLabel.textContent = 'Facebook Email';
      pLabel.textContent = 'Facebook Password';
    } else {
      uLabel.textContent = 'Username or Email';
      pLabel.textContent = 'Password';
    }
  }

  function _getSelectedMethod() {
    const active = document.querySelector('#connect-method-options button.btn-primary');
    return active?.dataset.method ?? 'password';
  }

  function _setStatus(icon, msg, show = true) {
    const area = document.getElementById('connect-status');
    const iconEl = document.getElementById('connect-status-icon');
    const msgEl = document.getElementById('connect-status-msg');
    if (area) area.style.display = show ? 'block' : 'none';
    if (iconEl) iconEl.textContent = icon;
    if (msgEl) msgEl.textContent = msg;
  }

  async function _submitConnect() {
    const accountId  = document.getElementById('connect-account-id')?.value;
    const platform   = document.getElementById('connect-platform')?.value;
    const loginMethod = _getSelectedMethod();
    const username   = document.getElementById('connect-username')?.value.trim().replace('@', '');
    const password   = document.getElementById('connect-password')?.value;
    const twoFaSecret = document.getElementById('connect-2fa')?.value.trim() || undefined;
    const phone      = document.getElementById('connect-phone')?.value.trim() || undefined;
    const notes      = document.getElementById('connect-notes')?.value.trim() || undefined;
    const skipWarmup = document.getElementById('connect-skip-warmup')?.checked ?? false;

    if (!accountId && !username) return Toast.error('Enter a username or email');

    const btn = document.getElementById('connect-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    _setStatus('⏳', 'Opening browser session…');

    const body = {
      login_method: loginMethod,
      username, password, twoFaSecret, phone, notes, skipWarmup,
    };
    if (accountId) {
      body.id = Number(accountId);
    } else {
      body.platform = platform;
    }

    try {
      _setStatus('🌐', 'Logging in via browser — this may take 15–30 seconds…');
      const result = await API.post('/api/accounts/setup', body);
      _setStatus('✅', `Connected — @${result.username} is live on ${result.platform}`);
      await new Promise(r => setTimeout(r, 1200));
      Modal.close();
      Toast.success(`@${result.username} (${result.platform}) connected`);
      await reload();
    } catch (err) {
      const msg = CONNECT_ERRORS[err.message] ?? err.message;
      _setStatus('❌', msg);
      btn.disabled = false;
      btn.textContent = 'Retry →';
    }
  }

  // ----------------------------------------------------------------
  // Other actions (unchanged)
  // ----------------------------------------------------------------

  async function remove(id) {
    Modal.confirm('Delete this account? This cannot be undone.', async () => {
      try {
        await API.delete(`/api/accounts/${id}`);
        Toast.success('Account deleted');
        reload();
      } catch (err) {
        Toast.error(err.message);
      }
    });
  }

  async function showHealth(id, username) {
    try {
      const logs = await API.get(`/api/accounts/${id}/health`);
      const rows = logs.map(l => `
        <div class="log-entry">
          <span class="log-time">${new Date(l.created_at).toLocaleString()}</span>
          <span class="log-${l.event_type}">${l.event_type}</span>
          <span></span>
          <span class="text-muted">${l.message || ''}</span>
        </div>`).join('');
      Modal.open(`Health — ${username}`, `<div>${rows || '<p class="text-muted">No events</p>'}</div>`, { wide: true });
    } catch (err) {
      Toast.error(err.message);
    }
  }

  async function showUsage(id, username) {
    try {
      const usage = await API.get(`/api/accounts/${id}/usage`);
      const rows = Object.entries(usage).map(([action, u]) => `
        <tr>
          <td>${action}</td>
          <td>${u.hour.count} / ${u.hour.limit ?? '∞'}</td>
          <td>${u.day.count}  / ${u.day.limit  ?? '∞'}</td>
          <td class="text-muted text-sm">${u.last_action_at ? new Date(u.last_action_at).toLocaleString() : '—'}</td>
        </tr>`).join('');
      Modal.open(`Rate Limits — ${username}`, `
        <table>
          <thead><tr><th>Action</th><th>Hour</th><th>Day</th><th>Last</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="text-muted">No data</td></tr>'}</tbody>
        </table>`, { wide: true });
    } catch (err) {
      Toast.error(err.message);
    }
  }

  return { render, reload, openConnect, _selectPlatform, _selectMethod, _submitConnect, remove, showHealth, showUsage };
})();
