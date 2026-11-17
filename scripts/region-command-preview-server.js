'use strict';

// خادم معاينة/اختبار معزول: ذاكرة SQLite اصطناعية فقط، بلا ملفات بيانات أو اتصالات إنتاج.
const path = require('path');
const http = require('http');
const express = require('express');
const { createFixture, grant, NOW } = require('../tests/region-command/fixtures');
const RegionScopeService = require('../services/region-scope-service');
const RegionCommandReadService = require('../services/region-command-read-service');
const RegionDecisionCenterService = require('../services/region-decision-center-service');
const SectorCommandLedgerService = require('../services/sector-command-ledger-service');
const createRegionCommandRouter = require('../routes/region-command-routes');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const port = Number(argValue('--port', process.env.PORT || 7100));
const host = argValue('--host', process.env.HOST || '127.0.0.1');
const db = createFixture();
// خمسة قطاعات مستقلة داخل R1 للمعاينة فقط؛ لا يتغير fixture اختبارات الوحدة.
db.hdl.prepare("UPDATE regions SET name='منطقة الرياض' WHERE id='R1'").run();
db.hdl.prepare("UPDATE sectors SET code='R-3', name='قطاع جنوب الرياض' WHERE id='S1'").run();
db.hdl.prepare("UPDATE sectors SET code='R-2', name='قطاع شرق الرياض' WHERE id='S2'").run();
db.hdl.prepare("UPDATE sectors SET region_id='R1', code='R-1', name='قطاع وسط الرياض' WHERE id='S3'").run();
db.hdl.prepare("INSERT INTO centers(id,name) VALUES ('C6','مركز C6')").run();
db.hdl.prepare("INSERT INTO sectors(id,region_id,code,name,status,created_at) VALUES ('S4','R1','R-4','قطاع شمال الرياض','active',?),('S5','R1','R-5','قطاع غرب الرياض','active',?)").run(NOW, NOW);
db.hdl.prepare("INSERT INTO sector_centers(id,sector_id,center_id,effective_from,effective_to,created_at) VALUES ('SC5','S4','C5','2020-01-01T00:00:00.000Z',NULL,?),('SC6','S5','C6','2020-01-01T00:00:00.000Z',NULL,?)").run(NOW, NOW);
db.hdl.exec('CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL, center TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)');
const insertTeam = db.hdl.prepare('INSERT INTO teams(id, name, center, is_active) VALUES (?, ?, ?, 1)');
insertTeam.run(1, 'جنوب 1', 'مركز C1');
insertTeam.run(2, 'جنوب 2', 'مركز C2');
insertTeam.run(3, 'شرق 1', 'مركز C3');
insertTeam.run(4, 'وسط 1', 'مركز C4');
insertTeam.run(5, 'شمال 1', 'مركز C5');
insertTeam.run(6, 'غرب 1', 'مركز C6');
insertTeam.run(7, 'فريق خارج النطاق', 'مركز C7');
const accounts = {
  region: { id: 'region', role: 'director', name: 'قائد منطقة اختبار', permissions: new Set(['region.command.view', 'region.audit.view']) },
  sector: { id: 'sector', role: 'user', name: 'قائد قطاع اختبار', permissions: new Set(['region.command.view']) },
  forbidden: { id: 'forbidden', role: 'user', name: 'مستخدم اختبار', permissions: new Set() },
  'no-scope': { id: 'no-scope', role: 'user', name: 'بلا نطاق اختبار', permissions: new Set(['region.command.view']) },
  star: { id: 'star', role: 'admin', name: 'مدير بلا نطاق اختبار', permissions: new Set(['*']) }
};
grant(db, 'region', 'region', 'R1');
grant(db, 'sector', 'sector', 'S1');
const permissionService = {
  hasPermission: async (id, role, key) => {
    const account = accounts[id];
    return !!account && (account.permissions.has('*') || account.permissions.has(key));
  }
};
const scopeService = new RegionScopeService({ db, permissionService, now: () => NOW });
let mode = 'ok';
let revision = 0;
const shiftBySector = { S1: 101, S2: 202, S3: 303, S4: 404, S5: 505 };
const otherTeams = {
  202: { name: 'شرق 1', center: 'مركز C3', vehicleId: 'V3', activeCount: 3, requiredPersonnel: 3 },
  303: { name: 'وسط 1', center: 'مركز C4', vehicleId: 'V4', activeCount: 2, requiredPersonnel: 2 },
  404: { name: 'شمال 1', center: 'مركز C5', vehicleId: 'V5', activeCount: 2, requiredPersonnel: 2 },
  505: { name: 'غرب 1', center: 'مركز C6', vehicleId: 'V6', activeCount: 2, requiredPersonnel: 2 }
};
const staffingService = { deriveTeamReadiness: async shiftId => {
  if (mode === 'unavailable') throw new Error('synthetic source outage');
  let teams;
  if (Number(shiftId) === 101) teams = {
    'جنوب 1': { status: 'ready', center: 'مركز C1', activeCount: 2, requiredPersonnel: 2, vehicleId: 'V1', lastDecision: { at: NOW } },
    'جنوب 2': { status: revision ? 'ready' : 'missing', center: 'مركز C2', activeCount: revision ? 2 : 1, requiredPersonnel: 2, vehicleId: 'V2', lastDecision: { at: NOW } }
  };
  else {
    const item = otherTeams[shiftId];
    teams = { [item.name]: { status: 'ready', center: item.center, activeCount: item.activeCount, requiredPersonnel: item.requiredPersonnel, vehicleId: item.vehicleId, lastDecision: { at: NOW } } };
  }
  return { shiftId, teams, stale: mode === 'stale' };
} };
const vehicleService = {
  getBoard: async shiftId => {
    if (mode === 'unavailable') throw new Error('synthetic source outage');
    let vehicles;
    if (Number(shiftId) === 101) vehicles = [
      { id: 'V1', name: 'مركبة اختبار 1', status: 'active', since: NOW },
      { id: 'V2', name: 'مركبة اختبار 2', status: 'breakdown', since: NOW }
    ];
    else {
      const item = otherTeams[shiftId];
      vehicles = [{ id: item.vehicleId, name: 'مركبة ' + item.name, status: 'active', since: NOW }];
    }
    return { shiftId, vehicles, stale: mode === 'stale' };
  },
  getState: async () => { throw new Error('synthetic fixture requires the current vehicle board'); }
};
const reportService = {
  getIncidentSummary: async shiftId => {
    if (mode === 'unavailable') throw new Error('synthetic source outage');
    let incidents;
    if (Number(shiftId) === 101) incidents = [
      { number: 'TEST-I-1', type: 'إصابة اختبارية', status: 'active', severity: 'yellow', district: 'حي اختبار 1', createdAt: NOW, lat: 24.612, lng: 46.752, bestArrivalMin: 8, bestMubasharaMin: 5, crews: [{ unit: 'جنوب 1', counted: true, cadUrs: 'A' }] },
      { number: 'TEST-I-2', type: 'حالة اختبارية', status: 'closed', severity: 'green', district: 'حي اختبار 2', createdAt: NOW, lat: 24.62, lng: 46.76, bestArrivalMin: 12, bestMubasharaMin: 7, crews: [{ unit: 'جنوب 2', counted: true }] },
      { number: 'TEST-I-NO-GEO', type: 'بلا إحداثيات', status: 'active', district: 'حي اختبار 3', createdAt: NOW, lat: null, lng: null, bestArrivalMin: 10, bestMubasharaMin: null, crews: [{ unit: 'جنوب 1', counted: true, cadUrs: 'A' }] }
    ];
    else {
      const item = otherTeams[shiftId];
      incidents = [{ number: 'TEST-I-' + shiftId, type: 'حالة اختبارية', status: 'active', severity: 'red', district: 'حي ' + item.name, createdAt: NOW, lat: 24.63, lng: 46.77, bestArrivalMin: 9, bestMubasharaMin: 6, crews: [{ unit: item.name, counted: true }] }];
    }
    if (revision && Number(shiftId) === 101) incidents.push({ number: 'TEST-I-NEW', type: 'تحديث لحظي اختباري', status: 'active', severity: 'red', district: 'حي التحديث', createdAt: NOW, lat: 24.616, lng: 46.757, bestArrivalMin: 7, bestMubasharaMin: 4, crews: [{ unit: 'جنوب 2', counted: true, cadUrs: 'A' }] });
    return { shiftId, incidents, stale: mode === 'stale' };
  },
  getHistoricalSummary: async (from, to) => {
    if (mode === 'unavailable') throw new Error('synthetic source outage');
    const incidents = [
      { number: 'TEST-H-SHARED', shiftId: 'H1', occurredAt: '2026-11-13T21:30:00.000Z', bestArrivalMin: 8, bestMubasharaMin: 4, crews: [{ unit: 'جنوب 1', counted: true }, { unit: 'شرق 1', counted: true }] },
      { number: 'TEST-H-S1', shiftId: 'H2', occurredAt: '2026-11-12T10:00:00.000Z', bestArrivalMin: 10, bestMubasharaMin: 6, crews: [{ unit: 'جنوب 2', counted: true }] },
      { number: 'TEST-H-NO-TIME', shiftId: 'H3', occurredAt: '2026-11-11T09:00:00.000Z', bestArrivalMin: null, bestMubasharaMin: null, crews: [{ unit: 'جنوب 1', counted: true }] },
      { number: 'TEST-H-S2', shiftId: 'H4', occurredAt: '2026-11-10T12:00:00.000Z', bestArrivalMin: 12, bestMubasharaMin: 8, crews: [{ unit: 'شرق 1', counted: true }] },
      { number: 'TEST-H-S3', shiftId: 'H6', occurredAt: '2026-11-09T12:00:00.000Z', bestArrivalMin: 11, bestMubasharaMin: 7, crews: [{ unit: 'وسط 1', counted: true }] },
      { number: 'TEST-H-S4', shiftId: 'H7', occurredAt: '2026-11-08T12:00:00.000Z', bestArrivalMin: 13, bestMubasharaMin: 8, crews: [{ unit: 'شمال 1', counted: true }] },
      { number: 'TEST-H-S5', shiftId: 'H8', occurredAt: '2026-11-13T12:00:00.000Z', bestArrivalMin: 7, bestMubasharaMin: 5, crews: [{ unit: 'غرب 1', counted: true }] },
      { number: 'TEST-H-OUTSIDE', shiftId: 'H5', occurredAt: '2026-11-13T08:00:00.000Z', bestArrivalMin: 1, bestMubasharaMin: 1, crews: [{ unit: 'فريق خارج النطاق', counted: true }] }
    ];
    return {
      incidents: incidents.filter(incident => Date.parse(incident.occurredAt) >= from && Date.parse(incident.occurredAt) <= to),
      unresolvedTimeCount: 1,
      stale: mode === 'stale'
    };
  }
};
const centersGeoService = { getData: () => mode === 'geo-unavailable' ? null : ({
  centers: {
    'مركز C1': { center: [24.61, 46.75] }, 'مركز C2': { center: [24.62, 46.76] },
    'مركز C3': { center: [24.63, 46.77] }, 'مركز C4': { center: [24.64, 46.78] },
    'مركز C6': { center: [24.65, 46.79] }
  }, nonGeographic: { 'مركز C5': 'مركز اختبار غير جغرافي' }
}) };
const readService = new RegionCommandReadService({
  scopeService, staffingService, vehicleService, reportService, centersGeoService,
  getActiveShift: async ({ sectorId }) => mode === 'empty' ? null : ({ id: shiftBySector[sectorId], shift_name: 'مناوبة اختبار اصطناعية', shift_type: 'ليلية', shift_date: '2026-11-14' }),
  now: () => NOW
});
const decisionCenter = new RegionDecisionCenterService({ readService, scopeService });
const ledgerService = new SectorCommandLedgerService({ db, scopeService, now: () => NOW });
const services = { scopeService, readService, decisionCenter, ledgerService, permissionService };
function accountFromRequest(req) {
  const raw = req.headers.authorization || '';
  const queryToken = req.query && req.query.token;
  const id = raw.startsWith('Bearer ') ? raw.slice(7) : queryToken;
  return accounts[id] || null;
}
function authenticate(req, res, next) {
  const account = accountFromRequest(req);
  if (!account) return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', error: 'مطلوب تسجيل الدخول' });
  req.user = account;
  next();
}
function authorizePerm(key) {
  return async (req, res, next) => {
    if (!(await permissionService.hasPermission(req.user.id, req.user.role, key))) return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'الصلاحية غير متاحة' });
    next();
  };
}

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => { res.setHeader('X-Region-Command-Test-Fixture', 'synthetic-only'); next(); });
app.post('/api/auth/login', (req, res) => {
  const account = accounts[req.body && req.body.username];
  if (!account || req.body.password !== 'test-only') return res.status(401).json({ success: false, error: 'بيانات اختبار غير صالحة' });
  res.json({ success: true, accessToken: account.id, refreshToken: 'refresh-' + account.id, expiresIn: 3600, user: account });
});
app.post('/api/auth/refresh', (req, res) => {
  const id = String(req.body && req.body.refreshToken || '').replace(/^refresh-/, '');
  if (!accounts[id]) return res.status(401).json({ success: false });
  res.json({ success: true, accessToken: id, refreshToken: 'refresh-' + id, expiresIn: 3600 });
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({ success: true, user: req.user }));
app.use('/api/region-command', createRegionCommandRouter({ authenticate, authorizePerm, getServices: () => services, isEnabled: () => true }));
const sseClients = new Set();
app.get('/api/sse', authenticate, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': synthetic-test-stream\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
app.post('/__test/mode', (req, res) => {
  const allowed = ['ok', 'stale', 'unavailable', 'empty', 'geo-unavailable'];
  if (!allowed.includes(req.body && req.body.mode)) return res.status(400).json({ success: false });
  mode = req.body.mode;
  res.json({ success: true, mode });
});
app.post('/__test/emit', (req, res) => {
  revision += 1;
  const event = { eventId: 'test-event-' + revision, type: 'region_command_changed', regionId: 'R1', sectorId: 'S1', entityType: 'reports', occurredAt: new Date().toISOString(), changeVersion: String(revision) };
  sseClients.forEach(client => client.write('data: ' + JSON.stringify(event) + '\n\n'));
  res.json({ success: true, event });
});
app.use(express.static(path.join(__dirname, '../public'), { index: false }));
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>دخول معاينة مركز القيادة</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b14;color:#e5edf9;font:16px Arial,sans-serif}main{width:min(90vw,390px);padding:32px;border:1px solid #25334a;border-radius:20px;background:#101827;box-shadow:0 24px 70px #0008}h1{font-size:24px}p,small{color:#9aabc2;line-height:1.8}label{display:block;margin:20px 0 8px}select,input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:10px;border:1px solid #35445d;background:#0b1220;color:#fff;font:inherit}button{margin-top:20px;background:#168c72;border:0;cursor:pointer;font-weight:700}#error{color:#fda4af;min-height:28px}</style></head>
<body><main><h1>معاينة مركز قيادة المنطقة</h1><p>بيئة اختبار معزولة ببيانات اصطناعية فقط.</p>
<form id="login"><label for="username">حساب الاختبار</label><select id="username"><option value="region">قائد المنطقة</option><option value="sector">قائد القطاع S1</option><option value="forbidden">مستخدم بلا صلاحية</option><option value="no-scope">مستخدم بلا نطاق</option><option value="star">مدير بلا نطاق</option></select>
<label for="password">كلمة مرور الاختبار</label><input id="password" type="password" value="test-only" autocomplete="current-password" required><button type="submit">دخول المعاينة</button><p id="error" role="alert"></p></form><small>لا يستخدم هذا الخادم قاعدة الإنتاج أو حسابات الموظفين.</small></main>
<script src="/js/core/core-auth.js"></script><script>
document.getElementById('login').addEventListener('submit',async function(event){event.preventDefault();var error=document.getElementById('error');error.textContent='';try{var response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});var data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||'تعذر الدخول');AuthCore.setTokens(data.accessToken,data.refreshToken,data.expiresIn);location.href='/region-command.html';}catch(e){error.textContent=e.message;}});
</script></body></html>`);
});
const server = http.createServer(app);
server.listen(port, host, () => {
  const address = server.address();
  console.log(JSON.stringify({ ok: true, fixture: 'synthetic-only', url: `http://${host}:${address.port}`, users: Object.keys(accounts) }));
});
function shutdown() {
  sseClients.forEach(client => { try { client.end(); } catch (_) { /* closed */ } });
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
