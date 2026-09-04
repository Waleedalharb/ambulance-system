/**
 * ═══ اختبار طبقات ظهور بيانات الموظفين (اعتماد المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3126 + OTP_PROVIDER=mock — لا تمس
 * بيانات الإنتاج ولا تُرسل SMS حقيقية.
 *
 * يغطي التصميم المعتمد:
 *  • أساسية (أي مستخدم مسجّل): حقول غير حساسة فقط — بلا phone وبلا phone_verified*.
 *  • +staff.phone_view: يظهر phone فقط — ولا يصل phone_verified* حتى بطلب مباشر.
 *  • +admin.users_manage: يظهر phone + phone_verified/at/by.
 *  • التوثيق/الإلغاء والاستعادة لا تتأثران · شكل الاستجابة لا ينكسر.
 *
 * التشغيل: node scripts/employees-visibility-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'empvis-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'empvis-data-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'employees-visibility-' + STAMP);
const PORT = 3126;
const BASE = 'http://127.0.0.1:' + PORT;
const MOCK_CODE = '246810';

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
// هل تحمل الحمولة أي مفتاح حساس؟ (غياب المفتاح نفسه — لا قيمته فقط)
function leakKeys(obj) {
    const SENS = ['phone', 'phone_verified', 'phone_verified_at', 'phone_verified_by'];
    return SENS.filter(k => obj && Object.prototype.hasOwnProperty.call(obj, k));
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── نسخة معزولة ──
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    // ── حسابات وموظفون تجريبيون ──
    const hash = bcrypt.hashSync('testpass123', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-EMPV', username: 'EMPV', name: 'موظف بوابة فقط', password: hash, role: 'user', isActive: true },
        { id: 'emp-PHONEV', username: 'PHONEV', name: 'حامل phone_view', password: hash, role: 'user', isActive: true },
        { id: 'emp-ADMV', username: 'ADMV', name: 'مدير تجريبي', password: hash, role: 'admin', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    for (const col of [['phone_verified', 'INTEGER NOT NULL DEFAULT 0'], ['phone_verified_at', 'DATETIME'], ['phone_verified_by', 'TEXT']]) {
        const cols = dbw.prepare('PRAGMA table_info(employees)').all();
        if (!cols.some(c => c.name === col[0])) dbw.exec(`ALTER TABLE employees ADD COLUMN ${col[0]} ${col[1]}`);
    }
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, phone, is_active, phone_verified, phone_verified_by) VALUES (?,?,?,?,1,?,?)');
    const eV1 = insEmp.run('EMPV', 'موظف بوابة فقط', 'فني اسعاف', '0501111111', 1, 'seed').lastInsertRowid;
    const eV2 = insEmp.run('VIS2', 'موظف مراقَب', 'أخصائي اسعاف', '0502222222', 1, 'seed').lastInsertRowid;
    // منح فردية مباشرة — EMPV: ops.my_portal فقط · PHONEV: staff.phone_view فقط
    const grant = dbw.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)');
    grant.run('emp-EMPV', 'ops.my_portal', 'test');
    grant.run('emp-PHONEV', 'staff.phone_view', 'test');
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — طبقات ظهور بيانات الموظفين');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', OTP_PROVIDER: 'mock', RESET_RATE_LIMIT_MAX: '500' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    async function login(u, p) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        const b = await r.json();
        return { status: r.status, token: b.accessToken || null, body: b };
    }
    async function apiGet(p, tok) {
        const r = await fetch(BASE + p, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    async function apiPost(p, body, tok) {
        const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body || {}) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    function dbRead(fn) { const d = new Database(TMP_DB, { readonly: true }); const v = fn(d); d.close(); return v; }

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const empv = await login('EMPV', 'testpass123');
        const phonev = await login('PHONEV', 'testpass123');
        const admv = await login('ADMV', 'testpass123');
        if (!empv.token || !phonev.token || !admv.token) throw new Error('فشل دخول أحد الحسابات التجريبية');

        // ── 1) موظف ops.my_portal فقط: القائمة الكاملة بلا phone ولا phone_verified* ──
        const l1 = await apiGet('/api/employees', empv.token);
        const emps1 = l1.body.employees || [];
        const seeded1 = emps1.filter(e => e.employee_code === 'EMPV' || e.employee_code === 'VIS2');
        const leaks1 = emps1.flatMap(e => leakKeys(e));
        check('1) ops.my_portal فقط — GET /api/employees: لا phone ولا phone_verified* في أي سجل',
            l1.status === 200 && emps1.length > 0 && leaks1.length === 0
            && seeded1.length === 2 && seeded1.every(e => e.name && e.job_title),
            JSON.stringify({ s: l1.status, n: emps1.length, leaks: leaks1, seeded: seeded1.length }));

        // ── 2) نفس الموظف: البحث المباشر والجلب بالمعرّف — بلا تسريب أيضًا ──
        const s2 = await apiGet('/api/employees/search?q=مراق', empv.token);
        const g2 = await apiGet('/api/employees/' + eV2, empv.token);
        const leaks2 = (s2.body.results || []).flatMap(e => leakKeys(e)).concat(leakKeys(g2.body.employee));
        check('2) ops.my_portal فقط — search + :id بطلب مباشر: صفر تسريب',
            s2.status === 200 && g2.status === 200 && leaks2.length === 0,
            JSON.stringify({ ss: s2.status, gs: g2.status, leaks: leaks2 }));

        // ── 3) حامل staff.phone_view: يرى phone في المسارات الثلاثة — ولا يرى phone_verified* إطلاقًا ──
        const l3 = await apiGet('/api/employees', phonev.token);
        const s3 = await apiGet('/api/employees/search?q=مراق', phonev.token);
        const g3 = await apiGet('/api/employees/' + eV2, phonev.token);
        const rec3 = (l3.body.employees || []).find(e => e.employee_code === 'VIS2');
        const verLeak3 = (l3.body.employees || []).flatMap(e => leakKeys(e).filter(k => k !== 'phone'))
            .concat((s3.body.results || []).flatMap(e => leakKeys(e).filter(k => k !== 'phone')))
            .concat(leakKeys(g3.body.employee).filter(k => k !== 'phone'));
        check('3) staff.phone_view — يظهر phone في الثلاثة، ولا يظهر phone_verified* حتى بطلب مباشر',
            l3.status === 200 && rec3 && rec3.phone === '0502222222'
            && (s3.body.results || [])[0] && (s3.body.results || [])[0].phone === '0502222222'
            && g3.body.employee && g3.body.employee.phone === '0502222222'
            && verLeak3.length === 0,
            JSON.stringify({ rec: rec3 && rec3.phone, verLeak: verLeak3 }));

        // ── 4) admin.users_manage: يرى phone + phone_verified* كاملة ──
        const l4 = await apiGet('/api/employees', admv.token);
        const g4 = await apiGet('/api/employees/' + eV2, admv.token);
        const rec4 = (l4.body.employees || []).find(e => e.employee_code === 'VIS2');
        check('4) admin — يرى phone + phone_verified + verified_at/by في القائمة والجلب',
            l4.status === 200 && rec4 && rec4.phone === '0502222222' && rec4.phone_verified === 1
            && Object.prototype.hasOwnProperty.call(rec4, 'phone_verified_at') && rec4.phone_verified_by === 'seed'
            && g4.body.employee && g4.body.employee.phone_verified === 1,
            JSON.stringify({ rec: rec4 && { p: rec4.phone, v: rec4.phone_verified, by: rec4.phone_verified_by } }));

        // ── 5) غير المسجّل: 401 على المسارات الثلاثة ──
        const u5a = await apiGet('/api/employees', null);
        const u5b = await apiGet('/api/employees/search?q=x', null);
        const u5c = await apiGet('/api/employees/' + eV2, null);
        check('5) بلا توكن: 401 على الثلاثة', u5a.status === 401 && u5b.status === 401 && u5c.status === 401,
            JSON.stringify([u5a.status, u5b.status, u5c.status]));

        // ── 6) التوثيق والإلغاء لا يتأثران (admin) ──
        const un6 = await apiPost('/api/employees/' + eV2 + '/unverify-phone', { confirmResponsibility: true }, admv.token);
        const mid6 = dbRead(d => d.prepare('SELECT phone_verified FROM employees WHERE id = ?').get(eV2));
        const re6 = await apiPost('/api/employees/' + eV2 + '/verify-phone', { confirmResponsibility: true }, admv.token);
        const end6 = dbRead(d => d.prepare('SELECT phone_verified, phone_verified_by FROM employees WHERE id = ?').get(eV2));
        check('6) التوثيق/الإلغاء يعملان: unverify ← 0 ثم verify ← 1 مع تسجيل المدير',
            un6.status === 200 && mid6.phone_verified === 0 && re6.status === 200 && end6.phone_verified === 1 && !!end6.phone_verified_by,
            JSON.stringify({ un: un6.status, mid: mid6, re: re6.status, end: end6 }));

        // ── 7) دورة استعادة كاملة بـmock لا تتأثر (EMPV موظفه موثق) ──
        await apiPost('/api/auth/forgot-password', { identifier: 'EMPV' });
        const v7 = await apiPost('/api/auth/verify-reset-code', { identifier: 'EMPV', code: MOCK_CODE });
        const rs7 = v7.body.resetToken
            ? await apiPost('/api/auth/reset-password', { token: v7.body.resetToken, newPassword: 'newpass999' })
            : { status: 0 };
        const relog = await login('EMPV', 'newpass999');
        check('7) الاستعادة لا تتأثر: forgot ← verify ← reset ← دخول بالجديدة',
            v7.status === 200 && rs7.status === 200 && relog.status === 200,
            JSON.stringify({ v: v7.status, rs: rs7.status, relog: relog.status }));

        // ── 8) شكل الاستجابة لا ينكسر: search يعيد {success, results[]} بحقول الواجهة ──
        // ملاحظة: فحص 7 أبطل جلسة EMPV القديمة (سلوك مقصود) — نستخدم توكن الدخول الجديد
        const s8 = await apiGet('/api/employees/search?q=موظف', relog.token);
        const r8 = (s8.body.results || [])[0];
        check('8) توافق الواجهات: search ← {success, results} بحقول name/employee_code/job_title/symbol/is_active',
            s8.status === 200 && s8.body.success === true && Array.isArray(s8.body.results)
            && r8 && ['employee_code', 'name', 'job_title', 'symbol', 'is_active', 'pattern_code'].every(k => Object.prototype.hasOwnProperty.call(r8, k)),
            JSON.stringify({ s: s8.status, keys: r8 && Object.keys(r8) }));

        // ── 9) القائمة الكاملة: حقول الطبقة الأساسية حاضرة لأي مستخدم ──
        const rec9 = (l1.body.employees || [])[0];
        check('9) الطبقة الأساسية كاملة: id/employee_code/name/job_title/symbol/is_active/pattern_code/created_at',
            !!rec9 && ['id', 'employee_code', 'name', 'job_title', 'symbol', 'is_active', 'pattern_code', 'created_at'].every(k => Object.prototype.hasOwnProperty.call(rec9, k)),
            JSON.stringify(rec9 && Object.keys(rec9)));

        console.log('\n════════════════ نتيجة طبقات الظهور: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
        console.log('المخرجات: ' + OUT_DIR);
    } finally {
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})();
