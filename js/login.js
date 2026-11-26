/* Staff sign-in page. */
(function () {
  'use strict';

  var form = document.getElementById('loginForm');
  var message = document.getElementById('loginMessage');

  function setMessage(text, kind) {
    message.textContent = text || '';
    message.className = 'message' + (kind ? ' ' + kind : '');
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
        }
        return data;
      });
    });
  }

  var hint = document.getElementById('loginHint');

  // Sign-in help: shows which account exists on this deployment (never a hash).
  fetch('/api/auth/setup', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!hint || !data || !data.ok) return;
      if (data.demoMode && data.demoUsername) {
        hint.textContent =
          'Demo mode — sign in as "' + data.demoUsername + '" with password "' + (data.demoPassword || '') +
          '". Set ADMIN_USERNAME and ADMIN_PASSWORD for a real deployment.';
      } else if (data.primaryUsername) {
        hint.textContent = 'Use the staff account configured by your administrator: "' + data.primaryUsername + '".';
      } else {
        hint.textContent = 'No staff account exists yet. Set ADMIN_USERNAME and ADMIN_PASSWORD, then restart the server.';
      }
      hint.hidden = false;
    })
    .catch(function () { /* ignore */ });

  // Already signed in? Go straight to the dashboard.
  fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.ok) window.location.replace('/dashboard.html');
    })
    .catch(function () { /* ignore */ });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = new FormData(form);
    setMessage('Signing in…', '');
    post('/api/auth/login', {
      username: String(data.get('username') || ''),
      password: String(data.get('password') || '')
    })
      .then(function () {
        window.location.href = '/dashboard.html';
      })
      .catch(function (err) {
        setMessage(err.message, 'error');
      });
  });
})();
