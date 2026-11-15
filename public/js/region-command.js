(function () {
  'use strict';
  var API, V;
  var REGION_KEYS = ['readinessRate', 'staffActive', 'vehiclesActive', 'incidentsActive', 'avgResponseMinutes', 'teamsPending'];
  var DETAIL_KEYS = ['readinessRate', 'staffActive', 'vehiclesActive', 'incidentsActive', 'avgResponseMinutes'];
  var COLORS = ['#34D399', '#60A5FA', '#A78BFA', '#F59E0B', '#22D3EE', '#F472B6', '#94A3B8'];
  var CATEGORY_LABELS = { staffing: 'القوى', vehicles: 'المركبات', data_quality: 'جودة البيانات' };
  var CATEGORY_TABS = { staffing: 'teams', vehicles: 'vehicles', data_quality: 'teams' };
  var state = {
    context: null, overview: null, selectedId: null, detail: null,
    overviewVersion: 0, detailVersion: 0, decisionVersion: 0, ledgerVersion: 0,
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
  function metricNotes(metrics, detail) {
    return {
      readinessRate: pair(metrics, 'teamsReady', 'teamsTotal') + ' فرق جاهزة',
      staffActive: 'المطلوب: ' + V.metricText(metrics && metrics.staffRequired),
      vehiclesActive: 'الإجمالي: ' + V.metricText(metrics && metrics.vehiclesTotal),
      incidentsActive: 'إجمالي CAD: ' + V.metricText(metrics && metrics.incidentsTotal),
      avgResponseMinutes: detail ? 'وفق تغطية أزمنة بلاغات القطاع' : 'موزون بتغطية البلاغات',
      teamsPending: 'حالة pending في قراءة التكميل'
    };
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
    id('pageTitle').textContent = enabled ? 'من المؤشر العام إلى سبب المتابعة' : 'الصورة التشغيلية في لقطة واحدة';
    id('scopeDescription').hidden = enabled;
    id('detailShift').hidden = !enabled;
    id('closeDetail').hidden = !enabled;
    id('refreshButton').hidden = enabled;
  }
  function renderOverview() {
    var overview = state.overview;
    var metrics = overview.totals.metrics;
    V.metricGrid(id('regionMetrics'), metrics, REGION_KEYS, {
      notes: metricNotes(metrics, false),
      labels: { readinessRate: 'جاهزية الفرق التشغيلية', staffActive: 'الكادر الحاضر / المطلوب', incidentsActive: 'البلاغات النشطة', teamsPending: 'بانتظار التكميل' }
    });
    applyMetricPairs(id('regionMetrics'), metrics);
    id('lastUpdated').textContent = 'آخر تحديث: ' + V.formatDate(overview.generatedAt);
    var complete = overview.sectors.filter(function (sector) { return sector.status === 'complete'; }).length;
    id('sectorCount').textContent = 'جودة المصدر: ' + complete + ' / ' + overview.sectors.length + ' مكتملة';
    id('sectorCount').dataset.state = complete === overview.sectors.length ? 'complete' : 'partial';
    id('scopeDescription').textContent = 'منطقة الرياض · الوضع الحالي · ' + overview.sectors.length + ' قطاعات ضمن النطاق المخول فقط';
    var quality = id('qualityBanner');
    quality.hidden = overview.totals.status === 'complete';
    quality.textContent = overview.totals.status === 'complete' ? '' : 'بعض المصادر غير مكتملة أو قديمة. تظهر القيم المتأثرة كغير متاحة ولا تُستبدل بصفر.';
    renderSectors();
    renderDecisionSectorOptions();
    renderSourceMeta(overview.sourceMeta || []);
  }
  function sectorStat(label, value, note, scale) {
    var box = V.node('div', 'rc-sector-stat');
    box.appendChild(V.node('span', '', label));
    box.appendChild(V.node('strong', '', value));
    if (note) box.appendChild(V.node('small', '', note));
    if (scale !== null && scale !== undefined) {
      var track = V.node('span', 'rc-mini-track');
      track.setAttribute('aria-hidden', 'true');
      var fill = V.node('span', 'rc-mini-fill');
      fill.style.setProperty('--metric-scale', Math.max(0, Math.min(100, scale)));
      track.appendChild(fill);
      box.appendChild(track);
    }
    return box;
  }
  function renderSectors() {
    var container = id('sectorList');
    V.clear(container);
    container.setAttribute('aria-busy', 'false');
    state.overview.sectors.forEach(function (sector, index) {
      var card = V.node('article', 'rc-sector-card');
      card.style.setProperty('--sector-color', COLORS[index % COLORS.length]);
      var head = V.node('div', 'rc-sector-card-head');
      var identity = V.node('div', 'rc-sector-identity');
      identity.appendChild(V.node('span', 'rc-sector-swatch'));
      var text = V.node('div');
      text.appendChild(V.node('h4', '', sector.name));
      var subtitle = V.node('p', '', sector.code + ' · ' + V.statusLabel(sector.status) + ' · ');
      var open = V.node('button', 'rc-button rc-button-quiet', 'فتح القطاع ←');
      open.type = 'button';
      open.addEventListener('click', function () { selectSector(sector.id, true); });
      subtitle.appendChild(open);
      text.appendChild(subtitle);
      identity.appendChild(text);
      head.appendChild(identity);
      card.appendChild(head);
      var stats = V.node('div', 'rc-sector-stats');
      var metrics = sector.metrics;
      var readiness = metrics.readinessRate && metrics.readinessRate.value;
      var response = metrics.avgResponseMinutes && metrics.avgResponseMinutes.value;
      stats.appendChild(sectorStat('الجاهزية', V.metricText(metrics.readinessRate, 'readinessRate'), pair(metrics, 'teamsReady', 'teamsTotal'), typeof readiness === 'number' ? readiness : 0));
      stats.appendChild(sectorStat('الكادر', pair(metrics, 'staffActive', 'staffRequired'), 'الحاضر / المطلوب'));
      stats.appendChild(sectorStat('المركبات', pair(metrics, 'vehiclesActive', 'vehiclesTotal'), 'العاملة / الإجمالي'));
      stats.appendChild(sectorStat('البلاغات', V.metricText(metrics.incidentsActive), 'النشطة / CAD'));
      stats.appendChild(sectorStat('زمن الوصول', V.metricText(metrics.avgResponseMinutes, 'avgResponseMinutes'), 'متوسط موزون', typeof response === 'number' ? response * 10 : 0));
      card.appendChild(stats);
      container.appendChild(card);
    });
    if (!state.overview.sectors.length) V.empty(container, 'لا توجد قطاعات فعالة ضمن نطاقك.');
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
      { key: 'status', label: 'الحالة', render: function (team) { return V.statusBadge(team.status); } }
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
