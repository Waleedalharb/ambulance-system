// F-2 (الجدول المرن): اختبار backend واجهات طلبات تغيير المناوبة.
// بيئة معزولة بالكامل (VACUUM مؤقت + users.json مؤقت) — لا يلمس data/ الحقيقية.
// يغطي: تشديد الملكية (د2) · اشتقاق old_shift_code/roster_id/team_id خادميًا
// (قاعدة المالك) · مسار «طلباتي» وعزله · إلغاء المالك (د1) بشروطه
// · إثراء قائمة المشرف · تكامل F-1 (الاعتماد يطبّق) · حفظ عقد المخوَّل.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3097;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-f2-'));
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
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
function dbAll(sql, params) {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB, { readonly: true });
    const rows = db.prepare(sql).all(...(params || []));
    db.close();
    return rows;
}
function dbRun(sql, params) {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    db.prepare(sql).run(...(params || []));
    db.close();
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
    if (!r.data || !r.data.accessToken) throw new Error('login failed: ' + username + ' — ' + JSON.stringify(r.data));
    return r.data.accessToken;
}
function plusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const my = (date) => ({ month: Number(date.slice(5, 7)), year: Number(date.slice(0, 4)) });

async function main() {
    console.log('═══ F-2 SHIFT-CHANGE UI/BACKEND TEST — بيئة معزولة ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (u.username === 'DEMO101' || u.username === 'DEMO102') u.password = hash; });
    // حساب بلا ملف موظف (لاختبار NO_EMPLOYEE) — نسخ بنية مستخدم قائم بلا افتراض حقول
    const demoProto = users.find(u => u.username === 'DEMO101');
    users.push(Object.assign({}, demoProto, { id: 'test-noemp1', username: 'NOEMP1', name: 'حساب بلا ملف', password: hash }));
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    // ops.my_portal منحة فردية حصرًا (لا دور يحملها) — نمنحها لـ DEMO101 لاختبار مسارات /api/my/*
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-f2-test')", [demoProto.id]);
    // ولـ NOEMP1 أيضًا كي يتجاوز بوابة الصلاحية ويصل لفحص «لا ملف موظف» (404 لا 403)
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('test-noemp1', 'ops.my_portal', 1, 'flex-f2-test')");

    const codes = dbAll('SELECT code FROM shift_codes ORDER BY code LIMIT 5').map(r => r.code);
    if (codes.length < 2) throw new Error('يحتاج الاختبار رمزين معتمدين على الأقل');
    const C1 = codes[0], C2 = codes[1];
    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const D1 = plusDays(31), D2 = plusDays(61), D3 = plusDays(62), D4 = plusDays(63);
    for (const [emp, dt] of [[EMP1, D1], [EMP1, D2], [EMP1, D3], [EMP2, D4]]) {
        dbRun('DELETE FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [emp, dt]);
    }

    await startServer();
    console.log('— الخادم يعمل على :' + PORT + ' —');
    const admin = await login('4252', '4252');
    const demo1 = await login('DEMO101', 'test123');
    const noemp = await login('NOEMP1', 'test123');

    // ── 0) بوابة المصادقة على المسارات الجديدة ──
    console.log('\n── المصادقة ──');
    const noAuth1 = await api('GET', '/api/my/shift-change-requests', null, null);
    check('GET طلباتي بلا توكن = 401', noAuth1.status === 401, 'status=' + noAuth1.status);
    const noAuth2 = await api('POST', '/api/my/shift-change-requests/1/cancel', {}, null);
    check('إلغاء بلا توكن = 401', noAuth2.status === 401, 'status=' + noAuth2.status);

    // ── 1) تشديد الملكية (د2) ──
    console.log('\n── تشديد ملكية التقديم ──');
    const m1 = my(D1);
    const mk = await api('POST', '/api/shift-roster', { employee_id: EMP1, shift_date: D1, shift_code: C1, month: m1.month, year: m1.year }, admin);
    const ROSTER1 = mk.data.id;
    const teamOfRow = dbAll('SELECT team_id FROM shift_roster WHERE id = ?', [ROSTER1])[0].team_id;

    const ownNoId = await api('POST', '/api/shift-change-request', { shift_date: D1, proposed_shift_code: C2, reason: 'بدون employee_id' }, demo1);
    check('موظف يقدّم بدون employee_id ⇒ 200 (يُشتق من الحساب)', ownNoId.ok && ownNoId.data.id, JSON.stringify(ownNoId.data));
    const REQ_OWN = ownNoId.data.id;
    const rowOwn = dbAll('SELECT * FROM shift_change_requests WHERE id = ?', [REQ_OWN])[0];
    check('employee_id المخزَّن = موظف الحساب', Number(rowOwn.employee_id) === EMP1);

    const ownExplicit = await api('POST', '/api/shift-change-request', { employee_id: EMP1, shift_date: D1, proposed_shift_code: C2 }, demo1);
    check('موظف يقدّم بـ employee_id مطابق لنفسه ⇒ 200', ownExplicit.ok, 'status=' + ownExplicit.status);

    const mismatch = await api('POST', '/api/shift-change-request', { employee_id: EMP2, shift_date: D1, proposed_shift_code: C2 }, demo1);
    check('موظف يقدّم باسم موظف آخر ⇒ 403 (EMPLOYEE_MISMATCH)', mismatch.status === 403 && mismatch.data.code === 'EMPLOYEE_MISMATCH', 'status=' + mismatch.status);

    const noEmpSubmit = await api('POST', '/api/shift-change-request', { shift_date: D1, proposed_shift_code: C2 }, noemp);
    check('حساب بلا ملف موظف ⇒ 403 (NO_EMPLOYEE)', noEmpSubmit.status === 403 && noEmpSubmit.data.code === 'NO_EMPLOYEE', 'status=' + noEmpSubmit.status);

    const adminForOther = await api('POST', '/api/shift-change-request', { employee_id: EMP2, shift_date: D4, proposed_shift_code: C2, reason: 'تقديم إداري' }, admin);
    check('مخوَّل (requests.review) يقدّم لموظف آخر ⇒ 200 (عقد قائم)', adminForOther.ok && adminForOther.data.id, 'status=' + adminForOther.status);
    const REQ_ADMIN = adminForOther.data.id;

    // ── 2) الاشتقاق الخادمي (قاعدة المالك) ──
    console.log('\n── اشتقاق old_shift_code من shift_roster ──');
    check('old_shift_code = القيمة الفعلية (' + C1 + ') لا قيمة عميل', rowOwn.old_shift_code === C1, 'got=' + rowOwn.old_shift_code);
    check('roster_id مربوط بالسطر الفعلي', Number(rowOwn.roster_id) === Number(ROSTER1));
    check('team_id من السطر الفعلي', (rowOwn.team_id === null ? null : Number(rowOwn.team_id)) === (teamOfRow === null ? null : Number(teamOfRow)));
    const forged = await api('POST', '/api/shift-change-request', { shift_date: D1, proposed_shift_code: C2, old_shift_code: 'FORGED' }, demo1);
    const forgedRow = dbAll('SELECT old_shift_code FROM shift_change_requests WHERE id = ?', [forged.data.id])[0];
    check('old_shift_code مزوَّر من العميل يُتجاهل ⇒ الفعلية تُخزَّن', forgedRow.old_shift_code === C1, 'got=' + forgedRow.old_shift_code);
    const noRoster = await api('POST', '/api/shift-change-request', { shift_date: D2, proposed_shift_code: C2 }, demo1);
    const noRosterRow = dbAll('SELECT * FROM shift_change_requests WHERE id = ?', [noRoster.data.id])[0];
    check('يوم بلا سطر ⇒ old_shift_code=null وroster_id=null', noRosterRow.old_shift_code === null && noRosterRow.roster_id === null);

    // ── 3) «طلباتي» وعزل النطاق ──
    console.log('\n── طلباتي ──');
    const mine = await api('GET', '/api/my/shift-change-requests', null, demo1);
    check('GET طلباتي 200 + قائمة', mine.ok && Array.isArray(mine.data.requests), JSON.stringify(mine.data).slice(0, 120));
    const mineIds = mine.data.requests.map(r => r.id);
    check('طلباتي تعرض طلباتي فعلًا', mineIds.includes(REQ_OWN));
    const emp1Ids = dbAll('SELECT id FROM shift_change_requests WHERE employee_id = ?', [EMP1]).map(r => r.id);
    check('طلباتي لا تعرض طلب موظف آخر (عزل)', !mineIds.includes(REQ_ADMIN) && mineIds.every(id => emp1Ids.includes(id)) && mineIds.length === emp1Ids.length,
        'mine=' + JSON.stringify(mineIds) + ' emp1=' + JSON.stringify(emp1Ids));
    const mineNoEmp = await api('GET', '/api/my/shift-change-requests', null, noemp);
    check('حساب بلا ملف ⇒ 404 (NO_EMPLOYEE)', mineNoEmp.status === 404, 'status=' + mineNoEmp.status);

    // ── 4) إثراء قائمة المشرف ──
    console.log('\n── قائمة المشرف المُثراة ──');
    const adminList = await api('GET', '/api/shift-change-request?status=pending', null, admin);
    const enriched = (adminList.data.requests || []).find(r => r.id === REQ_OWN);
    check('القائمة تحمل employee_name', !!enriched && typeof enriched.employee_name === 'string' && enriched.employee_name.length > 0, enriched && enriched.employee_name);
    check('القائمة تحمل current_shift_code الحي (' + C1 + ')', enriched && enriched.current_shift_code === C1, enriched && enriched.current_shift_code);

    // ── 5) إلغاء المالك (د1) ──
    console.log('\n── إلغاء المالك ──');
    const cancelOther = await api('POST', '/api/my/shift-change-requests/' + REQ_ADMIN + '/cancel', {}, demo1);
    check('إلغاء طلب موظف آخر ⇒ 403 (NOT_REQUEST_OWNER)', cancelOther.status === 403 && cancelOther.data.code === 'NOT_REQUEST_OWNER', 'status=' + cancelOther.status);
    const cancelMissing = await api('POST', '/api/my/shift-change-requests/999999/cancel', {}, demo1);
    check('إلغاء طلب غير موجود ⇒ 404', cancelMissing.status === 404, 'status=' + cancelMissing.status);
    const auditBefore = dbAll("SELECT COUNT(*) c FROM audit_log WHERE action = 'shift_change_request_owner_cancel'")[0].c;
    const REQ_CANCEL = ownExplicit.data.id;
    const cancelOk = await api('POST', '/api/my/shift-change-requests/' + REQ_CANCEL + '/cancel', {}, demo1);
    check('المالك يلغي طلبه المعلّق ⇒ 200', cancelOk.ok, JSON.stringify(cancelOk.data));
    check('الحالة cancelled (بلا حذف فعلي)', dbAll('SELECT status FROM shift_change_requests WHERE id = ?', [REQ_CANCEL])[0].status === 'cancelled');
    check('تدقيق الإلغاء مسجَّل', dbAll("SELECT COUNT(*) c FROM audit_log WHERE action = 'shift_change_request_owner_cancel'")[0].c === auditBefore + 1);
    const cancelTwice = await api('POST', '/api/my/shift-change-requests/' + REQ_CANCEL + '/cancel', {}, demo1);
    check('إلغاء طلب ملغى ⇒ 409', cancelTwice.status === 409 && cancelTwice.data.code === 'SHIFT_CHANGE_ALREADY_PROCESSED', 'status=' + cancelTwice.status);
    const mineAfter = await api('GET', '/api/my/shift-change-requests', null, demo1);
    check('الملغى يظهر cancelled في طلباتي', mineAfter.data.requests.find(r => r.id === REQ_CANCEL).status === 'cancelled');

    // ── 6) تكامل F-1: الاعتماد من مسار المشرف يطبّق فعليًا ──
    console.log('\n── تكامل F-1 ──');
    const approve = await api('POST', '/api/shift-change-request/' + REQ_OWN + '/review', { status: 'approved' }, admin);
    check('الاعتماد 200 + applied(edit)', approve.ok && approve.data.applied && approve.data.applied.change_type === 'edit', JSON.stringify(approve.data));
    check('الجدول طُبّق على اليوم المحدد (' + C2 + ')', dbAll('SELECT shift_code FROM shift_roster WHERE id = ?', [ROSTER1])[0].shift_code === C2);
    const mineApproved = await api('GET', '/api/my/shift-change-requests', null, demo1);
    check('طلباتي تعكس الاعتماد', mineApproved.data.requests.find(r => r.id === REQ_OWN).status === 'approved');
    const cancelApproved = await api('POST', '/api/my/shift-change-requests/' + REQ_OWN + '/cancel', {}, demo1);
    check('إلغاء طلب معتمد ⇒ 409', cancelApproved.status === 409, 'status=' + cancelApproved.status);

    await stopServer();
    console.log('\n═══ النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل ═══');
    // سطر ملخص بصيغة بوابة النشر (نفس عقد leave-backend-test)
    console.log((failed === 0 ? '✅' : '❌') + ' نجح: ' + passed + ' | ❌ فشل: ' + failed);
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL:', e); await stopServer(); process.exit(1); });
