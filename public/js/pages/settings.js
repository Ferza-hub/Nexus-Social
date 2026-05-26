// Settings page — change panel password

const SettingsPage = (() => {

  function render() {
    document.getElementById('page-container').innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Settings</h1>
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

    document.getElementById('change-pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current  = document.getElementById('cp-current').value;
      const newPw    = document.getElementById('cp-new').value;
      const confirm  = document.getElementById('cp-confirm').value;
      const errEl    = document.getElementById('cp-error');
      const btn      = document.getElementById('cp-btn');

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

  return { render };
})();
