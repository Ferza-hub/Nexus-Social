// Analytics page

const AnalyticsPage = (() => {
  function statCard(label, value, sub = '') {
    return `
      <div class="card">
        <div class="card-title">${label}</div>
        <div class="card-value">${value}</div>
        ${sub ? `<div class="text-sm text-muted mt-1">${sub}</div>` : ''}
      </div>`;
  }

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header"><h1 class="page-title">Analytics</h1></div>
      <div id="analytics-content">Loading...</div>`;
    await reload();
  }

  async function reload() {
    try {
      const data = await API.get('/api/analytics');
      const { accounts, jobs, deliveredToday, recentActivity } = data;

      // Accounts summary
      const acctTotal   = accounts.reduce((s, a) => s + a.total,   0);
      const acctActive  = accounts.reduce((s, a) => s + a.active,  0);
      const acctExpired = accounts.reduce((s, a) => s + a.expired, 0);

      // Jobs summary
      const jobRunning   = jobs.running   ?? 0;
      const jobCompleted = jobs.completed ?? 0;
      const jobFailed    = jobs.failed    ?? 0;

      // Delivered today rows
      const todayRows = (deliveredToday ?? []).map(r => `
        <tr>
          <td><span class="tag">${r.platform}</span></td>
          <td>${r.action_type}</td>
          <td style="font-weight:600;color:#22c55e">${r.completed ?? 0}</td>
          <td class="text-muted">${r.target ?? 0}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="text-muted">No activity today</td></tr>';

      // Recent activity
      const activityRows = (recentActivity ?? []).map(e => `
        <div class="log-entry">
          <span class="log-time">${new Date(e.created_at).toLocaleString()}</span>
          <span class="badge badge-${e.status}">${e.status}</span>
          <span style="color:var(--text-2)">${e.platform} · ${e.action}</span>
          <span class="text-muted">${e.message || ''}</span>
        </div>`).join('') || '<p class="text-muted">No recent activity</p>';

      // Accounts per platform
      const platformRows = accounts.map(a => `
        <tr>
          <td><span class="tag">${a.platform}</span></td>
          <td style="color:#22c55e">${a.active}</td>
          <td style="color:#f59e0b">${a.expired}</td>
          <td>${a.total}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="text-muted">No accounts</td></tr>';

      document.getElementById('analytics-content').innerHTML = `
        <div class="stat-grid">
          ${statCard('Key Accounts', acctTotal,   `${acctActive} active · ${acctExpired} expired`)}
          ${statCard('Jobs Running', jobRunning,  `${jobCompleted} completed · ${jobFailed} failed`)}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">Delivered Today</div>
            <table>
              <thead><tr><th>Platform</th><th>Action</th><th>Done</th><th>Target</th></tr></thead>
              <tbody>${todayRows}</tbody>
            </table>
          </div>
          <div class="card">
            <div class="card-title">Accounts by Platform</div>
            <table>
              <thead><tr><th>Platform</th><th>Active</th><th>Expired</th><th>Total</th></tr></thead>
              <tbody>${platformRows}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Recent Activity</div>
          ${activityRows}
        </div>`;
    } catch (err) { Toast.error(err.message); }
  }

  return { render, reload };
})();
