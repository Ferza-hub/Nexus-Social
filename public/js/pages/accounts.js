// Accounts page

const AccountsPage = (() => {
  function badge(status) {
    return `<span class="badge badge-${status}">${status}</span>`;
  }

  function sessionBadge(active, accountId, username, platform) {
    if (active) return `<span class="session-dot session-dot--on">● Connected</span>`;
    return `
      <div class="flex gap-1">
        <button class="btn btn-ghost btn-sm session-connect-btn"
          onclick="AccountsPage.connect(${accountId}, '${username}', '${platform}', this)">Connect</button>
        <button class="btn btn-ghost btn-sm"
          title="Import cookies from browser (for Google/Facebook OAuth accounts)"
          onclick="AccountsPage.importSession(${accountId}, '${username}', '${platform}')">Import</button>
      </div>`;
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

  function renderTable(accounts) {
    if (!accounts.length) return `
      <div class="empty-state">
        <div class="empty-icon">👤</div>
        <div>No accounts yet. Add your first account.</div>
      </div>`;

    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Username</th><th>Platform</th><th>Status</th>
            <th>Session</th><th>Warmup</th><th>API</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${accounts.map(acc => `
              <tr>
                <td class="text-muted text-sm">${acc.id}</td>
                <td><strong>${acc.username}</strong>${acc.email ? `<br><span class="text-muted text-sm">${acc.email}</span>` : ''}</td>
                <td><span class="tag">${acc.platform}</span></td>
                <td>${badge(acc.status)}</td>
                <td>${sessionBadge(acc.session_active, acc.id, acc.username, acc.platform)}</td>
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

  async function render() {
    const container = document.getElementById('page-container');
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Accounts</h1>
        <button class="btn btn-primary" onclick="AccountsPage.add()">+ Add Account</button>
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

  function add() {
    Modal.open('Add Account', `
      <div class="form-group">
        <label>Platform</label>
        <select id="acc-platform">
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
          <option value="twitter">Twitter/X</option>
          <option value="youtube">YouTube</option>
          <option value="facebook">Facebook</option>
          <option value="threads">Threads</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="acc-username" placeholder="@username">
        </div>
        <div class="form-group">
          <label>Password <span class="text-muted text-sm">(leave blank if using cookie import)</span></label>
          <input type="password" id="acc-password">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Email (optional)</label>
          <input type="email" id="acc-email">
        </div>
        <div class="form-group">
          <label>Phone (optional)</label>
          <input type="text" id="acc-phone" placeholder="+1234567890">
        </div>
      </div>
      <div class="form-group">
        <label>2FA Secret (TOTP base32, optional)</label>
        <input type="text" id="acc-2fa" placeholder="JBSWY3DPEHPK3PXP">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <input type="text" id="acc-notes">
      </div>
      <div class="form-group" style="background:var(--bg-2);border-radius:6px;padding:.75rem 1rem">
        <label class="toggle-label">
          <div>
            <div style="font-weight:500">Established account</div>
            <div class="text-muted text-sm">Account already has activity history — skip warmup and start immediately</div>
          </div>
          <div class="toggle-wrap">
            <input type="checkbox" id="acc-skip-warmup">
            <span class="toggle-slider"></span>
          </div>
        </label>
      </div>
      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="AccountsPage._submitAdd()">Add Account</button>
      </div>`);
  }

  async function _submitAdd() {
    const body = {
      platform:     document.getElementById('acc-platform').value,
      username:     document.getElementById('acc-username').value.trim().replace('@',''),
      password:     document.getElementById('acc-password').value,
      email:        document.getElementById('acc-email').value.trim() || undefined,
      phone:        document.getElementById('acc-phone').value.trim() || undefined,
      twoFaSecret:  document.getElementById('acc-2fa').value.trim() || undefined,
      notes:        document.getElementById('acc-notes').value.trim() || undefined,
      skipWarmup:   document.getElementById('acc-skip-warmup').checked,
    };
    if (!body.username) return Toast.error('Username required');
    if (!body.password) body.password = null;
    try {
      await API.post('/api/accounts', body);
      Toast.success('Account added');
      Modal.close();
      reload();
    } catch (err) {
      Toast.error(err.message);
    }
  }

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

  const CONNECT_ERRORS = {
    login_required:   'Wrong username or password',
    challenge:        'Platform requires verification — check 2FA or solve captcha manually first',
    disabled:         'Account has been disabled by the platform',
    action_block:     'Account is temporarily blocked by the platform',
    account_busy:     'Account is already running — try again in a moment',
    concurrency_limit:'Too many concurrent sessions — try again shortly',
    account_not_found:'Account not found',
  };

  async function connect(id, username, platform, btn) {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      await API.post(`/api/accounts/${id}/connect`, {});
      Toast.success(`@${username} (${platform}) connected — engine session active`);
      await reload();
    } catch (err) {
      const msg = CONNECT_ERRORS[err.message] ?? `Connection failed: ${err.message}`;
      Toast.error(msg);
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  function importSession(id, username, platform) {
    Modal.open(`Import Session — @${username} (${platform})`, `
      <div class="form-group">
        <p class="text-sm" style="line-height:1.6">
          Use this when the account logs in via <strong>Google, Facebook, or Apple</strong>,
          or when auto-connect fails. No password is needed.
        </p>
        <ol class="text-sm" style="line-height:1.8;padding-left:1.25rem;margin:.5rem 0">
          <li>Install the <strong>Cookie Editor</strong> browser extension
            (<a href="https://cookie-editor.com" target="_blank" rel="noopener" style="color:var(--accent)">cookie-editor.com</a>)</li>
          <li>Open <strong>${_platformUrl(platform)}</strong> and log in normally in your browser</li>
          <li>Click the Cookie Editor icon → <strong>Export → Export as JSON</strong></li>
          <li>Paste the copied JSON below</li>
        </ol>
      </div>
      <div class="form-group">
        <label>Cookies JSON</label>
        <textarea id="import-cookies-json" rows="8"
          style="font-family:monospace;font-size:0.75rem;width:100%;resize:vertical"
          placeholder='[{"name":"sessionid","value":"...","domain":".${platform}.com",...}]'></textarea>
      </div>
      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="AccountsPage._submitImport(${id}, '${username}', '${platform}')">Save Session</button>
      </div>`, { wide: true });
  }

  function _platformUrl(platform) {
    const urls = {
      instagram: 'instagram.com', facebook: 'facebook.com',
      twitter: 'x.com', tiktok: 'tiktok.com',
      youtube: 'youtube.com', threads: 'threads.net',
    };
    return urls[platform] ?? platform;
  }

  async function _submitImport(id, username, platform) {
    const raw = document.getElementById('import-cookies-json').value.trim();
    if (!raw) return Toast.error('Paste the cookie JSON first');
    try {
      await API.post(`/api/accounts/${id}/import-session`, { cookies_json: raw });
      Toast.success(`Session imported for @${username} (${platform})`);
      Modal.close();
      await reload();
    } catch (err) {
      Toast.error(err.message);
    }
  }

  return { render, reload, add, _submitAdd, remove, showHealth, showUsage, connect, importSession, _submitImport };
})();
