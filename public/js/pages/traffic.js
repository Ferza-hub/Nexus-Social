// Traffic Engine page

const TrafficPage = (() => {

  // ----------------------------------------------------------------
  // Platform / action config
  // ----------------------------------------------------------------

  const PLATFORMS = {
    instagram: { label: 'Instagram', emoji: '📸', actions: ['views', 'likes', 'followers'] },
    tiktok:    { label: 'TikTok',    emoji: '🎵', actions: ['views', 'likes', 'followers'] },
    twitter:   { label: 'Twitter/X', emoji: '🐦', actions: ['likes', 'followers'] },
    youtube:   { label: 'YouTube',   emoji: '▶️',  actions: ['views', 'likes', 'followers'] },
    facebook:  { label: 'Facebook',  emoji: '👥', actions: ['views', 'likes', 'followers'] },
    threads:   { label: 'Threads',   emoji: '🧵', actions: ['likes', 'followers'] },
  };

  const ACTION_META = {
    views:     { label: 'Views',     icon: '👁', hint: 'Paste the content URL (reel, video, post)' },
    likes:     { label: 'Likes',     icon: '❤️',  hint: 'Paste the content URL (post, tweet, video)' },
    followers: { label: 'Followers', icon: '➕', hint: 'Paste the profile URL or just the @username' },
  };

  let _pollTimer  = null;
  let _activeId   = null;
  let _platform   = 'instagram';
  let _actionType = 'views';

  // ----------------------------------------------------------------
  // Page render
  // ----------------------------------------------------------------

  function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Traffic Engine</h1>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start">
        <!-- Left: new job form -->
        <div class="card" style="padding:1.25rem">
          <h3 style="margin:0 0 1rem;font-size:1rem">New Job</h3>

          <div class="form-group">
            <label>Platform</label>
            <div id="tr-platform-grid"
              style="display:grid;grid-template-columns:repeat(3,1fr);gap:.35rem;margin-top:.4rem">
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
            <div id="tr-action-grid"
              style="display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.4rem">
            </div>
          </div>

          <div class="form-group">
            <label id="tr-target-label">Target URL or username</label>
            <input type="text" id="tr-target"
              style="width:100%;box-sizing:border-box"
              placeholder="">
            <div id="tr-target-hint" class="text-muted text-sm" style="margin-top:.25rem"></div>
          </div>

          <div class="form-row" style="align-items:flex-end">
            <div class="form-group" style="flex:1">
              <label>Count</label>
              <input type="number" id="tr-count" value="20" min="1" max="5000"
                style="width:100%;box-sizing:border-box">
            </div>
            <div class="form-group" style="flex:1">
              <label>Available accounts</label>
              <div id="tr-avail"
                style="padding:.55rem .75rem;background:var(--bg-2);border-radius:6px;font-size:.9rem">
                —
              </div>
            </div>
          </div>

          <div id="tr-capacity-warn"
            style="display:none;padding:.65rem .85rem;background:rgba(245,158,11,.12);
                   border:1px solid rgba(245,158,11,.35);border-radius:6px;
                   font-size:.82rem;color:#d97706;margin-bottom:.75rem">
          </div>

          <button class="btn btn-primary w-full" id="tr-start-btn"
            onclick="TrafficPage._start()">
            ▶ Start
          </button>
        </div>

        <!-- Right: active + history -->
        <div>
          <div id="tr-active-section" style="display:none;margin-bottom:1.25rem">
            <h3 style="font-size:.95rem;margin:0 0 .6rem">Active</h3>
            <div id="tr-active-card"></div>
          </div>

          <h3 style="font-size:.95rem;margin:0 0 .6rem">Recent Jobs</h3>
          <div id="tr-history">Loading…</div>
        </div>
      </div>

      <div style="margin-top:1.5rem">
        <div class="card" style="padding:1.25rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.9rem">
            <h3 style="margin:0;font-size:.95rem">Traffic Accounts <span class="text-muted text-sm">(for Likes &amp; Followers)</span></h3>
            <button class="btn btn-primary btn-sm" onclick="TrafficPage._addTrafficAccounts()">+ Bulk Import</button>
          </div>
          <div id="tr-acct-summary" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.5rem">
            Loading…
          </div>
        </div>
      </div>`;

    _refreshActionGrid(_platform);
    _refreshAvailability(_platform);
    _loadHistory();
    _loadTrafficAccounts();
  }

  function destroy() {
    _stopPoll();
  }

  // ----------------------------------------------------------------
  // Platform / action selection
  // ----------------------------------------------------------------

  function _setPlatform(platform, btn) {
    _platform = platform;
    _actionType = PLATFORMS[platform].actions[0];

    document.querySelectorAll('#tr-platform-grid button').forEach(b => {
      b.className = 'btn btn-ghost btn-sm';
      b.style.justifyContent = 'flex-start';
      b.style.gap = '.35rem';
    });
    btn.className = 'btn btn-primary btn-sm';
    btn.style.justifyContent = 'flex-start';
    btn.style.gap = '.35rem';

    _refreshActionGrid(platform);
    _refreshAvailability(platform);
  }

  function _setAction(action, btn) {
    _actionType = action;
    document.querySelectorAll('#tr-action-grid button').forEach(b => {
      b.className = 'btn btn-ghost btn-sm';
      b.style.gap = '.3rem';
    });
    btn.className = 'btn btn-primary btn-sm';
    btn.style.gap = '.3rem';
    _refreshHint(action);
    _refreshAvailability(_platform);
  }

  function _refreshActionGrid(platform) {
    const container = document.getElementById('tr-action-grid');
    if (!container) return;
    const actions = PLATFORMS[platform]?.actions ?? [];
    // Keep current action if valid, else reset
    if (!actions.includes(_actionType)) _actionType = actions[0];

    container.innerHTML = actions.map(a => {
      const meta = ACTION_META[a];
      return `
        <button type="button"
          class="btn ${a === _actionType ? 'btn-primary' : 'btn-ghost'} btn-sm"
          style="gap:.3rem"
          onclick="TrafficPage._setAction('${a}', this)">
          ${meta.icon} ${meta.label}
        </button>`;
    }).join('');

    _refreshHint(_actionType);
  }

  function _refreshHint(action) {
    const hint = ACTION_META[action]?.hint ?? '';
    const el = document.getElementById('tr-target-hint');
    if (el) el.textContent = hint;
  }

  const ANON_ACTIONS = new Set(['views']);

  async function _refreshAvailability(platform) {
    const el = document.getElementById('tr-avail');

    if (ANON_ACTIONS.has(_actionType)) {
      if (el) {
        el.textContent = 'Anonymous traffic';
        el.style.color = 'var(--text-success, #22c55e)';
      }
      const warn = document.getElementById('tr-capacity-warn');
      if (warn) warn.style.display = 'none';
      return;
    }

    try {
      const data = await API.get(`/api/traffic/accounts?platform=${platform}`);
      if (el) {
        el.textContent = data.count > 0
          ? `${data.count} account${data.count !== 1 ? 's' : ''} ready`
          : 'None — connect accounts first';
        el.style.color = data.count > 0 ? 'var(--text-success, #22c55e)' : 'var(--text-muted)';
      }
      _updateCapacityWarn(data.count);
    } catch (_) {}
  }

  function _updateCapacityWarn(accountCount) {
    const count = Number(document.getElementById('tr-count')?.value ?? 0);
    const warn  = document.getElementById('tr-capacity-warn');
    if (!warn) return;

    if (ANON_ACTIONS.has(_actionType)) {
      warn.style.display = 'none';
      return;
    }

    const maxUnique = accountCount;
    if (count > maxUnique && maxUnique > 0) {
      warn.style.display = 'block';
      warn.textContent   =
        `⚠ You have ${maxUnique} account${maxUnique !== 1 ? 's' : ''} — ` +
        `${_actionType} are one-time per account, so max unique ${_actionType} = ${maxUnique}. ` +
        `Add more accounts to increase reach.`;
    } else {
      warn.style.display = 'none';
    }
  }

  // ----------------------------------------------------------------
  // Start job
  // ----------------------------------------------------------------

  async function _start() {
    const target = document.getElementById('tr-target')?.value.trim();
    const count  = Number(document.getElementById('tr-count')?.value ?? 0);

    if (!target) return Toast.error('Enter a target URL or username');
    if (!count || count < 1) return Toast.error('Count must be at least 1');

    const btn = document.getElementById('tr-start-btn');
    btn.disabled    = true;
    btn.textContent = 'Starting…';

    try {
      const result = await API.post('/api/traffic', {
        platform:     _platform,
        action_type:  _actionType,
        target_value: target,
        count,
      });

      Toast.success(result.anonymous
        ? `Job #${result.id} started — anonymous traffic running`
        : `Job #${result.id} started — ${result.accounts_available} accounts working`);
      _activeId = result.id;
      _startPoll(result.id);
      document.getElementById('tr-target').value = '';
      await _loadHistory();
    } catch (err) {
      Toast.error(err.message);
    } finally {
      btn.disabled    = false;
      btn.textContent = '▶ Start';
    }
  }

  // ----------------------------------------------------------------
  // Polling — live progress for active job
  // ----------------------------------------------------------------

  function _startPoll(jobId) {
    _stopPoll();
    _pollTimer = setInterval(() => _pollJob(jobId), 2500);
    _pollJob(jobId);
  }

  function _stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  async function _pollJob(jobId) {
    try {
      const job = await API.get(`/api/traffic/${jobId}`);
      _renderActiveCard(job);

      if (!['running', 'pending'].includes(job.status)) {
        _stopPoll();
        await _loadHistory();
        if (job.status === 'completed') {
          Toast.success(`Job #${job.id} completed — ${job.completed_count}/${job.target_count} ${job.action_type}`);
        }
        const section = document.getElementById('tr-active-section');
        if (section) {
          await new Promise(r => setTimeout(r, 3000));
          section.style.display = 'none';
        }
      }
    } catch (_) {}
  }

  function _renderActiveCard(job) {
    const section = document.getElementById('tr-active-section');
    const card    = document.getElementById('tr-active-card');
    if (!section || !card) return;
    section.style.display = 'block';

    const pct    = job.target_count > 0
      ? Math.round((job.completed_count / job.target_count) * 100) : 0;
    const p      = PLATFORMS[job.platform] ?? { emoji: '?', label: job.platform };
    const a      = ACTION_META[job.action_type] ?? { icon: '', label: job.action_type };
    const isLive = ['running', 'pending'].includes(job.status);

    card.innerHTML = `
      <div style="background:var(--bg-2);border-radius:8px;padding:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
          <div>
            <span class="tag">${p.emoji} ${p.label}</span>
            <span style="margin-left:.4rem;font-weight:500">${a.icon} ${a.label}</span>
          </div>
          <div style="display:flex;align-items:center;gap:.5rem">
            ${isLive ? `<span style="color:#22c55e;font-size:.8rem">● running</span>` : `<span class="text-muted text-sm">${job.status}</span>`}
            ${isLive ? `<button class="btn btn-ghost btn-sm" onclick="TrafficPage._stop(${job.id})">⏸ Pause</button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="TrafficPage._delete(${job.id})">🗑</button>
          </div>
        </div>
        <div class="text-muted text-sm" style="margin-bottom:.5rem;word-break:break-all">${job.target_value}</div>
        <div class="progress-bar" style="height:10px;margin-bottom:.35rem">
          <div class="progress-fill" style="width:${pct}%;transition:width .4s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:.82rem;color:var(--text-muted)">
          <span>${job.completed_count} / ${job.target_count} ${a.label.toLowerCase()}</span>
          <span>${pct}%</span>
        </div>
        ${job.recent_logs?.length ? `
          <div style="margin-top:.75rem;font-size:.78rem;color:var(--text-muted)">
            ${job.recent_logs.slice(0,5).map(l => `
              <div style="display:flex;gap:.5rem;padding:.2rem 0;border-bottom:1px solid var(--border)">
                <span style="color:${l.status === 'success' ? '#22c55e' : '#f59e0b'}">
                  ${l.status === 'success' ? '✓' : '↷'}
                </span>
                <span>${l.account_id === 0 ? 'anonymous' : '@' + (l.username ?? l.account_id)}</span>
                <span style="margin-left:auto">${l.status}</span>
              </div>`).join('')}
          </div>` : ''}
      </div>`;
  }

  async function _stop(jobId) {
    try {
      await API.post(`/api/traffic/${jobId}/stop`, {});
      Toast.success('Job paused');
    } catch (err) {
      Toast.error(err.message);
    }
  }

  async function _delete(jobId) {
    try {
      if (jobId === _activeId) {
        _stopPoll();
        _activeId = null;
        const section = document.getElementById('tr-active-section');
        if (section) section.style.display = 'none';
      }
      await API.delete(`/api/traffic/${jobId}`);
      Toast.success('Job deleted');
      await _loadHistory();
    } catch (err) {
      Toast.error(err.message);
    }
  }

  // ----------------------------------------------------------------
  // History
  // ----------------------------------------------------------------

  async function _loadHistory() {
    try {
      const jobs = await API.get('/api/traffic');
      const el   = document.getElementById('tr-history');
      if (!el) return;

      if (!jobs.length) {
        el.innerHTML = '<div class="text-muted text-sm">No jobs yet.</div>';
        return;
      }

      el.innerHTML = jobs.slice(0, 20).map(job => {
        const p    = PLATFORMS[job.platform] ?? { emoji: '?', label: job.platform };
        const a    = ACTION_META[job.action_type] ?? { icon: '', label: job.action_type };
        const pct  = job.target_count > 0
          ? Math.round((job.completed_count / job.target_count) * 100) : 0;
        const age  = _age(job.created_at);

        const statusColor = {
          completed: '#22c55e', running: '#3b82f6', pending: '#f59e0b',
          failed: '#ef4444', paused: '#94a3b8',
        }[job.status] ?? '#94a3b8';

        return `
          <div style="background:var(--bg-2);border-radius:8px;padding:.85rem;margin-bottom:.6rem;
                      border-left:3px solid ${statusColor}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div style="font-size:.85rem">
                <span class="tag">${p.emoji} ${p.label}</span>
                <span style="margin-left:.35rem">${a.icon} ${a.label}</span>
              </div>
              <div style="display:flex;gap:.5rem;align-items:center">
                <span class="text-muted text-sm">${age}</span>
                ${['running','pending'].includes(job.status)
                  ? `<button class="btn btn-ghost btn-sm"
                       onclick="TrafficPage._watchJob(${job.id})">Watch</button>`
                  : ''}
                <button class="btn btn-danger btn-sm"
                  onclick="TrafficPage._delete(${job.id})">🗑</button>
              </div>
            </div>
            <div class="text-muted text-sm" style="margin:.3rem 0;word-break:break-all">${job.target_value}</div>
            <div style="display:flex;align-items:center;gap:.75rem">
              <div class="progress-bar" style="flex:1;height:6px">
                <div class="progress-fill" style="width:${pct}%"></div>
              </div>
              <span style="font-size:.8rem;white-space:nowrap;color:${statusColor}">
                ${job.completed_count}/${job.target_count}
              </span>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      const el = document.getElementById('tr-history');
      if (el) el.innerHTML = `<div class="text-muted text-sm">${err.message}</div>`;
    }
  }

  function _watchJob(jobId) {
    _activeId = jobId;
    _startPoll(jobId);
  }

  // ----------------------------------------------------------------
  // Traffic Accounts panel
  // ----------------------------------------------------------------

  async function _loadTrafficAccounts() {
    const platforms = ['instagram','tiktok','twitter','youtube','facebook','threads'];
    const el = document.getElementById('tr-acct-summary');
    if (!el) return;
    try {
      const counts = await Promise.all(
        platforms.map(p => API.get(`/api/traffic/accounts?platform=${p}`).catch(() => ({ platform: p, count: 0 })))
      );
      el.innerHTML = counts.map(d => {
        const meta = { instagram:'📸', tiktok:'🎵', twitter:'🐦', youtube:'▶️', facebook:'👥', threads:'🧵' };
        return `
          <div style="background:var(--bg-2);border-radius:6px;padding:.65rem .85rem;text-align:center">
            <div style="font-size:1.1rem">${meta[d.platform] ?? '?'}</div>
            <div style="font-size:.78rem;color:var(--text-muted);margin:.1rem 0">${d.platform}</div>
            <div style="font-weight:600;color:${d.count > 0 ? '#22c55e' : 'var(--text-muted)'}">${d.count}</div>
          </div>`;
      }).join('');
    } catch (_) {}
  }

  function _addTrafficAccounts() {
    Modal.open('Bulk Import Traffic Accounts', `
      <div class="form-group">
        <label>Platform</label>
        <select id="tr-bulk-platform">
          <option value="instagram">📸 Instagram</option>
          <option value="tiktok">🎵 TikTok</option>
          <option value="twitter">🐦 Twitter/X</option>
          <option value="youtube">▶️ YouTube</option>
          <option value="facebook">👥 Facebook</option>
          <option value="threads">🧵 Threads</option>
        </select>
      </div>
      <div class="form-group">
        <label>Accounts <span class="text-muted text-sm">— one per line, format: username:password</span></label>
        <textarea id="tr-bulk-lines" rows="8" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:.82rem"
          placeholder="john_doe:mypassword123&#10;jane_doe:secret456&#10;worker_123:p@ssw0rd"></textarea>
      </div>
      <div id="tr-bulk-result" style="font-size:.82rem;margin-bottom:.5rem"></div>
      <div class="flex gap-1" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="TrafficPage._submitBulkTraffic()">Import</button>
      </div>`);
  }

  async function _submitBulkTraffic() {
    const platform = document.getElementById('tr-bulk-platform')?.value;
    const raw = document.getElementById('tr-bulk-lines')?.value ?? '';
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return Toast.error('Paste at least one username:password line');

    const resultEl = document.getElementById('tr-bulk-result');
    if (resultEl) resultEl.textContent = 'Importing…';

    try {
      const data = await API.post('/api/accounts/bulk-traffic', { platform, lines });
      if (resultEl) {
        resultEl.innerHTML = `<span style="color:#22c55e">✓ Added ${data.added} of ${lines.length}</span>` +
          (data.added < lines.length
            ? ` — ${data.results.filter(r => !r.ok).map(r => r.error).slice(0,3).join(', ')}`
            : '');
      }
      if (data.added > 0) {
        await _loadTrafficAccounts();
        _refreshAvailability(_platform);
      }
    } catch (err) {
      Toast.error(err.message);
    }
  }

  function _age(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const m    = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h    = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  return { render, destroy, _setPlatform, _setAction, _start, _stop, _delete, _watchJob, _addTrafficAccounts, _submitBulkTraffic };
})();
