// Main app router + auth

const PAGES = {
  accounts:  AccountsPage,
  campaigns: CampaignsPage,
  scheduler: SchedulerPage,
  proxies:   ProxiesPage,
  analytics: AnalyticsPage,
  logs:      LogsPage,
};

let _currentPage = null;

function navigate(page) {
  if (!PAGES[page]) page = 'analytics';

  // Destroy current page if it has a cleanup method
  if (_currentPage && PAGES[_currentPage]?.destroy) {
    PAGES[_currentPage].destroy();
  }
  _currentPage = page;

  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  PAGES[page].render();
  location.hash = page;
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Route from hash or default
  const page = location.hash.replace('#', '') || 'analytics';
  navigate(page);
}

function showLogin() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-password')?.focus();
}

// Nav click handlers
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(el.dataset.page);
  });
});

// Login form
document.getElementById('login-btn').addEventListener('click', async () => {
  const pw = document.getElementById('login-password').value;
  const err = document.getElementById('login-error');
  err.classList.add('hidden');

  try {
    await API.login(pw);
    showApp();
  } catch (_) {
    err.classList.remove('hidden');
  }
});

document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  API.clearToken();
  showLogin();
});

// Hashchange for back/forward
window.addEventListener('hashchange', () => {
  const page = location.hash.replace('#', '');
  if (PAGES[page]) navigate(page);
});

// Init
if (API.hasToken()) {
  showApp();
} else {
  showLogin();
}
