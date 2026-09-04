/**
 * ═══ اختبار حِراسة عمليات admin.users_manage الكتابية (قرار المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3128 — لا تمس بيانات الإنتاج.
 *
 * يثبت المطلوب حرفيًا:
 *  ① admin بالنجمة بلا منحة فردية: لا يستطيع تنفيذ عمليات admin.users_manage الكتابية
 *    (grant/revoke/clear + إنشاء مستخدم + تغيير دور) ولا قراءة الكتالوج/القوائم.
 *  ② لا يستطيع منح نفسه أو غيره admin.users_manage دون التفويض الصحيح —
 *    والحامل الصريح يستطيع منح غيره (تفويض صحيح) بينما يبقى المنح الذاتي محظورًا.
 *  ③ eff.granted لا تتضمن أذونات الدور أو النجمة — منح فردية فقط (عبر /api/permissions/user/:id).
 *  ④ admin بمنحة staff.phone_view يرى phone فقط دون phone_verified*.
 *  + إثبات bootstrap: دور user بمنحة فردية admin.users_manage يمر — العضوية الصريحة تُحترم بغض النظر عن الدور.
 *
 * التشغيل: node scripts/permissions-write-guard-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'permguard-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'permguard-data-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'perm-guard-' + STAMP);
const PORT = 3128;
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

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    const hash = bcrypt.hashSync('guardpass1', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'adm-WNG1', username: 'WNG1', name: 'مدير نجمة بلا منحة', password: hash, role: 'admin', isActive: true },
        { id: 'adm-WGR', username: 'WGR', name: 'مدير حامل المفتاح', password: hash, role: 'admin', isActive: true },
        { id: 'adm-WPV', username: 'WPV', name: 'مدير حامل phone_view', password: hash, role: 'admin', isActive: true },
        { id: 'usr-WUG', username: 'WUG', name: 'مستخدم حامل المفتاح', password: hash, role: 'user', isActive: true },
        { id: 'usr-WT', username: 'WT', name: 'هدف المنح', password: hash, role: 'user', isActive: true },
        { id: 'usr-WD', username: 'WD', name: 'مشرف بلا منح', password: hash, role: 'director', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const cols = dbw.prepare('PRAGMA table_info(employees)').all();
    if (!cols.some(c => c.name === 'phone_verified')) dbw.exec('ALTER TABLE employees ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0');
    dbw.prepare('INSERT INTO employees (employee_code, name, job_title, phone, is_active, phone_verified) VALUES (?,?,?,?,1,1)').run('WG2', 'موظف مراقَب', 'فني اسعاف', '0503333333');
    const grant = dbw.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)');
    grant.run('adm-WGR', 'admin.users_manage', 'test-bootstrap');   // الحامل الصريح (admin)
    grant.run('usr-WUG', 'admin.users_manage', 'test-bootstrap');   // الحامل الصريح (user — إثبات bootstrap)
    grant.run('adm-WPV', 'staff.phone_view', 'test-bootstrap');     // لخاصية ④
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — حِراسة عمليات admin.users_manage');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    async function login(u) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'guardpass1' }) });
        const b = await r.json();
        return { status: r.status, token: b.accessToken || null };
    }
    async function api(p, method, tok, body) {
        const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    function dbRead(fn) { const d = new Database(TMP_DB, { readonly: true }); const v = fn(d); d.close(); return v; }
    const denied = r => r.status === 403 && r.body.code === 'PERMISSION_DENIED';

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const wng1 = await login('WNG1');   // admin نجمة بلا منحة
        const wgr = await login('WGR');     // admin + admin.users_manage
        const wpv = await login('WPV');     // admin + staff.phone_view
        const wug = await login('WUG');     // user + admin.users_manage
        if (!wng1.token || !wgr.token || !wpv.token || !wug.token) throw new Error('فشل دخول أحد الحسابات');

        // ── ① admin بلا منحة: العمليات الكتابية الخمس كلها ممنوعة ──
        const g1 = await api('/api/permissions/grant', 'POST', wng1.token, { user_id: 'usr-WT', permission: 'ops.files' });
        const r1 = await api('/api/permissions/revoke', 'POST', wng1.token, { user_id: 'usr-WT', permission: 'ops.execute' });
        const c1 = await api('/api/permissions/clear', 'POST', wng1.token, { user_id: 'usr-WT', permission: 'ops.execute' });
        const u1 = await api('/api/users', 'POST', wng1.token, { username: 'WGNEW', name: 'حساب مرفوض', role: 'user', employeeCode: 'WG2' });
        const ro1 = await api('/api/users/usr-WT/role', 'POST', wng1.token, { role: 'viewer' });
        check('① admin نجمة بلا منحة: grant/revoke/clear + إنشاء مستخدم + تغيير دور — الخمسة ← 403 PERMISSION_DENIED',
            [g1, r1, c1, u1, ro1].every(denied),
            JSON.stringify([g1.status, r1.status, c1.status, u1.status, ro1.status]));

        // ── ①ب) ولا قراءة الكتالوج/القوائم أيضًا (التشديد يشمل قراءات المفتاح) ──
        const cat1 = await api('/api/permissions/catalog', 'GET', wng1.token);
        const lst1 = await api('/api/permissions/users', 'GET', wng1.token);
        const one1 = await api('/api/permissions/user/usr-WT', 'GET', wng1.token);
        check('①ب) ولا قراءة: catalog + users + user/:id ← 403 PERMISSION_DENIED',
            [cat1, lst1, one1].every(denied), JSON.stringify([cat1.status, lst1.status, one1.status]));

        // ── ②أ) لا يستطيع منح نفسه admin.users_manage — ولا صف يُنشأ ──
        const self2 = await api('/api/permissions/grant', 'POST', wng1.token, { user_id: 'adm-WNG1', permission: 'admin.users_manage' });
        const selfRow = dbRead(d => d.prepare("SELECT COUNT(*) c FROM user_permissions WHERE user_id='adm-WNG1'").get().c);
        check('②أ) منح النفس admin.users_manage بلا تفويض ← 403 ولا صف في user_permissions',
            denied(self2) && selfRow === 0, JSON.stringify({ s: self2.status, rows: selfRow }));

        // ── ②ب) لا يستطيع منح غيره admin.users_manage — ولا صف يُنشأ ──
        const oth2 = await api('/api/permissions/grant', 'POST', wng1.token, { user_id: 'usr-WT', permission: 'admin.users_manage' });
        const othRow = dbRead(d => d.prepare("SELECT COUNT(*) c FROM user_permissions WHERE user_id='usr-WT' AND permission_key='admin.users_manage'").get().c);
        check('②ب) منح غيره admin.users_manage بلا تفويض ← 403 ولا صف في user_permissions',
            denied(oth2) && othRow === 0, JSON.stringify({ s: oth2.status, rows: othRow }));

        // ── ②ج) التفويض الصحيح: الحامل الصريح يمنح غيره بنجاح — والمنح الذاتي يبقى محظورًا ──
        const okGrant = await api('/api/permissions/grant', 'POST', wgr.token, { user_id: 'usr-WT', permission: 'admin.users_manage' });
        const selfGrant2 = await api('/api/permissions/grant', 'POST', wgr.token, { user_id: 'adm-WGR', permission: 'ops.files' });
        const wtRow = dbRead(d => d.prepare("SELECT granted FROM user_permissions WHERE user_id='usr-WT' AND permission_key='admin.users_manage'").get());
        check('②ج) الحامل يمنح غيره المفتاح ← 200 ويُسجَّل · والمنح الذاتي يبقى 403 SELF_MODIFY_DENIED',
            okGrant.status === 200 && wtRow && wtRow.granted === 1
            && selfGrant2.status === 403 && selfGrant2.body.code === 'SELF_MODIFY_DENIED',
            JSON.stringify({ ok: okGrant.status, wt: wtRow, self: self2 && selfGrant2.status, code: selfGrant2.body.code }));

        // ── ③) eff.granted نقاء: لا أذونات دور ولا نجمة — منح فردية فقط ──
        const pStar = await api('/api/permissions/user/adm-WNG1', 'GET', wgr.token);   // نجمة بلا صفوف
        const pDir = await api('/api/permissions/user/usr-WD', 'GET', wgr.token);      // director بلا صفوف
        const pWt = await api('/api/permissions/user/usr-WT', 'GET', wgr.token);       // user بمنحة واحدة
        const dirDefaults = (pDir.body.permissions || []).length;
        check('③) granted نقية: نجمة بلا صفوف ← granted=[] · director ← granted=[] رغم ' + 'أذونات دوره · الممنوح ← granted=[admin.users_manage] فقط',
            pStar.status === 200 && pStar.body.permissions_star === true && (pStar.body.permissions_granted || []).length === 0
            && pDir.status === 200 && (pDir.body.permissions_granted || []).length === 0 && dirDefaults > 0
            && pWt.status === 200 && JSON.stringify(pWt.body.permissions_granted) === JSON.stringify(['admin.users_manage']),
            JSON.stringify({ star: pStar.body.permissions_granted, dir: pDir.body.permissions_granted, dirN: dirDefaults, wt: pWt.body.permissions_granted }));

        // ── ④) admin بمنحة staff.phone_view: يرى phone فقط دون phone_verified* ──
        const el = await api('/api/employees', 'GET', wpv.token);
        const rec4 = (el.body.employees || []).find(e => e.employee_code === 'WG2');
        const verKeys4 = rec4 ? ['phone_verified', 'phone_verified_at', 'phone_verified_by'].filter(k => Object.prototype.hasOwnProperty.call(rec4, k)) : ['NO_RECORD'];
        check('④) admin + staff.phone_view: يرى phone ولا يرى phone_verified* إطلاقًا',
            el.status === 200 && rec4 && rec4.phone === '0503333333' && verKeys4.length === 0,
            JSON.stringify({ phone: rec4 && rec4.phone, verKeys: verKeys4 }));

        // ── bootstrap) دور user بمنحة فردية admin.users_manage يمر — العضوية الصريحة فوق الدور ──
        const boot = await api('/api/permissions/revoke', 'POST', wug.token, { user_id: 'usr-WT', permission: 'admin.users_manage' });
        const afterBoot = dbRead(d => d.prepare("SELECT granted FROM user_permissions WHERE user_id='usr-WT' AND permission_key='admin.users_manage'").get());
        check('bootstrap) user بمنحة فردية ينفذ الكتابة ← 200 (سحب ما منحه WGR)',
            boot.status === 200 && afterBoot && afterBoot.granted === 0,
            JSON.stringify({ s: boot.status, after: afterBoot }));

        // ── تدقيق) المنح الناجحة سُجّلت باسم الفاعل ──
        const audit = dbRead(d => d.prepare("SELECT user_name, action FROM audit_log WHERE action='permission_grant' ORDER BY id DESC LIMIT 1").get());
        check('تدقيق) permission_grant مسجلة باسم الحامل WGR', !!audit && audit.user_name === 'مدير حامل المفتاح', JSON.stringify(audit));

        console.log('\n════════════════ نتيجة حِراسة admin.users_manage: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
        console.log('المخرجات: ' + OUT_DIR);
    } finally {
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})();
