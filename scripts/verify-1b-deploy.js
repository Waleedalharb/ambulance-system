// تحقق ما بعد النشر لـ1B على الإنتاج — قراءة فقط + اختبارا المسار المصرّح بهما
const crypto = require('crypto');
const BASE = 'https://emsoperations.online';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ✅ ' + n); } else { failed++; console.log('  ❌ ' + n + (x ? ' — ' + x : '')); } };

async function login() {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '4252', password: '4252' }) });
  const j = await r.json();
  if (!j.accessToken) throw new Error('فشل الدخول: ' + r.status);
  return j.accessToken;
}

(async () => {
  console.log('① انتظار النشر واكتمال إعادة التشغيل…');
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(8000) }); if (r.status === 200) { up = true; break; } } catch (_) { }
    await sleep(15000);
  }
  check('الخادم يستجيب (Health)', up);
  if (!up) process.exit(1);

  const tok = await login();
  const auth = { Authorization: 'Bearer ' + tok };

  // ② انتظر حتى تتحدث الحزمة الرسمية بختم .d (دليل أن الكود الجديد منشور فعلًا)
  console.log('② انتظار وصول الكود الجديد (ختم 2026-08-27.d في الحزمة الرسمية)…');
  let pkg = null, stampOk = false, tries = 0;
  const JSZip = require(process.cwd() + '/node_modules/jszip');
  for (; tries < 30; tries++) {
    try {
      const r = await fetch(BASE + '/api/cad-overlay/package', { headers: auth, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
        const content = await zip.file('cad-overlay-content.js').async('string');
        const bg = await zip.file('background.js').async('string');
        const bridge = await zip.file('bridge.js').async('string');
        stampOk = /2026-08-27\.d/.test(content);
        if (stampOk) {
          const km = bg.match(/INTEGRATION_KEY\s*=\s*"([^"]+)"/);
          pkg = {
            fp: km ? crypto.createHash('sha256').update(km[1]).digest('hex').slice(0, 12) : 'غير موجود',
            key: km ? km[1] : null,
            bridgeClose: bridge.includes('episodeClose'),
            bgClose: bg.includes('episodeClose'),
            probeBtn: content.includes('southProbeBtn'),
            southFilter: content.includes('southTeam')
          };
          break;
        }
      }
    } catch (_) { }
    await sleep(15000);
  }
  check('الحزمة الرسمية تحمل ختم 2026-08-27.d (الكود الجديد منشور)', stampOk, 'محاولات=' + tries);
  if (!pkg) { console.log('تعذر التحقق من الحزمة'); process.exit(1); }
  check('بصمة مفتاح الإنتاج في الحزمة الرسمية', pkg.fp === 'f3bb06c64f58', 'fp=' + pkg.fp);
  check('الجسر والخلفية يحملان episodeClose', pkg.bridgeClose && pkg.bgClose);
  check('فلتر القطاع southTeam في المحتوى', pkg.southFilter);

  // ③ مرجعية الاحتساب قبل اختبار المسار
  const before = await (await fetch(BASE + '/api/cad-reports', { headers: auth })).json();
  console.log('③ مرجعية /api/cad-reports قبل الاختبار: total=' + before.total + ' incidents=' + before.incidentsCount);

  // ④ اختبارا المسار المصرّح بهما (وسم صريح «اختبار نشر»)
  const good = { 'Content-Type': 'application/json', 'X-Integration-Key': pkg.key };
  const post = (b) => fetch(BASE + '/api/cad-reports/hospital-sighting', { method: 'POST', headers: good, body: JSON.stringify(b) }).then(x => x.json().then(j => ({ s: x.status, j })));
  const TEST_EV = '9999999';
  let p = await post({ eventId: TEST_EV, unitId: 900001, runUnitId: 9900001, unitCode: 'اختبار نشر', southTeam: 'اختبار نشر 1B', hospitalName: 'منشأة تحقق النشر — تُغلق فورًا', journeyStepCode: 'HANDOVER' });
  check('وصول hospital-sighting للإنتاج ← created', p.s === 200 && p.j.success === true && p.j.kind === 'created', JSON.stringify(p.j));
  p = await post({ eventId: TEST_EV, unitId: 900001, runUnitId: 9900001, unitCode: 'اختبار نشر', southTeam: 'اختبار نشر 1B', episodeClose: true, journeyStepCode: 'BACK_TO_SERVICE' });
  check('وصول episodeClose للإنتاج ← episode-closed', p.s === 200 && p.j.kind === 'episode-closed', JSON.stringify(p.j));
  p = await post({ eventId: TEST_EV, unitId: 900001, runUnitId: 9900001, hospitalName: 'بلا فلتر' });
  check('رفض بلا southTeam ← 400 (فلتر القطاع يعمل على الإنتاج)', p.s === 400);

  // ⑤ الملخص: الحالة الاختبارية مغلقة وليست «في المستشفى الآن»
  const sum = await (await fetch(BASE + '/api/hospital-monitor/summary', { headers: auth })).json();
  check('الملخص يعمل على الإنتاج (success)', sum.success === true);
  check('الحالة الاختبارية مغلقة (currentAtHospital لا يعدّها)', (sum.facilities || []).every(f => !/تحقق النشر/.test(f.facility) || f.journeys.every(j => j.episodeState === 'last-known')));

  // ⑥ الاحتساب لم يتأثر: /api/cad-reports قبل/بعد الاختبار متطابق
  const after = await (await fetch(BASE + '/api/cad-reports', { headers: auth })).json();
  check('report_times/الاحتساب لم يتأثرا (total وincidents متطابقان قبل/بعد)',
    before.total === after.total && before.incidentsCount === after.incidentsCount,
    'قبل=' + before.total + '/' + before.incidentsCount + ' بعد=' + after.total + '/' + after.incidentsCount);

  console.log('\nالنتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
