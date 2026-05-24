// Scheduler page — content calendar

const SchedulerPage = (() => {
  function statusBadge(s) {
    return `<span class="badge badge-${s}">${s}</span>`;
  }

  function renderTable(items) {
    if (!items.length) return `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <div>No scheduled posts. Add your first.</div>
      </div>`;

    return `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Scheduled</th><th>Platform</th>
            <th>Type</th><th>Caption preview</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${items.map(item => {
              const content = item.content || {};
              const preview = (content.caption || content.text || content.title || '').slice(0, 60);
              return `
                <tr>
                  <td class="text-muted text-sm">${item.id}</td>
                  <td>${new Date(item.scheduled_at).toLocaleString()}</td>
                  <td><span class="tag">${item.platform}</span></td>
                  <td><span class="tag">${content.type || '—'}</span></td>
                  <td class="text-muted">${preview || '—'}</td>
                  <td>${statusBadge(item.status)}</td>
                  <td>
                    ${item.status === 'pending'
                      ? `<button class="btn btn-danger btn-sm" onclick="SchedulerPage.cancel(${item.id})">Cancel</button>`
                      : ''}
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Scheduler</h1>
        <button class="btn btn-primary" onclick="SchedulerPage.add()">+ Schedule Post</button>
      </div>
      <div id="scheduler-list">Loading...</div>`;
    await reload();
  }

  async function reload() {
    try {
      const items = await API.get('/api/schedule');
      document.getElementById('scheduler-list').innerHTML = renderTable(items);
    } catch (err) { Toast.error(err.message); }
  }

  async function cancel(id) {
    Modal.confirm('Cancel this scheduled post?', async () => {
      try {
        await API.delete(`/api/schedule/${id}`);
        Toast.success('Post cancelled');
        reload();
      } catch (err) { Toast.error(err.message); }
    });
  }

  async function add() {
    let accounts = [];
    try { accounts = await API.get('/api/accounts?status=active'); } catch (_) {}

    Modal.open('Schedule Post', `
      <div class="form-row">
        <div class="form-group">
          <label>Account</label>
          <select id="sp-account">
            ${accounts.map(a => `<option value="${a.id}">${a.username} (${a.platform})</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Platform</label>
          <select id="sp-platform">
            <option value="instagram">Instagram</option>
            <option value="twitter">Twitter/X</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube</option>
            <option value="linkedin">LinkedIn</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Content type</label>
          <select id="sp-type">
            <option value="photo">Photo</option>
            <option value="video">Video</option>
            <option value="carousel">Carousel</option>
            <option value="text">Text only</option>
          </select>
        </div>
        <div class="form-group">
          <label>Scheduled at</label>
          <input type="datetime-local" id="sp-scheduled">
        </div>
      </div>
      <div class="form-group">
        <label>Caption / Text</label>
        <textarea id="sp-caption" placeholder="Write your caption here..."></textarea>
      </div>
      <div class="form-group">
        <label>Media URL(s) — one per line</label>
        <textarea id="sp-media" placeholder="https://..." style="min-height:60px"></textarea>
      </div>
      <div class="form-group">
        <label>Hashtags — comma separated (without #)</label>
        <input type="text" id="sp-hashtags" placeholder="photography, nature, travel">
      </div>
      <div class="flex gap-1 mt-2" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="SchedulerPage._submitAdd()">Schedule</button>
      </div>`);

    // Default to 1 hour from now
    const d = new Date(Date.now() + 3600000);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('sp-scheduled').value = local;
  }

  async function _submitAdd() {
    const accountId   = Number(document.getElementById('sp-account').value);
    const platform    = document.getElementById('sp-platform').value;
    const type        = document.getElementById('sp-type').value;
    const scheduledAt = document.getElementById('sp-scheduled').value;
    const caption     = document.getElementById('sp-caption').value.trim();
    const mediaRaw    = document.getElementById('sp-media').value.trim();
    const hashtagRaw  = document.getElementById('sp-hashtags').value.trim();

    if (!scheduledAt) return Toast.error('Scheduled time required');

    const mediaUrls = mediaRaw ? mediaRaw.split('\n').map(l => l.trim()).filter(Boolean) : [];
    const hashtags  = hashtagRaw ? hashtagRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    const content = { type, caption, text: caption, mediaUrls, hashtags };

    try {
      await API.post('/api/schedule', { accountId, platform, content, scheduledAt });
      Toast.success('Post scheduled');
      Modal.close();
      reload();
    } catch (err) { Toast.error(err.message); }
  }

  return { render, reload, cancel, add, _submitAdd };
})();
