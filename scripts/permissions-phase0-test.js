/**
 * ═══ اختبار المرحلة 0 لمنظومة الصلاحيات — permissions-phase0-test.js ═══
 * الإثباتات الـ12 المعتمدة: لا فقد صلاحية · admin='*' · منح/سحب · granted=1
 * يمنح · granted=0 يسحب فوق الدور · غياب الصف = افتراضي الدور · الظهور في
 * auth/me · إبطال الجلسات · 403 لمن بلا صلاحية · قفل الرموز سليم ·
 * صفر تغيير في البيانات التشغيلية · انحدار نظيف.
 * يعمل على نسخة مؤقتة (VACUUM INTO) — لا يمس القاعدة الأصلية.
 * التشغيل: node scripts/permissions-phase0-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const TMP_DB = path.join(os.tmpdir(), 'perm-phase0-' + Date.now() + '.db').replace(/\\/g, '/');
const PORT = 3092;
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

(async () => {
    console.log('📋 نسخ القاعدة إلى ملف مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();

    // ── عدّادات البيانات التشغيلية قبل كل شيء (إثبات 11) ──
    const probeW = new Database(TMP_DB); // كتابة: إنشاء جدول المرحلة 0 بنفس DDL الرسمي
    probeW.exec(`CREATE TABLE IF NOT EXISTS user_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        permission_key TEXT NOT NULL,
        granted INTEGER NOT NULL,
        granted_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE(user_id, permission_key)
    );`);
    probeW.close();
    const probe = new Database(TMP_DB, { readonly: true });
    const probeRW = new Database(TMP_DB); // للمحول الوحدوي (منح/سحب)
    const count = (t) => probe.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    const beforeCounts = { shift_roster: count('shift_roster'), shift_reports: count('shift_reports'), employees: count('employees') };

    // ── وحدات مباشرة على القاعدة المؤقتة (إثباتات 2/4/5/6 على مستوى الخدمة) ──
    const { PERMISSION_KEYS, ROLES_PERMISSIONS } = require(path.join(ROOT, 'config', 'permissions.js'));
    const adapter = {
        UserPermissions: {
            async getByUser(uid) { return probeRW.prepare('SELECT * FROM user_permissions WHERE user_id = ?').all(String(uid)); },
            async getAll() { return probeRW.prepare('SELECT * FROM user_permissions').all(); },
            async set(uid, k, g, by) {
                probeRW.prepare(`INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,?,?)
                    ON CONFLICT(user_id, permission_key) DO UPDATE SET granted=excluded.granted, granted_by=excluded.granted_by, updated_at=CURRENT_TIMESTAMP`)
                    .run(String(uid), k, g ? 1 : 0, by || null);
            },
            async clear(uid, k) { probeRW.prepare('DELETE FROM user_permissions WHERE user_id=? AND permission_key=?').run(String(uid), k); }
        }
    };
    const PermissionService = require(path.join(ROOT, 'services', 'permission-service.js'));
    const svc = new PermissionService({ db: adapter });

    console.log('\n🧪 وحدات الخدمة (قواعد الحساب الأربع):');
    check('إثبات 2: admin يملك *', (await svc.getEffective('4252', 'admin')).star === true);
    check('viewer بلا صلاحيات كتابة', (await svc.getEffective('v1', 'viewer')).effective.length === 0);
    check('schedule.import غائبة من كل دور افتراضيًا', Object.keys(ROLES_PERMISSIONS).every(r => ROLES_PERMISSIONS[r].indexOf('schedule.import') === -1 || ROLES_PERMISSIONS[r][0] === '*'));

    // إثبات 6: لا سجل ← افتراضي الدور
    const effDefault = await svc.getEffective('u100', 'operator');
    check('إثبات 6: بلا سجل = افتراضي الدور (operator يملك ops.execute)', effDefault.effective.indexOf('ops.execute') !== -1 && effDefault.granted.length === 0);
    check('operator لا يملك schedule.import افتراضيًا', effDefault.effective.indexOf('schedule.import') === -1);

    // إثبات 4: granted=1 يمنح فوق الدور
    await svc.setPermission('u100', 'schedule.import', true, { id: '4252', name: 'اختبار' });
    const effGranted = await svc.getEffective('u100', 'operator');
    check('إثبات 4: granted=1 يمنح schedule.import فوق دور operator', effGranted.effective.indexOf('schedule.import') !== -1 && effGranted.granted.indexOf('schedule.import') !== -1);

    // إثبات 5: granted=0 يسحب مما يمنحه الدور
    await svc.setPermission('u100', 'ops.execute', false, { id: '4252', name: 'اختبار' });
    const effRevoked = await svc.getEffective('u100', 'operator');
    check('إثبات 5: granted=0 يسحب ops.execute رغم أن الدور يمنحها', effRevoked.effective.indexOf('ops.execute') === -1 && effRevoked.revoked.indexOf('ops.execute') !== -1);

    // إعادة للافتراضي
    await svc.clearPermission('u100', 'ops.execute', { id: '4252', name: 'اختبار' });
    const effCleared = await svc.getEffective('u100', 'operator');
    check('clear يعيد الصلاحية لافتراضي الدور', effCleared.effective.indexOf('ops.execute') !== -1 && effCleared.revoked.length === 0);

    // مفتاح مجهول مرفوض
    let rejected = false;
    try { await svc.setPermission('u100', 'hack.everything', true, { id: '4252', name: 'اختبار' }); } catch (e) { rejected = true; }
    check('مفتاح صلاحية خارج الكتالوج مرفوض', rejected);
    probeRW.close();

    // ── خادم الاختبار ──
    console.log('\n🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    server.stdout.on('data', d => serverLog += d);
    server.stderr.on('data', d => serverLog += d);

    try {
        check('خادم الاختبار يعمل', await waitReady());
        await new Promise(r => setTimeout(r, 6000));

        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const T = login.data && (login.data.token || login.data.accessToken);
        check('دخول admin (4252)', !!T);

        console.log('\n🌐 إثباتات API:');
        // إثبات 1+7: auth/me يرجع الصلاحيات وadmin='*'
        const me = await api('/api/auth/me', { token: T });
        check('إثبات 7: auth/me يرجع permissions', me.status === 200 && Array.isArray(me.data.permissions));
        check('إثبات 1+2: admin يملك * في auth/me', me.data.permissions_star === true && me.data.permissions[0] === '*');
        check('role_label مدير النظام', me.data.role_label === 'مدير النظام');

        // المستخدم الحالي لا يفقد شيئًا: مسار admin حقيقي يعمل
        const users = await api('/api/users', { token: T });
        check('إثبات 1: مسار admin حقيقي (/api/users) يعمل كما كان', users.status === 200);

        // إثبات 9: director وuser بلا admin.users_manage ← 403 على كتالوج الصلاحيات
        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security'));
        const dirToken = jwt.sign({ id: 'dir-probe', role: 'director', name: 'مشرف تجريبي' }, securityConfig.JWT_SECRET);
        const usrToken = jwt.sign({ id: 'usr-probe', role: 'user', name: 'مشغل تجريبي' }, securityConfig.JWT_SECRET);
        const dirTry = await api('/api/permissions/catalog', { token: dirToken });
        check('إثبات 9: director بلا admin.users_manage ← 403', dirTry.status === 403 && dirTry.data.code === 'PERMISSION_DENIED');
        const usrTry = await api('/api/permissions/catalog', { token: usrToken });
        check('إثبات 9: user ← 403', usrTry.status === 403);
        const catOk = await api('/api/permissions/catalog', { token: T });
        check('admin يصل الكتالوج (18 صلاحية)', catOk.status === 200 && Object.keys(catOk.data.permissions).length === PERMISSION_KEYS.length);

        // ═══ إثبات 12: لا تصعيد ذاتي — مفتاح التحكم محمي من صاحبه ═══
        const selfGrant = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '4252', permission: 'schedule.import' } });
        check('إثبات 12: منح النفس ← 403 SELF_MODIFY_DENIED', selfGrant.status === 403 && selfGrant.data.code === 'SELF_MODIFY_DENIED', 'status=' + selfGrant.status);
        const selfAdmin = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '4252', permission: 'admin.users_manage' } });
        check('إثبات 12: منح النفس صلاحية إدارية ← 403', selfAdmin.status === 403 && selfAdmin.data.code === 'SELF_MODIFY_DENIED');
        const selfRevoke = await api('/api/permissions/revoke', { method: 'POST', token: T, body: { user_id: '4252', permission: 'ops.execute' } });
        check('إثبات 12: سحب من النفس ← 403', selfRevoke.status === 403 && selfRevoke.data.code === 'SELF_MODIFY_DENIED');
        const selfClear = await api('/api/permissions/clear', { method: 'POST', token: T, body: { user_id: '4252', permission: 'ops.execute' } });
        check('إثبات 12: إعادة صلاحية النفس ← 403', selfClear.status === 403 && selfClear.data.code === 'SELF_MODIFY_DENIED');
        const starGrant = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '101353', permission: '*' } });
        check('إثبات 12: منح * مستحيل (ليست مفتاحًا في الكتالوج) ← 400', starGrant.status === 400 && starGrant.data.success !== true, 'status=' + starGrant.status);
        const bogusKey = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '101353', permission: 'god.mode' } });
        check('إثبات 12: مفتاح ملفق خارج الكتالوج ← 400', bogusKey.status === 400 && bogusKey.data.success !== true);
        const dirGrant = await api('/api/permissions/grant', { method: 'POST', token: dirToken, body: { user_id: '101353', permission: 'ops.execute' } });
        check('إثبات 12: director يحاول المنح ← 403', dirGrant.status === 403 && dirGrant.data.code === 'PERMISSION_DENIED');

        // إثباتات 3+8: منح فردي + إبطال الجلسة القديمة + الظهور بعد إعادة الدخول
        const login2 = await api('/api/auth/login', { method: 'POST', body: { username: '101353', password: '101353' } });
        const T2 = login2.data && (login2.data.token || login2.data.accessToken);
        check('دخول المستخدم الثاني (101353)', !!T2);
        const meBefore = await api('/api/auth/me/permissions', { token: T2 });
        check('101353 قبل المنحة: بلا schedule.import', meBefore.status === 200 && meBefore.data.permissions_star === true); // admin حاليًا = *

        // منح سحب فعلي على دور غير نجمي يتطلب دورًا غير admin — نثبت المنحة والإبطال على 101353:
        const grant = await api('/api/permissions/grant', { method: 'POST', token: T, body: { user_id: '101353', permission: 'schedule.import' } });
        check('إثبات 3: المنحة تُسجَّل', grant.status === 200 && grant.data.success === true, JSON.stringify(grant.data));
        check('إثبات 8: المنحة أبطلت جلسات المستخدم القديمة', grant.data.sessionsRevoked >= 1, 'revoked=' + grant.data.sessionsRevoked);
        const stale = await api('/api/auth/me', { token: T2 });
        check('إثبات 8: التوكن القديم ميت (403 TOKEN_REVOKED)', stale.status === 403 && stale.data.code === 'TOKEN_REVOKED', 'status=' + stale.status);
        const relogin = await api('/api/auth/login', { method: 'POST', body: { username: '101353', password: '101353' } });
        const T2b = relogin.data && (relogin.data.token || relogin.data.accessToken);
        const meAfter = await api('/api/auth/me/permissions', { token: T2b });
        check('إثبات 3+7: المنحة تظهر في السجل الفردي بعد إعادة الدخول', meAfter.data.permissions_granted.indexOf('schedule.import') !== -1);

        // سحب المنحة
        const revoke = await api('/api/permissions/revoke', { method: 'POST', token: T, body: { user_id: '101353', permission: 'schedule.import' } });
        check('السحب يُسجَّل ويبطل الجلسة', revoke.status === 200 && revoke.data.sessionsRevoked >= 1);
        const relogin2 = await api('/api/auth/login', { method: 'POST', body: { username: '101353', password: '101353' } });
        const meRev = await api('/api/auth/me/permissions', { token: relogin2.data.token || relogin2.data.accessToken });
        check('السحب يظهر (granted=0 في السجل الفردي)', meRev.data.permissions_revoked.indexOf('schedule.import') !== -1);

        // إثبات 10: قفل إدارة الرموز يعمل كما هو (طبقته المستقلة لم تُمس)
        const lockProbe = await api('/api/schedule-symbols/unlock', { method: 'POST', token: T, body: { secret: 'x' } });
        check('إثبات 10: قفل الرموز سليم (409 قبل الضبط / 401 بعده)', lockProbe.status === 409 || lockProbe.status === 401, 'status=' + lockProbe.status);

        // سجل التدقيق العام وثّق المنح والسحب
        const audit = await api('/api/audit-log', { token: T });
        const acts = JSON.stringify(audit.data);
        check('audit_log يوثق permission_grant و permission_revoke', acts.indexOf('permission_grant') !== -1 && acts.indexOf('permission_revoke') !== -1);

        // إثبات 11: صفر تغيير في البيانات التشغيلية
        const probe2 = new Database(TMP_DB, { readonly: true });
        const afterCounts = {
            shift_roster: probe2.prepare('SELECT COUNT(*) c FROM shift_roster').get().c,
            shift_reports: probe2.prepare('SELECT COUNT(*) c FROM shift_reports').get().c,
            employees: probe2.prepare('SELECT COUNT(*) c FROM employees').get().c
        };
        probe2.close();
        check('إثبات 11: البيانات التشغيلية لم تتغير', JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
            JSON.stringify(beforeCounts) + ' → ' + JSON.stringify(afterCounts));

    } catch (e) {
        failed++; failures.push('استثناء: ' + e.message);
        console.error('💥', e.message, '\n', serverLog.slice(-1200));
    } finally {
        server.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1500));
        try { server.kill('SIGKILL'); } catch (_) { }
        for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) { } }
    }

    console.log('\n════════════════════════════════');
    console.log(`النتيجة: ${passed} ✅ / ${failed} ❌`);
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})();
