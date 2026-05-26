// Campaigns page

const CampaignsPage = (() => {
  function badge(v, type) {
    return `<span class="badge badge-${v}">${v}</span>`;
  }

  function progressBar(c) {
    if (!c.target_count) return `<span class="text-muted">${c.completed_count} actions</span>`;
    const pct = Math.min(100, Math.round((c.completed_count / c.target_count) * 100));
    return `
      <div style="min-width:120px">
        <div class="text-sm text-muted">${c.completed_count} / ${c.target_count} (${pct}%)</div>
        <div class="progress-bar mt-1"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  function renderTable(campaigns) {
    if (!campaigns.length) return `
      <div class="empty-state">
        <div class="empty-icon">🚀</div>
        <div>No campaigns yet. Create your first campaign.</div>
      </div>`;

    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Name</th><th>Account</th><th>Type</th>
            <th>Status</th><th>Progress</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${campaigns.map(c => `
              <tr>
                <td class="text-muted text-sm">${c.id}</td>
                <td><strong>${c.name}</strong><br><span class="tag">${c.platform}</span></td>
                <td class="text-muted">${c.username}</td>
                <td>${badge(c.type)}</td>
                <td>${badge(c.status)}</td>
                <td>${progressBar(c)}</td>
                <td>
                  <div class="flex gap-1">
                    ${c.status === 'draft' || c.status === 'paused'
                      ? `<button class="btn btn-success btn-sm" onclick="CampaignsPage.setStatus(${c.id},'running')">▶ Run</button>`
                      : ''}
                    ${c.status === 'running'
                      ? `<button class="btn btn-ghost btn-sm" onclick="CampaignsPage.setStatus(${c.id},'paused')">⏸ Pause</button>`
                      : ''}
                    <button class="btn btn-ghost btn-sm" onclick="CampaignsPage.showLogs(${c.id},'${c.name}')">Logs</button>
                    <button class="btn btn-danger btn-sm" onclick="CampaignsPage.remove(${c.id})">✕</button>
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
        <h1 class="page-title">Campaigns</h1>
        <button class="btn btn-primary" onclick="CampaignsPage.create()">+ New Campaign</button>
      </div>
      <div id="campaigns-list">Loading...</div>`;
    await reload();
  }

  async function reload() {
    try {
      const campaigns = await API.get('/api/campaigns');
      document.getElementById('campaigns-list').innerHTML = renderTable(campaigns);
    } catch (err) { Toast.error(err.message); }
  }

  async function setStatus(id, status) {
    try {
      await API.patch(`/api/campaigns/${id}/status`, { status });
      Toast.success(`Campaign ${status}`);
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  async function remove(id) {
    Modal.confirm('Delete this campaign and all its logs?', async () => {
      try {
        await API.delete(`/api/campaigns/${id}`);
        Toast.success('Campaign deleted');
        reload();
      } catch (err) { Toast.error(err.message); }
    });
  }

  async function showLogs(id, name) {
    try {
      const logs = await API.get(`/api/campaigns/${id}/logs`);
      const rows = logs.map(l => `
        <div class="log-entry">
          <span class="log-time">${new Date(l.created_at).toLocaleString()}</span>
          <span class="badge badge-${l.status}">${l.status}</span>
          <span style="color:var(--text-2)">${l.action}</span>
          <span class="text-muted">${l.message || ''}</span>
        </div>`).join('');
      Modal.open(`Logs — ${name}`, `<div>${rows || '<p class="text-muted">No logs yet</p>'}</div>`, { wide: true });
    } catch (err) { Toast.error(err.message); }
  }

  async function create() {
    let accounts = [];
    try { accounts = await API.get('/api/accounts?status=active'); } catch (_) {}

    Modal.open('New Campaign', `
      <!-- platform options populated on open -->

      <div class="form-group">
        <label>Campaign Name</label>
        <input type="text" id="c-name" placeholder="My Instagram Growth">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Account</label>
          <select id="c-account">
            ${accounts.map(a => `<option value="${a.id}">${a.username} (${a.platform})</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Platform</label>
          <select id="c-platform" onchange="CampaignsPage._onPlatformChange()">
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
            <option value="twitter">Twitter/X</option>
            <option value="youtube">YouTube</option>
            <option value="facebook">Facebook</option>
            <option value="threads">Threads</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Type</label>
          <select id="c-type" onchange="CampaignsPage._toggleConfigFields()">
            <option value="growth">Growth (Playwright)</option>
            <option value="content">Content (API)</option>
            <option value="hybrid">Hybrid (API + Playwright)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Target count (optional)</label>
          <input type="number" id="c-target" placeholder="500">
        </div>
      </div>
      <div id="c-growth-config">
        <div class="form-row">
          <div class="form-group">
            <label>Action</label>
            <select id="c-action"></select>
          </div>
          <div class="form-group">
            <label>Target type</label>
            <select id="c-target-type"></select>
          </div>
        </div>
        <div class="form-group">
          <label>Target value (hashtag, @username, or keyword)</label>
          <input type="text" id="c-target-value" placeholder="photography">
        </div>
        <div class="form-group">
          <label>Daily goal</label>
          <input type="number" id="c-daily" value="30">
        </div>
      </div>
      <div class="flex gap-1 mt-2" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="CampaignsPage._submitCreate()">Create Campaign</button>
      </div>`);
    // Populate action + target dropdowns for default platform
    setTimeout(_onPlatformChange, 0);
  }

  const PLATFORM_ACTIONS = {
    instagram: [
      { value: 'follow',      label: 'Follow' },
      { value: 'unfollow',    label: 'Unfollow' },
      { value: 'like_post',   label: 'Like Post' },
      { value: 'watch_story', label: 'Watch Story' },
      { value: 'watch_reel',  label: 'Watch Reel' },
      { value: 'comment',     label: 'Comment' },
    ],
    tiktok: [
      { value: 'follow',      label: 'Follow' },
      { value: 'like_video',  label: 'Like Video' },
      { value: 'watch_video', label: 'Watch Video' },
      { value: 'comment',     label: 'Comment' },
    ],
    twitter: [
      { value: 'follow',       label: 'Follow' },
      { value: 'unfollow',     label: 'Unfollow' },
      { value: 'like_post',    label: 'Like Post' },
      { value: 'reply_tweet',  label: 'Reply' },
    ],
    youtube: [
      { value: 'subscribe',   label: 'Subscribe' },
      { value: 'like_video',  label: 'Like Video' },
      { value: 'watch_video', label: 'Watch Video' },
      { value: 'share',       label: 'Share Video' },
      { value: 'comment',     label: 'Comment' },
    ],
    facebook: [
      { value: 'follow',      label: 'Follow / Add Friend' },
      { value: 'like_post',   label: 'Like Post' },
      { value: 'watch_reel',  label: 'Watch Reel' },
      { value: 'like_reel',   label: 'Like Reel' },
      { value: 'share',       label: 'Share Post / Reel' },
      { value: 'comment',     label: 'Comment' },
    ],
    threads: [
      { value: 'follow',    label: 'Follow' },
      { value: 'unfollow',  label: 'Unfollow' },
      { value: 'like_post', label: 'Like Post' },
      { value: 'comment',   label: 'Comment' },
    ],
  };

  const PLATFORM_TARGETS = {
    instagram: [
      { value: 'hashtag',    label: 'Hashtag' },
      { value: 'competitor', label: 'Competitor followers' },
      { value: 'explore',    label: 'Explore' },
    ],
    tiktok: [
      { value: 'hashtag',    label: 'Hashtag' },
      { value: 'competitor', label: 'Creator followers' },
    ],
    twitter: [
      { value: 'hashtag',    label: 'Hashtag' },
      { value: 'competitor', label: 'Competitor followers' },
    ],
    youtube: [
      { value: 'keyword',    label: 'Keyword / topic' },
      { value: 'competitor', label: 'Channel subscribers' },
    ],
    facebook: [
      { value: 'hashtag',    label: 'Hashtag / topic' },
      { value: 'competitor', label: 'Page followers' },
    ],
    threads: [
      { value: 'hashtag',    label: 'Hashtag' },
      { value: 'competitor', label: 'Competitor followers' },
    ],
  };

  function _onPlatformChange() {
    const platform = document.getElementById('c-platform')?.value;
    const actionSel = document.getElementById('c-action');
    const targetSel = document.getElementById('c-target-type');
    if (!actionSel || !targetSel || !platform) return;

    actionSel.innerHTML = (PLATFORM_ACTIONS[platform] || [])
      .map(a => `<option value="${a.value}">${a.label}</option>`).join('');
    targetSel.innerHTML = (PLATFORM_TARGETS[platform] || [])
      .map(t => `<option value="${t.value}">${t.label}</option>`).join('');
  }

  function _toggleConfigFields() {
    const type = document.getElementById('c-type')?.value;
    const growthCfg = document.getElementById('c-growth-config');
    if (growthCfg) growthCfg.style.display = type === 'content' ? 'none' : '';
    _onPlatformChange();
  }

  async function _submitCreate() {
    const name      = document.getElementById('c-name').value.trim();
    const accountId = Number(document.getElementById('c-account').value);
    const platform  = document.getElementById('c-platform').value;
    const type      = document.getElementById('c-type').value;
    const targetCount = Number(document.getElementById('c-target').value) || null;

    if (!name || !accountId) return Toast.error('Name and account required');

    let config = {};
    if (type !== 'content') {
      config = {
        action:     document.getElementById('c-action').value,
        target:     {
          type:  document.getElementById('c-target-type').value,
          value: document.getElementById('c-target-value').value.trim().replace('@',''),
        },
        dailyGoal: Number(document.getElementById('c-daily').value) || 30,
      };
    }

    try {
      await API.post('/api/campaigns', { name, accountId, platform, type, config, targetCount });
      Toast.success('Campaign created');
      Modal.close();
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  return { render, reload, setStatus, remove, showLogs, create, _submitCreate, _toggleConfigFields, _onPlatformChange };
})();
