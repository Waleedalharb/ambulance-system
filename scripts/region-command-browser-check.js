'use strict';

// فحص متصفح فعلي مستقل: Chrome Headless + CDP، دون اعتماديات إضافية.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(ROOT, '..');
const OUT = path.join(WORKSPACE, 'diagnostics', 'region-command-execution', 'browser');
const PROFILE = path.join(OUT, 'chrome-profile');
const NODE = process.execPath;
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const exceptions = [];
const consoleErrors = [];
const requests = [];
let browser;
let server;
let cdp;
let baseUrl;
let realtimeMs = null;

function check(name, condition, details) {
  results.push({ name, pass: !!condition, details: details === undefined ? null : details });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${details === undefined ? '' : ' :: ' + JSON.stringify(details)}`);
  if (!condition) throw new Error('Browser check failed: ' + name);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}
function chromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('No local Chrome/Edge executable found');
  return found;
}
async function startServer() {
  const port = await freePort();
  server = spawn(NODE, [path.join(ROOT, 'scripts', 'region-command-preview-server.js'), '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) {
        baseUrl = `http://127.0.0.1:${port}`;
        check('خادم المعاينة يقدم صفحة دخول اختبارية', (await response.text()).includes('بيانات اصطناعية'));
        return;
      }
    } catch (_) { /* لم يبدأ بعد */ }
    if (server.exitCode !== null) throw new Error('Preview server exited: ' + output);
    await sleep(100);
  }
  throw new Error('Preview server timeout: ' + output);
}
class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(arg => arg.value || arg.description).join(' '));
      if (message.method === 'Network.requestWillBeSent') requests.push({ url: message.params.request.url, at: Date.now() });
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request, resourceType } = message.params;
        let local = false;
        try { local = ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname); } catch (_) { /* غير HTTP */ }
        if (local) {
          this.send('Fetch.continueRequest', { requestId }).catch(error => exceptions.push({ text: error.message }));
          return;
        }
        this.externalRequests.push({ url: request.url, resourceType, fulfilledLocally: true });
        const image = resourceType === 'Image';
        this.send('Fetch.fulfillRequest', {
          requestId, responseCode: image ? 200 : 204,
          responseHeaders: image ? [{ name: 'Content-Type', value: 'image/png' }, { name: 'Cache-Control', value: 'no-store' }] : [],
          body: image ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' : undefined
        }).catch(error => exceptions.push({ text: error.message }));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { if (this.ws) this.ws.close(); }
}
async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception && response.exceptionDetails.exception.description || response.exceptionDetails.text);
  return response.result.value;
}
async function waitFor(expression, timeout, label) {
  const deadline = Date.now() + (timeout || 12000);
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(expression);
      if (last) return last;
    } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error('Timeout waiting for ' + (label || expression) + '; last=' + JSON.stringify(last));
}
async function navigate(url) {
  await cdp.send('Page.navigate', { url });
  await waitFor('document.readyState === "complete"', 15000, 'page load ' + url);
}
async function screenshot(name) {
  await sleep(250);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
}
async function viewport(width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: !!mobile, screenWidth: width, screenHeight: height });
}
async function post(pathname, body) {
  const response = await fetch(baseUrl + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(pathname + ' returned ' + response.status);
  return response.json();
}
async function login(account) {
  await navigate(baseUrl + '/');
  await evaluate(`localStorage.clear(); document.getElementById('username').value=${JSON.stringify(account)}; document.getElementById('login').requestSubmit(); true`);
  await waitFor('location.pathname === "/region-command.html" && document.readyState === "complete"', 15000, 'login ' + account);
}
async function click(selector) {
  const clicked = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true;})()`);
  check('عنصر قابل للنقر: ' + selector, clicked);
}
async function regionDashboard() {
  await login('region');
  await waitFor('document.querySelectorAll(".rc-sector-card").length === 2 && document.getElementById("regionMetrics").getAttribute("aria-busy") === "false"', 15000, 'region overview');
  await waitFor('document.getElementById("connectionStatus").dataset.state === "connected"', 10000, 'SSE connected');
  check('قائد المنطقة يرى قطاعي الاختبار', await evaluate('document.querySelectorAll(".rc-sector-card").length') === 2);
  check('لا يوجد خطأ عام عند التحميل', await evaluate('document.getElementById("globalError").hidden'));
  check('المؤشرات الستة ظاهرة', await evaluate('document.querySelectorAll("#regionMetrics .rc-metric-card").length') === 6);
  check('مؤشر الجاهزية مميز لآلية الاختبار والدليل', await evaluate('document.querySelectorAll("#regionMetrics [data-metric=readinessRate]").length') === 1);
  check('كل قطاع يعرض خمس قيم مقارنة مستقلة وفق R-01', await evaluate('Array.from(document.querySelectorAll(".rc-sector-card")).every(card=>card.querySelectorAll(".rc-sector-stat").length===5)'));
  check('عناصر المراجعة لا تتحول إلى عمود سادس في مقارنة القطاعات', await evaluate('!document.querySelector(".rc-sector-columns").textContent.includes("تحتاج مراجعة")'));
  check('شارة جودة المصدر تعرض الاكتمال الفعلي', await evaluate('document.getElementById("sectorCount").textContent.includes("جودة المصدر")'));
  check('الاتجاه الزمني غير مفعّل دون اختلاق سلسلة تاريخية', (await evaluate('document.querySelector(".rc-trend-placeholder").textContent')).includes('لا تتوفر سلسلة زمنية معتمدة'));
  check('لا يوجد تجاوز أفقي في لوحة سطح المكتب', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), await evaluate('({scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})'));
  await evaluate('document.getElementById("sourceDetails").open=true; true');
  check('سجل المصادر يفتح ويعرض قراءاته الفعلية', await evaluate('document.getElementById("sourceDetails").open && document.querySelectorAll("#sourceMetaList .rc-source-meta-row").length > 0 && document.getElementById("sourceMetaList").textContent.includes("وقت المصدر")'));
  await screenshot('01-region-dashboard-dark');
  await click('[data-action="theme"]');
  check('الوضع الفاتح للوحة القيادة يعمل', await evaluate('document.documentElement.dataset.theme === "light"'));
  await screenshot('01b-region-dashboard-light');
  await click('[data-action="theme"]');

  await evaluate('document.querySelector(".rc-sector-card .rc-button").click(); true');
  await waitFor('document.querySelectorAll("#teamList tbody tr").length === 2 && document.querySelectorAll("#detailDecisionList .rc-decision-entry").length === 2', 10000, 'sector teams and decisions');
  check('تفاصيل S1 تعرض فرقتين', await evaluate('document.querySelectorAll("#teamList tbody tr").length') === 2);
  check('رموز الفرق الليلية تظهر مع القطاع والمناوبة ورقم الفرقة في جدول الفرق', await evaluate(`(()=>{const text=document.getElementById('teamList').textContent;return text.includes('R-3-2-1')&&text.includes('R-3-2-2')&&text.includes('قطاع جنوب الرياض')&&text.includes('ليلية')&&text.includes('فرقة 1')&&text.includes('فرقة 2');})()`));
  check('تفاصيل S1 تعرض عنصري المراجعة من بيانات القطاع', await evaluate('document.querySelectorAll("#detailDecisionList .rc-decision-entry").length') === 2);
  check('R-02 يعرض صفحة القطاع المستقلة بدل إبقاء لوحة المقارنة', await evaluate('document.body.classList.contains("rc-detail-mode") && getComputedStyle(document.querySelector(".rc-dashboard-grid")).display === "none"'));
  await waitFor('document.getElementById("evidenceDialog").open && document.getElementById("evidenceBody").textContent.includes("الكيان")', 10000, 'automatic embedded evidence');
  check('الدليل مدمج داخل مساحة التفاصيل وليس نافذة modal', await evaluate('document.querySelector(".rc-detail-workspace").contains(document.getElementById("evidenceDialog")) && !document.getElementById("evidenceDialog").matches(":modal")'));
  check('عناصر مراجعة القطاع صفوف ملونة حسب الفئة الفعلية', await evaluate('document.querySelector("#detailDecisionList [data-category=staffing]") && document.querySelector("#detailDecisionList [data-category=vehicles]")'));
  await evaluate('document.getElementById("sectorDetail").scrollIntoView({block:"start"}); true');
  await screenshot('02-sector-detail-dark');
  await click('#detailMetrics .rc-metric-card');
  await waitFor('document.getElementById("evidenceDialog").open && document.querySelectorAll("#evidenceBody .rc-evidence-item").length >= 8', 10000, 'metric evidence');
  check('دليل المؤشر يعرض المصدر والتغطية', (await evaluate('document.getElementById("evidenceBody").textContent')).includes('المصدر المالك'));
  await click('#closeEvidence');
  await click('#detailDecisionList .rc-decision-item');
  await waitFor('document.getElementById("evidenceDialog").open && document.getElementById("evidenceBody").textContent.includes("الكيان")', 10000, 'detail decision evidence');
  check('دليل قرار القطاع يفتح من مركز متابعة التفاصيل', (await evaluate('document.getElementById("evidenceTitle").textContent')).includes('عنصر المراجعة'));
  await screenshot('02b-sector-decision-evidence');
  await click('#closeEvidence');
  await click('#decisionList .rc-decision-item');
  await waitFor('document.getElementById("evidenceDialog").open && document.getElementById("evidenceBody").textContent.includes("الكيان")', 10000, 'regional decision evidence');
  await click('#closeEvidence');
  await click('[data-tab="vehicles"]');
  check('تبويب المركبات يعرض مركبتين', await evaluate('document.querySelectorAll("#vehicleList tbody tr").length') === 2);
  await click('[data-tab="incidents"]');
  check('تبويب البلاغات يعرض ثلاثة بلاغات اصطناعية', await evaluate('document.querySelectorAll("#incidentList tbody tr").length') === 3);
  check('رموز الفرق تظهر في بلاغات مركز القيادة دون تغيير مفاتيح الربط', await evaluate(`(()=>{const text=document.getElementById('incidentList').textContent;return text.includes('R-3-2-1')&&text.includes('R-3-2-2')&&text.includes('قطاع جنوب الرياض')&&text.includes('ليلية');})()`));
  await click('[data-tab="ledger"]');
  await waitFor('!document.getElementById("ledgerPanel").hidden && !document.getElementById("ledgerList").querySelector(".rc-loading-grid")', 10000, 'ledger tab');
  check('تبويب السجل القيادي يعمل', await evaluate('document.getElementById("ledgerList").textContent.length > 0'));

  await click('[data-tab="incidents"]');
  await evaluate('window.__realtimeStarted=performance.now(); true');
  await post('/__test/emit');
  await waitFor('document.getElementById("incidentList").textContent.includes("TEST-I-NEW")', 15000, 'live incident');
  realtimeMs = await evaluate('performance.now()-window.__realtimeStarted');
  check('التحديث اللحظي يظهر دون Refresh', true, { milliseconds: Math.round(realtimeMs) });
  check('التحديث اللحظي لا يعيد ضبط تبويب البلاغات', await evaluate('document.querySelector("[data-tab=incidents]").getAttribute("aria-selected")==="true" && !document.getElementById("incidentsPanel").hidden'));
  check('البلاغ الجديد غير مكرر', await evaluate('Array.from(document.querySelectorAll("#incidentList tbody tr")).filter(row=>row.textContent.includes("TEST-I-NEW")).length') === 1);
  await click('#refreshButton');
  await sleep(1000);
  check('Refresh لا يكرر البلاغ الجديد', await evaluate('Array.from(document.querySelectorAll("#incidentList tbody tr")).filter(row=>row.textContent.includes("TEST-I-NEW")).length') === 1);
  const requestCount = requests.filter(item => item.url.includes('/api/region-command/overview')).length;
  await sleep(1800);
  check('لا يوجد polling دوري للملخص', requests.filter(item => item.url.includes('/api/region-command/overview')).length === requestCount);
  await screenshot('02c-sector-live-update');

  await navigate(baseUrl + '/region-map.html?sector=S1');
  if (await evaluate('typeof window.L === "object" && typeof window.L.map === "function"')) {
    await waitFor('document.querySelector("#regionMap").classList.contains("leaflet-container") && document.querySelectorAll(".rc-map-marker").length >= 4 && document.getElementById("mapSectorName").textContent.includes("قطاع اختبار 1")', 20000, 'map layers');
    check('الخريطة تعرض علامات من الإحداثيات الاصطناعية', await evaluate('document.querySelectorAll(".rc-map-marker").length >= 4'));
    check('لوحة فرق الخريطة تعرض الرمز والقطاع والمناوبة ورقم الفرقة', await evaluate(`(()=>{const text=document.getElementById('mapTeamList').textContent;return text.includes('R-3-2-1')&&text.includes('R-3-2-2')&&text.includes('قطاع جنوب الرياض')&&text.includes('ليلية')&&text.includes('فرقة 1');})()`));
    await click('[data-map-tab="incidents"]');
    check('بلاغات الخريطة تعرض رموز الفرق المرتبطة', await evaluate(`(()=>{const text=document.getElementById('mapIncidentList').textContent;return text.includes('R-3-2-1')&&text.includes('R-3-2-2')&&text.includes('قطاع جنوب الرياض');})()`));
    await click('[data-map-tab="teams"]');
    check('توزيع RTL يضع لوحة القطاع يمين الخريطة', await evaluate('(()=>{const map=document.querySelector(".rc-map-stage").getBoundingClientRect();const panel=document.querySelector(".rc-map-panel").getBoundingClientRect();return map.left < panel.left && getComputedStyle(document.querySelector(".rc-map-workspace > *")).direction === "rtl";})()'));
    check('لا تُرسم مضلعات للقطاعات', await evaluate('document.querySelectorAll("#regionMap path.leaflet-interactive").length') === 0);
    await waitFor('document.querySelectorAll("#regionMap .leaflet-tile-loaded").length >= 4', 20000, 'dark base tiles');
    check('خريطة الأساس لا تستخدم CARTO أو مفتاح API', requests.every(item => !item.url.includes('basemaps.cartocdn.com')));
    await evaluate('document.querySelector("[data-layer=heat]").click(); true');
    check('طبقة الكثافة الحرارية قابلة للتفعيل', await evaluate('document.querySelector("[data-layer=heat]").checked'));
    check('اللوحة التحليلية تعرض الجاهزية والقوة والمركبات وتوزيع الفرق', await evaluate('document.getElementById("mapReadinessValue").textContent.includes("50") && document.querySelectorAll("#mapDetailMetrics .rc-force-row").length === 2 && document.querySelectorAll("#mapDetailMetrics .rc-team-legend-item").length === 4 && !!document.getElementById("mapTeamDistribution")'));
    await evaluate(`window.__mapResizeChecks=[];
      const originalInvalidate=L.Map.prototype.invalidateSize;
      L.Map.prototype.invalidateSize=function(options){
        const before=this.getCenter(); const zoom=this.getZoom();
        const result=originalInvalidate.call(this,options);
        const after=this.getCenter();
        window.__mapResizeChecks.push({before:{lat:before.lat,lng:before.lng},after:{lat:after.lat,lng:after.lng},zoomBefore:zoom,zoomAfter:this.getZoom(),options});
        return result;
      }; true`);
    const expandedMapWidth = await evaluate('document.querySelector(".rc-map-stage").getBoundingClientRect().width');
    await click('#toggleSectorPanel');
    await waitFor(`document.querySelector(".rc-map-workspace").classList.contains("rc-panel-collapsed") && document.querySelector(".rc-map-stage").getBoundingClientRect().width > ${expandedMapWidth + 250} && window.__mapResizeChecks.length > 0`, 10000, 'collapsed map expansion');
    check('طي اللوحة يمدد الخريطة تلقائيًا', await evaluate('document.getElementById("toggleSectorPanel").getAttribute("aria-expanded") === "false" && document.getElementById("sectorPanel").inert'));
    check('الطي يحفظ مركز الخريطة وزومها والقطاع والطبقات', await evaluate(`(()=>{const checks=window.__mapResizeChecks;const last=checks[checks.length-1];return Math.abs(last.before.lat-last.after.lat)<1e-9 && Math.abs(last.before.lng-last.after.lng)<1e-9 && last.zoomBefore===last.zoomAfter && new URLSearchParams(location.search).get("sector")==="S1" && document.querySelector("[data-layer=heat]").checked && document.querySelector("[data-layer=centers]").checked;})()`));
    await screenshot('03b-region-map-collapsed');
    await click('#toggleSectorPanel');
    await waitFor(`!document.querySelector(".rc-map-workspace").classList.contains("rc-panel-collapsed") && Math.abs(document.querySelector(".rc-map-stage").getBoundingClientRect().width - ${expandedMapWidth}) < 3`, 10000, 'expanded map restoration');
    check('إعادة اللوحة تعيد الخريطة إلى حجمها السابق', await evaluate('document.getElementById("toggleSectorPanel").getAttribute("aria-expanded") === "true" && !document.getElementById("sectorPanel").inert'));
    await evaluate('document.querySelector("[data-layer=heat]").click();document.getElementById("liveAnnouncer").textContent="";document.getElementById("refreshMap").click();true');
    await waitFor('document.getElementById("liveAnnouncer").textContent.includes("تم تحديث الخريطة")', 10000, 'refresh with removed heat layer');
    await evaluate('document.querySelector("[data-layer=heat]").click();document.querySelector("[data-layer=heat]").click();document.getElementById("liveAnnouncer").textContent="";document.getElementById("refreshMap").click();true');
    await waitFor('document.getElementById("liveAnnouncer").textContent.includes("تم تحديث الخريطة")', 10000, 'second refresh with removed heat layer');
    check('تحديث البيانات بعد إزالة الكثافة لا يعيد خطأ _animating', await evaluate('!document.getElementById("mapError").textContent.includes("_animating") && document.querySelectorAll(".rc-map-marker").length >= 4'));
    await evaluate('document.querySelector("[data-layer=heat]").click();true');
    await screenshot('03-region-map-dark');
    await click('[data-action="theme"]');
    check('الوضع الفاتح يعمل', await evaluate('document.documentElement.dataset.theme === "light"'));
    await waitFor('document.querySelectorAll("#regionMap .leaflet-tile-loaded").length >= 4', 20000, 'light base tiles');
    await screenshot('04-region-map-light');
    await click('[data-map-tab="sources"]');
    check('تبويب حالة المصادر يعرض بيانات', await evaluate('document.getElementById("mapSourceList").textContent.length > 20'));
  } else {
    await waitFor('!document.getElementById("mapError").hidden && document.getElementById("mapError").textContent.includes("مكتبة الخرائط غير متاحة")', 10000, 'Leaflet unavailable fallback');
    check('غياب Leaflet الخارجي يظهر عذرًا صريحًا ولا يختلق خريطة', await evaluate('document.getElementById("mapError").textContent.includes("مكتبة الخرائط غير متاحة")'));
    check('غياب المكتبة لا يعرض علامات أو مواقع بديلة', await evaluate('document.querySelectorAll(".rc-map-marker").length === 0 && !document.querySelector("#regionMap").classList.contains("leaflet-container")'));
    check('توزيع RTL يضع لوحة القطاع يمينًا ومساحة الخريطة يسارًا', await evaluate('(()=>{const map=document.querySelector(".rc-map-stage").getBoundingClientRect();const panel=document.querySelector(".rc-map-panel").getBoundingClientRect();return map.left < panel.left && getComputedStyle(document.querySelector(".rc-map-workspace > *")).direction === "rtl";})()'));
    await screenshot('03-region-map-offline-unavailable');
    await click('[data-action="theme"]');
    check('الوضع الفاتح لواجهة الخريطة يعمل دون مكتبة خارجية', await evaluate('document.documentElement.dataset.theme === "light"'));
    await screenshot('04-region-map-light-offline');
    for (const name of ['الخريطة التفاعلية والعلامات', 'منع مضلعات القطاعات', 'بلاطات الأساس المحلية', 'الكثافة الحرارية', 'مصادر الخريطة التفاعلية']) {
      results.push({ name, skipped: true, reason: 'LEAFLET_VENDOR_ASSETS_NOT_AVAILABLE_LOCALLY' });
    }
  }

  await viewport(390, 844, true);
  await navigate(baseUrl + '/region-command.html');
  await waitFor('document.querySelectorAll(".rc-sector-card").length === 2 && document.getElementById("connectionStatus").dataset.state === "connected"', 15000, 'mobile dashboard');
  if (await evaluate('document.documentElement.dataset.theme !== "dark"')) await click('[data-action="theme"]');
  check('لا يوجد تجاوز أفقي على الجوال', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), await evaluate('({scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})'));
  await screenshot('05-region-dashboard-mobile');
  await viewport(1440, 1000, false);

  for (const mode of ['stale', 'unavailable', 'empty']) {
    await post('/__test/mode', { mode });
    await click('#refreshButton');
    await sleep(1200);
    if (mode === 'stale') {
      check('مؤشرات المصادر القديمة تحتفظ بالقيم مع وسم stale صريح', await evaluate('["staffActive","vehiclesActive","incidentsActive","avgResponseMinutes"].every(key=>{const e=document.querySelector(`#regionMetrics [data-metric="${key}"]`);return e && e.dataset.state==="stale" && e.querySelector(".rc-metric-state").textContent.includes("قديمة");})'), await evaluate('Array.from(document.querySelectorAll("#regionMetrics .rc-metric-card")).map(e=>({metric:e.dataset.metric,state:e.dataset.state,value:e.querySelector(".rc-metric-value").textContent}))'));
      check('حالة المصدر القديم موضحة في التنبيه وسجل المصادر', await evaluate('!document.getElementById("qualityBanner").hidden && document.getElementById("qualityBanner").textContent.includes("قديمة") && document.querySelectorAll("#sourceMetaList .rc-status[data-state=stale]").length > 0'));
    } else {
      check('حالة ' + mode + ' لا تعرض قيمًا تشغيلية بديلة', await evaluate('Array.from(document.querySelectorAll("#regionMetrics .rc-metric-value")).every(e=>e.textContent.trim()==="—")'));
    }
    if (mode === 'unavailable') check('تعطل المصدر يعلن نقص التغطية أو عدم التاحة', await evaluate('Array.from(document.querySelectorAll("#regionMetrics .rc-metric-card")).every(e=>["unavailable","unresolved","partial"].includes(e.dataset.state))'));
  }
  await post('/__test/mode', { mode: 'geo-unavailable' });
  await navigate(baseUrl + '/region-map.html?sector=S1');
  await waitFor('document.getElementById("mapSectorName").textContent.includes("قطاع اختبار 1")', 15000, 'geo unavailable detail');
  await click('[data-map-tab="sources"]');
  check('غياب مرجع الإحداثيات موثق دون مواقع بديلة', (await evaluate('document.getElementById("mapSourceList").textContent')).includes('CENTER_GEO_SOURCE_UNAVAILABLE') || (await evaluate('document.getElementById("mapSourceList").textContent')).includes('مرجع إحداثيات المراكز غير متاح'));
  check('لا علامات مراكز عند تعطل مرجع إحداثياتها', await evaluate('document.querySelectorAll(".rc-map-marker:not(.incident)").length') === 0);
  await post('/__test/mode', { mode: 'ok' });
}
async function scopedAccounts() {
  await login('sector');
  await waitFor('document.querySelectorAll(".rc-sector-card").length === 1 && document.querySelectorAll("#teamList tbody tr").length === 2', 15000, 'sector scoped account');
  check('قائد القطاع يهبط مباشرة على S1 فقط', await evaluate('location.search.includes("sector=S1") && document.querySelectorAll(".rc-sector-card").length === 1'));
  await navigate(baseUrl + '/region-command.html?sector=S2');
  await waitFor('!document.getElementById("detailError").hidden', 15000, 'forbidden deep link');
  check('الرابط خارج النطاق مرفوض صراحة', (await evaluate('document.getElementById("detailError").textContent')).includes('غير مصرح'));
  check('الرابط المرفوض لا يعرض بيانات S2', await evaluate('document.getElementById("detailContent").hidden && !document.getElementById("detailTitle").textContent.includes("S2")'));
  for (const account of ['forbidden', 'no-scope', 'star']) {
    await login(account);
    await waitFor('!document.getElementById("globalError").hidden', 15000, 'denied account ' + account);
    check('رفض صريح للحساب ' + account, (await evaluate('document.getElementById("globalError").textContent')).length > 5);
    check('لا تسريب بيانات تشغيلية للحساب ' + account, await evaluate('!document.body.textContent.includes("TEST-I-") && document.querySelectorAll(".rc-sector-card").length === 0'));
  }
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
}
async function main() {
  const debugPort = await freePort();
  await startServer();
  browser = spawn(chromePath(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors',
    '--remote-debugging-port=' + debugPort, '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE, '--window-size=1440,1000', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErrors = '';
  browser.stderr.on('data', chunk => { browserErrors += chunk.toString(); });
  let page;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !page) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      page = pages.find(item => item.type === 'page');
    } catch (_) { /* لم يبدأ بعد */ }
    if (!page) await sleep(150);
  }
  if (!page) throw new Error('CDP startup failed: ' + browserErrors.slice(-2000));
  cdp = new Cdp(page.webSocketDebuggerUrl);
  cdp.externalRequests = [];
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*/*', requestStage: 'Request' }, { urlPattern: 'https://*/*', requestStage: 'Request' }] });
  await viewport(1440, 1000, false);
  await regionDashboard();
  await scopedAccounts();
  check('كل طلب خارجي حُجب وعولج محليًا دون اتصال خارجي', cdp.externalRequests.length > 0 && cdp.externalRequests.every(item => item.fulfilledLocally), { intercepted: cdp.externalRequests.length });
  check('لا استثناءات JavaScript غير معالجة', exceptions.length === 0, exceptions.map(item => item.text));
  check('لا أخطاء Console من كود التطبيق', consoleErrors.length === 0, consoleErrors);
  const skipped = results.filter(item => item.skipped);
  const report = { generatedAt: new Date().toISOString(), node: process.version, baseUrl: 'isolated-ephemeral', pass: results.every(item => item.pass || item.skipped), results, skipped, realtimeMs, exceptions, consoleErrors, requestCount: requests.length, externalEgress: 0, externalRequestsIntercepted: cdp.externalRequests, syntheticBaseTile: cdp.externalRequests.some(item => item.resourceType === 'Image'), interactiveMapSkipped: skipped.some(item => item.reason === 'LEAFLET_VENDOR_ASSETS_NOT_AVAILABLE_LOCALLY') };
  fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(`BROWSER_RESULT ${results.filter(item => item.pass).length}/${results.length - skipped.length} skipped=${skipped.length} realtimeMs=${Math.round(realtimeMs)}`);
}
main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
  try { fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results, realtimeMs, exceptions, consoleErrors, failure: error.stack || String(error) }, null, 2)); } catch (_) { /* لا شيء */ }
}).finally(async () => {
  if (cdp) cdp.close();
  await stopChild(browser);
  await stopChild(server);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* قد يتأخر Windows قليلًا */ }
});
