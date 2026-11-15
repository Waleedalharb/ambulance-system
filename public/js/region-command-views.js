(function (global) {
  'use strict';
  var STATUS = {
    ok: 'متاح', complete: 'مكتمل', stale: 'بيانات قديمة', partial: 'تغطية غير مكتملة',
    unavailable: 'غير متاح', unresolved: 'غير محسوم', not_applicable: 'لا ينطبق',
    ready: 'جاهزة', missing: 'ناقصة', offline: 'خارج الخدمة', pending: 'بانتظار التكميل',
    active: 'نشط', closed: 'مغلق', cancelled: 'ملغى', breakdown: 'عطل', out_of_service: 'خارج الخدمة',
    needs_review: 'تحتاج مراجعة', viewed: 'اطلاع', hierarchy_changed: 'تغيير الهيكل', scope_changed: 'تغيير النطاق'
  };
  var REASONS = {
    SOURCE_UNAVAILABLE: 'المصدر غير متاح', NO_ACTIVE_SHIFT: 'لا توجد مناوبة نشطة',
    REGION_COVERAGE_INCOMPLETE: 'التغطية الإقليمية غير مكتملة', COVERAGE_INCOMPLETE: 'التغطية غير مكتملة',
    RESPONSE_TIME_COVERAGE_INCOMPLETE: 'أزمنة الوصول غير مكتملة', NO_INCIDENTS: 'لا توجد بلاغات',
    NO_REQUIRED_TEAMS: 'لا توجد فرق مطلوبة', TEAM_SCOPE_SOURCE_UNAVAILABLE: 'تعذر حسم فرق القطاع',
    CENTER_GEO_SOURCE_UNAVAILABLE: 'مرجع إحداثيات المراكز غير متاح', CENTER_COORDINATES_UNAVAILABLE: 'إحداثيات المركز غير متاحة',
    NON_GEOGRAPHIC_CENTER: 'مركز غير جغرافي', TEAM_MISSING: 'فرقة ناقصة', TEAM_OFFLINE: 'فرقة خارج الخدمة', TEAM_PENDING: 'بانتظار قرار التكميل',
    SOURCE_STALE: 'بيانات المصدر قديمة', VEHICLE_BREAKDOWN: 'مركبة بحالة عطل',
    VEHICLE_OUT_OF_SERVICE: 'مركبة خارج الخدمة', VEHICLE_CENTER_UNRESOLVED: 'تعذر حسم مركز المركبة'
  };
  var LABELS = {
    teamsReady: 'الفرق الجاهزة', teamsTotal: 'إجمالي الفرق', staffActive: 'الكادر الحاضر',
    staffRequired: 'الكادر المطلوب', readinessRate: 'جاهزية الفرق', vehiclesActive: 'المركبات العاملة',
    vehiclesTotal: 'إجمالي المركبات', incidentsActive: 'البلاغات النشطة', incidentsTotal: 'إجمالي البلاغات',
    avgResponseMinutes: 'متوسط زمن الوصول', decisionCount: 'تحتاج مراجعة', centerCount: 'المراكز', sectorCount: 'القطاعات',
    teamsMissing: 'فرق ناقصة', teamsOffline: 'فرق خارج الخدمة', teamsPending: 'بانتظار التكميل'
  };
  var UNITS = { avgResponseMinutes: 'د', readinessRate: '٪' };
  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  function clear(element) { if (element) element.replaceChildren(); return element; }
  function statusLabel(status) { return STATUS[status] || status || 'غير معروف'; }
  function reasonLabel(reason) { return REASONS[reason] || reason || ''; }
  function statusBadge(status, label) {
    var badge = node('span', 'rc-status', label || statusLabel(status));
    badge.dataset.state = status || 'unknown';
    return badge;
  }
  function formatDate(value, includeDate) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ar-SA', {
      timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: includeDate ? undefined : '2-digit',
      year: includeDate ? 'numeric' : undefined, month: includeDate ? 'short' : undefined, day: includeDate ? 'numeric' : undefined
    }).format(date);
  }
  function metricText(metric, key) {
    if (!metric || metric.value === null || metric.value === undefined) return '—';
    return String(metric.value) + (UNITS[key] ? ' ' + UNITS[key] : '');
  }
  function metricCard(key, metric, options) {
    options = options || {};
    var card = node(options.onEvidence ? 'button' : 'article', 'rc-metric-card');
    if (options.onEvidence) card.type = 'button';
    card.dataset.state = metric && metric.status || 'unavailable';
    card.dataset.metric = key;
    var label = node('span', 'rc-metric-label', options.label || LABELS[key] || key);
    if (options.onEvidence) label.appendChild(node('span', 'rc-metric-evidence', 'الدليل ↗'));
    card.appendChild(label);
    card.appendChild(node('strong', 'rc-metric-value', metricText(metric, key)));
    var state = node('span', 'rc-metric-state', statusLabel(metric && metric.status));
    state.dataset.state = metric && metric.status || 'unavailable';
    card.appendChild(state);
    var meta = reasonLabel(metric && metric.reasonCode) || options.note || (metric && metric.sourceAt ? 'المصدر: ' + formatDate(metric.sourceAt) : 'المصدر والتغطية موضحان في الدليل');
    card.appendChild(node('small', 'rc-metric-meta', meta));
    if (options.onEvidence) {
      card.setAttribute('aria-label', (options.label || LABELS[key] || key) + ' — عرض الدليل');
      card.addEventListener('click', function () { options.onEvidence(key, metric); });
    }
    return card;
  }
  function metricGrid(container, metrics, keys, options) {
    clear(container);
    container.setAttribute('aria-busy', 'false');
    keys.forEach(function (key) {
      var config = Object.assign({}, options || {});
      if (options && options.labels && options.labels[key]) config.label = options.labels[key];
      if (options && options.notes && options.notes[key]) config.note = options.notes[key];
      if (config.onEvidence) config.onEvidence = function (k, m) { options.onEvidence(k, m); };
      container.appendChild(metricCard(key, metrics && metrics[key], config));
    });
  }
  function skeleton(container, count) {
    clear(container);
    container.setAttribute('aria-busy', 'true');
    var wrap = node('div', 'rc-loading-grid');
    for (var i = 0; i < (count || 3); i += 1) wrap.appendChild(node('div', 'rc-skeleton'));
    container.appendChild(wrap);
  }
  function empty(container, message) {
    clear(container);
    container.setAttribute('aria-busy', 'false');
    container.appendChild(node('div', 'rc-empty', message || 'لا توجد بيانات متاحة ضمن النطاق الحالي.'));
  }
  function showError(container, error, fallback) {
    if (!container) return;
    clear(container);
    var message = error && error.status === 403 ? 'هذا النطاق غير مصرح لك بعرضه.'
      : error && error.status === 401 ? 'انتهت الجلسة؛ عد إلى المنصة الرئيسية لتسجيل الدخول.'
        : error && error.message || fallback || 'تعذر تحميل البيانات.';
    container.appendChild(node('span', '', message));
    container.hidden = false;
  }
  function table(container, columns, rows, emptyMessage) {
    clear(container);
    if (!rows || !rows.length) return empty(container, emptyMessage);
    var tableElement = node('table', 'rc-table');
    var thead = node('thead');
    var headRow = node('tr');
    columns.forEach(function (column) { headRow.appendChild(node('th', '', column.label)); });
    thead.appendChild(headRow);
    tableElement.appendChild(thead);
    var tbody = node('tbody');
    rows.forEach(function (row) {
      var tr = node('tr');
      columns.forEach(function (column) {
        var td = node('td');
        var value = column.render ? column.render(row) : row[column.key];
        if (value instanceof Node) td.appendChild(value);
        else td.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tableElement.appendChild(tbody);
    container.appendChild(tableElement);
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('regionCommandTheme'); } catch (_) { /* تفضيل عرض فقط */ }
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
    Array.prototype.forEach.call(document.querySelectorAll('[data-action="theme"]'), function (button) {
      button.addEventListener('click', function () {
        var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('regionCommandTheme', next); } catch (_) { /* لا أثر تشغيلي */ }
        document.dispatchEvent(new CustomEvent('region-theme-change', { detail: { theme: next } }));
      });
    });
  }
  function teamIdentity(team) {
    var wrap = node('div', 'rc-team-identity');
    if (team && team.operationalCode) {
      var code = node('strong', 'rc-operational-code', team.operationalCode);
      code.dir = 'ltr';
      wrap.appendChild(code);
      wrap.appendChild(node('small', '', (team.name || '') + ' · ' + (team.sectorName || '') +
        (team.teamNumber ? ' · فرقة ' + team.teamNumber : '') + (team.shiftType ? ' · ' + team.shiftType : '')));
    } else {
      wrap.appendChild(node('strong', '', team && (team.displayLabel || team.name) || '—'));
      if (team && team.shiftType) wrap.appendChild(node('small', '', 'المناوبة: ' + team.shiftType));
    }
    return wrap;
  }
  function teamList(identities, fallbackNames) {
    var wrap = node('div', 'rc-team-identity-list');
    var rows = identities && identities.length ? identities : (fallbackNames || []).map(function (name) { return { name: name, displayLabel: name }; });
    rows.forEach(function (team) { wrap.appendChild(teamIdentity(team)); });
    if (!rows.length) wrap.appendChild(node('span', '', '—'));
    return wrap;
  }
  global.RegionCommandViews = {
    node: node, clear: clear, statusLabel: statusLabel, reasonLabel: reasonLabel, statusBadge: statusBadge,
    formatDate: formatDate, metricText: metricText, metricCard: metricCard, metricGrid: metricGrid,
    skeleton: skeleton, empty: empty, showError: showError, table: table, labels: LABELS, initTheme: initTheme,
    teamIdentity: teamIdentity, teamList: teamList
  };
})(window);
