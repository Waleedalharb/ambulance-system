/**
 * ═══ اختبار جولة تنظيم الوصول والصلاحيات — nav-perms-test.js ═══
 * (اعتماد المالك 2026-08-30 — قرار ① المساهمة + قرار ②ب الرموز)
 * يثبت على قاعدة معزولة (VACUUM INTO + DATA_DIR مؤقت — صفر لمس للبيانات الحقيقية):
 *  1) مستخدم بلا صلاحيات ← 403 PERMISSION_DENIED على المساهمة وكل مسارات الرموز الثمانية
 *  2) منحة indicators.contribution الفردية تفتح المساهمة فعليًا، وسحبها يعيد 403
 *  3) منحة assets.view تفتح /api/assets فعليًا (إثبات أن الحسم سيرفي لا شكلي)
 *  4) ops_supervisor يدخل المساهمة بعد الربط (أثر مخطط وموثق في التقرير)
 *  5) director لا يفقد المساهمة ولا الرموز (symbols.manage أُضيفت لدوره)
 *  6) admin/sysadmin وصول كامل عبر النجمة
 *  7) symbols.manage تتحكم فعليًا: منحة viewer تجتاز بوابة GET،
 *     والقفل السري يبقى طبقة فوق الصلاحية (POST بلا unlock ← 423)
 *  8) فحوص ساكنة: روابط الـSidebar الثلاثة + بوابة Fail-Closed في index.html،
 *     زر الرموز + سطر GATES في smart-schedule.html، رسالة 403 في contribution-stats.html
 *  9) سحب director (granted=0) يغلب افتراضي دوره ← 403 (السحب يغلب)
 * التشغيل: node scripts/nav-perms-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'nav-perm-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'nav-perm-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3097;
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

// مسارات الرموز الثمانية المربوطة (قرار ②ب)
const SYMBOL_ROUTES = [
    ['GET', '/api/schedule-symbols'],
    ['GET', '/api/schedule-symbols/audit'],
    ['POST', '/api/schedule-symbols/unlock'],
    ['POST', '/api/schedule-symbols/lock'],
    ['POST', '/api/schedule-symbols/secret'],
    ['POST', '/api/schedule-symbols'],
    ['PUT', '/api/schedule-symbols/1'],
    ['POST', '/api/schedule-symbols/1/status']
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

    // ── ⓪ الكتالوج والأدوار (ساكن) ──
    const { PERMISSION_KEYS, ROLES_PERMISSIONS } = require(path.join(ROOT, 'config', 'permissions.js'));
    console.log('\n🧪 الكتالوج:');
    check('المفاتيح الأربعة موجودة في الكتالوج', ['admin.users_manage', 'assets.view', 'assets.manage', 'indicators.contribution', 'symbols.manage'].every(k => PERMISSION_KEYS.indexOf(k) !== -1));
    check('director يحمل symbols.manage افتراضيًا (قرار ②ب — لا يفقد وصوله)', ROLES_PERMISSIONS.director.indexOf('symbols.manage') !== -1);
    check('director يحمل indicators.contribution افتراضيًا (لا يفقد المساهمة)', ROLES_PERMISSIONS.director.indexOf('indicators.contribution') !== -1);
    check('ops_supervisor يحمل indicators.contribution افتراضيًا (أثر مخطط موثق)', ROLES_PERMISSIONS.ops_supervisor.indexOf('indicators.contribution') !== -1);
    check('لم تُنشأ أي صلاحية جديدة خارج المعتمد — لا مفاتيح nav.* أو sidebar.*', PERMISSION_KEYS.every(k => k.indexOf('nav.') !== 0 && k.indexOf('sidebar.') !== 0));

    // ── فحوص الواجهة الساكنة ──
    console.log('\n🖥️ الواجهة (ساكن):');
    const indexSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check('index.html: رابط إدارة المستخدمين مربوط بـ admin.users_manage', indexSrc.includes("sbAdminUsers") && indexSrc.includes("admin.users_manage"));
    check('index.html: رابط مركز العهد مربوط بـ assets.view/manage', indexSrc.includes("sbAssetsCenter") && indexSrc.includes("assets.view") && indexSrc.includes("assets.manage"));
    check('index.html: رابط المساهمة مربوط بـ indicators.contribution', indexSrc.includes("sbContribution") && indexSrc.includes("indicators.contribution"));
    check('index.html: الروابط الثلاثة مخفية افتراضيًا (Fail-Closed)', (indexSrc.match(/id="sb(AdminUsers|AssetsCenter|Contribution)" style="display:none;"/g) || []).length === 3);
    check('index.html: البوابة تجلب /api/auth/me وتستخدم permissions_star', indexSrc.includes("/api/auth/me") && indexSrc.includes("permissions_star"));
    check('index.html: إدارة الرموز غير موجودة في الـSidebar الرئيسية', !indexSrc.includes('admin-symbols.html'));
    const schedSrc = fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8');
    check('smart-schedule: زر إدارة الرموز موجود داخل نظام الجداول', schedSrc.includes('symbolsAdminBtn') && schedSrc.includes("admin-symbols.html"));
    check('smart-schedule: الزر مسجل في GATES على symbols.manage', /sel:\s*'#symbolsAdminBtn'[^}]*perm:\s*'symbols\.manage'/.test(schedSrc));
    const contribSrc = fs.readFileSync(path.join(ROOT, 'public', 'contribution-stats.html'), 'utf8');
    check('contribution-stats: رسالة «غير مصرّح» مخصصة عند 403', contribSrc.includes('res.status === 403') && contribSrc.includes('غير مصرّح'));

    // منح فردية في القاعدة المعزولة فقط
    const grant = (uid, key) => dbw.prepare('INSERT OR REPLACE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)').run(uid, key, 'اختبار-تنظيم-الوصول');
    const revoke = (uid, key) => dbw.prepare('INSERT OR REPLACE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,0,?)').run(uid, key, 'اختبار-تنظيم-الوصول');
    grant('probe-contrib', 'indicators.contribution');
    grant('probe-assets', 'assets.view');
    grant('probe-symbols', 'symbols.manage');
    revoke('probe-dir-revoked', 'indicators.contribution'); // director مسحوبة منه المساهمة

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
        const T_NONE = tok('probe-none', 'viewer');           // بلا أي صلاحية
        const T_CONTRIB = tok('probe-contrib', 'viewer');     // منحة المساهمة فقط
        const T_ASSETS = tok('probe-assets', 'viewer');       // منحة العهد فقط
        const T_SYMBOLS = tok('probe-symbols', 'viewer');     // منحة الرموز فقط
        const T_OPSUP = tok('probe-opsup', 'ops_supervisor'); // بلا منح — افتراضي الدور
        const T_DIR = tok('probe-director', 'director');      // بلا منح — افتراضي الدور
        const T_DIR_REV = tok('probe-dir-revoked', 'director'); // مسحوبة منه المساهمة

        console.log('\n🚫 ١) مستخدم بلا صلاحيات — الفتح المباشر:');
        const c0 = await api('/api/indicators/contribution?year=2026&month=8', { token: T_NONE });
        check('المساهمة ← 403 PERMISSION_DENIED', c0.status === 403 && c0.data && c0.data.code === 'PERMISSION_DENIED', 'status=' + c0.status);
        let deniedSymbols = 0, wrongOnes = [];
        for (const [m, p] of SYMBOL_ROUTES) {
            const r = await api(p, { method: m, token: T_NONE, body: m === 'GET' ? undefined : {} });
            if (r.status === 403 && r.data && r.data.code === 'PERMISSION_DENIED') deniedSymbols++;
            else wrongOnes.push(m + ' ' + p + '=' + r.status);
        }
        check('مسارات الرموز الثمانية كلها ← 403 PERMISSION_DENIED', deniedSymbols === 8, wrongOnes.join(' | '));
        const a0 = await api('/api/assets', { token: T_NONE });
        check('مركز العهد ← 403 (الحماية القائمة كما هي)', a0.status === 403, 'status=' + a0.status);

        console.log('\n🔑 ٢) المنحة الفردية تفتح فعليًا (الحسم سيرفي لا شكلي):');
        const c1 = await api('/api/indicators/contribution?year=2026&month=8', { token: T_CONTRIB });
        check('منحة indicators.contribution ← المساهمة تنجح فعليًا (200 + success)', c1.status === 200 && c1.data && c1.data.success === true, 'status=' + c1.status);
        const c1x = await api('/api/assets', { token: T_CONTRIB });
        check('منحة المساهمة لا تفتح العهد (لا تسلل بين الصلاحيات)', c1x.status === 403);
        const a1 = await api('/api/assets', { token: T_ASSETS });
        check('منحة assets.view ← /api/assets ينجح فعليًا', a1.status === 200, 'status=' + a1.status);
        const a1x = await api('/api/indicators/contribution?year=2026&month=8', { token: T_ASSETS });
        check('منحة العهد لا تفتح المساهمة (الاتجاه العكسي مقفل)', a1x.status === 403);

        console.log('\n🔒 ٣) symbols.manage تتحكم فعليًا + القفل السري طبقة باقية:');
        const s1 = await api('/api/schedule-symbols', { token: T_SYMBOLS });
        check('منحة symbols.manage ← GET الرموز يجتاز البوابة (≠403)', s1.status === 200 && s1.data && s1.data.success === true, 'status=' + s1.status);
        const s2 = await api('/api/schedule-symbols', { method: 'POST', token: T_SYMBOLS, body: { code: 'X', symbol_type: 'day' } });
        check('الكتابة بلا فتح قفل ← 423 SYMBOLS_LOCKED (القفل السري فوق الصلاحية كما هو)', s2.status === 423 && s2.data && s2.data.code === 'SYMBOLS_LOCKED', 'status=' + s2.status);
        const s3 = await api('/api/schedule-symbols/runtime', { token: T_NONE });
        check('مسار runtime يبقى للموثّقين (لم يُمس)', s3.status !== 403 && s3.status !== 401, 'status=' + s3.status);

        console.log('\n👥 ٤) الأدوار القائمة — عدم الانحدار:');
        const d1 = await api('/api/indicators/contribution?year=2026&month=8', { token: T_DIR });
        check('director لا يفقد المساهمة بعد الربط', d1.status === 200, 'status=' + d1.status);
        const d2 = await api('/api/schedule-symbols', { token: T_DIR });
        check('director لا يفقد الرموز (symbols.manage في دوره)', d2.status === 200, 'status=' + d2.status);
        const o1 = await api('/api/indicators/contribution?year=2026&month=8', { token: T_OPSUP });
        check('ops_supervisor يدخل المساهمة بعد الربط (أثر مخطط)', o1.status === 200, 'status=' + o1.status);
        const dr = await api('/api/indicators/contribution?year=2026&month=8', { token: T_DIR_REV });
        check('سحب المساهمة من director (granted=0) يغلب افتراضي دوره ← 403', dr.status === 403 && dr.data && dr.data.code === 'PERMISSION_DENIED', 'status=' + dr.status);

        console.log('\n👑 ٥) admin/sysadmin عبر النجمة:');
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const T_ADMIN = login.data && (login.data.token || login.data.accessToken);
        check('دخول admin الحالي ينجح', !!T_ADMIN);
        const ad1 = await api('/api/indicators/contribution?year=2026&month=8', { token: T_ADMIN });
        const ad2 = await api('/api/schedule-symbols', { token: T_ADMIN });
        const ad3 = await api('/api/assets', { token: T_ADMIN });
        const ad4 = await api('/api/permissions/catalog', { token: T_ADMIN });
        check('admin (*): مساهمة ✅ رموز ✅ عهد ✅ إدارة مستخدمين ✅', ad1.status === 200 && ad2.status === 200 && ad3.status === 200 && ad4.status === 200, [ad1.status, ad2.status, ad3.status, ad4.status].join('/'));

        console.log('\n🧪 ٦) سلامة العزل:');
        const realUsers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
        check('users.json الأصلي لم يُمس', realUsers.every(u => u.role === 'admin'));
        const realProbe = new Database(SRC_DB, { readonly: true });
        const hasTable = realProbe.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='user_permissions'").get().c > 0;
        const realPerms = hasTable ? realProbe.prepare("SELECT COUNT(*) c FROM user_permissions").get().c : 0;
        realProbe.close();
        check('القاعدة الأصلية لم تُضف إليها أي منحة (المجسات على النسخة فقط)', realPerms === 0, 'rows=' + realPerms);
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
})();
