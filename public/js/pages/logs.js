// Logs page — real-time log stream

const LogsPage = (() => {
  let _eventSource = null;
  let _entries = [];

  function eventClass(e) {
    if (e.event_type === 'ok' || e.status === 'success') return 'log-ok';
    if (['challenge','captcha'].includes(e.event_type))  return 'log-challenge';
    if (e.event_type === 'action_block' || e.status === 'blocked') return 'log-action_block';
    if (['disabled','failed'].includes(e.event_type || e.status))  return 'log-error';
    return 'log-warning';
  }

  function renderEntry(e) {
    const time     = new Date(e.created_at).toLocaleString();
    const platform = e.platform || '—';
    const who      = e.job_id ? `job #${e.job_id}` : '—';
    const action   = e.action || e.event_type || '—';
    const msg      = e.message || '';
    const cls      = eventClass(e);
    return `
      <div class="log-entry">
        <span class="log-time">${time}</span>
        <span class="${cls}">${action}</span>
        <span style="color:var(--text-2)">${who} · ${platform}</span>
        <span class="text-muted">${msg}</span>
      </div>`;
  }

  function renderAll() {
    const container = document.getElementById('log-stream');
    if (!container) return;
    container.innerHTML = _entries.map(renderEntry).join('');
    container.scrollTop = container.scrollHeight;
  }

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Logs</h1>
        <div class="flex gap-1">
          <select id="log-type" onchange="LogsPage.reload()">
            <option value="">All platforms</option>
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
            <option value="twitter">Twitter/X</option>
            <option value="youtube">YouTube</option>
            <option value="facebook">Facebook</option>
            <option value="threads">Threads</option>
          </select>
          <button class="btn btn-ghost" onclick="LogsPage.reload()">↺ Refresh</button>
          <button id="stream-btn" class="btn btn-success btn-sm" onclick="LogsPage.toggleStream()">▶ Live</button>
        </div>
      </div>
      <div id="log-stream" style="max-height:calc(100vh - 160px);overflow-y:auto;"></div>`;
    await reload();
  }

  async function reload() {
    _stopStream();
    try {
      const platform = document.getElementById('log-type')?.value || '';
      const path = `/api/logs${platform ? `?platform=${platform}&limit=200` : '?limit=200'}`;
      _entries = await API.get(path);
      renderAll();
    } catch (err) { Toast.error(err.message); }
  }

  function _stopStream() {
    if (_eventSource) { _eventSource.close(); _eventSource = null; }
    const btn = document.getElementById('stream-btn');
    if (btn) { btn.textContent = '▶ Live'; btn.className = 'btn btn-success btn-sm'; }
  }

  function toggleStream() {
    if (_eventSource) {
      _stopStream();
      return;
    }

    const token = localStorage.getItem('nx_token') || '';
    _eventSource = new EventSource(`/api/logs/stream?token=${token}`);

    _eventSource.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        _entries.unshift(entry);
        if (_entries.length > 300) _entries.pop();
        const container = document.getElementById('log-stream');
        if (container) {
          container.insertAdjacentHTML('afterbegin', renderEntry(entry));
        }
      } catch (_) {}
    };

    _eventSource.onerror = () => {
      Toast.info('Log stream disconnected');
      _stopStream();
    };

    const btn = document.getElementById('stream-btn');
    if (btn) { btn.textContent = '⏸ Stop'; btn.className = 'btn btn-ghost btn-sm'; }
  }

  // Clean up SSE when navigating away
  function destroy() {
    _stopStream();
  }

  return { render, reload, toggleStream, destroy };
})();
