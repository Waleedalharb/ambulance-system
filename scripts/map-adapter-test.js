/**
 * ═══ map-adapter-test.js — اختبار طبقة الخريطة الموحدة (MapAdapter) ═══
 * (اعتماد المالك 2026-08-28 — «نقل العين فقط»)
 * يثبت في بيئة معزولة (vm — بلا متصفح وبلا شبكة):
 *  M1 الافتراضي leaflet بلا أي إعداد — السلوك القائم لا يتغير
 *  M2 تمرير Leaflet حرفي (نفس الكائنات والوسائط)
 *  M3 عند طلب mapbox وتوفر المكتبة ← المزود النشط mapbox
 *  M4 الفشل الآمن: mapbox مطلوب والمكتبة غائبة ← رجوع Leaflet تلقائيًا
 *  M5 علامات Mapbox: divIcon ← عنصر DOM بنفس className/html + zIndex + click
 *  M6 المجموعات: addTo/clearLayers تُركّب وتفك الأعضاء
 *  M7 الأشكال: دائرة (مضلّع بأمتار) + خط متقطع + نقطة — مصادر وطبقات صحيحة
 *  M8 الكثافة: heatmap بنفس النقاط + تدرج هوية المنصة + setLatLngs تحديث
 *  M9 تحديث علامة واحدة بلا إعادة بناء (setLatLng ← setLngLat فقط)
 *  M10 الأقفال البنيوية: ربط الوحدتين + عزل الذاكرة + الإصدارات + CSP
 *  M11 صفر مصادر بيانات في الطبقة: لا fetch/XHR/GPS/Traffic/Routing
 * التشغيل: node scripts/map-adapter-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const adapterSrc = read('public/js/map-adapter.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 160) : '')); }
}

// ---------- بيئة وهمية ----------
function makeEl() {
    return {
        className: '', innerHTML: '', style: {},
        __listeners: {}, __classes: [],
        addEventListener(ev, fn) { this.__listeners[ev] = fn; },
        classList: { add(c) { this.__owner.__classes.push(c); }, remove() { }, toggle() { } },
        closest() { return null; }
    };
}
function makeDocument() {
    const byId = {};
    return {
        createElement: () => { const el = makeEl(); el.classList.__owner = el; return el; },
        getElementById: (id) => { if (!byId[id]) { byId[id] = makeEl(); byId[id].classList.__owner = byId[id]; byId[id].__id = id; } return byId[id]; },
        __byId: byId
    };
}
function makeLeafletMock(calls) {
    const stub = (name) => function () { calls.push({ lib: 'L', fn: name, args: Array.from(arguments) }); return { __leafletObj: name, on() { return this; }, addTo() { return this; } }; };
    return {
        map: stub('map'), tileLayer: stub('tileLayer'), layerGroup: stub('layerGroup'),
        marker: stub('marker'), divIcon: stub('divIcon'), circle: stub('circle'),
        circleMarker: stub('circleMarker'), polyline: stub('polyline'), popup: stub('popup'),
        heatLayer: stub('heatLayer'), DomEvent: { stopPropagation(e) { e.__stopped = true; } }
    };
}
function makeMapboxMock(calls) {
    function Map(opts) {
        this.opts = opts;
        this.__handlers = {};
        this.sources = {}; this.layers = {};
        this.__styleLayers = Map.styleLayers || [];
        calls.push({ lib: 'mb', fn: 'Map', args: [opts] });
        this.scrollZoom = { enable() { calls.push({ lib: 'mb', fn: 'scrollZoom.enable' }); }, disable() { calls.push({ lib: 'mb', fn: 'scrollZoom.disable' }); } };
        this.dragRotate = { disable() { calls.push({ lib: 'mb', fn: 'dragRotate.disable' }); } };
        this.touchZoomRotate = { disableRotation() { calls.push({ lib: 'mb', fn: 'touchZoomRotate.disableRotation' }); } };
        this.keyboard = { enable() { } };
        this.doubleClickZoom = { enable() { } };
    }
    Map.prototype.on = function (ev, a, b) { this.__handlers[ev] = b || a; return this; };
    Map.prototype.addControl = function (ctrl, pos) { calls.push({ lib: 'mb', fn: 'addControl', args: [ctrl, pos] }); };
    Map.prototype.getStyle = function () { return { layers: this.__styleLayers }; };
    Map.prototype.setPaintProperty = function (id, k, v) { calls.push({ lib: 'mb', fn: 'setPaintProperty', args: [id, k, v] }); };
    Map.prototype.setLayoutProperty = function (id, k, v) { calls.push({ lib: 'mb', fn: 'setLayoutProperty', args: [id, k, v] }); };
    Map.prototype.jumpTo = function (o) { calls.push({ lib: 'mb', fn: 'jumpTo', args: [o] }); return this; };
    Map.prototype.fitBounds = function (b, o) { calls.push({ lib: 'mb', fn: 'fitBounds', args: [b, o] }); return this; };
    Map.prototype.resize = function () { calls.push({ lib: 'mb', fn: 'resize' }); };
    Map.prototype.getZoom = function () { return 12; };
    Map.prototype.panTo = function (c) { calls.push({ lib: 'mb', fn: 'panTo', args: [c] }); };
    Map.prototype.addSource = function (id, def) { this.sources[id] = def; def.setData = (d) => { def.__data = d; }; calls.push({ lib: 'mb', fn: 'addSource', args: [id, def] }); };
    Map.prototype.getSource = function (id) { return this.sources[id] || null; };
    Map.prototype.addLayer = function (l) { this.layers[l.id] = l; calls.push({ lib: 'mb', fn: 'addLayer', args: [l] }); };
    Map.prototype.getLayer = function (id) { return this.layers[id] || null; };
    Map.prototype.removeLayer = function (id) { delete this.layers[id]; };
    Map.prototype.removeSource = function (id) { delete this.sources[id]; };
    Map.prototype.getCanvas = function () { return { style: {} }; };
    function Marker(o) { this.o = o; calls.push({ lib: 'mb', fn: 'Marker', args: [o] }); }
    Marker.prototype.setLngLat = function (ll) { this.__ll = ll; calls.push({ lib: 'mb', fn: 'Marker.setLngLat', args: [ll] }); return this; };
    Marker.prototype.addTo = function () { calls.push({ lib: 'mb', fn: 'Marker.addTo' }); return this; };
    Marker.prototype.remove = function () { calls.push({ lib: 'mb', fn: 'Marker.remove' }); };
    function Popup(o) { this.o = o; calls.push({ lib: 'mb', fn: 'Popup', args: [o] }); }
    Popup.prototype.setLngLat = function (ll) { this.__ll = ll; return this; };
    Popup.prototype.setHTML = function (h) { this.__html = h; calls.push({ lib: 'mb', fn: 'Popup.setHTML', args: [h] }); return this; };
    Popup.prototype.addTo = function () { calls.push({ lib: 'mb', fn: 'Popup.addTo' }); return this; };
    function NavigationControl(o) { this.o = o; calls.push({ lib: 'mb', fn: 'NavigationControl', args: [o] }); }
    return { Map, Marker, Popup, NavigationControl, setRTLTextPlugin() { } };
}
function loadAdapter(cfg, withLeaflet, withMapbox) {
    const calls = [];
    const sandbox = {
        console,
        document: makeDocument(),
        SMAP_MAP_CONFIG: cfg
    };
    sandbox.window = sandbox;
    if (withLeaflet) sandbox.L = makeLeafletMock(calls);
    if (withMapbox) sandbox.mapboxgl = makeMapboxMock(calls);
    vm.createContext(sandbox);
    vm.runInContext(adapterSrc, sandbox);
    return { adapter: sandbox.MapAdapter, calls, sandbox };
}

console.log('\n— M1/M2: الافتراضي Leaflet وتمريره الحرفي —');
{
    const { adapter, calls } = loadAdapter(undefined, true, false);
    check('M1① بلا إعداد: المزود النشط leaflet', adapter.provider() === 'leaflet');
    const m = adapter.L.map('opsMap', { scrollWheelZoom: false });
    check('M2① L.map مُرّر بنفس الوسائط', calls.some(c => c.lib === 'L' && c.fn === 'map' && c.args[0] === 'opsMap'));
    check('M2② يعيد كائن Leaflet نفسه (لا غلاف يغيّر السلوك)', m && m.__leafletObj === 'map');
    adapter.L.divIcon({ className: 'x', html: '<b>y</b>' });
    check('M2③ divIcon مُرّر حرفيًا', calls.some(c => c.lib === 'L' && c.fn === 'divIcon' && c.args[0].className === 'x'));
    check('M1② __ready صادق عند توفر مزود', adapter.L.__ready() === true);
}

console.log('\n— M3: تفعيل Mapbox — التهيئة والعرض —');
{
    const { adapter, calls } = loadAdapter({ provider: 'mapbox' }, true, true);
    check('M3① المزود النشط mapbox عند طلبه وتوفره', adapter.provider() === 'mapbox');
    const fm = adapter.L.map('opsMap', { scrollWheelZoom: false });
    const mapCall = calls.find(c => c.fn === 'Map');
    check('M3② أنشئ mapboxgl.Map على الحاوية نفسها', mapCall && mapCall.args[0].container === 'opsMap');
    check('M3③ بلا مفتاح: النمط المؤقت المخفَّت (raster-saturation سالب)', mapCall && mapCall.args[0].style
        && mapCall.args[0].style.layers.some(l => l.paint && l.paint['raster-saturation'] < 0));
    check('M3④ التكبير الطبيعي دائم (اعتماد 2026-08-28 — يُلغي خيار الحظر القديم)', mapCall && mapCall.args[0].scrollZoom === true);
    fm.setView([24.71, 46.68], 13);
    check('M3⑤ setView ← jumpTo بتحويل [lat,lng]←[lng,lat]', calls.some(c => c.fn === 'jumpTo' && c.args[0].center[0] === 46.68 && c.args[0].center[1] === 24.71 && c.args[0].zoom === 13));
    fm.fitBounds([[24.7, 46.6], [24.8, 46.7]], { padding: [42, 42], maxZoom: 15 });
    const fb = calls.find(c => c.fn === 'fitBounds');
    check('M3⑥ fitBounds بالتحويل والحشو والحد الأقصى', fb && fb.args[0][0][0] === 46.6 && fb.args[1].padding === 42 && fb.args[1].maxZoom === 15);
    fm.scrollWheelZoom.enable();
    check('M3⑦ scrollWheelZoom.enable ← scrollZoom.enable', calls.some(c => c.fn === 'scrollZoom.enable'));
}

console.log('\n— M4: الفشل الآمن — mapbox مطلوب والمكتبة غائبة —');
{
    const { adapter } = loadAdapter({ provider: 'mapbox' }, true, false);
    check('M4① رجوع تلقائي إلى leaflet', adapter.provider() === 'leaflet');
    const none = loadAdapter({ provider: 'mapbox' }, false, false);
    check('M4② بلا أي مكتبة: __ready كاذب بصدق (لا اختراع خريطة)', none.adapter.L.__ready() === false);
}

console.log('\n— M5/M6: علامات Mapbox والمجموعات —');
{
    const { adapter, calls } = loadAdapter({ provider: 'mapbox' }, false, true);
    const fm = adapter.L.map('opsMap', {});
    const icon = adapter.L.divIcon({ className: 'smk-team sev-green', html: '<span>🚑</span>', iconAnchor: [17, 17] });
    const mk = adapter.L.marker([24.7, 46.7], { icon, zIndexOffset: 200 });
    const el = mk.getElement();
    check('M5① عنصر العلامة يحمل className وhtml نفسيهما', el.className === 'smk-team sev-green' && el.innerHTML === '<span>🚑</span>');
    check('M5② zIndexOffset مطبق على العنصر', el.style.zIndex === String(500 + 200));
    let clicked = null;
    mk.on('click', (e) => { clicked = e; });
    el.__listeners.click({ stopPropagation() { } });
    check('M5③ معالج الضغط يستلم originalEvent (توافق معالجات smart-map)', clicked && clicked.originalEvent);
    const grp = adapter.L.layerGroup();
    grp.addTo(fm);
    mk.addTo(grp);
    const mkCall = calls.find(c => c.fn === 'Marker');
    check('M5④ العلامة رُكّبت بإزاحة iconAnchor عبر offset', mkCall && mkCall.args[0].offset[0] === -17 && mkCall.args[0].offset[1] === -17);
    check('M5⑤ getLatLng يعيد الإحداثية الأصلية', mk.getLatLng().lat === 24.7 && mk.getLatLng().lng === 46.7);
    grp.clearLayers();
    check('M6① clearLayers تفك العلامة (Marker.remove)', calls.some(c => c.fn === 'Marker.remove'));
    // removeLayer الفردية — أساس الرسم التفاضلي (اعتماد 2026-08-28)
    const mk2 = adapter.L.marker([24.8, 46.8], { icon: adapter.L.divIcon({ html: 'y' }) });
    mk2.addTo(grp);
    const before2 = calls.filter(c => c.fn === 'Marker.remove').length;
    grp.removeLayer(mk2);
    check('M6② removeLayer تفك العضو وحده دون بقية المجموعة',
        calls.filter(c => c.fn === 'Marker.remove').length === before2 + 1 && grp.__members.length === 0);
}

console.log('\n— M7: الأشكال بعد جاهزية النمط —');
{
    const { adapter, calls } = loadAdapter({ provider: 'mapbox' }, false, true);
    const fm = adapter.L.map('opsMap', {});
    const grp = adapter.L.layerGroup().addTo(fm);
    adapter.L.circle([24.7, 46.7], { radius: 200, color: '#E8C84A', fillColor: '#E8C84A', fillOpacity: 0.1, weight: 1.5, opacity: 0.55 }).bindPopup('<b>ساخن</b>').addTo(grp);
    adapter.L.polyline([[24.7, 46.7], [24.8, 46.8]], { color: '#F59E0B', weight: 2, dashArray: '6 6', opacity: 0.8 }).addTo(grp);
    adapter.L.circleMarker([24.75, 46.75], { radius: 5, color: '#FBBF24', fillColor: '#F59E0B', fillOpacity: 0.65, weight: 1 }).addTo(grp);
    check('M7① لا مصادر قبل جاهزية النمط (طابور آمن)', !calls.some(c => c.fn === 'addSource'));
    fm.__inner.__handlers.load(); // محاكاة اكتمال تحميل النمط
    const poly = calls.find(c => c.fn === 'addSource' && c.args[1].data.geometry.type === 'Polygon');
    check('M7② الدائرة بالأمتار ← مضلّع GeoJSON مغلق (65 نقطة)', poly && poly.args[1].data.geometry.coordinates[0].length === 65);
    check('M7③ طبقتا تعبئة وحدود للدائرة بنفس الألوان', calls.some(c => c.fn === 'addLayer' && c.args[0].type === 'fill' && c.args[0].paint['fill-color'] === '#E8C84A')
        && calls.some(c => c.fn === 'addLayer' && c.args[0].type === 'line' && c.args[0].paint['line-color'] === '#E8C84A'));
    const dash = calls.find(c => c.fn === 'addLayer' && c.args[0].paint && c.args[0].paint['line-dasharray']);
    check('M7④ dashArray "6 6" ← [6,6]', dash && dash.args[0].paint['line-dasharray'][0] === 6 && dash.args[0].paint['line-dasharray'][1] === 6);
    check('M7⑤ circleMarker ← طبقة circle بنصف القطر والتعبئة', calls.some(c => c.fn === 'addLayer' && c.args[0].type === 'circle' && c.args[0].paint['circle-radius'] === 5));
}

console.log('\n— M8/M9: الكثافة وتحديث العلامة المفردة —');
{
    const { adapter, calls } = loadAdapter({ provider: 'mapbox' }, false, true);
    const fm = adapter.L.map('opsMap', {});
    const heat = adapter.L.heatLayer([[24.7, 46.7, 1]], { radius: 28, maxZoom: 16 });
    heat.addTo(fm);
    fm.__inner.__handlers.load();
    const hl = calls.find(c => c.fn === 'addLayer' && c.args[0].type === 'heatmap');
    check('M8① طبقة heatmap أُنشئت', !!hl);
    check('M8② تدرج الهوية: Teal ثم Gold ثم Red', hl && JSON.stringify(hl.args[0].paint['heatmap-color']).includes('#2E8B7A')
        && JSON.stringify(hl.args[0].paint['heatmap-color']).includes('#E8C84A'));
    heat.setLatLngs([[24.7, 46.7, 1], [24.8, 46.8, 1]]);
    const src = Object.values(fm.__inner.sources)[0];
    check('M8③ setLatLngs تحدّث المصدر بنفس النقاط والأوزان', src && src.__data && src.__data.features.length === 2 && src.__data.features[1].properties.weight === 1);
    const mk = adapter.L.marker([24.7, 46.7], { icon: adapter.L.divIcon({ html: 'x' }) }).addTo(fm);
    const before = calls.filter(c => c.fn === 'Marker').length;
    mk.setLatLng([24.9, 46.9]);
    check('M9① تحديث علامة واحدة: setLngLat فقط بلا إنشاء علامة جديدة',
        calls.some(c => c.fn === 'Marker.setLngLat' && c.args[0][0] === 46.9) && calls.filter(c => c.fn === 'Marker').length === before);
}

console.log('\n— M10: الأقفال البنيوية —');
{
    const smap = read('public/js/smart-map.js');
    const hist = read('public/js/map-history.js');
    const index = read('public/index.html');
    const sec = read('config/security.js');
    const cfgMain = read('public/js/map-config.js');
    const gitignore = read('.gitignore');
    check('M10① smart-map مربوط بالواجهة الموحدة', smap.includes('window.MapAdapter && window.MapAdapter.L'));
    check('M10② عقد الرسم التفاضلي (اعتماد 2026-08-28): بصمات __sig + syncMarkers + بوابة isFinalInc',
        smap.includes('syncMarkers') && smap.includes('__sig') && smap.includes('!isFinalInc(ic)'));
    check('M10③ map-history مربوط وما زال معزولًا عن الحية (لا SmartMap)',
        hist.includes('window.MapAdapter && window.MapAdapter.L') && !hist.includes('SmartMap'));
    check('M10④ تتبع الذاكرة باقٍ (dotsFrom/incidentCardHtml/zoneIncListHtml/openIncident)',
        hist.includes('function dotsFrom') && hist.includes('function incidentCardHtml') && hist.includes('function zoneIncListHtml') && hist.includes('MapHistory.openIncident'));
    check('M10⑤ index.html يحمّل mapbox + الإعداد + الـAdapter قبل smart-map',
        /mapbox-gl@2\.15\.0/.test(index) && /js\/map-config\.js/.test(index) && /js\/map-config\.local\.js/.test(index) && /js\/map-adapter\.js/.test(index)
        && index.indexOf('src="js/map-adapter.js') < index.indexOf('src="js/smart-map.js'));
    check('M10⑥ إصدارات الكاش محدثة (smart-map v=6 · map-history v=2)',
        /smart-map\.js\?v=6/.test(index) && /map-history\.js\?v=2/.test(index));
    check('M10⑦ CSP يسمح بنطاقات Mapbox وعمال blob', sec.includes('https://api.mapbox.com') && sec.includes('https://events.mapbox.com') && sec.includes('workerSrc'));
    // قفل سبب فشل الخلفية (لقطة المالك 2026-08-28): Mapbox GL يجلب البلاطات
    // النقطية عبر fetch داخل العمال ← connect-src وليس img-src
    check('M10⑩ CSP connect-src يسمح ببلاطات OSM للنمط المؤقت عبر Mapbox GL',
        /connectSrc:[^\]]*tile\.openstreetmap\.org/.test(sec));
    check('M10⑧ الإعداد المُدرج في Git بلا مفتاح وافتراضي leaflet',
        cfgMain.includes("provider: 'leaflet'") && !/pk\.eyJ/.test(cfgMain));
    check('M10⑨ ملف المفتاح المحلي مستثنى من Git', gitignore.includes('map-config.local.js'));
}

console.log('\n— M11: صفر مصادر بيانات / GPS / ازدحام في طبقة الرسم —');
{
    // فحص الشيفرة الفعلية فقط — التعليقات التوثيقية تُجرد أولًا
    const code = adapterSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    check('M11① لا fetch ولا XMLHttpRequest في الـAdapter', !/fetch\s*\(|XMLHttpRequest/.test(code));
    check('M11② لا geolocation ولا GPS', !/geolocation|watchPosition/i.test(code));
    check('M11③ لا Traffic ولا Routing', !/traffic|routing|directions/i.test(code));
    check('M11④ لا نطاق CAD في الـAdapter', !/cad-reports|cad-overlay|integration/i.test(code));
}

console.log('\n— N1: التفاعل الطبيعي الكامل (اعتماد المالك 2026-08-28) —');
{
    const { adapter, calls, sandbox } = loadAdapter({ provider: 'mapbox' }, false, true);
    const fm = adapter.L.map('opsMap', { scrollWheelZoom: false }); // حتى مع الطلب القديم
    const mapCall = calls.find(c => c.fn === 'Map');
    check('N1① العجلة/السحب/دبل-كليك/pinch مفعّلة دائمًا', mapCall
        && mapCall.args[0].scrollZoom === true && mapCall.args[0].dragPan === true
        && mapCall.args[0].doubleClickZoom === true && mapCall.args[0].touchZoomRotate === true);
    check('N1② الشمال ثابت: لا دوران بالسحب ولا باللمس ولا إمالة', mapCall
        && mapCall.args[0].dragRotate === false && mapCall.args[0].touchPitch === false
        && calls.some(c => c.fn === 'dragRotate.disable') && calls.some(c => c.fn === 'touchZoomRotate.disableRotation'));
    check('N1③ أزرار +/− دائمة أسفل اليسار بلا بوصلة (لا تغطية لبطاقة القرار — مراجعة UI 2026-08-28)', calls.some(c => c.fn === 'NavigationControl' && c.args[0].showCompass === false)
        && calls.some(c => c.fn === 'addControl' && c.args[1] === 'bottom-left'));
    fm.scrollWheelZoom.disable();
    check('N1④ تعطيل العجلة أصبح ممنوعًا كسره (لا scrollZoom.disable)', !calls.some(c => c.fn === 'scrollZoom.disable'));
    fm.scrollWheelZoom.enable();
    check('N1⑤ enable ما زال يفوّض للداخل', calls.some(c => c.fn === 'scrollZoom.enable'));
    check('N1⑥ الخريطة موسومة __keepViewport (Viewport المستخدم مقدَّس)', fm.__keepViewport === true);
    const smapSrc = read('public/js/smart-map.js');
    check('N1⑦ معالج resize في smart-map لا يعيد fitBounds فوق __keepViewport',
        /lastFit && lastFit\.length && !map\.__keepViewport/.test(smapSrc));
}

console.log('\n— N2: إثراء Light Operational فوق النمط الرسمي فقط —');
{
    const styleLayers = [
        { id: 'background' }, { id: 'water' }, { id: 'road-street' }, { id: 'road-street-case' },
        { id: 'road-label' }, { id: 'place-suburb-label' }, { id: 'poi-label' }, { id: 'admin-1-boundary' }, { id: 'building' }
    ];
    const { adapter, calls, sandbox } = loadAdapter({ provider: 'mapbox', accessToken: 'pk.test', style: 'mapbox://styles/mapbox/light-v11' }, false, true);
    sandbox.mapboxgl.Map.styleLayers = styleLayers;
    const fm = adapter.L.map('opsMap', {});
    fm.__inner.__handlers.load();
    check('N2① الخلفية رمادية مزرقة هادئة (#EDF1F6)', calls.some(c => c.fn === 'setPaintProperty' && c.args[0] === 'background' && c.args[1] === 'background-color' && c.args[2] === '#EDF1F6'));
    check('N2② جسم الطريق أبيض واضح والغلاف رمادي هادئ',
        calls.some(c => c.fn === 'setPaintProperty' && c.args[0] === 'road-street' && c.args[2] === '#FFFFFF')
        && calls.some(c => c.fn === 'setPaintProperty' && c.args[0] === 'road-street-case' && c.args[2] === '#BEC9D4'));
    check('N2③ أسماء الشوارع والأحياء مقروءة بحافة بيضاء',
        calls.some(c => c.fn === 'setPaintProperty' && c.args[0] === 'road-label' && c.args[1] === 'text-color' && c.args[2] === '#4E617A')
        && calls.some(c => c.fn === 'setPaintProperty' && c.args[0] === 'place-suburb-label' && c.args[1] === 'text-color' && c.args[2] === '#2F4359'));
    check('N2④ المعالم وحدود المناطق ظاهرة بلا صخب',
        calls.some(c => c.fn === 'setPaintProperty' && c.args[0] === 'poi-label' && c.args[2] === '#5E7186')
        && calls.some(c => c.fn === 'setPaintProperty' && c.args[0] === 'admin-1-boundary' && c.args[2] === '#9FAFC1'));
    const plain = loadAdapter({ provider: 'mapbox' }, false, true); // بلا مفتاح ← النمط المؤقت
    plain.adapter.L.map('opsMap', {}).__inner.__handlers.load();
    check('N2⑤ النمط المؤقت النقطي: صفر تعديل طبقات (لا شيء يُخترع)', !plain.calls.some(c => c.fn === 'setPaintProperty'));
}

console.log('\n— N3: ثيم Light Ops المشروط بالمزود (اعتماد المالك 2026-08-28) —');
{
    // ① Mapbox نشط ← حاوية الخريطة والقسم يُوسمان بـ smap-light-ops
    const mb = loadAdapter({ provider: 'mapbox', accessToken: 'pk.test' }, false, true);
    mb.adapter.L.map('opsMap', {});
    const opsEl = mb.sandbox.document.__byId['opsMap'];
    const secEl = mb.sandbox.document.__byId['opsMapSection'];
    check('N3① Mapbox: حاوية الخريطة تُوسم بـ smap-light-ops', opsEl && opsEl.__classes.includes('smap-light-ops'));
    check('N3② Mapbox: قسم الخريطة #opsMapSection يُوسم أيضًا (بطاقة/شريط/لوحة داخله)', secEl && secEl.__classes.includes('smap-light-ops'));
    // ② Leaflet (الإنتاج الحالي) ← لا وسم إطلاقًا: القواعد الداكنة تبقى وحدها
    const lf = loadAdapter(undefined, true, false);
    lf.adapter.L.map('opsMap', {});
    const lfEl = lf.sandbox.document.__byId['opsMap'];
    check('N3③ Leaflet: لا يُضاف الكلاس أصلًا (صفر مخاطرة على الإنتاج)', !lfEl || lfEl.__classes.length === 0);
    // ③ قسم CSS الفاتح موجود ويغطي كل العناصر الداكنة المشخصة
    const css = read('public/css/executive-theme.css');
    const need = [
        '.smap-light-ops .smk-team-name', '.smap-light-ops .smk-center-name',
        '.smap-light-ops .smap-card', '.smap-light-ops .smk-alertbar',
        '.smap-light-ops .smap-hist-dock', '.smap-light-ops .mapboxgl-popup-content',
        '.mapboxgl-popup-tip', '.smap-light-ops .mapboxgl-ctrl-group'
    ];
    check('N3④ CSS: كل عنصر داكن مشخص له نسخة فاتحة موسومة', need.every(s => css.includes(s)));
    // ④ القواعد الداكنة الأصلية باقية حرفيًا — الثيم إضافة صِرفة
    check('N3⑤ القواعد الداكنة القائمة لم تُعدَّل (أسماء/بطاقة/لوحة/شريط)',
        css.includes('.smk-team-name') && css.includes('color: #E2E8F0')
        && css.includes('background: rgba(11, 30, 51, 0.9)')
        && css.includes('background: rgba(11,18,32,.94)')
        && css.includes('background: rgba(11, 22, 38, 0.92)'));
    // ⑤ المعنى التشغيلي للألوان لم يُمس في القسم الفاتح (لا sev داخل النطاق الفاتح)
    const lightStart = css.indexOf('ثيم Light Ops لعناصر عرض الخريطة');
    const lightEnd = css.indexOf('ضبط تخطيط منطقة الخريطة'); // نهاية قسم الثيم — ما بعده قسم تخطيط مستقل
    const lightSection = css.slice(lightStart, lightEnd > lightStart ? lightEnd : undefined);
    check('N3⑥ القسم الفاتح لا يعيد تعريف ألوان الحالات sev-*', !/\.smap-light-ops[^{]*\.sev-/.test(lightSection));
    // ⑥ النسخ الفاتحة كلها موسومة — لا قاعدة فاتحة حرة تسرّب خارج النطاق
    check('N3⑦ الوسم شرط النطاق الوحيد (كل محددات القسم الفاتح تبدأ بـ .smap-light-ops أو #opsMap/#histMap)',
        lightSection.split('}').map(b => b.split('{')[0]).filter(s => s && s.trim() && !s.trim().startsWith('/*'))
            .every(s => s.includes('.smap-light-ops') || /^\s*@/.test(s)));
}

console.log('\n════════════════════════════════');
console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
process.exit(failed ? 1 : 0);
