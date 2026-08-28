/**
 * ═══ map-render-profile.js — قياس كلفة الرسم لكل تحديث بيانات (تشخيص فقط) ═══
 * (اعتماد المالك 2026-08-28 — «حدّد مصدر البطء قبل أي تعديل»)
 *
 * لا يغيّر أي شيء. يشغّل smart-map.js الفعلي في بيئة معزولة (vm) فوق
 * MapAdapter الحقيقي مع Mapbox مُحاكى مزوّدًا بعدّادات، ويغذّيه بحمولة
 * بواقعية المناوبة الحالية (من data/ambulance.db: عدد البلاغات الموقَّعة
 * + 14 فرقة + 9 مراكز)، ثم يعدّ بدقة ماذا يحدث عند:
 *  P1 تحديث بلاغات واحد (renderIncidents — مسار SSE للبلاغات)
 *  P2 تحديث قوى بشرية واحد (renderTeams — مسار SSE للفرق)
 *  P3 تحديثان متتاليان بنفس البيانات (هل يوجد عمل بلا تغيير؟)
 *
 * التشغيل: node scripts/map-render-profile.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------- عدّادات ----------
const counters = {
    markerCreate: 0, markerRemove: 0, domCreate: 0,
    addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, setData: 0,
    popupCreate: 0, setLngLat: 0
};
function reset() { Object.keys(counters).forEach(k => counters[k] = 0); }
function snap() { return Object.assign({}, counters); }

// ---------- بيئة DOM وهمية ----------
function makeEl() {
    const el = {
        className: '', innerHTML: '', textContent: '', style: {},
        __listeners: {},
        children: [],
        addEventListener(ev, fn) { this.__listeners[ev] = fn; },
        appendChild(c) { this.children.push(c); return c; },
        classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
        setAttribute() { }, getAttribute() { return null; },
        closest() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    return el;
}
const elById = {};
const documentStub = {
    createElement: () => { counters.domCreate++; return makeEl(); },
    getElementById: (id) => (elById[id] = elById[id] || makeEl()),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener() { }
};

// ---------- Mapbox مُحاكى مع عدّادات ----------
const mapsCreated = [];
function makeMapboxMock() {
    function Map() {
        this.__handlers = {};
        this.sources = {}; this.layers = {};
        this.scrollZoom = { enable() { }, disable() { } };
        this.dragRotate = { disable() { } };
        this.touchZoomRotate = { disableRotation() { } };
        this.keyboard = { enable() { } };
        this.doubleClickZoom = { enable() { } };
        mapsCreated.push(this);
    }
    Map.prototype.on = function (ev, a, b) { this.__handlers[ev] = b || a; return this; };
    Map.prototype.addControl = function () { };
    Map.prototype.getStyle = function () { return { layers: [] }; };
    Map.prototype.setPaintProperty = function () { };
    Map.prototype.setLayoutProperty = function () { };
    Map.prototype.jumpTo = function () { return this; };
    Map.prototype.fitBounds = function () { return this; };
    Map.prototype.resize = function () { };
    Map.prototype.getZoom = function () { return 12; };
    Map.prototype.panTo = function () { return this; };
    Map.prototype.addSource = function (id, def) { counters.addSource++; this.sources[id] = def; def.setData = () => counters.setData++; };
    Map.prototype.getSource = function (id) { return this.sources[id] || null; };
    Map.prototype.addLayer = function (l) { counters.addLayer++; this.layers[l.id] = l; };
    Map.prototype.getLayer = function (id) { return this.layers[id] || null; };
    Map.prototype.removeLayer = function (id) { counters.removeLayer++; delete this.layers[id]; };
    Map.prototype.removeSource = function (id) { counters.removeSource++; delete this.sources[id]; };
    Map.prototype.getCanvas = function () { return { style: {} }; };
    function Marker() { counters.markerCreate++; }
    Marker.prototype.setLngLat = function () { counters.setLngLat++; return this; };
    Marker.prototype.addTo = function () { return this; };
    Marker.prototype.remove = function () { counters.markerRemove++; };
    function Popup() { counters.popupCreate++; }
    Popup.prototype.setLngLat = function () { return this; };
    Popup.prototype.setHTML = function () { return this; };
    Popup.prototype.addTo = function () { return this; };
    function NavigationControl() { }
    return { Map, Marker, Popup, NavigationControl, setRTLTextPlugin() { } };
}

// ---------- حمولة واقعية من قاعدة البيانات (قراءة فقط) ----------
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const db = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
const posCount = db.prepare('SELECT COUNT(*) c FROM incident_registry WHERE lat IS NOT NULL AND lng IS NOT NULL').get().c;
const sampleCoords = db.prepare('SELECT lat, lng, street, district FROM incident_registry WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY id DESC LIMIT 60').all();
db.close();

const appJs = read('public/js/app.js');
function extractObject(src, varName) {
    const start = src.indexOf('var ' + varName + ' = {');
    const open = src.indexOf('{', start);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return vm.runInNewContext('(' + src.slice(open, end + 1) + ')', Object.create(null));
}
const operationalCenters = extractObject(appJs, 'operationalCenters');
const teamCenterMap = extractObject(appJs, 'teamCenterMap');
const teamNames = Object.keys(teamCenterMap);

function buildTeams() {
    const teams = {};
    teamNames.forEach((u, i) => {
        teams[u] = {
            status: i % 5 === 3 ? 'missing' : 'ready',
            vehicleOk: true, activeCount: 2, requiredPersonnel: 2, vacant: 0,
            members: [{ name: 'عضو ' + i, jobTitle: 'مسعف', state: 'حاضر' }],
            lastDecision: { at: '10:00', by: 'مشرف' }, vehicleId: 'veh_' + i, vehicleStatus: 'جاهزة'
        };
    });
    return teams;
}
function buildSummary() {
    const incidents = [];
    const n = Math.max(posCount, 40);
    for (let i = 0; i < n; i++) {
        const c = sampleCoords[i % sampleCoords.length] || { lat: 24.7, lng: 46.7, street: 'شارع ' + (i % 7), district: 'حي ' + (i % 5) };
        incidents.push({
            number: '99' + String(100000 + i), type: 'medical', code: '32B3',
            severity: i % 6 === 0 ? 'red' : (i % 3 === 0 ? 'yellow' : 'green'),
            status: 'active', lat: c.lat, lng: c.lng,
            address: 'عنوان ' + i, street: c.street || ('شارع ' + (i % 7)), district: c.district || ('حي ' + (i % 5)), city: 'الرياض',
            cadCreatedAt: '28/8/2026 10:00:00 AM',
            crews: [{ unit: teamNames[i % teamNames.length], phases: { 'التحرك': '10:05:00 AM' }, counted: true }],
            duplicates: i % 11 === 0 ? [{ candidate: { number: '99' + String(100000 + ((i + 1) % n)) }, level: 'medium', evidence: [{ label: 'نفس الشارع' }] }] : [],
            bestArrivalMin: 7, bestMubasharaMin: 4
        });
    }
    return {
        incidents,
        activeCount: n, total: n,
        mapStatus: {
            sectorStatus: 'green',
            peakHour: { hour: 10, count: 8 },
            topStreets: [{ name: 'شارع 1', count: 5 }, { name: 'شارع 2', count: 4 }],
            noLocation: []
        },
        responseTime: { arrival: { avg: 8, count: 20 } }
    };
}

// ---------- التحميل والتشغيل ----------
const sandbox = {
    console,
    document: documentStub,
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
    setInterval: () => 0, clearInterval() { },
    setTimeout: (fn) => 0, clearTimeout() { },
    ResizeObserver: function () { this.observe = () => { }; },
    operationalCenters, teamCenterMap,
    REPORT_TYPE_DEFS: undefined,
    SMAP_MAP_CONFIG: { provider: 'mapbox' }
};
sandbox.window = sandbox;
sandbox.mapboxgl = makeMapboxMock();
sandbox.AlertRules = require(path.join(ROOT, 'public', 'js', 'alert-rules.js'));
vm.createContext(sandbox);
vm.runInContext(read('public/js/map-adapter.js'), sandbox);
vm.runInContext(read('public/js/smart-map.js'), sandbox);

const SmartMap = sandbox.SmartMap;
const teams = buildTeams();
const summary = buildSummary();
const fmt = (s) => 'Markers(+' + s.markerCreate + '/−' + s.markerRemove + ') · DOM(+' + s.domCreate + ') · Sources(+' + s.addSource + '/−' + s.removeSource + ') · Layers(+' + s.addLayer + '/−' + s.removeLayer + ') · setData(' + s.setData + ')';

console.log('الحمولة: ' + summary.incidents.length + ' بلاغًا موقَّعًا (واقع المناوبة: ' + posCount + ') · ' + teamNames.length + ' فرقة · ' + Object.keys(operationalCenters).length + ' مراكز\n');

// الإقلاع الأول (تهيئة)
reset();
SmartMap.renderTeams(teams);
SmartMap.renderIncidents(summary);
const boot = snap();
console.log('P0 الإقلاع الأول (مرة واحدة):');
console.log('   ' + fmt(boot));

// إكمال تحميل النمط — تفريغ طابور الأشكال (دوائر/خطوط/كثافة) كما يحدث فعليًا
mapsCreated.forEach(m => { if (m.__handlers.load) m.__handlers.load(); });

// P1: تحديث بلاغات واحد عبر SSE
reset();
SmartMap.renderIncidents(summary);
const p1 = snap();
console.log('\nP1 تحديث بلاغات واحد (SSE) — بعد اكتمال تحميل النمط:');
console.log('   ' + fmt(p1));

// P2: تحديث قوى بشرية واحد
reset();
SmartMap.renderTeams(teams);
const p2 = snap();
console.log('\nP2 تحديث قوى بشرية واحد (SSE):');
console.log('   ' + fmt(p2));

// P3: تحديثان متتاليان بنفس البيانات حرفيًا — هل يوجد عمل بلا تغيير؟
reset();
SmartMap.renderIncidents(summary);
SmartMap.renderIncidents(summary);
SmartMap.renderTeams(teams);
SmartMap.renderTeams(teams);
const p3 = snap();
console.log('\nP3 أربعة تحديثات متتالية بنفس البيانات حرفيًا:');
console.log('   ' + fmt(p3));

console.log('\n═══ الخلاصة التشخيصية ═══');
console.log('كل تحديث SSE واحد للبلاغات = إعادة إنشاء ' + p1.markerCreate + ' علامة DOM من الصفر + إزالة ' + p1.markerRemove + ' علامة قديمة');
console.log('   + ' + (p1.addSource + p1.addLayer) + ' عملية إضافة مصدر/طبقة للنمط و' + (p1.removeLayer + p1.removeSource) + ' إزالة مقابلة (دوائر ساخنة + خطوط تكرار)');
console.log('كل تحديث SSE واحد للفرق = إعادة إنشاء ' + p2.markerCreate + ' علامة DOM من الصفر + إزالة ' + p2.markerRemove);
console.log('P3 يثبت: ' + (p3.markerCreate > 0 ? 'نفس البيانات بلا أي تغيير تُعيد إنشاء كل شيء (عمل ضائع 100%)' : 'لا عمل بلا تغيير'));

// ═══ سيناريوهات التغيير المفرد — إثبات الرسم التفاضلي (اعتماد 2026-08-28) ═══
// P4: تغيّرت خطورة بلاغ واحد فقط — يجب استبدال علامته وحدها
summary.incidents[5].severity = summary.incidents[5].severity === 'red' ? 'green' : 'red';
reset();
SmartMap.renderIncidents(summary);
const p4 = snap();
console.log('\nP4 تغيّر بلاغ واحد (خطورة) — المتوقع تفاضليًا: علامة واحدة فقط تُستبدل:');
console.log('   ' + fmt(p4));

// P5: اختفى بلاغ واحد (أُغلق) — يجب إزالة علامته وحدها بلا إنشاء
summary.incidents[7].status = 'closed';
reset();
SmartMap.renderIncidents(summary);
const p5 = snap();
console.log('\nP5 اختفاء بلاغ واحد — المتوقع تفاضليًا: إزالة واحدة وصفر إنشاء:');
console.log('   ' + fmt(p5));

// P6: تغيّرت حالة فرقة واحدة — يجب استبدال علامتها وحدها
const tKeys = Object.keys(teams);
teams[tKeys[2]].status = teams[tKeys[2]].status === 'missing' ? 'ready' : 'missing';
reset();
SmartMap.renderTeams(teams);
const p6 = snap();
console.log('\nP6 تغيّر فرقة واحدة (حالة) — المتوقع تفاضليًا: علامة الفرقة وربما مركزها فقط:');
console.log('   ' + fmt(p6));

// P7: تحديث مطابق تمامًا بعد كل ما سبق — يجب صفر عمليات
reset();
SmartMap.renderIncidents(summary);
SmartMap.renderTeams(teams);
const p7 = snap();
console.log('\nP7 تحديث مطابق بعد التغييرات — المتوقع: صفر عمليات رسم:');
console.log('   ' + fmt(p7));

const diffOk = p4.markerCreate === 1 && p4.markerRemove === 1
    && p5.markerCreate === 0 && p5.markerRemove === 1
    && p6.markerCreate <= 2 && p6.markerRemove <= 2
    && p7.markerCreate === 0 && p7.markerRemove === 0 && p7.addLayer === 0 && p7.removeLayer === 0;
console.log('\n' + (diffOk
    ? '✅ الرسم التفاضلي مثبت: المتغيّر وحده يُحدَّث، والمطابق = صفر عمليات'
    : '⚠️ الأرقام أعلى من المتوقع التفاضلي — راجع P4-P7 أعلاه'));
process.exit(0);
