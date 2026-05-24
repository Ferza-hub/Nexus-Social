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

  function campaignRow(c) {
    const pct = c.target_count ? Math.min(100, Math.round((c.completed_count / c.target_count) * 100)) : 0;
    return `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td><span class="tag">${c.type}</span></td>
        <td><span class="tag">${c.platform}</span></td>
        <td><span class="badge badge-${c.status}">${c.status}</span></td>
        <td>
          <div class="text-sm text-muted">${c.completed_count}${c.target_count ? ` / ${c.target_count}` : ''}</div>
          ${c.target_count ? `<div class="progress-bar mt-1"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
        </td>
      </tr>`;
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
      const { accounts, campaigns, posts, actionsToday, recentAlerts, campaignProgress } = data;

      const actionRows = actionsToday.map(a =>
        `<tr><td>${a.action_type}</td><td>${a.total}</td></tr>`
      ).join('') || '<tr><td colspan="2" class="text-muted">No actions today</td></tr>';

      const alertRows = recentAlerts.map(a => `
        <div class="log-entry">
          <span class="log-time">${new Date(a.created_at).toLocaleString()}</span>
          <span class="log-${a.event_type}">${a.event_type}</span>
          <span class="text-accent">${a.username}</span>
          <span class="text-muted">${a.message || ''}</span>
        </div>`).join('') || '<p class="text-muted">No recent alerts</p>';

      document.getElementById('analytics-content').innerHTML = `
        <div class="stat-grid">
          ${statCard('Total Accounts',  accounts.total,    `${accounts.active} active · ${accounts.warming} warming`)}
          ${statCard('Flagged',         accounts.flagged,  'need attention')}
          ${statCard('Campaigns',       campaigns.total,   `${campaigns.running} running`)}
          ${statCard('Posts Published', posts.published,   `${posts.pending} pending`)}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">Actions Today</div>
            <table><tbody>${actionRows}</tbody></table>
          </div>
          <div class="card">
            <div class="card-title">Recent Alerts</div>
            ${alertRows}
          </div>
        </div>

        ${campaignProgress.length ? `
          <div class="card">
            <div class="card-title">Active Campaigns</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Type</th><th>Platform</th><th>Status</th><th>Progress</th></tr></thead>
                <tbody>${campaignProgress.map(campaignRow).join('')}</tbody>
              </table>
            </div>
          </div>` : ''}`;
    } catch (err) { Toast.error(err.message); }
  }

  return { render, reload };
})();
