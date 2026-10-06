// ═══ E-8 (FSS) §4: اختبارات التزامن المتقاطع — Flex ⇄ Swap / Leave / roster change ═══
// بيئة معزولة (VACUUM + users.json مؤقتان). يثبت: لا تطبيق مزدوج، لا صف رسمي
// متعارض، وفشل أي مسار يكون Fail-Safe مع الحفاظ على البيانات:
//  A) Flex حيّ ← Swap يُطبَّق أولًا ← قبول عرض Flex يجب أن يفشل بأمان
//     (FLEX_ROSTER_CHANGED ← تصعيد ← اعتماد المسؤول يفشل أيضًا بنفس الحارس)
//     ونتيجة الـSwap تبقى كما هي بلا أي تعديل جزئي من Flex.
//  B) Flex طُبِّق ← Swap على التاريخ القديم = 404 (لا مسارًا متقادمًا).
//  C) Flex + إجازة معتمدة على يوم بديل ← E-4 يستبعده ويختار البديل التالي.
//  D) تقديم Flex وSwap متزامنان على نفس المناوبة ← ناجح واحد + فشل آمن للآخر،
//     وإن نجحا معًا (سباق) فحارس E-6 النهائي يمنع التطبيق المزدوج.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3106;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e8c-'));
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
let server = null;

function api(method, url, body, token) {
    return new Promise((resolve, reject) => {
        const u = new URL(BASE + url);
        const data = body ? JSON.stringify(body) : null;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {});
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(buf); } catch (e) {}
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json, text: buf });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
function dbAll(sql, params) {
    const Database = require('better-sqlite3');
    const d = new Database(TMP_DB, { readonly: true });
    const rows = d.prepare(sql).all(...(params || []));
    d.close();
    return rows;
}
function dbRun(sql, params) {
    const Database = require('better-sqlite3');
    const d = new Database(TMP_DB);
    d.pragma('busy_timeout = 8000');
    d.prepare(sql).run(...(params || []));
    d.close();
}
function riyadhOffset(n) {
    const p = TimeRiyadh.riyadhParts(new Date());
    const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + n));
    return d.toISOString().slice(0, 10);
}
function startServer() {
    return new Promise((resolve, reject) => {
        const env = Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' });
        server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        server.stdout.on('data', d => log += d);
        server.stderr.on('data', d => log += d);
        let attempts = 0;
        const tick = () => {
            http.get(BASE + '/health', (res) => {
                if (res.statusCode === 200) { res.resume(); return resolve(); }
                res.resume(); retry();
            }).on('error', retry);
        };
        const retry = () => {
            if (++attempts > 80) { console.error('server never ready. Log tail:\n' + log.slice(-3000)); return reject(new Error('boot failed')); }
            setTimeout(tick, 500);
        };
        tick();
    });
}
function stopServer() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.once('exit', () => { server = null; resolve(); });
        server.kill();
        setTimeout(resolve, 5000);
    });
}
async function login(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password });
    if (!r.data || !r.data.accessToken) throw new Error('login failed: ' + username);
    return r.data.accessToken;
}

async function main() {
    console.log('═══ E-8 CONCURRENCY TEST — Flex ⇄ Swap / Leave / roster change ═══');

    // ═══ التهيئة المعزولة ═══
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (['DEMO101', 'DEMO102', 'DEMO103'].includes(u.username)) u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    for (const un of ['DEMO101', 'DEMO102', 'DEMO103']) {
        const u = users.find(x => x.username === un);
        dbRun('DELETE FROM user_permissions WHERE user_id = ? AND permission_key = ?', [u.id, 'ops.my_portal']);
        dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e8c-test')", [u.id]);
    }
    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;
    dbRun("UPDATE employees SET is_active = 0 WHERE employee_code NOT IN ('DEMO101','DEMO102','DEMO103')");
    dbRun('DELETE FROM team_assignments WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    const insTA = 'INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, ?, ?, ?, ?)';
    for (const e of [EMP1, EMP2, EMP3]) dbRun(insTA, [e, TEAM, '2026-01-01', null, 1, 'flex-e8c-test']);
    dbRun('DELETE FROM leave_requests WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    const FILLERS = dbAll('SELECT id FROM employees WHERE is_active = 0 ORDER BY id LIMIT 14').map(r => r.id);
    const insR = 'INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)';
    function clearEmps(date, emps) {
        dbRun(`DELETE FROM shift_roster WHERE employee_id IN (${emps.map(() => '?').join(',')}) AND shift_date = ?`, [...emps, date]);
    }
    function seedCoverage(date, opts) {
        opts = opts || {};
        dbRun('DELETE FROM shift_roster WHERE team_id = ? AND shift_date = ?', [TEAM, date]);
        clearEmps(date, [EMP1, EMP2, EMP3]);
        const m = Number(date.slice(5, 7)), y = Number(date.slice(0, 4));
        if (opts.emp1) dbRun(insR, [EMP1, TEAM, date, opts.emp1, m, y]);
        let fi = 0;
        for (let i = 0; i < (opts.day || 0); i++) dbRun(insR, [FILLERS[fi++], TEAM, date, 'D12', m, y]);
        for (let i = 0; i < (opts.night || 0); i++) dbRun(insR, [FILLERS[fi++], TEAM, date, 'N12', m, y]);
    }
    function seedRoster(emp, date, code) {
        clearEmps(date, [emp]);
        dbRun(insR, [emp, TEAM, date, code || 'D12', Number(date.slice(5, 7)), Number(date.slice(0, 4))]);
    }

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');
    // نظافة سياقية بعد الإقلاع (جداول E-6/E-2 تُنشأ بالـMigration)
    dbRun('DELETE FROM shift_swap_requests WHERE initiator_employee_id IN (?, ?, ?) OR target_employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3, EMP1, EMP2, EMP3]);
    dbRun('DELETE FROM unable_attend_requests WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    dbRun("INSERT INTO app_settings (key, value) VALUES ('schedule_engine.max_flex_moves_per_month', '10')");
    dbRun("INSERT INTO app_settings (key, value) VALUES ('schedule_engine.flex_makeup_search_days', '14')");
    const demo1 = await login('DEMO101', 'test123');
    const demo2 = await login('DEMO102', 'test123');
    const demo3 = await login('DEMO103', 'test123');
    const admin = await login('4252', '4252');
    const tokOf = (e) => e === EMP2 ? demo2 : demo3;

    // ═══ A) Flex حيّ ← Swap يُطبَّق أولًا ← قبول Flex يفشل بأمان ═══
    console.log('\n── A) Flex live ← Swap applied ← Flex accept = Fail-Safe ──');
    const D1 = riyadhOffset(8), D2 = riyadhOffset(9), M1 = riyadhOffset(10);
    seedCoverage(D1, { emp1: 'D12' }); // التغطية تسقط ⇒ مسار عروض
    const flexA = await api('POST', '/api/my/flex-requests', { orig_shift_date: D1, makeup_options: [M1] }, demo1);
    check('A1: تقديم Flex = offer_pending (التغطية مكسورة)',
        flexA.status === 200 && flexA.data && flexA.data.status === 'offer_pending', JSON.stringify(flexA.data));
    const X = Number(flexA.data.offer.employee_id);
    const Y = X === EMP2 ? EMP3 : EMP2;
    seedRoster(Y, D2); // مناوبة الطرف الثاني للتبديل
    const swapA = await api('POST', '/api/my/shift-swaps', { target_employee_id: Y, my_shift_date: D1, target_shift_date: D2 }, demo1);
    check('A2: تقديم Swap على نفس المناوبة أثناء Flex حيّ = pending_consent (E-6 لا يمنع — التنسيق عند التطبيق)',
        swapA.status === 200 && swapA.data && swapA.data.status === 'pending_consent', JSON.stringify(swapA.data));
    const consentA = await api('POST', '/api/my/shift-swaps/' + swapA.data.id + '/consent', { decision: 'accept' }, tokOf(Y));
    check('A3: موافقة الطرف الثاني = auto_applied (خارج نافذة 48س — K4)',
        consentA.status === 200 && consentA.data && ['auto_applied', 'applied'].includes(consentA.data.status), JSON.stringify(consentA.data));
    check('A4: نتيجة الـSwap على الأرض: صف المناوبة الأصلي انتقل لملكية Y',
        dbAll('SELECT employee_id FROM shift_roster WHERE shift_date = ? AND team_id = ?', [D1, TEAM]).some(r => Number(r.employee_id) === Y) &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [Y, D2])[0].n === 0);
    // الآن قبول عرض Flex — صف roster تقادم (تبدّلت ملكيته)
    const acceptA = await api('POST', '/api/my/flex-offers/' + flexA.data.offer.id + '/respond', { action: 'accept' }, tokOf(X));
    check('A5: قبول العرض بعد تطبيق الـSwap = escalated بسبب apply_guard_failed:FLEX_ROSTER_CHANGED (Fail-Safe)',
        acceptA.status === 200 && acceptA.data && acceptA.data.status === 'escalated' &&
        String(acceptA.data.escalation_reason || '').includes('FLEX_ROSTER_CHANGED'), JSON.stringify(acceptA.data));
    check('A6: صفر تعديل جزئي من Flex — نتيجة الـSwap كما هي + لا صف تغطية لـX + لا revision',
        dbAll('SELECT employee_id FROM shift_roster WHERE shift_date = ? AND team_id = ?', [D1, TEAM]).some(r => Number(r.employee_id) === Y) &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [X, D1])[0].n === 0 &&
        dbAll("SELECT COUNT(*) n FROM schedule_revisions WHERE source = 'flex-move' AND stats_json LIKE ?", ['%"flex_request_id":' + flexA.data.id + '%'])[0].n === 0);
    const approveA = await api('POST', '/api/schedule/flex-requests/' + flexA.data.id + '/review', { action: 'approve' }, admin);
    check('A7: اعتماد المسؤول يفشل أيضًا بنفس الحارس = 409 FLEX_ROSTER_CHANGED + الطلب يبقى escalated',
        approveA.status === 409 && approveA.data && approveA.data.code === 'FLEX_ROSTER_CHANGED' &&
        dbAll('SELECT status FROM flex_requests WHERE id = ?', [flexA.data.id])[0].status === 'escalated', JSON.stringify(approveA.data));
    const rejectA = await api('POST', '/api/schedule/flex-requests/' + flexA.data.id + '/review', { action: 'reject', note: 'تعذر بعد تبديل المناوبة' }, admin);
    check('A8: رفض المسؤول يُنهي الطلب نظيفًا + roster نهائي = نتيجة الـSwap فقط',
        rejectA.status === 200 && rejectA.data.status === 'rejected' &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date IN (?, ?)', [X, D1, D2])[0].n === 0);

    // ═══ B) Flex طُبِّق ← Swap على التاريخ القديم = 404 ═══
    console.log('\n── B) Flex applied ← Swap على تاريخ تقادم ──');
    const D3 = riyadhOffset(12), M3 = riyadhOffset(13), D4 = riyadhOffset(14);
    seedCoverage(D3, { emp1: 'D12', day: 5, night: 4 });
    seedRoster(EMP2, D4);
    const flexB = await api('POST', '/api/my/flex-requests', { orig_shift_date: D3, makeup_options: [M3] }, demo1);
    check('B1: تقديم Flex = applied (تغطية صامدة)', flexB.status === 200 && flexB.data && flexB.data.status === 'applied');
    const swapB = await api('POST', '/api/my/shift-swaps', { target_employee_id: EMP2, my_shift_date: D3, target_shift_date: D4 }, demo1);
    check('B2: Swap على التاريخ القديم بعد النقل = 404 SWAP_ROSTER_NOT_FOUND (لا مسار متقادم)',
        swapB.status === 404 && swapB.data && swapB.data.code === 'SWAP_ROSTER_NOT_FOUND', JSON.stringify(swapB.data));
    check('B3: roster ثابت — EMP1 على البديل فقط ولا صف مكرر',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, M3])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, D3])[0].n === 0);

    // ═══ C) Flex + إجازة معتمدة على يوم بديل ═══
    console.log('\n── C) Flex + إجازة معتمدة على أحد البدائل ──');
    const D5 = riyadhOffset(16), LV = riyadhOffset(17), M5 = riyadhOffset(18);
    seedCoverage(D5, { emp1: 'D12', day: 5, night: 4 });
    dbRun("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason) VALUES (?, ?, ?, 'إجازة', 'approved', 'بذر اختبار تزامن')", [EMP1, LV, LV]);
    const flexC = await api('POST', '/api/my/flex-requests', { orig_shift_date: D5, makeup_options: [LV, M5] }, demo1);
    check('C1: البديل المغطى بإجازة معتمدة يُستبعد (LEAVE_CONFLICT_APPROVED) ويُختار البديل التالي = applied على ' + M5,
        flexC.status === 200 && flexC.data && flexC.data.status === 'applied' && flexC.data.makeup_date === M5, JSON.stringify(flexC.data));
    check('C2: roster على البديل الصالح فقط (لا صف في يوم الإجازة)',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, M5])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, LV])[0].n === 0);

    // ═══ D) تقديم Flex وSwap متزامنان على نفس المناوبة ═══
    console.log('\n── D) Flex ⇄ Swap تقديم متزامن ──');
    const D6 = riyadhOffset(20), M6 = riyadhOffset(21), D7 = riyadhOffset(22);
    seedCoverage(D6, { emp1: 'D12', day: 5, night: 4 });
    seedRoster(EMP3, D7);
    const [flexD, swapD] = await Promise.all([
        api('POST', '/api/my/flex-requests', { orig_shift_date: D6, makeup_options: [M6] }, demo1),
        api('POST', '/api/my/shift-swaps', { target_employee_id: EMP3, my_shift_date: D6, target_shift_date: D7 }, demo1)
    ]);
    const flexWon = flexD.status === 200 && flexD.data && flexD.data.status === 'applied';
    const swapWon = swapD.status === 200 && swapD.data && swapD.data.status === 'pending_consent';
    const flexSafeFail = flexD.status === 409 && flexD.data && ['FLEX_ROSTER_BUSY', 'FLEX_DUPLICATE_REQUEST'].includes(flexD.data.code);
    const swapSafeFail = swapD.status === 404 && swapD.data && swapD.data.code === 'SWAP_ROSTER_NOT_FOUND';
    check('D1: ناجح واحد على الأقل + الفاشل (إن وُجد) Fail-Safe — Flex applied XOR Swap pending',
        (flexWon && (swapSafeFail || swapWon)) || (swapWon && flexSafeFail),
        JSON.stringify({ flex: [flexD.status, flexD.data && flexD.data.code], swap: [swapD.status, swapD.data && swapD.data.code] }));
    if (swapWon && flexWon) {
        // سباق نجحا معًا: حارس E-6 النهائي يجب أن يمنع التطبيق المزدوج عند الموافقة
        const consentD = await api('POST', '/api/my/shift-swaps/' + swapD.data.id + '/consent', { decision: 'accept' }, demo3);
        check('D2: نجحا معًا (سباق) ⇒ موافقة الـSwap تفشل بأمان عند حارس اللقطة (لا تطبيق مزدوج)',
            consentD.status === 409, JSON.stringify([consentD.status, consentD.data]));
    } else if (swapWon) {
        const cancelD = await api('POST', '/api/my/shift-swaps/' + swapD.data.id + '/cancel', {}, demo1);
        const retryD = await api('POST', '/api/my/flex-requests', { orig_shift_date: D6, makeup_options: [M6] }, demo1);
        check('D2: فاز الـSwap ⇒ إلغاؤه ثم Flex ينجح (لا حالة عالقة)',
            cancelD.status === 200 && retryD.status === 200 && retryD.data && retryD.data.status === 'applied', JSON.stringify(retryD.data));
    } else {
        check('D2: فاز Flex ⇒ الـSwap رُفض مباشرة (404) — لا إجراء لاحق مطلوب', swapSafeFail);
    }
    check('D3: الاتساق النهائي — مناوبة EMP1 على البديل فقط + لا تكرار (موظف، تاريخ) للثلاثة',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, M6])[0].n === 1 &&
        dbAll(`SELECT COUNT(*) n FROM (SELECT employee_id, shift_date FROM shift_roster
               WHERE employee_id IN (?, ?, ?) GROUP BY employee_id, shift_date HAVING COUNT(*) > 1)`, [EMP1, EMP2, EMP3])[0].n === 0);
    check('D4: طلب flex واحد فقط على مناوبة السباق (لا صف رسمي متعارض)',
        dbAll('SELECT COUNT(*) n FROM flex_requests WHERE employee_id = ? AND orig_shift_date = ?', [EMP1, D6])[0].n === 1);

    // ═══ الخلاصة ═══
    await stopServer();
    console.log('\n═══════════════════════════════════');
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failed > 0) {
        console.log('الفاشلة:');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('✅ E-8 CONCURRENCY TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
