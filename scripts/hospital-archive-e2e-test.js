/**
 * ═══ hospital-archive-e2e-test.js — سلسلة الأرشفة الكاملة طرف-لطرف ═══
 * (اعتماد المالك 2026-08-28 — تشخيص «التبويب غير ظاهر»): يثبت على خادم حقيقي
 * قيد التشغيل السلسلة كاملة بلا محاكاة:
 *   Shift نشطة ← مشاهدة مستشفى (ختم shiftId) ← أرشفة/ختم ← shift_snapshots
 *   ← GET /api/shifts/:id ← response.hospital ← GET /export (قسم نصي)
 * العزل كامل: نسخة مؤقتة من مجلد data (DATA_DIR) + مخزن مستشفيات مؤقت —
 * صفر مساس ببيانات البيئة الحقيقية، ويُحذف كل شيء عند الخروج.
 * التشغيل: node scripts/hospital-archive-e2e-test.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3998;
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.resolve(__dirname, '..');
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-data-'));
const TMP_STORE = path.join(os.tmpdir(), 'hm-e2e-store-' + Date.now() + '.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const failures = [];
const check = (n, c, x) => { if (c) { passed++; console.log('  ✅ ' + n); } else { failed++; failures.push(n); console.log('  ❌ ' + n + (x ? ' — ' + x : '')); } };

function cleanup() {
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (_) { }
    try { fs.unlinkSync(TMP_STORE); } catch (_) { }
}

(async () => {
    console.log('═══ E2E: سلسلة أرشفة دورة المستشفيات (نسخة معزولة من data) ═══\n');
    fs.cpSync(path.join(ROOT, 'data'), TMP_DATA, { recursive: true });

    const key = (JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'integration-keys.json'), 'utf8')) || [])
        .find(k => k.active && k.scope === 'cad-reports');
    if (!key) { console.error('لا مفتاح تكامل في النسخة المعزولة'); cleanup(); process.exit(1); }

    const srv = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP_DATA, HOSPITAL_MONITOR_FILE: TMP_STORE },
        stdio: 'ignore'
    });
    const kill = () => { try { srv.kill('SIGTERM'); } catch (_) { } cleanup(); };
    process.on('exit', kill);

    let up = false;
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(1500) }); if (r.status) { up = true; break; } } catch (_) { }
        await sleep(1000);
    }
    if (!up) { console.error('الخادم لم يقلع'); kill(); process.exit(1); }
    console.log('الخادم قام على :' + PORT + ' (DATA_DIR معزول)\n');

    const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '4252', password: '4252' }) })).json();
    const tok = login.accessToken;
    check('① دخول المدير', !!tok);
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };

    // مناوبة نشطة في النسخة المعزولة: استخدم القائمة أو أنشئ واحدة
    const Database = require('better-sqlite3');
    const clone = new Database(path.join(TMP_DATA, 'ambulance.db'), { readonly: true });
    let active = clone.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    clone.close();
    if (!active) {
        const st = await (await fetch(BASE + '/api/start-new-shift', { method: 'POST', headers: auth, body: JSON.stringify({ shiftType: 'morning' }) })).json();
        check('② بدء مناوبة جديدة في النسخة المعزولة', !!(st && (st.success || st.shift)), JSON.stringify(st).slice(0, 160));
        const c2 = new Database(path.join(TMP_DATA, 'ambulance.db'), { readonly: true });
        active = c2.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
        c2.close();
    } else {
        check('② توجد مناوبة نشطة في النسخة المعزولة (#' + active.id + ')', true);
    }
    const shiftId = active && active.id;
    if (!shiftId) { console.error('تعذر الحصول على مناوبة نشطة'); kill(); process.exit(1); }

    // مشاهدة مستشفى عبر مفتاح التكامل (نفس مسار الـOverlay الحقيقي)
    const EV = '7770001', RID = 4242, KEY = EV + ':' + RID;
    const sg = await fetch(BASE + '/api/cad-reports/hospital-sighting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Integration-Key': key.key },
        body: JSON.stringify({ eventId: EV, unitId: 1467, runUnitId: RID, unitCode: 'جنوب 1 - 1', southTeam: 'جنوب 1', hospitalName: 'مستشفى E2E للاختبار', journeyStepCode: 'HANDOVER', observedAt: new Date().toISOString() })
    }).then(r => r.json());
    check('③ مشاهدة مستشفى ← created', sg.success === true && sg.kind === 'created', JSON.stringify(sg));

    // ختم shiftId سيرفيًا على الرحلة (من ملف المخزن المؤقت مباشرة)
    const stored = JSON.parse(fs.readFileSync(TMP_STORE, 'utf8'));
    check('④ الرحلة مختومة بمناوبة الاستقبال سيرفريًا (shiftId=' + shiftId + ')',
        stored.current[KEY] && Number(stored.current[KEY].shiftId) === Number(shiftId),
        JSON.stringify(stored.current[KEY] || {}).slice(0, 200));

    // أرشفة المناوبة (ختم اللقطة)
    const arc = await (await fetch(BASE + '/api/shift/' + shiftId + '/archive', { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'e2e hospital cycle' }) })).json();
    check('⑤ أرشفة المناوبة نجحت', arc && arc.success === true, JSON.stringify(arc).slice(0, 200));

    // القسم مختوم في shift_snapshots (مصدر قراءة الأرشيف)
    const c3 = new Database(path.join(TMP_DATA, 'ambulance.db'), { readonly: true });
    const snapRow = c3.prepare('SELECT snapshot_data FROM shift_snapshots WHERE shift_id = ? ORDER BY id DESC LIMIT 1').get(shiftId);
    c3.close();
    let sealed = null;
    try { sealed = snapRow ? JSON.parse(snapRow.snapshot_data) : null; } catch (_) { }
    check('⑥ snapshot.hospital مختوم في shift_snapshots',
        !!(sealed && sealed.hospital && Array.isArray(sealed.hospital.journeys)));
    const sealedJ = sealed && sealed.hospital ? sealed.hospital.journeys.find(j => j.key === KEY) : null;
    check('⑦ الرحلة داخل اللقطة المختومة — مفتوحة عند الإغلاق بصدق (لا إغلاق ملفّق)',
        !!sealedJ && sealedJ.episodeState === 'at-hospital' && sealedJ.episodeClosedAt === null &&
        sealedJ.hospitalName === 'مستشفى E2E للاختبار' && Number(sealedJ.shiftId) === Number(shiftId));

    // الـAPI الذي يغذي viewShift يرجع القسم من اللقطة المختومة
    const detail = await (await fetch(BASE + '/api/shifts/' + shiftId, { headers: auth })).json();
    const hj = detail.hospital && Array.isArray(detail.hospital.journeys)
        ? detail.hospital.journeys.find(j => j.key === KEY) : null;
    check('⑧ GET /api/shifts/:id يرجع hospital من اللقطة المختومة والرحلة فيه',
        !!(detail.hospital && detail.hospital.sealedAt && hj));

    // التصدير النصي يشمل القسم
    const exp = await (await fetch(BASE + '/api/shifts/' + shiftId + '/export', { headers: auth })).text();
    check('⑨ /export يشمل قسم المستشفيات والرحلة والـTimeline',
        exp.includes('المستشفيات') && exp.includes('مستشفى E2E للاختبار') && exp.includes('Timeline المستشفيات'));

    console.log('\n═══ النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    kill();
    await sleep(500);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('خطأ فادح:', e); cleanup(); process.exit(1); });
