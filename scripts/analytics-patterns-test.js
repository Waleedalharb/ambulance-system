/**
 * ═══ اختبار H2 — الأنماط الزمنية: analytics-patterns-test.js ═══
 * (اعتماد المالك 2026-08-24 — الطبقة التاريخية): GET /api/analytics/patterns
 * يعيد التوزيع بالساعة/اليوم/الفترة/اليومي + الذروة + الأحياء والشوارع +
 * مقارنة بالفترة السابقة المماثلة — كلها مشتقة من cad_created_at الفعلي
 * (أو created_at بديلًا صادقًا) بلا تخزين مسبق. التوقعات ذات المرجع الزمني
 * (ساعة/يوم الحدث الاحتياطي ISO) تُحسب في الاختبار بنفس أساس الخادم حتى يبقى
 * الاختبار حتميًا مهما كانت منطقة الجهاز. معزول كاملًا: VACUUM INTO + DATA_DIR
 * مؤقت وبيانات اصطناعية مستقبلية (يناير 2027) — لا لمس لقاعدة التشغيل.
 * التشغيل: node scripts/analytics-patterns-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'patterns-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'patterns-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3108;
const BASE = 'http://127.0.0.1:' + PORT;
const SHIFT_ID = 900001;

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
        .run(SHIFT_ID, 'مناوبة الأنماط', '2027-01-10', 'D');
    const inc = db.prepare(`INSERT INTO incident_registry
        (id, shift_id, number, code, type, source, created_at, cad_created_at, address, region, district, street, city, lat, lng, status)
        VALUES (?, ?, ?, ?, ?, 'cad', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A: أحد 10/01 الساعة 14:05 (صباح بالقاعدة) · حي التحليل · شارع 1
    inc.run(900001, SHIFT_ID, '9101', 'C1', 'medical', '2027-01-10T11:05:00.000Z', '10/01/2027 14:05:00',
        null, 'الجنوب', 'حي التحليل', 'شارع التحليل 1', 'الرياض', 24.7001, 46.7001, 'closed');
    // B: اثنين 11/01 الساعة 02:30 (ليل) · حي التحليل · شارع 1
    inc.run(900002, SHIFT_ID, '9102', 'C2', 'traffic', '2027-01-10T23:31:00.000Z', '11/01/2027 02:30:00',
        null, 'الجنوب', 'حي التحليل', 'شارع التحليل 1', 'الرياض', 24.7010, 46.7010, 'cancelled');
    // D: بلا cad_created_at — بديل created_at (ساعته/يومه يُحسبان في الاختبار)
    inc.run(900003, SHIFT_ID, '9104', 'C4', null, '2027-01-10T18:00:00.000Z', null,
        null, 'الجنوب', 'حي التحليل', null, null, null, null, 'closed');
    // خارج النطاق: 05/01 — لا يدخل الحالية ولا السابقة (السابقة = 06–08)
    inc.run(900004, SHIFT_ID, '9103', 'C3', 'fire', '2027-01-05T07:00:00.000Z', '05/01/2027 10:00:00',
        null, 'الجنوب', 'حي بعيد', 'شارع بعيد', 'الرياض', 24.8, 46.8, 'closed');
    // بلا وقت قابل للقراءة — unresolved
    inc.run(900005, SHIFT_ID, '9105', 'C5', 'medical', null, 'غير معروف',
        null, 'الجنوب', 'حي التحليل', null, null, 24.9, 46.9, 'active');
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

        console.log('\n— A. الحماية والمدخلات —');
        let r = await api('/api/analytics/patterns?from=2027-01-09&to=2027-01-11');
        check('A1: بلا توكن ← 401', r.status === 401);
        r = await api('/api/analytics/patterns?from=2027-01-12&to=2027-01-10', { token: admin });
        check('A2: نطاق معكوس ← 400', r.status === 400);

        console.log('\n— B. التوزيعات الزمنية —');
        r = await api('/api/analytics/patterns?from=2027-01-09&to=2027-01-11', { token: admin });
        const d = r.data;
        check('B1: نجاح + total=3', r.status === 200 && d.success === true && d.total === 3, 'total=' + d.total);
        // مرجعيات محسوبة بنفس أساس الخادم (الجهاز نفسه) — حتمية مهما كانت المنطقة
        const A = { ts: new Date(2027, 0, 10, 14, 5).getTime() };
        const B = { ts: new Date(2027, 0, 11, 2, 30).getTime() };
        const D = { ts: Date.parse('2027-01-10T18:00:00.000Z') };
        const hA = new Date(A.ts).getHours(), hB = new Date(B.ts).getHours(), hD = new Date(D.ts).getHours();
        const sum = d.byHour.reduce((a, b) => a + b, 0);
        check('B2: byHour مجموعه 3 و24 خلية', d.byHour.length === 24 && sum === 3);
        check('B3: byHour[14]=1 (A)', d.byHour[hA] === 1 && hA === 14);
        check('B4: byHour[2]=1 (B)', d.byHour[hB] === 1 && hB === 2);
        check('B5: ساعة D الاحتياطية محسوبة', d.byHour[hD] === 1, 'hD=' + hD);
        const wA = new Date(A.ts).getDay(), wB = new Date(B.ts).getDay(), wD = new Date(D.ts).getDay();
        const wexp = {}; [wA, wB, wD].forEach(w => { wexp[w] = (wexp[w] || 0) + 1; });
        check('B6: byWeekday يطابق أيام الأحداث (مع تجميع المتشاركين)', Object.keys(wexp).every(w => d.byWeekday[w] === wexp[w]) && d.byWeekday.reduce((a, b) => a + b, 0) === 3, JSON.stringify(d.byWeekday));
        check('B7: byHour خارج النطاق صفر (ساعة 10 — بلاغ 05/01 غائب)', d.byHour[10] === 0);
        // الفترات: A صباح (14) · B ليل (2) · D حسب ساعته المحسوبة
        const pD = hD >= 7 && hD < 15 ? 'morning' : (hD >= 15 && hD < 23 ? 'evening' : 'night');
        check('B8: الفترات (صباح=1 · ليل≥1)', d.byPeriod.morning === 1 && d.byPeriod.night >= 1 && d.byPeriod[pD] >= 1, JSON.stringify(d.byPeriod));
        check('B9: قاعدة الفترات موثقة في الاستجابة', typeof d.periodRule === 'string' && d.periodRule.includes('07:00'));

        console.log('\n— C. الذروة والترتيبات —');
        check('C1: ساعة الذروة عند التعادل = أصغر ساعة (2)', d.peakHour && d.peakHour.hour === 2 && d.peakHour.count === 1, JSON.stringify(d.peakHour));
        check('C2: يوم الذروة موجود وضمن النطاق', d.peakWeekday && [wA, wB, wD].includes(d.peakWeekday.day));
        check('C3: أكثر حي = حي التحليل ×3', d.districts[0] && d.districts[0].name === 'حي التحليل' && d.districts[0].count === 3, JSON.stringify(d.districts));
        check('C4: حي بعيد (خارج النطاق) غائب من الترتيب', !d.districts.some(x => x.name === 'حي بعيد'));
        check('C5: أكثر شارع = شارع التحليل 1 ×2', d.streets[0] && d.streets[0].name === 'شارع التحليل 1' && d.streets[0].count === 2);
        const dkD = (() => { const x = new Date(D.ts); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); })();
        check('C6: byDate[10/01]=2 (A+D) · [11/01]=1 (B)', d.byDate['2027-01-10'] === 2 && d.byDate['2027-01-11'] === 1 && dkD === '2027-01-10', JSON.stringify(d.byDate));

        console.log('\n— D. مقارنة الفترات —');
        const cmp = d.comparison;
        check('D1: الفترة السابقة = 06–08 يناير (فارغة): total=0', cmp && cmp.total === 0, JSON.stringify(cmp && cmp.range));
        check('D2: الفرق = +3', cmp && cmp.delta === 3);
        check('D3: المتوسط اليومي 1 مقابل 0 (3 أيام)', cmp && cmp.perDay && cmp.perDay.current === 1 && cmp.perDay.previous === 0, JSON.stringify(cmp && cmp.perDay));
        check('D4: مقارنة الأنواع: الحالية فيها medical=1 · السابقة فارغة', cmp && cmp.byType && cmp.byType.current.medical === 1 && !cmp.byType.previous.medical);
        check('D5: وسم المقارنة موثق', cmp && typeof cmp.label === 'string' && cmp.label.includes('السابقة'));
        check('D6: unresolvedTimeCount ≥ 1 (9105)', d.unresolvedTimeCount >= 1);
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
