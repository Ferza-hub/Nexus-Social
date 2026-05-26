// Fetch wrapper — auto-attaches auth token, handles errors

const API = (() => {
  let _token = localStorage.getItem('nx_token') || '';

  function setToken(t) {
    _token = t;
    localStorage.setItem('nx_token', t);
  }

  function clearToken() {
    _token = '';
    localStorage.removeItem('nx_token');
  }

  async function request(method, path, body) {
    const opts = {
      method,
      headers: {
        'Content-Type':  'application/json',
        'X-Auth-Token':  _token,
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(path, opts);

    if (res.status === 401) {
      clearToken();
      window.location.reload();
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  return {
    hasToken: () => !!_token,
    setToken,
    clearToken,
    get:    (path)       => request('GET',    path),
    post:   (path, body) => request('POST',   path, body),
    patch:  (path, body) => request('PATCH',  path, body),
    delete: (path)       => request('DELETE', path),
    login:  async (pw)   => {
      const data = await request('POST', '/api/auth/login', { password: pw });
      setToken(data.token);
      return data;
    },
    changePassword: (currentPassword, newPassword) =>
      request('POST', '/api/auth/change-password', { currentPassword, newPassword }),
  };
})();
