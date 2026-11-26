/* Public waiting-area display: shows token numbers only, updated in real time. */
(function () {
  'use strict';

  var departmentSelect = document.getElementById('displayDepartment');
  var nowServing = document.getElementById('nowServing');
  var displayQueue = document.getElementById('displayQueue');

  var PRIORITY_LABEL = { normal: 'Normal', urgent: 'Urgent', emergency: 'Emergency' };

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function render(data) {
    var serving = data.serving;
    nowServing.innerHTML =
      '<span>NOW SERVING · ' + esc(data.department.toUpperCase()) + '</span>' +
      '<strong>' + (serving ? esc(serving.tokenNumber) : '---') + '</strong>' +
      '<p>' + (serving ? 'Token called' : 'No active token') + '</p>';

    if (!data.waiting.length) {
      displayQueue.innerHTML = '<p class="empty">No tokens waiting in this department.</p>';
      return;
    }

    displayQueue.innerHTML = data.waiting
      .slice(0, 12)
      .map(function (token, index) {
        return (
          '<div class="queue-item">' +
            '<div><strong>' + esc(token.tokenNumber) + '</strong>' +
              '<small>Up next #' + (index + 1) + '</small></div>' +
            '<span class="pill ' + esc(token.priority) + '">' + esc(PRIORITY_LABEL[token.priority] || token.priority) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function loadQueue() {
    var department = departmentSelect.value;
    return fetch('/api/queue?department=' + encodeURIComponent(department), { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok) render(data);
      })
      .catch(function () {
        displayQueue.innerHTML = '<p class="empty">Reconnecting to the queue…</p>';
      });
  }

  departmentSelect.addEventListener('change', loadQueue);

  if (typeof io === 'function') {
    var socket = io();
    socket.on('queue:updated', function (payload) {
      if (!payload || !payload.department || payload.department === departmentSelect.value) loadQueue();
    });
    socket.on('connect', loadQueue);
  }
  setInterval(loadQueue, 15000);

  loadQueue();
})();
