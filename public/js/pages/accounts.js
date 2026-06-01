// Key Accounts page — platform login credentials for ghost actions

const AccountsPage = (() => {
  function badge(status) {
    return `<span class="badge badge-${status}">${status}</span>`;
  }

  function renderTable(accounts) {
    if (!accounts.length) return `
      <div class="empty-state">
        <div class="empty-icon">🔑</div>
        <div>No key accounts yet. Add credentials to enable likes, follows, and comments.</div>
      </div>`;

    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Platform</th><th>Email</th><th>Status</th>
            <th>Session</th><th>Last used</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${accounts.map(a => `
              <tr>
                <td class="text-muted text-sm">${a.id}</td>
                <td><span class="tag">${a.platform}</span></td>
                <td>${a.email}</td>
                <td>${badge(a.status)}</td>
                <td>${a.storage_state_path
                  ? '<span style="color:#22c55e">✓ cached</span>'
                  : '<span class="text-muted">—</span>'}</td>
                <td class="text-muted text-sm">${a.last_used_at
                  ? new Date(a.last_used_at).toLocaleString()
                  : '—'}</td>
                <td>
                  <div class="flex gap-1">
                    ${a.status !== 'active'
                      ? `<button class="btn btn-ghost btn-sm"
                           onclick="AccountsPage.setStatus(${a.id},'active')">Reactivate</button>`
                      : ''}
                    <button class="btn btn-danger btn-sm"
                      onclick="AccountsPage.remove(${a.id})">✕</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Key Accounts</h1>
        <div class="flex gap-1">
          <button class="btn btn-ghost" onclick="AccountsPage.bulkAdd()">Bulk import</button>
          <button class="btn btn-primary" onclick="AccountsPage.add()">+ Add account</button>
        </div>
      </div>
      <p class="text-muted text-sm" style="margin-bottom:1rem">
        These are "key" accounts used for actions (likes, follows, comments).
        Ghost views are anonymous — no account needed.
      </p>
      <div id="accounts-list">Loading...</div>`;
    await reload();
  }

  async function reload() {
    try {
      const accounts = await API.get('/api/accounts');
      document.getElementById('accounts-list').innerHTML = renderTable(accounts);
    } catch (err) { Toast.error(err.message); }
  }

  function add() {
    Modal.open('Add Key Account', `
      <div class="form-group">
        <label>Platform</label>
        <select id="acc-platform">
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
          <option value="twitter">Twitter / X</option>
          <option value="youtube">YouTube</option>
          <option value="facebook">Facebook</option>
          <option value="threads">Threads</option>
        </select>
      </div>
      <div class="form-group">
        <label>Email / Username</label>
        <input type="text" id="acc-email" placeholder="account@email.com">
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="acc-password">
      </div>
      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="AccountsPage._submitAdd()">Add</button>
      </div>`);
  }

  async function _submitAdd() {
    const platform = document.getElementById('acc-platform').value;
    const email    = document.getElementById('acc-email').value.trim();
    const password = document.getElementById('acc-password').value;
    if (!email || !password) return Toast.error('Email and password required');
    try {
      await API.post('/api/accounts', { platform, email, password });
      Toast.success('Account added');
      Modal.close();
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  function bulkAdd() {
    Modal.open('Bulk Import Accounts', `
      <div class="form-group">
        <label>Platform</label>
        <select id="acc-bulk-platform">
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
          <option value="twitter">Twitter / X</option>
          <option value="youtube">YouTube</option>
          <option value="facebook">Facebook</option>
          <option value="threads">Threads</option>
        </select>
      </div>
      <div class="form-group">
        <label>Accounts <span class="text-muted text-sm">— one per line: email:password</span></label>
        <textarea id="acc-bulk-lines" rows="8"
          style="width:100%;box-sizing:border-box;font-family:monospace;font-size:.82rem"
          placeholder="user@gmail.com:password123&#10;other@email.com:secret456"></textarea>
      </div>
      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="AccountsPage._submitBulk()">Import</button>
      </div>`);
  }

  async function _submitBulk() {
    const platform = document.getElementById('acc-bulk-platform').value;
    const raw      = document.getElementById('acc-bulk-lines').value.trim();
    const lines    = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return Toast.error('Paste at least one line');

    const accounts = lines.map(line => {
      const idx      = line.indexOf(':');
      const email    = line.slice(0, idx).trim();
      const password = line.slice(idx + 1).trim();
      return { email, password };
    }).filter(a => a.email && a.password);

    if (!accounts.length) return Toast.error('No valid lines (expected email:password)');

    try {
      const data = await API.post('/api/accounts/bulk', { platform, accounts });
      Toast.success(`Imported ${data.inserted} of ${accounts.length}`);
      Modal.close();
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function setStatus(id, status) {
    try {
      await API.patch(`/api/accounts/${id}/status`, { status });
      Toast.success(`Status updated to ${status}`);
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function remove(id) {
    Modal.confirm('Delete this account?', async () => {
      try {
        await API.delete(`/api/accounts/${id}`);
        Toast.success('Account deleted');
        reload();
      } catch (err) { Toast.error(err.message); }
    });
  }

  return { render, reload, add, _submitAdd, bulkAdd, _submitBulk, setStatus, remove };
})();
