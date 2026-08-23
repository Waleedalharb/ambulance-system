/**
 * ═══ unit-lifecycle-test.js — اختبار قبول «قاعدة المشاركة الفعلية» (قرار المالك 2026-08-22) ═══
 * يثبت على خادم معزول (نسخة مؤقتة من قاعدة البيانات — لا يمس بيانات حقيقية) أن
 * مصدر حالة الوحدة هو unitRequestStatus + journeys (لا نص «وحدة ملغاة»):
 *  U1 بلاغ بفرقة واحدة A ← تُحسب مشاركة فعلية
 *  U2 بلاغ بفرقتين A ← تُحسبان كلتاهما والإجمالي بلاغ واحد فريد
 *  U3 سحب فرقة قبل المباشرة (B + لا وصول فعلي) ← لا تُحسب: مستبعدة من byCrew
 *     والعدّ، محفوظة في التفاصيل بـcancelKind=before-arrival، والإجمالي ثابت
 *  U4 إلغاء فرقة بعد المباشرة (B + وصول فعلي) ← تبقى محسوبة مشاركة وتُعلَّم
 *     after-arrival وتُعاد في cancelAfterArrivalCrews للمراجعة (مثال 1305710)
 *  U5 البلاغ ينتهي بعد ذلك ← يختفي من النشطة ويبقى تاريخيًا كاملًا بلا حذف
 *  U6 A الصريح من CAD يزيل علم withdrawn النصي (عودة فرقة سُحبت خطأً)
 *  U7 غياب cadUrs ← السلوك القائم لا يتغير إطلاقًا (نص الصفحة وحده)
 *  U8 قيمة urs غير معروفة ← تُهمَل بصدق (لا تخمين ولا تغيير)
 * التشغيل: node scripts/unit-lifecycle-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3098;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const NB = String(Date.now()).slice(-7); // أساس رقمي صرف — CAD_NUMBER_RE يقبل الأرقام فقط
const TMP_DIR = path.join(os.tmpdir(), 'cad-unit-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');
const TEST_KEY = 'unitkey-' + STAMP;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 200) : '')); }
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
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار دورة حياة الوحدة', active: true, createdAt: new Date().toISOString() }
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

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) { console.log('❌ الدخول فشل'); throw new Error('login'); }
        const sum = () => api('/api/cad-reports', { token: TK }).then(r => r.data);

        const s0 = await sum();
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;
        const canc0 = (s0.unitCancels && s0.unitCancels.beforeArrival) || 0;
        const cancA0 = (s0.unitCancels && s0.unitCancels.afterArrival) || 0;
        const PH_MOVE = { 'التحرك': '08:00 AM' };
        const PH_ARRIVE = { 'التحرك': '08:00 AM', 'البحث': '08:10 AM' };

        // ── U1: بلاغ بفرقة واحدة A ← تُحسب ──
        const N1 = '8' + NB + '1';
        let r = await post(TK, { number: N1, type: 'medical', crews: [{ team: 'جنوب 1', phases: PH_MOVE, cadUrs: 'A', cadReached: false }] });
        let s = await sum();
        check('U1 فرقة A واحدة تُحسب في byCrew (+1)', ((s.byCrew || {})['جنوب 1'] || 0) === c0('جنوب 1') + 1);
        let cw = crewOf(s, N1, 'جنوب 1');
        check('U1 المشاركة counted وبدون cancelKind', !!cw && cw.counted === true && cw.cancelKind === null && cw.cadUrs === 'A');

        // ── U2: بلاغ بفرقتين A ← كلتاهما والإجمالي بلاغ واحد ──
        const N2 = '8' + NB + '2';
        r = await post(TK, { number: N2, type: 'traffic', crews: [
            { team: 'جنوب 2', phases: PH_MOVE, cadUrs: 'A', cadReached: false },
            { team: 'جنوب 3', phases: PH_MOVE, cadUrs: 'A', cadReached: true }] });
        s = await sum();
        check('U2 الفرقتان A محتسبتان', ((s.byCrew || {})['جنوب 2'] || 0) === c0('جنوب 2') + 1 && ((s.byCrew || {})['جنوب 3'] || 0) === c0('جنوب 3') + 1);
        check('U2 الإجمالي ارتفع بلاغًا واحدًا فقط (فريد)', s.total === s0.total + 2, 'total=' + s.total + ' متوقع ' + (s0.total + 2));

        // ── U3: سحب فرقة قبل المباشرة (B بلا وصول) ← لا تُحسب ──
        const N3 = '8' + NB + '3';
        r = await post(TK, { number: N3, type: 'medical', crews: [
            { team: 'جنوب 4', phases: PH_ARRIVE, cadUrs: 'A', cadReached: true },
            { team: 'جنوب 5', phases: PH_MOVE, cadUrs: 'B', cadReached: false }] });
        s = await sum();
        check('U3 الفرقة A المحتسبة دخلت العدّ', ((s.byCrew || {})['جنوب 4'] || 0) === c0('جنوب 4') + 1);
        check('U3 الفرقة B (قبل المباشرة) خارج byCrew', ((s.byCrew || {})['جنوب 5'] || 0) === c0('جنوب 5'));
        cw = crewOf(s, N3, 'جنوب 5');
        check('U3 B محفوظة تاريخيًا: withdrawn + counted=false + before-arrival', !!cw && cw.withdrawn === true && cw.counted === false && cw.cancelKind === 'before-arrival' && cw.cadUrs === 'B');
        check('U3 عدّاد الإلغاء قبل المباشرة +1', ((s.unitCancels || {}).beforeArrival || 0) === canc0 + 1);
        const inc3 = incOf(s, N3);
        check('U3 البلاغ نفسه يبقى واحدًا بفرقتيه في التفاصيل', !!inc3 && (inc3.crews || []).length === 2);

        // ── U4: إلغاء بعد المباشرة (B مع وصول فعلي) ← تبقى محسوبة ──
        const N4 = '8' + NB + '4';
        r = await post(TK, { number: N4, type: 'injury', crews: [
            { team: 'جنوب 6', phases: PH_ARRIVE, cadUrs: 'A', cadReached: true },
            { team: 'سريع 1', phases: PH_ARRIVE, cadUrs: 'B', cadReached: true }] });
        check('U4 الاستجابة تُعيد cancelAfterArrivalCrews للمراجعة', (r.data && (r.data.cancelAfterArrivalCrews || []).includes('سريع 1')) === true, JSON.stringify(r.data).slice(0, 160));
        s = await sum();
        check('U4 الفرقة الملغاة بعد المباشرة محتسبة في byCrew (+1)', ((s.byCrew || {})['سريع 1'] || 0) === c0('سريع 1') + 1);
        cw = crewOf(s, N4, 'سريع 1');
        check('U4 counted=true وبدون withdrawn ومعلَّمة after-arrival', !!cw && cw.counted === true && cw.withdrawn === false && cw.cancelKind === 'after-arrival');
        check('U4 عدّاد الإلغاء بعد المباشرة +1', ((s.unitCancels || {}).afterArrival || 0) === cancA0 + 1);

        // ── U5: انتهاء البلاغ ← خارج النشطة وتاريخه كامل ──
        r = await post(TK, { number: N4, type: 'injury', status: 'closed', crews: [
            { team: 'جنوب 6', phases: PH_ARRIVE, cadUrs: 'A', cadReached: true },
            { team: 'سريع 1', phases: PH_ARRIVE, cadUrs: 'B', cadReached: true }] });
        s = await sum();
        const inc4 = incOf(s, N4);
        check('U5 البلاغ المنتهي خارج النشطة (status=closed, severity=null)', !!inc4 && inc4.status === 'closed' && inc4.severity === null);
        check('U5 تاريخه كامل: الفرقتان باقيتان بحالتيهما', !!inc4 && (inc4.crews || []).length === 2 &&
            (inc4.crews || []).some(c => c.unit === 'سريع 1' && c.cancelKind === 'after-arrival'));
        check('U5 الإجمالي التاريخي لم ينقص', s.total === s0.total + 4);

        // ── U6: A الصريح يزيل withdrawn النصي (عودة من سحب خطأ) ──
        const N6 = '8' + NB + '6';
        await post(TK, { number: N6, type: 'medical', crews: [{ team: 'جنوب 7', phases: PH_MOVE, withdrawn: true }] });
        s = await sum();
        check('U6 فرقة مسحوبة نصيًا مستبعدة أولًا', ((s.byCrew || {})['جنوب 7'] || 0) === c0('جنوب 7'));
        r = await post(TK, { number: N6, type: 'medical', crews: [{ team: 'جنوب 7', phases: PH_MOVE, cadUrs: 'A', cadReached: false }] });
        s = await sum();
        cw = crewOf(s, N6, 'جنوب 7');
        check('U6 وصول A من CAD يعيدها للعدّ (مصدر الحقيقة)', !!cw && cw.withdrawn === false && cw.counted === true && ((s.byCrew || {})['جنوب 7'] || 0) === c0('جنوب 7') + 1);

        // ── U7: غياب cadUrs ← السلوك القائم لا يتغير ──
        const N7 = '8' + NB + '7';
        await post(TK, { number: N7, type: 'medical', crews: [
            { team: 'جنوب 8', phases: PH_MOVE, withdrawn: true },
            { team: 'جنوب 9', phases: PH_MOVE }] });
        s = await sum();
        check('U7 withdrawn النصي ما زال يستبعد (بلا cadUrs)', ((s.byCrew || {})['جنوب 8'] || 0) === c0('جنوب 8'));
        check('U7 المشاركة بلا علم ولا urs تُحسب كما كانت', ((s.byCrew || {})['جنوب 9'] || 0) === c0('جنوب 9') + 1);
        cw = crewOf(s, N7, 'جنوب 8');
        check('U7 لا cancelKind بلا urs (لا اختلاق حالة)', !!cw && cw.cancelKind === null && cw.cadUrs === null);

        // ── U8: قيمة urs غير معروفة ← تُهمَل بصدق ──
        const N8 = '8' + NB + '8';
        r = await post(TK, { number: N8, type: 'other', crews: [{ team: 'جنوب 10', phases: PH_MOVE, cadUrs: 'X', cadReached: false }] });
        s = await sum();
        cw = crewOf(s, N8, 'جنوب 10');
        check('U8 قيمة urs غريبة لا تغيّر شيئًا (تُحسب كالمعتاد)', !!cw && cw.counted === true && cw.cadUrs === null && ((s.byCrew || {})['جنوب 10'] || 0) === c0('جنوب 10') + 1);

        // ── تتبع المصدر في قاعدة البيانات نفسها ──
        const vdb = new Database(TMP_DB, { readonly: true });
        const rowB = vdb.prepare(`SELECT cad_unit_status, cad_reached, withdrawn FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=? AND r.unit='جنوب 5'`).get(N3);
        const rowA = vdb.prepare(`SELECT cad_unit_status, cad_reached, withdrawn FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=? AND r.unit='سريع 1'`).get(N4);
        vdb.close();
        check('DB: إلغاء قبل المباشرة موثق (B/0/withdrawn=1)', !!rowB && rowB.cad_unit_status === 'B' && rowB.cad_reached === 0 && rowB.withdrawn === 1, JSON.stringify(rowB));
        check('DB: إلغاء بعد المباشرة موثق (B/1/withdrawn=0)', !!rowA && rowA.cad_unit_status === 'B' && rowA.cad_reached === 1 && rowA.withdrawn === 0, JSON.stringify(rowA));

        // ── U9: وسم المصدر (المرحلة A — 2026-08-23): cad-auto يُخزَّن، والافتراضي cad-oneclick ──
        const N9 = '8' + NB + '9';
        await post(TK, { number: N9, type: 'medical', source: 'cad-auto', crews: [{ team: 'جنوب 1', phases: PH_MOVE, cadUrs: 'A' }] });
        const vdb2 = new Database(TMP_DB, { readonly: true });
        const srcAuto = vdb2.prepare('SELECT source FROM incident_registry WHERE number=?').get(N9);
        const srcManual = vdb2.prepare('SELECT source FROM incident_registry WHERE number=?').get(N1);
        vdb2.close();
        check('U9 التسجيل التلقائي يُوسم cad-auto في السجل', !!srcAuto && srcAuto.source === 'cad-auto', JSON.stringify(srcAuto));
        check('U9 غياب الوسم يبقى cad-oneclick (السلوك القائم)', !!srcManual && srcManual.source === 'cad-oneclick', JSON.stringify(srcManual));

        // ── U10: هوية الوحدة الثابتة (2026-08-23): unitId/runUnitId يُخزَّنان ويُعرضان ──
        const N10 = NB + '10';
        await post(TK, { number: N10, type: 'medical', crews: [
            { team: 'جنوب 6', phases: PH_MOVE, cadUrs: 'A', cadReached: false, cadUnitId: 1460, cadRunUnitId: 2518906 },
            { team: 'سريع 1', phases: PH_MOVE, cadUrs: 'B', cadReached: false, cadUnitId: 1729, cadRunUnitId: 2518898 }] });
        s = await sum();
        const c10a = crewOf(s, N10, 'جنوب 6'), c10b = crewOf(s, N10, 'سريع 1');
        check('U10 معرفا الوحدة يظهران في تفاصيل الإحصائية', !!c10a && c10a.cadUnitId === 1460 && c10a.cadRunUnitId === 2518906
            && !!c10b && c10b.cadUnitId === 1729 && c10b.cadRunUnitId === 2518898, JSON.stringify([c10a, c10b]).slice(0, 180));
        check('U10 Journey مستقلة: A محتسبة وB مستبعدة في نفس البلاغ', !!c10a && c10a.counted === true && !!c10b && c10b.counted === false && c10b.cancelKind === 'before-arrival');
        const vdb3 = new Database(TMP_DB, { readonly: true });
        const rowIds = vdb3.prepare(`SELECT cad_unit_id, cad_run_unit_id FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=? AND r.unit='جنوب 6'`).get(N10);
        vdb3.close();
        check('U10 المعرفان موثقان في القاعدة', !!rowIds && rowIds.cad_unit_id === 1460 && rowIds.cad_run_unit_id === 2518906, JSON.stringify(rowIds));
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n══ النتيجة: ' + passed + ' نجح / ' + failed + ' فشل ══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(1); });
