/**
 * ═══ journey-separation-test.js — اختبار قبول «Journey لكل وحدة + التصحيح» (قرار المالك 2026-08-23) ═══
 * يثبت على خادم معزول (نسخة مؤقتة من قاعدة البيانات — لا يمس بيانات حقيقية) أن:
 *  J1 بلاغ جديد بفرقتين ← لكل فرقة Journey الخاصة بها فقط، ولا نسخ بينهما
 *  J2 بلاغ قائم تتطور Journey إحدى فرقه ← نفس المشاركة تُحدَّث (لا سجل جديد)
 *     والفرقة الأخرى لا تُمس
 *  J3 فرقة جديدة تنضم لبلاغ قائم ← تُضاف مستقلة بأوقاتها دون لمس أوقات السابقات
 *  J4 فرقة من CAD غير مدرجة في التكميل ← تُسجَّل، وعند وصولها لاحقًا بمسمى مختلف
 *     بنفس runUnitId تُربط بسجلها القائم (لا فرقة ثانية)
 *  J5 تصحيح 1307875: لقطة مشتركة خاطئة مخزنة ← Journey الموثوقة (cad-detail)
 *     تستبدلها: سريع 1 بلا بحث/علاج/نقل + B ملغاة قبل المباشرة مستبعدة،
 *     وجنوب 6 بأوقاتها الخاصة محتسبة — والتصحيح موثق (correctedCrews)
 * التشغيل: node scripts/journey-separation-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const NB = String(Date.now()).slice(-7);
const TMP_DIR = path.join(os.tmpdir(), 'cad-journey-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');
const TEST_KEY = 'journeykey-' + STAMP;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
}

async function api(p, { method = 'GET', token, key, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (key) headers['X-Integration-Key'] = key;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}
const post = (token, body) => api('/api/cad-reports', { method: 'POST', token, body });
const crewOf = (sum, num, unit) => {
    const inc = (sum.incidents || []).find(i => i.number === num);
    return inc ? (inc.crews || []).find(c => c.unit === unit) || null : null;
};
const incOf = (sum, num) => (sum.incidents || []).find(i => i.number === num) || null;

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار فصل Journey', active: true, createdAt: new Date().toISOString() }
    ]));
    const probe = new Database(TMP_DB, { readonly: true });
    const active = probe.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    probe.close();
    if (!active) { console.log('❌ لا مناوبة نشطة في النسخة'); process.exit(1); }

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    const dbPhases = (num, unit) => {
        const v = new Database(TMP_DB, { readonly: true });
        const row = v.prepare(`SELECT t.phases, t.withdrawn, t.cad_unit_status FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=? AND r.unit=?`).get(num, unit);
        const cnt = v.prepare(`SELECT COUNT(*) c FROM report_times WHERE incident_number=?`).get(num).c;
        v.close();
        return { phases: row && row.phases ? JSON.parse(row.phases) : null, row, count: cnt };
    };

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) { console.log('❌ الدخول فشل'); throw new Error('login'); }
        const sum = () => api('/api/cad-reports', { token: TK }).then(r => r.data);
        const s0 = await sum();
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;

        // Journey كل وحدة كما يقرؤها الـOverlay من journeys[] (phasesSource='cad-detail')
        const J_S6 = { 'قبول': '10:07:08 AM', 'التحرك': '10:07:11 AM', 'الاستجابة': '10:07:50 AM', 'البحث': '10:13:16 AM' };
        const J_R1 = { 'قبول': '10:02:00 AM', 'التحرك': '10:02:47 AM', 'الاستجابة': '10:03:13 AM' };

        // ── J1: بلاغ جديد بفرقتين — Journey مختلفة لكل فرقة ──
        const N1 = '9' + NB + '1';
        await post(TK, { number: N1, type: 'medical', crews: [
            { team: 'جنوب 6', phases: J_S6, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: true, cadUnitId: 1460, cadRunUnitId: 2518906 },
            { team: 'سريع 1', phases: J_R1, phasesSource: 'cad-detail', cadUrs: 'B', cadReached: false, cadUnitId: 1729, cadRunUnitId: 2518898 }] });
        let d1a = dbPhases(N1, 'جنوب 6'), d1b = dbPhases(N1, 'سريع 1');
        check('J1 جنوب 6 خُزّنت بأوقاتها الخاصة فقط', JSON.stringify(d1a.phases) === JSON.stringify(J_S6), JSON.stringify(d1a.phases));
        check('J1 سريع 1 خُزّنت بأوقاتها الخاصة فقط (بلا بحث)', JSON.stringify(d1b.phases) === JSON.stringify(J_R1), JSON.stringify(d1b.phases));
        check('J1 سريع 1 ملغاة قبل المباشرة (B بلا علاج)', d1b.row && d1b.row.withdrawn === 1 && d1b.row.cad_unit_status === 'B', JSON.stringify(d1b.row));
        let s = await sum();
        check('J1 جنوب 6 محتسبة وسريع 1 مستبعدة من byCrew', ((s.byCrew || {})['جنوب 6'] || 0) === c0('جنوب 6') + 1 && ((s.byCrew || {})['سريع 1'] || 0) === c0('سريع 1'));

        // ── J2: بلاغ قائم تتطور Journey إحدى فرقه ← نفس المشاركة تُحدَّث ──
        const J_S6_v2 = Object.assign({}, J_S6, { 'العلاج': '10:20:56 AM' });
        let r = await post(TK, { number: N1, type: 'medical', crews: [
            { team: 'جنوب 6', phases: J_S6_v2, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: true, cadUnitId: 1460, cadRunUnitId: 2518906 },
            { team: 'سريع 1', phases: J_R1, phasesSource: 'cad-detail', cadUrs: 'B', cadReached: false, cadUnitId: 1729, cadRunUnitId: 2518898 }] });
        let d2a = dbPhases(N1, 'جنوب 6'), d2b = dbPhases(N1, 'سريع 1');
        check('J2 لا سجل جديد — ما زال مشاركتان فقط', d2a.count === 2, 'count=' + d2a.count);
        check('J2 جنوب 6 اكتملت بالعلاج في نفس السجل', JSON.stringify(d2a.phases) === JSON.stringify(J_S6_v2), JSON.stringify(d2a.phases));
        check('J2 سريع 1 لم تُمس أوقاتها', JSON.stringify(d2b.phases) === JSON.stringify(J_R1), JSON.stringify(d2b.phases));
        check('J2 التصحيح موثق: correctedCrews تضم جنوب 6 فقط', r.data && (r.data.correctedCrews || []).some(c => c.team === 'جنوب 6')
            && !(r.data.correctedCrews || []).some(c => c.team === 'سريع 1'), JSON.stringify(r.data && r.data.correctedCrews));

        // ── J3: فرقة جديدة تنضم لاحقًا لبلاغ قائم ──
        const J_S3 = { 'قبول': '10:30:00 AM', 'التحرك': '10:31:00 AM' };
        await post(TK, { number: N1, type: 'medical', crews: [
            { team: 'جنوب 6', phases: J_S6_v2, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: true, cadUnitId: 1460, cadRunUnitId: 2518906 },
            { team: 'سريع 1', phases: J_R1, phasesSource: 'cad-detail', cadUrs: 'B', cadReached: false, cadUnitId: 1729, cadRunUnitId: 2518898 },
            { team: 'جنوب 3', phases: J_S3, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 1503, cadRunUnitId: 2518950 }] });
        let d3a = dbPhases(N1, 'جنوب 6'), d3b = dbPhases(N1, 'سريع 1'), d3c = dbPhases(N1, 'جنوب 3');
        check('J3 الفرقة الجديدة أُضيفت مستقلة بأوقاتها (3 مشاركات)', d3c.count === 3 && JSON.stringify(d3c.phases) === JSON.stringify(J_S3), 'count=' + d3c.count);
        check('J3 أوقات الفرقتين السابقتين لم تتغير', JSON.stringify(d3a.phases) === JSON.stringify(J_S6_v2) && JSON.stringify(d3b.phases) === JSON.stringify(J_R1));
        s = await sum();
        const inc1 = incOf(s, N1);
        check('J3 الإجمالي ثابت — نفس البلاغ الواحد بثلاث فرق', !!inc1 && (inc1.crews || []).length === 3 && s.total === s0.total + 1, 'total=' + s.total);

        // ── J4: فرقة من CAD غير مدرجة في التكميل ← تُسجَّل ثم تُربط بلا تكرار ──
        const N4 = '9' + NB + '4';
        await post(TK, { number: N4, type: 'medical', source: 'cad-auto', crews: [
            { team: 'سريع 7', phases: { 'قبول': '11:00:00 AM', 'التحرك': '11:02:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 1707, cadRunUnitId: 900107 }] });
        s = await sum();
        check('J4 الفرقة غير المدرجة سُجّلت من CAD واحتُسبت', ((s.byCrew || {})['سريع 7'] || 0) === c0('سريع 7') + 1, JSON.stringify(s.byCrew && s.byCrew['سريع 7']));
        // لاحقًا ظهرت في التكميل ووصلت بمسمى مختلف قليلًا لكن بنفس runUnitId
        r = await post(TK, { number: N4, type: 'medical', crews: [
            { team: 'سريع 7 (تكميل)', phases: { 'قبول': '11:00:00 AM', 'التحرك': '11:02:00 AM', 'البحث': '11:09:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 1707, cadRunUnitId: 900107 }] });
        const d4 = dbPhases(N4, 'سريع 7');
        check('J4 لا فرقة ثانية — نفس المشاركة بُقيت وحيدة', d4.count === 1, 'count=' + d4.count);
        check('J4 الربط بهوية الوحدة موثق (linkedCrews)', r.data && (r.data.linkedCrews || []).some(l => l.from === 'سريع 7' && l.to === 'سريع 7 (تكميل)'), JSON.stringify(r.data && r.data.linkedCrews));
        check('J4 Journey تقدمت على نفس السجل (البحث أُضيف)', !!d4.phases && d4.phases['البحث'] === '11:09:00 AM', JSON.stringify(d4.phases));
        s = await sum();
        check('J4 العدّ لم يتضاعف بعد الربط', ((s.byCrew || {})['سريع 7'] || 0) === c0('سريع 7') + 1 && ((s.byCrew || {})['سريع 7 (تكميل)'] || 0) === 0);

        // ── J5: تصحيح 1307875 — لقطة مشتركة خاطئة ← Journey الموثوقة تستبدلها ──
        const N5 = '9' + NB + '5';
        const WRONG_SHARED = { 'قبول': '10:02:00 AM', 'التحرك': '10:02:47 AM', 'البحث': '10:13:16 AM', 'العلاج': '10:20:56 AM', 'النقل': '10:33:15 AM' };
        // الحالة الخاطئة كما في القاعدة الآن: نفس اللقطة للفرقتين وكلتاهما A
        await post(TK, { number: N5, type: 'injury', crews: [
            { team: 'جنوب 6', phases: WRONG_SHARED, cadUrs: 'A', cadReached: false, cadUnitId: 1460, cadRunUnitId: 2518906 },
            { team: 'سريع 1', phases: WRONG_SHARED, cadUrs: 'A', cadReached: false, cadUnitId: 1729, cadRunUnitId: 2518898 }] });
        const preA = dbPhases(N5, 'سريع 1');
        check('J5 تهيئة: اللقطة الخاطئة مخزنة فعلًا (محاكاة الحالة الحالية)', !!preA.phases && preA.phases['العلاج'] === '10:20:56 AM' && preA.row.withdrawn === 0);
        // وصول Journey الموثوقة من detail (ما سيرسله الـOverlay المُصلح عند فتح البلاغ)
        const J_S6_FULL = { 'قبول': '10:07:08 AM', 'التحرك': '10:07:11 AM', 'الاستجابة': '10:07:50 AM', 'البحث': '10:13:16 AM', 'العلاج': '10:20:56 AM', 'النقل': '10:33:15 AM' };
        r = await post(TK, { number: N5, type: 'injury', crews: [
            { team: 'جنوب 6', phases: J_S6_FULL, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: true, cadUnitId: 1460, cadRunUnitId: 2518906 },
            { team: 'سريع 1', phases: J_R1, phasesSource: 'cad-detail', cadUrs: 'B', cadReached: false, cadUnitId: 1729, cadRunUnitId: 2518898 }] });
        const d5a = dbPhases(N5, 'جنوب 6'), d5b = dbPhases(N5, 'سريع 1');
        check('J5 جنوب 6 صُحّحت لأوقاتها الخاصة (قبول 10:07:08 لا 10:02:00)', JSON.stringify(d5a.phases) === JSON.stringify(J_S6_FULL), JSON.stringify(d5a.phases));
        check('J5 سريع 1 صُحّحت: لا بحث ولا علاج ولا نقل', JSON.stringify(d5b.phases) === JSON.stringify(J_R1), JSON.stringify(d5b.phases));
        check('J5 سريع 1 أصبحت B ملغاة قبل المباشرة (withdrawn)', d5b.row && d5b.row.withdrawn === 1 && d5b.row.cad_unit_status === 'B', JSON.stringify(d5b.row));
        check('J5 التصحيح موثق للفرقتين (correctedCrews + اللقطة القديمة محفوظة للتدقيق)', r.data && (r.data.correctedCrews || []).length === 2
            && (r.data.correctedCrews || []).every(c => typeof c.oldPhases === 'string' && c.oldPhases.includes('10:20:56')), JSON.stringify(r.data && r.data.correctedCrews).slice(0, 200));
        s = await sum();
        const cw5a = crewOf(s, N5, 'جنوب 6'), cw5b = crewOf(s, N5, 'سريع 1');
        check('J5 جنوب 6 محتسبة وسريع 1 خارج byCrew بعد التصحيح', !!cw5a && cw5a.counted === true && !!cw5b && cw5b.counted === false && cw5b.cancelKind === 'before-arrival'
            && ((s.byCrew || {})['سريع 1'] || 0) === c0('سريع 1'));
        check('J5 لا سجلات جديدة أثناء التصحيح — مشاركتان فقط', d5b.count === 2, 'count=' + d5b.count);

        // ── J6: بلا phasesSource ← السلوك القائم (استكمال الفراغات فقط، بلا استبدال) ──
        const N6 = '9' + NB + '6';
        await post(TK, { number: N6, type: 'medical', crews: [{ team: 'جنوب 2', phases: { 'التحرك': '09:00:00 AM' } }] });
        await post(TK, { number: N6, type: 'medical', crews: [{ team: 'جنوب 2', phases: { 'التحرك': '09:05:00 AM', 'البحث': '09:12:00 AM' } }] });
        const d6 = dbPhases(N6, 'جنوب 2');
        check('J6 بلا cad-detail: القيمة الموجودة لا تُستبدل والفراغ يُملأ فقط', !!d6.phases && d6.phases['التحرك'] === '09:00:00 AM' && d6.phases['البحث'] === '09:12:00 AM', JSON.stringify(d6.phases));
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n══ النتيجة: ' + passed + ' نجح / ' + failed + ' فشل ══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
