/**
 * ═══ اختبار مسار إنشاء حساب الموظف POST /api/users (اعتماد المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت معزول 3131 + بيانات اختبار مصطنعة
 * (موظف T501 نشط / T502 غير نشط · حساب ADM1 admin · حساب USR1 user) — لا تمس بيانات الإنتاج.
 * API فقط — لا حاجة لمتصفح.
 *
 * الاختبارات العشرة المعتمدة:
 *   1) إنشاء ناجح 201 + الدخول بالكلمة المؤقتة ينجح + /api/my/profile ← 403 (لا منح تلقائي لـ ops.my_portal)
 *   2) تكرار username ← 409 ACCOUNT_EXISTS
 *   3) ربط ثانٍ لنفس الموظف بـusername مختلف ← 400 IDENTITY_MISMATCH
 *   4) موظف غير موجود ← 404 EMPLOYEE_NOT_FOUND
 *   5) موظف غير نشط ← 404 EMPLOYEE_INACTIVE
 *   6) username ≠ employeeCode ← 400 IDENTITY_MISMATCH
 *   7) دور غير معتمد ← 400
 *   8) user بلا admin.users_manage ← 403 · بلا توكن ← 401
 *   9) audit_log يحوي قيد user_create ولا يحوي كلمة المرور نهائيًا + users.json يخزن hash فقط
 *  10) انحدار: دخول admin قديم + GET /api/users + POST /api/users/:id/role تعمل
 *
 * التشغيل: node scripts/admin-create-user-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'usercreate-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'usercreate-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3131;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
async function api(method, url, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await r.json(); } catch (_) { }
    return { status: r.status, body: json };
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── 1) نسخة معزولة ──
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    // ── 2) حسابات وموظفون مصطنعون ──
    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-ADM1', username: 'ADM1', name: 'مدير اختبار الإنشاء', password: hash, role: 'admin', isActive: true },
        { id: 'emp-USR1', username: 'USR1', name: 'مستخدم بلا إدارة', password: hash, role: 'user', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    dbw.prepare("INSERT INTO employees (employee_code, name, job_title, is_active) VALUES ('T501','موظف اختبار الإنشاء','فني اسعاف',1)").run();
    dbw.prepare("INSERT INTO employees (employee_code, name, job_title, is_active) VALUES ('T502','موظف غير نشط','فني اسعاف',0)").run();
    const auditCountBefore = dbw.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='user_create'").get().c;

    console.log('🧪 خادم معزول على ' + PORT + ' — مسار إنشاء حساب الموظف POST /api/users');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يجهز');

        // تسجيل دخول الحسابات
        const admLogin = await api('POST', '/api/auth/login', { body: { username: 'ADM1', password: 'test1234' } });
        const usrLogin = await api('POST', '/api/auth/login', { body: { username: 'USR1', password: 'test1234' } });
        if (!admLogin.body || !admLogin.body.accessToken) throw new Error('فشل دخول ADM1: ' + JSON.stringify(admLogin));
        if (!usrLogin.body || !usrLogin.body.accessToken) throw new Error('فشل دخول USR1: ' + JSON.stringify(usrLogin));
        const ADM = admLogin.body.accessToken, USR = usrLogin.body.accessToken;

        // ── 1) إنشاء ناجح 201 ──
        console.log('\n— 1) إنشاء ناجح —');
        const create = await api('POST', '/api/users', {
            token: ADM,
            body: { username: 'T501', name: 'موظف اختبار الإنشاء', role: 'user', employeeCode: 'T501' }
        });
        check('1أ) الإنشاء يرد 201', create.status === 201, JSON.stringify(create.body));
        check('1ب) الاستجابة: user.id=emp-T501 وpermissionsGranted فارغة',
            create.body && create.body.user && create.body.user.id === 'emp-T501' &&
            Array.isArray(create.body.permissionsGranted) && create.body.permissionsGranted.length === 0,
            JSON.stringify(create.body));
        const tempPassword = create.body && create.body.tempPassword;
        check('1ج) كلمة مؤقتة مولّدة خادميًا (10 خانات)', typeof tempPassword === 'string' && tempPassword.length === 10, String(tempPassword));

        // الدخول بالكلمة المؤقتة
        const newLogin = await api('POST', '/api/auth/login', { body: { username: 'T501', password: tempPassword } });
        check('1د) الدخول بالكلمة المؤقتة ينجح', newLogin.status === 200 && !!(newLogin.body && newLogin.body.accessToken), JSON.stringify(newLogin.body && newLogin.body.error));
        const NEW = newLogin.body && newLogin.body.accessToken;

        // لا منح تلقائي لـ ops.my_portal
        const myProfile = await api('GET', '/api/my/profile', { token: NEW });
        check('1هـ) /api/my/profile للحساب الجديد ← 403 (لا منح تلقائي لـ ops.my_portal)', myProfile.status === 403, JSON.stringify(myProfile.body));

        // ── 2) تكرار username ← 409 ──
        console.log('\n— 2) منع التكرار —');
        const dup = await api('POST', '/api/users', {
            token: ADM,
            body: { username: 'T501', name: 'أي اسم', role: 'user', employeeCode: 'T501' }
        });
        check('2) تكرار نفس الطلب ← 409 ACCOUNT_EXISTS', dup.status === 409 && dup.body && dup.body.code === 'ACCOUNT_EXISTS', JSON.stringify(dup));

        // ── 3) ربط ثانٍ لنفس الموظف بـusername مختلف ← 400 ──
        const relink = await api('POST', '/api/users', {
            token: ADM,
            body: { username: 'T599', name: 'ربط ثانٍ', role: 'user', employeeCode: 'T501' }
        });
        check('3) ربط ثانٍ بـusername مختلف ← 400 IDENTITY_MISMATCH', relink.status === 400 && relink.body && relink.body.code === 'IDENTITY_MISMATCH', JSON.stringify(relink));

        // ── 4) موظف غير موجود ← 404 ──
        console.log('\n— 3) التحقق من ملف الموظف —');
        const ghost = await api('POST', '/api/users', {
            token: ADM,
            body: { username: 'T999', name: 'موظف وهمي', role: 'user', employeeCode: 'T999' }
        });
        check('4) موظف غير موجود ← 404 EMPLOYEE_NOT_FOUND', ghost.status === 404 && ghost.body && ghost.body.code === 'EMPLOYEE_NOT_FOUND', JSON.stringify(ghost));

        // ── 5) موظف غير نشط ← 404 ──
        const inactive = await api('POST', '/api/users', {
            token: ADM,
            body: { username: 'T502', name: 'موظف غير نشط', role: 'user', employeeCode: 'T502' }
        });
        check('5) موظف غير نشط ← 404 EMPLOYEE_INACTIVE', inactive.status === 404 && inactive.body && inactive.body.code === 'EMPLOYEE_INACTIVE', JSON.stringify(inactive));

        // ── 6) username ≠ employeeCode ← 400 ──
        console.log('\n— 4) عقد الهوية والدور —');
        const mismatch = await api('POST', '/api/users', {
            token: ADM,
            body: { username: 'T501', name: 'مطابقة خاطئة', role: 'user', employeeCode: 'T503' }
        });
        check('6) username≠employeeCode ← 400 IDENTITY_MISMATCH', mismatch.status === 400 && mismatch.body && mismatch.body.code === 'IDENTITY_MISMATCH', JSON.stringify(mismatch));

        // ── 7) دور غير معتمد ← 400 ──
        const badRole = await api('POST', '/api/users', {
            token: ADM,
            body: { username: 'T501', name: 'دور خاطئ', role: 'superadmin', employeeCode: 'T501' }
        });
        check('7) دور غير معتمد ← 400', badRole.status === 400 && badRole.body && /الدور غير معتمد/.test(badRole.body.error || ''), JSON.stringify(badRole));

        // ── 8) الصلاحيات: 403 و401 ──
        console.log('\n— 5) الصلاحيات —');
        const forbidden = await api('POST', '/api/users', {
            token: USR,
            body: { username: 'T601', name: 'محاولة بلا صلاحية', role: 'user', employeeCode: 'T601' }
        });
        check('8أ) user بلا admin.users_manage ← 403', forbidden.status === 403 && forbidden.body && forbidden.body.code === 'PERMISSION_DENIED', JSON.stringify(forbidden));
        const anon = await api('POST', '/api/users', {
            body: { username: 'T601', name: 'محاولة بلا توكن', role: 'user', employeeCode: 'T601' }
        });
        check('8ب) بلا توكن ← 401', anon.status === 401, JSON.stringify(anon));

        // ── 9) AuditLog: القيد موجود وكلمة المرور غير مسجلة ──
        console.log('\n— 6) التوثيق وعدم تسريب كلمة المرور —');
        const auditRows = dbw.prepare("SELECT user_id, user_name, action, detail, type FROM audit_log WHERE action='user_create' AND detail LIKE '%T501%'").all();
        check('9أ) قيد user_create موجود في audit_log (المنفذ + الحساب + الدور)',
            auditRows.length > 0 && auditRows[0].user_name === 'مدير اختبار الإنشاء' && /الدور:/.test(auditRows[0].detail) && auditRows[0].type === 'permissions',
            JSON.stringify(auditRows));
        const leakInAudit = dbw.prepare("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE ?").get('%' + tempPassword + '%').c;
        check('9ب) كلمة المرور المؤقتة غير موجودة في audit_log نهائيًا', leakInAudit === 0, 'rows=' + leakInAudit);
        const usersAfter = fs.readFileSync(usersPath, 'utf8');
        const createdRec = JSON.parse(usersAfter).find(u => u.username === 'T501');
        check('9ج) users.json يخزن hash فقط (لا نص صريح لكلمة المرور)',
            createdRec && createdRec.password !== tempPassword && createdRec.password.startsWith('$2') && !usersAfter.includes(tempPassword));

        // ── 10) انحدار: المسارات الإدارية القائمة تعمل ──
        console.log('\n— 7) انحدار المسارات القائمة —');
        const listUsers = await api('GET', '/api/users', { token: ADM });
        check('10أ) GET /api/users يعمل', listUsers.status === 200 && Array.isArray(listUsers.body && listUsers.body.users), JSON.stringify(listUsers.status));
        const roleChange = await api('POST', '/api/users/emp-T501/role', { token: ADM, body: { role: 'viewer' } });
        check('10ب) POST /api/users/:id/role يعمل على الحساب المنشأ', roleChange.status === 200 && roleChange.body && roleChange.body.changed === true, JSON.stringify(roleChange));
        const auditTotal = dbw.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='user_create'").get().c;
        check('10ج) لا قيود user_create زائدة (فقط الناجحة)', auditTotal === auditCountBefore + 1, 'total=' + auditTotal + ' before=' + auditCountBefore);

        dbw.close();
    } catch (e) {
        failed++;
        failures.push('خطأ عام: ' + e.message);
        console.error('💥', e.message);
    } finally {
        server.kill();
        await sleep(800);
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + ext, { force: true }); } catch (_) { } }
    }

    console.log('\n════════════════════════════════════');
    console.log(`النتيجة: ${passed} ناجح · ${failed} فاشل`);
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})();
