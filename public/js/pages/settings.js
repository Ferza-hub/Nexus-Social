// Settings page — change password + speed mode

const SettingsPage = (() => {

  async function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Settings</h1>
      </div>

      <div class="settings-card" style="margin-bottom:1.5rem">
        <h2 class="settings-section-title">Speed Mode</h2>
        <p class="text-muted mt-1" style="margin-bottom:1.25rem">
          Removes cosmetic waiting time (pre/post-action pauses, scroll reading pauses).
          Functional delays — page loads, click settle time, typing rhythm — are kept
          at a safe minimum so actions complete correctly and aren't flagged as invalid.
        </p>
        <label class="toggle-label" id="speed-mode-row">
          <span id="speed-mode-text">Loading…</span>
          <div class="toggle-wrap">
            <input type="checkbox" id="speed-mode-toggle" onchange="SettingsPage.toggleSpeedMode(this.checked)">
            <span class="toggle-slider"></span>
          </div>
        </label>
      </div>

      <div class="settings-card">
        <h2 class="settings-section-title">Change Password</h2>
        <p class="text-muted mt-1" style="margin-bottom:1.5rem">
          After saving, all active sessions will be signed out and you'll need to log in again.
        </p>

        <form id="change-pw-form" autocomplete="off">
          <div class="form-group">
            <label class="form-label">Current password</label>
            <input type="password" id="cp-current" class="form-input" autocomplete="current-password" placeholder="Current password">
          </div>
          <div class="form-group">
            <label class="form-label">New password</label>
            <input type="password" id="cp-new" class="form-input" autocomplete="new-password" placeholder="Min. 8 characters">
          </div>
          <div class="form-group">
            <label class="form-label">Confirm new password</label>
            <input type="password" id="cp-confirm" class="form-input" autocomplete="new-password" placeholder="Repeat new password">
          </div>
          <p id="cp-error" class="error-text hidden" style="margin-bottom:.75rem"></p>
          <button type="submit" id="cp-btn" class="btn btn-primary">Save new password</button>
        </form>
      </div>
    `;

    // Load current speed mode state
    try {
      const s = await API.get('/api/settings');
      _applySpeedMode(s.speed_mode);
    } catch (_) {}

    document.getElementById('change-pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = document.getElementById('cp-current').value;
      const newPw   = document.getElementById('cp-new').value;
      const confirm = document.getElementById('cp-confirm').value;
      const errEl   = document.getElementById('cp-error');
      const btn     = document.getElementById('cp-btn');

      errEl.classList.add('hidden');

      if (newPw !== confirm) {
        errEl.textContent = 'New passwords do not match';
        errEl.classList.remove('hidden');
        return;
      }
      if (newPw.length < 8) {
        errEl.textContent = 'New password must be at least 8 characters';
        errEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        await API.changePassword(current, newPw);
        Toast.show('Password changed — please sign in again', 'success');
        setTimeout(() => {
          API.clearToken();
          window.location.reload();
        }, 1500);
      } catch (err) {
        errEl.textContent = err.message || 'Failed to change password';
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Save new password';
      }
    });
  }

  function _applySpeedMode(enabled) {
    const toggle = document.getElementById('speed-mode-toggle');
    const text   = document.getElementById('speed-mode-text');
    if (!toggle) return;
    toggle.checked = enabled;
    text.textContent = enabled ? 'Speed Mode: ON — delays disabled' : 'Speed Mode: OFF — human timing active';
    text.style.color = enabled ? 'var(--warning)' : 'var(--text-1)';
  }

  async function toggleSpeedMode(enabled) {
    try {
      const s = await API.post('/api/settings', { speed_mode: enabled });
      _applySpeedMode(s.speed_mode);
      Toast.show(`Speed mode ${s.speed_mode ? 'enabled' : 'disabled'}`, s.speed_mode ? 'warning' : 'success');
    } catch (err) {
      Toast.error(err.message);
    }
  }

  return { render, toggleSpeedMode };
})();
