// F-3 (صلاحيات granular): اختبار ربط الحراس الأربعة — بيئة معزولة بالكامل
// (VACUUM مؤقت + users.json مؤقت) — لا يلمس data/ الحقيقية إطلاقًا.
// الربط المعتمد (D1/D2/D4):
//   POST /api/employees/:code/transfer      ← authorizePerm('employees.manage')
//   PUT  /api/employees/:code/pattern       ← authorizePerm('employees.manage')
//   POST /api/shift-schedule/generate       ← authorizePerm('schedule.generate')
//   POST /api/shift-schedule/update         ← authorizePerm('schedule.bulk_update')
// يغطي: 403 لغير المخوَّل ×4 · نجاح admin/sysadmin بالنجمة ×4 · منحة فردية تفتح
// مسارها فقط ×4 · عدم تأثر F-1/F-2/الإجازات. صفر Migration/Schema.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-f3-'));
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
let server = null;

function api(method, url, body, token) {
    return new Promise((resolve, reject) => {
        const u = new URL(BASE + url);
        const data = body ? JSON.stringify(body) : null;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {});
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(buf); } catch (e) {}
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
function dbAll(sql, params) {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB, { readonly: true });
    const rows = db.prepare(sql).all(...(params || []));
    db.close();
    return rows;
}
function dbRun(sql, params) {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    db.prepare(sql).run(...(params || []));
    db.close();
}
function startServer() {
    return new Promise((resolve, reject) => {
        const env = Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' });
        server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        server.stdout.on('data', d => log += d);
        server.stderr.on('data', d => log += d);
        let attempts = 0;
        const tick = () => {
            http.get(BASE + '/health', (res) => {
                if (res.statusCode === 200) { res.resume(); return resolve(); }
                res.resume(); retry();
            }).on('error', retry);
        };
        const retry = () => {
            if (++attempts > 80) { console.error('server never ready. Log tail:\n' + log.slice(-3000)); return reject(new Error('boot failed')); }
            setTimeout(tick, 500);
        };
        tick();
    });
}
function stopServer() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.once('exit', () => { server = null; resolve(); });
        server.kill();
        setTimeout(resolve, 5000);
    });
}
async function login(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password });
    if (!r.data || !r.data.accessToken) throw new Error('login failed: ' + username + ' — ' + JSON.stringify(r.data));
    return r.data.accessToken;
}
function plusMonths(n) {
    const d = new Date();
    d.setMonth(d.getMonth() + n);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
}
const isDenied = (r, key) => r.status === 403 && r.data && r.data.code === 'PERMISSION_DENIED' && r.data.permission === key;

async function main() {
    console.log('═══ F-3 GRANULAR AUTH TEST — بيئة معزولة ═══');

    // ── 0) فحص ستاتيكي: الحراس الأربعة مربوطة بالمفاتيح المعتمدة حرفيًا ──
    console.log('\n── فحص ستاتيكي: الربط ──');
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check("transfer ← authorizePerm('employees.manage')",
        src.includes("app.post('/api/employees/:employeeCode/transfer', authenticate, authorizePerm('employees.manage')"));
    check("pattern ← authorizePerm('employees.manage')",
        src.includes("app.put('/api/employees/:employeeCode/pattern', authenticate, authorizePerm('employees.manage')"));
    check("generate ← authorizePerm('schedule.generate')",
        src.includes("app.post('/api/shift-schedule/generate', authenticate, authorizePerm('schedule.generate')"));
    check("update ← authorizePerm('schedule.bulk_update')",
        src.includes("app.post('/api/shift-schedule/update', authenticate, authorizePerm('schedule.bulk_update')"));
    check('لا أثر للحارس القديم على المسارات الأربعة',
        !src.includes("'/api/employees/:employeeCode/transfer', authenticate, authorize(") &&
        !src.includes("'/api/employees/:employeeCode/pattern', authenticate, authorize(") &&
        !src.includes("'/api/shift-schedule/generate', authenticate, authorize(") &&
        !src.includes("'/api/shift-schedule/update', authenticate, authorize("));

    // ── 1) التهيئة المعزولة ──
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const srcDb = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    srcDb.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    srcDb.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (u.username === 'DEMO101') u.password = hash; });
    const proto = users.find(u => u.username === 'DEMO101');
    // sysadmin بنجمة الكتالوج + ثلاثة حاملي منح فردية (دور user بلا مفاتيح الجدول)
    users.push(Object.assign({}, proto, { id: 'test-sysadm1', username: 'SYSADM1', name: 'مدير نظام اختبار', role: 'sysadmin', password: hash }));
    users.push(Object.assign({}, proto, { id: 'test-grantemp1', username: 'GRANTEMP1', name: 'منحة إدارة موظفين', password: hash }));
    users.push(Object.assign({}, proto, { id: 'test-grantgen1', username: 'GRANTGEN1', name: 'منحة توليد', password: hash }));
    users.push(Object.assign({}, proto, { id: 'test-grantblk1', username: 'GRANTBLK1', name: 'منحة تحديث جماعي', password: hash }));
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('test-grantemp1', 'employees.manage', 1, 'f3-test')");
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('test-grantgen1', 'schedule.generate', 1, 'f3-test')");
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('test-grantblk1', 'schedule.bulk_update', 1, 'f3-test')");

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');
    const admin = await login('4252', '4252');       // role admin — '*'
    const sysadm = await login('SYSADM1', 'test123'); // role sysadmin — '*'
    const demo1 = await login('DEMO101', 'test123');  // role user — بلا مفاتيح
    const gEmp = await login('GRANTEMP1', 'test123');
    const gGen = await login('GRANTGEN1', 'test123');
    const gBlk = await login('GRANTBLK1', 'test123');

    // Fixture: سطور roster لأيام النقل (لكل فاعل يوم مستقل) + معرّفات أساسية
    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const TEAM2 = dbAll('SELECT id FROM teams WHERE is_active = 1 LIMIT 1')[0].id;
    const D_ADMIN = '2031-01-10', D_SYS = '2031-01-11', D_GRANT = '2031-01-12';
    for (const dt of [D_ADMIN, D_SYS, D_GRANT]) {
        dbRun('DELETE FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, dt]);
        dbRun('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, NULL, ?, ?, 1, 2031)', [EMP1, dt, 'C']);
    }

    // ── 2) 403 لغير المخوَّل ×4 ──
    console.log('\n── غير المخوَّل (user بلا منحة) = 403 ──');
    const patternBefore = dbAll('SELECT pattern_code FROM employees WHERE id = ?', [EMP1])[0].pattern_code;
    const dTransfer = await api('POST', '/api/employees/DEMO101/transfer', { teamId: TEAM2, scope: 'day', date: D_GRANT }, demo1);
    check('transfer: 403 + permission=employees.manage', isDenied(dTransfer, 'employees.manage'), JSON.stringify(dTransfer.data));
    const dPattern = await api('PUT', '/api/employees/DEMO101/pattern', { patternCode: 'A' }, demo1);
    check('pattern: 403 + permission=employees.manage', isDenied(dPattern, 'employees.manage'), JSON.stringify(dPattern.data));
    const dGenerate = await api('POST', '/api/shift-schedule/generate', plusMonths(3), demo1);
    check('generate: 403 + permission=schedule.generate', isDenied(dGenerate, 'schedule.generate'), JSON.stringify(dGenerate.data));
    const dUpdate = await api('POST', '/api/shift-schedule/update', { id: 1, shift_hours: 12 }, demo1);
    check('update: 403 + permission=schedule.bulk_update', isDenied(dUpdate, 'schedule.bulk_update'), JSON.stringify(dUpdate.data));
    check('403 لم يكتب شيئًا: نمط DEMO101 لم يتغير',
        dbAll('SELECT pattern_code FROM employees WHERE id = ?', [EMP1])[0].pattern_code === patternBefore,
        'before=' + patternBefore + ' after=' + dbAll('SELECT pattern_code FROM employees WHERE id = ?', [EMP1])[0].pattern_code);
    const rosterBeforeDeny = dbAll('SELECT team_id FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, D_GRANT])[0];
    check('403 لم يكتب شيئًا: سطر roster ليوم النقل لم يتغير', rosterBeforeDeny && rosterBeforeDeny.team_id === null);

    // ── 3) النجمة: admin وsysadmin ينجحان ×4 ──
    console.log('\n── النجمة: admin وsysadmin ──');
    const aTransfer = await api('POST', '/api/employees/DEMO101/transfer', { teamId: TEAM2, scope: 'day', date: D_ADMIN }, admin);
    check('admin: transfer 200', aTransfer.ok && aTransfer.data.success === true, JSON.stringify(aTransfer.data));
    const aPattern = await api('PUT', '/api/employees/DEMO101/pattern', { patternCode: 'A' }, admin);
    check('admin: pattern 200', aPattern.ok && aPattern.data.success === true, JSON.stringify(aPattern.data));
    const m1 = plusMonths(3);
    const aGenerate = await api('POST', '/api/shift-schedule/generate', { year: m1.year, month: m1.month }, admin);
    check('admin: generate 200 + schedule[]', aGenerate.ok && aGenerate.data.success === true && Array.isArray(aGenerate.data.schedule), JSON.stringify(aGenerate.data).slice(0, 120));
    const autoRow1 = dbAll("SELECT id FROM shift_schedule_auto WHERE shift_date LIKE ? LIMIT 1", [m1.year + '-' + String(m1.month).padStart(2, '0') + '-%'])[0];
    const aUpdate = await api('POST', '/api/shift-schedule/update', { id: autoRow1.id, shift_hours: 12 }, admin);
    check('admin: update 200', aUpdate.ok && aUpdate.data.success === true, JSON.stringify(aUpdate.data));

    const sTransfer = await api('POST', '/api/employees/DEMO101/transfer', { teamId: TEAM2, scope: 'day', date: D_SYS }, sysadm);
    check('sysadmin: transfer 200', sTransfer.ok && sTransfer.data.success === true, JSON.stringify(sTransfer.data));
    const sPattern = await api('PUT', '/api/employees/DEMO101/pattern', { patternCode: 'B' }, sysadm);
    check('sysadmin: pattern 200', sPattern.ok && sPattern.data.success === true, JSON.stringify(sPattern.data));
    const m2 = plusMonths(4);
    const sGenerate = await api('POST', '/api/shift-schedule/generate', { year: m2.year, month: m2.month }, sysadm);
    check('sysadmin: generate 200', sGenerate.ok && sGenerate.data.success === true, JSON.stringify(sGenerate.data).slice(0, 120));
    const autoRow2 = dbAll("SELECT id FROM shift_schedule_auto WHERE shift_date LIKE ? LIMIT 1", [m2.year + '-' + String(m2.month).padStart(2, '0') + '-%'])[0];
    const sUpdate = await api('POST', '/api/shift-schedule/update', { id: autoRow2.id, shift_hours: 8 }, sysadm);
    check('sysadmin: update 200', sUpdate.ok && sUpdate.data.success === true, JSON.stringify(sUpdate.data));

    // ── 4) المنحة الفردية تفتح مسارها فقط ×4 ──
    console.log('\n── المنحة الفردية: مسارها فقط ──');
    const gTransfer = await api('POST', '/api/employees/DEMO101/transfer', { teamId: TEAM2, scope: 'day', date: D_GRANT }, gEmp);
    check('منحة employees.manage: transfer 200', gTransfer.ok && gTransfer.data.success === true, JSON.stringify(gTransfer.data));
    const gPattern = await api('PUT', '/api/employees/DEMO101/pattern', { patternCode: null }, gEmp);
    check('منحة employees.manage: pattern 200 (مسح النمط)', gPattern.ok && gPattern.data.success === true, JSON.stringify(gPattern.data));
    check('منحة employees.manage: generate يبقى 403', isDenied(await api('POST', '/api/shift-schedule/generate', plusMonths(5), gEmp), 'schedule.generate'));
    check('منحة employees.manage: update يبقى 403', isDenied(await api('POST', '/api/shift-schedule/update', { id: autoRow1.id, shift_hours: 9 }, gEmp), 'schedule.bulk_update'));

    const m3 = plusMonths(5);
    const gGenerate = await api('POST', '/api/shift-schedule/generate', { year: m3.year, month: m3.month }, gGen);
    check('منحة schedule.generate: generate 200', gGenerate.ok && gGenerate.data.success === true, JSON.stringify(gGenerate.data).slice(0, 120));
    check('منحة schedule.generate: transfer يبقى 403', isDenied(await api('POST', '/api/employees/DEMO101/transfer', { teamId: TEAM2, scope: 'day', date: D_ADMIN }, gGen), 'employees.manage'));
    check('منحة schedule.generate: pattern يبقى 403', isDenied(await api('PUT', '/api/employees/DEMO101/pattern', { patternCode: 'A' }, gGen), 'employees.manage'));
    const autoRow3 = dbAll("SELECT id FROM shift_schedule_auto WHERE shift_date LIKE ? LIMIT 1", [m3.year + '-' + String(m3.month).padStart(2, '0') + '-%'])[0];
    check('منحة schedule.generate: update يبقى 403', isDenied(await api('POST', '/api/shift-schedule/update', { id: autoRow3.id, shift_hours: 9 }, gGen), 'schedule.bulk_update'));

    const gUpdate = await api('POST', '/api/shift-schedule/update', { id: autoRow3.id, shift_hours: 12 }, gBlk);
    check('منحة schedule.bulk_update: update 200', gUpdate.ok && gUpdate.data.success === true, JSON.stringify(gUpdate.data));
    check('منحة schedule.bulk_update: generate يبقى 403', isDenied(await api('POST', '/api/shift-schedule/generate', plusMonths(6), gBlk), 'schedule.generate'));
    check('منحة schedule.bulk_update: transfer يبقى 403', isDenied(await api('POST', '/api/employees/DEMO101/transfer', { teamId: TEAM2, scope: 'day', date: D_SYS }, gBlk), 'employees.manage'));
    check('منحة schedule.bulk_update: pattern يبقى 403', isDenied(await api('PUT', '/api/employees/DEMO101/pattern', { patternCode: 'A' }, gBlk), 'employees.manage'));

    // ── 5) عدم التأثر: F-1/F-2 (طلبات المناوبة) والإجازات ──
    console.log('\n── عدم تأثر F-1/F-2/الإجازات ──');
    const scSubmit = await api('POST', '/api/shift-change-request', { shift_date: '2031-02-15', proposed_shift_code: 'C', reason: 'فحص عدم تأثر F-3' }, demo1);
    check('F-2: تقديم طلب تغيير مناوبة للموظف يعمل (200)', scSubmit.ok && !!scSubmit.data.id, JSON.stringify(scSubmit.data));
    const scReview403 = await api('POST', '/api/shift-change-request/' + scSubmit.data.id + '/review', { status: 'approved' }, demo1);
    check('F-1: مراجعة الطلب تبقى خلف requests.review (403 للموظف)', scReview403.status === 403);
    const scReview = await api('POST', '/api/shift-change-request/' + scSubmit.data.id + '/review', { status: 'approved' }, admin);
    check('F-1: اعتماد المدير يطبّق (200 + applied)', scReview.ok && scReview.data.applied && scReview.data.applied.shift_code === 'C', JSON.stringify(scReview.data));
    const lvSubmit = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: '2031-03-10', end_date: '2031-03-11', type: 'إجازة', reason: 'فحص عدم تأثر F-3' }, demo1);
    check('الإجازات: تقديم طلب إجازة يعمل (200)', lvSubmit.ok && !!lvSubmit.data.id, JSON.stringify(lvSubmit.data));
    const lvApprove403 = await api('POST', '/api/leave-requests/' + lvSubmit.data.id + '/approve', { status: 'approved' }, demo1);
    check('الإجازات: الاعتماد يبقى خلف leave.review (403 للموظف)', lvApprove403.status === 403);

    // ── الخلاصة ──
    await stopServer();
    console.log('\n═══════════════════════════════════');
    // تنسيق الملخص الموحد — بوابة ما قبل النشر تقرأه حرفيًا
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failed > 0) {
        console.log('الفاشلة:');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('✅ F-3 GRANULAR AUTH TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
