// Proxies page

const ProxiesPage = (() => {
  function statusBadge(s) {
    return `<span class="badge badge-${s === 'active' ? 'active' : s === 'banned' ? 'flagged' : 'draft'}">${s}</span>`;
  }

  function renderTable(proxies) {
    if (!proxies.length) return `
      <div class="empty-state">
        <div class="empty-icon">🔗</div>
        <div>No proxies yet. Import your proxies.</div>
      </div>`;

    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Host:Port</th><th>Auth</th><th>Protocol</th>
            <th>Status</th><th>Assigned to</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${proxies.map(p => `
              <tr>
                <td class="text-muted text-sm">${p.id}</td>
                <td><code>${p.host}:${p.port}</code></td>
                <td>${p.username ? `<code>${p.username}</code>` : '<span class="text-muted">—</span>'}</td>
                <td><span class="tag">${p.protocol}</span></td>
                <td>${statusBadge(p.status)}</td>
                <td>${p.assigned_to ? `<span class="text-accent">${p.assigned_to}</span>` : '<span class="text-muted">—</span>'}</td>
                <td>
                  <div class="flex gap-1">
                    ${p.status !== 'banned'
                      ? `<button class="btn btn-ghost btn-sm" onclick="ProxiesPage.ban(${p.id})">Ban</button>`
                      : `<button class="btn btn-ghost btn-sm" onclick="ProxiesPage.activate(${p.id})">Unban</button>`}
                    <button class="btn btn-danger btn-sm" onclick="ProxiesPage.remove(${p.id})">✕</button>
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
        <h1 class="page-title">Proxies</h1>
        <div class="flex gap-1">
          <button class="btn btn-ghost" onclick="ProxiesPage.addSingle()">+ Single</button>
          <button class="btn btn-primary" onclick="ProxiesPage.bulkImport()">⬆ Bulk Import</button>
        </div>
      </div>
      <div id="proxies-list">Loading...</div>`;
    await reload();
  }

  async function reload() {
    try {
      const proxies = await API.get('/api/proxies');
      document.getElementById('proxies-list').innerHTML = renderTable(proxies);
    } catch (err) { Toast.error(err.message); }
  }

  function addSingle() {
    Modal.open('Add Proxy', `
      <div class="form-row">
        <div class="form-group">
          <label>Host</label>
          <input type="text" id="p-host" placeholder="1.2.3.4 or proxy.example.com">
        </div>
        <div class="form-group">
          <label>Port</label>
          <input type="number" id="p-port" placeholder="8080">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Username (optional)</label>
          <input type="text" id="p-user">
        </div>
        <div class="form-group">
          <label>Password (optional)</label>
          <input type="password" id="p-pass">
        </div>
      </div>
      <div class="form-group">
        <label>Protocol</label>
        <select id="p-proto">
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
          <option value="socks5">SOCKS5</option>
        </select>
      </div>
      <div class="flex gap-1 mt-2" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="ProxiesPage._submitSingle()">Add</button>
      </div>`);
  }

  async function _submitSingle() {
    const host = document.getElementById('p-host').value.trim();
    const port = Number(document.getElementById('p-port').value);
    if (!host || !port) return Toast.error('Host and port required');

    try {
      await API.post('/api/proxies', {
        host, port,
        username: document.getElementById('p-user').value.trim() || undefined,
        password: document.getElementById('p-pass').value || undefined,
        protocol: document.getElementById('p-proto').value,
      });
      Toast.success('Proxy added');
      Modal.close();
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  function bulkImport() {
    Modal.open('Bulk Import Proxies', `
      <p class="text-muted text-sm" style="margin-bottom:12px">Format: <code>host:port</code> or <code>host:port:user:pass</code> — one per line</p>
      <div class="form-group">
        <label>Protocol</label>
        <select id="bulk-proto"><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select>
      </div>
      <div class="form-group">
        <textarea id="bulk-lines" style="min-height:200px;font-family:monospace;font-size:12px" placeholder="1.2.3.4:8080&#10;5.6.7.8:3128:user:pass"></textarea>
      </div>
      <div class="flex gap-1 mt-2" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="ProxiesPage._submitBulk()">Import</button>
      </div>`);
  }

  async function _submitBulk() {
    const raw  = document.getElementById('bulk-lines').value.trim();
    const proto = document.getElementById('bulk-proto').value;
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return Toast.error('No lines to import');

    try {
      const result = await API.post('/api/proxies/bulk', { lines, protocol: proto });
      Toast.success(`Imported ${result.inserted} proxies${result.errors.length ? `, ${result.errors.length} errors` : ''}`);
      Modal.close();
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function ban(id) {
    try {
      await API.patch(`/api/proxies/${id}/status`, { status: 'banned' });
      Toast.info('Proxy banned');
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function activate(id) {
    try {
      await API.patch(`/api/proxies/${id}/status`, { status: 'active' });
      Toast.success('Proxy activated');
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function remove(id) {
    Modal.confirm('Delete this proxy?', async () => {
      try {
        await API.delete(`/api/proxies/${id}`);
        Toast.success('Proxy deleted');
        reload();
      } catch (err) { Toast.error(err.message); }
    });
  }

  return { render, reload, addSingle, _submitSingle, bulkImport, _submitBulk, ban, activate, remove };
})();
