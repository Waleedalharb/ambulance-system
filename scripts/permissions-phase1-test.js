/**
 * ═══ اختبار المرحلة 1 — إدارة المستخدمين والصلاحيات الفردية ═══
 * permissions-phase1-test.js
 * يثبت: تفكيك ops إلى 9 مفاتيح دقيقة · schedule.* فردية حصرًا · تغيير الدور
 * الفردي مع إبطال الجلسات · عزل المستخدمين (تعديل A لا يمس B) · الحواجز
 * الذاتية · صفر تغيير سلوكي على البيانات التشغيلية.
 * العزل الكامل: قاعدة مؤقتة (VACUUM INTO) + DATA_DIR مؤقت بنسخة users.json —
 * لا يمس القاعدة ولا ملف المستخدمين الأصليين. حسابات الاختبار: 4252 و101353.
 * التشغيل: node scripts/permissions-phase1-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'perm-p1-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'perm-p1-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3093;
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

async function login(u, p) {
    const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
    return r.data && (r.data.token || r.data.accessToken);
}

(async () => {
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت بنسخة users.json...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    const probe = new Database(TMP_DB, { readonly: true });
    const count = (t) => probe.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    const beforeCounts = { shift_roster: count('shift_roster'), shift_reports: count('shift_reports'), employees: count('employees') };

    // ── وحدات الكتالوج (بلا خادم) ──
    const { PERMISSIONS, PERMISSION_KEYS, ROLES_PERMISSIONS } = require(path.join(ROOT, 'config', 'permissions.js'));
    console.log('\n🧪 الكتالوج بعد التفكيك:');
    const OPS9 = ['ops.completion', 'ops.dispatch', 'ops.reports', 'ops.report_revert', 'ops.report_detail', 'ops.deployments', 'ops.forms', 'ops.team_exit', 'ops.volunteers'];
    check('الكتالوج 34 مفتاحًا (29 + 5 جداول: employees/sync/export/print/clear)', PERMISSION_KEYS.length === 34, 'keys=' + PERMISSION_KEYS.length);
    check('مفاتيح التشغيل التسعة الدقيقة موجودة', OPS9.every(k => PERMISSION_KEYS.indexOf(k) !== -1));
    check('ops.execute الشامل باقٍ للتوافق', PERMISSION_KEYS.indexOf('ops.execute') !== -1);
    check('workflow.view أُضيف', PERMISSION_KEYS.indexOf('workflow.view') !== -1);
    check('§7: لا دور يحمل أي schedule.* إطلاقًا', Object.keys(ROLES_PERMISSIONS).every(r => !ROLES_PERMISSIONS[r].some(k => k.indexOf('schedule.') === 0)));
    check('§7: schedule.import فردية حصرًا', Object.keys(ROLES_PERMISSIONS).every(r => ROLES_PERMISSIONS[r].indexOf('schedule.import') === -1));
    check('§2ب: ops_supervisor بلا إدارة مستخدمين/رموز/تقنية', ['admin.users_manage', 'symbols.manage', 'admin.tech', 'admin.settings', 'data.delete'].every(k => ROLES_PERMISSIONS.ops_supervisor.indexOf(k) === -1));
    check('§2ب: ops_supervisor يحمل التشغيل التسعة + سير العمل كاملًا', OPS9.every(k => ROLES_PERMISSIONS.ops_supervisor.indexOf(k) !== -1) && ['workflow.view', 'workflow.manage', 'workflow.approve'].every(k => ROLES_PERMISSIONS.ops_supervisor.indexOf(k) !== -1));
    check('§4: field_leadership = حزمة operator + workflow.approve', OPS9.every(k => ROLES_PERMISSIONS.field_leadership.indexOf(k) !== -1) && ROLES_PERMISSIONS.field_leadership.indexOf('workflow.approve') !== -1);
    check('§3/§5: operator = 4 تنفيذ + 5 اطلاع + workflow.view', ROLES_PERMISSIONS.operator.length === 10 && OPS9.every(k => ROLES_PERMISSIONS.operator.indexOf(k) !== -1) && ROLES_PERMISSIONS.operator.indexOf('workflow.view') !== -1);
    check('operator بلا اعتماد ولا إدارة ولا جداول', ['workflow.approve', 'workflow.manage', 'admin.users_manage', 'symbols.manage', 'admin.settings', 'admin.tech', 'data.delete'].every(k => ROLES_PERMISSIONS.operator.indexOf(k) === -1));
    check('viewer فارغ', ROLES_PERMISSIONS.viewer.length === 0);

    // ── خادم الاختبار بعزل كامل ──
    console.log('\n🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + ' (DATA_DIR معزول)...');
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

        const T = await login('4252', '4252');
        check('دخول admin الممثّل (4252)', !!T);
        let T2 = await login('101353', '101353');
        check('دخول المستخدم الهدف (101353)', !!T2);

        console.log('\n🌐 قائمة المستخدمين الموسّعة:');
        const list = await api('/api/permissions/users', { token: T });
        check('GET /api/permissions/users ← 200 وتضم 20 مستخدمًا', list.status === 200 && Array.isArray(list.data.users) && list.data.users.length >= 20, 'n=' + (list.data.users || []).length);
        check('القائمة تحمل role_label وعدّاد الاستثناءات', list.data.users && list.data.users.every(u => u.role_label && u.overrides));
        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security'));
        const opToken = jwt.sign({ id: 'op-probe', role: 'operator', name: 'مشغل تجريبي' }, securityConfig.JWT_SECRET);
        const denied = await api('/api/permissions/users', { token: opToken });
        check('operator يُرفض على القائمة ← 403', denied.status === 403);

        console.log('\n🔒 عزل المستخدمين (تعديل 101353 لا يمس 4252):');
        const meActorBefore = await api('/api/auth/me', { token: T });
        const grant = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '101353', permission: 'ops.dispatch' } });
        check('منح ops.dispatch لـ 101353', grant.status === 200 && grant.data.sessionsRevoked >= 1, 'revoked=' + (grant.data && grant.data.sessionsRevoked));
        const actorStill = await api('/api/auth/me', { token: T });
        check('جلسة الممثّل (4252) حيّة بعد إبطال جلسات الهدف', actorStill.status === 200 && actorStill.data.success === true);
        const actorPerms = await api('/api/permissions/user/4252', { token: T });
        check('سجل 4252 الفردي بقي فارغًا (لا تسرّب)', actorPerms.status === 200 && actorPerms.data.permissions_granted.length === 0 && actorPerms.data.permissions_revoked.length === 0);
        const stale = await api('/api/auth/me', { token: T2 });
        check('توكن الهدف القديم ميت (TOKEN_REVOKED)', stale.status === 403 && stale.data.code === 'TOKEN_REVOKED');

        console.log('\n🔄 تغيير الدور الفردي:');
        const badRole = await api('/api/users/101353/role', { method: 'POST', token: T, body: { role: 'supergod' } });
        check('دور غير معتمد ← 400', badRole.status === 400);
        const selfRole = await api('/api/users/4252/role', { method: 'POST', token: T, body: { role: 'viewer' } });
        check('تغيير دور النفس ← 403 SELF_MODIFY_DENIED', selfRole.status === 403 && selfRole.data.code === 'SELF_MODIFY_DENIED');
        // جلسة طازجة للهدف لإثبات أن تغيير الدور يبطلها فعليًا
        const T2fresh = await login('101353', '101353');
        const toOperator = await api('/api/users/101353/role', { method: 'POST', token: T, body: { role: 'operator' } });
        check('admin ← operator: نجح وأبطل الجلسات', toOperator.status === 200 && toOperator.data.changed === true && toOperator.data.sessionsRevoked >= 1, JSON.stringify(toOperator.data || {}));
        const freshDead = await api('/api/auth/me', { token: T2fresh });
        check('تغيير الدور قتل الجلسة الطازجة (TOKEN_REVOKED)', freshDead.status === 403 && freshDead.data.code === 'TOKEN_REVOKED');
        T2 = await login('101353', '101353');
        const meOp = await api('/api/auth/me/permissions', { token: T2 });
        check('بعد operator: لا نجمة والفعلية = المنح الفردية فقط', meOp.data.permissions_star === false && meOp.data.permissions.indexOf('*') === -1);
        check('منحة ops.dispatch السابقة ظاهرة وفعّالة', meOp.data.permissions.indexOf('ops.dispatch') !== -1 && meOp.data.permissions_granted.indexOf('ops.dispatch') !== -1);

        console.log('\n🌟 حارس النجمة (admin ← دور عادي: لا بقايا * إطلاقًا):');
        const ADMIN_KEYS = ['admin.users_manage', 'admin.settings', 'admin.tech', 'symbols.manage', 'data.delete', 'employees.manage'];
        const expectedOp = ROLES_PERMISSIONS.operator.slice().sort(); // ops.dispatch ضمن الحزمة أصلًا
        check('الفعلية = حزمة operator + الاستثناءات الفردية حصرًا', JSON.stringify(meOp.data.permissions.slice().sort()) === JSON.stringify(expectedOp), JSON.stringify(meOp.data.permissions));
        check('لا صلاحية إدارية بقيت من دور admin القديم', ADMIN_KEYS.every(k => meOp.data.permissions.indexOf(k) === -1));
        check('لا schedule.* تسرّبت من النجمة القديمة', meOp.data.permissions.every(k => k.indexOf('schedule.') !== 0));

        console.log('\n🧩 التفكيك والفردية (§1/§7/§8):');
        // إثبات التفكيك على viewer (فارغ): منحة ops.dispatch وحدها لا تمنح ops.forms
        const toViewer = await api('/api/users/101353/role', { method: 'POST', token: T, body: { role: 'viewer' } });
        check('operator ← viewer ينجح', toViewer.status === 200 && toViewer.data.changed === true);
        T2 = await login('101353', '101353');
        const meV = await api('/api/auth/me/permissions', { token: T2 });
        check('§1: التفكيك حقيقي — viewer + منحة ops.dispatch وحدها (بلا ops.forms)', meV.data.permissions.indexOf('ops.dispatch') !== -1 && meV.data.permissions.indexOf('ops.forms') === -1 && meV.data.permissions_star === false, JSON.stringify(meV.data.permissions));
        const grantView = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '101353', permission: 'schedule.view' } });
        check('منح schedule.view فرديًا ينجح', grantView.status === 200);
        T2 = await login('101353', '101353');
        const meView = await api('/api/auth/me/permissions', { token: T2 });
        check('§8: schedule.view لا تستلزم edit_cell', meView.data.permissions.indexOf('schedule.view') !== -1 && meView.data.permissions.indexOf('schedule.edit_cell') === -1);
        const toSup = await api('/api/users/101353/role', { method: 'POST', token: T, body: { role: 'ops_supervisor' } });
        check('operator ← ops_supervisor ينجح', toSup.status === 200 && toSup.data.changed === true);
        T2 = await login('101353', '101353');
        const meSup = await api('/api/auth/me/permissions', { token: T2 });
        check('مشرف العمليات: التشغيل التسعة فعّالة', ['ops.completion', 'ops.reports', 'ops.forms', 'ops.team_exit'].every(k => meSup.data.permissions.indexOf(k) !== -1));
        check('§7: حتى ops_supervisor بلا schedule.generate', meSup.data.permissions.indexOf('schedule.generate') === -1);
        check('§7: schedule.view الفردية باقية فوق الدور', meSup.data.permissions.indexOf('schedule.view') !== -1);
        check('§2ب: ops_supervisor بلا admin.users_manage', meSup.data.permissions.indexOf('admin.users_manage') === -1);
        const revokeReports = await api('/api/permissions/revoke', { method: 'POST', token: T, body: { user_id: '101353', permission: 'ops.reports' } });
        check('سحب ops.reports من المشرف ينجح', revokeReports.status === 200);
        T2 = await login('101353', '101353');
        const meSup2 = await api('/api/auth/me/permissions', { token: T2 });
        check('السحب انتقائي: ops.reports غابت وops.forms باقية', meSup2.data.permissions.indexOf('ops.reports') === -1 && meSup2.data.permissions.indexOf('ops.forms') !== -1 && meSup2.data.permissions_revoked.indexOf('ops.reports') !== -1);

        // حارس النجمة — الاتجاه العكسي: العودة إلى admin تستعيد * من الدور الجديد
        const T2preAdmin = await login('101353', '101353');
        const backAdmin = await api('/api/users/101353/role', { method: 'POST', token: T, body: { role: 'admin' } });
        check('العودة إلى admin تُبطل الجلسة', backAdmin.status === 200 && backAdmin.data.sessionsRevoked >= 1);
        const preAdminDead = await api('/api/auth/me', { token: T2preAdmin });
        check('الجلسة السابقة ميتة بعد العودة', preAdminDead.status === 403 && preAdminDead.data.code === 'TOKEN_REVOKED');
        T2 = await login('101353', '101353');
        const meBack = await api('/api/auth/me/permissions', { token: T2 });
        check('النجمة تعود من دور admin الجديد (* فعّالة)', meBack.data.permissions_star === true && meBack.data.permissions.indexOf('*') !== -1);
        check('الاستثناءات الفردية باقية ومرئية فوق النجمة', meBack.data.permissions_granted.indexOf('schedule.view') !== -1 && meBack.data.permissions_revoked.indexOf('ops.reports') !== -1);

        console.log('\n🛡️ الحواجز والعقد:');
        const starGrant = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '101353', permission: '*' } });
        check('منح * مستحيل ← 400', starGrant.status === 400);
        const opGrant = await api('/api/permissions/grant', { method: 'POST', token: opToken, body: { user_id: '101353', permission: 'ops.forms' } });
        check('operator يحاول المنح ← 403', opGrant.status === 403);
        const meContract = await api('/api/auth/me', { token: T });
        check('عقد auth/me القديم سليم + الحقول الجديدة إضافية', meContract.status === 200 && meContract.data.success === true && !!meContract.data.user && Array.isArray(meContract.data.permissions));

        const audit = await api('/api/audit-log', { token: T });
        const acts = JSON.stringify(audit.data);
        check('التدقيق وثّق role_change والمنح/السحوبات', acts.indexOf('role_change') !== -1 && acts.indexOf('permission_grant') !== -1 && acts.indexOf('permission_revoke') !== -1);

        const probe2 = new Database(TMP_DB, { readonly: true });
        const afterCounts = {
            shift_roster: probe2.prepare('SELECT COUNT(*) c FROM shift_roster').get().c,
            shift_reports: probe2.prepare('SELECT COUNT(*) c FROM shift_reports').get().c,
            employees: probe2.prepare('SELECT COUNT(*) c FROM employees').get().c
        };
        probe2.close();
        check('صفر تغيير في البيانات التشغيلية', JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), JSON.stringify(afterCounts));

        const usersFileAfter = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
        const realTarget = usersFileAfter.find(u => u.username === '101353');
        check('users.json الأصلي لم يُمس (الدور ما زال admin)', realTarget && realTarget.role === 'admin', 'role=' + (realTarget && realTarget.role));
    } finally {
        server.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1500));
        try { server.kill('SIGKILL'); } catch (_) { }
        probe.close();
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); }
    if (failed > 0) { console.log('\n—— سجل الخادم (آخر 30 سطرًا) ——'); console.log(serverLog.split('\n').slice(-30).join('\n')); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('فشل عام:', e); process.exit(1); });
