'use strict';

/**
 * قبول طرفًا لطرف على خادم EMS الفعلي، لا خادم المعاينة:
 * حمولة CAD Overlay → ReportService/SQLite → قراءة قائد المنطقة → SSE → المتصفح.
 * كل الكتابات في نسخة SQLite وDATA_DIR مؤقتين داخل مجلد التشخيص، وتُحذف عند الانتهاء.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const TeamCode = require('../public/js/operational-team-code');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '..', 'diagnostics', 'cad-overlay-region-command-integration');
fs.mkdirSync(OUT, { recursive: true });
const RUN = fs.mkdtempSync(path.join(OUT, 'run-'));
const TMP_DB = path.join(RUN, 'ambulance.db');
const TMP_DATA = path.join(RUN, 'data');
const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = `isolated-cad-region-${Date.now()}`;
const results = [];
const serverLog = [];
let server = null;
let browser = null;
let cdp = null;
const sseClients = [];

fs.mkdirSync(TMP_DATA, { recursive: true });
function check(name, condition, details = null) {
  results.push({ name, pass: !!condition, details });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${details ? ' :: ' + JSON.stringify(details) : ''}`);
  assert.ok(condition, name);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(reader, timeout = 20000, label = 'condition') {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await reader(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(150);
  }
  throw new Error(`Timeout: ${label}; last=${JSON.stringify(last)}`);
}
async function api(pathname, { method = 'GET', token, key, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['X-Integration-Key'] = key;
  const response = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}
async function login(username, password) {
  const response = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  check(`تسجيل دخول حساب الاختبار ${username}`, response.status === 200 && !!response.data?.accessToken, { status: response.status });
  return response.data;
}
async function openSse(token, label) {
  const controller = new AbortController();
  const response = await fetch(BASE + '/api/sse', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  check(`فتح قناة SSE الفعلية: ${label}`, response.status === 200 && response.headers.get('content-type')?.includes('text/event-stream'));
  const client = { label, controller, events: [], buffer: '' };
  sseClients.push(client);
  (async () => {
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        client.buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = client.buffer.indexOf('\n\n')) !== -1) {
          const block = client.buffer.slice(0, boundary);
          client.buffer = client.buffer.slice(boundary + 2);
          const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (!data) continue;
          try { client.events.push(JSON.parse(data)); } catch (_) { /* heartbeat أو نص غير JSON */ }
        }
      }
    } catch (error) { if (!controller.signal.aborted) serverLog.push(`[SSE ${label}] ${error.message}`); }
  })();
  await waitFor(() => client.events.some(event => event.type === 'connected'), 10000, `SSE connected ${label}`);
  return client;
}
function regionEvents(client) { return client.events.filter(event => event.type === 'region_command_changed'); }
function cadPayload(number, teamNumber, shiftCode, suffix) {
  const code = `R-3-${shiftCode}-${teamNumber}`;
  return {
    number, code: '29B05U', type: 'traffic', source: 'cad-auto',
    createdAt: '15/11/2026 8:00:00 AM', address: 'طريق الاختبار، حي الشفا، الرياض، السعودية',
    lat: 24.540000 + suffix / 10000, lng: 46.720000 + suffix / 10000,
    crews: [{
      team: `جنوب ${teamNumber}`, operationalCode: code,
      phases: { 'قبول': '8:00:30 AM', 'التحرك': '8:01:00 AM', 'البحث': '8:08:00 AM' },
      phasesSource: 'cad-detail', cadUrs: 'A', cadReached: true,
      cadUnitId: 990000 + suffix, cadRunUnitId: 991000 + suffix
    }]
  };
}

async function prepareCopy() {
  const source = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
  source.exec(`VACUUM INTO '${TMP_DB.replace(/'/g, "''")}'`);
  source.close();
  const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
  const password = bcrypt.hashSync('isolated-region-test', 4);
  users.push(
    { id: 'test-region-leader', username: 'test-region-leader', password, name: 'قائد منطقة — اختبار معزول', role: 'admin', isActive: true },
    { id: 'test-other-sector', username: 'test-other-sector', password, name: 'قائد قطاع آخر — اختبار معزول', role: 'admin', isActive: true }
  );
  fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
  fs.writeFileSync(path.join(TMP_DATA, 'integration-keys.json'), JSON.stringify([{ key: KEY, scope: 'cad-reports', label: 'اختبار تكامل معزول', active: true, createdAt: new Date().toISOString() }]));

  const db = new Database(TMP_DB);
  db.exec(fs.readFileSync(path.join(ROOT, 'deploy', 'region-command-phase-1-schema.sql'), 'utf8'));
  let active = db.prepare("SELECT id, shift_type, shift_date FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
  const activeRosterCount = active ? db.prepare('SELECT COUNT(*) AS count FROM shift_roster WHERE shift_date = ?').get(active.shift_date).count : 0;
  if (active && activeRosterCount === 0) {
    const rosteredShift = db.prepare(`SELECT s.id, s.shift_type, s.shift_date FROM shifts s
      WHERE EXISTS (SELECT 1 FROM shift_roster sr WHERE sr.shift_date = s.shift_date)
      ORDER BY s.id DESC LIMIT 1`).get();
    if (rosteredShift) {
      db.prepare("UPDATE shifts SET status='pending_handover' WHERE status='active'").run();
      db.prepare("UPDATE shifts SET status='active' WHERE id=?").run(rosteredShift.id);
      active = rosteredShift;
    }
  }
  check('النسخة المعزولة تحتوي مناوبة EMS نشطة مرتبطة بجدول فعلي', !!active, active);
  const shiftCode = TeamCode.shiftCodeFromType(active.shift_type);
  check('نوع المناوبة الفعلي يقابل رمزًا تشغيليًا معتمدًا', !!shiftCode, { shiftType: active.shift_type, shiftCode });
  const teams = db.prepare('SELECT id, name, center FROM teams').all();
  const southCenters = [...new Set(teams.filter(team => TeamCode.identityFromTeamName(team.name, shiftCode)?.sectorCode === '3' && team.center).map(team => team.center))];
  check('مراكز الجنوب مشتقة من teams.center الفعلية', southCenters.length > 0, southCenters);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO regions(id, code, name, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run('TEST-R', 'R', 'منطقة الرياض — اختبار معزول', 'active', now, 'integration-test');
  const sector = db.prepare('INSERT INTO sectors(id, region_id, code, name, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
  sector.run('TEST-S3', 'TEST-R', '3', 'قطاع جنوب الرياض', 'active', now, 'integration-test');
  sector.run('TEST-S4', 'TEST-R', '4', 'قطاع غرب الرياض', 'active', now, 'integration-test');
  const link = db.prepare('INSERT INTO sector_centers(id, sector_id, center_id, effective_from, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)');
  for (const name of southCenters) {
    const center = db.prepare('SELECT id FROM centers WHERE name = ?').get(name);
    if (!center && name === 'الفرق الإضافية') {
      check('الفرق الإضافية تبقى غير جغرافية ولا تُنشأ لها centers وهمية', true, { skippedCenter: name });
      continue;
    }
    check(`مركز الجنوب موجود في centers: ${name}`, !!center);
    link.run(`TEST-S3-${center.id}`, 'TEST-S3', String(center.id), '2020-01-01T00:00:00.000Z', now, 'integration-test');
  }
  const otherCenter = db.prepare(`SELECT c.id, c.name FROM centers c WHERE c.name NOT IN (${southCenters.map(() => '?').join(',')}) ORDER BY c.id LIMIT 1`).get(...southCenters);
  if (otherCenter) link.run('TEST-S4-OTHER', 'TEST-S4', String(otherCenter.id), '2020-01-01T00:00:00.000Z', now, 'integration-test');
  else check('القطاع الآخر بلا مراكز فعلية في النسخة؛ يبقى نطاقًا فارغًا بلا بيانات مختلقة', true, { sectorId: 'TEST-S4', centers: 0 });
  const grant = db.prepare('INSERT INTO user_access_scopes(id, user_id, scope_type, scope_id, status, effective_from, granted_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  grant.run('TEST-GRANT-REGION', 'test-region-leader', 'region', 'TEST-R', 'active', '2020-01-01T00:00:00.000Z', now, 'اختبار معزول فقط');
  grant.run('TEST-GRANT-OTHER', 'test-other-sector', 'sector', 'TEST-S4', 'active', '2020-01-01T00:00:00.000Z', now, 'اختبار معزول فقط');
  db.close();
  return { active, shiftCode };
}
async function startServer() {
  const logStream = fs.createWriteStream(path.join(OUT, 'actual-server.log'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA,
      NODE_ENV: 'test', JWT_SECRET: 'isolated-region-command-test-secret',
      REGION_COMMAND_ENABLED: 'true', HOSPITAL_MONITOR_FILE: path.join(TMP_DATA, 'hospital-monitor.json'),
      PLACES_DATA_DIR: TMP_DATA
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const capture = chunk => { const text = String(chunk); serverLog.push(text); logStream.write(text); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
  await waitFor(async () => (await fetch(BASE + '/health').catch(() => null))?.ok, 45000, 'actual EMS health');
  check('خادم server.js الفعلي اشتغل على النسخة المعزولة', true, { port: PORT });
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.exceptions = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close() { if (this.ws) this.ws.close(); }
}
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
function chromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('لا يوجد Chrome/Edge محلي لاختبار الواجهة الفعلية');
  return found;
}
async function startBrowser(auth) {
  browser = spawn(chromePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9228', '--remote-allow-origins=*', `--user-data-dir=${path.join(RUN, 'chrome-profile')}`, '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const page = await waitFor(async () => {
    const pages = await fetch('http://127.0.0.1:9228/json/list').then(r => r.json()).catch(() => []);
    return pages.find(item => item.type === 'page');
  }, 15000, 'CDP');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token',${JSON.stringify(auth.accessToken)});localStorage.setItem('authToken',${JSON.stringify(auth.accessToken)});localStorage.setItem('auth_refresh_token',${JSON.stringify(auth.refreshToken)});}catch(_){}` });
  await cdp.send('Page.navigate', { url: BASE + '/region-command.html?sector=TEST-S3' });
  await waitFor(() => evaluate('document.readyState === "complete" && document.getElementById("connectionStatus")?.dataset.state === "connected"'), 25000, 'actual region page and SSE');
  check('صفحة قائد المنطقة الفعلية اتصلت بـSSE', true);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(4000)]);
}

(async () => {
  let auth;
  try {
    check('إصدار Node مطابق للمشروع', process.version === 'v22.23.5', process.version);
    const { shiftCode } = await prepareCopy();
    await startServer();
    auth = await login('test-region-leader', 'isolated-region-test');
    const otherAuth = await login('test-other-sector', 'isolated-region-test');
    await waitFor(async () => {
      const context = await api('/api/region-command/context', { token: auth.accessToken });
      const reports = await api('/api/cad-reports', { token: auth.accessToken });
      return context.status === 200 && reports.status === 200;
    }, 45000, 'region services ready');
    const context = await api('/api/region-command/context', { token: auth.accessToken });
    check('سياق قائد المنطقة يقرأ النطاق الفعلي المؤقت', context.data?.scopes?.some(scope => scope.type === 'region' && scope.id === 'TEST-R'), context.data);
    const otherContext = await api('/api/region-command/context', { token: otherAuth.accessToken });
    check('حساب القطاع الآخر مقيد بنطاقه فقط', otherContext.data?.scopes?.length === 1 && otherContext.data.scopes[0].id === 'TEST-S4', otherContext.data);
    check('قراءة الجنوب من نطاق غير مخول مرفوضة 403', (await api('/api/region-command/sectors/TEST-S3', { token: otherAuth.accessToken })).status === 403);

    const leaderSse = await openSse(auth.accessToken, 'قائد المنطقة');
    const otherSse = await openSse(otherAuth.accessToken, 'القطاع الآخر');
    const suffix = Number(String(Date.now()).slice(-5));
    const firstNumber = `88${String(suffix).padStart(6, '0')}`.slice(0, 12);
    const first = await api('/api/cad-reports', { method: 'POST', key: KEY, body: cadPayload(firstNumber, 1, shiftCode, 1) });
    check('حمولة Overlay الأولى سُجلت عبر POST /api/cad-reports', first.status === 200 && first.data?.created === true, first.data);
    const liveEvent = await waitFor(() => regionEvents(leaderSse).find(event => event.sectorId === 'TEST-S3' && event.entityType === 'incidents'), 15000, 'scoped incident SSE');
    check('SSE يحمل حدث region_command_changed لقطاع الجنوب', liveEvent.regionId === 'TEST-R' && !!liveEvent.eventId, liveEvent);
    await sleep(900);
    check('حدث الجنوب لم يصل إلى قناة القطاع الآخر', !regionEvents(otherSse).some(event => event.sectorId === 'TEST-S3'), regionEvents(otherSse));

    const detail = await waitFor(async () => {
      const response = await api('/api/region-command/sectors/TEST-S3', { token: auth.accessToken });
      return response.data?.sector?.incidents?.find(incident => incident.id === firstNumber) && response;
    }, 15000, 'incident in actual region read service');
    const incident = detail.data.sector.incidents.find(item => item.id === firstNumber);
    check('قراءة قائد المنطقة تعرض البلاغ من ReportService', detail.status === 200 && incident.teams?.includes('جنوب 1'), incident);
    check('الرمز والقطاع ورقم الفرقة والمناوبة مشتقة بصورة صحيحة', incident.teamIdentities?.[0]?.operationalCode === `R-3-${shiftCode}-1` && incident.teamIdentities[0].sectorName === 'قطاع جنوب الرياض' && incident.teamIdentities[0].teamNumber === '1', incident.teamIdentities);
    const map = await api('/api/region-command/sectors/TEST-S3/map', { token: auth.accessToken });
    const mapped = map.data?.incidents?.items?.find(item => item.id === firstNumber);
    check('الخريطة الفعلية تقرأ نفس البلاغ وإحداثياته', map.status === 200 && mapped?.coordinateStatus === 'ok' && mapped?.teamIdentities?.[0]?.operationalCode === `R-3-${shiftCode}-1`, mapped);

    const dbBefore = new Database(TMP_DB, { readonly: true });
    const before = dbBefore.prepare('SELECT t.id, r.unit, t.cad_unit_id, t.cad_run_unit_id FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=?').all(firstNumber);
    dbBefore.close();
    check('المشاركة محفوظة مرة واحدة بالمعرف الداخلي ومعرفات CAD', before.length === 1 && before[0].unit === 'جنوب 1', before);
    const duplicate = await api('/api/cad-reports', { method: 'POST', key: KEY, body: cadPayload(firstNumber, 1, shiftCode, 1) });
    const dbAfter = new Database(TMP_DB, { readonly: true });
    const after = dbAfter.prepare('SELECT t.id, r.unit, t.cad_unit_id, t.cad_run_unit_id FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=?').all(firstNumber);
    dbAfter.close();
    check('إعادة حمولة Overlay لا تنشئ مشاركة أو هوية مكررة', duplicate.status === 200 && duplicate.data?.created === false && after.length === 1 && after[0].id === before[0].id, duplicate.data);
    const refreshed = await api('/api/region-command/sectors/TEST-S3', { token: auth.accessToken });
    check('إعادة قراءة القطاع لا تكرر البلاغ', refreshed.data.sector.incidents.filter(item => item.id === firstNumber).length === 1);

    await startBrowser(auth);
    await waitFor(() => evaluate(`document.getElementById('incidentList').textContent.includes(${JSON.stringify(firstNumber)})`), 15000, 'first incident rendered');
    await evaluate('document.querySelector(\'[data-tab="incidents"]\').click(); window.__actualIntegrationMarker="no-reload"; true');
    const secondNumber = `89${String(suffix).padStart(6, '0')}`.slice(0, 12);
    const second = await api('/api/cad-reports', { method: 'POST', key: KEY, body: cadPayload(secondNumber, 2, shiftCode, 2) });
    check('بلاغ Overlay الثاني سُجل أثناء فتح الصفحة', second.status === 200 && second.data?.created === true, second.data);
    await waitFor(() => evaluate(`document.getElementById('incidentList').textContent.includes(${JSON.stringify(secondNumber)}) && document.getElementById('incidentList').textContent.includes(${JSON.stringify(`R-3-${shiftCode}-2`)})`), 20000, 'browser live update without refresh');
    check('الواجهة الفعلية تعرض البلاغ والرمز الجديد دون Refresh', await evaluate('window.__actualIntegrationMarker === "no-reload"'));
    check('البلاغ اللحظي ظاهر مرة واحدة في الجدول', await evaluate(`Array.from(document.querySelectorAll('#incidentList tbody tr')).filter(row=>row.textContent.includes(${JSON.stringify(secondNumber)})).length === 1`));
    check('لا استثناءات JavaScript في صفحة الربط الفعلية', cdp.exceptions.length === 0, cdp.exceptions.map(item => item.text));
    await evaluate(`(()=>{if(document.getElementById('evidenceDialog').open)document.getElementById('evidenceDialog').close();const row=Array.from(document.querySelectorAll('#incidentList tbody tr')).find(item=>item.textContent.includes(${JSON.stringify(secondNumber)}));if(row)row.scrollIntoView({block:'center'});return true;})()`);
    await sleep(250);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, 'actual-region-command-live.png'), Buffer.from(screenshot.data, 'base64'));
    results.browserScreenshot = 'actual-region-command-live.png';
  } catch (error) {
    results.push({ name: 'اكتمال الاختبار', pass: false, error: error.stack || String(error) });
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    for (const client of sseClients) client.controller.abort();
    await stopChild(browser);
    await stopChild(server);
    const report = {
      generatedAt: new Date().toISOString(), node: process.version,
      server: 'server.js', previewServerUsed: false, productionTouched: false,
      database: 'isolated-disposable-copy', pass: results.every(item => item.pass), results,
      serverErrors: serverLog.join('').split('\n').filter(line => /error|failed|❌|⚠️/i.test(line)).slice(-30)
    };
    fs.writeFileSync(path.join(OUT, 'integration-results.json'), JSON.stringify(report, null, 2));
    try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (_) { /* تنظيف لاحق عند تحرر Windows */ }
    console.log(`INTEGRATION_RESULT ${results.filter(item => item.pass).length}/${results.length}`);
  }
})();
