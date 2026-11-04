/**
 * P1-B — اختبارات توليد المسودات والاستثناءات وE-4/M5 وminimal-diff.
 * بيئة SQLite جديدة بالكامل داخل .test-tmp؛ لا قاعدة تشغيل ولا منح إنتاجية.
 * القيم والإثباتات هنا اصطناعية للاختبار فقط، وليست اعتمادًا تشغيليًا لـD4-C.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP_ROOT = path.join(ROOT, '.test-tmp', 'p1-b-' + Date.now());
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const PORT = 3111;
const BASE = 'http://127.0.0.1:' + PORT;
process.env.DB_PATH = TMP_DB;
process.env.DATA_DIR = TMP_DATA;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p1-b-isolated-test-secret';

let passed = 0, failed = 0;
const failures = [];
let server = null, serverLog = '';
function check(name, condition, extra) {
    if (condition) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function must(name, condition, extra) {
    check(name, condition, extra);
    if (!condition) throw new Error('فشل شرط أساسي: ' + name + (extra ? ' — ' + extra : ''));
}
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await response.json(); } catch (_) { }
    return { status: response.status, data };
}
async function waitReady(tries = 120) {
    for (let i = 0; i < tries; i++) {
        try { if ((await fetch(BASE + '/health')).ok) return true; } catch (_) { }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
}
async function stopServer() {
    if (!server || server.killed) return;
    const child = server; server = null;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
    });
}
function rowsHash(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function cellMap(run) {
    return new Map(run.entries.map(row => [`${row.employee_id}|${row.shift_date}`, row]));
}
function sameCells(a, b) {
    if (a.size !== b.size) return false;
    for (const [key, row] of a) {
        const other = b.get(key);
        if (!other || other.team_id !== row.team_id || other.shift_code !== row.shift_code) return false;
    }
    return true;
}
function immutableDenied(fn) {
    try { fn(); return false; } catch (error) { return /immutable/i.test(error.message); }
}
function exceptionBody(overrides) {
    return Object.assign({
        exception_type: 'temporary_change', start_date: '2026-03-09', end_date: '2026-03-09',
        effect_shift_code: 'D12', reason: 'استثناء اختبار موثق', approval_source: 'سند اصطناعي P1-B',
        approval_authority: 'جهة اختبار مخولة', approved_by: 'معتمد اختبار', approved_at: '2026-02-25T10:00:00Z',
        document_ref: 'TEST-ONLY'
    }, overrides);
}

(async () => {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const db = require('../db.js');
    const { ContinuityService, contentHash, daysOfMonth } = require('../services/schedule-engine/continuity-service.js');
    const { ScheduleGenerationService } = require('../services/schedule-engine/generation-service.js');
    const { validateAssignment } = require('../services/schedule-engine/validation-service.js');
    const { PERMISSIONS, ROLES_PERMISSIONS } = require('../config/permissions.js');

    console.log('🧪 العقود النقية والتهيئة الاصطناعية:');
    check('أطوال 28/29/30/31 يومًا', daysOfMonth('2026-02').length === 28 && daysOfMonth('2028-02').length === 29 &&
        daysOfMonth('2026-04').length === 30 && daysOfMonth('2026-01').length === 31);
    check('مفتاح الاستثناءات موجود بلا افتراضي دور', !!PERMISSIONS['schedule.exceptions.manage'] &&
        Object.entries(ROLES_PERMISSIONS).filter(([, keys]) => !keys.includes('*'))
            .every(([, keys]) => !keys.includes('schedule.exceptions.manage')));

    await db.init(false);
    const teams = await db.all('SELECT * FROM teams ORDER BY id');
    const team = teams[0], otherTeam = teams[1];
    const cycle = ['D12', 'D12', 'N12', 'N12', 'WO', 'WO', 'WO', 'WO'];
    await db.run("UPDATE shift_patterns SET cycle_json = ?, is_active = 1 WHERE code = 'A'", [JSON.stringify(cycle)]);
    const users = [
        { id: 'p1b-admin', role: 'admin', name: 'أدمن P1-B' },
        { id: 'p1b-director', role: 'director', name: 'مدير P1-B' },
        { id: 'p1b-sysadmin', role: 'sysadmin', name: 'مدير نظام P1-B' },
        { id: 'p1b-user', role: 'user', name: 'مستخدم P1-B' }
    ];
    for (const user of users) {
        // جدول users القديم يقبل ثلاثة أدوار فقط؛ sysadmin يبقى هوية JWT/ملف
        // المستخدمين كما في النظام، ولا نغيّر قيد الدور لأجل الاختبار.
        if (user.role === 'sysadmin') continue;
        await db.run('INSERT INTO users (user_id, username, password, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)',
            [user.id, user.id, 'not-used', user.name, user.role]);
    }
    for (const permission of ['schedule.view', 'schedule.exceptions.manage', 'schedule.approve', 'schedule.generate']) {
        await db.run('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)',
            ['p1b-director', permission, 'تهيئة اختبار معزول فقط']);
    }
    await db.run('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)',
        ['p1b-user', 'schedule.view', 'تهيئة اختبار معزول فقط']);
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users.map(user => ({
        id: user.id, username: user.id, password: 'not-used', name: user.name, role: user.role, isActive: true
    })), null, 2));

    const employeeIds = [];
    const febStartPhases = [4, 6, 0, 2]; // +28 يومًا ⇒ أطوار مارس 0/2/4/6.
    for (let i = 0; i < 4; i++) {
        const id = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES (?, ?, 'A')",
            [`P1B-E${i + 1}`, `موظف توليد ${i + 1}`])).id;
        employeeIds.push(id);
        await db.run('INSERT INTO team_assignments (employee_id, team_id, assigned_date, is_primary) VALUES (?, ?, ?, 1)',
            [id, team.id, '2026-01-01']);
        await Promise.all(daysOfMonth('2026-02').map((date, index) =>
            db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 2, 2026)',
                [id, team.id, date, cycle[(febStartPhases[i] + index) % cycle.length]])));
    }

    const syntheticDefault = { day: 1, night: 1, total: 99 }; // total متعمدًا غير قابل للتحقق: لا شرط ثالث.
    const syntheticOverrides = {};
    await db.AppSettings.set('schedule_engine.coverage_default', syntheticDefault);
    await db.AppSettings.set('schedule_engine.coverage_team_overrides', syntheticOverrides);
    const defaultHash = contentHash(syntheticDefault), overridesHash = contentHash(syntheticOverrides);
    for (const row of teams) {
        await db.run(`INSERT INTO schedule_coverage_approvals
            (id, team_id, applicability, coverage_default_hash, coverage_overrides_hash,
             source, approval_authority, approved_by, approved_at, effective_from, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
            [crypto.randomUUID(), row.id, row.id === team.id ? 'required' : 'not_applicable', defaultHash, overridesHash,
                'سند تغطية اصطناعي للاختبار فقط', 'جهة اختبار', 'معتمد اختبار', '2026-02-20T00:00:00Z',
                '2020-01-01', 'p1b-test-fixture']);
    }

    const continuity = new ContinuityService(db);
    const actor = { id: 'p1b-admin', role: 'admin', name: 'أدمن P1-B' };
    let reference = await continuity.importRoster({ month: '2026-02', sourceNote: 'مرجع اصطناعي P1-B', user: actor });
    await continuity.openDraft(reference.id, actor);
    reference = await continuity.derive(reference.id, actor);
    must('المرجع الاصطناعي مكتمل الاستمرارية', reference.status === 'ready_for_review', JSON.stringify(reference.readiness));
    reference = await continuity.approve(reference.id, reference.content_hash, actor);
    must('اللقطة المرجعية معتمدة للاختبار', reference.status === 'approved' && reference.current_snapshot.status === 'approved');

    const directService = new ScheduleGenerationService(db, { hasPermission: async () => true });
    let denied = false;
    try { await directService.generate({ targetMonth: '2026-03', user: { id: 'x', role: 'director' } }); }
    catch (error) { denied = error.status === 403 && error.code === 'PERMISSION_DENIED'; }
    check('الخدمة نفسها ترفض director قبل أي كتابة', denied && (await db.get('SELECT COUNT(*) AS n FROM schedule_generation_runs')).n === 0);
    denied = false;
    try { await directService.generate({ targetMonth: '2026-03', user: { id: 'x', role: 'sysadmin' } }); }
    catch (error) { denied = error.status === 403; }
    check('الخدمة نفسها ترفض sysadmin رغم النجمة', denied);
    const noPermission = new ScheduleGenerationService(db, { hasPermission: async () => false });
    denied = false;
    try { await noPermission.generate({ targetMonth: '2026-03', user: actor }); }
    catch (error) { denied = error.status === 403; }
    check('admin بلا schedule.generate فعلي مرفوض', denied && (await db.get('SELECT COUNT(*) AS n FROM schedule_generation_runs')).n === 0);
    await db.closeDb();

    let raw = new (require('better-sqlite3'))(TMP_DB);
    const baseline = {
        roster: rowsHash(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()),
        months: rowsHash(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()),
        permissions: rowsHash(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all())
    };

    console.log('\n🚀 تشغيل خادم P1-B المعزول:');
    server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test', JWT_SECRET: process.env.JWT_SECRET },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', data => { serverLog += data; });
    server.stderr.on('data', data => { serverLog += data; });
    must('الخادم يعمل', await waitReady(), serverLog.slice(-3000));
    const jwt = require('jsonwebtoken');
    const tokens = Object.fromEntries(users.map(user => [user.role,
        jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET)]));

    console.log('\n🔐 الحارس ومداخل التوليد:');
    let response = await api('/api/schedule/generation-runs', { method: 'POST', body: { target_month: '2026-03' } });
    check('التوليد بلا توكن 401', response.status === 401);
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens.director, body: { target_month: '2026-03' } });
    check('director مع منحة generate يُرفض 403', response.status === 403 && response.data.permission === 'schedule.generate');
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens.sysadmin, body: { target_month: '2026-03' } });
    check('sysadmin مع * يُرفض 403', response.status === 403);
    response = await api('/api/shift-schedule/generate', { method: 'POST', token: tokens.director, body: { year: 2026, month: 3 } });
    check('المسار القديم لا يتجاوز الحارس', response.status === 403 && response.data.permission === 'schedule.generate');
    check('كل الرفض بلا تشغيل مكتوب', raw.prepare('SELECT COUNT(*) AS n FROM schedule_generation_runs').get().n === 0);

    console.log('\n📅 التوليد المرجعي والتغطية وM5:');
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens.admin, body: { target_month: '2026-03', source_note: 'مسودة P1-B الأولى' } });
    must('admin ينشئ مسودة 201', response.status === 201 && response.data.run, JSON.stringify(response).slice(0, 3000));
    const initial = response.data.run;
    check('31 يومًا × 4 موظفين', initial.entries.length === 124 && initial.target_month === '2026-03');
    check('الطور مستمر من فبراير ولا يبدأ من الصفر', initial.reference_version_id === reference.id && initial.reference_snapshot_id === reference.current_snapshot.id &&
        initial.entries.find(row => row.employee_id === employeeIds[0] && row.shift_date === '2026-03-01').shift_code === 'D12' &&
        initial.entries.find(row => row.employee_id === employeeIds[1] && row.shift_date === '2026-03-01').shift_code === 'N12');
    check('تغطية day/night مكتملة بلا total ثالث', initial.status === 'ready_for_review' && initial.summary.shortages.length === 0 &&
        initial.summary.unresolved_teams.length === 0 && initial.summary.e4_blocker_count === 0, JSON.stringify(initial.summary.blockers).slice(0, 1500));
    check('لا M5 عند اكتمال التغطية', initial.summary.m5_assignments.length === 0);
    check('الفرق not_applicable لا تُحسب ناقصة', initial.summary.coverage.filter(row => row.team_id !== team.id).every(row => row.applicability === 'not_applicable' && row.met));
    check('بصمات الإدخال والإخراج والإصدار SHA-256', [initial.input_hash, initial.output_hash, initial.version.content_hash]
        .every(hash => /^[a-f0-9]{64}$/.test(hash)) && initial.output_hash === initial.version.content_hash);
    check('الإصدار generated_draft وليس معتمدًا', initial.version.version_kind === 'generated_draft' && initial.version.status === 'ready_for_review' && !initial.version.approved_at && !initial.version.published_at);
    check('كل خلية أولية لها فرق وسبب', initial.diffs.length === initial.entries.length && initial.diffs.every(row => row.change_type === 'added' && row.reason));

    response = await api('/api/schedule/generation-runs/' + initial.id, { token: tokens.user });
    check('قراءة التشغيل بـschedule.view', response.status === 200 && response.data.run.entries.length === 124);
    response = await api('/api/schedule/generation-runs?target_month=2026-03', { token: tokens.director });
    check('فهرس التشغيلات متاح للمخول بالقراءة', response.status === 200 && response.data.runs.some(row => row.id === initial.id));
    response = await api('/api/schedule/versions/' + initial.schedule_version_id + '/approve', {
        method: 'POST', token: tokens.director, body: { content_hash: initial.output_hash }
    });
    check('P1-A لا يعتمد generated_draft', response.status === 409 && response.data.code === 'VERSION_KIND_NOT_REFERENCE');

    console.log('\n🏖️ الإجازات والطور وminimal-diff:');
    const pendingLeaveId = raw.prepare("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason) VALUES (?, ?, ?, 'إجازة', 'pending', 'اختبار pending')")
        .run(employeeIds[0], '2026-03-10', '2026-03-12').lastInsertRowid;
    response = await api('/api/schedule/generation-runs/' + initial.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    must('إعادة التوليد مع pending تنجح', response.status === 201, JSON.stringify(response).slice(0, 2000));
    const pendingRun = response.data.run;
    check('pending لا يغير رموز الإجازة', [10, 11, 12].every(day => pendingRun.entries.find(row => row.employee_id === employeeIds[0] && row.shift_date === `2026-03-${String(day).padStart(2, '0')}`).source !== 'approved_leave'));
    raw.prepare("UPDATE leave_requests SET status = 'approved', approved_at = datetime('now') WHERE id = ?").run(pendingLeaveId);
    response = await api('/api/schedule/generation-runs/' + pendingRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    must('إعادة التوليد مع إجازة معتمدة تنجح', response.status === 201, JSON.stringify(response).slice(0, 2000));
    const leaveRun = response.data.run;
    const leaveCells = leaveRun.entries.filter(row => row.employee_id === employeeIds[0] && row.shift_date >= '2026-03-10' && row.shift_date <= '2026-03-12');
    check('الإجازة المعتمدة ترمز V وتوثق leave_id', leaveCells.length === 3 && leaveCells.every(row => row.shift_code === 'V' && row.source === 'approved_leave' && row.leave_id === pendingLeaveId));
    check('العودة بعد الإجازة على طور الدورة', leaveRun.entries.find(row => row.employee_id === employeeIds[0] && row.shift_date === '2026-03-13').shift_code === 'WO' &&
        leaveRun.entries.find(row => row.employee_id === employeeIds[0] && row.shift_date === '2026-03-17').shift_code === 'D12');
    check('M5 يحاول سد النقص بترتيب موثق', leaveRun.summary.m5_assignments.length > 0 && leaveRun.summary.m5_assignments.every(row => row.m5 && row.m5.rank_position > 0));
    check('أي نقص متبقٍ صريح ولا توزيع مخترع', leaveRun.status === 'ready_for_review' || leaveRun.summary.shortages.length > 0);
    const leaveMap = cellMap(leaveRun);
    check('غير المتأثر في إعادة الإجازة محفوظ حرفيًا', pendingRun.entries.filter(row => {
        const next = leaveMap.get(`${row.employee_id}|${row.shift_date}`);
        return next && next.affected === 0;
    }).every(row => {
        const next = leaveMap.get(`${row.employee_id}|${row.shift_date}`);
        return next.source === 'preserved' && next.shift_code === row.shift_code && next.team_id === row.team_id;
    }));

    response = await api('/api/schedule/exceptions', { method: 'POST', token: tokens.director, body: exceptionBody({ employee_id: employeeIds[3], effect_shift_code: null }) });
    check('الاستثناء الناقص 422', response.status === 422 && response.data.code === 'EXCEPTION_EFFECT_REQUIRED');
    response = await api('/api/schedule/exceptions', { method: 'POST', token: tokens.user, body: exceptionBody({ employee_id: employeeIds[3] }) });
    check('إدخال استثناء بلا manage مرفوض 403', response.status === 403);
    response = await api('/api/schedule/exceptions', { method: 'POST', token: tokens.director, body: exceptionBody({ employee_id: employeeIds[3] }) });
    must('إنشاء تغيير مؤقت موثق 201', response.status === 201, JSON.stringify(response));
    const changeException = response.data.exception;
    response = await api('/api/schedule/generation-runs/' + leaveRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    must('minimal-diff مع الاستثناء ينجح', response.status === 201, JSON.stringify(response).slice(0, 1800));
    const exceptionRun = response.data.run;
    const changedCell = exceptionRun.entries.find(row => row.employee_id === employeeIds[3] && row.shift_date === '2026-03-09');
    check('الاستثناء يؤثر في يومه فقط ويوثق مصدره', changedCell.shift_code === 'D12' && changedCell.source === 'documented_exception' && changedCell.exception_id === changeException.id);
    const exceptionMap = cellMap(exceptionRun), leaveCellsMap = cellMap(leaveRun);
    let preservedChecked = 0, preservedValid = true;
    for (const row of exceptionRun.entries.filter(item => item.affected === 0)) {
        const before = leaveCellsMap.get(`${row.employee_id}|${row.shift_date}`);
        preservedChecked++;
        if (!before || before.shift_code !== row.shift_code || before.team_id !== row.team_id || row.source !== 'preserved') preservedValid = false;
    }
    check('100% من الخلايا غير المتأثرة ثابتة', preservedChecked > 0 && preservedValid);
    check('كل تغيير في minimal-diff له سبب', exceptionRun.diffs.every(row => row.reason && row.reason.length > 0));
    check('التشغيل الأساسي لم يتغير', (await api('/api/schedule/generation-runs/' + leaveRun.id, { token: tokens.admin })).data.run.output_hash === leaveRun.output_hash);

    response = await api('/api/schedule/exceptions/' + changeException.id + '/cancel', {
        method: 'POST', token: tokens.director, body: { cancellation_reason: 'انتهاء الاستثناء الاختباري' }
    });
    check('إلغاء الاستثناء مدقق', response.status === 200 && response.data.exception.status === 'cancelled' && !!response.data.exception.cancellation_reason);
    response = await api('/api/schedule/generation-runs/' + exceptionRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const cancelledRun = response.data.run;
    check('إزالة الاستثناء تعيد الرمز وتظهر سبب التغيير', cancelledRun.entries.find(row => row.employee_id === employeeIds[3] && row.shift_date === '2026-03-09').shift_code === 'WO' &&
        cancelledRun.diffs.some(row => row.employee_id === employeeIds[3] && row.shift_date === '2026-03-09' && row.reason));

    response = await api('/api/schedule/exceptions', { method: 'POST', token: tokens.director, body: exceptionBody({
        employee_id: employeeIds[3], exception_type: 'temporary_assignment', effect_shift_code: null, effect_team_id: otherTeam.id
    }) });
    const assignmentException = response.data.exception;
    response = await api('/api/schedule/generation-runs/' + cancelledRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const assignmentRun = response.data.run;
    const assignedCell = assignmentRun.entries.find(row => row.employee_id === employeeIds[3] && row.shift_date === '2026-03-09');
    check('التكليف المؤقت يغير الفريق مع أهلية موثقة', assignedCell.team_id === otherTeam.id && assignedCell.source === 'documented_exception' &&
        !assignmentRun.summary.blockers.some(row => row.type === 'e4_violation' && row.employee_id === employeeIds[3] && row.date === '2026-03-09' && row.reasons.includes('EMPLOYEE_NO_ACTIVE_TEAM')));
    await api('/api/schedule/exceptions/' + assignmentException.id + '/cancel', { method: 'POST', token: tokens.director, body: { cancellation_reason: 'إنهاء اختبار التكليف' } });

    response = await api('/api/schedule/exceptions', { method: 'POST', token: tokens.director, body: exceptionBody({
        employee_id: employeeIds[3], exception_type: 'operational_note', effect_shift_code: null, reason: 'ملاحظة بلا أثر على الرمز'
    }) });
    const noteException = response.data.exception;
    response = await api('/api/schedule/generation-runs/' + assignmentRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const noteRun = response.data.run;
    check('الملاحظة التشغيلية محفوظة ولا تغير المناوبات', noteRun.version.content.operational_notes.some(row => row.id === noteException.id) &&
        noteRun.entries.find(row => row.employee_id === employeeIds[3] && row.shift_date === '2026-03-09').shift_code === 'WO');
    await api('/api/schedule/exceptions/' + noteException.id + '/cancel', { method: 'POST', token: tokens.director, body: { cancellation_reason: 'إنهاء الملاحظة' } });

    const conflict1 = (await api('/api/schedule/exceptions', { method: 'POST', token: tokens.director, body: exceptionBody({ employee_id: employeeIds[3] }) })).data.exception;
    const conflict2 = (await api('/api/schedule/exceptions', { method: 'POST', token: tokens.director, body: exceptionBody({ employee_id: employeeIds[3], effect_shift_code: 'N12' }) })).data.exception;
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    check('تداخل الاستثناءات blocker بلا أولوية خفية', response.status === 201 && response.data.run.status === 'draft' &&
        response.data.run.summary.blockers.some(row => row.type === 'exception_conflict' && row.exception_ids.includes(conflict1.id) && row.exception_ids.includes(conflict2.id)));
    await api('/api/schedule/exceptions/' + conflict1.id + '/cancel', { method: 'POST', token: tokens.director, body: { cancellation_reason: 'حسم التعارض' } });
    await api('/api/schedule/exceptions/' + conflict2.id + '/cancel', { method: 'POST', token: tokens.director, body: { cancellation_reason: 'حسم التعارض' } });

    const leaveConflict = (await api('/api/schedule/exceptions', { method: 'POST', token: tokens.director, body: exceptionBody({
        employee_id: employeeIds[0], start_date: '2026-03-10', end_date: '2026-03-10'
    }) })).data.exception;
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    check('استثناء العمل المتداخل مع إجازة معتمدة blocker', response.status === 201 && response.data.run.summary.blockers.some(row =>
        row.type === 'leave_exception_conflict' && row.leave_id === pendingLeaveId && row.exception_id === leaveConflict.id) &&
        response.data.run.entries.find(row => row.employee_id === employeeIds[0] && row.shift_date === '2026-03-10').shift_code === 'V');
    await api('/api/schedule/exceptions/' + leaveConflict.id + '/cancel', { method: 'POST', token: tokens.director, body: { cancellation_reason: 'حسم تداخل الإجازة' } });

    console.log('\n🛡️ E-4 وعدم التمكّن والتغطية غير المحسومة:');
    const unableDate = '2026-03-23';
    const unableId = raw.prepare("INSERT INTO unable_attend_requests (employee_id, month, off_date, reason, status, created_by) VALUES (?, '2026-03', ?, 'اختبار عدم تمكّن', 'approved', 1)")
        .run(employeeIds[1], unableDate).lastInsertRowid;
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    check('عدم التمكّن المحسوم يظهر كمانع E-4', response.status === 201 && response.data.run.summary.blockers.some(row =>
        row.type === 'e4_violation' && row.employee_id === employeeIds[1] && row.date === unableDate && row.reasons.includes('UNABLE_ATTEND_CONFLICT')));
    raw.prepare("UPDATE unable_attend_requests SET status = 'cancelled' WHERE id = ?").run(unableId);

    const candidateUnableIds = [];
    for (const employeeId of [employeeIds[2], employeeIds[3]]) {
        candidateUnableIds.push(raw.prepare("INSERT INTO unable_attend_requests (employee_id, month, off_date, reason, status, created_by) VALUES (?, '2026-03', '2026-03-10', 'رفض مرشح اصطناعي', 'approved', 1)")
            .run(employeeId).lastInsertRowid);
    }
    response = await api('/api/schedule/generation-runs/' + leaveRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const rejectedCandidatesRun = response.data.run;
    check('M5 يرفض المرشحين الذين يكسرون E-4 ولا يخفي النقص', rejectedCandidatesRun.summary.candidate_rejections.some(row =>
        row.employee_id === employeeIds[2] && row.reasons.includes('UNABLE_ATTEND_CONFLICT')) &&
        rejectedCandidatesRun.summary.candidate_rejections.some(row => row.employee_id === employeeIds[3] && row.reasons.includes('UNABLE_ATTEND_CONFLICT')) &&
        rejectedCandidatesRun.summary.shortages.some(row => row.team_id === team.id && row.date === '2026-03-10' && row.missing.includes('day')));
    raw.prepare("UPDATE unable_attend_requests SET status = 'cancelled' WHERE id IN (?, ?)").run(...candidateUnableIds);

    const coverageApproval = raw.prepare('SELECT * FROM schedule_coverage_approvals WHERE team_id = ?').get(team.id);
    raw.prepare("UPDATE schedule_coverage_approvals SET status = 'revoked' WHERE id = ?").run(coverageApproval.id);
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const unresolvedRun = response.data.run;
    check('غياب إثبات التغطية = unresolved وdraft', unresolvedRun.status === 'draft' && unresolvedRun.summary.unresolved_teams.some(row => row.team_id === team.id && row.reason === 'COVERAGE_APPROVAL_MISSING'));
    check('لا M5 للفريق unresolved ولا fallback إلى 2/2/8', unresolvedRun.summary.m5_assignments.every(row => row.team_id !== team.id) &&
        unresolvedRun.summary.coverage.filter(row => row.team_id === team.id).every(row => row.applicability === 'unresolved' && row.rule === null));
    raw.prepare("UPDATE schedule_coverage_approvals SET status = 'active' WHERE id = ?").run(coverageApproval.id);

    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_default'")
        .run(JSON.stringify({ day: 1, night: 1, total: 2 }));
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    check('تغير بصمة FSS يجعل الإثبات stale', response.status === 201 && response.data.run.summary.unresolved_teams.some(row => row.team_id === team.id && row.reason === 'COVERAGE_APPROVAL_STALE'));
    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_default'")
        .run(JSON.stringify(syntheticDefault));

    raw.prepare(`INSERT INTO schedule_coverage_approvals
        (id, team_id, applicability, coverage_default_hash, coverage_overrides_hash, source,
         approval_authority, approved_by, approved_at, effective_from, status, created_by)
        VALUES (?, ?, 'not_applicable', ?, ?, 'تعارض اصطناعي', 'جهة اختبار', 'معتمد اختبار', ?, '2020-01-01', 'active', 'fixture')`)
        .run(crypto.randomUUID(), team.id, defaultHash, overridesHash, '2026-02-21T00:00:00Z');
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    check('إثباتان متعارضان = COVERAGE_APPROVAL_CONFLICT', response.status === 201 && response.data.run.summary.unresolved_teams.some(row => row.team_id === team.id && row.reason === 'COVERAGE_APPROVAL_CONFLICT'));
    raw.prepare("DELETE FROM schedule_coverage_approvals WHERE team_id = ? AND source = 'تعارض اصطناعي'").run(team.id);

    const allLeaveIds = [];
    for (const employeeId of employeeIds) {
        allLeaveIds.push(raw.prepare("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason) VALUES (?, '2026-03-20', '2026-03-20', 'مرضية', 'approved', 'نقص اصطناعي شامل')").run(employeeId).lastInsertRowid);
    }
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const shortageRun = response.data.run;
    check('النقص الذي يتعذر سده يظهر صراحة', shortageRun.status === 'draft' && shortageRun.summary.shortages.some(row => row.team_id === team.id && row.date === '2026-03-20' && row.missing.includes('day') && row.missing.includes('night')));
    check('الإجازة المرضية تستخدم S والطور لا يتغير', shortageRun.entries.filter(row => row.shift_date === '2026-03-20').every(row => row.shift_code === 'S') &&
        shortageRun.entries.find(row => row.employee_id === employeeIds[0] && row.shift_date === '2026-03-21').shift_code === 'WO');
    raw.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id IN (" + allLeaveIds.map(() => '?').join(',') + ')').run(...allLeaveIds);

    console.log('\n🧩 فحوص E-4 على قارئ المسودة:');
    await db.init(false);
    const e4Base = { employeeId: employeeIds[0], date: '2026-03-10', shiftCode: 'D12', operation: 'change', teamId: team.id };
    const okCoverage = async () => ({
        coverage_before: { day: 1, night: 1, total: 2, rule: { day: 0, night: 0, total: 0 }, met: true, missing: [] },
        coverage_after: { day: 1, night: 1, total: 2, rule: { day: 0, night: 0, total: 0 }, met: true, missing: [] },
        wouldBreak: false, still_below_minimum: false
    });
    let e4 = await validateAssignment(db, { ...e4Base,
        assignmentLookup: async (id, date) => date === '2026-03-09' ? { shift_code: 'N12' } : null,
        membershipLookup: async () => ({ team_id: team.id, team_name: team.name }), coverageAssessor: okCoverage });
    check('قارئ المسودة يكشف الراحة دون الحد الأدنى', e4.reasons.includes('REST_BELOW_MINIMUM'));
    raw.prepare("INSERT INTO shift_codes (code, name, time_start, time_end, status) VALUES ('XOVER', 'تداخل اختباري', '23:00', '09:00', 'دوام')").run();
    e4 = await validateAssignment(db, { ...e4Base,
        assignmentLookup: async (id, date) => date === '2026-03-09' ? { shift_code: 'XOVER' } : null,
        membershipLookup: async () => ({ team_id: team.id, team_name: team.name }), coverageAssessor: okCoverage });
    check('قارئ المسودة يكشف التداخل الزمني', e4.reasons.includes('SHIFT_OVERLAP'));
    e4 = await validateAssignment(db, { ...e4Base, shiftCode: 'N12',
        assignmentLookup: async (id, date) => ['2026-03-07', '2026-03-08', '2026-03-09'].includes(date) ? { shift_code: 'N12' } : null,
        membershipLookup: async () => ({ team_id: team.id, team_name: team.name }), coverageAssessor: okCoverage });
    check('قارئ المسودة يكشف الليالي المتتالية', e4.reasons.includes('CONSECUTIVE_NIGHTS_EXCEEDED'));
    e4 = await validateAssignment(db, { ...e4Base, assignmentLookup: async () => null, membershipLookup: async () => null, coverageAssessor: okCoverage });
    check('غياب العضوية الحية يمنع الأهلية', e4.reasons.includes('EMPLOYEE_NO_ACTIVE_TEAM'));

    console.log('\n🧷 الحتمية والسجل وعدم الكتابة التشغيلية:');
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const deterministic1 = response.data.run;
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    const deterministic2 = response.data.run;
    check('نفس المدخلات والأساس = نفس الخلايا والترتيب', sameCells(cellMap(deterministic1), cellMap(deterministic2)) &&
        JSON.stringify(deterministic1.summary.m5_assignments) === JSON.stringify(deterministic2.summary.m5_assignments));
    check('سجل الإدخال يحفظ المرجع والإجازات والاستثناءات والسياسة', !!deterministic1.input.reference.content_hash && Array.isArray(deterministic1.input.leaves) &&
        Array.isArray(deterministic1.input.exceptions) && !!deterministic1.input.coverage_policy.coverage_default_hash && !!deterministic1.input.e4_config);

    const overrideDefault = { day: 9, night: 9, total: 99 };
    const overrideMap = { [String(team.id)]: { day: 1, night: 1, total: 0 } };
    const overrideDefaultHash = contentHash(overrideDefault), overrideMapHash = contentHash(overrideMap);
    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_default'").run(JSON.stringify(overrideDefault));
    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_team_overrides'").run(JSON.stringify(overrideMap));
    raw.prepare("UPDATE schedule_coverage_approvals SET coverage_default_hash = ?, coverage_overrides_hash = ? WHERE status = 'active'")
        .run(overrideDefaultHash, overrideMapHash);
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    check('team override يتقدم على default وtotal مشتق لا مستقل', response.status === 201 &&
        response.data.run.summary.coverage.filter(row => row.team_id === team.id).every(row =>
            row.rule.day === 1 && row.rule.night === 1 && row.rule.total === 2) &&
        response.data.run.input.coverage_policy.coverage_default.day === 9);
    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_default'").run(JSON.stringify(syntheticDefault));
    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_team_overrides'").run(JSON.stringify(syntheticOverrides));
    raw.prepare("UPDATE schedule_coverage_approvals SET coverage_default_hash = ?, coverage_overrides_hash = ? WHERE status = 'active'")
        .run(defaultHash, overridesHash);

    check('التدقيق لكل تشغيل ناجح', raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE type = 'schedule_generation' AND action IN ('schedule_generation_created','schedule_generation_regenerated')").get().n ===
        raw.prepare('SELECT COUNT(*) AS n FROM schedule_generation_runs').get().n);
    const runEntryId = raw.prepare('SELECT id FROM schedule_generation_entries WHERE run_id = ? LIMIT 1').get(initial.id).id;
    check('Trigger يمنع تعديل run', immutableDenied(() => raw.prepare('UPDATE schedule_generation_runs SET status = ? WHERE id = ?').run('draft', initial.id)));
    check('Trigger يمنع حذف entry', immutableDenied(() => raw.prepare('DELETE FROM schedule_generation_entries WHERE id = ?').run(runEntryId)));
    check('Trigger يمنع تعديل diff', immutableDenied(() => raw.prepare('UPDATE schedule_generation_diffs SET reason = ? WHERE run_id = ?').run('tamper', initial.id)));
    check('shift_roster لم يتغير', rowsHash(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()) === baseline.roster);
    check('schedule_months لم يتغير', rowsHash(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()) === baseline.months);
    check('user_permissions لم تتغير', rowsHash(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all()) === baseline.permissions);
    check('صفر generated_draft معتمد أو منشور', raw.prepare("SELECT COUNT(*) AS n FROM schedule_versions WHERE version_kind = 'generated_draft' AND status IN ('approved','published')").get().n === 0);

    console.log('\n⏱️ منع minimal-diff على مرجع stale:');
    // مرجع أحدث مشروع عبر P1-A؛ لا يعدّل المرجع السابق ولا أي مسودة مولدة.
    response = await api('/api/schedule/versions/import-roster', { method: 'POST', token: tokens.admin, body: { month: '2026-02', source_note: 'مرجع أحدث لاختبار stale' } });
    const newerId = response.data.version.id;
    await api('/api/schedule/versions/' + newerId + '/open-draft', { method: 'POST', token: tokens.admin, body: {} });
    response = await api('/api/schedule/versions/' + newerId + '/continuity/derive', { method: 'POST', token: tokens.admin, body: {} });
    response = await api('/api/schedule/versions/' + newerId + '/approve', { method: 'POST', token: tokens.admin, body: { content_hash: response.data.version.content_hash } });
    must('المرجع الأحدث معتمد كتهيئة اختبار', response.status === 200, JSON.stringify(response).slice(0, 1000));
    response = await api('/api/schedule/generation-runs/' + noteRun.id + '/regenerate', { method: 'POST', token: tokens.admin, body: {} });
    check('التشغيل القديم مرفوض STALE_REFERENCE', response.status === 409 && response.data.code === 'STALE_REFERENCE');

    raw.close(); raw = null;
    await stopServer();
    await db.closeDb();
    console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
    if (failures.length) console.log('الإخفاقات:\n- ' + failures.join('\n- '));
    if (failed) process.exitCode = 1;
})().catch(error => {
    console.error('❌ انهيار الاختبار:', error.stack || error.message);
    if (serverLog) console.error(serverLog.slice(-6000));
    failed++;
    process.exitCode = 1;
}).finally(async () => {
    await stopServer();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) { }
});
