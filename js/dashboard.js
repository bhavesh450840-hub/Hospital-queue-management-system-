/* Staff dashboard: queue management, priority changes and patient search. */
(function () {
  'use strict';

  var welcome = document.getElementById('welcome');
  var departmentSelect = document.getElementById('staffDepartment');
  var callNextBtn = document.getElementById('callNextBtn');
  var logoutBtn = document.getElementById('logoutBtn');
  var staffWaiting = document.getElementById('staffWaiting');
  var staffServing = document.getElementById('staffServing');
  var staffCompleted = document.getElementById('staffCompleted');
  var staffQueue = document.getElementById('staffQueue');
  var patientSearch = document.getElementById('patientSearch');
  var patientResults = document.getElementById('patientResults');

  var PRIORITY_LABEL = { normal: 'Normal', urgent: 'Urgent', emergency: 'Emergency' };
  var STATUS_LABEL = { waiting: 'Waiting', serving: 'Serving', completed: 'Completed', cancelled: 'Cancelled' };
  var user = null;

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function request(path, options) {
    var config = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
    return fetch(path, config).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.status === 401) {
          window.location.replace('/login.html');
          throw new Error('Your session expired. Please sign in again.');
        }
        if (!res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
        }
        return data;
      });
    });
  }

  function setQueueMessage(text, kind) {
    var el = document.getElementById('queueMessage');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'message' + (kind ? ' ' + kind : '');
  }

  function renderQueue(data) {
    staffWaiting.textContent = data.stats.waiting;
    staffServing.textContent = data.stats.serving;
    staffCompleted.textContent = data.stats.completed;

    var rows = [];

    if (data.serving) {
      rows.push(renderRow(data.serving, true));
    }
    data.waiting.forEach(function (token) {
      rows.push(renderRow(token, false));
    });

    staffQueue.innerHTML = rows.length
      ? rows.join('')
      : '<p class="empty">This department queue is empty.</p>';

    bindRowActions();
  }

  function renderRow(token, isServing) {
    var patient = token.patient || {};
    var priorityOptions = Object.keys(PRIORITY_LABEL)
      .map(function (value) {
        return '<option value="' + value + '"' + (token.priority === value ? ' selected' : '') + '>' +
          PRIORITY_LABEL[value] + '</option>';
      })
      .join('');

    var actions = isServing
      ? '<button class="btn small primary" data-action="complete" data-id="' + esc(token.id) + '">Complete</button>' +
        '<button class="btn small danger" data-action="cancel" data-id="' + esc(token.id) + '">Cancel</button>'
      : '<select class="priority-select" data-role="priority" data-id="' + esc(token.id) + '" aria-label="Priority">' +
          priorityOptions + '</select>' +
        '<button class="btn small secondary" data-action="serve" data-id="' + esc(token.id) + '">Call</button>' +
        '<button class="btn small danger" data-action="cancel" data-id="' + esc(token.id) + '">Cancel</button>';

    return (
      '<div class="queue-item">' +
        '<div class="queue-main">' +
          '<strong>' + esc(token.tokenNumber) + ' · ' + esc(patient.fullName || 'Patient') + '</strong>' +
          '<small>' +
            (patient.age !== undefined ? esc(patient.age) + 'y · ' + esc(patient.gender || '') + ' · ' : '') +
            esc(patient.phone || '') +
            (token.visitReason ? ' · ' + esc(token.visitReason) : '') +
          '</small>' +
        '</div>' +
        '<div class="queue-meta">' +
          '<span class="pill ' + esc(token.priority) + '">' + esc(PRIORITY_LABEL[token.priority] || token.priority) + '</span>' +
          '<span class="pill status-' + esc(token.status) + '">' + esc(STATUS_LABEL[token.status] || token.status) + '</span>' +
        '</div>' +
        '<div class="row-actions">' + actions + '</div>' +
      '</div>'
    );
  }

  function bindRowActions() {
    staffQueue.querySelectorAll('button[data-action]').forEach(function (button) {
      button.addEventListener('click', function () {
        var id = button.getAttribute('data-id');
        var action = button.getAttribute('data-action');
        button.disabled = true;
        var status = action === 'complete' ? 'completed' : action === 'cancel' ? 'cancelled' : 'serving';
        request('/api/queue/' + encodeURIComponent(id) + '/status', {
          method: 'PATCH',
          body: JSON.stringify({ status: status })
        })
          .then(function () {
            setQueueMessage('Token updated.', 'success');
            return loadQueue();
          })
          .catch(function (err) {
            button.disabled = false;
            setQueueMessage(err.message, 'error');
          });
      });
    });

    staffQueue.querySelectorAll('select[data-role="priority"]').forEach(function (select) {
      select.addEventListener('change', function () {
        request('/api/queue/' + encodeURIComponent(select.getAttribute('data-id')) + '/priority', {
          method: 'PATCH',
          body: JSON.stringify({ priority: select.value })
        })
          .then(function () {
            setQueueMessage('Priority updated.', 'success');
            return loadQueue();
          })
          .catch(function (err) {
            setQueueMessage(err.message, 'error');
          });
      });
    });
  }

  function loadQueue() {
    return request('/api/queue/detail?department=' + encodeURIComponent(departmentSelect.value))
      .then(renderQueue)
      .catch(function (err) {
        staffQueue.innerHTML = '<p class="empty">' + esc(err.message) + '</p>';
      });
  }

  function searchPatients() {
    var term = patientSearch.value.trim();
    if (term.length < 2) {
      patientResults.innerHTML = '<p class="empty">Type at least 2 characters.</p>';
      return;
    }
    request('/api/patients?q=' + encodeURIComponent(term))
      .then(function (data) {
        if (!data.patients.length) {
          patientResults.innerHTML = '<p class="empty">No matching patients.</p>';
          return;
        }
        patientResults.innerHTML = data.patients
          .map(function (patient) {
            var token = patient.lastToken;
            return (
              '<div class="queue-item">' +
                '<div class="queue-main"><strong>' + esc(patient.fullName) + '</strong>' +
                  '<small>' + esc(patient.age) + 'y · ' + esc(patient.gender) + ' · ' + esc(patient.phone) + '</small></div>' +
                '<div class="queue-meta">' +
                  (token
                    ? '<span class="pill">' + esc(token.tokenNumber) + '</span>' +
                      '<span class="pill status-' + esc(token.status) + '">' + esc(STATUS_LABEL[token.status] || token.status) + '</span>'
                    : '<span class="pill">No visits</span>') +
                '</div>' +
              '</div>'
            );
          })
          .join('');
      })
      .catch(function (err) {
        patientResults.innerHTML = '<p class="empty">' + esc(err.message) + '</p>';
      });
  }

  var searchTimer = null;
  patientSearch.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchPatients, 300);
  });

  callNextBtn.addEventListener('click', function () {
    callNextBtn.disabled = true;
    request('/api/queue/next', {
      method: 'POST',
      body: JSON.stringify({ department: departmentSelect.value })
    })
      .then(function (data) {
        setQueueMessage('Now serving ' + data.called.tokenNumber + '.', 'success');
        return loadQueue();
      })
      .catch(function (err) {
        setQueueMessage(err.message, 'error');
      })
      .then(function () {
        callNextBtn.disabled = false;
      });
  });

  departmentSelect.addEventListener('change', loadQueue);

  logoutBtn.addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).finally(function () {
      window.location.replace('/login.html');
    });
  });

  request('/api/auth/me')
    .then(function (data) {
      user = data.user;
      welcome.textContent = 'Signed in as ' + (user.displayName || user.username) + '.';
      loadQueue();
      if (typeof io === 'function') {
        var socket = io();
        socket.on('queue:updated', function (payload) {
          if (!payload || !payload.department || payload.department === departmentSelect.value) loadQueue();
        });
      }
      setInterval(loadQueue, 20000);
    })
    .catch(function (err) {
      if (!/session expired/i.test(err.message)) welcome.textContent = err.message;
    });
})();
