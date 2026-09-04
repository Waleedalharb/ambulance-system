/**
 * ═══ اختبار طبقات ظهور بيانات الموظفين (اعتماد المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3126 + OTP_PROVIDER=mock — لا تمس
 * بيانات الإنتاج ولا تُرسل SMS حقيقية.
 *
 * يغطي التصميم المعتمد + تشديد المالك (النجمة '*' وحدها لا تكفي للطبقتين الحساستين):
 *  • أساسية (أي مستخدم مسجّل): حقول غير حساسة فقط — بلا phone وبلا phone_verified*.
 *  • +staff.phone_view: يظهر phone فقط — ولا يصل phone_verified* حتى بطلب مباشر.
 *  • +admin.users_manage: يظهر phone + phone_verified/at/by.
 *  • admin بالنجمة بلا منحة فردية: لا يرى phone ولا phone_verified* (اختبار المالك الصريح).
 *  • staff.phone_view لا تُمنح تلقائيًا لأي دور (user/director/operator/viewer).
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
        { id: 'adm-ADMV', username: 'ADMV', name: 'مدير نجمة بلا منح', password: hash, role: 'admin', isActive: true },
        { id: 'adm-ADMG', username: 'ADMG', name: 'مدير بمنحة users_manage', password: hash, role: 'admin', isActive: true },
        { id: 'adm-ADMP', username: 'ADMP', name: 'مدير بمنحة phone_view', password: hash, role: 'admin', isActive: true },
        { id: 'usr-DIRV', username: 'DIRV', name: 'مشرف عمليات بلا منح', password: hash, role: 'director', isActive: true },
        { id: 'usr-OPERV', username: 'OPERV', name: 'مستخدم تشغيل بلا منح', password: hash, role: 'operator', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    for (const col of [['phone_verified', 'INTEGER NOT NULL DEFAULT 0'], ['phone_verified_at', 'DATETIME'], ['phone_verified_by', 'TEXT']]) {
        const cols = dbw.prepare('PRAGMA table_info(employees)').all();
        if (!cols.some(c => c.name === col[0])) dbw.exec(`ALTER TABLE employees ADD COLUMN ${col[0]} ${col[1]}`);
    }
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, phone, is_active, phone_verified, phone_verified_by) VALUES (?,?,?,?,1,?,?)');
    insEmp.run('EMPV', 'موظف بوابة فقط', 'فني اسعاف', '0501111111', 1, 'seed');
    const eV2 = insEmp.run('VIS2', 'موظف مراقَب', 'أخصائي اسعاف', '0502222222', 1, 'seed').lastInsertRowid;
    // منح فردية مباشرة — EMPV: ops.my_portal · PHONEV: staff.phone_view · ADMG: admin.users_manage · ADMP: staff.phone_view
    // ADMV (admin نجمة) وDIRV (director) وOPERV (operator): بلا أي منحة — لاختبار التشديد وعدم المنح التلقائي
    const grant = dbw.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)');
    grant.run('emp-EMPV', 'ops.my_portal', 'test');
    grant.run('emp-PHONEV', 'staff.phone_view', 'test');
    grant.run('adm-ADMG', 'admin.users_manage', 'test');
    grant.run('adm-ADMP', 'staff.phone_view', 'test');
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — طبقات ظهور بيانات الموظفين (مع تشديد النجمة)');
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
    // فحص شامل للمسارات الثلاثة: يرجع { listLeaks, searchLeaks, getLeaks, rec }
    async function probeAll(tok) {
        const l = await apiGet('/api/employees', tok);
        const s = await apiGet('/api/employees/search?q=مراق', tok);
        const g = await apiGet('/api/employees/' + eV2, tok);
        return {
            statuses: [l.status, s.status, g.status],
            rec: (l.body.employees || []).find(e => e.employee_code === 'VIS2'),
            sRec: (s.body.results || [])[0],
            gRec: g.body.employee,
            leaks: (l.body.employees || []).flatMap(e => leakKeys(e))
                .concat((s.body.results || []).flatMap(e => leakKeys(e)))
                .concat(leakKeys(g.body.employee))
        };
    }

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const empv = await login('EMPV', 'testpass123');
        const phonev = await login('PHONEV', 'testpass123');
        const admv = await login('ADMV', 'testpass123');
        const admg = await login('ADMG', 'testpass123');
        const admp = await login('ADMP', 'testpass123');
        const dirv = await login('DIRV', 'testpass123');
        const operv = await login('OPERV', 'testpass123');
        if (!empv.token || !phonev.token || !admv.token || !admg.token || !admp.token || !dirv.token || !operv.token)
            throw new Error('فشل دخول أحد الحسابات التجريبية');

        // ── 1) موظف ops.my_portal فقط: القائمة الكاملة بلا phone ولا phone_verified* ──
        const p1 = await probeAll(empv.token);
        check('1) ops.my_portal فقط — المسارات الثلاثة: لا phone ولا phone_verified* في أي سجل',
            p1.statuses.every(s => s === 200) && p1.leaks.length === 0 && !!p1.rec && !!p1.rec.name,
            JSON.stringify({ st: p1.statuses, leaks: p1.leaks }));

        // ── 2) حامل staff.phone_view: يرى phone في الثلاثة — ولا يرى phone_verified* إطلاقًا ──
        const p2 = await probeAll(phonev.token);
        const verLeak2 = p2.leaks.filter(k => k !== 'phone');
        check('2) staff.phone_view — يظهر phone في الثلاثة، ولا يظهر phone_verified* حتى بطلب مباشر',
            p2.statuses.every(s => s === 200)
            && p2.rec && p2.rec.phone === '0502222222'
            && p2.sRec && p2.sRec.phone === '0502222222'
            && p2.gRec && p2.gRec.phone === '0502222222'
            && verLeak2.length === 0,
            JSON.stringify({ st: p2.statuses, verLeak: verLeak2 }));

        // ── 3) اختبار المالك الصريح: admin بالنجمة بلا منحة فردية — لا يرى الحقول الإدارية ولا الجوال ──
        const p3 = await probeAll(admv.token);
        check('3) admin (نجمة *) بلا منحة admin.users_manage — لا phone ولا phone_verified* في المسارات الثلاثة',
            p3.statuses.every(s => s === 200) && p3.leaks.length === 0 && !!p3.rec && !!p3.rec.name,
            JSON.stringify({ st: p3.statuses, leaks: p3.leaks, keys: p3.rec && Object.keys(p3.rec) }));

        // ── 4) admin بمنحة فردية admin.users_manage: يرى phone + phone_verified* كاملة ──
        const p4 = await probeAll(admg.token);
        check('4) admin + منحة فردية admin.users_manage — يرى phone + phone_verified + verified_at/by',
            p4.statuses.every(s => s === 200)
            && p4.rec && p4.rec.phone === '0502222222' && p4.rec.phone_verified === 1
            && Object.prototype.hasOwnProperty.call(p4.rec, 'phone_verified_at') && p4.rec.phone_verified_by === 'seed'
            && p4.gRec && p4.gRec.phone_verified === 1,
            JSON.stringify({ rec: p4.rec && { p: p4.rec.phone, v: p4.rec.phone_verified, by: p4.rec.phone_verified_by } }));

        // ── 5) admin بمنحة فردية staff.phone_view فقط: يرى phone ولا يرى phone_verified* ──
        const p5 = await probeAll(admp.token);
        const verLeak5 = p5.leaks.filter(k => k !== 'phone');
        check('5) admin + منحة staff.phone_view فقط — يرى phone ولا يرى phone_verified*',
            p5.statuses.every(s => s === 200)
            && p5.rec && p5.rec.phone === '0502222222' && p5.gRec && p5.gRec.phone === '0502222222'
            && verLeak5.length === 0,
            JSON.stringify({ verLeak: verLeak5 }));

        // ── 6) staff.phone_view لا تُمنح تلقائيًا: director وoperator بلا منح — أساسية فقط ──
        const p6a = await probeAll(dirv.token);
        const p6b = await probeAll(operv.token);
        check('6) لا منح تلقائي لأي دور: director وoperator بلا منحة — لا phone ولا phone_verified*',
            p6a.statuses.every(s => s === 200) && p6a.leaks.length === 0
            && p6b.statuses.every(s => s === 200) && p6b.leaks.length === 0,
            JSON.stringify({ dir: p6a.leaks, op: p6b.leaks }));

        // ── 7) إثبات ثابت: staff.phone_view غير موجودة في أي قائمة دور في config/permissions.js ──
        {
            const cfg = fs.readFileSync(path.join(ROOT, 'config', 'permissions.js'), 'utf8');
            const rolesBlock = cfg.slice(cfg.indexOf('const ROLES_PERMISSIONS'));
            check('7) إثبات ثابت: ROLES_PERMISSIONS لا تحوي staff.phone_view إطلاقًا (منح فردي حصرًا)',
                rolesBlock.indexOf('staff.phone_view') === -1, '');
        }

        // ── 8) غير المسجّل: 401 على المسارات الثلاثة ──
        const u8a = await apiGet('/api/employees', null);
        const u8b = await apiGet('/api/employees/search?q=x', null);
        const u8c = await apiGet('/api/employees/' + eV2, null);
        check('8) بلا توكن: 401 على الثلاثة', u8a.status === 401 && u8b.status === 401 && u8c.status === 401,
            JSON.stringify([u8a.status, u8b.status, u8c.status]));

        // ── 9) التوثيق والإلغاء لا يتأثران (authorize بالدور — admin يمر) ──
        const un9 = await apiPost('/api/employees/' + eV2 + '/unverify-phone', { confirmResponsibility: true }, admv.token);
        const mid9 = dbRead(d => d.prepare('SELECT phone_verified FROM employees WHERE id = ?').get(eV2));
        const re9 = await apiPost('/api/employees/' + eV2 + '/verify-phone', { confirmResponsibility: true }, admv.token);
        const end9 = dbRead(d => d.prepare('SELECT phone_verified, phone_verified_by FROM employees WHERE id = ?').get(eV2));
        check('9) التوثيق/الإلغاء يعملان: unverify ← 0 ثم verify ← 1 مع تسجيل المدير',
            un9.status === 200 && mid9.phone_verified === 0 && re9.status === 200 && end9.phone_verified === 1 && !!end9.phone_verified_by,
            JSON.stringify({ un: un9.status, mid: mid9, re: re9.status, end: end9 }));

        // ── 10) دورة استعادة كاملة بـmock لا تتأثر (EMPV موظفه موثق) ──
        await apiPost('/api/auth/forgot-password', { identifier: 'EMPV' });
        const v10 = await apiPost('/api/auth/verify-reset-code', { identifier: 'EMPV', code: MOCK_CODE });
        const rs10 = v10.body.resetToken
            ? await apiPost('/api/auth/reset-password', { token: v10.body.resetToken, newPassword: 'newpass999' })
            : { status: 0 };
        const relog = await login('EMPV', 'newpass999');
        check('10) الاستعادة لا تتأثر: forgot ← verify ← reset ← دخول بالجديدة',
            v10.status === 200 && rs10.status === 200 && relog.status === 200,
            JSON.stringify({ v: v10.status, rs: rs10.status, relog: relog.status }));

        // ── 11) شكل الاستجابة لا ينكسر: search يعيد {success, results[]} بحقول الواجهة ──
        // ملاحظة: فحص 10 أبطل جلسة EMPV القديمة (سلوك مقصود) — نستخدم توكن الدخول الجديد
        const s11 = await apiGet('/api/employees/search?q=موظف', relog.token);
        const r11 = (s11.body.results || [])[0];
        check('11) توافق الواجهات: search ← {success, results} بحقول name/employee_code/job_title/symbol/is_active',
            s11.status === 200 && s11.body.success === true && Array.isArray(s11.body.results)
            && r11 && ['employee_code', 'name', 'job_title', 'symbol', 'is_active', 'pattern_code'].every(k => Object.prototype.hasOwnProperty.call(r11, k)),
            JSON.stringify({ s: s11.status, keys: r11 && Object.keys(r11) }));

        // ── 12) القائمة الكاملة: حقول الطبقة الأساسية حاضرة لأي مستخدم ──
        const rec12 = p1.rec;
        check('12) الطبقة الأساسية كاملة: id/employee_code/name/job_title/symbol/is_active/pattern_code/created_at',
            !!rec12 && ['id', 'employee_code', 'name', 'job_title', 'symbol', 'is_active', 'pattern_code', 'created_at'].every(k => Object.prototype.hasOwnProperty.call(rec12, k)),
            JSON.stringify(rec12 && Object.keys(rec12)));

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
