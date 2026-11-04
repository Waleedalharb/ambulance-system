/**
 * P1-A — اختبارات معزولة للمرجع والاستمرارية والتهيئة الأولى.
 * التشغيل بنسخة Node المتوافقة: node scripts/p1-a-continuity-test.js
 * قاعدة جديدة داخل .test-tmp؛ لا قراءة أو كتابة في قاعدة التشغيل.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAMP = Date.now();
const TMP_ROOT = path.join(ROOT, '.test-tmp', 'p1-a-' + STAMP);
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const PORT = 3108;
const BASE = 'http://127.0.0.1:' + PORT;
process.env.DB_PATH = TMP_DB;
process.env.DATA_DIR = TMP_DATA;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p1-a-isolated-test-secret';

let passed = 0;
let failed = 0;
const failures = [];
let server = null;
let serverLog = '';

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
function must(name, condition, extra) {
    check(name, condition, extra);
    if (!condition) throw new Error('فشل شرط أساسي: ' + name + (extra ? ' — ' + extra : ''));
}
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(BASE + p, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await response.json(); } catch (_) { }
    return { status: response.status, data };
}
async function waitReady(tries = 100) {
    for (let i = 0; i < tries; i++) {
        try { if ((await fetch(BASE + '/health')).ok) return true; } catch (_) { }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
}
async function stopServer() {
    if (!server || server.killed) return;
    const child = server;
    server = null;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
    });
}
function rowsHash(rows) {
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function expectSqliteDenied(name, fn) {
    let denied = false;
    try { fn(); } catch (error) { denied = /immutable/i.test(error.message); }
    check(name, denied);
}

(async () => {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const db = require('../db.js');
    const { ContinuityService, canonicalStringify, contentHash, daysOfMonth, monthsBetweenExclusive } =
        require('../services/schedule-engine/continuity-service.js');
    const { PERMISSIONS, ROLES_PERMISSIONS } = require('../config/permissions.js');

    console.log('🧪 العقود النقية والصلاحيات:');
    check('canonical JSON يرتب مفاتيح الكائنات', canonicalStringify({ b: 1, a: 2 }) === '{"a":2,"b":1}');
    check('SHA-256 مستقر دلاليًا', contentHash({ b: [1, 2], a: 3 }) === contentHash({ a: 3, b: [1, 2] }));
    check('أطوال الأشهر 28/29/30/31 والسنة الكبيسة',
        daysOfMonth('2026-02').length === 28 && daysOfMonth('2028-02').length === 29 &&
        daysOfMonth('2026-04').length === 30 && daysOfMonth('2026-01').length === 31);
    check('فجوة الأشهر لا تقفز على المرجع', JSON.stringify(monthsBetweenExclusive('2026-02', '2026-05')) === JSON.stringify(['2026-03', '2026-04']));
    const p1Keys = ['schedule.draft.edit', 'schedule.gaps.review', 'schedule.approve'];
    check('مفاتيح P1-A موجودة ومستقلة', p1Keys.every(key => PERMISSIONS[key] && PERMISSIONS[key].domain === 'schedule'));
    check('لا افتراضيات أدوار جديدة لمفاتيح P1-A', Object.entries(ROLES_PERMISSIONS)
        .filter(([, perms]) => !perms.includes('*')).every(([, perms]) => p1Keys.every(key => !perms.includes(key))));

    await db.init(false);
    const team = await db.get('SELECT id FROM teams ORDER BY id LIMIT 1');
    await db.run("UPDATE shift_patterns SET cycle_json = ? WHERE code = 'A'", [JSON.stringify(['D12', 'N12', 'WO'])]);
    await db.run("UPDATE shift_patterns SET cycle_json = ? WHERE code = 'B'", [JSON.stringify(['D12', 'D12', 'WO'])]);
    const e1 = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES ('P1-E1', 'موظف مرجعي', 'A')")).id;
    const e2 = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES ('P1-E2', 'موظف بلا مرجع', 'A')")).id;
    const users = [
        { id: 'p1-admin', role: 'admin', name: 'أدمن الاختبار' },
        { id: 'p1-director', role: 'director', name: 'مدير الاختبار' },
        { id: 'p1-user', role: 'user', name: 'مستخدم الاختبار' }
    ];
    for (const user of users) {
        await db.run('INSERT INTO users (user_id, username, password, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)',
            [user.id, user.id, 'not-used', user.name, user.role]);
    }
    const directorKeys = ['schedule.view', 'schedule.draft.edit', 'schedule.gaps.review', 'schedule.approve'];
    for (const key of directorKeys) {
        await db.run('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)',
            ['p1-director', key, 'تهيئة قاعدة الاختبار فقط']);
    }
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users.map(u => ({
        id: u.id, username: u.id, password: 'not-used', name: u.name, role: u.role, isActive: true
    })), null, 2));

    const febDays = daysOfMonth('2026-02');
    for (let index = 0; index < febDays.length; index++) {
        if (index === 14) continue; // 2026-02-15، المتوقع WO
        const code = ['D12', 'N12', 'WO'][index % 3];
        await db.run(`INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year)
                      VALUES (?, ?, ?, ?, 2, 2026)`, [e1, team.id, febDays[index], code]);
    }
    const raw = new (require('better-sqlite3'))(TMP_DB);
    const rosterBefore = rowsHash(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all());
    const monthsBefore = rowsHash(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all());
    const permissionsBefore = rowsHash(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all());
    raw.close();

    console.log('\n🚀 خادم P1-A المعزول:');
    server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test', JWT_SECRET: process.env.JWT_SECRET },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', data => { serverLog += data; });
    server.stderr.on('data', data => { serverLog += data; });

    let approvedId;
    let approvedSnapshotId;
    let approvedEntryId;
    try {
        must('الخادم يعمل على قاعدة P1-A الجديدة', await waitReady(), serverLog.slice(-2500));
        const jwt = require('jsonwebtoken');
        const tokens = Object.fromEntries(users.map(user => [user.role,
            jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET)]));

        console.log('\n🔐 المصادقة والصلاحيات ودورة الحياة:');
        let response = await api('/api/schedule/versions/import-roster', { method: 'POST', body: { month: '2026-02' } });
        check('الاستيراد بلا توكن 401', response.status === 401);
        response = await api('/api/schedule/versions/import-roster', { method: 'POST', token: tokens.director, body: { month: '2026-02' } });
        check('director بلا schedule.import مرفوض 403', response.status === 403 && response.data.permission === 'schedule.import');
        response = await api('/api/shift-schedule/generate', { method: 'POST', token: tokens.director, body: { year: 2026, month: 3, mode: 'normal' } });
        check('صلاحيات P1-A لا تفتح توليد الجدول لـdirector', response.status === 403 && response.data.permission === 'schedule.generate');

        response = await api('/api/schedule/versions/import-roster', {
            method: 'POST', token: tokens.admin, body: { month: '2026-02', source_note: 'لقطة اختبار P1-A' }
        });
        must('admin يستورد لقطة مستقلة 201', response.status === 201 && response.data.version, JSON.stringify(response));
        const version = response.data.version;
        approvedId = version.id;
        check('الاستيراد يبدأ imported وببصمة SHA-256', version.status === 'imported' && /^[a-f0-9]{64}$/.test(version.content_hash));
        check('المحتوى يحفظ 28 يومًا والرمز الخام', version.content.employees.length === 2 && version.content.employees[0].days.length === 28 && version.content.employees[0].days[14].shift_code === null);
        check('الفراغ سجل unresolved ولم يتحول تلقائيًا إلى راحة', version.gap_reviews.length === 1 && version.gap_reviews[0].gap_date === '2026-02-15' && version.gap_reviews[0].resolution === 'unresolved');
        check('لا شهر كاملًا من الفراغات لموظف بلا مرجع', version.gap_reviews.every(g => g.employee_id === e1));

        response = await api('/api/schedule/versions/' + approvedId + '/open-draft', { method: 'POST', token: tokens.user });
        check('فتح المسودة بلا schedule.draft.edit مرفوض 403', response.status === 403);
        response = await api('/api/schedule/versions/' + approvedId + '/open-draft', { method: 'POST', token: tokens.director });
        must('director المخول يفتح المسودة', response.status === 200 && response.data.version.status === 'draft', JSON.stringify(response));

        response = await api('/api/schedule/versions/' + approvedId + '/continuity/derive', { method: 'POST', token: tokens.director });
        must('الاشتقاق الأول ينشئ لقطة', response.status === 200 && response.data.version.current_snapshot, JSON.stringify(response));
        check('الفراغ غير المحسوم يمنع الجاهزية', response.data.version.status === 'draft' && !response.data.version.readiness.ready);
        check('بلا صفوف = no_reference لا نمط مفترض', response.data.version.current_snapshot.entries.find(e => e.employee_id === e2).status === 'no_reference');

        response = await api('/api/schedule/versions/' + approvedId + '/gaps', {
            method: 'PUT', token: tokens.director,
            body: { reviews: [{ employee_id: e1, gap_date: '2026-02-15', resolution: 'rest_confirmed', reason: 'تأكيد بشري في الاختبار' }] }
        });
        must('مراجعة الفراغ توثق rest_confirmed', response.status === 200 && response.data.version.gap_reviews[0].resolution === 'rest_confirmed', JSON.stringify(response));
        check('تأكيد الراحة لا يعدل الرمز الخام', response.data.version.content.employees[0].days[14].shift_code === null);

        response = await api('/api/schedule/versions/' + approvedId + '/continuity/derive', { method: 'POST', token: tokens.director });
        must('إعادة الاشتقاق تنشئ لقطة ثانية', response.status === 200 && response.data.version.current_snapshot.snapshot_number === 2, JSON.stringify(response));
        const derived = response.data.version;
        const entry1 = derived.current_snapshot.entries.find(e => e.employee_id === e1);
        check('الطور التالي مشتق حتميًا N12/index=1', entry1.status === 'resolved' && entry1.next_phase_index === 1 && entry1.next_shift_code === 'N12' && entry1.effective_date === '2026-03-01');
        check('اللقطة السابقة محفوظة وغير حالية', derived.snapshots.length === 2 && derived.snapshots[0].is_current === 0);

        response = await api('/api/schedule/versions/' + approvedId + '/continuity/' + e2, {
            method: 'PUT', token: tokens.director,
            body: { status: 'resolved', pattern_code: 'A', next_phase_index: 2, effective_date: '2026-03-01', reason: 'تهيئة أولى بمراجعة بشرية' }
        });
        must('الإسناد البشري يحسم الموظف بلا مرجع', response.status === 200 && response.data.version.status === 'ready_for_review', JSON.stringify(response));
        const ready = response.data.version;
        const entry2 = ready.current_snapshot.entries.find(e => e.employee_id === e2);
        check('الإسناد يحفظ WO/index=2 ومصدره وسببه', entry2.next_shift_code === 'WO' && entry2.next_phase_index === 2 && entry2.resolution_source === 'manual_reviewed' && entry2.reason.includes('مراجعة بشرية'));
        check('الفريق اختياري في التهيئة البشرية', entry2.assignment_status === 'not_applicable' && entry2.team_id === null);

        response = await api('/api/schedule/versions/' + approvedId + '/approve', { method: 'POST', token: tokens.director, body: { content_hash: '0'.repeat(64) } });
        check('اعتماد ببصمة خاطئة 409', response.status === 409 && response.data.code === 'CONTENT_HASH_MISMATCH');
        response = await api('/api/schedule/versions/' + approvedId + '/approve', { method: 'POST', token: tokens.director, body: { content_hash: ready.content_hash } });
        must('الاعتماد بالبصمة الصحيحة ينجح', response.status === 200 && response.data.version.status === 'approved', JSON.stringify(response));
        const approved = response.data.version;
        approvedSnapshotId = approved.current_snapshot.id;
        approvedEntryId = approved.current_snapshot.entries[0].id;
        check('الاعتماد يعتمد اللقطة الحالية في المعاملة نفسها', approved.current_snapshot.status === 'approved' && approved.current_snapshot.approved_by === 'p1-director');

        response = await api('/api/schedule/versions/' + approvedId + '/gaps', {
            method: 'PUT', token: tokens.director,
            body: { reviews: [{ employee_id: e1, gap_date: '2026-02-15', resolution: 'missing_data', reason: 'محاولة ممنوعة' }] }
        });
        check('تعديل فراغات المعتمد مرفوض 409', response.status === 409 && response.data.code === 'VERSION_IMMUTABLE');
        response = await api('/api/schedule/versions/' + approvedId + '/continuity/derive', { method: 'POST', token: tokens.director });
        check('إعادة اشتقاق المعتمد مرفوضة 409', response.status === 409 && response.data.code === 'VERSION_IMMUTABLE');
        response = await api('/api/schedule/versions/' + approvedId + '/continuity/' + e2, {
            method: 'PUT', token: tokens.director,
            body: { status: 'excluded', reason: 'محاولة ممنوعة' }
        });
        check('تعديل استمرارية المعتمد مرفوض 409', response.status === 409 && response.data.code === 'VERSION_IMMUTABLE');

        console.log('\n🔎 اختيار المرجع والثبات بعد القراءة:');
        response = await api('/api/schedule/reference?target_month=2026-03', { token: tokens.director });
        check('مارس يستخدم أحدث مرجع فبراير المعتمد', response.status === 200 && response.data.usable && response.data.reference.id === approvedId);
        response = await api('/api/schedule/reference?target_month=2026-04', { token: tokens.director });
        check('أبريل يفشل بفجوة مارس بدل القفز', response.status === 200 && !response.data.usable && response.data.reason === 'REFERENCE_MONTH_GAP' && JSON.stringify(response.data.missing_months) === JSON.stringify(['2026-03']));
        response = await api('/api/schedule/reference?target_month=2026-03');
        check('قراءة المرجع بلا توكن 401', response.status === 401);
        response = await api('/api/schedule/versions/' + approvedId, { token: tokens.director });
        const rereadHash = response.data.version.content_hash;
        const rereadSnapshots = response.data.version.snapshots.length;
        response = await api('/api/schedule/versions/' + approvedId, { token: tokens.director });
        check('إعادة القراءة لا تغير البصمة ولا تكرر اللقطات', response.data.version.content_hash === rereadHash && response.data.version.snapshots.length === rereadSnapshots);
        response = await api('/api/schedule/versions?month=2026-02&status=approved', { token: tokens.director });
        check('الفهرس يعرض الإصدار المعتمد', response.status === 200 && response.data.versions.some(v => v.id === approvedId));

        const live = new (require('better-sqlite3'))(TMP_DB);
        expectSqliteDenied('Trigger يمنع تعديل محتوى الإصدار المعتمد', () => live.prepare('UPDATE schedule_versions SET content_json = ? WHERE id = ?').run('{}', approvedId));
        expectSqliteDenied('Trigger يمنع حذف الإصدار المعتمد', () => live.prepare('DELETE FROM schedule_versions WHERE id = ?').run(approvedId));
        expectSqliteDenied('Trigger يمنع حذف اللقطة المعتمدة', () => live.prepare('DELETE FROM schedule_continuity_snapshots WHERE id = ?').run(approvedSnapshotId));
        expectSqliteDenied('Trigger يمنع إلغاء حالية اللقطة المعتمدة', () => live.prepare('UPDATE schedule_continuity_snapshots SET is_current = 0 WHERE id = ?').run(approvedSnapshotId));
        expectSqliteDenied('Trigger يمنع تعديل مدخل اللقطة المعتمدة', () => live.prepare('UPDATE schedule_continuity_entries SET reason = ? WHERE id = ?').run('tamper', approvedEntryId));
        const auditActions = live.prepare("SELECT action FROM audit_log WHERE type = 'schedule_continuity' ORDER BY id").all().map(row => row.action);
        const expectedAuditActions = [
            'schedule_reference_imported', 'schedule_reference_draft_opened',
            'schedule_continuity_derived', 'schedule_gaps_reviewed',
            'schedule_continuity_derived', 'schedule_continuity_manually_assigned',
            'schedule_reference_approved'
        ];
        check('كل العمليات السبع الناجحة مدققة والمحاولات المرفوضة بلا قيد جديد', JSON.stringify(auditActions) === JSON.stringify(expectedAuditActions), JSON.stringify(auditActions));
        check('shift_roster لم يتغير بصمته', rowsHash(live.prepare('SELECT * FROM shift_roster ORDER BY id').all()) === rosterBefore);
        check('schedule_months لم يتغير', rowsHash(live.prepare('SELECT * FROM schedule_months ORDER BY month').all()) === monthsBefore);
        check('لم تنشأ منح أو سحوبات عبر المسارات', rowsHash(live.prepare('SELECT * FROM user_permissions ORDER BY id').all()) === permissionsBefore);
        live.close();
    } finally {
        await stopServer();
    }

    console.log('\n🧩 حالات الاشتقاق الحدية على الخدمة نفسها:');
    await db.init(false);
    const service = new ContinuityService(db);
    const actor = { id: 'p1-director', name: 'مدير الاختبار' };
    await db.run('UPDATE employees SET is_active = 0 WHERE id IN (?, ?)', [e1, e2]);

    // دورة ملتبسة: لا يجوز اختيار طور من أكثر من احتمال.
    const e3 = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES ('P1-E3', 'طور ملتبس', 'B')")).id;
    for (const date of daysOfMonth('2026-03')) {
        await db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 3, 2026)', [e3, team.id, date, 'D12']);
    }
    let v = await service.importRoster({ month: '2026-03', user: actor });
    await service.openDraft(v.id, actor);
    v = await service.derive(v.id, actor);
    check('الدورة الملتبسة تبقى unresolved ولا تختار طورًا', v.current_snapshot.entries[0].status === 'unresolved' && v.current_snapshot.entries[0].next_phase_index === null && v.status === 'draft');
    await db.run('UPDATE employees SET is_active = 0 WHERE id = ?', [e3]);

    // غياب cycle_json: لا استنتاج 2+2+4 ولا أي نمط من الرموز.
    const e4 = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES ('P1-E4', 'نمط مجهول', 'C')")).id;
    for (const date of daysOfMonth('2026-04')) {
        await db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 4, 2026)', [e4, team.id, date, 'D12']);
    }
    v = await service.importRoster({ month: '2026-04', user: actor });
    await service.openDraft(v.id, actor);
    v = await service.derive(v.id, actor);
    check('النمط بلا cycle_json لا يُخمن', v.current_snapshot.entries[0].status === 'unresolved' && v.current_snapshot.entries[0].reason.includes('لا توجد دورة صريحة'));
    await db.run('UPDATE employees SET is_active = 0 WHERE id = ?', [e4]);

    // الإجازة wildcard مع تقدم الطور، لا إعادة ضبط.
    const e5 = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES ('P1-E5', 'إجازة مؤقتة', 'A')")).id;
    const mayDays = daysOfMonth('2026-05');
    for (let index = 0; index < mayDays.length; index++) {
        const code = index === 10 ? 'V' : ['D12', 'N12', 'WO'][index % 3];
        await db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 5, 2026)', [e5, team.id, mayDays[index], code]);
    }
    v = await service.importRoster({ month: '2026-05', user: actor });
    await service.openDraft(v.id, actor);
    v = await service.derive(v.id, actor);
    check('الإجازة wildcard ولا تعيد ضبط الدورة', v.current_snapshot.entries[0].status === 'resolved' && v.current_snapshot.entries[0].next_phase_index === 1 && v.current_snapshot.entries[0].next_shift_code === 'N12');
    await db.run('UPDATE employees SET is_active = 0 WHERE id = ?', [e5]);

    // missing_data: يلزم إسناد بشري، وتغيير الفراغ يجعل اللقطة القديمة stale.
    const e6 = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES ('P1-E6', 'نقص بيانات', 'A')")).id;
    const juneDays = daysOfMonth('2026-06');
    for (let index = 0; index < juneDays.length; index++) {
        if (index === 5) continue;
        await db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 6, 2026)', [e6, team.id, juneDays[index], ['D12', 'N12', 'WO'][index % 3]]);
    }
    v = await service.importRoster({ month: '2026-06', user: actor });
    await service.openDraft(v.id, actor);
    await service.derive(v.id, actor);
    v = await service.reviewGaps(v.id, [{ employee_id: e6, gap_date: '2026-06-06', resolution: 'missing_data', reason: 'السند غير متوفر' }], actor);
    let staleDenied = false;
    try {
        await service.assignContinuity(v.id, e6, { status: 'resolved', pattern_code: 'A', next_phase_index: 0, effective_date: '2026-07-01', reason: 'حسم بشري' }, actor);
    } catch (error) { staleDenied = error.code === 'STALE_SNAPSHOT'; }
    check('تغيير المرجع بعد اللقطة يمنع الإسناد على لقطة stale', staleDenied);
    v = await service.derive(v.id, actor);
    check('missing_data يتطلب إسنادًا بشريًا', v.current_snapshot.entries[0].status === 'unresolved' && v.status === 'draft');
    v = await service.assignContinuity(v.id, e6, { status: 'resolved', pattern_code: 'A', next_phase_index: 0, effective_date: '2026-07-01', team_id: team.id, reason: 'حسم بشري موثق لنقص البيانات' }, actor);
    check('الإسناد البشري يزيل مانع missing_data ويجهز الاعتماد', v.status === 'ready_for_review' && v.readiness.blockers.length === 0);
    const approvedJune = await service.approve(v.id, v.content_hash, actor);
    check('اعتماد الحالة اليدوية يحفظ البصمة', approvedJune.status === 'approved' && approvedJune.current_snapshot.entries[0].resolution_source === 'manual_reviewed');

    await db.closeDb();
    console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
    if (failures.length) console.log('الإخفاقات:\n- ' + failures.join('\n- '));
    if (failed) process.exitCode = 1;
})().catch(error => {
    console.error('❌ انهيار الاختبار:', error.stack || error.message);
    if (serverLog) console.error(serverLog.slice(-5000));
    failed++;
    process.exitCode = 1;
}).finally(async () => {
    await stopServer();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) { }
});
