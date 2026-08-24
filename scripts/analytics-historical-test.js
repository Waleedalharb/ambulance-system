/**
 * ═══ اختبار الذاكرة التاريخية للخريطة — analytics-historical-test.js ═══
 * (H1 — اعتماد المالك 2026-08-24، وثيقة DECISION-HISTORICAL-ANALYTICS):
 * GET /api/analytics/incidents?from=&to= يعيد ملخص البلاغات على نطاق زمني حر
 * عبر كل المناوبات — قراءة مشتقة من ReportService.getHistoricalSummary:
 *  · الترشيح على cad_created_at الفعلي (محلل CAD المركزي) + created_at بديلًا
 *    صادقًا، وصف بلا وقت قابل للقراءة يُحسب في unresolvedTimeCount بصدق.
 *  · byType/byDistrict مرة واحدة لكل بلاغ مهما تعددت الفرق.
 *  · byCrew والأزمنة من المشاركات المحتسبة فقط: لا withdrawn ولا manual_cancelled
 *    (قاعدة isParticipationCounted الواحدة) — وإلغاءات الوحدات قبل/بعد المباشرة
 *    تُعدّ تاريخيًا ولا تدخل الاحتساب إلا بعد المباشرة.
 *  · severity=null دائمًا (لا خطورة حية في الذاكرة) · الضغطات اليدوية خارج الطبقة.
 * البيانات الاصطناعية في نطاق مستقبلي (يناير 2027) حتى لا يختلط أي سجل حقيقي.
 * معزول كاملًا: VACUUM INTO + DATA_DIR مؤقت — لا لمس لقاعدة التشغيل.
 * التشغيل: node scripts/analytics-historical-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'histmap-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'histmap-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3107;
const BASE = 'http://127.0.0.1:' + PORT;
const SHIFT_ID = 900001;
const U1 = 'تحليل جنوب 901', U2 = 'تحليل جنوب 902';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

function seed(db) {
    db.prepare('INSERT INTO shifts (id, shift_name, shift_date, shift_type) VALUES (?, ?, ?, ?)')
        .run(SHIFT_ID, 'مناوبة التحليل', '2027-01-10', 'D');
    db.prepare('INSERT INTO reports (id, shift_id, center, unit, count, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(900001, SHIFT_ID, 'تحليل', U1, '2027-01-10T11:00:00.000Z');
    db.prepare('INSERT INTO reports (id, shift_id, center, unit, count, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(900002, SHIFT_ID, 'تحليل', U2, '2027-01-10T11:00:00.000Z');
    const inc = db.prepare(`INSERT INTO incident_registry
        (id, shift_id, number, code, type, source, created_at, cad_created_at, address, region, district, street, city, lat, lng, status)
        VALUES (?, ?, ?, ?, ?, 'cad', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A: داخل النطاق · محدد الموقع · مغلق · فرقتان (901 محتسبة / 902 ملغاة يدويًا)
    inc.run(900001, SHIFT_ID, '9101', 'C1', 'medical', '2027-01-10T11:05:00.000Z', '10/01/2027 14:05:00',
        'عنوان اختبار أ', 'الجنوب', 'حي التحليل', 'شارع التحليل 1', 'الرياض', 24.7001, 46.7001, 'closed');
    // B: داخل النطاق · ملغى · 901 مسحوبة قبل المباشرة / 902 باشرت ثم أُلغيت
    inc.run(900002, SHIFT_ID, '9102', 'C2', 'traffic', '2027-01-10T23:31:00.000Z', '11/01/2027 02:30:00',
        'عنوان اختبار ب', 'الجنوب', 'حي التحليل', 'شارع التحليل 1', 'الرياض', 24.7010, 46.7010, 'cancelled');
    // C: خارج النطاق زمنيًا — يجب ألا يظهر إطلاقًا
    inc.run(900003, SHIFT_ID, '9103', 'C3', 'fire', '2027-01-05T07:00:00.000Z', '05/01/2027 10:00:00',
        'عنوان اختبار ج', 'الجنوب', 'حي بعيد', 'شارع بعيد', 'الرياض', 24.8000, 46.8000, 'closed');
    // D: بلا cad_created_at — يدخل ببديل created_at الصادق · بلا إحداثيات (بلا موقع دقيق)
    inc.run(900004, SHIFT_ID, '9104', 'C4', null, '2027-01-10T18:00:00.000Z', null,
        null, 'الجنوب', 'حي التحليل', null, null, null, null, 'closed');
    // E: بلا أي وقت قابل للقراءة — unresolvedTimeCount بصدق ولا يتسلل للنطاق
    inc.run(900005, SHIFT_ID, '9105', 'C5', 'medical', null, 'غير معروف',
        null, 'الجنوب', 'حي التحليل', null, null, 24.9, 46.9, 'active');

    const rt = db.prepare(`INSERT INTO report_times
        (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min, withdrawn, cad_unit_status, cad_reached, manual_cancelled, manual_cancelled_by, manual_cancelled_at, manual_cancel_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A/901: مشاركة فعلية محتسبة (وصول 14:15 = +10د · مباشرة 14:20 = +15د)
    rt.run(900001, '2027-01-10T11:06:00.000Z', 'medical', '9101',
        JSON.stringify({ 'قبول': '10/01/2027 14:06', 'التحرك': '10/01/2027 14:07', 'البحث': '10/01/2027 14:15', 'العلاج': '10/01/2027 14:20' }),
        10, 15, 0, null, null, 0, null, null, null);
    // A/902: ملغاة يدويًا — خارج كل عدّاد
    rt.run(900002, '2027-01-10T11:06:30.000Z', 'medical', '9101',
        JSON.stringify({ 'قبول': '10/01/2027 14:06' }),
        null, null, 0, null, null, 1, 'مختبر', '2027-01-10T11:10:00.000Z', 'اختبار');
    // B/901: تحركت ثم سُحبت قبل المباشرة (B + لا وصول) — قبل المباشرة، خارج byCrew
    rt.run(900001, '2027-01-10T23:32:00.000Z', 'traffic', '9102',
        JSON.stringify({ 'قبول': '11/01/2027 02:31', 'التحرك': '11/01/2027 02:33' }),
        null, null, 1, 'B', 0, 0, null, null, null);
    // B/902: باشرت (وصول 02:40 = +10د) ثم أُلغيت — بعد المباشرة، محتسبة تاريخيًا
    rt.run(900002, '2027-01-10T23:32:30.000Z', 'traffic', '9102',
        JSON.stringify({ 'قبول': '11/01/2027 02:31', 'التحرك': '11/01/2027 02:32', 'البحث': '11/01/2027 02:40' }),
        10, null, 0, 'C', 1, 0, null, null, null);
    // ضغطة يدوية بلا رقم — خارج الطبقة التاريخية بنيويًا (لا موقع لها)
    rt.run(900001, '2027-01-10T12:00:00.000Z', 'medical', null, null, null, null, 0, null, null, 0, null, null, null);
}

(async () => {
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت + بيانات اصطناعية (يناير 2027)...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    const seedDb = new Database(TMP_DB);
    seed(seedDb);
    seedDb.close();

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const admin = (await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } })).data.accessToken;

        console.log('\n— A. الحماية والتحقق من المدخلات —');
        let r = await api('/api/analytics/incidents?from=2027-01-09&to=2027-01-11');
        check('A1: بلا توكن ← 401', r.status === 401);
        r = await api('/api/analytics/incidents?from=abc&to=2027-01-11', { token: admin });
        check('A2: صيغة تاريخ فاسدة ← 400', r.status === 400);
        r = await api('/api/analytics/incidents?from=2027-01-12&to=2027-01-10', { token: admin });
        check('A3: بداية بعد النهاية ← 400', r.status === 400);
        r = await api('/api/analytics/incidents', { token: admin });
        check('A4: الوضع الافتراضي (7 أيام) يعمل ويعيد العقد', r.status === 200 && r.data.success === true
            && r.data.range && Array.isArray(r.data.incidents) && r.data.mapStatus);

        console.log('\n— B. الترشيح الزمني والصدق —');
        r = await api('/api/analytics/incidents?from=2027-01-09&to=2027-01-11', { token: admin });
        const d = r.data;
        check('B1: الاستجابة ناجحة', r.status === 200 && d.success === true);
        check('B2: total=3 (داخل النطاق فقط)', d.total === 3, 'total=' + d.total);
        const nums = (d.incidents || []).map(x => x.number).sort();
        check('B3: البلاغات = 9101/9102/9104 حصرًا', JSON.stringify(nums) === JSON.stringify(['9101', '9102', '9104']), nums.join(','));
        check('B4: خارج النطاق (9103) غائب', !nums.includes('9103'));
        check('B5: بلا cad_created_at يدخل ببديل created_at (9104)', nums.includes('9104'));
        check('B6: بلا وقت قابل للقراءة ← unresolvedTimeCount ≥ 1 ولا يدخل النطاق', d.unresolvedTimeCount >= 1 && !nums.includes('9105'), 'unresolved=' + d.unresolvedTimeCount);
        check('B7: range يرد النطاق', d.range && d.range.from && d.range.to);
        check('B8: byStatus صادق (closed=2 · cancelled=1)', d.byStatus && d.byStatus.closed === 2 && d.byStatus.cancelled === 1, JSON.stringify(d.byStatus));
        check('B9: activeCount=0 معلومة فقط', d.activeCount === 0);

        console.log('\n— C. قواعد الاشتقاق التاريخية —');
        check('C1: byType مرة لكل بلاغ (medical=1 · traffic=1 · other=1)', d.byType.medical === 1 && d.byType.traffic === 1 && d.byType.other === 1, JSON.stringify(d.byType));
        check('C2: الضغطة اليدوية خارج الطبقة (medical لم تتضخم)', d.byType.medical === 1);
        check('C3: byDistrict[حي التحليل]=3 (بلاغ/مرة — لا تكرار بالفرق)', d.byDistrict['حي التحليل'] === 3, JSON.stringify(d.byDistrict));
        check('C4: حي بعيد (خارج النطاق) غائب', !d.byDistrict['حي بعيد']);
        check('C5: byCrew[901]=1 (المسحوبة قبل المباشرة خارجة)', d.byCrew[U1] === 1, JSON.stringify(d.byCrew));
        check('C6: byCrew[902]=1 (الملغاة يدويًا خارجة · بعد المباشرة محتسبة)', d.byCrew[U2] === 1);
        check('C7: إلغاءات الوحدات تاريخية (قبل=1 · بعد=1)', d.unitCancels.beforeArrival === 1 && d.unitCancels.afterArrival === 1, JSON.stringify(d.unitCancels));

        console.log('\n— D. تفاصيل البلاغ وأزمنة الاستجابة —');
        const inc = {}; d.incidents.forEach(x => { inc[x.number] = x; });
        check('D1: 9101 أسرع وصول=10 · أسرع مباشرة=15', inc['9101'].bestArrivalMin === 10 && inc['9101'].bestMubasharaMin === 15);
        check('D2: 9101 فرقتان ظاهرتان (المحتسبة والملغاة يدويًا)', inc['9101'].crews.length === 2);
        const a902 = inc['9101'].crews.find(c => c.unit === U2);
        check('D3: 9101/902 manualCancelled=true وcounted=false', a902 && a902.manualCancelled === true && a902.counted === false);
        const b901 = inc['9102'].crews.find(c => c.unit === U1);
        const b902 = inc['9102'].crews.find(c => c.unit === U2);
        check('D4: 9102/901 withdrawn وcancelKind=before-arrival وغير محتسبة', b901 && b901.withdrawn === true && b901.cancelKind === 'before-arrival' && b901.counted === false);
        check('D5: 9102/902 cancelKind=after-arrival ومحتسبة', b902 && b902.cancelKind === 'after-arrival' && b902.counted === true);
        check('D6: 9102 أسرع وصول=10 من المحتسبة فقط', inc['9102'].bestArrivalMin === 10);
        check('D7: severity=null للجميع (لا خطورة حية في الذاكرة)', d.incidents.every(x => x.severity === null));
        check('D8: متوسط الوصول=10 من بلاغين', d.responseTime.arrival.avg === 10 && d.responseTime.arrival.count === 2, JSON.stringify(d.responseTime.arrival));
        check('D9: متوسط المباشرة=15 من بلاغ واحد', d.responseTime.mubashara.avg === 15 && d.responseTime.mubashara.count === 1);

        console.log('\n— E. مؤشرات الخريطة التاريخية —');
        const ms = d.mapStatus;
        check('E1: positionedCount=2 · noLocationCount=1', ms.positionedCount === 2 && ms.noLocationCount === 1, JSON.stringify({ p: ms.positionedCount, n: ms.noLocationCount }));
        check('E2: «بلا موقع دقيق» = 9104', ms.noLocation.length === 1 && ms.noLocation[0].number === '9104');
        check('E3: أكثر شارع = شارع التحليل 1 ×2', ms.topStreets[0] && ms.topStreets[0].name === 'شارع التحليل 1' && ms.topStreets[0].count === 2, JSON.stringify(ms.topStreets));
        check('E4: أكثر حي = حي التحليل ×3', ms.topDistrict && ms.topDistrict.name === 'حي التحليل' && ms.topDistrict.count === 3);
        check('E5: ساعة الذروة — عند التعادل يفوز أصغر ساعة (ترتيب مفاتيح JS الرقمية)', ms.peakHour && ms.peakHour.hour === 2 && ms.peakHour.count === 1, JSON.stringify(ms.peakHour));
        check('E6: sectorStatus=null (لا ضغط حي)', ms.sectorStatus === null);
        check('E7: إحداثيات البلاغات تصل للخريطة (9101 lat/lng)', inc['9101'].lat === 24.7001 && inc['9101'].lng === 46.7001);
        check('E8: التحفظات موثقة في notes', Array.isArray(d.notes) && d.notes.length >= 3);
    } finally {
        server.kill();
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failed) { console.log('الفشلات:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('كل الاختبارات ناجحة.');
})().catch(e => { console.error('❌ خطأ جسيم:', e); process.exit(1); });
