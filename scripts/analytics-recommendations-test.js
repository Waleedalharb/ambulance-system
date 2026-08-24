/**
 * ═══ اختبار H4 — دعم القرار: analytics-recommendations-test.js ═══
 * (اعتماد المالك 2026-08-24 — الطبقة التاريخية): GET /api/analytics/recommendations
 * يبني مرشحي التمركز من مناطق الطلب التاريخية (مرتبين بالطلب × معامل زمن
 * الاستجابة) + نوافذ يوم×ساعة الأعلى طلبًا + محاكاة افتراضية لأثر كل مرشح
 * على البلاغات التاريخية ضمن 3كم. **دعم قرار فقط**: المسار قراءة GET حصرًا،
 * ولا ينفذ نقل فرقة ولا تغيير تمركز ولا أي إجراء تشغيلي.
 * معزول كاملًا: VACUUM INTO + DATA_DIR مؤقت + بيانات مستقبلية (يناير 2027).
 * التشغيل: node scripts/analytics-recommendations-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'recs-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'recs-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3110;
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

// نفس بذرة اختبار H3 — منظومتان متكاملتان: خلية قريبة مغطاة وخلية بعيدة ضعيفة
function seed(db) {
    db.prepare('INSERT INTO shifts (id, shift_name, shift_date, shift_type) VALUES (?, ?, ?, ?)')
        .run(SHIFT_ID, 'مناوبة دعم القرار', '2027-01-10', 'D');
    db.prepare('INSERT INTO reports (id, shift_id, center, unit, count, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(900001, SHIFT_ID, 'تحليل', U1, '2027-01-10T11:00:00.000Z');
    db.prepare('INSERT INTO reports (id, shift_id, center, unit, count, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(900002, SHIFT_ID, 'تحليل', U2, '2027-01-10T11:00:00.000Z');
    const inc = db.prepare(`INSERT INTO incident_registry
        (id, shift_id, number, code, type, source, created_at, cad_created_at, address, region, district, street, city, lat, lng, status)
        VALUES (?, ?, ?, ?, ?, 'cad', ?, ?, NULL, 'الجنوب', ?, NULL, 'الرياض', ?, ?, 'closed')`);
    inc.run(900001, SHIFT_ID, '9101', 'C1', 'medical', '2027-01-10T11:05:00.000Z', '10/01/2027 14:05:00', 'حي قريب', 24.7001, 46.7001);
    inc.run(900002, SHIFT_ID, '9102', 'C2', 'traffic', '2027-01-10T23:31:00.000Z', '11/01/2027 02:30:00', 'حي قريب', 24.7010, 46.7010);
    inc.run(900003, SHIFT_ID, '9106', 'C6', 'medical', '2027-01-10T11:30:00.000Z', '10/01/2027 14:30:00', 'حي قريب', 24.7005, 46.7005);
    inc.run(900004, SHIFT_ID, '9107', 'C7', 'medical', '2027-01-10T17:05:00.000Z', '10/01/2027 20:05:00', 'حي بعيد', 24.9001, 46.9001);
    inc.run(900005, SHIFT_ID, '9108', 'C8', 'medical', '2027-01-10T17:15:00.000Z', '10/01/2027 20:15:00', 'حي بعيد', 24.9010, 46.9010);
    inc.run(900006, SHIFT_ID, '9109', 'C9', 'traffic', '2027-01-11T00:00:00.000Z', '11/01/2027 03:00:00', 'حي بعيد', 24.9005, 46.9005);
    inc.run(900007, SHIFT_ID, '9104', 'C4', 'medical', '2027-01-10T18:00:00.000Z', '10/01/2027 21:00:00', 'حي قريب', null, null);
    const rt = db.prepare(`INSERT INTO report_times
        (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min, withdrawn, cad_unit_status, cad_reached, manual_cancelled)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 0)`);
    const mv = (d, t) => JSON.stringify({ 'قبول': d + ' ' + t, 'التحرك': d + ' ' + t, 'البحث': d + ' ' + t });
    rt.run(900001, '2027-01-10T11:06:00.000Z', 'medical', '9101', mv('10/01/2027', '14:06'), 10);
    rt.run(900002, '2027-01-10T23:32:00.000Z', 'traffic', '9102', mv('11/01/2027', '02:31'), 10);
    rt.run(900001, '2027-01-10T17:06:00.000Z', 'medical', '9107', mv('10/01/2027', '20:06'), 25);
    rt.run(900001, '2027-01-10T17:16:00.000Z', 'medical', '9108', mv('10/01/2027', '20:16'), 25);
    rt.run(900001, '2027-01-11T00:01:00.000Z', 'traffic', '9109', mv('11/01/2027', '03:01'), 25);
    const pe = db.prepare(`INSERT INTO positioning_events
        (shift_id, plan_id, event_type, changed_fields, payload, actor_id, actor_name, created_at)
        VALUES (?, ?, 'created', NULL, ?, NULL, 'اختبار', ?)`);
    const win = { startTime: '2027-01-09T00:00:00.000Z', endTime: '2027-01-20T00:00:00.000Z', status: 'active' };
    pe.run(SHIFT_ID, 'pp1', JSON.stringify({ ...win, unit: U1, lat: '24.705', lng: '46.705', location: 'نقطة قريبة' }), '2027-01-09T00:00:00.000Z');
    pe.run(SHIFT_ID, 'pp2', JSON.stringify({ ...win, unit: U2, lat: '25.200', lng: '47.200', location: 'نقطة بعيدة' }), '2027-01-09T00:00:00.000Z');
}

(async () => {
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت + بيانات اصطناعية...');
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

        console.log('\n— A. دعم قرار فقط —');
        let r = await api('/api/analytics/recommendations?from=2027-01-09&to=2027-01-11');
        check('A1: بلا توكن ← 401', r.status === 401);
        r = await api('/api/analytics/recommendations?from=2027-01-09&to=2027-01-11', { method: 'POST', token: admin });
        check('A2: المسار قراءة حصرًا — POST ← 404 (لا تنفيذ أي إجراء)', r.status === 404, 'status=' + r.status);
        r = await api('/api/analytics/recommendations?from=2027-01-09&to=2027-01-11', { token: admin });
        const d = r.data;
        check('A3: نجاح', r.status === 200 && d.success === true);
        check('A4: التنازل صريح: دعم قرار فقط بلا إجراء تلقائي', typeof d.disclaimer === 'string' && d.disclaimer.includes('دعم قرار فقط') && d.disclaimer.includes('لا تنفذ'));

        console.log('\n— B. مرشحو التمركز —');
        check('B1: مرشحان (منطقتا الطلب)', d.candidates.length === 2);
        const c0 = d.candidates[0], c1 = d.candidates[1];
        check('B2: الترتيب بالأولوية: البعيدة الضعيفة أولًا (طلب × معامل استجابة)', c0.weakCoverage === true && c0.score > c1.score, 'scores=' + c0.score + ',' + c1.score);
        check('B3: المرشح الأول من الخلية البعيدة', c0.lat > 24.8, 'lat=' + c0.lat);
        check('B4: بطاقة المرشح كاملة (بلاغات/وصول/أقرب تمركز)', c0.basedOnIncidents === 3 && c0.avgArrivalMin === 25 && c0.nearestHistoricalPositioningKm > 15);
        check('B5: أسباب الضعف مرفقة بالمرشح', Array.isArray(c0.weakReasons) && c0.weakReasons.length === 2);

        console.log('\n— C. المحاكاة الافتراضية (اشتقاق من الخام) —');
        const s0 = c0.simulation, s1 = c1.simulation;
        check('C1: البعيدة: 3 بلاغات ضمن 3كم = 50% من المحددة', s0.incidentsWithin === 3 && s0.sharePct === 50, JSON.stringify(s0));
        check('C2: البعيدة: استجابتها 25د أعلى من النطاق 19د ← higher', s0.avgArrivalMin === 25 && s0.rangeAvgArrivalMin === 19 && s0.comparison === 'higher');
        check('C3: القريبة: 3 بلاغات · 10د ← lower', s1.incidentsWithin === 3 && s1.avgArrivalMin === 10 && s1.comparison === 'lower');
        check('C4: نصف القطر موثق (3كم)', s0.radiusKm === 3);

        console.log('\n— D. النوافذ والملخصات —');
        check('D1: أعلى نافذة = الأحد 14:00 ×2', d.suggestedWindows[0] && d.suggestedWindows[0].weekday === new Date(2027, 0, 10, 14).getDay() && d.suggestedWindows[0].hour === 14 && d.suggestedWindows[0].count === 2, JSON.stringify(d.suggestedWindows[0]));
        check('D2: ملخص التغطية (منطقتان · واحدة ضعيفة · نافذتا تمركز)', d.coverageSummary.zonesCount === 2 && d.coverageSummary.weakZonesCount === 1 && d.coverageSummary.positioningWindows === 2);
        check('D3: ملخص الأنماط (7 بلاغات + مقارنة)', d.patternsSummary.total === 7 && d.patternsSummary.comparison && d.patternsSummary.comparison.delta === 7);
        check('D4: التحفظات موثقة (مرشحون/محاكاة/نوافذ)', Array.isArray(d.notes) && d.notes.length >= 3);
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
