/**
 * ═══ اختبار توافق sysadmin مع الحراس القديمة — sysadmin-compat-test.js ═══
 * (معتمد التصميم 2026-08-18) يثبت على خادم معزول:
 *  1) authorize(['admin']) وauthorize(['admin','director']) يمرّان sysadmin (نجمة من config)
 *  2) دور admin القديم يبقى يمر كما كان (لا كسر توافق)
 *  3) operator/field_leadership/viewer يبقون مرفوضين 403 على نفس المسارات — لا صلاحية إدارية جديدة
 *  4) البوابة لا تُفتح إلا إذا كانت القائمة تتضمن 'admin' أصلًا (فحص ساكن للشيم)
 *  5) الواجهة: التسميات + حراس الجداول/الرموز/المساعد تستخدم الصلاحيات/النجمة (فحص ساكن)
 * العزل: VACUUM INTO + DATA_DIR مؤقت — لا يمس القاعدة ولا users.json الأصليين.
 * التشغيل: node scripts/sysadmin-compat-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'syscompat-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'syscompat-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3096;
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

// عينات آمنة (GET) من الحراس القديمة — [path, نوع القائمة]
const LEGACY_ADMIN_ONLY = ['/api/users', '/api/auth/sessions', '/api/admin/stats', '/api/admin/monitor/health', '/api/admin/monitor/alerts', '/api/admin/frontend-errors'];
const LEGACY_ADMIN_DIRECTOR = ['/api/disk-usage', '/api/schedule-symbols', '/api/schedule-symbols/audit', '/api/get-password', '/api/shift-change-request', '/api/ai/v2/knowledge', '/api/ai/v2/stats', '/api/ai/v2/unanswered', '/api/indicators/contribution'];

(async () => {
    // ── فحص ساكن للشيم ──
    console.log('🧪 الفحص الساكن:');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('الشيم مشتق من ROLES_PERMISSIONS (المصدر الوحيد للنجمة)', serverSrc.includes("require('./config/permissions')") && serverSrc.includes('isStarRole'));
    check('الشيم يفتح فقط بوابات تتضمن admin أصلًا', serverSrc.includes("roles.includes('admin') && isStarRole(req.user.role)"));
    check('لا alias نصي أعمى: authorize لا يحوّل sysadmin إلى admin', !serverSrc.includes("role = 'admin'") && !serverSrc.includes('role = "admin"'));

    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const symSrc = fs.readFileSync(path.join(ROOT, 'public', 'admin-symbols.html'), 'utf8');
    const ssSrc = fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8');
    const ceSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'smart-schedule-cell-editor.js'), 'utf8');
    const ddSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'smart-schedule-dragdrop.js'), 'utf8');
    const aiSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ai-assistant.js'), 'utf8');
    const wfSrc = fs.readFileSync(path.join(ROOT, 'public', 'workflow.html'), 'utf8');
    check('app.js: roleLabel يعرض sysadmin = مدير النظام', appSrc.includes("sysadmin: 'مدير النظام'"));
    check('app.js: applyUserPermissions يقبل sysadmin لعناصر .admin-only', appSrc.includes("user.role === 'admin' || user.role === 'sysadmin'"));
    check('إدارة الرموز: تقبل permissions_star', symSrc.includes('me.permissions_star === true'));
    check('الجداول: شريط التحرير بصلاحيات schedule.* عبر __schedPermsState', ssSrc.includes('__schedPermsState') && ssSrc.includes("'schedule.edit_cell'"));
    check('محرر الخلية: canEdit بـ schedule.edit_cell/النجمة', ceSrc.includes("st.perms.indexOf('schedule.edit_cell')"));
    check('السحب والإفلات: canEdit بـ schedule.swap', ddSrc.includes("st.perms.indexOf('schedule.swap')"));
    check('المساعد الذكي: isAdmin يقبل permissions_star', aiSrc.includes('cu.permissions_star === true'));
    check('workflow: خريطة التسميات تشمل الأدوار الخمسة', wfSrc.includes("field_leadership: 'القيادة الميدانية'"));

    // ── عزل وتشغيل ──
    console.log('\n📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    console.log('🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    if (!(await waitReady())) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security.js'));
        const tok = (id, role) => jwt.sign({ id, role, name: 'مجس ' + id }, securityConfig.JWT_SECRET);
        const T_SYS = tok('probe-sys', 'sysadmin');
        const T_ADMIN = tok('probe-admin', 'admin');
        const T_OP = tok('probe-op', 'operator');
        const T_FL = tok('probe-fl', 'field_leadership');
        const T_VW = tok('probe-vw', 'viewer');

        // auth/me للمجس sysadmin: دوره + نجمته
        const me = await api('/api/auth/me', { token: T_SYS });
        check('auth/me: sysadmin role=sysadmin + permissions_star=true', me.status === 200 && me.data.user.role === 'sysadmin' && me.data.permissions_star === true, JSON.stringify({ role: me.data && me.data.user && me.data.user.role, star: me.data && me.data.permissions_star }));

        console.log('\n🛡️ عينات authorize([\'admin\']) القديمة:');
        for (const p of LEGACY_ADMIN_ONLY) {
            const rSys = await api(p, { token: T_SYS });
            const rAdm = await api(p, { token: T_ADMIN });
            const rOp = await api(p, { token: T_OP });
            const rFl = await api(p, { token: T_FL });
            const rVw = await api(p, { token: T_VW });
            check(p + ': sysadmin يمر (≠403)', rSys.status !== 403, 'status=' + rSys.status);
            check(p + ': admin القديم يمر كما كان', rAdm.status !== 403, 'status=' + rAdm.status);
            check(p + ': operator/field_leadership/viewer يبقون 403', rOp.status === 403 && rFl.status === 403 && rVw.status === 403, [rOp.status, rFl.status, rVw.status].join(','));
        }

        console.log('\n🛡️ عينات authorize([\'admin\',\'director\']) القديمة:');
        for (const p of LEGACY_ADMIN_DIRECTOR) {
            const rSys = await api(p, { token: T_SYS });
            const rOp = await api(p, { token: T_OP });
            const rFl = await api(p, { token: T_FL });
            check(p + ': sysadmin يمر (≠403)', rSys.status !== 403, 'status=' + rSys.status);
            check(p + ': operator/field_leadership يبقون 403', rOp.status === 403 && rFl.status === 403, [rOp.status, rFl.status].join(','));
        }

        // مسارات authorizePerm الجديدة لا تتأثر: viewer يبقى 403 على التنفيذ
        const rBound = await api('/api/shift-completion', { method: 'POST', token: T_VW, body: {} });
        check('مسارات authorizePerm الجديدة لم تتأثر بالشيم (viewer ← 403 على التكميل)', rBound.status === 403 && rBound.data && rBound.data.code === 'PERMISSION_DENIED');
        // ومسارات الإدارة الجديدة (admin.users_manage) تبقى بـ authorizePerm — operator مرفوض
        const rUsers = await api('/api/permissions/catalog', { token: T_OP });
        check('إدارة الصلاحيات نفسها تبقى authorizePerm — operator ← 403', rUsers.status === 403);
        const rUsersSys = await api('/api/permissions/catalog', { token: T_SYS });
        check('إدارة الصلاحيات: sysadmin يمر بنجمته عبر authorizePerm', rUsersSys.status === 200);
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }

    console.log('\n' + '═'.repeat(50));
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('★ كل اختبارات توافق sysadmin ناجحة');
})().catch(e => { console.error('فشل غير متوقع:', e); process.exit(1); });
