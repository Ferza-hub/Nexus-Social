// Accounts page

const AccountsPage = (() => {
  function badge(status) {
    return `<span class="badge badge-${status}">${status}</span>`;
  }

  function sessionBadge(active, accountId) {
    return active
      ? `<span class="session-dot session-dot--on">● Connected</span>`
      : `<button class="btn btn-ghost btn-sm session-connect-btn" onclick="AccountsPage.connect(${accountId}, this)">Connect</button>`;
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
                <td>${sessionBadge(acc.session_active, acc.id)}</td>
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
          <label>Password</label>
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
    if (!body.username || !body.password) return Toast.error('Username and password required');
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

  async function connect(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      await API.post(`/api/accounts/${id}/connect`, {});
      Toast.success('Account connected — session active');
      await reload();
    } catch (err) {
      Toast.error(`Connect failed: ${err.message}`);
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  return { render, reload, add, _submitAdd, remove, showHealth, showUsage, connect };
})();
