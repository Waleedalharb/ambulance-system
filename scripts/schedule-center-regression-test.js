/**
 * منع تكرار أخطاء مركز الجدولة: مشغّل Node، المخطط، الصلاحيات وكل أقسام القراءة وP6.
 * قاعدة وحسابات وملفات اصطناعية معزولة فقط؛ لا توليد أو اعتماد أو نشر أو بيانات إنتاج.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '.test-tmp', 'p3-1793826466969');
const OUT = path.join(ROOT, 'test-output', 'schedule-center-regression-' + Date.now());
const TMP_DB = path.join(OUT, 'ambulance.db');
const TMP_DATA = path.join(OUT, 'data');
const PORT = 3126, BASE = `http://127.0.0.1:${PORT}`;
process.env.DB_PATH = TMP_DB;
process.env.DATA_DIR = TMP_DATA;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p3-isolated-workspace-test-secret';
let server = null, raw = null, serverLog = '', passed = 0, failed = 0;
const failures = [], checks = [];
function check(name, condition, detail = null) {
    const ok = !!condition;
    checks.push({ name, ok, detail: ok ? null : detail });
    if (ok) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}
function must(name, condition, detail) { check(name, condition, detail); if (!condition) throw new Error(name); }
function hashRows(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function snapshot() {
    return Object.fromEntries(['shift_roster', 'schedule_months', 'employees', 'users', 'user_permissions', 'schedule_versions', 'schedule_generation_runs'].map(table => [table, hashRows(raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
}
async function api(endpoint, { method = 'GET', token, body, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const response = await fetch(BASE + endpoint, { method, headers, body: payload });
    let data = null;
    if ((response.headers.get('content-type') || '').includes('application/json')) {
        try { data = await response.json(); } catch (_) {}
    }
    return { status: response.status, data, response };
}
async function waitReady() {
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(BASE + '/health')).ok) return true; } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
}
async function stopServer() {
    if (!server || server.killed || server.exitCode !== null) return;
    const child = server; server = null;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
    });
}
(async () => {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    must('مجس P3 الاصطناعي موجود', fs.existsSync(path.join(SOURCE, 'ambulance.db')) && fs.existsSync(path.join(SOURCE, 'data', 'users.json')));
    fs.copyFileSync(path.join(SOURCE, 'ambulance.db'), TMP_DB);
    fs.copyFileSync(path.join(SOURCE, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));
    const { discoverNode22, launchConfiguration } = require('./dev-server');
    const discovered = discoverNode22();
    check('مشغّل التطوير يكتشف Node 22 محمولًا', !!discovered && /node-v22\./.test(discovered) && fs.existsSync(discovered), String(discovered));
    const launch = launchConfiguration();
    check('المشغّل يستخدم binary متوافقًا ويمرّر المنافذ', fs.existsSync(launch.nodeBinary) && launch.options.env.PATH.startsWith(path.dirname(launch.nodeBinary)) && launch.options.env.PORT === '3002');
    if (process.env.NODE24_BINARY && fs.existsSync(process.env.NODE24_BINARY)) {
        const output = execFileSync(process.env.NODE24_BINARY, ['-e', `const d=require(${JSON.stringify(path.join(__dirname, 'dev-server.js'))});const c=d.launchConfiguration();if(!c.nodeBinary.includes('node-v22.'))process.exit(2);console.log(JSON.stringify({parent:process.version,selected:c.nodeBinary}));`], { encoding: 'utf8', env: { ...process.env, NODE_BINARY: '' } });
        const selection = JSON.parse(output.trim());
        check('Node 24 الأب يحوّل التشغيل فعليًا إلى Node 22', selection.parent.startsWith('v24.') && /node-v22\./.test(selection.selected), output);
    } else check('اختبار الأب Node 24 متاح', false, 'NODE24_BINARY غير مضبوط');
    const previous = process.env.NODE_BINARY;
    process.env.NODE_BINARY = path.join(OUT, 'missing-node.exe');
    let missingRejected = false;
    try { launchConfiguration(); } catch (error) { missingRejected = /NODE_BINARY غير موجود/.test(error.message); }
    if (previous === undefined) delete process.env.NODE_BINARY; else process.env.NODE_BINARY = previous;
    check('NODE_BINARY المفقود يفشل برسالة تشخيصية', missingRejected);
    if (process.env.NODE24_BINARY) {
        process.env.NODE_BINARY = process.env.NODE24_BINARY;
        let wrongRejected = false;
        try { launchConfiguration(); } catch (error) { wrongRejected = /يجب أن يكون Node 22/.test(error.message); }
        if (previous === undefined) delete process.env.NODE_BINARY; else process.env.NODE_BINARY = previous;
        check('NODE_BINARY لإصدار غير متوافق مرفوض قبل الإقلاع', wrongRejected);
    }

    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-schedule-p1-p3.js'), '--db', TMP_DB, '--verify'], { stdio: 'pipe' });
    check('ترحيل P1–P3 مكتمل ومطابق', true);
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-schedule-p6.js'), '--db', TMP_DB], { stdio: 'pipe' });
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-schedule-p6.js'), '--db', TMP_DB, '--verify'], { stdio: 'pipe' });
    check('ترحيل P6 مطبق ومطابق على النسخة', true);

    raw = new (require('better-sqlite3'))(TMP_DB);
    const baseline = snapshot();
    const generated = raw.prepare("SELECT id FROM schedule_versions WHERE version_kind <> 'bootstrap_reference' ORDER BY created_at, id").all();
    const reference = raw.prepare("SELECT id FROM schedule_versions WHERE version_kind = 'bootstrap_reference' ORDER BY created_at LIMIT 1").get();
    const entry = raw.prepare('SELECT e.employee_id, r.schedule_version_id FROM schedule_generation_entries e JOIN schedule_generation_runs r ON r.id = e.run_id ORDER BY e.id LIMIT 1').get();
    must('المجس يحوي إصدارين للمقارنة وموظفًا', generated.length >= 2 && reference && entry);
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { serverLog += chunk; });
    server.stderr.on('data', chunk => { serverLog += chunk; });
    must('الخادم يعمل على Node 22 دون fallback', await waitReady(), serverLog.slice(-4000));
    const health = await api('/health');
    check('health يثبت SQLite والتخزين الدائم وJWT', health.status === 200 && health.data.checks.storage === true && health.data.checks.jwt === true && health.data.storageProof.persistent === true && health.data.storageProof.writable === true && health.data.storageProof.dbPath === TMP_DB, JSON.stringify(health.data).slice(0, 1000));
    const jwt = require('jsonwebtoken');
    const users = ['p3-admin', 'p3-viewer', 'p3-importer', 'p3-denied'];
    const tokens = Object.fromEntries(users.map(id => [id, jwt.sign({ id, role: id === 'p3-admin' ? 'admin' : 'director', name: id }, process.env.JWT_SECRET)]));

    const readEndpoints = [
        '/api/schedule/workspace?month=2026-03',
        '/api/schedule/imports',
        '/api/schedule/reference?target_month=2026-03',
        '/api/schedule/versions?month=2026-03',
        `/api/schedule/versions/${reference.id}`,
        '/api/schedule/generation-runs?month=2026-03',
        '/api/schedule/exceptions?month=2026-03',
        '/api/schedule/coverage-approvals?month=2026-03',
        '/api/schedule/audit-log?month=2026-03&limit=500',
        `/api/schedule/generated-versions/${generated[0].id}/lifecycle`,
        `/api/schedule/versions/${entry.schedule_version_id}/employee/${entry.employee_id}`,
        `/api/schedule/version-comparison?base_id=${generated[0].id}&target_id=${generated[1].id}`
    ];
    for (const endpoint of readEndpoints) {
        let result = await api(endpoint);
        check(`401 بلا جلسة: ${endpoint.split('?')[0]}`, result.status === 401, JSON.stringify(result.data));
        result = await api(endpoint, { token: tokens['p3-denied'] });
        check(`403 آمن بلا schedule.view: ${endpoint.split('?')[0]}`, result.status === 403 && result.data.code === 'PERMISSION_DENIED' && result.data.permission === 'schedule.view' && Object.keys(result.data).length === 3, JSON.stringify(result.data));
        result = await api(endpoint, { token: tokens['p3-viewer'] });
        check(`200 للمخول: ${endpoint.split('?')[0]}`, result.status === 200 && result.data && !result.data.error, JSON.stringify(result.data).slice(0, 800));
    }
    const me = await api('/api/auth/me', { token: tokens['p3-viewer'] });
    check('auth/me وPermissionService يعيدان الصلاحية الفعلية', me.status === 200 && me.data.permissions.includes('schedule.view') && !me.data.permissions.includes('schedule.generate'), JSON.stringify(me.data).slice(0, 500));
    const adminWorkspace = await api('/api/schedule/workspace?month=2026-03', { token: tokens['p3-admin'] });
    check('admin=\'*\' يقرأ المركز دون تغيير العقد', adminWorkspace.status === 200 && Array.isArray(adminWorkspace.data.versions));

    const team = raw.prepare('SELECT name FROM teams ORDER BY id LIMIT 1').get();
    const csv = Buffer.from(`Employee Number,Shift Date,Duty,Team,Total Hours\nP3-E1,2026-03-01,D12,${team.name},12\n`, 'utf8');
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'synthetic-center-regression.csv');
    form.append('month', '2026-03');
    let upload = await api('/api/schedule/imports', { method: 'POST', token: tokens['p3-denied'], form });
    check('رفع P6 بلا schedule.import مرفوض 403', upload.status === 403 && upload.data.permission === 'schedule.import');
    upload = await api('/api/schedule/imports', { method: 'POST', token: tokens['p3-importer'], form });
    must('رفع P6 اصطناعي متصل بالخدمة الفعلية 201', upload.status === 201 && upload.data.batch && upload.data.batch.analysis, JSON.stringify(upload.data).slice(0, 1000));
    const batch = upload.data.batch;
    const batchRead = await api(`/api/schedule/imports/${batch.id}`, { token: tokens['p3-viewer'] });
    check('تفاصيل دفعة P6 وخيارات المراجعة متاحة', batchRead.status === 200 && batchRead.data.batch.id === batch.id && batchRead.data.options && Array.isArray(batchRead.data.options.employees));
    const file = await api(`/api/schedule/imports/${batch.id}/file`, { token: tokens['p3-viewer'] });
    const bytes = Buffer.from(await file.response.arrayBuffer());
    check('تنزيل أصل P6 يطابق SHA-256', file.status === 200 && crypto.createHash('sha256').update(bytes).digest('hex') === batch.file_sha256);
    const after = snapshot();
    for (const table of Object.keys(baseline)) check(`لم تتغير بيانات ${table}`, after[table] === baseline[table]);
    check('لا أخطاء 500 أو fallback في سجل الخادم', !/authorizePerm error|Smart schedule import error|Schedule generation error|Falling back to JSON file mode/.test(serverLog), serverLog.slice(-2000));
    const html = fs.readFileSync(path.join(ROOT, 'public', 'schedule-workspace.html'), 'utf8');
    const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
    check('واجهة المركز تعرض الأقسام التسعة بما فيها الاستيراد', tabs.length === 9 && ['overview', 'imports', 'reference', 'versions', 'review', 'employees', 'exceptions', 'coverage', 'audit'].every(tab => tabs.includes(tab)), tabs.join(','));

    fs.writeFileSync(path.join(OUT, 'server.log'), serverLog);
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ passed, failed, failures, checks, scope: 'synthetic isolated; no generation/approval/publication; no production data', finishedAt: new Date().toISOString() }, null, 2));
    console.log(`\nالنتيجة: ${passed} ناجح / ${failed} فاشل\nالأدلة: ${OUT}`);
    await stopServer(); raw.close(); raw = null;
    process.exit(failed ? 1 : 0);
})().catch(async error => {
    console.error(error && (error.stack || error.message));
    console.error(serverLog.slice(-4000));
    if (fs.existsSync(OUT)) fs.writeFileSync(path.join(OUT, 'server.log'), serverLog);
    await stopServer(); if (raw) raw.close();
    process.exit(1);
});
