/**
 * P2 — اختبارات دورة مراجعة/اعتماد/نشر/تصحيح مسودات التوليد.
 * SQLite اصطناعية كاملة داخل .test-tmp؛ لا إنتاج ولا منح فعلية ولا roster رسمي.
 * قيم التغطية والإثباتات اصطناعية للاختبار فقط وليست اعتمادًا لـD4-C.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP_ROOT = path.join(ROOT, '.test-tmp', 'p2-' + Date.now());
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const PORT = 3112;
const BASE = 'http://127.0.0.1:' + PORT;
process.env.DB_PATH = TMP_DB;
process.env.DATA_DIR = TMP_DATA;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p2-isolated-lifecycle-test-secret';

let passed = 0, failed = 0, server = null, serverLog = '';
const failures = [];
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
function immutableDenied(fn) {
    try { fn(); return false; } catch (error) { return /immutable|invalid schedule version lifecycle/i.test(error.message); }
}
function sameCells(a, b) {
    if (a.length !== b.length) return false;
    const shape = rows => rows.map(row => `${row.employee_id}|${row.shift_date}|${row.team_id}|${row.shift_code}`).sort();
    return JSON.stringify(shape(a)) === JSON.stringify(shape(b));
}

(async () => {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const db = require('../db.js');
    const { ContinuityService, contentHash, daysOfMonth } = require('../services/schedule-engine/continuity-service.js');
    const { PERMISSIONS, ROLES_PERMISSIONS } = require('../config/permissions.js');

    console.log('🧪 التهيئة الاصطناعية وكتالوج D5:');
    check('مفاتيح publish وpublished.edit موجودة', !!PERMISSIONS['schedule.publish'] && !!PERMISSIONS['schedule.published.edit']);
    check('لا افتراضيات جديدة لأي دور غير النجمة', Object.entries(ROLES_PERMISSIONS).filter(([, keys]) => !keys.includes('*'))
        .every(([, keys]) => !keys.includes('schedule.publish') && !keys.includes('schedule.published.edit')));

    await db.init(false);
    const teams = await db.all('SELECT * FROM teams ORDER BY id');
    const team = teams[0];
    await db.run('UPDATE teams SET is_active = 0 WHERE id <> ?', [team.id]);
    const cycle = ['D12', 'D12', 'N12', 'N12', 'WO', 'WO', 'WO', 'WO'];
    await db.run("UPDATE shift_patterns SET cycle_json = ?, is_active = 1 WHERE code = 'A'", [JSON.stringify(cycle)]);
    const users = [
        { id: 'p2-admin', role: 'admin', name: 'أدمن P2' },
        { id: 'p2-reviewer', role: 'director', name: 'مراجع P2' },
        { id: 'p2-approver', role: 'director', name: 'معتمد P2' },
        { id: 'p2-publisher', role: 'director', name: 'ناشر P2' },
        { id: 'p2-corrector', role: 'director', name: 'مصحح P2' },
        { id: 'p2-viewer', role: 'director', name: 'قارئ P2' },
        { id: 'p2-denied', role: 'director', name: 'بلا صلاحية P2' }
    ];
    const grants = {
        'p2-reviewer': ['schedule.view', 'schedule.draft.edit'],
        'p2-approver': ['schedule.view', 'schedule.approve'],
        'p2-publisher': ['schedule.view', 'schedule.publish'],
        'p2-corrector': ['schedule.view', 'schedule.published.edit'],
        'p2-viewer': ['schedule.view']
    };
    for (const user of users) {
        await db.run('INSERT INTO users (user_id, username, password, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)',
            [user.id, user.id, 'not-used', user.name, user.role]);
        for (const permission of grants[user.id] || []) {
            await db.run('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)',
                [user.id, permission, 'مجس اختبار P2 المعزول فقط']);
        }
    }
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users.map(user => ({
        id: user.id, username: user.id, password: 'not-used', name: user.name, role: user.role, isActive: true
    })), null, 2));

    const employeeIds = [];
    const febStartPhases = [4, 6, 0, 2];
    for (let i = 0; i < 4; i++) {
        const id = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES (?, ?, 'A')",
            [`P2-E${i + 1}`, `موظف P2 ${i + 1}`])).id;
        employeeIds.push(id);
        await db.run('INSERT INTO team_assignments (employee_id, team_id, assigned_date, is_primary) VALUES (?, ?, ?, 1)',
            [id, team.id, '2026-01-01']);
        await Promise.all(daysOfMonth('2026-02').map((date, index) =>
            db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 2, 2026)',
                [id, team.id, date, cycle[(febStartPhases[i] + index) % cycle.length]])));
    }

    const syntheticDefault = { day: 1, night: 1, total: 99 };
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
                'سند تغطية اصطناعي P2 فقط', 'جهة اختبار', 'معتمد اختبار', '2026-02-20T00:00:00Z',
                '2020-01-01', 'p2-test-fixture']);
    }
    const continuity = new ContinuityService(db);
    const adminActor = { id: 'p2-admin', role: 'admin', name: 'أدمن P2' };
    let reference = await continuity.importRoster({ month: '2026-02', sourceNote: 'مرجع P2 اصطناعي', user: adminActor });
    await continuity.openDraft(reference.id, adminActor);
    reference = await continuity.derive(reference.id, adminActor);
    reference = await continuity.approve(reference.id, reference.content_hash, adminActor);
    must('المرجع الاصطناعي معتمد', reference.status === 'approved');
    await db.closeDb();

    let raw = new (require('better-sqlite3'))(TMP_DB);
    const baseline = {
        roster: rowsHash(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()),
        months: rowsHash(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()),
        permissions: rowsHash(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all())
    };

    server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test', JWT_SECRET: process.env.JWT_SECRET },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', data => { serverLog += data; });
    server.stderr.on('data', data => { serverLog += data; });
    must('خادم P2 المعزول يعمل', await waitReady(), serverLog.slice(-3000));
    const jwt = require('jsonwebtoken');
    const tokens = Object.fromEntries(users.map(user => [user.id,
        jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET)]));

    async function generate() {
        const response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens['p2-admin'], body: { target_month: '2026-03', source_note: 'مسودة P2 اصطناعية' } });
        must('إنشاء مسودة توليد 201', response.status === 201, JSON.stringify(response).slice(0, 1600));
        return response.data.run;
    }
    async function review(versionId, expectedStatus = 200) {
        const response = await api(`/api/schedule/generated-versions/${versionId}/review`, { method: 'POST', token: tokens['p2-reviewer'], body: {} });
        must('طلب المراجعة يعيد ' + expectedStatus, response.status === expectedStatus, JSON.stringify(response).slice(0, 1800));
        return response.data;
    }
    async function approve(versionId, hash, expectedStatus = 200) {
        const response = await api(`/api/schedule/generated-versions/${versionId}/approve`, { method: 'POST', token: tokens['p2-approver'], body: { content_hash: hash } });
        must('طلب الاعتماد يعيد ' + expectedStatus, response.status === expectedStatus, JSON.stringify(response).slice(0, 1800));
        return response;
    }
    async function publish(versionId, hash, expectedStatus = 200) {
        const response = await api(`/api/schedule/generated-versions/${versionId}/publish`, { method: 'POST', token: tokens['p2-publisher'], body: { content_hash: hash } });
        must('طلب النشر يعيد ' + expectedStatus, response.status === expectedStatus, JSON.stringify(response).slice(0, 1800));
        return response;
    }
    async function correction(versionId, reason = 'تصحيح اختباري موثق') {
        const response = await api(`/api/schedule/generated-versions/${versionId}/corrections`, { method: 'POST', token: tokens['p2-corrector'], body: { reason } });
        must('إنشاء تصحيح 201', response.status === 201, JSON.stringify(response).slice(0, 1800));
        return response.data;
    }

    console.log('\n🔐 الصلاحيات والمراجعة الناجحة:');
    const initial = await generate();
    must('المسودة الأولية جاهزة', initial.status === 'ready_for_review' && initial.summary.blocker_count === 0,
        JSON.stringify(initial.summary.blockers).slice(0, 1500));
    check('بصمة E-4 أصبحت رقمية موثقة', initial.input.e4_config.min_rest_hours === 8 && initial.input.e4_config.max_consecutive_nights === 3);
    let response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/lifecycle`);
    check('قراءة lifecycle بلا توكن 401', response.status === 401);
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/lifecycle`, { token: tokens['p2-viewer'] });
    check('schedule.view يقرأ lifecycle', response.status === 200 && response.data.run.entries.length === 124);
    const reviewsBeforeDenied = raw.prepare('SELECT COUNT(*) AS n FROM schedule_lifecycle_reviews').get().n;
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/review`, { method: 'POST', token: tokens['p2-approver'], body: {} });
    check('approve لا يرث draft.edit', response.status === 403 && response.data.permission === 'schedule.draft.edit');
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/review`, { method: 'POST', body: {} });
    check('المراجعة بلا توكن 401', response.status === 401);
    check('الرفض لا ينشئ مراجعة', raw.prepare('SELECT COUNT(*) AS n FROM schedule_lifecycle_reviews').get().n === reviewsBeforeDenied);

    let lifecycle = await review(initial.schedule_version_id);
    must('المراجعة الناجحة تثبت ready', lifecycle.version.status === 'ready_for_review' && lifecycle.latest_review.ready,
        JSON.stringify(lifecycle.latest_review && lifecycle.latest_review.blockers).slice(0, 2000));
    check('المراجعة مربوطة بالمحتوى والمدخلات الحالية', lifecycle.latest_review.content_hash === initial.output_hash &&
        lifecycle.latest_review.input_hash === initial.input_hash && lifecycle.latest_review.current_input_hash === initial.input_hash);
    check('التغطية والنواقص والتعارضات معروضة', lifecycle.latest_review.coverage.length > 0 &&
        Array.isArray(lifecycle.latest_review.shortages) && Array.isArray(lifecycle.latest_review.conflicts) && Array.isArray(lifecycle.latest_review.e4));
    check('لا موانع أو unresolved في النسخة السليمة', lifecycle.latest_review.blockers.length === 0 && lifecycle.latest_review.unresolved_teams.length === 0);

    console.log('\n✅ الاعتماد والنشر وفصل الصلاحيات:');
    response = await approve(initial.schedule_version_id, null, 422);
    check('البصمة مطلوبة للاعتماد', response.data.code === 'CONTENT_HASH_REQUIRED');
    response = await approve(initial.schedule_version_id, '0'.repeat(64), 409);
    check('بصمة مختلفة مرفوضة', response.data.code === 'CONTENT_HASH_MISMATCH');
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/approve`, { method: 'POST', token: tokens['p2-publisher'], body: { content_hash: initial.output_hash } });
    check('publish لا يرث approve', response.status === 403 && response.data.permission === 'schedule.approve');
    response = await approve(initial.schedule_version_id, initial.output_hash);
    check('الاعتماد يحفظ الهوية والبصمة', response.data.version.status === 'approved' && response.data.version.approved_by === 'p2-approver' &&
        response.data.version.content_hash === initial.output_hash);
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/publish`, { method: 'POST', token: tokens['p2-approver'], body: { content_hash: initial.output_hash } });
    check('approve لا يرث publish', response.status === 403 && response.data.permission === 'schedule.publish');
    response = await publish(initial.schedule_version_id, initial.output_hash);
    check('النشر المنطقي مستقل وموثق', response.data.version.status === 'published' && response.data.version.published_by === 'p2-publisher' &&
        response.data.publication_scope === 'logical_version_status_only_no_roster_write');
    response = await review(initial.schedule_version_id, 409);
    check('المنشور لا يعاد فتحه للمراجعة', response.code === 'VERSION_IMMUTABLE');

    console.log('\n🧬 التصحيح وسلسلة النسخ ومنع نشر الأقدم:');
    const originalRow = raw.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(initial.schedule_version_id);
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/corrections`, { method: 'POST', token: tokens['p2-approver'], body: { reason: 'محاولة بلا صلاحية' } });
    check('approve لا يرث published.edit', response.status === 403 && response.data.permission === 'schedule.published.edit');
    response = await api(`/api/schedule/generated-versions/${initial.schedule_version_id}/corrections`, { method: 'POST', token: tokens['p2-corrector'], body: { reason: '' } });
    check('سبب التصحيح إلزامي', response.status === 422 && response.data.code === 'CORRECTION_REASON_REQUIRED');
    const c1 = await correction(initial.schedule_version_id, 'تصحيح أول موثق');
    check('التصحيح إصدار correction جديد', c1.version.version_kind === 'correction' && c1.version.status === 'draft' &&
        c1.version.parent_version_id === initial.schedule_version_id && c1.version.id !== initial.schedule_version_id);
    check('التصحيح يحفظ الخلايا ويصفّر الفروقات', sameCells(c1.run.entries, initial.entries) && c1.run.diffs.length === 0 &&
        c1.run.entries.every(row => row.affected === 0));
    check('سبب التصحيح داخل المحتوى والبصمة الجديدة', c1.version.content.correction.reason === 'تصحيح أول موثق' &&
        c1.version.content_hash !== initial.output_hash);
    let c1Lifecycle = await review(c1.version.id);
    await approve(c1.version.id, c1.version.content_hash);
    c1Lifecycle = await publish(c1.version.id, c1.version.content_hash);
    check('التصحيح يمر باعتماد ونشر مستقلين', c1Lifecycle.data.version.status === 'published');
    check('الأصل المنشور لم يتغير', rowsHash([raw.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(initial.schedule_version_id)]) === rowsHash([originalRow]));

    const c2 = await correction(initial.schedule_version_id, 'تصحيح ثانٍ يبقى معتمدًا');
    await review(c2.version.id);
    await approve(c2.version.id, c2.version.content_hash);
    const c3 = await correction(c2.version.id, 'تصحيح ثالث أحدث');
    await review(c3.version.id);
    await approve(c3.version.id, c3.version.content_hash);
    await publish(c3.version.id, c3.version.content_hash);
    response = await publish(c2.version.id, c2.version.content_hash, 409);
    check('منع نشر إصدار أقدم من المنشور الأحدث', response.data.code === 'STALE_PUBLICATION_LINEAGE');

    console.log('\n🛡️ الحماية المادية للمحتوى والحالة والمراجعات:');
    check('منع approved/published → draft', immutableDenied(() => raw.prepare("UPDATE schedule_versions SET status = 'draft' WHERE id = ?").run(c2.version.id)) &&
        immutableDenied(() => raw.prepare("UPDATE schedule_versions SET status = 'draft' WHERE id = ?").run(initial.schedule_version_id)));
    check('منع تعديل محتوى منشور', immutableDenied(() => raw.prepare('UPDATE schedule_versions SET content_json = ? WHERE id = ?').run('{}', initial.schedule_version_id)));
    check('منع حذف معتمد أو منشور', immutableDenied(() => raw.prepare('DELETE FROM schedule_versions WHERE id = ?').run(c2.version.id)) &&
        immutableDenied(() => raw.prepare('DELETE FROM schedule_versions WHERE id = ?').run(initial.schedule_version_id)));
    check('منع تعديل وحذف دليل المراجعة', immutableDenied(() => raw.prepare('UPDATE schedule_lifecycle_reviews SET ready = 0 WHERE version_id = ?').run(initial.schedule_version_id)) &&
        immutableDenied(() => raw.prepare('DELETE FROM schedule_lifecycle_reviews WHERE version_id = ?').run(initial.schedule_version_id)));
    check('سجلات التوليد الأصلية ما زالت immutable', immutableDenied(() => raw.prepare('UPDATE schedule_generation_entries SET shift_code = ? WHERE run_id = ?').run('N12', initial.id)));

    console.log('\n🔄 إعادة توليد تصحيح دون تعديل الأصل:');
    const c4 = await correction(c3.version.id, 'تصحيح قابل لإعادة التوليد');
    const correctionLeaveId = raw.prepare("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason) VALUES (?, '2026-03-10', '2026-03-10', 'إجازة', 'approved', 'تغيير تصحيح اصطناعي')")
        .run(employeeIds[0]).lastInsertRowid;
    response = await api(`/api/schedule/generation-runs/${c4.run.id}/regenerate`, { method: 'POST', token: tokens['p2-admin'], body: { source_note: 'إعادة توليد تصحيح P2' } });
    must('إعادة توليد correction تنجح', response.status === 201, JSON.stringify(response).slice(0, 1800));
    const c4Regenerated = response.data.run;
    check('إعادة التوليد تحافظ على نوع وسبب التصحيح', c4Regenerated.version.version_kind === 'correction' &&
        c4Regenerated.version.content.correction.reason === 'تصحيح قابل لإعادة التوليد');
    check('التغيير موثق بسبب والمناوبات غير المتأثرة محفوظة', c4Regenerated.diffs.some(row => row.employee_id === employeeIds[0] && row.shift_date === '2026-03-10' && row.reason) &&
        c4Regenerated.entries.filter(row => row.affected === 0).every(row => row.source === 'preserved'));
    check('الإصدار المنشور الأصلي بقي ثابتًا', raw.prepare('SELECT content_hash FROM schedule_versions WHERE id = ?').get(c3.version.id).content_hash === c3.version.content_hash);
    raw.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?").run(correctionLeaveId);

    console.log('\n⛔ الاعتماد بلا مراجعة والتلاعب بالبصمة:');
    const noReview = await generate();
    response = await approve(noReview.schedule_version_id, noReview.output_hash, 409);
    check('الاعتماد بلا مراجعة مرفوض', response.data.code === 'REVIEW_REQUIRED');
    const noReviewContent = raw.prepare('SELECT content_json FROM schedule_versions WHERE id = ?').get(noReview.schedule_version_id).content_json;
    raw.prepare('UPDATE schedule_versions SET content_json = ? WHERE id = ?').run(JSON.stringify({ month: '2026-03', employees: [] }), noReview.schedule_version_id);
    lifecycle = await review(noReview.schedule_version_id);
    check('تغير المحتوى دون البصمة يظهر كمانع', lifecycle.version.status === 'draft' && lifecycle.latest_review.conflicts.some(row => row.type === 'content_integrity'));
    raw.prepare('UPDATE schedule_versions SET content_json = ? WHERE id = ?').run(noReviewContent, noReview.schedule_version_id);
    lifecycle = await review(noReview.schedule_version_id);
    check('استعادة المحتوى والمراجعة تعيد الجاهزية', lifecycle.latest_review.ready && lifecycle.version.status === 'ready_for_review');

    console.log('\n🚨 التغطية غير المحسومة والنواقص وE-4 وتغير المدخلات:');
    const coverageApproval = raw.prepare('SELECT * FROM schedule_coverage_approvals WHERE team_id = ?').get(team.id);
    raw.prepare("UPDATE schedule_coverage_approvals SET status = 'revoked' WHERE id = ?").run(coverageApproval.id);
    const unresolved = await generate();
    check('غياب الإثبات يمنع جاهزية التوليد', unresolved.status === 'draft' && unresolved.summary.unresolved_teams.some(row => row.reason === 'COVERAGE_APPROVAL_MISSING'));
    lifecycle = await review(unresolved.schedule_version_id);
    check('المراجعة تعرض unresolved وتمنع الاعتماد', lifecycle.version.status === 'draft' && lifecycle.latest_review.unresolved_teams.length > 0 &&
        lifecycle.latest_review.blockers.some(row => row.type === 'coverage_unresolved'));
    response = await approve(unresolved.schedule_version_id, unresolved.output_hash, 409);
    check('لا اعتماد للفريق غير المحسوم', response.data.code === 'VERSION_NOT_READY');
    raw.prepare("UPDATE schedule_coverage_approvals SET status = 'active' WHERE id = ?").run(coverageApproval.id);

    const changing = await generate();
    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_default'").run(JSON.stringify({ day: 1, night: 1, total: 2 }));
    lifecycle = await review(changing.schedule_version_id);
    check('تغير FSS = إثبات stale وتغير مدخلات', lifecycle.latest_review.unresolved_teams.some(row => row.reason === 'COVERAGE_APPROVAL_STALE') &&
        lifecycle.latest_review.input_snapshot.differences.includes('coverage_policy'));
    raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'schedule_engine.coverage_default'").run(JSON.stringify(syntheticDefault));
    raw.prepare(`INSERT INTO schedule_coverage_approvals
        (id, team_id, applicability, coverage_default_hash, coverage_overrides_hash, source,
         approval_authority, approved_by, approved_at, effective_from, status, created_by)
        VALUES (?, ?, 'not_applicable', ?, ?, 'تعارض P2', 'جهة اختبار', 'معتمد اختبار', ?, '2020-01-01', 'active', 'fixture')`)
        .run(crypto.randomUUID(), team.id, defaultHash, overridesHash, '2026-02-21T00:00:00Z');
    lifecycle = await review(changing.schedule_version_id);
    check('الإثباتان المتعارضان ظاهران كمانع', lifecycle.latest_review.unresolved_teams.some(row => row.reason === 'COVERAGE_APPROVAL_CONFLICT'));
    raw.prepare("DELETE FROM schedule_coverage_approvals WHERE team_id = ? AND source = 'تعارض P2'").run(team.id);
    raw.prepare("UPDATE schedule_coverage_approvals SET status = 'revoked' WHERE id = ?").run(coverageApproval.id);
    lifecycle = await review(changing.schedule_version_id);
    check('غياب الإثبات بعد التوليد مانع حالي', lifecycle.latest_review.unresolved_teams.some(row => row.reason === 'COVERAGE_APPROVAL_MISSING'));
    raw.prepare("UPDATE schedule_coverage_approvals SET status = 'active' WHERE id = ?").run(coverageApproval.id);

    const leaveIds = employeeIds.map(employeeId => raw.prepare("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason) VALUES (?, '2026-03-20', '2026-03-20', 'مرضية', 'approved', 'نقص P2 اصطناعي')").run(employeeId).lastInsertRowid);
    lifecycle = await review(changing.schedule_version_id);
    check('النقص الفعلي وتغير الإجازات ظاهران', lifecycle.latest_review.shortages.some(row => row.date === '2026-03-20') &&
        lifecycle.latest_review.input_snapshot.differences.includes('leaves') && lifecycle.latest_review.e4.some(row => row.reasons.includes('LEAVE_CONFLICT_APPROVED')));
    raw.prepare('UPDATE leave_requests SET status = \'cancelled\' WHERE id IN (' + leaveIds.map(() => '?').join(',') + ')').run(...leaveIds);

    const workCell = changing.entries.find(row => ['D12', 'N12'].includes(row.shift_code));
    const unableId = raw.prepare("INSERT INTO unable_attend_requests (employee_id, month, off_date, reason, status, created_by) VALUES (?, '2026-03', ?, 'E4 P2', 'approved', 1)")
        .run(workCell.employee_id, workCell.shift_date).lastInsertRowid;
    lifecycle = await review(changing.schedule_version_id);
    check('عدم التمكّن يعيد E-4 ويمنع الجاهزية', lifecycle.latest_review.e4.some(row => row.employee_id === workCell.employee_id && row.date === workCell.shift_date && row.reasons.includes('UNABLE_ATTEND_CONFLICT')) &&
        lifecycle.latest_review.input_snapshot.differences.includes('unable_attend'));
    raw.prepare('DELETE FROM unable_attend_requests WHERE id = ?').run(unableId);

    raw.prepare('UPDATE team_assignments SET end_date = ? WHERE employee_id = ?').run('2026-02-28', employeeIds[0]);
    lifecycle = await review(changing.schedule_version_id);
    check('تغير العضوية يظهر ويمنع الأهلية', lifecycle.latest_review.input_snapshot.differences.includes('memberships') &&
        lifecycle.latest_review.e4.some(row => row.employee_id === employeeIds[0] && row.reasons.includes('EMPLOYEE_NO_ACTIVE_TEAM')));
    raw.prepare('UPDATE team_assignments SET end_date = NULL WHERE employee_id = ?').run(employeeIds[0]);

    const extraEmployeeId = raw.prepare("INSERT INTO employees (employee_code, name, pattern_code) VALUES ('P2-EXTRA', 'موظف إضافي', 'A')").run().lastInsertRowid;
    lifecycle = await review(changing.schedule_version_id);
    check('تغير الموظفين النشطين مسجل كمدخل متقادم', lifecycle.latest_review.input_snapshot.differences.includes('active_employees'));
    raw.prepare('UPDATE employees SET is_active = 0 WHERE id = ?').run(extraEmployeeId);

    const exceptionId = crypto.randomUUID();
    raw.prepare(`INSERT INTO schedule_exceptions
        (id, employee_id, exception_type, start_date, end_date, reason, approval_source,
         approval_authority, approved_by, approved_at, status, created_by)
        VALUES (?, ?, 'operational_note', '2026-03-05', '2026-03-05', 'ملاحظة P2', 'سند اختبار', 'جهة اختبار', 'معتمد اختبار', ?, 'active', 'fixture')`)
        .run(exceptionId, employeeIds[0], '2026-02-25T00:00:00Z');
    lifecycle = await review(changing.schedule_version_id);
    check('تغير الاستثناءات الموثقة يكتشف', lifecycle.latest_review.input_snapshot.differences.includes('exceptions'));
    raw.prepare("UPDATE schedule_exceptions SET status = 'cancelled' WHERE id = ?").run(exceptionId);

    raw.prepare("UPDATE app_settings SET value = '30' WHERE key = 'schedule_engine.min_rest_hours'").run();
    lifecycle = await review(changing.schedule_version_id);
    check('تغير إعدادات E-4 يظهر مع فحوص الراحة', lifecycle.latest_review.input_snapshot.differences.includes('e4_config') &&
        lifecycle.latest_review.e4.some(row => row.reasons.includes('REST_BELOW_MINIMUM')));
    raw.prepare("UPDATE app_settings SET value = '8' WHERE key = 'schedule_engine.min_rest_hours'").run();

    lifecycle = await review(changing.schedule_version_id);
    must('بعد حسم المدخلات تعود المراجعة الناجحة', lifecycle.latest_review.ready,
        JSON.stringify(lifecycle.latest_review.blockers).slice(0, 2200));
    response = await approve(changing.schedule_version_id, changing.output_hash);
    check('الاعتماد بعد المراجعة الناجحة فقط', response.data.version.status === 'approved');

    console.log('\n🧭 تغير المرجع والتدقيق والعزل النهائي:');
    response = await api('/api/schedule/versions/import-roster', { method: 'POST', token: tokens['p2-admin'], body: { month: '2026-02', source_note: 'مرجع أحدث P2' } });
    const newerReferenceId = response.data.version.id;
    await api(`/api/schedule/versions/${newerReferenceId}/open-draft`, { method: 'POST', token: tokens['p2-admin'], body: {} });
    response = await api(`/api/schedule/versions/${newerReferenceId}/continuity/derive`, { method: 'POST', token: tokens['p2-admin'], body: {} });
    await api(`/api/schedule/versions/${newerReferenceId}/approve`, { method: 'POST', token: tokens['p2-admin'], body: { content_hash: response.data.version.content_hash } });
    lifecycle = await review(noReview.schedule_version_id);
    check('تغير المرجع المعتمد يمنع النسخة القديمة', lifecycle.latest_review.conflicts.some(row => row.type === 'stale_reference') &&
        lifecycle.latest_review.input_snapshot.differences.includes('reference'));

    check('تدقيق المراجعة والاعتماد والنشر والتصحيح موجود', ['schedule_draft_reviewed', 'schedule_draft_approved', 'schedule_draft_published', 'schedule_correction_created']
        .every(action => raw.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n > 0));
    check('shift_roster لم يتغير إطلاقًا', rowsHash(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()) === baseline.roster);
    check('schedule_months لم يتغير إطلاقًا', rowsHash(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()) === baseline.months);
    check('user_permissions لم تتغير إطلاقًا', rowsHash(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all()) === baseline.permissions);
    check('لا منح أو سحب عبر مسارات P2', raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('permission_grant','permission_revoke','permission_clear')").get().n === 0);
    check('كل مراجعة محفوظة وقابلة للتتبع', raw.prepare('SELECT COUNT(*) AS n FROM schedule_lifecycle_reviews').get().n >= 15 &&
        raw.prepare('SELECT COUNT(*) AS n FROM schedule_lifecycle_reviews WHERE content_hash = \'\' OR current_input_hash = \'\'').get().n === 0);

    raw.close(); raw = null;
    await stopServer();
    await db.closeDb();
    console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
    if (failures.length) console.log('الإخفاقات:\n- ' + failures.join('\n- '));
    if (failed) process.exitCode = 1;
})().catch(error => {
    console.error('❌ انهيار الاختبار:', error.stack || error.message);
    if (serverLog) console.error(serverLog.slice(-7000));
    failed++;
    process.exitCode = 1;
}).finally(async () => {
    await stopServer();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) { }
});
