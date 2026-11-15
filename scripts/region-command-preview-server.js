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
const staffingService = { deriveTeamReadiness: async shiftId => {
  if (mode === 'unavailable') throw new Error('synthetic source outage');
  const teams = shiftId === 101 ? {
    'جنوب 1': { status: 'ready', center: 'مركز C1', activeCount: 2, requiredPersonnel: 2, lastDecision: { at: NOW } },
    'جنوب 2': { status: revision ? 'ready' : 'missing', center: 'مركز C2', activeCount: revision ? 2 : 1, requiredPersonnel: 2, lastDecision: { at: NOW } }
  } : {
    'فريق اختبار 3': { status: 'ready', center: 'مركز C3', activeCount: 3, requiredPersonnel: 3, lastDecision: { at: NOW } }
  };
  return { shiftId, teams, stale: mode === 'stale' };
} };
const vehicleService = { getState: async shiftId => {
  if (mode === 'unavailable') throw new Error('synthetic source outage');
  return { shiftId, stale: mode === 'stale', entities: shiftId === 101 ? [
    { entityId: 'V1', entityName: 'مركبة اختبار 1', center: 'مركز C1', open: [{ status: 'active', created_at: NOW }] },
    { entityId: 'V2', entityName: 'مركبة اختبار 2', center: 'مركز C2', open: [{ status: 'breakdown', created_at: NOW }] }
  ] : [{ entityId: 'V3', entityName: 'مركبة اختبار 3', center: 'مركز C3', open: [{ status: 'active', created_at: NOW }] }] };
} };
const reportService = { getIncidentSummary: async shiftId => {
  if (mode === 'unavailable') throw new Error('synthetic source outage');
  const incidents = shiftId === 101 ? [
    { number: 'TEST-I-1', type: 'إصابة اختبارية', status: 'active', severity: 'yellow', district: 'حي اختبار 1', createdAt: NOW, lat: 24.612, lng: 46.752, bestArrivalMin: 8, crews: [{ unit: 'جنوب 1', counted: true }] },
    { number: 'TEST-I-2', type: 'حالة اختبارية', status: 'closed', severity: 'green', district: 'حي اختبار 2', createdAt: NOW, lat: 24.62, lng: 46.76, bestArrivalMin: 12, crews: [{ unit: 'جنوب 2', counted: true }] },
    { number: 'TEST-I-NO-GEO', type: 'بلا إحداثيات', status: 'active', district: 'حي اختبار 3', createdAt: NOW, lat: null, lng: null, bestArrivalMin: 10, crews: [{ unit: 'جنوب 1', counted: true }] }
  ] : [{ number: 'TEST-I-3', type: 'حالة اختبارية', status: 'active', severity: 'red', district: 'حي اختبار 4', createdAt: NOW, lat: 24.63, lng: 46.77, bestArrivalMin: 9, crews: [{ unit: 'فريق اختبار 3', counted: true }] }];
  if (revision && shiftId === 101) incidents.push({ number: 'TEST-I-NEW', type: 'تحديث لحظي اختباري', status: 'active', severity: 'red', district: 'حي التحديث', createdAt: NOW, lat: 24.616, lng: 46.757, bestArrivalMin: 7, crews: [{ unit: 'جنوب 2', counted: true }] });
  return { shiftId, incidents, stale: mode === 'stale' };
} };
const centersGeoService = { getData: () => mode === 'geo-unavailable' ? null : ({
  centers: {
    'مركز C1': { center: [24.61, 46.75] }, 'مركز C2': { center: [24.62, 46.76] },
    'مركز C3': { center: [24.63, 46.77] }, 'مركز C4': { center: [24.64, 46.78] }
  }, nonGeographic: { 'مركز C5': 'مركز اختبار غير جغرافي' }
}) };
const readService = new RegionCommandReadService({
  scopeService, staffingService, vehicleService, reportService, centersGeoService,
  getActiveShift: async ({ sectorId }) => mode === 'empty' ? null : ({ id: sectorId === 'S1' ? 101 : 202, shift_name: 'مناوبة اختبار اصطناعية', shift_type: 'ليلية', shift_date: '2026-11-14' }),
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
