/**
 * ═══ اختبار H3 — الطلب × التمركز: analytics-coverage-test.js ═══
 * (اعتماد المالك 2026-08-24 — الطبقة التاريخية): GET /api/analytics/coverage
 * يربط كل بلاغ محدد الموقع بنوافذ التمركز الفعلية من سجل positioning_events
 * (append-only): أقرب تمركز نشط وقت البلاغ + تمركز الفرقة المباشرة — ويكتشف
 * مناطق الطلب (خلية ~0.01° بثلاثة بلاغات+) ويصنف «تغطية ضعيفة» (أقرب تمركز
 * وقت البلاغ > 3كم أو وصول أعلى من متوسط النطاق أو بلاغات بلا تمركز معروف).
 * لا تخمين مواقع: بلا إحداثيات يُحسب ولا يُرسم، وبلا نافذة معروفة = null بصدق.
 * معزول كاملًا: VACUUM INTO + DATA_DIR مؤقت + بيانات مستقبلية (يناير 2027).
 * التشغيل: node scripts/analytics-coverage-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'coverage-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'coverage-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3109;
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
        .run(SHIFT_ID, 'مناوبة التغطية', '2027-01-10', 'D');
    db.prepare('INSERT INTO reports (id, shift_id, center, unit, count, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(900001, SHIFT_ID, 'تحليل', U1, '2027-01-10T11:00:00.000Z');
    db.prepare('INSERT INTO reports (id, shift_id, center, unit, count, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(900002, SHIFT_ID, 'تحليل', U2, '2027-01-10T11:00:00.000Z');
    const inc = db.prepare(`INSERT INTO incident_registry
        (id, shift_id, number, code, type, source, created_at, cad_created_at, address, region, district, street, city, lat, lng, status)
        VALUES (?, ?, ?, ?, ?, 'cad', ?, ?, NULL, 'الجنوب', ?, NULL, 'الرياض', ?, ?, 'closed')`);
    // خلية قريبة (24.70, 46.70): A وB وF — تمركز U1 على بُعد <1كم
    inc.run(900001, SHIFT_ID, '9101', 'C1', 'medical', '2027-01-10T11:05:00.000Z', '10/01/2027 14:05:00', 'حي قريب', 24.7001, 46.7001);
    inc.run(900002, SHIFT_ID, '9102', 'C2', 'traffic', '2027-01-10T23:31:00.000Z', '11/01/2027 02:30:00', 'حي قريب', 24.7010, 46.7010);
    inc.run(900003, SHIFT_ID, '9106', 'C6', 'medical', '2027-01-10T11:30:00.000Z', '10/01/2027 14:30:00', 'حي قريب', 24.7005, 46.7005);
    // خلية بعيدة (24.90, 46.90): G وH وI — أقرب تمركز >20كم + وصول أعلى من المتوسط
    inc.run(900004, SHIFT_ID, '9107', 'C7', 'medical', '2027-01-10T17:05:00.000Z', '10/01/2027 20:05:00', 'حي بعيد', 24.9001, 46.9001);
    inc.run(900005, SHIFT_ID, '9108', 'C8', 'medical', '2027-01-10T17:15:00.000Z', '10/01/2027 20:15:00', 'حي بعيد', 24.9010, 46.9010);
    inc.run(900006, SHIFT_ID, '9109', 'C9', 'traffic', '2027-01-11T00:00:00.000Z', '11/01/2027 03:00:00', 'حي بعيد', 24.9005, 46.9005);
    // بلا إحداثيات — يُحسب ولا يُرسم
    inc.run(900007, SHIFT_ID, '9104', 'C4', 'medical', '2027-01-10T18:00:00.000Z', '10/01/2027 21:00:00', 'حي قريب', null, null);
    const rt = db.prepare(`INSERT INTO report_times
        (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min, withdrawn, cad_unit_status, cad_reached, manual_cancelled)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 0)`);
    const mv = (d, t) => JSON.stringify({ 'قبول': d + ' ' + t, 'التحرك': d + ' ' + t, 'البحث': d + ' ' + t });
    // A: U1 وصول +10د · B: U2 وصول +10د · F: بلا مشاركات (وصولها null بصدق)
    rt.run(900001, '2027-01-10T11:06:00.000Z', 'medical', '9101', mv('10/01/2027', '14:06'), 10);
    rt.run(900002, '2027-01-10T23:32:00.000Z', 'traffic', '9102', mv('11/01/2027', '02:31'), 10);
    // G/H/I: U1 وصول +25د لكل منها — أعلى من متوسط النطاق (19)
    rt.run(900001, '2027-01-10T17:06:00.000Z', 'medical', '9107', mv('10/01/2027', '20:06'), 25);
    rt.run(900001, '2027-01-10T17:16:00.000Z', 'medical', '9108', mv('10/01/2027', '20:16'), 25);
    rt.run(900001, '2027-01-11T00:01:00.000Z', 'traffic', '9109', mv('11/01/2027', '03:01'), 25);
    // نوافذ التمركز (append-only): U1 قريب من الخلية الأولى · U2 بعيد جدًا
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

        console.log('\n— A. الحماية والإجماليات —');
        let r = await api('/api/analytics/coverage?from=2027-01-09&to=2027-01-11');
        check('A1: بلا توكن ← 401', r.status === 401);
        r = await api('/api/analytics/coverage?from=2027-01-09&to=2027-01-11', { token: admin });
        const d = r.data;
        check('A2: نجاح', r.status === 200 && d.success === true);
        check('A3: الإجماليات (7 بلاغات · 6 محددة · 1 بلا إحداثيات)', d.totals.incidents === 7 && d.totals.positioned === 6 && d.totals.noCoords === 1, JSON.stringify(d.totals));
        check('A4: نافذتا تمركز مقروءتان من السجل', d.positioning.windowsCount === 2 && d.positioning.units.length === 2);
        check('A5: نقطتا تمركز فريدتان بإحداثيات للعرض', Array.isArray(d.positioningUnits) && d.positioningUnits.length === 2 && d.positioningUnits.every(p => isFinite(p.lat) && isFinite(p.lng)));
        check('A6: متوسط وصول النطاق = 19', d.responseAvgArrival === 19, 'avg=' + d.responseAvgArrival);

        console.log('\n— B. ربط البلاغ بالتمركز وقت البلاغ —');
        const inc = {}; d.incidents.forEach(x => { inc[x.number] = x; });
        check('B1: A أقرب تمركز وقتها ≤1كم وهو فرقة U1', inc['9101'].nearestPositioningAtTime && inc['9101'].nearestPositioningAtTime.km <= 1 && inc['9101'].nearestPositioningAtTime.unit === U1, JSON.stringify(inc['9101'].nearestPositioningAtTime));
        check('B2: A تمركز فرقتها المباشرة = U1', inc['9101'].crewPositioning && inc['9101'].crewPositioning.unit === U1 && inc['9101'].crewPositioning.km <= 1);
        check('B3: B تمركز فرقتها المباشرة = U2 (بعيدة)', inc['9102'].crewPositioning && inc['9102'].crewPositioning.unit === U2);
        check('B4: G أقرب تمركز وقتها > 3كم', inc['9107'].nearestPositioningAtTime && inc['9107'].nearestPositioningAtTime.km > 3, JSON.stringify(inc['9107'].nearestPositioningAtTime));
        check('B5: بلا إحداثيات (9104) يُحسب ولا يُرسم ولا يُخمَّن', inc['9104'].noCoords === true && inc['9104'].nearestPositioningAtTime === null);
        check('B6: الفرق المباشرة المحتسبة فقط تصل (A=U1)', JSON.stringify(inc['9101'].countedUnits) === JSON.stringify([U1]));

        console.log('\n— C. مناطق الطلب وضعف التغطية —');
        check('C1: منطقتان (خليتان × 3 بلاغات)', d.zones.length === 2, 'zones=' + d.zones.length);
        const near = d.zones.find(z => z.centroid.lat > 24.6 && z.centroid.lat < 24.8);
        const far = d.zones.find(z => z.centroid.lat > 24.8);
        check('C2: الخلية القريبة موجودة (3 بلاغات · وصول 10)', near && near.count === 3 && near.avgArrivalMin === 10, JSON.stringify(near && near.centroid));
        check('C3: القريبة مغطاة (ليست ضعيفة)', near && near.weak === false, near && near.weakReasons && near.weakReasons.join('·'));
        check('C4: البعيدة ضعيفة بسببين (بعد التمركز + وصول أعلى)', far && far.weak === true && far.weakReasons.length === 2, far && far.weakReasons && far.weakReasons.join('·'));
        check('C5: البعيدة: متوسط وصول 25 وأقرب تمركز > 3كم', far && far.avgArrivalMin === 25 && far.avgNearestAtTimeKm > 3);
        check('C6: أقرب تمركز تاريخي للبعيدة = النقطة القريبة (>15كم)', far && far.nearestAnytimeKm !== null && far.nearestAnytimeKm > 15, 'km=' + (far && far.nearestAnytimeKm));
        check('C7: الثوابت موثقة في الاستجابة', d.constants && d.constants.demandZoneMin === 3 && d.constants.coverageFarKm === 3);
        check('C8: التحفظات موثقة (لا تخمين · قاعدة الخلية)', Array.isArray(d.notes) && d.notes.length >= 3);
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
