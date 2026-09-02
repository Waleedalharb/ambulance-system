/**
 * ═══ اختبار L-1 API — incident-lookup-api-test.js ═══
 * اعتماد المالك 2026-09-01 — مواصفة FORMS-LOOKUP-L1-SPEC.md §4.1 (10 فحوص):
 *   1) 200 + كمال المخطط (بلاغ موثق 1310627)
 *   2) القيم تطابق صفوف DB حرفيًا (قابلية التتبع)
 *   3) تكرار الرقم: الأحدث افتراضيًا + otherShifts (1300370)
 *   4) 404 لرقم غير موجود
 *   5) 400 لصيغ غير صالحة
 *   6) 401 بلا جلسة + 403 لجلسة بلا ops.forms
 *   7) timeCompleteness=missing لبلاغ بلا cad_created_at (99900127)
 *   8) مشاركة ملغاة يدويًا: counted:false + manualCancelled:true + خارج «الأسرع»
 *      — إثبات بالقيمة: عينة اصطناعية في قاعدة temp (زمن الملغاة أدنى من المحتسبة)
 *      + بلاغ حقيقي 1310420 (فيه ملغاة يدويًا ومحتسبة معًا)
 *   9) caller_number غائب من الرد
 *  10) انحدار: traceability + nav-perms أخضران
 * العزل: VACUUM INTO + DATA_DIR مؤقت. التشغيل: node scripts/incident-lookup-api-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'l1-api-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'l1-api-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3101; // بعيدًا عن 3099 (map-history-traceability) و 3096/3097 (اختبارات الواجهة) — لا تصادم عند الانحدار
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
async function login(username, password) {
    const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.accessToken || j.access_token || j.token || null;
}
async function api(path_, token) {
    const r = await fetch(BASE + path_, { headers: token ? { 'Authorization': 'Bearer ' + token } : {} });
    let body = null;
    try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}

(async () => {
    // ── قاعدة temp + زرع عينة الإلغاء اليدوي الاصطناعية + كلمة مرور user ──
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }
    const tmp = new Database(TMP_DB);
    // عينة L-1 الاصطناعية (قاعدة temp فقط): بلاغ 90000001 — فرقة ملغاة يدويًا
    // بزمن 3.0 (أدنى) + فرقة محتسبة بزمن 12.0 ⇒ الإثبات: bestArrivalMin=12.0
    tmp.prepare(`INSERT INTO shifts (id, shift_name, shift_date, status, created_at, updated_at)
        VALUES (999999999999, 'مناوبة-اختبار-L1', '2026-09-01', 'archived', '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z')`).run();
    tmp.prepare(`INSERT INTO incident_registry (shift_id, number, code, type, source, created_at, cad_created_at, address, district, status)
        VALUES (999999999999, '90000001', '32B03', 'medical', 'l1-fixture', '2026-09-01T09:00:00.000Z', '01/09/2026 12:00:00 PM', 'حي الاختبار', 'الاختبار', 'active')`).run();
    const now = '2026-09-01T09:05:00.000Z';
    const rep1 = tmp.prepare(`INSERT INTO reports (center, unit, count, created_at, shift_id) VALUES ('اختبار', 'فرقة-محتسبة', 1, ?, 999999999999)`).run(now);
    const rep2 = tmp.prepare(`INSERT INTO reports (center, unit, count, created_at, shift_id) VALUES ('اختبار', 'فرقة-ملغاة', 1, ?, 999999999999)`).run(now);
    tmp.prepare(`INSERT INTO report_times (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min, withdrawn, cad_unit_status, cad_reached, cad_unit_id, cad_run_unit_id, manual_cancelled)
        VALUES (?, ?, 'medical', '90000001', ?, 12.0, 4.0, 0, 'ع', 1, 9001, 90011, 0)`)
        .run(rep1.lastInsertRowid, now, JSON.stringify({ 'قبول': '12:01:00 PM', 'التحرك': '12:02:00 PM', 'البحث': '12:12:00 PM', 'العلاج': '12:16:00 PM' }));
    tmp.prepare(`INSERT INTO report_times (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min, withdrawn, cad_unit_status, cad_reached, cad_unit_id, cad_run_unit_id, manual_cancelled, manual_cancelled_by, manual_cancelled_at, manual_cancel_reason)
        VALUES (?, ?, 'medical', '90000001', ?, 3.0, 1.0, 0, 'ع', 1, 9002, 90021, 1, 'مختبر L-1', ?, 'إلغاء اختباري')`)
        .run(rep2.lastInsertRowid, now, JSON.stringify({ 'قبول': '12:00:30 PM', 'التحرك': '12:01:00 PM', 'البحث': '12:03:00 PM' }), now);
    // حساب مشاهد اصطناعي في نسخة temp من users.json فقط (الدخول يقرأ JSON لا
    // DB) — دوره user بلا ops.forms، لفحص 403. لا يمس الملف الحقيقي إطلاقًا.
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
    const hash = bcrypt.hashSync('l1test403', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push({ id: 'l1-viewer-fixture', user_id: 'l1-viewer-fixture', username: 'l1viewer', password: hash, name: 'مشاهد اختبار L-1', role: 'user', isActive: true });
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    tmp.close();

    console.log('🚀 خادم معزول على ' + PORT + ' — اختبار L-1 API');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const token = await login('4252', '4252');
        check('تسجيل دخول admin (4252)', !!token);

        // ── 1) 200 + كمال المخطط ──
        const r1 = await api('/api/incidents/lookup?number=1310627', token);
        const b1 = r1.body || {};
        check('1) 200 + found + الحقول الأساسية', r1.status === 200 && b1.found === true && b1.number === '1310627'
            && b1.incident && b1.incident.cadCreatedAtRaw && Array.isArray(b1.units) && b1.units.length === 2
            && b1.timeCompleteness && b1.timeCompleteness.state === 'complete',
            'status=' + r1.status + ' ' + JSON.stringify(b1).slice(0, 200));

        // ── 2) القيم تطابق DB حرفيًا ──
        const ref = new Database(TMP_DB, { readonly: true });
        const dbRows = ref.prepare(`SELECT r.unit, t.resp_arrival_min, t.resp_mubashara_min, t.manual_cancelled
            FROM report_times t JOIN reports r ON r.id = t.report_id
            WHERE t.incident_number = '1310627' AND r.shift_id = ?`).all(b1.shiftId);
        ref.close();
        const byUnit = {}; (b1.units || []).forEach(u => { byUnit[u.unit] = u; });
        const exact = dbRows.every(d => byUnit[d.unit]
            && byUnit[d.unit].respArrivalMin === d.resp_arrival_min
            && byUnit[d.unit].respMubasharaMin === d.resp_mubashara_min);
        check('2) قيم الأزمنة لكل فرقة تطابق report_times حرفيًا', exact && b1.bestArrivalMin === 6.8,
            'DB=' + JSON.stringify(dbRows) + ' API=' + JSON.stringify(b1.units));

        // ── 3) التكرار: الأحدث افتراضيًا + otherShifts ──
        const r3 = await api('/api/incidents/lookup?number=1300370', token);
        const b3 = r3.body || {};
        check('3) رقم مكرر: otherShifts غير فارغة والافتراضي هو الأحدث',
            r3.status === 200 && Array.isArray(b3.otherShifts) && b3.otherShifts.length >= 1
            && b3.otherShifts.every(s => s.shiftId !== b3.shiftId),
            JSON.stringify({ shiftId: b3.shiftId, other: b3.otherShifts }));

        // ── 4) 404 ──
        const r4 = await api('/api/incidents/lookup?number=0000000', token);
        check('4) 404 + found:false لرقم غير موجود', r4.status === 404 && r4.body && r4.body.found === false, 'status=' + r4.status);

        // ── 5) 400 صيغ غير صالحة ──
        const bad = ['abc', '12', '13 0627', '٠١٢٣'];
        let all400 = true;
        for (const n of bad) { const r = await api('/api/incidents/lookup?number=' + encodeURIComponent(n), token); if (r.status !== 400) all400 = false; }
        const rNoParam = await api('/api/incidents/lookup', token);
        check('5) 400 لكل الصيغ غير الصالحة + غياب المعامل', all400 && rNoParam.status === 400, '');

        // ── 6) 401 + 403 ──
        const r401 = await api('/api/incidents/lookup?number=1310627', null);
        const userToken = await login('l1viewer', 'l1test403');
        const r403 = userToken ? await api('/api/incidents/lookup?number=1310627', userToken) : { status: -1 };
        check('6) 401 بلا جلسة + 403 لدور user بلا ops.forms', r401.status === 401 && r403.status === 403,
            'noauth=' + r401.status + ' user=' + r403.status);

        // ── 7) timeCompleteness=missing (99900127 بلا cad_created_at) ──
        const r7 = await api('/api/incidents/lookup?number=99900127', token);
        const b7 = r7.body || {};
        check('7) بلاغ بلا cad_created_at: state=missing ومذكور في missing[]',
            r7.status === 200 && b7.timeCompleteness && b7.timeCompleteness.state === 'missing'
            && b7.timeCompleteness.missing.indexOf('cad_created_at') !== -1
            && b7.incident && b7.incident.cadCreatedAtRaw === null,
            JSON.stringify(b7.timeCompleteness));

        // ── 8) الملغاة يدويًا: موسومة ومستبعدة من «الأسرع» — إثبات بالقيمة ──
        const r8 = await api('/api/incidents/lookup?number=90000001', token);
        const b8 = r8.body || {};
        const fxCounted = (b8.units || []).find(u => u.unit === 'فرقة-محتسبة');
        const fxCancelled = (b8.units || []).find(u => u.unit === 'فرقة-ملغاة');
        check('8أ) عينة: الملغاة counted:false + manualCancelled:true + سبب',
            !!fxCancelled && fxCancelled.counted === false && fxCancelled.flags.manualCancelled === true
            && fxCancelled.flags.manualCancelReason === 'إلغاء اختباري'
            && fxCancelled.respArrivalMin === 3.0,
            JSON.stringify(fxCancelled));
        check('8ب) عينة: المحتسبة counted:true وbestArrivalMin=12.0 لا 3.0',
            !!fxCounted && fxCounted.counted === true && b8.bestArrivalMin === 12.0,
            'best=' + b8.bestArrivalMin);
        const r8r = await api('/api/incidents/lookup?number=1310420', token);
        const b8r = r8r.body || {};
        const realCancelled = (b8r.units || []).filter(u => u.flags && u.flags.manualCancelled);
        const realCounted = (b8r.units || []).filter(u => u.counted);
        check('8ج) بلاغ حقيقي 1310420: الملغاة تظهر موسومة وbestArrivalMin من المحتسبة فقط',
            r8r.status === 200 && realCancelled.length >= 1 && realCancelled.every(u => u.counted === false)
            && realCounted.length >= 1 && b8r.bestArrivalMin === 20,
            'cancelled=' + realCancelled.length + ' best=' + b8r.bestArrivalMin);

        // ── 9) caller_number غائب ──
        const dump = JSON.stringify(b1) + JSON.stringify(b8) + JSON.stringify(b8r);
        check('9) caller_number غائب من كل الردود', dump.indexOf('caller') === -1 && !b1.incident.caller_number, '');

        // ── 10) انحدار ──
        for (const t of ['map-history-traceability-test', 'nav-perms-test']) {
            const p = path.join(ROOT, 'scripts', t + '.js');
            if (!fs.existsSync(p)) { check('10) انحدار ' + t, false, 'الملف غير موجود'); continue; }
            const rr = spawn(process.execPath, [p], { cwd: ROOT, env: { ...process.env } });
            let out = '';
            rr.stdout.on('data', d => { out += d; });
            rr.stderr.on('data', d => { out += d; });
            const code = await new Promise(res => rr.on('close', res));
            check('10) انحدار ' + t, code === 0, out.slice(-160));
        }

        console.log('\n════════════════ نتيجة L-1 API: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
    } finally {
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('⚠️ انهيار:', e.message); process.exit(1); });
