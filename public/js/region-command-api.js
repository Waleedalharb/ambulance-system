(function (global) {
  'use strict';
  var BASE = '/api/region-command';
  function RegionCommandApiError(message, status, code) {
    this.name = 'RegionCommandApiError';
    this.message = message;
    this.status = status || 0;
    this.code = code || 'REQUEST_FAILED';
  }
  RegionCommandApiError.prototype = Object.create(Error.prototype);

  function query(params) {
    var search = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    });
    var text = search.toString();
    return text ? '?' + text : '';
  }

  async function request(path, options) {
    options = options || {};
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, options.timeout || 15000);
    var external = options.signal;
    var abort = function () { controller.abort(); };
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', abort, { once: true });
    }
    try {
      var response = await AuthCore.apiRequest(BASE + path, { signal: controller.signal, headers: { Accept: 'application/json' } });
      var data = null;
      try { data = await response.json(); } catch (_) { data = null; }
      if (!response.ok) {
        throw new RegionCommandApiError(data && data.error || 'تعذر إكمال الطلب', response.status, data && data.code);
      }
      if (!data || data.success !== true) throw new RegionCommandApiError('استجابة الخادم غير مكتملة', response.status, 'INVALID_RESPONSE');
      return data;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new RegionCommandApiError(timedOut ? 'انتهت مهلة الطلب' : 'أُلغي الطلب', 0, timedOut ? 'TIMEOUT' : 'ABORTED');
      }
      if (error instanceof RegionCommandApiError) throw error;
      throw new RegionCommandApiError('تعذر الاتصال بالخادم', 0, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', abort);
    }
  }

  global.RegionCommandAPI = {
    Error: RegionCommandApiError,
    request: request,
    context: function (options) { return request('/context', options); },
    overview: function (regionId, options) { return request('/overview' + query({ regionId: regionId, view: 'current' }), options); },
    sector: function (sectorId, options) { return request('/sectors/' + encodeURIComponent(sectorId) + query({ view: 'current' }), options); },
    sectorMap: function (sectorId, options) { return request('/sectors/' + encodeURIComponent(sectorId) + '/map' + query({ view: 'current' }), options); },
    decisions: function (filters, options) { return request('/decision-center' + query(filters), options); },
    decisionEvidence: function (itemId, options) { return request('/decision-center/' + encodeURIComponent(itemId) + '/evidence', options); },
    metricEvidence: function (sectorId, metricKey, options) {
      return request('/metrics/' + encodeURIComponent(metricKey) + '/evidence' + query({ sectorId: sectorId, metricVersion: '1.0.0', view: 'current' }), options);
    },
    ledger: function (sectorId, filters, options) { return request('/sectors/' + encodeURIComponent(sectorId) + '/ledger' + query(filters), options); },
    ledgerEntry: function (sectorId, entryId, options) { return request('/sectors/' + encodeURIComponent(sectorId) + '/ledger/' + encodeURIComponent(entryId), options); }
  };
})(window);
