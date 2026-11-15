(function () {
  'use strict';
  var checking = false;
  function reveal() {
    var button = document.getElementById('regionCommandBtn');
    if (!button || checking || !window.AuthManager || !AuthManager.isLoggedIn()) return;
    checking = true;
    AuthManager.apiRequest('/api/region-command/context').then(function (response) {
      if (!response.ok) return null;
      return response.json();
    }).then(function (data) {
      if (data && data.success) {
        button.hidden = false;
        button.addEventListener('click', function () { navigateToPage('region-command.html'); });
      }
    }).catch(function () { /* الميزة غير المفعلة أو غير المخولة تبقى مخفية */ })
      .finally(function () { checking = false; });
  }
  function init() {
    reveal();
    if (window.AuthManager && AuthManager.onAuthEvent) {
      AuthManager.onAuthEvent(function (event) {
        if (event.type === 'login') reveal();
        if (event.type === 'logout' || event.type === 'session_expired') {
          var button = document.getElementById('regionCommandBtn');
          if (button) button.hidden = true;
        }
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
