/**
 * ═══ اختبار توافق المخطط القانوني — إثبات إصلاح 500 (2026-09-04) ═══
 * السبب المؤكد إنتاجيًا: shift_roster في الإنتاج بلا عمود updated_at
 * (المخطط القانوني db.js:369-380)، ففشل profile/schedule ونجح assignments/team-incidents.
 * هذا الاختبار يبني قاعدة طازجة من db.js نفسه (= المخطط القانوني للإنتاج)
 * ويثبت أن المسارات الأربعة كلها تعمل بعد الإصلاح (created_at بدل updated_at).
 *
 * التشغيل: node scripts/my-portal-schema-compat-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const STAMP = Date.now();
const FRESH_DB = path.join(os.tmpdir(), 'canonical-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'canonical-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3134;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, url, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (_) { }
    return { status: r.status, body: json };
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── 1) بناء قاعدة طازجة بالمخطط القانوني عبر db.js نفسه (عملية ابنة) ──
    const initCode = `
        process.env.DB_PATH = process.argv[1];
        (async () => {
            const db = require(${JSON.stringify(path.join(ROOT, 'db.js'))});
            await db.openDb();
            await db.init(false);
            await db.closeDb();
            console.log('SCHEMA_READY');
        })().catch(e => { console.error('INIT_FAIL', e.message); process.exit(1); });
    `;
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', initCode, FRESH_DB], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => out += d);
        child.on('exit', c => (c === 0 && out.includes('SCHEMA_READY')) ? resolve() : reject(new Error('فشل بناء المخطط: ' + out.slice(-400))));
    });

    // ── 2) إثبات أن المخطط القانوني بلا updated_at (مطابقة الإنتاج) ──
    const probe = new Database(FRESH_DB, { readonly: true });
    const rosterCols = probe.prepare('PRAGMA table_info(shift_roster)').all().map(c => c.name);
    probe.close();
    check('1) المخطط القانوني لـshift_roster بلا updated_at (مطابق للإنتاج)', !rosterCols.includes('updated_at'), rosterCols.join(','));
    check('2) المخطط القانوني يحوي created_at', rosterCols.includes('created_at'), rosterCols.join(','));

    // ── 3) تجهيزات: فرقة + رمز + موظف + roster (بلا updated_at — كما الإنتاج) ──
    const dbw = new Database(FRESH_DB);
    const NOW = '2026-09-04 04:00:00';
    const teamId = dbw.prepare("INSERT INTO teams (name, center, team_type, sort_order, is_active) VALUES ('فرقة توافق','مركز توافق','اختبار',99,1)").run().lastInsertRowid;
    try { dbw.prepare("INSERT INTO shift_codes (code, name, status) VALUES ('D12','دوام 12 صباحاً','دوام')").run(); } catch (_) { }
    const empId = dbw.prepare("INSERT INTO employees (employee_code, name, job_title, is_active) VALUES ('T901','موظف توافق المخطط','فني اسعاف',1)").run().lastInsertRowid;
    // إدراج بقائمة أعمدة صريحة بلا updated_at — تمامًا كما تفعل خدمة المزامنة في الإنتاج
    dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?,?,?,?,?,?)')
        .run(empId, teamId, '2026-09-04', 'D12', 9, 2026);
    dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?,?,?,?,?,?)')
        .run(empId, teamId, '2026-09-03', 'D12', 9, 2026);
    dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-T901','ops.my_portal',1,'compat')").run();
    dbw.close();

    // users.json مؤقت
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const hash = bcrypt.hashSync('test1234', 10);
    fs.writeFileSync(path.join(TMP_DIR, 'users.json'), JSON.stringify([
        { id: 'emp-T901', username: 'T901', name: 'موظف توافق المخطط', password: hash, role: 'user', isActive: true }
    ], null, 2));

    // ── 4) الخادم المعزول فوق القاعدة القانونية ──
    console.log('🧪 خادم معزول على ' + PORT + ' فوق مخطط قانوني طازج (بلا updated_at)');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: FRESH_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const errs = [];
    server.stderr.on('data', d => errs.push(String(d)));
    try {
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) ok = true; } catch (_) { } if (!ok) await sleep(1000); }
        if (!ok) throw new Error('الخادم لم يجهز — ' + errs.join('').slice(-300));

        const login = await api('POST', '/api/auth/login', { body: { username: 'T901', password: 'test1234' } });
        const T = login.body && login.body.accessToken;
        check('3) الدخول بحساب الاختبار', !!T, JSON.stringify(login.status));

        const profile = await api('GET', '/api/my/profile', { token: T });
        check('4) profile ← 200 فوق مخطط بلا updated_at', profile.status === 200, JSON.stringify(profile.body).slice(0, 200));
        check('5) profile.lastRosterUpdate مشتق من created_at', !!(profile.body && profile.body.lastRosterUpdate), JSON.stringify(profile.body && profile.body.lastRosterUpdate));

        const schedule = await api('GET', '/api/my/schedule?month=9&year=2026', { token: T });
        check('6) schedule ← 200 فوق مخطط بلا updated_at', schedule.status === 200, JSON.stringify(schedule.body).slice(0, 200));
        check('7) schedule يعرض اليومين والرمز المترجم', schedule.body && Array.isArray(schedule.body.days) && schedule.body.days.length === 2 && schedule.body.days[0].shiftName === 'دوام 12 صباحاً', JSON.stringify(schedule.body && schedule.body.days).slice(0, 200));
        check('8) schedule.lastUpdate موجود', !!(schedule.body && schedule.body.lastUpdate), JSON.stringify(schedule.body && schedule.body.lastUpdate));

        const assignments = await api('GET', '/api/my/assignments', { token: T });
        check('9) assignments ← 200', assignments.status === 200 && assignments.body.periods.length === 1, JSON.stringify(assignments.body).slice(0, 200));

        const incidents = await api('GET', '/api/my/team-incidents', { token: T });
        check('10) team-incidents ← 200', incidents.status === 200, JSON.stringify(incidents.body).slice(0, 150));

        const myErr = errs.join('').match(/\[my-portal\][\s\S]{0,300}/g);
        check('11) لا أخطاء [my-portal] في سجل الخادم', !myErr, myErr ? myErr[0] : '');
    } finally {
        server.kill();
        await sleep(800);
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(FRESH_DB + ext, { force: true }); } catch (_) { } }
    }

    console.log('\n════════════════════════════════════');
    console.log(`النتيجة: ${passed} ناجح · ${failed} فاشل`);
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥 ' + e.message); process.exit(1); });
