// اختبار دخان حي لنقاط Hospital Monitor على خادم محلي مؤقت (يُقتل تلقائيًا)
// العزل (اعتماد المالك 2026-08-28): مخزن المستشفيات مؤقت عبر HOSPITAL_MONITOR_FILE —
// لا كتابة على data/hospital-monitor.json الحقيقي ولا بقايا رحلات بعد الاختبار.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3999;
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.resolve(__dirname, '..');
const TMP_STORE = path.join(os.tmpdir(), 'hm-smoke-' + Date.now() + '.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ✅ ' + n); } else { failed++; console.log('  ❌ ' + n + (x ? ' — ' + x : '')); } };

(async () => {
  const key = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'integration-keys.json'), 'utf8')) || [])
    .find(k => k.active && k.scope === 'cad-reports');
  if (!key) { console.error('لا مفتاح تكامل محلي نشط'); process.exit(1); }

  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOSPITAL_MONITOR_FILE: TMP_STORE }, stdio: 'ignore' });
  const kill = () => { try { srv.kill('SIGTERM'); } catch (_) { } try { fs.unlinkSync(TMP_STORE); } catch (_) { } };
  process.on('exit', kill);

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) }); if (r.status) { up = true; break; } } catch (_) { }
    await sleep(1000);
  }
  if (!up) { console.error('الخادم لم يقلع'); kill(); process.exit(1); }
  console.log('الخادم المحلي قام على :' + PORT + '\n');

  const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '4252', password: '4252' }) })).json();
  const tok = login.accessToken;
  check('دخول المشرف', !!tok);
  const auth = { Authorization: 'Bearer ' + tok };

  let r = await fetch(BASE + '/api/cad-reports/hospital-sighting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: '1319999', unitId: 1, hospitalName: 'X' }) });
  check('بلا مفتاح ← 401', r.status === 401);
  r = await fetch(BASE + '/api/cad-reports/hospital-sighting', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Integration-Key': 'wrong-key' }, body: JSON.stringify({ eventId: '1319999', unitId: 1, hospitalName: 'X' }) });
  check('مفتاح خاطئ ← 401', r.status === 401);

  const good = { 'Content-Type': 'application/json', 'X-Integration-Key': key.key };
  const post = (b) => fetch(BASE + '/api/cad-reports/hospital-sighting', { method: 'POST', headers: good, body: JSON.stringify(b) }).then(x => x.json().then(j => ({ s: x.status, j })));

  let p = await post({ eventId: '1319999', unitId: 1467, runUnitId: 2532116, unitCode: 'جنوب 9 - 2', southTeam: 'جنوب 9', hospitalName: 'مستشفى الدخان A', journeyStepCode: 'HANDOVER', observedAt: new Date().toISOString() });
  check('مشاهدة أولى صالحة ← created', p.s === 200 && p.j.success && p.j.kind === 'created', JSON.stringify(p.j));
  p = await post({ eventId: '1319999', unitId: 1467, runUnitId: 2532116, unitCode: 'جنوب 9 - 2', southTeam: 'جنوب 9', hospitalName: 'مستشفى الدخان A', journeyStepCode: 'HANDOVER' });
  check('نفس القيمة ← seen بلا تغيير', p.j.kind === 'seen' && p.j.changed === false);
  p = await post({ eventId: '1319999', unitId: 1467, runUnitId: 2532116, hospitalName: '  ', journeyStepCode: 'HANDOVER' });
  check('hospitalName فارغ ← 400 (null لا يمسح — يُرفض عند الحدود)', p.s === 400);
  p = await post({ eventId: '1319999', southTeam: 'جنوب 9', hospitalName: 'مستشفى بلا هوية' });
  check('بلا هوية ثابتة ← 400', p.s === 400);
  p = await post({ eventId: '1319999', unitId: 1467, runUnitId: 2532116, hospitalName: 'مستشفى بلا فلتر قطاع' });
  check('بلا southTeam ← 400 (فلتر القطاع دفاع سيرفري)', p.s === 400);
  p = await post({ eventId: '1319999', unitId: 1467, runUnitId: 2532116, unitCode: 'جنوب 9 - 1', southTeam: 'جنوب 9', hospitalName: 'مستشفى الدخان B' });
  check('تغيّر المنشأة A←B ← hospital-change', p.j.kind === 'hospital-change');

  // الفصل الدلالي: إغلاق الحالة الحالية عند العودة للخدمة
  p = await post({ eventId: '1319999', unitId: 1467, runUnitId: 2532116, unitCode: 'جنوب 9 - 1', southTeam: 'جنوب 9', episodeClose: true, journeyStepCode: 'BACK_TO_SERVICE' });
  check('عودة للخدمة ← episode-closed', p.s === 200 && p.j.kind === 'episode-closed' && p.j.changed === true, JSON.stringify(p.j));
  p = await post({ eventId: '1319999', unitId: 1467, runUnitId: 2532116, southTeam: 'جنوب 9', episodeClose: true, journeyStepCode: 'BACK_TO_SERVICE' });
  check('إغلاق مكرر ← already-closed', p.j.kind === 'already-closed' && p.j.changed === false);
  p = await post({ eventId: '1319888', unitId: 999, southTeam: 'جنوب 1', episodeClose: true, journeyStepCode: 'BACK_TO_SERVICE' });
  check('إغلاق بلا مشاهدة سابقة ← close-without-episode ولا حالة تُنشأ', p.j.kind === 'close-without-episode');

  const sum = await (await fetch(BASE + '/api/hospital-monitor/summary', { headers: auth })).json();
  const fac = (sum.facilities || []).find(f => f.facility === 'مستشفى الدخان B');
  check('الملخص يعرض المنشأة الحالية B (وليس A)', sum.success === true && !!fac && fac.cases >= 1, JSON.stringify(sum.facilities || []));
  check('الفصل في الملخص: الرحلة المغلقة ليست «في المستشفى الآن» (currentAtHospital=0)', sum.currentAtHospital === 0 && sum.lastKnownOnly >= 1,
    'current=' + sum.currentAtHospital + ' lastKnown=' + sum.lastKnownOnly);
  const his = await (await fetch(BASE + '/api/hospital-monitor/history?key=' + encodeURIComponent('1319999:2532116'), { headers: auth })).json();
  check('التدقيق: history يوثق الإنشاء والانتقال A←B والإغلاق', his.success && his.history.length >= 3 &&
    his.history.some(h => h.from === 'مستشفى الدخان A' && h.to === 'مستشفى الدخان B') &&
    his.history.some(h => h.field === 'episode' && h.to === 'last-known'));
  const noAuth = await fetch(BASE + '/api/hospital-monitor/summary');
  check('الملخص بلا جلسة ← 401', noAuth.status === 401);

  console.log('\nالنتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
  kill();
  await sleep(500);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
