// Traffic Engine page

const TrafficPage = (() => {
  const PLATFORMS = {
    instagram: { label: 'Instagram', emoji: '📸', actions: ['views', 'likes', 'followers'] },
    tiktok:    { label: 'TikTok',    emoji: '🎵', actions: ['views', 'likes', 'followers'] },
    twitter:   { label: 'Twitter/X', emoji: '🐦', actions: ['likes', 'followers'] },
    youtube:   { label: 'YouTube',   emoji: '▶️',  actions: ['views'] },
    facebook:  { label: 'Facebook',  emoji: '👥', actions: ['views', 'likes', 'followers'] },
    threads:   { label: 'Threads',   emoji: '🧵', actions: ['likes', 'followers'] },
  };

  const ACTION_HINT = {
    views:     'Paste the content URL (reel, video, post)',
    likes:     'Paste the content URL (post, tweet, video)',
    followers: 'Paste the profile URL or @username',
  };

  let _platform   = 'instagram';
  let _actionType = 'views';
  let _pollTimer  = null;
  let _activeId   = null;

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header"><h1 class="page-title">Traffic Engine</h1></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start">

        <!-- Left: new job form -->
        <div class="card" style="padding:1.25rem">
          <h3 style="margin:0 0 1rem;font-size:1rem">New Job</h3>

          <div class="form-group">
            <label>Platform</label>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem;margin-top:.4rem">
              ${Object.entries(PLATFORMS).map(([key, p]) => `
                <button type="button"
                  class="btn ${key === _platform ? 'btn-primary' : 'btn-ghost'} btn-sm"
                  style="justify-content:flex-start;gap:.35rem"
                  data-platform="${key}"
                  onclick="TrafficPage._setPlatform('${key}', this)">
                  ${p.emoji} ${p.label}
                </button>`).join('')}
            </div>
          </div>

          <div class="form-group">
            <label>Traffic type</label>
            <div id="tr-action-grid" style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.4rem"></div>
          </div>

          <div class="form-group">
            <label id="tr-target-label">Target URL or username</label>
            <input type="text" id="tr-target" style="width:100%;box-sizing:border-box" placeholder="">
            <div id="tr-target-hint" class="text-muted text-sm" style="margin-top:.25rem"></div>
          </div>

          <div class="form-group">
            <label>Count</label>
            <input type="number" id="tr-count" value="20" min="1" max="5000"
              style="width:100%;box-sizing:border-box">
          </div>

          <button class="btn btn-primary w-full" onclick="TrafficPage._start()">▶ Start</button>
        </div>

        <!-- Right: active + history -->
        <div>
          <div id="tr-active-section" style="display:none;margin-bottom:1.25rem">
            <h3 style="font-size:.95rem;margin:0 0 .6rem">Active</h3>
            <div id="tr-active-card"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
            <h3 style="font-size:.95rem;margin:0">Recent Jobs</h3>
            <button class="btn btn-ghost btn-sm" onclick="TrafficPage._loadHistory()">↺</button>
          </div>
          <div id="tr-history">Loading…</div>
        </div>
      </div>

      <div style="margin-top:1.5rem">
        <div class="card" style="padding:1.25rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
            <h3 style="margin:0;font-size:.95rem">Residential Proxies</h3>
            <button class="btn btn-primary btn-sm" onclick="TrafficPage._addProxies()">+ Bulk Import</button>
          </div>
          <div id="tr-proxy-summary" class="text-muted text-sm">Loading…</div>
        </div>
      </div>`;

    _refreshActionGrid();
    _loadHistory();
    _loadProxySummary();
  }

  function destroy() {
    _stopPoll();
  }

  // ----------------------------------------------------------------
  // Platform / action selection
  // ----------------------------------------------------------------

  function _setPlatform(key, btn) {
    _platform = key;
    document.querySelectorAll('[data-platform]').forEach(b => {
      b.className = b.dataset.platform === key
        ? 'btn btn-primary btn-sm'
        : 'btn btn-ghost btn-sm';
      b.style.cssText = 'justify-content:flex-start;gap:.35rem';
    });
    _refreshActionGrid();
  }

  function _refreshActionGrid() {
    const actions = PLATFORMS[_platform]?.actions ?? [];
    if (!actions.includes(_actionType)) _actionType = actions[0];
    document.getElementById('tr-action-grid').innerHTML = actions.map(a => `
      <button type="button"
        class="btn ${a === _actionType ? 'btn-primary' : 'btn-ghost'} btn-sm"
        onclick="TrafficPage._setAction('${a}', this)">
        ${a}
      </button>`).join('');
    _updateHint();
  }

  function _setAction(a, btn) {
    _actionType = a;
    document.querySelectorAll('#tr-action-grid button').forEach(b => {
      b.className = b.textContent.trim() === a ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
    });
    _updateHint();
  }

  function _updateHint() {
    const el = document.getElementById('tr-target-hint');
    if (el) el.textContent = ACTION_HINT[_actionType] ?? '';
  }

  // ----------------------------------------------------------------
  // Start job
  // ----------------------------------------------------------------

  async function _start() {
    const target = document.getElementById('tr-target')?.value.trim();
    const count  = Number(document.getElementById('tr-count')?.value ?? 20);
    if (!target) return Toast.error('Enter a target URL or username');
    if (!count || count < 1) return Toast.error('Count must be ≥ 1');

    try {
      const data = await API.post('/api/traffic', {
        platform:     _platform,
        action_type:  _actionType,
        target_value: target,
        count,
      });
      Toast.success(`Job #${data.id} started`);
      _activeId = data.id;
      _loadHistory();
      _startPoll(data.id);
    } catch (err) { Toast.error(err.message); }
  }

  // ----------------------------------------------------------------
  // Job history
  // ----------------------------------------------------------------

  async function _loadHistory() {
    const el = document.getElementById('tr-history');
    if (!el) return;
    try {
      const jobs = await API.get('/api/traffic');
      if (!jobs.length) {
        el.innerHTML = '<div class="text-muted text-sm">No jobs yet.</div>';
        return;
      }
      el.innerHTML = `
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>#</th><th>Platform</th><th>Action</th>
              <th>Progress</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${jobs.map(j => {
                const pct = j.target_count
                  ? Math.min(100, Math.round((j.completed_count / j.target_count) * 100))
                  : 0;
                return `
                  <tr>
                    <td class="text-muted text-sm">${j.id}</td>
                    <td><span class="tag">${j.platform}</span></td>
                    <td>${j.action_type}</td>
                    <td>
                      <div class="text-sm text-muted">${j.completed_count} / ${j.target_count} (${pct}%)</div>
                      <div class="progress-bar mt-1">
                        <div class="progress-fill" style="width:${pct}%"></div>
                      </div>
                    </td>
                    <td><span class="badge badge-${j.status}">${j.status}</span></td>
                    <td>
                      ${j.status === 'running'
                        ? `<button class="btn btn-ghost btn-sm"
                             onclick="TrafficPage._stop(${j.id})">Stop</button>`
                        : ''}
                      <button class="btn btn-danger btn-sm"
                        onclick="TrafficPage._delete(${j.id})">✕</button>
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) { Toast.error(err.message); }
  }

  async function _stop(id) {
    try {
      await API.post(`/api/traffic/${id}/stop`);
      Toast.success('Job stopped');
      _loadHistory();
    } catch (err) { Toast.error(err.message); }
  }

  async function _delete(id) {
    Modal.confirm('Delete this job and its logs?', async () => {
      try {
        await API.delete(`/api/traffic/${id}`);
        Toast.success('Job deleted');
        _loadHistory();
      } catch (err) { Toast.error(err.message); }
    });
  }

  // ----------------------------------------------------------------
  // Poll active job
  // ----------------------------------------------------------------

  function _startPoll(id) {
    _stopPoll();
    _pollTimer = setInterval(async () => {
      try {
        const j = await API.get(`/api/traffic/${id}`);
        _renderActive(j);
        if (!j.is_running) _stopPoll();
      } catch (_) { _stopPoll(); }
    }, 3000);
  }

  function _stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  function _renderActive(j) {
    const section = document.getElementById('tr-active-section');
    const card    = document.getElementById('tr-active-card');
    if (!section || !card) return;

    if (!j || !j.is_running) {
      section.style.display = 'none';
      _loadHistory();
      return;
    }

    section.style.display = '';
    const pct = j.target_count
      ? Math.min(100, Math.round((j.completed_count / j.target_count) * 100))
      : 0;
    card.innerHTML = `
      <div class="card" style="padding:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
          <div>
            <span class="tag">${j.platform}</span>
            <span style="margin-left:.35rem">${j.action_type}</span>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="TrafficPage._stop(${j.id})">Stop</button>
        </div>
        <div class="text-sm text-muted" style="margin-bottom:.4rem">
          ${j.completed_count} / ${j.target_count} (${pct}%)
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="text-muted text-sm" style="margin-top:.4rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${j.target_value}
        </div>
      </div>`;
  }

  // ----------------------------------------------------------------
  // Proxies
  // ----------------------------------------------------------------

  async function _loadProxySummary() {
    const el = document.getElementById('tr-proxy-summary');
    if (!el) return;
    try {
      const data = await API.get('/api/proxies/residential/count');
      el.innerHTML = `<strong style="color:${data.active > 0 ? '#22c55e' : '#f59e0b'}">${data.active}</strong>
        active residential proxies (${data.total} total) — each ghost view uses a random proxy`;
    } catch (_) {
      el.textContent = 'Failed to load proxy count.';
    }
  }

  function _addProxies() {
    Modal.open('Bulk Import Residential Proxies', `
      <div class="form-group">
        <label>Proxies <span class="text-muted text-sm">— one per line: host:port or host:port:user:pass</span></label>
        <textarea id="px-lines" rows="8"
          style="width:100%;box-sizing:border-box;font-family:monospace;font-size:.82rem"
          placeholder="123.45.67.89:8000&#10;proxy.example.com:3128:user:pass"></textarea>
      </div>
      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="TrafficPage._submitProxies()">Import</button>
      </div>`);
  }

  async function _submitProxies() {
    const raw   = document.getElementById('px-lines')?.value.trim() ?? '';
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return Toast.error('Paste at least one proxy line');
    try {
      const data = await API.post('/api/proxies/bulk', { lines, proxy_type: 'residential' });
      Toast.success(`Imported ${data.inserted} of ${lines.length} proxies`);
      if (data.errors?.length) Toast.info(`${data.errors.length} lines skipped`);
      Modal.close();
      _loadProxySummary();
    } catch (err) { Toast.error(err.message); }
  }

  return {
    render, destroy,
    _setPlatform, _setAction, _start,
    _loadHistory, _stop, _delete,
    _addProxies, _submitProxies,
  };
})();
