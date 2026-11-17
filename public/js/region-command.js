(function () {
  'use strict';
  var API, V;
  var REGION_KEYS = ['readinessRate', 'staffActive', 'vehiclesActive', 'incidentsActive', 'avgResponseMinutes', 'teamsPending'];
  var DETAIL_KEYS = ['readinessRate', 'staffActive', 'vehiclesActive', 'incidentsActive', 'avgResponseMinutes', 'avgMubasharaMinutes'];
  var COLORS = ['#20DFBD', '#62A8EE', '#A88BEC', '#548DD5', '#E4BB57'];
  var COMPARISON_METRICS = [
    ['readinessRate', 'الجاهزية'], ['staffActive', 'الكادر'], ['teamsReady', 'الفرق'],
    ['vehiclesActive', 'المركبات'], ['incidentsActive', 'البلاغات']
  ];
  var CATEGORY_LABELS = { staffing: 'القوى', vehicles: 'المركبات', data_quality: 'جودة البيانات' };
  var CATEGORY_TABS = { staffing: 'teams', vehicles: 'vehicles', data_quality: 'teams' };
  var state = {
    context: null, overview: null, selectedId: null, homeSelectedId: null, detail: null,
    comparisonMetric: 'readinessRate', overviewVersion: 0, detailVersion: 0, decisionVersion: 0, ledgerVersion: 0,
    decisionItems: [], decisionNext: null, ledgerEntries: [], ledgerNext: null,
    activeTab: 'teams', realtime: null
  };
  function id(name) { return document.getElementById(name); }
  function sectorName(sectorId) {
    var sector = state.overview && state.overview.sectors.find(function (item) { return item.id === sectorId; });
    return sector ? sector.name : 'القطاع المخول';
  }
  function announce(message) { id('liveAnnouncer').textContent = message; }
  function updateConnection(status) {
    var element = id('connectionStatus');
    var labels = { connected: 'متصل لحظيًا', connecting: 'جارٍ الاتصال', reconnecting: 'جارٍ استعادة الاتصال', disconnected: 'الاتصال متوقف', forbidden: 'التحديث اللحظي متوقف' };
    element.dataset.state = status;
    element.replaceChildren(V.node('span'), document.createTextNode(labels[status] || labels.connecting));
  }
  function pair(metrics, first, second) {
    return V.metricText(metrics && metrics[first]) + ' / ' + V.metricText(metrics && metrics[second]);
  }
  function timeCoverage(metric) {
    var coverage = metric && metric.coverage;
    if (!coverage || typeof coverage.available !== 'number' || typeof coverage.expected !== 'number') return 'التغطية غير متاحة';
    return 'تغطية الأزمنة: ' + coverage.available + ' / ' + coverage.expected + ' بلاغ';
  }
  function metricNotes(metrics, detail) {
    return {
      readinessRate: pair(metrics, 'teamsReady', 'teamsTotal') + ' فرق جاهزة · المشغولة: ' + V.metricText(metrics && metrics.teamsBusy),
      staffActive: 'المطلوب: ' + V.metricText(metrics && metrics.staffRequired),
      vehiclesActive: 'الإجمالي: ' + V.metricText(metrics && metrics.vehiclesTotal),
      incidentsActive: 'إجمالي CAD: ' + V.metricText(metrics && metrics.incidentsTotal),
      avgResponseMinutes: timeCoverage(metrics && metrics.avgResponseMinutes) + (detail ? '' : ' · متوسط موزون'),
      avgMubasharaMinutes: timeCoverage(metrics && metrics.avgMubasharaMinutes) + (detail ? '' : ' · متوسط موزون'),
      teamsPending: 'حالة pending في قراءة التكميل'
    };
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgNode(name, attributes, text) {
    var element = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach(function (key) { element.setAttribute(key, attributes[key]); });
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function trendPanel(title, unit, series, points) {
    var panel = V.node('article', 'rc-trend-series');
    var head = V.node('div', 'rc-trend-series-head');
    head.appendChild(V.node('h4', '', title));
    var legend = V.node('div', 'rc-trend-legend');
    series.forEach(function (item) {
      var key = V.node('span');
      var mark = V.node('i');
      mark.style.setProperty('--trend-color', item.color);
      key.appendChild(mark);
      key.appendChild(document.createTextNode(item.label));
      legend.appendChild(key);
    });
    head.appendChild(legend);
    panel.appendChild(head);
    var width = 680, height = 220, left = 46, right = 18, top = 16, bottom = 42;
    var plotWidth = width - left - right, plotHeight = height - top - bottom;
    var values = [];
    points.forEach(function (point) {
      series.forEach(function (item) {
        var metric = point[item.key];
        if (metric && typeof metric.value === 'number') values.push(metric.value);
      });
    });
    if (!values.length) {
      panel.appendChild(V.node('div', 'rc-trend-empty', 'لا توجد قيم مكتملة لهذا المؤشر ضمن الأيام السبعة.'));
      return panel;
    }
    var maximum = Math.max.apply(Math, values);
    var axisMaximum = maximum <= 0 ? 1 : maximum;
    var magnitude = Math.pow(10, Math.floor(Math.log(axisMaximum) / Math.LN10));
    axisMaximum = Math.ceil(axisMaximum / magnitude * 2) * magnitude / 2;
    var svg = svgNode('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': title + ' خلال سبعة أيام؛ القيم غير المتاحة تظهر كفجوات' });
    for (var tick = 0; tick <= 4; tick += 1) {
      var tickValue = axisMaximum * (4 - tick) / 4;
      var y = top + plotHeight * tick / 4;
      svg.appendChild(svgNode('line', { x1: left, x2: width - right, y1: y, y2: y, 'class': 'rc-trend-grid-line' }));
      svg.appendChild(svgNode('text', { x: left - 9, y: y + 4, 'text-anchor': 'end', 'class': 'rc-trend-axis-label' }, Math.round(tickValue * 10) / 10));
    }
    function xAt(index) { return left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1)); }
    function yAt(value) { return top + plotHeight - value / axisMaximum * plotHeight; }
    series.forEach(function (item) {
      var segment = [];
      function drawSegment() {
        if (segment.length > 1) svg.appendChild(svgNode('path', { d: segment.map(function (point, index) { return (index ? 'L' : 'M') + point[0] + ' ' + point[1]; }).join(' '), fill: 'none', stroke: item.color, 'class': 'rc-trend-line' }));
        segment = [];
      }
      points.forEach(function (point, index) {
        var metric = point[item.key];
        if (!metric || typeof metric.value !== 'number') { drawSegment(); return; }
        var x = xAt(index), y = yAt(metric.value);
        segment.push([x, y]);
        var circle = svgNode('circle', { cx: x, cy: y, r: 4, fill: item.color, 'class': 'rc-trend-point' });
        circle.appendChild(svgNode('title', {}, point.date + ' · ' + item.label + ': ' + metric.value + ' ' + unit + ' · تغطية ' + (metric.coverage.available === null ? '—' : metric.coverage.available + '/' + metric.coverage.expected)));
        svg.appendChild(circle);
      });
      drawSegment();
    });
    points.forEach(function (point, index) {
      var date = new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(point.date + 'T00:00:00Z'));
      svg.appendChild(svgNode('text', { x: xAt(index), y: height - 14, 'text-anchor': 'middle', 'class': 'rc-trend-day-label' }, date));
    });
    panel.appendChild(svg);
    panel.appendChild(V.node('small', 'rc-trend-unit', 'الوحدة: ' + unit + ' · الفراغ يعني عدم توفر قياس، وليس صفرًا.'));
    return panel;
  }
  function renderTrends() {
    var trends = state.overview.totals.trends;
    var container = V.clear(id('trendChart'));
    var note = id('trendNote');
    if (!trends || !Array.isArray(trends.points) || !trends.points.length) {
      V.empty(container, 'السلسلة التاريخية غير متاحة من المصدر حاليًا.');
      note.textContent = trends && trends.reasonCode ? V.reasonLabel(trends.reasonCode) : 'لا توجد قراءات تاريخية كافية.';
      return;
    }
    container.appendChild(trendPanel('حجم البلاغات المرتبطة بالفرق', 'بلاغ', [{ key: 'incidentsTotal', label: 'البلاغات', color: '#60A5FA' }], trends.points));
    container.appendChild(trendPanel('أزمنة الاستجابة المسجلة', 'دقيقة', [{ key: 'avgResponseMinutes', label: 'الوصول', color: '#34D399' }, { key: 'avgMubasharaMinutes', label: 'المباشرة', color: '#F59E0B' }], trends.points));
    var unresolved = trends.unresolvedTimeCount && trends.unresolvedTimeCount.value;
    var coverage = trends.coverage;
    note.textContent = 'آخر 7 أيام بتوقيت الرياض · المصدر: ReportService · ' + V.statusLabel(trends.status) +
      (coverage ? ' · تغطية القطاعات: ' + coverage.available + '/' + coverage.expected : '') +
      (unresolved ? ' · أزمنة غير محسومة مستبعدة: ' + unresolved : '');
  }
  function applyMetricPairs(container, metrics) {
    [['staffActive', 'staffRequired'], ['vehiclesActive', 'vehiclesTotal']].forEach(function (keys) {
      var value = container.querySelector('[data-metric="' + keys[0] + '"] .rc-metric-value');
      var first = metrics && metrics[keys[0]];
      var second = metrics && metrics[keys[1]];
      var complete = first && second && first.value !== null && first.value !== undefined && second.value !== null && second.value !== undefined;
      if (value) value.textContent = complete ? pair(metrics, keys[0], keys[1]) : V.metricText(first);
    });
  }
  function setDetailMode(enabled) {
    document.body.classList.toggle('rc-detail-mode', enabled);
    id('pageEyebrow').textContent = enabled ? 'تفاصيل القطاع / مركز المتابعة / الدليل' : 'غرفة القيادة / الوضع الحالي';
    id('pageTitle').textContent = 'القوى العاملة والجاهزية التشغيلية';
    id('scopeDescription').hidden = enabled;
    id('detailShift').hidden = !enabled;
    id('closeDetail').hidden = !enabled;
    id('refreshButton').hidden = enabled;
  }
  function icon(name, className) {
    var svg = svgNode('svg', { 'class': 'rc-icon' + (className ? ' ' + className : ''), 'aria-hidden': 'true', viewBox: '0 0 24 24' });
    svg.appendChild(svgNode('use', { href: '#rc-i-' + name }));
    return svg;
  }
  function valueOf(metric) { return metric && typeof metric.value === 'number' ? metric.value : null; }
  function homeSector() {
    return state.overview && state.overview.sectors.find(function (sector) { return sector.id === state.homeSelectedId; }) || null;
  }
  function selectHomeSector(sectorId, shouldAnnounce) {
    if (!state.overview || !state.overview.sectors.some(function (sector) { return sector.id === sectorId; })) return;
    state.homeSelectedId = sectorId;
    renderSectors();
    renderHomeSidebar();
    if (shouldAnnounce !== false) announce('تم تحديث اللوحة الجانبية: ' + sectorName(sectorId));
  }
  function readinessRing(value, label, className, centerText) {
    var wrap = V.node('div', 'rc-home-ring' + (className ? ' ' + className : ''));
    var svg = svgNode('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    var radius = 42, circumference = 2 * Math.PI * radius;
    var percent = typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0;
    svg.appendChild(svgNode('circle', { cx: 50, cy: 50, r: radius, 'class': 'rc-ring-track' }));
    svg.appendChild(svgNode('circle', { cx: 50, cy: 50, r: radius, 'class': 'rc-ring-value', 'stroke-dasharray': circumference.toFixed(2), 'stroke-dashoffset': (circumference * (1 - percent / 100)).toFixed(2) }));
    wrap.appendChild(svg);
    wrap.appendChild(V.node('strong', '', centerText !== undefined ? centerText : (typeof value === 'number' ? value + '٪' : '—')));
    wrap.appendChild(V.node('small', '', label || 'جاهزية'));
    wrap.setAttribute('aria-label', (label || 'الجاهزية') + ': ' + (typeof value === 'number' ? value + '٪' : 'غير متاحة'));
    return wrap;
  }
  function sectorSparkline(sector) {
    var container = V.node('div', 'rc-sector-sparkline');
    var points = sector.trends && Array.isArray(sector.trends.points) ? sector.trends.points : [];
    var values = points.map(function (point) { return point.incidentsTotal && point.incidentsTotal.value; });
    if (!values.some(function (value) { return typeof value === 'number'; })) {
      container.appendChild(V.node('div', 'rc-spark-empty', 'الاتجاه التاريخي غير متاح'));
      return container;
    }
    var svg = svgNode('svg', { viewBox: '0 0 200 45', role: 'img', 'aria-label': 'البلاغات اليومية الفعلية خلال سبعة أيام' });
    svg.appendChild(svgNode('line', { x1: 0, x2: 200, y1: 40, y2: 40, 'class': 'rc-spark-grid' }));
    var maximum = Math.max.apply(Math, values.map(function (value) { return typeof value === 'number' ? value : 0; }).concat([1]));
    var slot = 200 / Math.max(1, values.length);
    values.forEach(function (value, index) {
      if (typeof value !== 'number') return;
      var height = value === 0 ? 0 : Math.max(3, value / maximum * 34);
      var bar = svgNode('rect', { x: (index * slot + slot * .25).toFixed(2), y: (40 - height).toFixed(2), width: (slot * .42).toFixed(2), height: height.toFixed(2), rx: 1.5, 'class': 'rc-spark-bar' });
      bar.appendChild(svgNode('title', {}, points[index].date + ': ' + value + ' بلاغ'));
      svg.appendChild(bar);
    });
    container.appendChild(svg);
    return container;
  }
  function renderOverview() {
    var overview = state.overview;
    var sectorOrder = { 'R-3': 1, 'R-2': 2, 'R-1': 3, 'R-4': 4, 'R-5': 5 };
    overview.sectors.sort(function (a, b) { return (sectorOrder[a.code] || 99) - (sectorOrder[b.code] || 99); });
    var metrics = overview.totals.metrics;
    V.metricGrid(id('regionMetrics'), metrics, REGION_KEYS, {
      notes: metricNotes(metrics, false),
      labels: { readinessRate: 'جاهزية الفرق التشغيلية', staffActive: 'الكادر الحاضر / المطلوب', incidentsActive: 'البلاغات النشطة', teamsPending: 'بانتظار التكميل' }
    });
    applyMetricPairs(id('regionMetrics'), metrics);
    id('lastUpdated').textContent = 'آخر تحديث: ' + V.formatDate(overview.generatedAt);
    id('sectorCount').textContent = '(' + overview.sectors.length + ')';
    id('scopeDescription').textContent = 'منطقة الرياض · ' + overview.sectors.length + ' قطاعات تشغيلية';
    var now = new Date();
    id('homeClock').textContent = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    id('homeDate').textContent = new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
    id('weatherValue').textContent = '—';
    var quality = id('qualityBanner');
    var sourceWarning = (overview.sourceMeta || []).some(function (source) { return source.status === 'stale' || source.status === 'unavailable'; });
    quality.hidden = !sourceWarning;
    quality.textContent = sourceWarning ? 'بعض المصادر غير مكتملة أو قديمة. تظهر القيم المتأثرة كغير متاحة ولا تُستبدل بصفر.' : '';
    if (!overview.sectors.some(function (sector) { return sector.id === state.homeSelectedId; })) {
      var requested = new URLSearchParams(location.search).get('sector');
      state.homeSelectedId = overview.sectors.some(function (sector) { return sector.id === requested; }) ? requested : (overview.sectors[0] && overview.sectors[0].id || null);
    }
    renderSectors();
    renderHomeSidebar();
    renderWorkforceDistribution();
    renderDataQuality();
    renderSectorComparison();
    renderDecisionSectorOptions();
    renderSourceMeta(overview.sourceMeta || []);
  }
  function homeSectorStat(name, label, value) {
    var row = V.node('div', 'rc-home-sector-stat');
    var caption = V.node('span');
    caption.appendChild(icon(name));
    caption.appendChild(document.createTextNode(label));
    row.appendChild(caption);
    row.appendChild(V.node('strong', '', value));
    return row;
  }
  function renderSectors() {
    var container = id('sectorList');
    V.clear(container);
    container.setAttribute('aria-busy', 'false');
    state.overview.sectors.forEach(function (sector) {
      var card = V.node('article', 'rc-sector-card');
      card.dataset.sectorId = sector.id;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-selected', String(sector.id === state.homeSelectedId));
      card.setAttribute('aria-label', 'اختيار ' + sector.name);
      var head = V.node('div', 'rc-home-sector-head');
      head.appendChild(V.node('h4', '', sector.name));
      head.appendChild(V.node('span', 'rc-home-sector-code', sector.code));
      card.appendChild(head);
      var selected = V.node('span', 'rc-home-sector-selected');
      selected.appendChild(icon('check'));
      card.appendChild(selected);
      var body = V.node('div', 'rc-home-sector-body');
      body.appendChild(readinessRing(valueOf(sector.metrics.readinessRate), 'جاهزية'));
      var stats = V.node('div', 'rc-home-sector-stats');
      stats.appendChild(homeSectorStat('users', 'الكادر', pair(sector.metrics, 'staffActive', 'staffRequired')));
      stats.appendChild(homeSectorStat('truck', 'المركبات', pair(sector.metrics, 'vehiclesActive', 'vehiclesTotal')));
      stats.appendChild(homeSectorStat('bell', 'البلاغات', V.metricText(sector.metrics.incidentsActive)));
      body.appendChild(stats);
      card.appendChild(body);
      card.appendChild(sectorSparkline(sector));
      function choose() { selectHomeSector(sector.id); }
      card.addEventListener('click', choose);
      card.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
      container.appendChild(card);
    });
    if (!state.overview.sectors.length) V.empty(container, 'لا توجد قطاعات فعالة ضمن نطاقك.');
  }
  function renderHomeSidebar() {
    var container = id('selectedSectorPanel');
    V.clear(container);
    container.setAttribute('aria-busy', 'false');
    var sector = homeSector();
    if (!sector) { container.appendChild(V.node('div', 'rc-selected-empty', 'لا يوجد قطاع محدد ضمن النطاق الحالي.')); return; }
    var inner = V.node('div', 'rc-selected-sector-inner');
    inner.dataset.sectorId = sector.id;
    var identity = V.node('section', 'rc-selected-identity');
    var head = V.node('div', 'rc-selected-sector-head');
    head.appendChild(V.node('h2', '', sector.name));
    head.appendChild(V.node('span', 'rc-home-sector-code', sector.code));
    identity.appendChild(head);
    identity.appendChild(V.node('p', '', 'نظرة تشغيلية تفصيلية'));
    var tabs = V.node('div', 'rc-selected-tabs');
    ['الملخص', 'الفرق', 'المركبات', 'البلاغات', 'التكميلات'].forEach(function (label) { tabs.appendChild(V.node('span', '', label)); });
    identity.appendChild(tabs);
    var workforce = V.node('div', 'rc-selected-workforce');
    workforce.appendChild(readinessRing(valueOf(sector.metrics.readinessRate), 'جاهزية'));
    var staff = V.node('div', 'rc-selected-staff');
    var staffTitle = V.node('h3');
    staffTitle.appendChild(document.createTextNode('القوى البشرية'));
    staffTitle.appendChild(icon('users'));
    staff.appendChild(staffTitle);
    staff.appendChild(V.node('strong', '', pair(sector.metrics, 'staffActive', 'staffRequired')));
    var active = valueOf(sector.metrics.staffActive), required = valueOf(sector.metrics.staffRequired);
    var people = V.node('div', 'rc-staff-people');
    if (active !== null && required !== null && required > 0 && required <= 60) {
      for (var person = 0; person < required; person += 1) people.appendChild(V.node('i', 'rc-staff-person' + (person >= active ? ' is-missing' : '')));
    } else {
      people.appendChild(V.node('span', '', 'التوزيع الفردي غير متاح'));
    }
    staff.appendChild(people);
    staff.appendChild(V.node('small', '', 'نقص: ' + (active !== null && required !== null ? Math.max(0, required - active) : '—')));
    workforce.appendChild(staff);
    identity.appendChild(workforce);
    inner.appendChild(identity);

    var teamBlock = V.node('section', 'rc-selected-block');
    var teamTitle = V.node('h3', 'rc-selected-block-title');
    teamTitle.appendChild(document.createTextNode('حالة الفرق (' + V.metricText(sector.metrics.teamsTotal) + ')'));
    teamTitle.appendChild(icon('users'));
    teamBlock.appendChild(teamTitle);
    var statusGrid = V.node('div', 'rc-team-status-grid');
    [
      ['teamsReady', 'جاهزة', 'check', 'ready'], ['teamsPending', 'بانتظار التكميل', 'clock', 'warning'],
      ['teamsMissing', 'ناقصة', 'bell', 'danger'], ['teamsOffline', 'غير متصلة', 'data', 'neutral']
    ].forEach(function (entry) {
      var item = V.node('div', 'rc-team-status-item');
      item.dataset.tone = entry[3];
      item.dataset.statusMetric = entry[0];
      item.appendChild(icon(entry[2]));
      item.appendChild(V.node('strong', '', V.metricText(sector.metrics[entry[0]])));
      item.appendChild(V.node('span', '', entry[1]));
      statusGrid.appendChild(item);
    });
    teamBlock.appendChild(statusGrid);
    inner.appendChild(teamBlock);

    var shifts = V.node('section', 'rc-selected-block');
    var shiftTitle = V.node('h3', 'rc-selected-block-title');
    shiftTitle.appendChild(document.createTextNode('المناوبات'));
    shiftTitle.appendChild(icon('layers'));
    shifts.appendChild(shiftTitle);
    var shiftGrid = V.node('div', 'rc-shift-grid');
    var currentType = sector.shift && sector.shift.type || '';
    [['صباحية', 'sun'], ['ليلية', 'moon']].forEach(function (entry) {
      var current = currentType.indexOf(entry[0]) >= 0;
      var item = V.node('div', 'rc-shift-item' + (current ? ' is-current' : ''));
      item.dataset.shiftType = entry[0];
      var caption = V.node('span');
      caption.appendChild(document.createTextNode('المناوبة ' + entry[0]));
      caption.appendChild(icon(entry[1]));
      item.appendChild(caption);
      item.appendChild(V.node('strong', '', current ? pair(sector.metrics, 'staffActive', 'staffRequired') : '—'));
      if (!current) item.appendChild(V.node('small', '', 'غير متاحة من اللقطة الحالية'));
      shiftGrid.appendChild(item);
    });
    shifts.appendChild(shiftGrid);
    inner.appendChild(shifts);

    var actions = V.node('section', 'rc-selected-block');
    var actionTitle = V.node('h3', 'rc-selected-block-title');
    actionTitle.appendChild(document.createTextNode('إجراءات سريعة'));
    actionTitle.appendChild(icon('layers'));
    actions.appendChild(actionTitle);
    var actionGrid = V.node('div', 'rc-quick-actions');
    [
      ['عرض الفرق', 'list', 'teams'], ['فتح الخريطة', 'map', 'map'], ['تفاصيل القطاع', 'layers', 'detail']
    ].forEach(function (entry) {
      var button = entry[2] === 'map' ? V.node('a', 'rc-button') : V.node('button', 'rc-button');
      button.dataset.homeAction = entry[2];
      if (entry[2] === 'map') button.href = '/region-map.html?sector=' + encodeURIComponent(sector.id);
      else {
        button.type = 'button';
        button.addEventListener('click', function () { selectSector(sector.id, true, entry[2] === 'teams' ? 'teams' : undefined); });
      }
      button.appendChild(icon(entry[1]));
      button.appendChild(document.createTextNode(entry[0]));
      actionGrid.appendChild(button);
    });
    actions.appendChild(actionGrid);
    inner.appendChild(actions);
    container.appendChild(inner);
  }
  function renderWorkforceDistribution() {
    var metrics = state.overview.totals.metrics;
    var active = valueOf(metrics.staffActive), required = valueOf(metrics.staffRequired);
    var availability = active !== null && required !== null && required > 0 ? Math.round(active / required * 1000) / 10 : null;
    var container = V.clear(id('workforceDistribution'));
    container.appendChild(readinessRing(availability, 'إجمالي الكادر', 'rc-workforce-ring', pair(metrics, 'staffActive', 'staffRequired')));
    var legend = V.node('div', 'rc-workforce-legend');
    [['حاضر', active], ['نقص', active !== null && required !== null ? Math.max(0, required - active) : null]].forEach(function (entry) {
      var row = V.node('div', 'rc-workforce-legend-row');
      row.appendChild(V.node('span', '', entry[0]));
      row.appendChild(V.node('strong', '', entry[1] === null ? '—' : entry[1]));
      legend.appendChild(row);
    });
    container.appendChild(legend);
    var percent = V.node('div', 'rc-workforce-percent');
    percent.appendChild(V.node('span', '', 'نسبة التوفر'));
    percent.appendChild(V.node('strong', '', availability === null ? '—' : availability + '٪'));
    var track = V.node('div', 'rc-workforce-track');
    var fill = V.node('i');
    fill.style.width = (availability === null ? 0 : Math.max(0, Math.min(100, availability))) + '%';
    track.appendChild(fill);
    percent.appendChild(track);
    container.appendChild(percent);
  }
  function renderDataQuality() {
    var complete = state.overview.sectors.filter(function (sector) { return sector.status === 'complete'; }).length;
    var summary = id('qualityCompleteness');
    summary.textContent = 'جودة المصادر: ' + complete + ' / ' + state.overview.sectors.length + ' مكتملة';
    summary.dataset.state = complete === state.overview.sectors.length ? 'complete' : 'partial';
    var rows = [
      ['بيانات القوى العاملة', 'StaffingEventsService'], ['بيانات الفرق', 'StaffingEventsService'],
      ['بيانات المركبات', 'VehicleEventsService'], ['بيانات البلاغات', 'ReportService'], ['بيانات التكميلات', 'StaffingEventsService']
    ];
    var container = V.clear(id('qualitySources'));
    rows.forEach(function (entry) {
      var sources = (state.overview.sourceMeta || []).filter(function (source) { return source.ownerService === entry[1]; });
      var status = !sources.length ? 'unavailable' : sources.some(function (source) { return source.status === 'unavailable'; }) ? 'unavailable' : sources.some(function (source) { return source.status === 'partial'; }) ? 'partial' : sources.some(function (source) { return source.status === 'stale'; }) ? 'stale' : 'ok';
      var row = V.node('div', 'rc-quality-source');
      row.dataset.state = status;
      row.dataset.ownerService = entry[1];
      row.appendChild(V.node('span', '', entry[0]));
      row.appendChild(V.node('small', '', status === 'ok' ? 'محدثة' : V.statusLabel(status)));
      row.appendChild(V.node('i', '', status === 'ok' ? '✓' : '!'));
      container.appendChild(row);
    });
  }
  function renderSectorComparison() {
    var tabs = V.clear(id('comparisonTabs'));
    COMPARISON_METRICS.forEach(function (entry) {
      var button = V.node('button', '', entry[1]);
      button.type = 'button';
      button.dataset.comparisonMetric = entry[0];
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.comparisonMetric === entry[0]));
      button.addEventListener('click', function () { state.comparisonMetric = entry[0]; renderSectorComparison(); });
      tabs.appendChild(button);
    });
    var sectors = state.overview.sectors.slice();
    var values = sectors.map(function (sector) { return valueOf(sector.metrics[state.comparisonMetric]); });
    var maximum = Math.max.apply(Math, values.map(function (value) { return value === null ? 0 : value; }).concat([1]));
    sectors.sort(function (a, b) { return (valueOf(b.metrics[state.comparisonMetric]) || 0) - (valueOf(a.metrics[state.comparisonMetric]) || 0); });
    var container = V.clear(id('sectorComparison'));
    sectors.forEach(function (sector) {
      var value = valueOf(sector.metrics[state.comparisonMetric]);
      var row = V.node('div', 'rc-comparison-row');
      var name = V.node('button', '', sector.name);
      name.type = 'button';
      name.addEventListener('click', function () { selectHomeSector(sector.id); });
      row.appendChild(name);
      var track = V.node('div', 'rc-comparison-track');
      var fill = V.node('i');
      fill.style.width = (value === null ? 0 : value / maximum * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(V.node('strong', '', V.metricText(sector.metrics[state.comparisonMetric], state.comparisonMetric)));
      container.appendChild(row);
    });
  }
  function renderSourceMeta(entries) {
    id('sourceReadCount').textContent = entries.length + ' قراءة';
    var container = id('sourceMetaList');
    V.clear(container);
    entries.forEach(function (source) {
      var row = V.node('div', 'rc-source-meta-row');
      row.appendChild(V.node('strong', '', sectorName(source.sectorId) + ' · ' + source.ownerService));
      row.appendChild(V.statusBadge(source.status));
      row.appendChild(V.node('small', '', (source.reasonCode ? V.reasonLabel(source.reasonCode) + ' · ' : '') + 'وقت المصدر: ' + V.formatDate(source.sourceAt, true)));
      container.appendChild(row);
    });
    if (!entries.length) V.empty(container, 'لا توجد بيانات مصدر متاحة.');
  }
  function renderDecisionSectorOptions() {
    var select = id('decisionSector');
    var current = select.value;
    select.replaceChildren(new Option('كل القطاعات المخولة', ''));
    state.overview.sectors.forEach(function (sector) { select.appendChild(new Option(sector.name, sector.id)); });
    select.value = current;
  }
  async function loadOverview() {
    var version = ++state.overviewVersion;
    V.skeleton(id('regionMetrics'), 6);
    V.skeleton(id('sectorList'), 3);
    id('globalError').hidden = true;
    try {
      var params = new URLSearchParams(location.search);
      var overview = await API.overview(params.get('regionId'));
      if (version !== state.overviewVersion) return;
      state.overview = overview;
      renderOverview();
    } catch (error) {
      if (version !== state.overviewVersion) return;
      state.overview = null;
      V.empty(id('regionMetrics'), 'الملخص غير متاح.');
      V.empty(id('sectorList'), 'لا يمكن عرض القطاعات.');
      V.showError(id('globalError'), error);
    }
  }
  async function loadDecisions(reset) {
    if (!state.overview) return;
    var version = ++state.decisionVersion;
    if (reset) { state.decisionItems = []; state.decisionNext = null; V.skeleton(id('decisionList'), 3); }
    var filters = { sectorId: id('decisionSector').value || undefined, category: id('decisionCategory').value || undefined, limit: 20 };
    if (!reset && state.decisionNext) filters.cursor = state.decisionNext;
    try {
      var result = await API.decisions(filters);
      if (version !== state.decisionVersion) return;
      var byId = new Map(state.decisionItems.map(function (item) { return [item.id, item]; }));
      result.items.forEach(function (item) { byId.set(item.id, item); });
      state.decisionItems = Array.from(byId.values());
      state.decisionNext = result.nextCursor;
      id('decisionCount').textContent = V.metricText(result.count, 'decisionCount');
      renderDecisions();
    } catch (error) {
      if (version !== state.decisionVersion) return;
      V.empty(id('decisionList'), error.status === 403 ? 'مركز القرار غير مصرح ضمن هذا النطاق.' : 'تعذر تحميل مركز القرار.');
      id('decisionMore').hidden = true;
    }
  }
  function decisionEntry(item, inDetail) {
    var entry = V.node('article', 'rc-decision-entry');
    entry.dataset.category = item.category || 'data_quality';
    var button = V.node('button', 'rc-decision-item');
    button.type = 'button';
    button.appendChild(V.node('strong', '', inDetail ? V.reasonLabel(item.reasonCode) : sectorName(item.sectorId)));
    button.appendChild(V.statusBadge(item.status, inDetail ? (CATEGORY_LABELS[item.category] || item.category) + ' · ' + V.statusLabel(item.status) : undefined));
    button.appendChild(V.node('p', '', inDetail ? item.entityId + ' · ' + (item.reasonCode || '') : V.reasonLabel(item.reasonCode)));
    button.appendChild(V.node('small', '', 'الدليل والمصدر ←'));
    button.addEventListener('click', function () { openDecisionEvidence(item.id); });
    entry.appendChild(button);
    if (inDetail) {
      var open = V.node('button', 'rc-button rc-button-quiet rc-decision-open', 'فتح التبويب المناسب');
      open.type = 'button';
      open.addEventListener('click', function () { setTab(CATEGORY_TABS[item.category] || 'teams'); });
      entry.appendChild(open);
    }
    return entry;
  }
  function renderDecisions() {
    var container = id('decisionList');
    V.clear(container);
    container.setAttribute('aria-busy', 'false');
    state.decisionItems.forEach(function (item) { container.appendChild(decisionEntry(item, false)); });
    if (!state.decisionItems.length) V.empty(container, 'لا توجد عناصر تحتاج مراجعة ضمن المرشحات الحالية.');
    id('decisionMore').hidden = !state.decisionNext;
  }
  function renderDetailDecisions(sector) {
    var container = id('detailDecisionList');
    V.clear(container);
    var items = sector.decisions || [];
    items.forEach(function (item) { container.appendChild(decisionEntry(item, true)); });
    if (!items.length) V.empty(container, 'لا توجد عناصر تحتاج مراجعة في هذا القطاع ضمن اللقطة الحالية.');
    var count = sector.decisionCount && sector.decisionCount.value;
    id('detailDecisionCount').textContent = count === null || count === undefined ? 'عناصر المراجعة غير متاحة' : count + ' عناصر تحتاج مراجعة';
    if (items.length && !state.evidenceUserClosed && !id('evidenceDialog').open) openDecisionEvidence(items[0].id);
  }
  async function selectSector(sectorId, scroll, tab) {
    state.selectedId = sectorId;
    state.homeSelectedId = sectorId;
    state.activeTab = tab || 'teams';
    state.ledgerEntries = [];
    state.ledgerNext = null;
    state.evidenceUserClosed = false;
    if (id('evidenceDialog').open) id('evidenceDialog').close();
    setTab(state.activeTab);
    await loadDetail(sectorId, true);
    if (scroll) window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  async function loadDetail(sectorId, updateUrl) {
    if (!sectorId) return;
    var version = ++state.detailVersion;
    state.selectedId = sectorId;
    id('sectorDetail').hidden = false;
    id('detailError').hidden = true;
    id('detailContent').hidden = false;
    id('detailTitle').textContent = sectorName(sectorId);
    id('detailShift').textContent = 'جارٍ تحميل المناوبة والمؤشرات…';
    V.skeleton(id('detailMetrics'), 5);
    V.skeleton(id('detailDecisionList'), 2);
    if (updateUrl) {
      var url = new URL(location.href);
      url.searchParams.set('sector', sectorId);
      history.replaceState(null, '', url.pathname + url.search);
    }
    try {
      var detail = await API.sector(sectorId);
      if (version !== state.detailVersion) return;
      state.detail = detail;
      renderDetail();
      if (state.context.capabilities.canViewLedger && state.activeTab === 'ledger') loadLedger(true);
    } catch (error) {
      if (version !== state.detailVersion) return;
      state.detail = null;
      id('detailContent').hidden = true;
      V.showError(id('detailError'), error);
    }
  }
  function renderDetail() {
    var detail = state.detail;
    var sector = detail.sector;
    setDetailMode(true);
    id('detailTitle').textContent = sector.name;
    id('detailShift').textContent = sector.name + ' · ' + (sector.shift ? (sector.shift.name || 'المناوبة الحالية') + ' · ' + (sector.shift.type || 'الوضع الحالي') : 'لا توجد مناوبة نشطة') + ' · قراءة فقط';
    id('detailStatus').textContent = sector.code + ' · ' + (sector.shift ? 'مناوبة ' + sector.shift.id : V.statusLabel(sector.status));
    V.metricGrid(id('detailMetrics'), sector.metrics, DETAIL_KEYS, { onEvidence: openMetricEvidence, notes: metricNotes(sector.metrics, true) });
    applyMetricPairs(id('detailMetrics'), sector.metrics);
    id('ledgerTab').hidden = !state.context.capabilities.canViewLedger;
    renderDetailDecisions(sector);
    renderTeams(sector.teams, id('teamList'));
    renderVehicles(sector.vehicles);
    renderIncidents(sector.incidents, id('incidentList'));
  }
  function renderTeams(teams, container) {
    V.table(container, [
      { key: 'name', label: 'الفرقة / الرمز التشغيلي', render: function (team) { return V.teamIdentity(team); } }, { key: 'center', label: 'المركز' },
      { key: 'activeCount', label: 'الحاضر / المطلوب', render: function (team) { return V.metricText(team.activeCount) + ' / ' + V.metricText(team.requiredPersonnel); } },
      { key: 'status', label: 'الحالة', render: function (team) {
        var status = V.node('div', 'rc-team-state');
        status.appendChild(V.statusBadge(team.status));
        if (team.status === 'busy' && team.activeIncidentIds && team.activeIncidentIds.length) status.appendChild(V.node('small', 'rc-team-incident-link', 'البلاغ: ' + team.activeIncidentIds.join('، ')));
        return status;
      } }
    ], teams, 'لا توجد فرق مسجلة ضمن مراكز هذا القطاع في المناوبة الحالية.');
    var latest = teams.map(function (team) { return team.lastDecisionAt; }).filter(Boolean).sort().pop();
    id('teamSourceNote').textContent = latest ? 'آخر قرار تكميل مسجل: ' + V.formatDate(latest, true) : 'آخر قرار تكميل غير متاح في البيانات الحالية.';
  }
  function renderVehicles(vehicles) {
    V.table(id('vehicleList'), [
      { key: 'name', label: 'المركبة' }, { key: 'center', label: 'المركز' },
      { key: 'status', label: 'الحالة', render: function (vehicle) { return V.statusBadge(vehicle.status); } },
      { key: 'sourceAt', label: 'وقت المصدر', render: function (vehicle) { return V.formatDate(vehicle.sourceAt); } }
    ], vehicles, 'لا توجد مركبات مرتبطة بمراكز هذا القطاع.');
  }
  function renderIncidents(incidents, container) {
    V.table(container, [
      { key: 'id', label: 'البلاغ' }, { key: 'type', label: 'النوع' },
      { key: 'status', label: 'الحالة', render: function (incident) { return V.statusBadge(incident.status); } },
      { key: 'district', label: 'الحي' },
      { key: 'teams', label: 'الفرق / الرموز', render: function (incident) { return V.teamList(incident.teamIdentities, incident.teams); } },
      { key: 'bestArrivalMin', label: 'زمن الوصول', render: function (incident) { return V.metricText(incident.bestArrivalMin, 'avgResponseMinutes'); } },
      { key: 'createdAt', label: 'وقت الإنشاء', render: function (incident) { return V.formatDate(incident.createdAt, true); } }
    ], incidents, 'لا توجد بلاغات مرتبطة بفرق هذا القطاع.');
  }
  function setTab(tab) {
    if (tab === 'ledger' && !state.context.capabilities.canViewLedger) return;
    state.activeTab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (button) { button.setAttribute('aria-selected', String(button.dataset.tab === tab)); });
    ['teams', 'vehicles', 'incidents', 'ledger'].forEach(function (name) { id(name + 'Panel').hidden = name !== tab; });
    if (tab === 'ledger' && state.selectedId) loadLedger(true);
  }
  async function loadLedger(reset) {
    if (!state.context.capabilities.canViewLedger || !state.selectedId) return;
    var version = ++state.ledgerVersion;
    if (reset) { state.ledgerEntries = []; state.ledgerNext = null; V.skeleton(id('ledgerList'), 3); }
    var filters = { eventType: id('ledgerEventType').value || undefined, limit: 20 };
    if (!reset && state.ledgerNext) filters.cursor = state.ledgerNext;
    try {
      var result = await API.ledger(state.selectedId, filters);
      if (version !== state.ledgerVersion) return;
      var byId = new Map(state.ledgerEntries.map(function (entry) { return [entry.id, entry]; }));
      result.entries.forEach(function (entry) { byId.set(entry.id, entry); });
      state.ledgerEntries = Array.from(byId.values()).sort(function (a, b) { return b.sectorSeq - a.sectorSeq; });
      state.ledgerNext = result.nextCursor;
      renderLedger();
    } catch (error) {
      if (version !== state.ledgerVersion) return;
      V.empty(id('ledgerList'), error.status === 403 ? 'السجل القيادي غير مصرح.' : 'تعذر تحميل السجل القيادي.');
      id('ledgerMore').hidden = true;
    }
  }
  function renderLedger() {
    var container = id('ledgerList');
    V.clear(container);
    state.ledgerEntries.forEach(function (entry) {
      var article = V.node('article', 'rc-ledger-entry');
      var head = V.node('div', 'rc-ledger-entry-head');
      head.appendChild(V.node('strong', '', V.statusLabel(entry.eventType)));
      head.appendChild(V.node('span', 'rc-count-chip', '#' + entry.sectorSeq));
      article.appendChild(head);
      article.appendChild(V.node('p', '', V.formatDate(entry.occurredAt, true) + ' · الفاعل: ' + entry.actorUserId));
      article.appendChild(V.node('code', 'rc-hash', entry.eventHash));
      container.appendChild(article);
    });
    if (!state.ledgerEntries.length) V.empty(container, 'لا توجد أحداث قيادية مسجلة لهذا القطاع ضمن المرشحات الحالية.');
    id('ledgerMore').hidden = !state.ledgerNext;
  }
  function openDialog(title) {
    id('evidenceTitle').textContent = title;
    V.skeleton(id('evidenceBody'), 2);
    var dialog = id('evidenceDialog');
    var workspace = dialog.parentElement;
    if (!dialog.dataset.layoutBound) {
      dialog.dataset.layoutBound = 'true';
      dialog.addEventListener('close', function () { workspace.classList.add('rc-evidence-closed'); });
    }
    workspace.classList.remove('rc-evidence-closed');
    state.evidenceUserClosed = false;
    if (!dialog.open) dialog.open = true;
  }
  function evidenceGrid(entries) {
    var grid = V.node('div', 'rc-evidence-grid');
    entries.forEach(function (entry) {
      var item = V.node('div', 'rc-evidence-item' + (entry[2] ? ' rc-wide' : ''));
      item.appendChild(V.node('span', '', entry[0]));
      item.appendChild(V.node('strong', '', entry[1] === null || entry[1] === undefined || entry[1] === '' ? '—' : String(entry[1])));
      grid.appendChild(item);
    });
    V.clear(id('evidenceBody')).appendChild(grid);
  }
  async function openMetricEvidence(metricKey) {
    if (!state.selectedId) return;
    openDialog('دليل ' + (V.labels[metricKey] || metricKey));
    try {
      var result = await API.metricEvidence(state.selectedId, metricKey);
      evidenceGrid([
        ['المؤشر', result.metric.label], ['القيمة', V.metricText(result.value, metricKey)],
        ['المصدر المالك', result.metric.ownerService], ['إصدار المؤشر', result.metric.version],
        ['مرجع المعادلة', result.metric.formulaRef, true], ['حالة القيمة', V.statusLabel(result.value.status)],
        ['السبب', V.reasonLabel(result.value.reasonCode) || '—'], ['وقت المصدر', V.formatDate(result.value.sourceAt, true)],
        ['البسط', result.numerator ? V.metricText(result.numerator) : 'لا ينطبق'], ['المقام', result.denominator ? V.metricText(result.denominator) : 'لا ينطبق'],
        ['التغطية', result.value.coverage.available + ' / ' + result.value.coverage.expected, true]
      ]);
    } catch (error) { V.empty(id('evidenceBody'), error.message); }
  }
  async function openDecisionEvidence(itemId) {
    var known = state.decisionItems.find(function (item) { return item.id === itemId; });
    if (!state.detail && known) {
      state.evidenceUserClosed = true;
      await selectSector(known.sectorId, false);
    }
    openDialog('دليل عنصر المراجعة');
    try {
      var result = await API.decisionEvidence(itemId);
      var item = result.item;
      var evidence = Object.entries(item.evidence || {}).map(function (pair) { return [pair[0], typeof pair[1] === 'object' ? JSON.stringify(pair[1]) : pair[1]]; });
      var owner = item.ownerService || (item.evidence && item.evidence.ownerService);
      if (!owner && state.detail && Array.isArray(state.detail.sourceMeta)) {
        var ownerName = item.category === 'staffing' ? 'StaffingEventsService' : item.category === 'vehicles' ? 'VehicleEventsService' : null;
        var source = state.detail.sourceMeta.find(function (entry) { return entry.ownerService === ownerName; });
        if (source) owner = source.ownerService;
      }
      evidenceGrid([
        ['السبب المعتمد', item.reasonCode], ['الكيان', item.entityId],
        ['الفئة', CATEGORY_LABELS[item.category] || item.category], ['الحالة', V.statusLabel(item.status)],
        ['المصدر المالك', owner || 'غير منصوص في استجابة الدليل'], ['إصدار المصدر', item.sourceVersion, true]
      ].concat(evidence.length ? evidence : [['الدليل', 'لا توجد حقول إضافية', true]]));
      var body = id('evidenceBody');
      var hero = V.node('div', 'rc-evidence-hero');
      hero.appendChild(V.node('strong', '', V.reasonLabel(item.reasonCode)));
      hero.appendChild(V.node('p', '', item.entityId + ' · ' + (CATEGORY_LABELS[item.category] || item.category) + ' · ' + V.statusLabel(item.status)));
      body.insertBefore(hero, body.firstChild);
      var open = V.node('button', 'rc-button rc-evidence-tab-button', 'فتح تفاصيل ' + (CATEGORY_LABELS[item.category] || 'العنصر') + ' في القطاع ←');
      open.type = 'button';
      open.addEventListener('click', function () { setTab(CATEGORY_TABS[item.category] || 'teams'); });
      body.appendChild(open);
    } catch (error) { V.empty(id('evidenceBody'), error.message); }
  }
  async function refreshAll() {
    if (!state.context) return;
    await loadOverview();
    var jobs = [loadDecisions(true)];
    if (state.selectedId) jobs.push(loadDetail(state.selectedId, false));
    await Promise.all(jobs);
    announce('تم تحديث بيانات القيادة دون إعادة تحميل الصفحة.');
  }
  function bind() {
    id('refreshButton').addEventListener('click', refreshAll);
    id('decisionSector').addEventListener('change', function () { loadDecisions(true); });
    id('decisionCategory').addEventListener('change', function () { loadDecisions(true); });
    id('decisionMore').addEventListener('click', function () { loadDecisions(false); });
    id('ledgerMore').addEventListener('click', function () { loadLedger(false); });
    id('ledgerEventType').addEventListener('change', function () { loadLedger(true); });
    id('closeDetail').addEventListener('click', function () {
      ++state.detailVersion;
      state.selectedId = null;
      state.detail = null;
      if (id('evidenceDialog').open) id('evidenceDialog').close();
      id('sectorDetail').hidden = true;
      setDetailMode(false);
      selectHomeSector(state.homeSelectedId, false);
      var url = new URL(location.href);
      url.searchParams.delete('sector');
      history.replaceState(null, '', url.pathname + url.search);
      window.scrollTo({ top: 0, behavior: 'auto' });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (button) { button.addEventListener('click', function () { setTab(button.dataset.tab); }); });
    id('closeEvidence').addEventListener('click', function () { state.evidenceUserClosed = true; id('evidenceDialog').close(); });
    window.addEventListener('beforeunload', function () { if (state.realtime) state.realtime.stop(); });
  }
  async function init() {
    if (!window.AuthCore || !AuthCore.requireAuth('/')) return;
    API = window.RegionCommandAPI;
    V = window.RegionCommandViews;
    V.initTheme();
    bind();
    V.skeleton(id('regionMetrics'), 6);
    V.skeleton(id('sectorList'), 3);
    V.skeleton(id('decisionList'), 3);
    try {
      state.context = await API.context();
      await loadOverview();
      if (!state.overview) return;
      await loadDecisions(true);
      var requested = new URLSearchParams(location.search).get('sector');
      var scopedSector = state.context.scopes.length === 1 && state.context.scopes[0].type === 'sector' ? state.context.scopes[0].id : null;
      if (requested || scopedSector) await selectSector(requested || scopedSector, false);
      state.realtime = new RegionCommandRealtime({ onChange: refreshAll, onStatus: updateConnection });
      state.realtime.start();
    } catch (error) {
      V.showError(id('globalError'), error);
      V.empty(id('regionMetrics'), 'لوحة القيادة غير متاحة.');
      V.empty(id('sectorList'), 'لا يمكن تحديد نطاق الوصول.');
      V.empty(id('decisionList'), 'لا يمكن تحميل مركز القرار.');
      updateConnection('forbidden');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
