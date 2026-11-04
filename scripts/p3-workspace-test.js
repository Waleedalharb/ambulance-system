/**
 * P3 — قبول مركز دورة الجدول ومصفوفة التغطية، بداية إلى نهاية.
 * كل البيانات والقيم والإثباتات والمجسات اصطناعية داخل .test-tmp فقط.
 * لا منح فعلية ولا كتابة في roster/schedule_months ولا اعتماد تشغيلي لـD4-C.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const TMP_ROOT = path.join(ROOT, '.test-tmp', 'p3-' + Date.now());
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const PORT = 3113, BASE = 'http://127.0.0.1:' + PORT;
process.env.DB_PATH = TMP_DB; process.env.DATA_DIR = TMP_DATA; process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p3-isolated-workspace-test-secret';
let passed = 0, failed = 0, server = null, serverLog = '', raw;
const failures = [];
function check(name, condition, extra) { if (condition) { passed++; console.log('  ✅ ' + name); } else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); } }
function must(name, condition, extra) { check(name, condition, extra); if (!condition) throw new Error('شرط أساسي: ' + name + (extra ? ' — ' + extra : '')); }
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await response.json(); } catch (_) {}
    return { status: response.status, data };
}
async function waitReady() { for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + '/health')).ok) return true; } catch (_) {} await new Promise(r => setTimeout(r, 250)); } return false; }
async function stopServer() { if (!server || server.killed) return; const child = server; server = null; await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); }); }
function hashRows(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function immutableDenied(fn) { try { fn(); return false; } catch (error) { return /immutable|invalid schedule version lifecycle/i.test(error.message); } }

(async () => {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const db = require('../db.js');
    const { ContinuityService, daysOfMonth, contentHash } = require('../services/schedule-engine/continuity-service.js');
    await db.init(false);
    const teams = await db.all('SELECT * FROM teams ORDER BY id'); const team = teams[0];
    await db.run('UPDATE teams SET is_active = 0 WHERE id <> ?', [team.id]);
    const cycle = ['D12', 'D12', 'N12', 'N12', 'WO', 'WO', 'WO', 'WO'];
    await db.run("UPDATE shift_patterns SET cycle_json = ?, is_active = 1 WHERE code = 'A'", [JSON.stringify(cycle)]);
    const users = [
        { id: 'p3-admin', role: 'admin', name: 'أدمن P3' },
        { id: 'p3-importer', role: 'director', name: 'مستورد P3' },
        { id: 'p3-reviewer', role: 'director', name: 'مراجع P3' },
        { id: 'p3-approver', role: 'director', name: 'معتمد P3' },
        { id: 'p3-publisher', role: 'director', name: 'ناشر P3' },
        { id: 'p3-corrector', role: 'director', name: 'مصحح P3' },
        { id: 'p3-settings', role: 'director', name: 'مدير إعدادات P3' },
        { id: 'p3-exceptions', role: 'director', name: 'استثناءات P3' },
        { id: 'p3-viewer', role: 'director', name: 'قارئ P3' },
        { id: 'p3-denied', role: 'director', name: 'بلا صلاحية P3' }
    ];
    const grants = {
        'p3-importer': ['schedule.view', 'schedule.import', 'schedule.draft.edit', 'schedule.gaps.review', 'schedule.approve'],
        'p3-reviewer': ['schedule.view', 'schedule.draft.edit'], 'p3-approver': ['schedule.view', 'schedule.approve'],
        'p3-publisher': ['schedule.view', 'schedule.publish'], 'p3-corrector': ['schedule.view', 'schedule.published.edit'],
        'p3-settings': ['schedule.view', 'schedule.settings.manage'], 'p3-exceptions': ['schedule.view', 'schedule.exceptions.manage'],
        'p3-viewer': ['schedule.view']
    };
    for (const user of users) {
        await db.run('INSERT INTO users (user_id, username, password, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)', [user.id, user.id, 'not-used', user.name, user.role]);
        for (const key of grants[user.id] || []) await db.run('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)', [user.id, key, 'مجس P3 اصطناعي فقط']);
    }
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users.map(user => ({ id: user.id, username: user.id, password: 'not-used', name: user.name, role: user.role, isActive: true })), null, 2));
    const employeeIds = [], phases = [4, 6, 0, 2];
    for (let i = 0; i < 4; i++) {
        const id = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES (?, ?, 'A')", [`P3-E${i + 1}`, `موظف P3 ${i + 1}`])).id;
        employeeIds.push(id);
        await db.run('INSERT INTO team_assignments (employee_id, team_id, assigned_date, is_primary) VALUES (?, ?, ?, 1)', [id, team.id, '2026-01-01']);
        await Promise.all(daysOfMonth('2026-02').map((date, index) => db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 2, 2026)', [id, team.id, date, cycle[(phases[i] + index) % cycle.length]])));
    }
    // قيمة تقنية اصطناعية لا يجوز استخدامها بديلًا؛ الفريق سيحصل على override رسمي اختباري مستقل.
    const syntheticDefault = { day: 90, night: 90, total: 999 };
    await db.AppSettings.set('schedule_engine.coverage_default', syntheticDefault);
    await db.AppSettings.set('schedule_engine.coverage_team_overrides', {});
    const continuity = new ContinuityService(db), adminActor = { id: 'p3-admin', role: 'admin', name: 'أدمن P3' };
    let reference = await continuity.importRoster({ month: '2026-02', sourceNote: 'مرجع P3 اصطناعي', user: adminActor });
    await continuity.openDraft(reference.id, adminActor); reference = await continuity.derive(reference.id, adminActor);
    reference = await continuity.approve(reference.id, reference.content_hash, adminActor);
    must('مرجع الاختبار معتمد', reference.status === 'approved'); await db.closeDb();

    raw = new (require('better-sqlite3'))(TMP_DB);
    const baseline = {
        roster: hashRows(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()),
        months: hashRows(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()),
        permissions: hashRows(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all())
    };
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
    must('خادم P3 المعزول يعمل', await waitReady(), serverLog.slice(-3000));
    const jwt = require('jsonwebtoken');
    const tokens = Object.fromEntries(users.map(user => [user.id, jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET)]));
    const evidence = { source: 'سند تغطية رسمي اصطناعي P3 فقط', approval_authority: 'جهة اختبار P3', approved_by: 'معتمد اختبار P3', approved_at: '2026-02-20T00:00:00Z', effective_from: '2020-01-01', effective_to: null, official_confirmation: true };
    async function matrixPayload(day = 1, night = 1) {
        const current = await api('/api/schedule/coverage-approvals?month=2026-03', { token: tokens['p3-viewer'] });
        return { ...evidence, rows: [{ team_id: team.id, applicability: 'required', day, night }], expected_default_hash: current.data.coverage_default_hash, expected_overrides_hash: current.data.coverage_overrides_hash };
    }
    async function review(id, expected = 200) { const r = await api(`/api/schedule/generated-versions/${id}/review`, { method: 'POST', token: tokens['p3-reviewer'], body: {} }); must(`مراجعة ${id.slice(0, 8)} تعيد ${expected}`, r.status === expected, JSON.stringify(r).slice(0, 1500)); return r; }
    async function approve(id, hash, expected = 200) { const r = await api(`/api/schedule/generated-versions/${id}/approve`, { method: 'POST', token: tokens['p3-approver'], body: { content_hash: hash } }); must(`اعتماد ${id.slice(0, 8)} يعيد ${expected}`, r.status === expected, JSON.stringify(r).slice(0, 1500)); return r; }
    async function publish(id, hash, expected = 200) { const r = await api(`/api/schedule/generated-versions/${id}/publish`, { method: 'POST', token: tokens['p3-publisher'], body: { content_hash: hash } }); must(`نشر ${id.slice(0, 8)} يعيد ${expected}`, r.status === expected, JSON.stringify(r).slice(0, 1500)); return r; }

    console.log('\n🔐 حدود القراءة والإدارة:');
    let response = await api('/api/schedule/workspace?month=2026-03');
    check('workspace بلا توكن 401', response.status === 401);
    response = await api('/api/schedule/workspace?month=2026-03', { token: tokens['p3-denied'] });
    check('workspace بلا schedule.view 403', response.status === 403 && response.data.permission === 'schedule.view');
    response = await api('/api/schedule/workspace?month=2026-03', { token: tokens['p3-viewer'] });
    must('workspace يعرض المرجع والمصفوفة والإصدارات', response.status === 200 && response.data.reference.usable && response.data.coverage.summary.unresolved === 1 && Array.isArray(response.data.versions), JSON.stringify(response).slice(0, 1500));
    check('لا توليد مسبق ولا إخفاء للحالة unresolved', response.data.current_version === null && response.data.coverage.teams.find(row => row.team_id === team.id).applicability === 'unresolved');
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-viewer'], body: await matrixPayload() });
    check('schedule.view لا يدير إثباتات التغطية', response.status === 403 && response.data.permission === 'schedule.settings.manage');
    check('الرفض لا يضيف إثباتًا', raw.prepare('SELECT COUNT(*) AS n FROM schedule_coverage_approvals').get().n === 0);

    console.log('\n📋 التحقق من المصفوفة والسند والبصمات:');
    let payload = await matrixPayload(); payload.official_confirmation = false;
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-settings'], body: payload });
    check('التأكيد الرسمي إلزامي', response.status === 422 && response.data.code === 'OFFICIAL_COVERAGE_CONFIRMATION_REQUIRED');
    payload = await matrixPayload(); payload.source = '';
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-settings'], body: payload });
    check('مصدر الاعتماد إلزامي', response.status === 422 && response.data.code === 'COVERAGE_EVIDENCE_REQUIRED');
    payload = await matrixPayload(); payload.effective_to = '2019-01-01';
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-settings'], body: payload });
    check('فترة السريان العكسية مرفوضة', response.status === 422 && response.data.code === 'INVALID_COVERAGE_EFFECTIVE_PERIOD');
    payload = await matrixPayload(); payload.rows = [];
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-settings'], body: payload });
    check('المصفوفة الناقصة مرفوضة', response.status === 422 && response.data.code === 'COVERAGE_MATRIX_INCOMPLETE');
    payload = await matrixPayload(); delete payload.rows[0].day;
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-settings'], body: payload });
    check('قيمة نهار الناقصة لا تُفترض', response.status === 422 && response.data.code === 'COVERAGE_VALUES_UNRESOLVED');
    payload = await matrixPayload(); payload.expected_overrides_hash = '0'.repeat(64);
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-settings'], body: payload });
    check('بصمة قديمة أو مضللة تمنع الحفظ', response.status === 409 && response.data.code === 'STALE_COVERAGE_SETTINGS');
    check('كل المدخلات المرفوضة ذرية بلا إثباتات', raw.prepare('SELECT COUNT(*) AS n FROM schedule_coverage_approvals').get().n === 0);
    payload = await matrixPayload();
    response = await api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p3-settings'], body: payload });
    must('حفظ المصفوفة الاصطناعية ينجح', response.status === 200 && response.data.summary.required === 1 && response.data.summary.unresolved === 0, JSON.stringify(response).slice(0, 1500));
    const override = raw.prepare('SELECT value FROM app_settings WHERE key = ?').get('schedule_engine.coverage_team_overrides');
    const overrideValue = JSON.parse(override.value)[String(team.id)];
    check('override صريح وtotal مشتق غير مخزن', overrideValue.day === 1 && overrideValue.night === 1 && overrideValue.total === undefined && response.data.teams[0].rule.total === 2);
    const proof = raw.prepare('SELECT * FROM schedule_coverage_approvals WHERE team_id = ?').get(team.id);
    check('الإثبات مربوط بالبصمتين والسند والسريان', proof.coverage_default_hash === payload.expected_default_hash && proof.coverage_overrides_hash === response.data.coverage_overrides_hash && proof.source === evidence.source && proof.effective_from === evidence.effective_from);
    check('التدقيق سجل عملية المصفوفة', raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_coverage_matrix_recorded'").get().n === 1);

    console.log('\n🧪 توليد ومراجعة واعتماد ونشر منطقي:');
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens['p3-reviewer'], body: { target_month: '2026-03' } });
    check('director لا يتجاوز حارس التوليد بصلاحية المراجعة', response.status === 403 && response.data.permission === 'schedule.generate');
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens['p3-admin'], body: { target_month: '2026-03', source_note: 'توليد P3 اصطناعي' } });
    must('التوليد الأولي 201', response.status === 201, JSON.stringify(response).slice(0, 1600));
    const initial = response.data.run;
    must('المسودة جاهزة بلا موانع', initial.status === 'ready_for_review' && initial.summary.blocker_count === 0, JSON.stringify(initial.summary.blockers).slice(0, 1800));
    check('لا fallback للقيمة التقنية 90/90', initial.summary.coverage.every(row => row.rule.day === 1 && row.rule.night === 1 && row.rule.total === 2));
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/approve`, { method: 'POST', token: tokens['p3-approver'], body: { content_hash: initial.output_hash } });
    check('الاعتماد قبل المراجعة ممنوع', response.status === 409 && response.data.code === 'REVIEW_REQUIRED');
    let lifecycle = await review(initial.schedule_version_id);
    check('المراجعة تعرض التغطية والتعارضات وE-4', lifecycle.data.latest_review.coverage.length > 0 && Array.isArray(lifecycle.data.latest_review.conflicts) && Array.isArray(lifecycle.data.latest_review.e4));
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/publish`, { method: 'POST', token: tokens['p3-publisher'], body: { content_hash: initial.output_hash } });
    check('النشر قبل الاعتماد ممنوع', response.status === 409);
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/publish`, { method: 'POST', token: tokens['p3-approver'], body: { content_hash: initial.output_hash } });
    check('approve لا يرث publish', response.status === 403 && response.data.permission === 'schedule.publish');
    await approve(initial.schedule_version_id, initial.output_hash);
    lifecycle = await publish(initial.schedule_version_id, initial.output_hash);
    check('النشر منطقي فقط', lifecycle.data.version.status === 'published' && lifecycle.data.publication_scope === 'logical_version_status_only_no_roster_write');

    console.log('\n👤 تفاصيل الموظف والإصدارات والتدقيق:');
    response = await api(`/api/schedule/versions/${initial.schedule_version_id}/employee/${employeeIds[0]}`, { token: tokens['p3-viewer'] });
    must('تفاصيل الموظف مكتملة', response.status === 200 && response.data.days.length === 31 && response.data.employee.id === employeeIds[0] && Array.isArray(response.data.leaves) && Array.isArray(response.data.diffs));
    response = await api('/api/schedule/workspace?month=2026-03', { token: tokens['p3-viewer'] });
    check('لوحة الشهر تعرض النسخة الحالية وآخر توليد', response.data.current_version.id === initial.schedule_version_id && response.data.latest_run.id === initial.id);
    response = await api('/api/schedule/audit-log?month=2026-03&limit=500', { token: tokens['p3-viewer'] });
    check('سجل التدقيق متاح بصلاحية القراءة', response.status === 200 && response.data.audit.some(row => row.action === 'schedule_generation_created') && response.data.audit.some(row => row.action === 'schedule_draft_published'));

    console.log('\n🧬 التصحيح وإعادة التوليد والمقارنة الموثقة:');
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/corrections`, { method: 'POST', token: tokens['p3-corrector'], body: { reason: 'تصحيح P3 بعد إجازة اصطناعية' } });
    must('إنشاء التصحيح 201', response.status === 201, JSON.stringify(response).slice(0, 1600));
    const correction = response.data;
    check('سلسلة الأب والبصمة ظاهرة', correction.version.parent_version_id === initial.schedule_version_id && correction.version.content_hash !== initial.output_hash);
    const leaveId = raw.prepare("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason) VALUES (?, '2026-03-10', '2026-03-10', 'إجازة', 'approved', 'إجازة P3 اصطناعية')").run(employeeIds[0]).lastInsertRowid;
    response = await api(`/api/schedule/generation-runs/${correction.run.id}/regenerate`, { method: 'POST', token: tokens['p3-admin'], body: { source_note: 'إعادة توليد تصحيح P3' } });
    must('إعادة توليد التصحيح 201', response.status === 201, JSON.stringify(response).slice(0, 1600));
    const regenerated = response.data.run;
    check('minimal-diff يحفظ غير المتأثر ويسجل السبب', regenerated.mode === 'minimal_diff' && regenerated.diffs.some(row => row.employee_id === employeeIds[0] && row.shift_date === '2026-03-10' && row.reason) && regenerated.entries.filter(row => !row.affected).every(row => row.source === 'preserved'));
    response = await api(`/api/schedule/version-comparison?base_id=${initial.schedule_version_id}&target_id=${regenerated.schedule_version_id}`, { token: tokens['p3-viewer'] });
    must('مقارنة الإصدارين ناجحة', response.status === 200 && response.data.changes.some(row => row.employee_id === employeeIds[0] && row.date === '2026-03-10' && row.reason_source === 'schedule_generation_diffs'), JSON.stringify(response).slice(0, 1500));
    check('المقارنة تعرض الموظف المتأثر وسبب التغيير', response.data.employees.some(row => row.id === employeeIds[0]) && response.data.changes.every(row => row.reason !== undefined));
    response = await api(`/api/schedule/versions/${regenerated.schedule_version_id}/employee/${employeeIds[0]}`, { token: tokens['p3-viewer'] });
    check('تفاصيل الموظف تعرض الإجازة والفرق', response.data.leaves.some(row => row.id === Number(leaveId)) && response.data.diffs.length > 0);
    await review(regenerated.schedule_version_id); await approve(regenerated.schedule_version_id, regenerated.output_hash);
    response = await publish(regenerated.schedule_version_id, regenerated.output_hash);
    check('التصحيح أكمل الاعتماد والنشر المنطقي', response.data.version.status === 'published' && response.data.version.version_kind === 'correction');
    check('الأصل المنشور ثابت', raw.prepare('SELECT content_hash, status FROM schedule_versions WHERE id = ?').get(initial.schedule_version_id).content_hash === initial.output_hash && raw.prepare('SELECT status FROM schedule_versions WHERE id = ?').get(initial.schedule_version_id).status === 'published');
    check('منع تعديل وحذف المنشور ماديًا', immutableDenied(() => raw.prepare('UPDATE schedule_versions SET content_json = ? WHERE id = ?').run('{}', initial.schedule_version_id)) && immutableDenied(() => raw.prepare('DELETE FROM schedule_versions WHERE id = ?').run(regenerated.schedule_version_id)));

    console.log('\n🚫 unresolved والقدم والتعارض:');
    // تشغيل إضافي بعد جعل الإثبات stale: لا قيمة بديلة ولا جاهزية.
    raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(JSON.stringify({}), 'schedule_engine.coverage_team_overrides');
    response = await api('/api/schedule/coverage-approvals?month=2026-03', { token: tokens['p3-viewer'] });
    check('تغير البصمة يكشف stale', response.data.teams[0].applicability === 'unresolved' && response.data.teams[0].unresolved_reason === 'COVERAGE_APPROVAL_STALE');
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens['p3-admin'], body: { target_month: '2026-03', source_note: 'إثبات unresolved في P3' } });
    must('التوليد مع stale يُنشئ مسودة غير جاهزة', response.status === 201 && response.data.run.status === 'draft' && response.data.run.summary.unresolved_teams.length === 1);
    const unresolvedRun = response.data.run;
    response = await review(unresolvedRun.schedule_version_id);
    check('المراجعة تمنع الجاهزية مع unresolved', response.data.version.status === 'draft' && !response.data.latest_review.ready && response.data.latest_review.unresolved_teams.length === 1);
    response = await approve(unresolvedRun.schedule_version_id, unresolvedRun.output_hash, 409);
    check('اعتماد unresolved ممنوع', response.data.code === 'VERSION_NOT_READY' || response.data.code === 'REVIEW_NOT_READY' || response.data.code === 'UNRESOLVED_BLOCKERS');
    // صفّا تعارض اصطناعيان بنفس البصمتين، لاختبار resolution دون مسار revoke.
    const contextDefault = contentHash(syntheticDefault), contextOverrides = contentHash({});
    const conflictInsert = raw.prepare(`INSERT INTO schedule_coverage_approvals (id, team_id, applicability, coverage_default_hash, coverage_overrides_hash, source, approval_authority, approved_by, approved_at, effective_from, status, created_by) VALUES (?, ?, ?, ?, ?, 'سند تعارض اصطناعي', 'اختبار', 'اختبار', '2026-01-01', '2020-01-01', 'active', 'p3-fixture')`);
    conflictInsert.run(crypto.randomUUID(), team.id, 'required', contextDefault, contextOverrides);
    conflictInsert.run(crypto.randomUUID(), team.id, 'not_applicable', contextDefault, contextOverrides);
    response = await api('/api/schedule/coverage-approvals?month=2026-03', { token: tokens['p3-viewer'] });
    check('تعارض الإثباتات المتطابقة البصمة يصبح unresolved', response.data.teams[0].applicability === 'unresolved' && response.data.teams[0].unresolved_reason === 'COVERAGE_APPROVAL_CONFLICT');

    console.log('\n🖥️ عقد الواجهة الساكن وسلامة JavaScript:');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'schedule-workspace.html'), 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    check('معرّفات DOM غير مكررة', new Set(ids).size === ids.length);
    ['panel-overview', 'panel-reference', 'panel-versions', 'panel-review', 'panel-employees', 'panel-exceptions', 'panel-coverage', 'panel-audit', 'generateDraft', 'reviewDraft', 'approveDraft', 'publishDraft', 'createCorrection', 'coverageForm'].forEach(id => check(`عنصر ${id} موجود`, ids.includes(id)));
    check('الواجهة RTL ومتجاوبة وتحمّل CSS الهوية', html.includes('dir="rtl"') && html.includes('name="viewport"') && html.includes('schedule-workspace.css'));
    check('الواجهة لا تستخدم localStorage للبيانات التشغيلية', !fs.readFileSync(path.join(ROOT, 'public', 'js', 'schedule-workspace.js'), 'utf8').includes('localStorage'));
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'public', 'js', 'schedule-workspace.js')]); check('JavaScript سليم نحويًا', true);
    response = await fetch(BASE + '/schedule-workspace.html'); check('الصفحة تُخدم من التطبيق', response.status === 200 && (await response.text()).includes('مركز إدارة دورة الجدول'));
    check('الجدول القديم يحتوي رابط المركز', fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8').includes("schedule-workspace.html"));

    console.log('\n🧊 ثبات البيانات الرسمية والصلاحيات:');
    check('shift_roster لم يتغير إطلاقًا', hashRows(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()) === baseline.roster);
    check('schedule_months لم يتغير إطلاقًا', hashRows(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()) === baseline.months);
    check('user_permissions لم يتغير إطلاقًا', hashRows(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all()) === baseline.permissions);
    raw.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?").run(leaveId);
    console.log(`\n════════════════════════════════\nالنتيجة: ${passed} ✅ / ${failed} ❌`);
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(name => console.log('  ❌ ' + name)); }
    await stopServer(); raw.close(); raw = null;
    process.exit(failed ? 1 : 0);
})().catch(async error => {
    console.error('فشل عام:', error && (error.stack || error.message)); console.error(serverLog.slice(-5000));
    await stopServer(); if (raw) raw.close(); process.exit(1);
});
