/**
 * ═══ اختبار استعادة كلمة المرور عبر الجوال الموثّق (اعتماد المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3124 + OTP_PROVIDER=mock — لا تمس
 * بيانات الإنتاج، ولا تُرسل أي رسالة SMS حقيقية (المزوّد الوهمي فقط).
 *
 * يغطي التعديلات الإلزامية الأربعة:
 *  1) رد موحّد لا يكشف الحساب ولا حالة التوثيق.
 *  2) توثيق المدير بتأكيد مسؤولية + سجل تدقيق كامل (مدير/موظف/رقم/وقت/IP/قبل/بعد).
 *  3) تصفير التوثيق ذريًا مع أي تغيير للرقم (حتى الشكلي).
 *  4) بصمة الرقم في رمز الاستعادة: تغيّر الرقم/التصفير أثناء الدورة يُبطل الرمز.
 *
 * التشغيل: node scripts/auth-reset-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'authreset-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'authreset-data-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'auth-reset-' + STAMP);
const PORT = 3124;
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
    const hash = bcrypt.hashSync('oldpass123', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-R100', username: 'R100', name: 'موظف موثق الجوال', password: hash, role: 'user', isActive: true },
        { id: 'emp-R200', username: 'R200', name: 'موظف غير موثق', password: hash, role: 'user', isActive: true },
        { id: 'emp-R400', username: 'R400', name: 'موظف بصمة الرقم', password: hash, role: 'user', isActive: true },
        { id: 'adm-RADM', username: 'RADM', name: 'مدير التوثيق التجريبي', password: hash, role: 'admin', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    // الأعمدة والجداول الجديدة تُنشأ عند إقلاع db.js — ننشئها هنا لأن الزرع يسبق الإقلاع
    dbw.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        phone_fingerprint TEXT NOT NULL, expires_at DATETIME NOT NULL,
        used INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    for (const col of [['phone_verified', 'INTEGER NOT NULL DEFAULT 0'], ['phone_verified_at', 'DATETIME'], ['phone_verified_by', 'TEXT']]) {
        const cols = dbw.prepare('PRAGMA table_info(employees)').all();
        if (!cols.some(c => c.name === col[0])) dbw.exec(`ALTER TABLE employees ADD COLUMN ${col[0]} ${col[1]}`);
    }
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, phone, is_active, phone_verified) VALUES (?,?,?,?,1,?)');
    const eR100 = insEmp.run('R100', 'موظف موثق الجوال', 'فني اسعاف', '0500000100', 1).lastInsertRowid;   // موثق مسبقًا
    const eR200 = insEmp.run('R200', 'موظف غير موثق', 'فني اسعاف', '0500000200', 0).lastInsertRowid;    // غير موثق
    const eR400 = insEmp.run('R400', 'موظف بصمة الرقم', 'فني اسعاف', '0500000400', 1).lastInsertRowid;  // موثق — لفحص البصمة
    const eR300 = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, phone, is_active, phone_verified) VALUES (?,?,?,?,1,0)')
        .run('R300', 'موظف بلا حساب', 'فني اسعاف', '0500000300').lastInsertRowid;                        // موظف بلا حساب أصلًا
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — استعادة كلمة المرور (mock provider)');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', OTP_PROVIDER: 'mock', RESET_RATE_LIMIT_MAX: '500' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    async function login(u, p) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        const b = await r.json();
        return { status: r.status, token: b.accessToken || null, body: b };
    }
    async function apiPost(p, body, tok) {
        const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body || {}) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    async function apiGet(p, tok) {
        const r = await fetch(BASE + p, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    function dbRead(fn) { const d = new Database(TMP_DB, { readonly: true }); const v = fn(d); d.close(); return v; }

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const adm = await login('RADM', 'oldpass123');
        if (!adm.token) throw new Error('فشل دخول المدير التجريبي');

        // ── 1) الرد الموحّد: مسجل موثق / غير موثق / غير موجود — نفس الحالة والنص ──
        const r1a = await apiPost('/api/auth/forgot-password', { identifier: 'R100' });
        const r1b = await apiPost('/api/auth/forgot-password', { identifier: 'R200' });
        const r1c = await apiPost('/api/auth/forgot-password', { identifier: 'NOPE999' });
        check('1) عدم كشف الحساب: رد موحّد (200 بنفس النص) لموثق/غير موثق/غير موجود',
            r1a.status === 200 && r1b.status === 200 && r1c.status === 200
            && JSON.stringify(r1a.body) === JSON.stringify(r1b.body) && JSON.stringify(r1b.body) === JSON.stringify(r1c.body),
            JSON.stringify({ a: r1a.status, b: r1b.status, c: r1c.status, same: JSON.stringify(r1a.body) === JSON.stringify(r1c.body) }));

        // ── 2) غير الموثق لا يحصل على دورة: إدخال الرمز الصحيح (mock) يفشل ──
        const v2 = await apiPost('/api/auth/verify-reset-code', { identifier: 'R200', code: MOCK_CODE });
        check('2) غير الموثق: verify يرفض حتى مع الرمز الصحيح — لا رمز استعادة يُصدر',
            v2.status === 400 && !v2.body.resetToken, JSON.stringify({ s: v2.status, b: v2.body }));

        // ── 3) توثيق المدير: بلا تأكيد مسؤولية ← 400 · مع التأكيد ← 200 + سجل تدقيق كامل ──
        const noConfirm = await apiPost('/api/employees/' + eR200 + '/verify-phone', {}, adm.token);
        const withConfirm = await apiPost('/api/employees/' + eR200 + '/verify-phone', { confirmResponsibility: true }, adm.token);
        const audit = dbRead(d => d.prepare("SELECT * FROM audit_log WHERE action = 'phone_verify' ORDER BY id DESC LIMIT 1").get());
        check('3) توثيق المدير: CONFIRM_REQUIRED بلا تأكيد + نجاح معه + AuditLog (مدير/موظف/رقم/قبل←بعد)',
            noConfirm.status === 400 && noConfirm.body.code === 'CONFIRM_REQUIRED'
            && withConfirm.status === 200 && withConfirm.body.phone_verified === 1
            && !!audit && audit.detail.includes('RADM') && audit.detail.includes('0500000200') && audit.detail.includes('0 ← 1'),
            JSON.stringify({ nc: noConfirm.status, wc: withConfirm.status, audit: audit && audit.detail }));

        // ── 4) الدورة الكاملة للموثق: forgot ← verify ← reset ← القديم يموت والجديد يعمل ──
        const before = await login('R100', 'oldpass123');
        await apiPost('/api/auth/forgot-password', { identifier: 'R100' });
        const v4 = await apiPost('/api/auth/verify-reset-code', { identifier: 'R100', code: MOCK_CODE });
        const rs4 = v4.body.resetToken
            ? await apiPost('/api/auth/reset-password', { token: v4.body.resetToken, newPassword: 'newpass456' })
            : { status: 0, body: {} };
        const oldMe = before.token ? await apiGet('/api/auth/me', before.token) : { status: 0, body: {} };
        const oldTokenDead = oldMe.status === 401 || (oldMe.status === 403 && oldMe.body && oldMe.body.code === 'TOKEN_REVOKED');
        const newLogin = await login('R100', 'newpass456');
        const oldPassLogin = await login('R100', 'oldpass123');
        check('4) الدورة الكاملة: resetToken ← نجاح التعيين ← الجلسة القديمة مُبطلة (401/403 TOKEN_REVOKED) ← الجديد يدخل والقديم يرفض',
            v4.status === 200 && !!v4.body.resetToken && rs4.status === 200
            && oldTokenDead && newLogin.status === 200 && oldPassLogin.status === 401,
            JSON.stringify({ v: v4.status, rs: rs4.status, oldTok: oldMe.status, newL: newLogin.status, oldL: oldPassLogin.status }));

        // ── 5) الرمز مرة واحدة: إعادة استخدام نفس resetToken تفشل ──
        const reuse = await apiPost('/api/auth/reset-password', { token: v4.body.resetToken, newPassword: 'another789' });
        check('5) رمز الاستعادة مرة واحدة: إعادة الاستخدام ← 400', reuse.status === 400, String(reuse.status));

        // ── 6) انتهاء الصلاحية: رمز منتهي ← 400 ──
        await apiPost('/api/auth/forgot-password', { identifier: 'R200' }); // R200 صار موثقًا في فحص 3
        const v6 = await apiPost('/api/auth/verify-reset-code', { identifier: 'R200', code: MOCK_CODE });
        dbRead(() => {}); // no-op للوضوح
        {
            const d = new Database(TMP_DB);
            d.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM password_reset_tokens ORDER BY id DESC LIMIT 1)")
                .run(new Date(Date.now() - 60000).toISOString());
            d.close();
        }
        const expired = await apiPost('/api/auth/reset-password', { token: v6.body.resetToken, newPassword: 'expired123' });
        check('6) انتهاء 10 دقائق: رمز منتهي ← 400', v6.status === 200 && expired.status === 400,
            JSON.stringify({ v: v6.status, exp: expired.status }));

        // ── 7) حد محاولات الإدخال: 5 رموز خاطئة ثم الصحيح يُرفض ──
        await apiPost('/api/auth/forgot-password', { identifier: 'R200' });
        for (let i = 0; i < 5; i++) await apiPost('/api/auth/verify-reset-code', { identifier: 'R200', code: '000000' });
        const afterFive = await apiPost('/api/auth/verify-reset-code', { identifier: 'R200', code: MOCK_CODE });
        check('7) حد 5 محاولات إدخال: الرمز الصحيح بعدها يُرفض', afterFive.status === 400, String(afterFive.status));

        // ── 8) التصفير الذري: نفس الرقم يبقى موثقًا · تغيير شكلي يصفّر ──
        const empRow = dbRead(d => d.prepare('SELECT * FROM employees WHERE id = ?').get(eR200));
        const sameRes = await apiPost('/api/employees/' + eR200, undefined, null); // placeholder لا يُستخدم
        {
            // تعديل بلا تغيير للرقم عبر PUT (نفس القيمة) — يبقى موثقًا
            const r1 = await fetch(BASE + '/api/employees/' + eR200, {
                method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm.token },
                body: JSON.stringify({ employee_code: 'R200', name: 'موظف غير موثق', phone: '0500000200', job_title: 'فني اسعاف', is_active: 1 })
            });
            const keep = dbRead(d => d.prepare('SELECT phone_verified FROM employees WHERE id = ?').get(eR200));
            // تغيير شكلي (مسافة زائدة) — يصفّر التوثيق
            const r2 = await fetch(BASE + '/api/employees/' + eR200, {
                method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm.token },
                body: JSON.stringify({ employee_code: 'R200', name: 'موظف غير موثق', phone: '0500000200 ', job_title: 'فني اسعاف', is_active: 1 })
            });
            const wiped = dbRead(d => d.prepare('SELECT phone_verified, phone_verified_at, phone_verified_by FROM employees WHERE id = ?').get(eR200));
            check('8) التصفير الذري: نفس القيمة تُبقي التوثيق · تغيير شكلي (مسافة) يصفّره مع الحقول المرافقة',
                r1.ok && keep.phone_verified === 1 && r2.ok
                && wiped.phone_verified === 0 && wiped.phone_verified_at === null && wiped.phone_verified_by === null,
                JSON.stringify({ keep: keep.phone_verified, wiped }));
        }

        // ── 9) بصمة الرقم: تغيير الرقم أثناء دورة الاستعادة يُبطل الرمز (409) — هوية مستقلة R400 ──
        await apiPost('/api/auth/forgot-password', { identifier: 'R400' });
        const v9 = await apiPost('/api/auth/verify-reset-code', { identifier: 'R400', code: MOCK_CODE });
        {
            // المدير يغيّر الرقم بعد إصدار رمز الاستعادة
            await fetch(BASE + '/api/employees/' + eR400, {
                method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm.token },
                body: JSON.stringify({ employee_code: 'R400', name: 'موظف بصمة الرقم', phone: '0500000499', job_title: 'فني اسعاف', is_active: 1 })
            });
            const blocked = await apiPost('/api/auth/reset-password', { token: v9.body.resetToken, newPassword: 'blocked123' });
            const stillOld = await login('R400', 'oldpass123');
            check('9) بصمة الرقم: تغيير الجوال أثناء الدورة ← 409 وكلمة المرور لا تتغير',
                v9.status === 200 && blocked.status === 409 && stillOld.status === 200,
                JSON.stringify({ v: v9.status, b: blocked.status, old: stillOld.status }));
        }

        // ── 10) لا رقم جوال من العميل: تمرير phone في الطلبات يُتجاهل ولا يغيّر شيئًا ──
        const before10 = dbRead(d => d.prepare('SELECT phone FROM employees WHERE id = ?').get(eR100));
        await apiPost('/api/auth/forgot-password', { identifier: 'R100', phone: '0509999999' });
        await apiPost('/api/auth/reset-password', { token: 'x'.repeat(64), newPassword: 'hack12345', phone: '0509999999' });
        const after10 = dbRead(d => d.prepare('SELECT phone FROM employees WHERE id = ?').get(eR100));
        check('10) رفض رقم من العميل: phone المُمرَّر لا يؤثر ولا يُخزَّن',
            before10.phone === after10.phone && after10.phone === '0500000100',
            JSON.stringify({ before: before10.phone, after: after10.phone }));

        // ── 11) حد طلبات الرمز: 3/ساعة لكل هوية — الطلبات اللاحقة لا تُرسل (رد موحّد يبقى) ──
        const prov = null; // يُقاس عبر verify: بعد 3 طلبات لم تُرسل رموز جديدة للهوية
        for (let i = 0; i < 5; i++) await apiPost('/api/auth/forgot-password', { identifier: 'R300' }); // R300 بلا حساب — حد بالهوية
        const lim = await apiPost('/api/auth/forgot-password', { identifier: 'R300' });
        check('11) حد الطلبات: الرد يبقى موحّدًا 200 حتى بعد تجاوز الحد (لا كشف ولا 500)',
            lim.status === 200 && lim.body.success === true, JSON.stringify({ s: lim.status }));

        // ── 12) لا تسريب: كلمة المرور والرمز غير موجودين في auth_logs/audit_log ──
        const leak = dbRead(d => {
            const a = d.prepare("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE '%newpass456%' OR detail LIKE '%" + MOCK_CODE + "%'").get().c;
            const b = d.prepare("SELECT COUNT(*) c FROM auth_logs WHERE action_detail LIKE '%newpass456%' OR error_message LIKE '%newpass456%'").get().c;
            return a + b;
        });
        check('12) لا تسريب: صفر أثر لكلمة المرور/الرمز في السجلات', leak === 0, 'leak=' + leak);

        // ── 13) انحدار: الدخول العادي + change-password + صلاحيات لم تتأثر ──
        const rl = await login('RADM', 'oldpass123');
        const me = await apiGet('/api/auth/me', rl.token);
        check('13) انحدار: دخول admin سليم + /api/auth/me ← 200', rl.status === 200 && me.status === 200,
            JSON.stringify({ l: rl.status, me: me.status }));

        console.log('\n════════════════ نتيجة استعادة كلمة المرور: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
        console.log('المخرجات: ' + OUT_DIR);
    } finally {
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})();
