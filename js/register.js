/* Patient registration page: creates a real token through the API and shows the live queue. */
(function () {
  'use strict';

  var form = document.getElementById('registrationForm');
  var message = document.getElementById('formMessage');
  var tokenCard = document.getElementById('tokenCard');
  var tokenNumberEl = document.getElementById('tokenNumber');
  var tokenInfoEl = document.getElementById('tokenInfo');
  var printBtn = document.getElementById('printTokenBtn');
  var departmentFilter = document.getElementById('departmentFilter');
  var publicQueue = document.getElementById('publicQueue');
  var waitingCount = document.getElementById('waitingCount');
  var servingCount = document.getElementById('servingCount');

  var PRIORITY_LABEL = { normal: 'Normal', urgent: 'Urgent', emergency: 'Emergency' };

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function setMessage(text, kind) {
    message.textContent = text || '';
    message.className = 'message' + (kind ? ' ' + kind : '');
  }

  function request(path, options) {
    var config = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
    return fetch(path, config)
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data || data.ok === false) {
            var error = new Error((data && data.error) || 'Request failed (' + res.status + ')');
            error.status = res.status;
            throw error;
          }
          return data;
        });
      });
  }

  function renderQueue(data) {
    waitingCount.textContent = data.stats.waiting;
    servingCount.textContent = data.stats.serving;

    if (!data.waiting.length) {
      publicQueue.innerHTML = '<p class="empty">No patients waiting right now.</p>';
      return;
    }

    publicQueue.innerHTML = data.waiting
      .map(function (token, index) {
        return (
          '<div class="queue-item">' +
            '<div><strong>' + esc(token.tokenNumber) + '</strong>' +
              '<small>Position ' + (index + 1) +
              (token.waitingMinutes ? ' · waiting ' + esc(token.waitingMinutes) + ' min' : '') +
              '</small></div>' +
            '<span class="pill ' + esc(token.priority) + '">' + esc(PRIORITY_LABEL[token.priority] || token.priority) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function loadQueue() {
    var department = departmentFilter.value;
    return request('/api/queue?department=' + encodeURIComponent(department))
      .then(renderQueue)
      .catch(function (err) {
        publicQueue.innerHTML = '<p class="empty">Could not load the queue. ' + esc(err.message) + '</p>';
      });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var data = new FormData(form);
    var payload = {
      fullName: String(data.get('fullName') || ''),
      age: Number(data.get('age')),
      gender: String(data.get('gender') || ''),
      phone: String(data.get('phone') || ''),
      department: String(data.get('department') || ''),
      visitReason: String(data.get('visitReason') || '')
    };

    setMessage('Registering…', '');
    request('/api/patients', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (result) {
        tokenNumberEl.textContent = result.token.tokenNumber;
        tokenInfoEl.textContent =
          result.token.department + ' · ' + (PRIORITY_LABEL[result.token.priority] || result.token.priority) +
          ' priority · ' + result.patient.fullName;
        tokenCard.classList.remove('hidden');
        setMessage('Registration successful. Keep this token and watch the live display.', 'success');
        departmentFilter.value = result.token.department;
        form.reset();
        return loadQueue();
      })
      .catch(function (err) {
        setMessage(err.message, 'error');
      });
  });

  if (printBtn) {
    printBtn.addEventListener('click', function () {
      window.print();
    });
  }

  departmentFilter.addEventListener('change', loadQueue);

  if (typeof io === 'function') {
    var socket = io();
    socket.on('queue:updated', function (payload) {
      if (!payload || !payload.department || payload.department === departmentFilter.value) loadQueue();
    });
    socket.on('connect', loadQueue);
  }
  setInterval(loadQueue, 20000);

  loadQueue();
})();
