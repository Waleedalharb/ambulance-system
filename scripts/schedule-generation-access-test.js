/**
 * اختبار حارس توليد الجدول الشهري — admin حرفيًا + schedule.generate فعليًا.
 * يغطي الحارس كخدمة، والمسار القديم، والوضعين normal/alternative، وإعادة التوليد،
 * ومنح غير admin، وsysadmin، ومنع الكتابة عند الرفض، وسلامة البيانات الأصلية.
 * التشغيل: node scripts/schedule-generation-access-test.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const SRC_USERS = path.join(ROOT, 'data', 'users.json');
const STAMP = Date.now();
const TMP_ROOT = path.join(ROOT, '.test-tmp', 'schedule-generation-access-' + STAMP);
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const PORT = 3107;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, extra) {
    if (condition) {
        passed++;
        console.log('  ✅ ' + name);
    } else {
        failed++;
        failures.push(name);
        console.log('  ❌ ' + name + (extra ? ' — ' + extra : ''));
    }
}

async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(BASE + p, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try {
            const response = await fetch(BASE + '/health');
            if (response.ok) return true;
        } catch (_) { }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
}

function hashFile(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function expectAccessDenied(user, service, name) {
    let error = null;
    try {
        const { assertScheduleGenerationAccess } = require('../services/schedule-generation-access');
        await assertScheduleGenerationAccess(user, service);
    } catch (caught) {
        error = caught;
    }
    check(name, error && error.status === 403 && error.code === 'PERMISSION_DENIED' && error.permission === 'schedule.generate');
}

(async () => {
    console.log('🧪 اختبارات الحارس كمدخل خدمة مستقل:');
    const {
        assertScheduleGenerationAccess,
        ScheduleGenerationAccessError
    } = require('../services/schedule-generation-access');

    let factoryCalls = 0;
    let permissionCalls = 0;
    const allowingService = {
        hasPermission: async (userId, role, key) => {
            permissionCalls++;
            return userId === 'admin-1' && role === 'admin' && key === 'schedule.generate';
        }
    };
    const allowingFactory = () => {
        factoryCalls++;
        return allowingService;
    };

    await expectAccessDenied({ id: 'director-1', role: 'director' }, allowingFactory, 'director مرفوض قبل حل خدمة الصلاحيات');
    check('رفض director لم يستدعِ مصنع الخدمة أو hasPermission', factoryCalls === 0 && permissionCalls === 0);
    await expectAccessDenied({ id: 'sys-1', role: 'sysadmin' }, allowingFactory, 'sysadmin مرفوض رغم النجمة وقبل فحص المفتاح');
    check('رفض sysadmin لم يستدعِ خدمة الصلاحيات', factoryCalls === 0 && permissionCalls === 0);
    await expectAccessDenied(null, allowingFactory, 'غياب هوية الخدمة مرفوض بـ403');

    const adminAllowed = await assertScheduleGenerationAccess({ id: 'admin-1', role: 'admin' }, allowingFactory);
    check('admin يملك schedule.generate فعليًا يجتاز مدخل الخدمة', adminAllowed === true && factoryCalls === 1 && permissionCalls === 1);
    await expectAccessDenied({ id: 'admin-2', role: 'admin' }, allowingService, 'admin بلا امتلاك فعلي للمفتاح مرفوض');

    let middlewareNext = 0;
    const middleware = require('../services/schedule-generation-access').authorizeScheduleGeneration(allowingFactory);
    const deniedResponse = {
        statusCode: null,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; }
    };
    await middleware({ user: { id: 'director-1', role: 'director' } }, deniedResponse, () => { middlewareNext++; });
    check('وسيط HTTP يعيد 403 PERMISSION_DENIED ولا يستدعي next', deniedResponse.statusCode === 403 && deniedResponse.payload.code === 'PERMISSION_DENIED' && middlewareNext === 0);

    console.log('\n🧪 الفحص الساكن للمسارات ومداخل الدوال:');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('المسار القديم يستخدم scheduleGenerationGuard لا authorize للدورين', serverSrc.includes("app.post('/api/shift-schedule/generate', authenticate, scheduleGenerationGuard,") && !serverSrc.includes("app.post('/api/shift-schedule/generate', authenticate, authorize(['admin', 'director'])"));
    check('generateNormalSchedule محروس عند مدخل الدالة قبل قراءة الموظفين', /async function generateNormalSchedule\(year, month, leaveMap, actor\) \{\s*await assertScheduleGenerationAccess\(actor, getPermissionService\);\s*const daysInMonth[\s\S]*?const employees = await db\.Employees\.getActive\(\);/.test(serverSrc));
    check('generateAlternativeSchedule محروس عند مدخل الدالة قبل قراءة الموظفين', /async function generateAlternativeSchedule\(year, month, leaveMap, actor\) \{\s*await assertScheduleGenerationAccess\(actor, getPermissionService\);\s*const daysInMonth[\s\S]*?const employees = await db\.Employees\.getActive\(\);/.test(serverSrc));
    check('المسار يمرر req.user إلى دالتي التوليد', serverSrc.includes('generateAlternativeSchedule(y, m, leaveMap, req.user)') && serverSrc.includes('generateNormalSchedule(y, m, leaveMap, req.user)'));
    const monthlyGenerationRoutes = serverSrc.match(/app\.(?:post|put|patch)\([^\n]*(?:shift-schedule|schedule-engine)[^\n]*(?:generate|regenerate|minimal-diff)[^\n]*/g) || [];
    check('كل مسارات توليد الجدول الشهري الموجودة تستخدم الحارس المشترك', monthlyGenerationRoutes.length === 1 && monthlyGenerationRoutes.every(route => route.includes('scheduleGenerationGuard')), monthlyGenerationRoutes.join(' | '));
    check('خطأ الحارس عند مدخل الدالة يبقى 403 ولا يتحول إلى 500', serverSrc.includes("error.permission === 'schedule.generate'") && serverSrc.includes('return res.status(403).json({ error: error.message, code: error.code, permission: error.permission })'));

    fs.mkdirSync(TMP_DATA, { recursive: true });
    const originalDbHash = hashFile(SRC_DB);
    const originalUsersHash = hashFile(SRC_USERS);
    const Database = require('better-sqlite3');
    const source = new Database(SRC_DB, { readonly: true });
    source.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    source.close();
    const isolated = new Database(TMP_DB);
    isolated.exec(`CREATE TABLE IF NOT EXISTS user_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        permission_key TEXT NOT NULL,
        granted INTEGER NOT NULL,
        granted_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE(user_id, permission_key)
    );`);
    fs.copyFileSync(SRC_USERS, path.join(TMP_DATA, 'users.json'));

    const setIsolatedPermission = (userId, granted) => isolated.prepare(
        'INSERT OR REPLACE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, ?, ?)'
    ).run(userId, 'schedule.generate', granted, 'اختبار معزول');
    setIsolatedPermission('probe-director', 1);
    setIsolatedPermission('probe-viewer', 1);
    setIsolatedPermission('probe-user', 1);
    setIsolatedPermission('probe-admin', 0); // النجمة تبقى كما هي؛ السحب لا يقيد admin.

    const tables = ['shift_schedule_auto', 'staffing_alerts', 'audit_log'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, isolated.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count]));
    const permissionsSnapshot = () => isolated.prepare(
        'SELECT user_id, permission_key, granted, granted_by FROM user_permissions ORDER BY user_id, permission_key'
    ).all();
    const beforeDenied = snapshot();
    const beforeDeniedPermissions = permissionsSnapshot();

    console.log('\n🚀 تشغيل خادم معزول على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    server.stdout.on('data', data => { serverLog += data; });
    server.stderr.on('data', data => { serverLog += data; });

    try {
        check('خادم الاختبار يعمل', await waitReady());
        const jwt = require('jsonwebtoken');
        const securityConfig = require('../config/security');
        const token = (id, role) => jwt.sign({ id, role, name: 'مجس ' + id }, securityConfig.JWT_SECRET);
        const tokens = {
            director: token('probe-director', 'director'),
            sysadmin: token('probe-sysadmin', 'sysadmin'),
            viewer: token('probe-viewer', 'viewer'),
            user: token('probe-user', 'user'),
            admin: token('probe-admin', 'admin')
        };

        console.log('\n🚫 الرفض قبل أي توليد أو كتابة:');
        for (const role of ['director', 'sysadmin', 'viewer', 'user']) {
            for (const mode of ['normal', 'alternative']) {
                const response = await api('/api/shift-schedule/generate', {
                    method: 'POST',
                    token: tokens[role],
                    body: { year: 2026, month: 1, mode }
                });
                check(role + ' / ' + mode + ' مرفوض 403 رغم المنحة أو النجمة', response.status === 403 && response.data && response.data.code === 'PERMISSION_DENIED' && response.data.permission === 'schedule.generate', 'status=' + response.status);
            }
        }
        const unauthenticated = await api('/api/shift-schedule/generate', {
            method: 'POST',
            body: { year: 2026, month: 1, mode: 'normal' }
        });
        check('غير الموثق مرفوض 401 قبل التوليد', unauthenticated.status === 401);
        check('جميع محاولات الرفض لم تغيّر جداول التوليد أو التنبيهات أو التدقيق', JSON.stringify(snapshot()) === JSON.stringify(beforeDenied), JSON.stringify(snapshot()));
        check('محاولات الرفض لم تغيّر منح الاختبار المعدة مسبقًا', JSON.stringify(permissionsSnapshot()) === JSON.stringify(beforeDeniedPermissions));

        console.log('\n✅ السماح وإعادة التوليد على القاعدة المعزولة:');
        const generated = await api('/api/shift-schedule/generate', {
            method: 'POST',
            token: tokens.admin,
            body: { year: 2026, month: 1, mode: 'normal' }
        });
        check('admin حامل النجمة يولد normal رغم صف السحب الفردي', generated.status === 200 && generated.data && generated.data.success === true && generated.data.mode === 'normal', 'status=' + generated.status + ' body=' + JSON.stringify(generated.data || {}).slice(0, 180));
        const normalRows = generated.status === 200 ? isolated.prepare("SELECT COUNT(*) AS count FROM shift_schedule_auto WHERE shift_date BETWEEN '2026-01-01' AND '2026-01-31'").get().count : -1;
        check('التوليد normal كتب النتيجة في النسخة المعزولة فقط', generated.status === 200 && normalRows === generated.data.schedule.length, 'rows=' + normalRows);

        const regenerated = await api('/api/shift-schedule/generate', {
            method: 'POST',
            token: tokens.admin,
            body: { year: 2026, month: 1, mode: 'alternative' }
        });
        check('admin نفسه يعيد التوليد alternative عبر المسار القديم', regenerated.status === 200 && regenerated.data && regenerated.data.success === true && regenerated.data.mode === 'alternative', 'status=' + regenerated.status + ' body=' + JSON.stringify(regenerated.data || {}).slice(0, 180));
        const alternativeRows = regenerated.status === 200 ? isolated.prepare("SELECT COUNT(*) AS count FROM shift_schedule_auto WHERE shift_date BETWEEN '2026-01-01' AND '2026-01-31' AND mode = 'alternative'").get().count : -1;
        check('إعادة التوليد استبدلت الشهر في النسخة المعزولة دون تكرار', regenerated.status === 200 && alternativeRows === regenerated.data.schedule.length, 'rows=' + alternativeRows);

        check('قاعدة البيانات الأصلية لم تتغير', hashFile(SRC_DB) === originalDbHash);
        check('users.json الأصلي والحسابات والأدوار لم تتغير', hashFile(SRC_USERS) === originalUsersHash);
    } finally {
        server.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 1000));
        try { server.kill('SIGKILL'); } catch (_) { }
        try { isolated.close(); } catch (_) { }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failures.length) {
        console.log('الفاشلة:');
        failures.forEach(name => console.log('  ❌ ' + name));
        console.log('\n—— سجل الخادم (آخر 30 سطرًا) ——');
        console.log(serverLog.split('\n').slice(-30).join('\n'));
    }
    process.exit(failed ? 1 : 0);
})().catch(error => {
    console.error('فشل عام:', error);
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) { }
    process.exit(1);
});
