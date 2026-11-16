(function () {
  'use strict';
  var API, V;
  var COLORS = ['#34D399', '#60A5FA', '#A78BFA', '#F59E0B', '#22D3EE', '#F472B6', '#94A3B8'];
  var state = {
    context: null, overview: null, maps: new Map(), selectedId: null, detail: null,
    map: null, tile: null, layers: null, points: [], heatPoints: [], version: 0, detailVersion: 0,
    boundaryLayers: new Map(), sectorBounds: new Map(),
    realtime: null, fitted: false, activeTab: 'teams', panelCollapsed: false,
    resizeObserver: null, invalidateFrame: null, resizeView: null, resizeViewTimer: null,
    mapMoving: false, mapMoveVersion: 0, mapMoveTimer: null
  };
  function id(name) { return document.getElementById(name); }
  function announce(message) { id('liveAnnouncer').textContent = message; }
  function sectorColor(sectorId) {
    var index = state.overview ? state.overview.sectors.findIndex(function (sector) { return sector.id === sectorId; }) : 0;
    return COLORS[Math.max(0, index) % COLORS.length];
  }
  function updateConnection(status) {
    var element = id('connectionStatus');
    var labels = { connected: 'متصل لحظيًا', connecting: 'جارٍ الاتصال', reconnecting: 'جارٍ استعادة الاتصال', disconnected: 'الاتصال متوقف', forbidden: 'التحديث اللحظي متوقف' };
    element.dataset.state = status;
    element.replaceChildren(V.node('span'), document.createTextNode(labels[status] || labels.connecting));
  }
  function invalidateMapSize() {
    if (!state.map) return;
    if (!state.mapMoving && state.map._loaded && !state.resizeView) state.resizeView = { center: state.map.getCenter(), zoom: state.map.getZoom() };
    if (state.invalidateFrame) cancelAnimationFrame(state.invalidateFrame);
    state.invalidateFrame = requestAnimationFrame(function () {
      state.invalidateFrame = null;
      if (!state.map || !state.map._loaded) return;
      var view = state.resizeView || { center: state.map.getCenter(), zoom: state.map.getZoom() };
      state.map.invalidateSize({ animate: false, pan: false, debounceMoveend: true });
      if (state.mapMoving) return;
      // تثبيت مركز بداية الانتقال في كل الإطارات يمنع تراكم الانزياح حتى اكتمال الحجم.
      state.map.setView(view.center, view.zoom, { animate: false });
      clearTimeout(state.resizeViewTimer);
      state.resizeViewTimer = setTimeout(function () { state.resizeView = null; }, 420);
    });
  }
  function watchMapSize() {
    if (!window.ResizeObserver || state.resizeObserver) return;
    state.resizeObserver = new ResizeObserver(invalidateMapSize);
    state.resizeObserver.observe(id('regionMap'));
  }
  function updateHeatPoints(points) {
    state.heatPoints = points || [];
    var heat = state.layers && state.layers.heat;
    // Leaflet.heat 0.2.0 يقرأ this._map._animating في redraw دون فحص _map.
    // لا نحدّث طبقة سبق إزالتها؛ تُزوّد بأحدث النقاط فور إعادة إضافتها.
    if (heat && heat._map) heat.setLatLngs(state.heatPoints);
  }
  function removeOperationalLayer(layer) {
    if (!state.map || !layer) return;
    if (layer === state.layers.heat && layer._frame) {
      L.Util.cancelAnimFrame(layer._frame);
      layer._frame = null;
    }
    state.map.removeLayer(layer);
  }
  function initMap() {
    if (state.map) return true;
    if (!window.L || typeof L.map !== 'function') {
      V.showError(id('mapError'), { message: 'مكتبة الخرائط غير متاحة؛ لا تُعرض مواقع بديلة أو مفترضة.' });
      id('mapLoading').hidden = true;
      return false;
    }
    state.map = L.map('regionMap', { zoomControl: true, attributionControl: true, keyboard: true }).setView([24.7136, 46.6753], 10);
    state.layers = { boundaries: L.layerGroup().addTo(state.map), centers: L.layerGroup().addTo(state.map), incidents: L.layerGroup().addTo(state.map), positionings: L.layerGroup().addTo(state.map), heat: typeof L.heatLayer === 'function' ? L.heatLayer([], { radius: 28, blur: 22, minOpacity: .22 }) : null };
    setTiles();
    watchMapSize();
    state.map.on('tileerror', function () {
      id('mapNotice').textContent = 'تعذر تحميل بعض بلاطات الخريطة. العلامات المعروضة تبقى من البيانات المسجلة فقط.';
      id('mapNotice').hidden = false;
    });
    return true;
  }
  function setTiles() {
    if (!state.map) return;
    if (state.tile) state.map.removeLayer(state.tile);
    state.tile = L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
    }).addTo(state.map);
  }
  function renderSectorStrip() {
    var container = id('mapSectorList');
    V.clear(container);
    container.setAttribute('aria-busy', 'false');
    if (state.overview.sectors.length > 1) {
      var all = V.node('button', 'rc-sector-button rc-sector-all', 'جميع القطاعات');
      all.type = 'button';
      all.dataset.sector = 'all';
      all.setAttribute('aria-pressed', String(state.selectedId === null));
      all.addEventListener('click', function () { selectAllSectors(true); });
      container.appendChild(all);
    }
    state.overview.sectors.forEach(function (sector) {
      var button = V.node('button', 'rc-sector-button', sector.name);
      button.type = 'button';
      button.dataset.sector = sector.id;
      button.style.setProperty('--sector-color', sectorColor(sector.id));
      button.setAttribute('aria-pressed', String(state.selectedId === sector.id));
      button.addEventListener('click', function () { selectSector(sector.id, true); });
      container.appendChild(button);
    });
  }
  function regionalMetric(label, value) {
    var card = V.node('article', 'rc-map-regional-card');
    card.appendChild(V.node('span', '', label));
    card.appendChild(V.node('strong', '', value));
    return card;
  }
  function renderRegionalMetrics() {
    var metrics = state.overview.totals.metrics;
    var container = V.clear(id('mapRegionalMetrics'));
    container.appendChild(regionalMetric('المركبات الجاهزة', V.metricText(metrics.vehiclesActive)));
    container.appendChild(regionalMetric('متوسط الوصول', V.metricText(metrics.avgResponseMinutes, 'avgResponseMinutes')));
    container.appendChild(regionalMetric('البلاغات النشطة', V.metricText(metrics.incidentsActive)));
    container.appendChild(regionalMetric('الفرق المكتملة', V.metricText(metrics.teamsReady) + ' / ' + V.metricText(metrics.teamsTotal)));
    container.appendChild(regionalMetric('القوة الميدانية', V.metricText(metrics.staffActive)));
  }
  async function loadOverview() {
    var params = new URLSearchParams(location.search);
    state.overview = await API.overview(params.get('regionId'));
    renderSectorStrip();
    renderRegionalMetrics();
    id('mapUpdated').textContent = 'آخر تحديث: ' + V.formatDate(state.overview.generatedAt);
    var freshness = id('mapDataFreshness').querySelector('small');
    freshness.textContent = 'آخر تحديث: ' + V.formatDate(state.overview.generatedAt);
  }
  async function loadMaps() {
    var version = ++state.version;
    var results = await Promise.allSettled(state.overview.sectors.map(function (sector) { return API.sectorMap(sector.id); }));
    if (version !== state.version) return;
    state.maps = new Map();
    var failures = [];
    results.forEach(function (result, index) {
      if (result.status === 'fulfilled') state.maps.set(state.overview.sectors[index].id, result.value);
      else failures.push(state.overview.sectors[index].name);
    });
    var quality = id('mapQuality');
    quality.hidden = failures.length === 0;
    quality.textContent = failures.length ? 'تعذر تحميل الطبقات لبعض القطاعات: ' + failures.join('، ') + '. لم تُستخدم بيانات بديلة.' : '';
    if (initMap()) renderLayers();
  }
  function popupForIncident(incident) {
    var popup = V.node('div', 'rc-map-popup');
    var presentation = window.ProQAIncidentIcons.resolve(incident.code);
    popup.appendChild(V.node('strong', '', 'بلاغ ' + incident.id));
    popup.appendChild(V.node('p', 'rc-proqa-popup-type', presentation.category === null ? (incident.type || presentation.label) : presentation.label));
    popup.appendChild(V.node('p', 'rc-proqa-popup-code', incident.code ? 'ProQA: ' + incident.code : 'ProQA: غير متاح'));
    var priority = V.node('p', 'rc-proqa-popup-priority', presentation.classificationAvailable ? 'الأولوية: ' + presentation.priorityName + ' — ' + presentation.priorityLabel : 'الأولوية: التصنيف غير متاح');
    priority.dataset.tone = presentation.tone;
    popup.appendChild(priority);
    popup.appendChild(V.node('p', '', 'الحالة: ' + V.statusLabel(incident.status)));
    if (incident.type && presentation.category !== null) popup.appendChild(V.node('p', '', 'الوصف المسجل: ' + incident.type));
    popup.appendChild(V.node('p', '', incident.district || incident.street || 'الموقع النصي غير متاح'));
    var teams = V.node('div', 'rc-map-popup-teams');
    teams.appendChild(V.node('span', '', 'الفرق:'));
    teams.appendChild(V.teamList(incident.teamIdentities, incident.teams));
    popup.appendChild(teams);
    popup.appendChild(V.node('small', '', V.formatDate(incident.createdAt, true)));
    return popup;
  }
  function boundaryStyle(sectorId, selected) {
    return { color: sectorColor(sectorId), weight: selected ? 4 : 2, opacity: selected ? .98 : .58, fillColor: sectorColor(sectorId), fillOpacity: selected ? .16 : .035, dashArray: selected ? null : '7 6', lineJoin: 'round', className: selected ? 'rc-sector-boundary is-selected' : 'rc-sector-boundary' };
  }
  function validCoordinateTree(node) {
    if (!Array.isArray(node) || !node.length) return false;
    if (typeof node[0] === 'number' || typeof node[1] === 'number') {
      return node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1]) && Math.abs(node[0]) <= 180 && Math.abs(node[1]) <= 90;
    }
    return node.every(validCoordinateTree);
  }
  function sectorGeometry(data) {
    var boundary = data && data.sector && data.sector.boundary;
    var geometry = boundary && boundary.type === 'Feature' ? boundary.geometry : boundary;
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !validCoordinateTree(geometry.coordinates)) return null;
    return geometry;
  }
  function renderBoundaries() {
    state.layers.boundaries.clearLayers();
    state.boundaryLayers = new Map();
    state.sectorBounds = new Map();
    state.maps.forEach(function (data, sectorId) {
      var geometry = sectorGeometry(data);
      if (!geometry) return;
      var layer = L.geoJSON({ type: 'Feature', properties: { sectorId: sectorId }, geometry: geometry }, { style: boundaryStyle(sectorId, state.selectedId === sectorId) });
      layer.bindTooltip(data.sector.name, { sticky: true, className: 'rc-sector-tooltip' });
      layer.on('click', function () { selectSector(sectorId, true); });
      layer.addTo(state.layers.boundaries);
      var bounds = layer.getBounds();
      if (!bounds.isValid()) return;
      state.boundaryLayers.set(sectorId, layer);
      state.sectorBounds.set(sectorId, bounds);
    });
  }
  function highlightBoundaries() {
    state.boundaryLayers.forEach(function (layer, sectorId) {
      var selected = state.selectedId === sectorId;
      layer.setStyle(boundaryStyle(sectorId, selected));
      // setStyle يحدّث الرسم فقط؛ صنف SVG يحتاج تحديثًا مستقلًا للإبراز والاختبار.
      layer.eachLayer(function (path) {
        var element = path.getElement && path.getElement();
        if (element) element.classList.toggle('is-selected', selected);
      });
      if (selected) layer.bringToFront();
    });
  }
  function mapMotion() {
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function prepareMapMove() {
    // لا تسمح لحماية عرض الطي/تغيير الحجم بإعادة مركز قديم أثناء الانتقال المتعمد.
    if (state.map) state.map.stop();
    state.map._pendingFit = null;
    state.resizeView = null;
    clearTimeout(state.resizeViewTimer);
    if (state.invalidateFrame) cancelAnimationFrame(state.invalidateFrame);
    state.invalidateFrame = null;
    state.mapMoving = true;
    var version = ++state.mapMoveVersion;
    var finish = function () {
      if (version !== state.mapMoveVersion) return;
      var pending = state.map._pendingFit;
      state.map._pendingFit = null;
      if (pending) state.map.setView(pending.center, pending.zoom, { animate: false });
      state.mapMoving = false;
    };
    state.map.once('moveend', finish);
    clearTimeout(state.mapMoveTimer);
    state.mapMoveTimer = setTimeout(finish, 1200);
  }
  function showBoundaryNotice(missing) {
    if (!missing || !missing.length) { id('mapNotice').hidden = true; return; }
    id('mapNotice').textContent = 'لا توجد حدود جغرافية معتمدة لـ' + missing.join('، ') + '. تم استخدام الإحداثيات المسجلة فقط دون اختلاق مضلعات.';
    id('mapNotice').hidden = false;
  }
  function fitMapBounds(bounds, options) {
    prepareMapMove();
    var zoom = Math.min(options.maxZoom || 19, state.map.getBoundsZoom(bounds, false, options.padding));
    state.map._pendingFit = { center: bounds.getCenter(), zoom: zoom };
    state.map.fitBounds(bounds, options);
  }
  function fitSectorGeography(sectorId) {
    if (!state.map) return;
    if (state.sectorBounds.has(sectorId)) {
      fitMapBounds(state.sectorBounds.get(sectorId), { padding: [56, 56], maxZoom: 15, animate: mapMotion(), duration: .65 });
      showBoundaryNotice([]);
      return;
    }
    var points = state.points.filter(function (point) { return point.sectorId === sectorId; });
    fitPoints(points);
    var sector = state.overview.sectors.find(function (item) { return item.id === sectorId; });
    showBoundaryNotice([sector ? sector.name : sectorId]);
  }
  function fitAllSectors() {
    if (!state.map) return;
    var bounds = null;
    var missing = [];
    state.overview.sectors.forEach(function (sector) {
      if (state.sectorBounds.has(sector.id)) {
        var sectorBounds = state.sectorBounds.get(sector.id);
        if (!bounds) bounds = L.latLngBounds(sectorBounds.getSouthWest(), sectorBounds.getNorthEast());
        else bounds.extend(sectorBounds);
      } else missing.push(sector.name);
    });
    if (bounds) {
      state.points.filter(function (point) {
        return !state.sectorBounds.has(point.sectorId);
      }).forEach(function (point) { bounds.extend([point.lat, point.lng]); });
      fitMapBounds(bounds, { padding: [56, 56], maxZoom: 14, animate: mapMotion(), duration: .65 });
    } else fitPoints(state.points);
    showBoundaryNotice(missing);
  }
  function positioningPhaseLabel(phase) {
    return { planned: 'مخطط — لم يبدأ', en_route: 'جارٍ — لم يُسجل الوصول', arrived: 'وصل إلى التمركز' }[phase] || 'حالة التوقيت غير متاحة';
  }
  function positioningMarkerHtml(positioning) {
    return '<span class="rc-positioning-marker" data-phase="' + positioning.temporalStatus + '">' +
      '<svg viewBox="0 0 40 48" aria-hidden="true"><path class="rc-positioning-marker__pin" d="M20 2C10.6 2 3 9.6 3 19c0 12.4 17 27 17 27s17-14.6 17-27C37 9.6 29.4 2 20 2Z"></path>' +
      '<circle class="rc-positioning-marker__hub" cx="20" cy="19" r="10"></circle><path class="rc-positioning-marker__cross" d="M20 13v12M14 19h12"></path></svg></span>';
  }
  function popupForPositioning(positioning) {
    var popup = V.node('div', 'rc-map-popup rc-positioning-popup');
    popup.dataset.positioningId = positioning.id;
    popup.appendChild(V.node('strong', '', positioning.title || 'تمركز تشغيلي'));
    popup.appendChild(V.node('p', 'rc-positioning-popup-phase', positioningPhaseLabel(positioning.temporalStatus)));
    popup.appendChild(V.node('p', '', positioning.location || 'الموقع النصي غير متاح'));
    var teams = V.node('div', 'rc-map-popup-teams');
    teams.appendChild(V.node('span', '', 'الفرق المستهدفة:'));
    teams.appendChild(V.teamList(positioning.teamIdentities, positioning.teams));
    popup.appendChild(teams);
    popup.appendChild(V.node('p', '', 'البداية: ' + V.formatDate(positioning.startTime, true)));
    popup.appendChild(V.node('p', '', 'النهاية: ' + V.formatDate(positioning.endTime, true)));
    if (positioning.arrivalTime) popup.appendChild(V.node('p', '', 'تسجيل الوصول: ' + V.formatDate(positioning.arrivalTime, true)));
    popup.appendChild(V.node('small', 'rc-positioning-popup-note', 'إحداثيات التمركز المسجلة — ليست تتبعًا حيًا للفرقة.'));
    return popup;
  }
  function renderLayers() {
    if (!state.map || !state.layers) return;
    renderBoundaries();
    state.layers.centers.clearLayers();
    state.layers.incidents.clearLayers();
    state.layers.positionings.clearLayers();
    var heatPoints = [];
    state.points = [];
    state.maps.forEach(function (data, sectorId) {
      var color = sectorColor(sectorId);
      (data.centers || []).forEach(function (center) {
        if (center.coordinateStatus !== 'ok' || center.lat === null || center.lng === null) return;
        var icon = L.divIcon({ className: 'rc-marker-wrap', html: '<span class="rc-map-marker" style="--marker-color:' + color + '"></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
        var marker = L.marker([center.lat, center.lng], { icon: icon, keyboard: true, title: center.name }).addTo(state.layers.centers);
        var label = V.node('span', '', data.sector.name + ' · ' + center.name);
        marker.bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -12], className: 'rc-sector-tooltip' });
        marker.on('click', function () { selectSector(sectorId, false); });
        state.points.push({ sectorId: sectorId, lat: center.lat, lng: center.lng });
      });
      if (data.positionings && Array.isArray(data.positionings.items)) {
        data.positionings.items.forEach(function (positioning) {
          if (positioning.coordinateStatus !== 'ok' || positioning.lat === null || positioning.lng === null) return;
          var icon = L.divIcon({
            className: 'rc-marker-wrap rc-positioning-marker-wrap', html: positioningMarkerHtml(positioning),
            iconSize: [40, 48], iconAnchor: [20, 45], popupAnchor: [0, -42]
          });
          var marker = L.marker([positioning.lat, positioning.lng], {
            icon: icon, keyboard: true,
            title: 'تمركز ' + (positioning.title || positioning.id) + ' — ' + positioningPhaseLabel(positioning.temporalStatus),
            // إبقاء رمز + مقروءًا عند اشتراك التمركز والبلاغ في نقطة متقاربة.
            zIndexOffset: 600,
            positioningId: positioning.id
          }).addTo(state.layers.positionings);
          marker.bindPopup(popupForPositioning(positioning));
          marker.on('click', function () { selectSector(sectorId, false); });
          state.points.push({ sectorId: sectorId, lat: positioning.lat, lng: positioning.lng });
        });
      }
      if (data.incidents && Array.isArray(data.incidents.items)) {
        data.incidents.items.forEach(function (incident) {
          if (incident.status !== 'active' || incident.coordinateStatus !== 'ok' || incident.lat === null || incident.lng === null) return;
          // حلقة ProQA من كود CAD فقط؛ incident.severity التشغيلي يبقى مستقلًا ولا يحدد لونها.
          var presentation = window.ProQAIncidentIcons.resolve(incident.code);
          var icon = L.divIcon({
            className: 'rc-marker-wrap rc-proqa-marker-wrap',
            html: window.ProQAIncidentIcons.markerHtml(incident.code),
            iconSize: [42, 50], iconAnchor: [21, 48], popupAnchor: [0, -44]
          });
          var title = presentation.label + (incident.code ? ' · ' + incident.code : ' · التصنيف غير متاح');
          var marker = L.marker([incident.lat, incident.lng], { icon: icon, keyboard: true, title: 'بلاغ ' + incident.id + ' — ' + title }).addTo(state.layers.incidents);
          marker.bindPopup(popupForIncident(incident));
          marker.on('click', function () { selectSector(sectorId, false); });
          state.points.push({ sectorId: sectorId, lat: incident.lat, lng: incident.lng });
          heatPoints.push([incident.lat, incident.lng, 1]);
        });
      }
    });
    updateHeatPoints(heatPoints);
    if (!state.fitted && state.points.length) {
      fitPoints(state.points);
      state.fitted = true;
    }
    invalidateMapSize();
  }
  function fitPoints(points) {
    if (!state.map || !points || !points.length) {
      id('mapNotice').textContent = 'لا توجد إحداثيات متاحة لملاءمة العرض؛ لم يتم اختلاق موقع بديل.';
      id('mapNotice').hidden = false;
      return;
    }
    id('mapNotice').hidden = true;
    prepareMapMove();
    if (points.length === 1) state.map.setView([points[0].lat, points[0].lng], 14);
    else state.map.fitBounds(points.map(function (point) { return [point.lat, point.lng]; }), { padding: [70, 70], maxZoom: 14 });
  }
  async function selectSector(sectorId, focus) {
    state.selectedId = sectorId;
    var url = new URL(location.href);
    url.searchParams.set('sector', sectorId);
    history.replaceState(null, '', url.pathname + url.search);
    renderSectorStrip();
    highlightBoundaries();
    if (focus) fitSectorGeography(sectorId);
    await loadDetail(sectorId);
  }
  function showRegionalDetail() {
    state.detail = {
      sector: { id: null, name: 'جميع القطاعات', shift: null, status: state.overview.totals.status, metrics: state.overview.totals.metrics, teams: [], decisionCount: state.overview.totals.metrics.decisionCount },
      sourceMeta: state.overview.sourceMeta || []
    };
    renderDetail();
  }
  async function selectAllSectors(focus) {
    state.detailVersion += 1;
    state.selectedId = null;
    var url = new URL(location.href);
    url.searchParams.delete('sector');
    history.replaceState(null, '', url.pathname + url.search);
    renderSectorStrip();
    highlightBoundaries();
    showRegionalDetail();
    if (focus) fitAllSectors();
  }
  async function loadDetail(sectorId) {
    var version = ++state.detailVersion;
    id('mapDetailError').hidden = true;
    id('mapSectorName').textContent = 'جارٍ التحميل…';
    V.skeleton(id('mapDetailMetrics'), 4);
    try {
      var detail = await API.sector(sectorId);
      if (version !== state.detailVersion) return;
      state.detail = detail;
      renderDetail();
    } catch (error) {
      if (version !== state.detailVersion) return;
      state.detail = null;
      id('mapSectorName').textContent = 'تعذر عرض القطاع';
      id('mapSectorShift').textContent = '—';
      V.clear(id('mapDetailMetrics'));
      V.clear(id('mapTeamList'));
      V.clear(id('mapIncidentList'));
      V.clear(id('mapSourceList'));
      V.showError(id('mapDetailError'), error);
    }
  }
  function hasMetricValue(metric) {
    return !!metric && typeof metric.value === 'number' && Number.isFinite(metric.value);
  }
  function metricRatio(part, total) {
    if (!hasMetricValue(part) || !hasMetricValue(total) || total.value <= 0) return null;
    return Math.max(0, Math.min(1, part.value / total.value));
  }
  function pairText(part, total) {
    return hasMetricValue(part) && hasMetricValue(total) ? String(part.value) + ' / ' + String(total.value) : '—';
  }
  function analyticsHeading(title, meta) {
    var head = V.node('div', 'rc-analytics-heading');
    head.appendChild(V.node('h3', '', title));
    if (meta) head.appendChild(V.node('span', '', meta));
    return head;
  }
  function readinessOverview(metrics) {
    var section = V.node('section', 'rc-readiness-overview');
    section.dataset.state = metrics.readinessRate && metrics.readinessRate.status || 'unavailable';
    var gauge = V.node('div', 'rc-readiness-gauge');
    gauge.dataset.metric = 'readinessRate';
    gauge.setAttribute('role', 'img');
    gauge.setAttribute('aria-label', 'جاهزية الفرق: ' + V.metricText(metrics.readinessRate, 'readinessRate'));
    var readiness = hasMetricValue(metrics.readinessRate) ? Math.max(0, Math.min(100, metrics.readinessRate.value)) : 0;
    var ticks = '';
    for (var tick = 0; tick < 36; tick += 1) {
      var angle = (tick / 36 * 360 - 90) * Math.PI / 180;
      var active = tick / 36 * 100 < readiness;
      ticks += '<line class="' + (active ? 'rc-gauge-tick is-active' : 'rc-gauge-tick') + '" x1="' + (60 + Math.cos(angle) * 52) + '" y1="' + (60 + Math.sin(angle) * 52) + '" x2="' + (60 + Math.cos(angle) * 57) + '" y2="' + (60 + Math.sin(angle) * 57) + '"></line>';
    }
    gauge.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><g>' + ticks + '</g><circle class="rc-gauge-track" cx="60" cy="60" r="44" pathLength="100"></circle><circle class="rc-gauge-progress" cx="60" cy="60" r="44" pathLength="100"></circle></svg>';
    var progress = gauge.querySelector('.rc-gauge-progress');
    if (hasMetricValue(metrics.readinessRate)) progress.style.strokeDasharray = Math.max(0, Math.min(100, metrics.readinessRate.value)) + ' 100';
    else progress.style.strokeDasharray = '0 100';
    var gaugeValue = V.node('div', 'rc-gauge-value');
    gaugeValue.appendChild(V.node('strong', '', V.metricText(metrics.readinessRate, 'readinessRate'))).id = 'mapReadinessValue';
    gaugeValue.appendChild(V.node('span', '', 'جاهزية الفرق'));
    gauge.appendChild(gaugeValue);
    section.appendChild(gauge);
    var summary = V.node('div', 'rc-readiness-summary');
    summary.appendChild(V.node('span', 'rc-analytics-kicker', 'الصورة التشغيلية'));
    summary.appendChild(V.node('h3', '', 'اكتمال جاهزية الفرق'));
    summary.appendChild(V.node('strong', 'rc-readiness-fraction', pairText(metrics.teamsReady, metrics.teamsTotal))).id = 'mapReadinessDetail';
    summary.appendChild(V.node('small', '', 'الفرق المكتملة من إجمالي فرق القطاع'));
    var pending = V.node('span', 'rc-completion-chip');
    pending.dataset.state = hasMetricValue(metrics.teamsPending) && metrics.teamsPending.value > 0 ? 'attention' : 'neutral';
    pending.dataset.metric = 'teamsPending';
    pending.appendChild(V.node('i', ''));
    pending.appendChild(document.createTextNode('بانتظار التكميل: ' + V.metricText(metrics.teamsPending)));
    summary.appendChild(pending);
    section.appendChild(summary);
    return section;
  }
  function distributionRow(label, part, total, key) {
    var row = V.node('article', 'rc-force-row');
    row.dataset.metric = key;
    row.dataset.state = part && part.status || 'unavailable';
    var ratio = metricRatio(part, total);
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', label + ': ' + pairText(part, total));
    var instrument = V.node('div', 'rc-force-instrument');
    instrument.innerHTML = '<svg viewBox="0 0 140 82" aria-hidden="true"><path class="rc-force-arc-track" d="M18 68 A52 52 0 0 1 122 68" pathLength="100"></path><path class="rc-force-arc-value" d="M18 68 A52 52 0 0 1 122 68" pathLength="100"></path><circle class="rc-force-hub" cx="70" cy="68" r="3"></circle></svg>';
    var arc = instrument.querySelector('.rc-force-arc-value');
    arc.style.strokeDasharray = (ratio === null ? 0 : ratio * 100) + ' 100';
    var reading = V.node('div', 'rc-force-reading');
    reading.appendChild(V.node('strong', '', pairText(part, total)));
    reading.appendChild(V.node('span', '', label));
    instrument.appendChild(reading);
    row.appendChild(instrument);
    return row;
  }
  function forceDistribution(metrics) {
    var section = V.node('section', 'rc-force-distribution');
    section.appendChild(analyticsHeading('توزيع القوة التشغيلية', 'الحاضر / المطلوب والعامل / الإجمالي'));
    var instruments = V.node('div', 'rc-force-instruments');
    instruments.appendChild(distributionRow('الكادر الميداني', metrics.staffActive, metrics.staffRequired, 'staffActive'));
    instruments.appendChild(distributionRow('المركبات التشغيلية', metrics.vehiclesActive, metrics.vehiclesTotal, 'vehiclesActive'));
    section.appendChild(instruments);
    return section;
  }
  function teamDistribution(metrics) {
    var section = V.node('section', 'rc-team-distribution');
    section.appendChild(analyticsHeading('حالة الفرق', hasMetricValue(metrics.teamsTotal) ? metrics.teamsTotal.value + ' فرق' : 'الإجمالي غير متاح'));
    var layout = V.node('div', 'rc-team-orbit-layout');
    var constellation = V.node('div', 'rc-team-constellation');
    constellation.id = 'mapTeamDistribution';
    var legend = V.node('div', 'rc-team-legend');
    var definitions = [
      ['teamsReady', 'مكتملة', 'ready'], ['teamsMissing', 'ناقصة', 'missing'],
      ['teamsOffline', 'خارج الخدمة', 'offline'], ['teamsPending', 'بانتظار التكميل', 'pending']
    ];
    var dots = [];
    definitions.forEach(function (definition) {
      var metric = metrics[definition[0]];
      if (hasMetricValue(metric)) {
        for (var index = 0; index < metric.value; index += 1) dots.push({ label: definition[1], state: definition[2] });
      }
      var item = V.node('span', 'rc-team-legend-item');
      item.dataset.metric = definition[0];
      item.appendChild(V.node('i', 'rc-team-' + definition[2]));
      item.appendChild(document.createTextNode(definition[1]));
      item.appendChild(V.node('strong', '', V.metricText(metric)));
      legend.appendChild(item);
    });
    var visibleDots = dots.slice(0, 32);
    visibleDots.forEach(function (dot, index) {
      var angle = -Math.PI / 2 + index / Math.max(1, visibleDots.length) * Math.PI * 2;
      var radius = visibleDots.length > 12 && index % 2 ? 43 : 37;
      var point = V.node('span', 'rc-team-dot rc-team-' + dot.state);
      point.style.left = 50 + Math.cos(angle) * radius + '%';
      point.style.top = 50 + Math.sin(angle) * radius + '%';
      point.title = dot.label;
      constellation.appendChild(point);
    });
    var center = V.node('div', 'rc-team-orbit-center');
    center.appendChild(V.node('strong', '', hasMetricValue(metrics.teamsTotal) ? String(metrics.teamsTotal.value) : '—'));
    center.appendChild(V.node('span', '', 'فرق'));
    constellation.appendChild(center);
    constellation.setAttribute('role', 'img');
    constellation.setAttribute('aria-label', 'توزيع ' + (hasMetricValue(metrics.teamsTotal) ? metrics.teamsTotal.value : 'غير متاح') + ' فرق حسب الحالة');
    layout.appendChild(constellation);
    layout.appendChild(legend);
    if (dots.length > visibleDots.length) layout.appendChild(V.node('small', 'rc-team-more', '+' + (dots.length - visibleDots.length) + ' فرق أخرى موضحة عدديًا في الدليل'));
    section.appendChild(layout);
    return section;
  }
  function incidentSignal(metrics) {
    var section = V.node('section', 'rc-incident-signal');
    section.dataset.metric = 'incidentsActive';
    section.dataset.state = metrics.incidentsActive && metrics.incidentsActive.status || 'unavailable';
    var content = V.node('div', 'rc-incident-content');
    content.appendChild(analyticsHeading('نبض البلاغات', hasMetricValue(metrics.incidentsTotal) ? 'الإجمالي المسجل: ' + metrics.incidentsTotal.value : 'الإجمالي غير متاح'));
    var stage = V.node('div', 'rc-incident-stage');
    var reading = V.node('div', 'rc-incident-reading');
    reading.appendChild(V.node('strong', '', V.metricText(metrics.incidentsActive)));
    reading.appendChild(V.node('span', '', 'بلاغات نشطة'));
    stage.appendChild(reading);
    var dots = V.node('div', 'rc-incident-dots');
    dots.setAttribute('aria-hidden', 'true');
    var total = hasMetricValue(metrics.incidentsTotal) ? metrics.incidentsTotal.value : hasMetricValue(metrics.incidentsActive) ? metrics.incidentsActive.value : 0;
    var active = hasMetricValue(metrics.incidentsActive) ? metrics.incidentsActive.value : 0;
    var visible = Math.min(total, 40);
    for (var index = 0; index < visible; index += 1) dots.appendChild(V.node('i', index < active ? 'is-active' : 'is-inactive'));
    if (!visible) dots.appendChild(V.node('span', 'rc-incident-empty', '—'));
    stage.appendChild(dots);
    content.appendChild(stage);
    if (total > visible) content.appendChild(V.node('small', 'rc-incident-more', '+' + (total - visible) + ' بلاغات أخرى ضمن الإجمالي الفعلي'));
    section.appendChild(content);
    return section;
  }
  function renderAnalytics(metrics) {
    var container = V.clear(id('mapDetailMetrics'));
    container.setAttribute('aria-busy', 'false');
    container.appendChild(readinessOverview(metrics));
    container.appendChild(forceDistribution(metrics));
    container.appendChild(teamDistribution(metrics));
    container.appendChild(incidentSignal(metrics));
  }
  function responseMetric(label, value, note, metric, key) {
    var item = V.node('div', 'rc-response-item');
    if (key) item.dataset.metric = key;
    var copy = V.node('div', 'rc-response-copy');
    copy.appendChild(V.node('span', '', label));
    copy.appendChild(V.node('strong', '', value));
    copy.appendChild(V.node('small', '', note));
    item.appendChild(copy);
    if (metric) {
      var coverage = metric.coverage || {};
      var ratio = typeof coverage.expected === 'number' && coverage.expected > 0 && typeof coverage.available === 'number' ? Math.max(0, Math.min(1, coverage.available / coverage.expected)) : null;
      var instrument = V.node('div', 'rc-response-coverage');
      instrument.innerHTML = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="rc-response-track" cx="32" cy="32" r="26" pathLength="100"></circle><circle class="rc-response-value" cx="32" cy="32" r="26" pathLength="100"></circle></svg>';
      instrument.querySelector('.rc-response-value').style.strokeDasharray = (ratio === null ? 0 : ratio * 100) + ' 100';
      instrument.appendChild(V.node('small', '', ratio === null ? '—' : coverage.available + '/' + coverage.expected));
      instrument.title = 'اكتمال قياس زمن الوصول';
      item.appendChild(instrument);
    }
    return item;
  }
  function renderDetail() {
    var sector = state.detail.sector;
    id('mapSectorName').textContent = sector.name;
    id('mapSectorShift').textContent = sector.id === null ? 'النطاق الإقليمي الكامل' : sector.shift ? (sector.shift.name || 'المناوبة الحالية') + ' · ' + (sector.shift.type || '') : 'لا توجد مناوبة نشطة';
    V.clear(id('mapSectorStatus')).appendChild(V.statusBadge(sector.status));
    renderAnalytics(sector.metrics);
    var responses = V.clear(id('mapResponseMetrics'));
    responses.appendChild(responseMetric('زمن المباشرة', '—', 'غير متاح في مصدر البيانات الحالي'));
    responses.appendChild(responseMetric('متوسط الوصول', V.metricText(sector.metrics.avgResponseMinutes, 'avgResponseMinutes'), 'من بلاغات CAD المرتبطة بالقطاع', sector.metrics.avgResponseMinutes, 'avgResponseMinutes'));
    var reviewCount = sector.decisionCount && sector.decisionCount.value;
    var alert = id('mapOperationalAlert');
    alert.hidden = !(typeof reviewCount === 'number' && reviewCount > 0);
    if (!alert.hidden) {
      V.clear(alert);
      alert.appendChild(V.node('strong', '', reviewCount + ' عناصر تحتاج مراجعة'));
      alert.appendChild(V.node('p', '', 'عناصر needs_review المسجلة في مركز المتابعة لهذا القطاع.'));
      alert.appendChild(V.node('small', '', 'لا يمثل هذا العرض أولوية آلية أو درجة خطر جديدة.'));
    }
    renderTeamRows(sector.teams || []);
    renderIncidentRows();
    renderSources();
    setMapTab(state.activeTab);
  }
  function renderTeamRows(teams) {
    var container = V.clear(id('mapTeamList'));
    if (state.selectedId === null) teams = state.overview.sectors.flatMap(function (sector) {
      return (sector.teams || []).map(function (team) { return Object.assign({}, team, { center: sector.name + ' · ' + team.center }); });
    });
    teams.forEach(function (team) {
      var row = V.node('article', 'rc-map-row');
      var head = V.node('div', 'rc-map-row-head');
      head.appendChild(V.teamIdentity(team));
      head.appendChild(V.statusBadge(team.status));
      row.appendChild(head);
      row.appendChild(V.node('p', '', team.center + ' · الحاضر / المطلوب: ' + V.metricText(team.activeCount) + ' / ' + V.metricText(team.requiredPersonnel)));
      row.appendChild(V.node('small', '', 'الموقع الحي غير متاح'));
      container.appendChild(row);
    });
    if (!teams.length) V.empty(container, 'لا توجد فرق متاحة ضمن هذا القطاع.');
  }
  function selectedMapData() {
    if (state.selectedId) {
      var selected = state.maps.get(state.selectedId);
      return selected ? [selected] : [];
    }
    return Array.from(state.maps.values());
  }
  function renderIncidentRows() {
    var container = V.clear(id('mapIncidentList'));
    var mapData = selectedMapData();
    var incidents = mapData.flatMap(function (data) { return data.incidents ? data.incidents.items : []; });
    incidents.forEach(function (incident) {
      var presentation = window.ProQAIncidentIcons.resolve(incident.code);
      var row = V.node('article', 'rc-map-row');
      row.dataset.proqaCategory = presentation.category === null ? 'unknown' : String(presentation.category);
      row.dataset.proqaTone = presentation.tone;
      var head = V.node('div', 'rc-map-row-head');
      head.appendChild(V.node('strong', '', 'بلاغ ' + incident.id));
      head.appendChild(V.statusBadge(incident.status));
      row.appendChild(head);
      row.appendChild(V.node('p', '', (presentation.category === null ? (incident.type || presentation.label) : presentation.label) + ' · ' + (incident.district || incident.street || 'الحي غير متاح')));
      row.appendChild(V.node('p', 'rc-proqa-row-code', incident.code ? 'ProQA: ' + incident.code + ' · ' + presentation.priorityName : 'ProQA: التصنيف غير متاح'));
      row.appendChild(V.teamList(incident.teamIdentities, incident.teams));
      row.appendChild(V.node('small', '', incident.coordinateStatus === 'ok' ? 'موقع مسجل على الخريطة' : 'بلا إحداثيات — لا يُرسم'));
      container.appendChild(row);
    });
    var unavailable = mapData.some(function (data) { return data.incidents && data.incidents.status === 'unavailable'; });
    if (!incidents.length) V.empty(container, unavailable ? 'البلاغات غير متاحة من المصدر الحالي.' : 'لا توجد بلاغات مرتبطة بفرق القطاع.');
  }
  function renderSources() {
    var container = V.clear(id('mapSourceList'));
    var mapData = selectedMapData();
    var sources = (state.detail.sourceMeta || []).concat(mapData.flatMap(function (data) { return data.sourceMeta || []; }));
    sources.forEach(function (source) {
      var row = V.node('article', 'rc-map-row');
      var head = V.node('div', 'rc-map-row-head');
      head.appendChild(V.node('strong', '', source.ownerService));
      head.appendChild(V.statusBadge(source.status));
      row.appendChild(head);
      if (source.reasonCode) row.appendChild(V.node('p', '', V.reasonLabel(source.reasonCode)));
      container.appendChild(row);
    });
    if (!sources.length) V.empty(container, 'حالة المصادر غير متاحة.');
    var notes = V.clear(id('mapCenterNotes'));
    mapData.flatMap(function (data) { return data.centers || []; }).filter(function (center) { return center.coordinateStatus !== 'ok'; }).forEach(function (center) {
      notes.appendChild(V.node('p', '', center.name + ': ' + V.reasonLabel(center.reasonCode)));
    });
    mapData.flatMap(function (data) { return data.positionings ? data.positionings.items : []; }).filter(function (positioning) {
      return positioning.coordinateStatus !== 'ok';
    }).forEach(function (positioning) {
      notes.appendChild(V.node('p', '', 'تمركز ' + (positioning.title || positioning.id) + ': إحداثيات التمركز غير مسجلة؛ لم يُرسم موقع بديل.'));
    });
  }
  function setMapTab(tab) {
    state.activeTab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('[data-map-tab]'), function (button) { button.setAttribute('aria-selected', String(button.dataset.mapTab === tab)); });
    ['teams', 'incidents', 'sources'].forEach(function (name) { id('map' + name.charAt(0).toUpperCase() + name.slice(1) + 'Panel').hidden = name !== tab; });
  }
  async function refreshAll() {
    if (!state.context || !state.overview) return;
    try {
      await loadOverview();
      await loadMaps();
      var missingBoundaries = state.overview.sectors.filter(function (sector) {
        return (!state.selectedId || state.selectedId === sector.id) && !state.sectorBounds.has(sector.id);
      }).map(function (sector) { return sector.name; });
      showBoundaryNotice(missingBoundaries);
      if (state.selectedId) await loadDetail(state.selectedId);
      else showRegionalDetail();
      highlightBoundaries();
      renderSectorStrip();
      announce('تم تحديث الخريطة والبيانات التشغيلية دون إعادة تحميل الصفحة.');
    } catch (error) { V.showError(id('mapError'), error); }
  }
  function applyBrightness() {
    var value = Math.max(55, Math.min(125, Number(id('mapBrightness').value) || 100));
    document.documentElement.style.setProperty('--rc-map-brightness', String(value / 100));
    document.documentElement.style.setProperty('--rc-map-dark-brightness', String(value / 100 * .58));
    id('mapBrightnessValue').textContent = value + '٪';
    try { localStorage.setItem('regionCommandMapBrightness', String(value)); } catch (_) { /* تفضيل عرض فقط */ }
  }
  function setPanelCollapsed(collapsed) {
    state.panelCollapsed = collapsed;
    var workspace = document.querySelector('.rc-map-workspace');
    var panel = id('sectorPanel');
    var button = id('toggleSectorPanel');
    if (collapsed && panel.contains(document.activeElement)) button.focus();
    workspace.classList.toggle('rc-panel-collapsed', collapsed);
    panel.setAttribute('aria-hidden', String(collapsed));
    panel.inert = collapsed;
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? 'إظهار لوحة بيانات القطاع' : 'طي لوحة بيانات القطاع');
    button.title = collapsed ? 'إظهار لوحة القطاع' : 'طي لوحة القطاع';
    button.textContent = collapsed ? '⇥' : '⇤';
    invalidateMapSize();
    setTimeout(invalidateMapSize, 360);
    announce(collapsed ? 'طُويت لوحة القطاع وتمددت الخريطة.' : 'أُعيدت لوحة القطاع إلى موضعها.');
  }
  function bind() {
    id('fitMap').addEventListener('click', function () {
      if (state.selectedId) fitSectorGeography(state.selectedId);
      else fitAllSectors();
    });
    id('refreshMap').addEventListener('click', refreshAll);
    id('toggleSectorPanel').addEventListener('click', function () { setPanelCollapsed(!state.panelCollapsed); });
    id('toggleLayers').addEventListener('click', function () {
      var control = id('mapLayerControl');
      control.hidden = !control.hidden;
      id('toggleLayers').setAttribute('aria-expanded', String(!control.hidden));
    });
    var savedBrightness = null;
    try { savedBrightness = localStorage.getItem('regionCommandMapBrightness'); } catch (_) { /* تفضيل عرض فقط */ }
    if (savedBrightness !== null) id('mapBrightness').value = savedBrightness;
    id('mapBrightness').addEventListener('input', applyBrightness);
    applyBrightness();
    Array.prototype.forEach.call(document.querySelectorAll('[data-layer]'), function (input) {
      input.addEventListener('change', function () {
        if (!state.map || !state.layers) return;
        var layer = state.layers[input.dataset.layer];
        if (!layer) { input.checked = false; return; }
        if (input.checked) {
          layer.addTo(state.map);
          if (layer === state.layers.heat) layer.setLatLngs(state.heatPoints);
        } else removeOperationalLayer(layer);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-map-tab]'), function (button) { button.addEventListener('click', function () { setMapTab(button.dataset.mapTab); }); });
    document.addEventListener('region-theme-change', function () {
      setTiles();
      applyBrightness();
      invalidateMapSize();
    });
    window.addEventListener('resize', invalidateMapSize);
    window.addEventListener('beforeunload', function () {
      if (state.realtime) state.realtime.stop();
      if (state.resizeObserver) state.resizeObserver.disconnect();
      if (state.invalidateFrame) cancelAnimationFrame(state.invalidateFrame);
      clearTimeout(state.resizeViewTimer);
    });
  }
  async function init() {
    if (!window.AuthCore || !AuthCore.requireAuth('/')) return;
    API = window.RegionCommandAPI;
    V = window.RegionCommandViews;
    V.initTheme();
    bind();
    try {
      state.context = await API.context();
      await loadOverview();
      await loadMaps();
      id('mapLoading').hidden = true;
      var requested = new URLSearchParams(location.search).get('sector');
      var scopedSector = state.context.scopes.length === 1 && state.context.scopes[0].type === 'sector' ? state.context.scopes[0].id : null;
      var initial = requested || scopedSector || state.overview.sectors[0] && state.overview.sectors[0].id;
      if (initial) await selectSector(initial, true);
      else await selectAllSectors(true);
      state.realtime = new RegionCommandRealtime({ onChange: refreshAll, onStatus: updateConnection });
      state.realtime.start();
    } catch (error) {
      id('mapLoading').hidden = true;
      V.showError(id('mapError'), error);
      updateConnection('forbidden');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
