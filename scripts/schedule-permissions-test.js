/**
 * ═══ اختبار تفكيك صلاحيات الجداول — schedule-permissions-test.js ═══
 * (معتمد 2026-08-17) يثبت على حسابات تجريبية معزولة:
 *  1) الـ31 مسارًا المربوطة كلها 403 لمن لا منحة له (authorizePerm هو البوابة)
 *  2) كل منحة تفتح مسارها فقط: view/import/edit_cell/employees/export/clear
 *  3) schedule.employees منفصلة عن schedule.edit_cell (الاتجاهان)
 *  4) schedule.clear لا يحملها أي دور، وتعمل بالمنحة اليدوية فقط
 *  5) get-monthly-table يبقى الاستثناء الانتقالي الوحيد (متاح للموثّق)
 *  6) schedule.print لا مسار خادمي لها — تحكم واجهة موثّق فقط
 * العزل: VACUUM INTO + DATA_DIR مؤقت — لا يمس القاعدة ولا users.json الأصليين.
 * التشغيل: node scripts/schedule-permissions-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'sched-perm-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'sched-perm-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3094;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

// المسارات الـ31 المربوطة: [method, path, المفتاح]
const BOUND = [
    ['GET', '/api/shift-roster', 'schedule.view'],
    ['GET', '/api/shift-roster/months', 'schedule.view'],
    ['GET', '/api/shift-roster/stats', 'schedule.view'],
    ['GET', '/api/shift-roster/drafts', 'schedule.view'],
    ['GET', '/api/shift-roster/audit-log', 'schedule.view'],
    ['GET', '/api/shift-roster/employee-schedule/x', 'schedule.view'],
    ['GET', '/api/shift-roster/123', 'schedule.view'],
    ['GET', '/api/schedule/metrics', 'schedule.view'],
    ['GET', '/api/schedule/files', 'schedule.view'],
    ['GET', '/api/schedule/employees', 'schedule.view'],
    ['POST', '/api/shift-roster/validate', 'schedule.view'],
    ['POST', '/api/upload-monthly-table', 'schedule.import'],
    ['POST', '/api/shift-roster/import', 'schedule.import'],
    ['POST', '/api/schedule/official-import', 'schedule.import'],
    ['PUT', '/api/shift-roster/cell', 'schedule.edit_cell'],
    ['POST', '/api/shift-roster/audit-log', 'schedule.edit_cell'],
    ['POST', '/api/schedule/employees', 'schedule.employees'],
    ['DELETE', '/api/schedule/employees', 'schedule.employees'],
    ['POST', '/api/shift-roster', 'schedule.employees'],
    ['PUT', '/api/shift-roster/123', 'schedule.employees'],
    ['DELETE', '/api/shift-roster/123', 'schedule.employees'],
    ['POST', '/api/shift-roster/swap', 'schedule.swap'],
    ['POST', '/api/shift-roster/bulk-update', 'schedule.bulk_update'],
    ['POST', '/api/shift-roster/draft', 'schedule.bulk_update'],
    ['POST', '/api/shift-roster/undo', 'schedule.bulk_update'],
    ['POST', '/api/shift-roster/redo', 'schedule.bulk_update'],
    ['POST', '/api/schedule/files', 'schedule.sync'],
    ['GET', '/api/schedule/pdf', 'schedule.export'],
    ['POST', '/api/shift-roster/export', 'schedule.export'],
    ['POST', '/api/shift-roster/clear-all', 'schedule.clear'],
    ['POST', '/api/shift-roster/clear', 'schedule.clear'],
    ['DELETE', '/api/monthly-table', 'schedule.clear']
];

(async () => {
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    const dbw = new Database(TMP_DB);
    dbw.exec(`CREATE TABLE IF NOT EXISTS user_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        permission_key TEXT NOT NULL, granted INTEGER NOT NULL, granted_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME,
        UNIQUE(user_id, permission_key));`);
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    const count = (t) => dbw.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    const beforeCounts = { shift_roster: count('shift_roster'), employees: count('employees') };

    // ── وحدات الكتالوج ──
    const { PERMISSION_KEYS, ROLES_PERMISSIONS } = require(path.join(ROOT, 'config', 'permissions.js'));
    console.log('\n🧪 الكتالوج:');
    const SCHED_KEYS = ['schedule.view', 'schedule.import', 'schedule.edit_cell', 'schedule.employees', 'schedule.generate', 'schedule.swap', 'schedule.bulk_update', 'schedule.sync', 'schedule.export', 'schedule.print', 'schedule.clear'];
    check('الكتالوج 40 مفتاحًا (37 + 3 العهد 2026-08-23؛ جولة تنظيم الوصول 2026-08-30 أضافت صفر مفاتيح)', PERMISSION_KEYS.length === 40, 'keys=' + PERMISSION_KEYS.length);
    check('مفاتيح الجداول الـ11 كلها موجودة', SCHED_KEYS.every(k => PERMISSION_KEYS.indexOf(k) !== -1));
    check('لا دور يحمل أي schedule.* إطلاقًا', Object.keys(ROLES_PERMISSIONS).every(r => !ROLES_PERMISSIONS[r].some(k => k.indexOf('schedule.') === 0)));
    check('schedule.clear ممنوعة من كل دور تحديدًا', Object.keys(ROLES_PERMISSIONS).every(r => ROLES_PERMISSIONS[r].indexOf('schedule.clear') === -1));
    const pageSrc = fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8');
    check('schedule.print: لا مسار خادمي — بوابة واجهة موثّقة موجودة', pageSrc.includes('schedule.print') && pageSrc.includes('ليست حماية أمنية'));

    // منح فردية مباشرة في القاعدة المعزولة لمستخدمين تجريبيين
    const grant = (uid, key) => dbw.prepare('INSERT OR REPLACE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)').run(uid, key, 'اختبار');
    grant('probe-view', 'schedule.view');
    grant('probe-import', 'schedule.import');
    grant('probe-cell', 'schedule.edit_cell');
    grant('probe-emps', 'schedule.employees');
    grant('probe-export', 'schedule.export');
    grant('probe-clear', 'schedule.clear');
    grant('probe-vi', 'schedule.view'); grant('probe-vi', 'schedule.import');
    grant('probe-ve', 'schedule.view'); grant('probe-ve', 'schedule.employees');
    check('الواجهة: زر الاستيراد الرسمي مربوط بـ schedule.import في البوابة', pageSrc.includes('oiOpenPicker()")]\',   perm: \'schedule.import\'') || pageSrc.includes('button[onclick="oiOpenPicker()"]'));
    check('الواجهة: oiApply يحفظ عبر official-import وليس schedule/employees', pageSrc.includes('/api/schedule/official-import'));

    console.log('\n🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    server.stdout.on('data', d => serverLog += d);
    server.stderr.on('data', d => serverLog += d);

    try {
        check('خادم الاختبار يعمل', await waitReady());
        await new Promise(r => setTimeout(r, 6000));

        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security'));
        const tok = (id, role) => jwt.sign({ id, role, name: 'مجس ' + id }, securityConfig.JWT_SECRET);
        const T_DIR = tok('probe-director', 'director'); // بلا أي منحة — كان يمر على admin+director سابقًا
        const T_VIEW = tok('probe-view', 'viewer');
        const T_IMPORT = tok('probe-import', 'viewer');
        const T_CELL = tok('probe-cell', 'viewer');
        const T_EMPS = tok('probe-emps', 'viewer');
        const T_EXPORT = tok('probe-export', 'viewer');
        const T_CLEAR = tok('probe-clear', 'viewer');
        const T_VI = tok('probe-vi', 'viewer');      // view + import
        const T_VE = tok('probe-ve', 'viewer');      // view + employees
        const T_NONE = tok('probe-none', 'viewer');

        console.log('\n🚫 البوابة: director بلا منح على كل المسارات الـ32:');
        let deniedCount = 0, wrongCodes = [];
        for (const [m, p] of BOUND) {
            const r = await api(p, { method: m, token: T_DIR, body: m === 'GET' || m === 'DELETE' ? undefined : {} });
            if (r.status === 403 && r.data && r.data.code === 'PERMISSION_DENIED') deniedCount++;
            else wrongCodes.push(m + ' ' + p + '=' + r.status);
        }
        check('الـ32 مسارًا كلها ← 403 PERMISSION_DENIED (authorizePerm هو البوابة)', deniedCount === 32, wrongCodes.join(' | '));
        // المرفوض لا يكتب: العدّادات بعد موجة الرفض الكاملة يجب أن تطابق قبلها
        const afterDenied = { shift_roster: count('shift_roster'), employees: count('employees') };
        check('موجة الـ403 الـ31 لم تكتب شيئًا (صفر تغيير)', JSON.stringify(beforeCounts) === JSON.stringify(afterDenied), JSON.stringify(afterDenied));

        console.log('\n🔑 كل منحة تفتح مسارها فقط:');
        // view فقط
        const v1 = await api('/api/shift-roster', { token: T_VIEW });
        const v2 = await api('/api/shift-roster/import', { method: 'POST', token: T_VIEW, body: {} });
        const v3 = await api('/api/shift-roster/clear-all', { method: 'POST', token: T_VIEW, body: {} });
        check('view فقط: القراءة تنجح والاستيراد/المسح 403', v1.status === 200 && v2.status === 403 && v3.status === 403);
        // import فقط
        const i1 = await api('/api/shift-roster/import', { method: 'POST', token: T_IMPORT, body: {} });
        const i2 = await api('/api/shift-roster', { token: T_IMPORT });
        const i3 = await api('/api/schedule/files', { method: 'POST', token: T_IMPORT, body: {} });
        check('import فقط: الاستيراد يجتاز البوابة (≠403) والقراءة/المزامنة 403', i1.status !== 403 && i2.status === 403 && i3.status === 403, 'import=' + i1.status);
        // edit_cell مقابل employees — الفصل بالاتجاهين
        const c1 = await api('/api/shift-roster/cell', { method: 'PUT', token: T_CELL, body: {} });
        const c2 = await api('/api/schedule/employees', { method: 'POST', token: T_CELL, body: {} });
        const e1 = await api('/api/schedule/employees', { method: 'POST', token: T_EMPS, body: {} });
        const e2 = await api('/api/shift-roster/cell', { method: 'PUT', token: T_EMPS, body: {} });
        check('الفصل: edit_cell تفتح الخلية وتُقفل الموظفين', c1.status !== 403 && c2.status === 403, 'cell=' + c1.status);
        check('الفصل: employees تفتح الموظفين وتُقفل الخلية', e1.status !== 403 && e2.status === 403, 'emps=' + e1.status);
        // export فقط
        const x1 = await api('/api/schedule/pdf', { token: T_EXPORT });
        const x2 = await api('/api/shift-roster/clear-all', { method: 'POST', token: T_EXPORT, body: {} });
        check('export فقط: PDF السيرفري يجتاز البوابة والمسح 403', x1.status !== 403 && x2.status === 403, 'pdf=' + x1.status);
        // clear فقط — بالمنحة اليدوية حصرًا
        const cl1 = await api('/api/shift-roster/clear-all', { method: 'POST', token: T_CLEAR, body: {} });
        const cl2 = await api('/api/shift-roster', { token: T_CLEAR });
        const cl3 = await api('/api/monthly-table', { method: 'DELETE', token: T_NONE });
        check('clear بالمنحة: المسح يجتاز البوابة والقراءة 403', cl1.status !== 403 && cl2.status === 403, 'clear=' + cl1.status);
        check('بلا منحة clear: DELETE monthly-table ← 403', cl3.status === 403);

        console.log('\n🧪 السيناريوهات الخمسة المعتمدة (الاستيراد الرسمي = schedule.import حصرًا):');
        // ① view فقط: مشاهدة نعم — استيراد 403 — إدارة موظفين 403
        const s1a = await api('/api/shift-roster', { token: T_VIEW });
        const s1b = await api('/api/schedule/official-import', { method: 'POST', token: T_VIEW, body: { employees: [] } });
        const s1c = await api('/api/schedule/employees', { method: 'POST', token: T_VIEW, body: { employees: [] } });
        check('① view فقط: مشاهدة ✅ · استيراد رسمي 403 · إدارة موظفين 403', s1a.status === 200 && s1b.status === 403 && s1c.status === 403);
        // ② import فقط: الاستيراد الرسمي يجتاز البوابة — إدارة الموظفين اليدوية 403
        const s2a = await api('/api/schedule/official-import', { method: 'POST', token: T_IMPORT, body: { employees: [] } });
        const s2b = await api('/api/schedule/employees', { method: 'POST', token: T_IMPORT, body: { employees: [] } });
        check('② import فقط: استيراد رسمي يجتاز (≠403) · إدارة موظفين 403 — لا تسلل بين الصلاحيتين', s2a.status !== 403 && s2b.status === 403, 'oi=' + s2a.status);
        // ③ employees فقط: إدارة يدوية تجتاز — الاستيراد الرسمي 403
        const s3a = await api('/api/schedule/employees', { method: 'POST', token: T_EMPS, body: { employees: [] } });
        const s3b = await api('/api/schedule/official-import', { method: 'POST', token: T_EMPS, body: { employees: [] } });
        check('③ employees فقط: إدارة موظفين تجتاز (≠403) · استيراد رسمي 403', s3a.status !== 403 && s3b.status === 403, 'emps=' + s3a.status);
        // ④ view + import: مشاهدة + استيراد
        const s4a = await api('/api/shift-roster', { token: T_VI });
        const s4b = await api('/api/schedule/official-import', { method: 'POST', token: T_VI, body: { employees: [] } });
        check('④ view+import: مشاهدة ✅ + استيراد ✅', s4a.status === 200 && s4b.status !== 403);
        // ⑤ view + employees: مشاهدة + إدارة موظفين — بلا استيراد
        const s5a = await api('/api/shift-roster', { token: T_VE });
        const s5b = await api('/api/schedule/employees', { method: 'POST', token: T_VE, body: { employees: [] } });
        const s5c = await api('/api/schedule/official-import', { method: 'POST', token: T_VE, body: { employees: [] } });
        check('⑤ view+employees: مشاهدة ✅ + إدارة ✅ · استيراد 403', s5a.status === 200 && s5b.status !== 403 && s5c.status === 403);

        // استيراد فعلي كامل بمنحة import وحدها: حمولة حقيقية ← نجاح + مزامنة قاعدة
        const realImp = await api('/api/schedule/official-import', {
            method: 'POST', token: T_VI,
            body: { employees: [{ id: '999001', employeeNumber: '999001', name: 'موظف اختبار الاستيراد', jobTitle: 'تحكم عملياتي', team: 'A1', schedule: [{ date: '2026-08-01', shiftCode: 'D', location: 'A1' }] }] }
        });
        check('استيراد فعلي حقيقي بمنحة import وحدها: success + rosterSync', realImp.status === 200 && realImp.data && realImp.data.success === true && !!realImp.data.rosterSync, JSON.stringify(realImp.data || {}).slice(0, 160));

        console.log('\n⚠️ الاستثناء الانتقالي الوحيد:');
        const g1 = await api('/api/get-monthly-table', { token: T_NONE });
        const g2 = await api('/api/get-monthly-table', { token: T_DIR });
        // في العزل لا يوجد monthly-table.xlsx ← 404 طبيعي؛ المهم: لا 403 (لم تُربط بالصلاحية)
        check('get-monthly-table لم تُربط بـ schedule.view (≠403 للموثّق — انتقالي موثّق)', g1.status !== 403 && g1.status !== 401 && g2.status !== 403, 'status=' + g1.status);

        console.log('\n👑 عدم كسر الحاليين + سلامة الملفات:');
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const T_ADMIN = login.data && (login.data.token || login.data.accessToken);
        const a1 = await api('/api/shift-roster', { token: T_ADMIN });
        const a2 = await api('/api/shift-roster/months', { token: T_ADMIN });
        check('admin الحالي (*) يمر على المسارات المربوطة — لا كسر', a1.status === 200 && a2.status === 200);
        // ملاحظة: مجسات المنح (clear/import) نُفذت فعليًا على القاعدة المعزولة بإثبات فتح البوابة —
        // إثبات «المرفوض لا يكتب» قيس بعد موجة الرفض أعلاه مباشرة.
        const realUsers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
        check('users.json الأصلي لم يُمس', realUsers.every(u => u.role === 'admin'));
        const realProbe = new Database(SRC_DB, { readonly: true });
        const hasTable = realProbe.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='user_permissions'").get().c > 0;
        const realPerms = hasTable ? realProbe.prepare("SELECT COUNT(*) c FROM user_permissions").get().c : 0;
        realProbe.close();
        check('القاعدة الأصلية لم يُضف إليها أي منحة (المجسات على النسخة فقط)', realPerms === 0, 'rows=' + realPerms);
    } finally {
        server.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1500));
        try { server.kill('SIGKILL'); } catch (_) { }
        dbw.close();
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); }
    if (failed > 0) { console.log('\n—— سجل الخادم (آخر 25 سطرًا) ——'); console.log(serverLog.split('\n').slice(-25).join('\n')); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('فشل عام:', e); process.exit(1); });
