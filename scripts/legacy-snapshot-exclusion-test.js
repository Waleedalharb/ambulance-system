/**
 * ═══ legacy-snapshot-exclusion-test.js — قاعدة «اللقطة المشتركة القديمة» (اعتماد المالك 2026-08-26) ═══
 * المشكلة: آخر نسخة منشورة (abb3119) أغلقت مسار التلوث الجديد (23/23) لكنها ما
 * زالت تحتسب 149 مشاركة تاريخية ملوثة (بصمة: قبل إغلاق 2026-08-23.c + بلا هوية
 * CAD + phases موقوتة) في byCrew/الإنجازات/التوزيع/المؤشرات/الذاكرة التحليلية —
 * جنوب 8 تظهر 17 بينما الموثوق منها 2 فقط.
 * القاعدة: legacy_snapshot = historical_unverified ← يبقى محفوظًا للتدقيق ولا
 * يدخل أي عداد. لا حذف، لا تعديل phases، لا تصفير يدوي، لا استثناء باسم فرقة.
 * يعمل هذا الملف على نسخة VACUUM معزولة من قاعدة الإنتاج (قراءة البيانات
 * الحقيقية بلا أي تعديل عليها) ويثبت:
 *   L1 جنوب 8 في مناوبة 176: 8 مشاركات legacy ← byCrew=0 والسجلات ظاهرة مصنفة
 *   L2 جنوب 8 في مناوبة 184: الشرعيتان (بهوية CAD) محفوظتان ← byCrew=2
 *   L3 الاختبار العكسي: مشاركة قديمة بهوية CAD (مناوبة 183) لا تُستبعد لمجرد أنها قديمة
 *   L4 الذاكرة التحليلية على كامل النطاق: جنوب 8 = 2 (كانت 17) · سريع 2 = 4 (كانت 31)
 *   L5 الإجمالي الكلي = 50 (كان 174) ← كل الـ149 legacy مستبعدة بنفس القاعدة
 *      (منها 25 كانت أصلًا بلا «تحرك» فلم تدخل العد سابقًا)
 *   L6 تقرير المناوبة /api/shifts/:id يستخدم نفس التعريف (CAD|جنوب 8 = 0)
 *   L7 لا حذف: عدد report_times ثابت والـ15 سجل legacy بـphases كاملة
 *   L8 مسار الكتابة الجديد سليم: مشاركة شرعية جديدة تُحسب طبيعيًا
 * التشغيل: node scripts/legacy-snapshot-exclusion-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3099;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'legacy-snap-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

const SHIFT_176 = 1784126563176; // 8 مشاركات legacy لجنوب 8
const SHIFT_183 = 1784126563183; // مشاركات قديمة بهوية CAD (الاختبار العكسي)
const SHIFT_184 = 1784126563184; // الشرعيتان 1310425/1310820

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 240) : '')); }
}

async function api(p, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    const ro = () => new Database(TMP_DB, { readonly: true });
    const rtCountBefore = ro().prepare('SELECT COUNT(*) AS c FROM report_times').get().c;
    const legacyRowsBefore = ro().prepare(
        `SELECT t.id, t.phases FROM report_times t JOIN reports r ON r.id=t.report_id
         WHERE r.unit='جنوب 8' AND t.incident_number IS NOT NULL AND r.created_at < '2026-08-23 13:00:00'
           AND t.cad_unit_id IS NULL AND t.cad_run_unit_id IS NULL AND t.cad_unit_status IS NULL`).all();

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) throw new Error('login');
        const sum = (sid) => api('/api/cad-reports?shift_id=' + sid, { token: TK }).then(r => r.data);
        const crewOf = (s, num, unit) => {
            const inc = (s.incidents || []).find(i => i.number === num);
            return inc ? (inc.crews || []).find(c => c.unit === unit) || null : null;
        };

        console.log('🧪 قاعدة legacy_snapshot — استبعاد اللقطة المشتركة القديمة من كل العدادات\n');

        /* ── L1: مناوبة 176 — 8 مشاركات legacy لجنوب 8 ← byCrew=0 ── */
        const s176 = await sum(SHIFT_176);
        check('L1 مناوبة 176: byCrew[جنوب 8] = 0 (كانت 8 قبل القاعدة)',
            ((s176.byCrew || {})['جنوب 8'] || 0) === 0, JSON.stringify(s176.byCrew));
        const l8 = crewOf(s176, '1300738', 'جنوب 8');
        check('L1+ سجل جنوب 8 في 1300738 محفوظ ومصنف: legacySnapshot=true + counted=false + phases كاملة',
            !!l8 && l8.legacySnapshot === true && l8.counted === false && !!l8.phases && !!l8.phases['التحرك'],
            JSON.stringify(l8 && { legacy: l8.legacySnapshot, counted: l8.counted, keys: Object.keys(l8.phases || {}) }));

        /* ── L2: مناوبة 184 — الشرعيتان محفوظتان ── */
        const s184 = await sum(SHIFT_184);
        check('L2 مناوبة 184: byCrew[جنوب 8] = 2 (الشرعيتان بهوية CAD لا تتأثران)',
            ((s184.byCrew || {})['جنوب 8'] || 0) === 2, JSON.stringify(s184.byCrew));
        const l184 = crewOf(s184, '1310425', 'جنوب 8');
        check('L2+ مشاركة 1310425 شرعية: counted=true + legacySnapshot=false',
            !!l184 && l184.counted === true && l184.legacySnapshot === false, JSON.stringify(l184 && { c: l184.counted, l: l184.legacySnapshot }));

        /* ── L3 الاختبار العكسي: قديمة بهوية CAD ← لا تُستبعد لمجرد قدمها ── */
        const s183 = await sum(SHIFT_183);
        const j6a = crewOf(s183, '1307875', 'جنوب 6');
        const j6b = crewOf(s183, '1308053', 'جنوب 6');
        check('L3 عكسي: مشاركتا جنوب 6 القديمتان بهوية CAD (1307875/1308053) محتسبتان وغير مصنفتين legacy',
            !!j6a && j6a.counted === true && j6a.legacySnapshot === false && !!j6b && j6b.counted === true && j6b.legacySnapshot === false,
            JSON.stringify({ a: j6a && j6a.counted, b: j6b && j6b.counted }));
        check('L3+ byCrew[جنوب 6] في مناوبة 183 ≥ 2 (الهوية القديمة محمية)',
            ((s183.byCrew || {})['جنوب 6'] || 0) >= 2, JSON.stringify(s183.byCrew));

        /* ── L4/L5: الذاكرة التحليلية على كامل النطاق — نفس القاعدة على كل الفرق ──
           (الأعداد المتوقعة محسوبة بقاعدة الاحتساب الدقيقة على بيانات الإنتاج:
           149 legacy مستبعدة، منها 25 كانت أصلًا بلا «تحرك» فلم تكن محتسبة —
           لذلك الإجمالي 174 ← 50 وليس 149 بالكامل) */
        const hist = await api('/api/analytics/incidents?from=2026-08-20&to=2026-08-25', { token: TK }).then(r => r.data);
        check('L4 الذاكرة التحليلية: byCrew[جنوب 8] = 2 على كامل النطاق (كانت 17)',
            ((hist.byCrew || {})['جنوب 8'] || 0) === 2, JSON.stringify({ j8: (hist.byCrew || {})['جنوب 8'] }));
        check('L4+ الذاكرة التحليلية: byCrew[سريع 2] = 4 (كانت 31 — الـ28 legacy مستبعدة بنفس القاعدة)',
            ((hist.byCrew || {})['سريع 2'] || 0) === 4, JSON.stringify({ s2: (hist.byCrew || {})['سريع 2'] }));
        const totalCounted = Object.values(hist.byCrew || {}).reduce((a, b) => a + b, 0);
        check('L5 إجمالي المشاركات المحتسبة على كامل النطاق = 50 (كان 174 — استبعاد كل الـlegacy المحتسبة سابقًا)',
            totalCounted === 50, 'total=' + totalCounted);

        /* ── L6: تقرير المناوبة /api/shifts/:id — نفس تعريف المحتسبة ── */
        const sh176 = await api('/api/shifts/' + SHIFT_176, { token: TK }).then(r => r.data);
        const rep176 = (sh176 && sh176.reports) || {};
        check('L6 تقرير المناوبة 176: CAD|جنوب 8 غائب أو عداده 0 (نفس التعريف)',
            !rep176['CAD|جنوب 8'] || (rep176['CAD|جنوب 8'].count || 0) === 0,
            JSON.stringify(rep176['CAD|جنوب 8'] || null));

        /* ── L7: لا حذف — السجلات وphases كما هي ── */
        const rtCountAfter = ro().prepare('SELECT COUNT(*) AS c FROM report_times').get().c;
        check('L7 عدد report_times ثابت (' + rtCountBefore + ') — لا حذف إطلاقًا', rtCountAfter === rtCountBefore);
        const legacyRowsAfter = ro().prepare(
            `SELECT t.id, t.phases FROM report_times t JOIN reports r ON r.id=t.report_id
             WHERE r.unit='جنوب 8' AND t.incident_number IS NOT NULL AND r.created_at < '2026-08-23 13:00:00'
               AND t.cad_unit_id IS NULL AND t.cad_run_unit_id IS NULL AND t.cad_unit_status IS NULL`).all();
        check('L7+ سجلات جنوب 8 الـ15 legacy محفوظة بـphases مطابقة حرفيًا (قيمة تدقيقية)',
            legacyRowsAfter.length === legacyRowsBefore.length
            && legacyRowsBefore.every(b => { const a = legacyRowsAfter.find(x => x.id === b.id); return a && a.phases === b.phases; }),
            'before=' + legacyRowsBefore.length + ' after=' + legacyRowsAfter.length);

        /* ── L8: مسار الكتابة الجديد سليم — مشاركة شرعية حديثة تُحسب طبيعيًا ── */
        const N8 = '9900' + String(Date.now()).slice(-4);
        const post = await api('/api/cad-reports', {
            method: 'POST', token: TK,
            body: { shift_id: SHIFT_184, number: N8, type: 'medical', source: 'cad-auto', crews: [
                { team: 'جنوب 9', phases: { 'قبول': '11:50:00 AM', 'التحرك': '11:51:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 2999, cadRunUnitId: 9299 }] }
        });
        const s184b = await sum(SHIFT_184);
        check('L8 مشاركة جديدة شرعية (بهوية CAD + تحرك) تُنشأ وتُحسب طبيعيًا',
            post.data && (post.data.addedCrews || []).indexOf('جنوب 9') !== -1
            && ((s184b.byCrew || {})['جنوب 9'] || 0) >= 1, JSON.stringify(post.data && post.data.addedCrews));
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n═══ النتيجة الإجمالية: ' + passed + ' ✅ / ' + failed + ' ❌ ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥 خطأ غير متوقع:', e); process.exit(1); });
