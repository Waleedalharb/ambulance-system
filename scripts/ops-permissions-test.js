/**
 * ═══ اختبار ربط صلاحيات العمليات — ops-permissions-test.js ═══
 * (معتمد التصميم 2026-08-17) يثبت على حسابات تجريبية معزولة:
 *  1) كل مسارات التنفيذ الـ61 مربوطة بـ authorizePerm (فحص ساكن + 403 فعلي)
 *  2) viewer بلا منح ← كل التنفيذ 403، والقراءات تبقى مفتوحة (قرار ①)
 *  3) كل مفتاح يفتح مساراته فقط — لا تسلل بين مفاتيح العمليات
 *  4) ops.completion لا تفتح التوزيع/التمركزات/النماذج/المركبات/خروج الفرق
 *  5) workflow.approve وحدها لا تمنح أي صلاحية تشغيلية
 *  6) ops.execute القديم (legacy) لا يفتح أي مسار بعد الربط (قرار ⑤)
 *  7) operator/field_leadership/sysadmin يتصرفون حسب الحزم المعتمدة
 * العزل: VACUUM INTO + DATA_DIR مؤقت — لا يمس القاعدة ولا users.json الأصليين.
 * التشغيل: node scripts/ops-permissions-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'ops-perm-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'ops-perm-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3095;
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

// ── المسارات الـ61 المربوطة: [method, path, key] ──
const BOUND = [
    ['POST', '/api/shift-completion', 'ops.completion'],
    ['POST', '/api/staffing/activation', 'ops.completion'],
    ['POST', '/api/staffing/activation/end', 'ops.completion'],
    ['POST', '/api/shift-absences/1', 'ops.completion'],
    ['DELETE', '/api/shift-absences/1/x', 'ops.completion'],
    ['POST', '/api/shift-notes/1', 'ops.completion'],
    ['DELETE', '/api/shift-notes/1/x', 'ops.completion'],
    ['POST', '/api/shift-events/1', 'ops.completion'],
    ['DELETE', '/api/shift-events/1/x', 'ops.completion'],
    ['POST', '/api/report', 'ops.dispatch'],
    ['POST', '/api/undo', 'ops.report_revert'],
    ['POST', '/api/report-entry', 'ops.report_detail'],
    ['DELETE', '/api/report-entry/1', 'ops.report_detail'],
    ['POST', '/api/unit-locations', 'ops.deployments'],
    ['POST', '/api/unit-location-addresses', 'ops.deployments'],
    ['POST', '/api/peak-plans', 'ops.deployments'],
    ['PUT', '/api/peak-plans/1', 'ops.deployments'],
    ['DELETE', '/api/peak-plans/1', 'ops.deployments'],
    ['POST', '/api/peak-mission', 'ops.deployments'],
    ['POST', '/api/peak-resolve', 'ops.deployments'],
    ['POST', '/api/e-cases', 'ops.forms'],
    ['DELETE', '/api/e-cases/1', 'ops.forms'],
    ['POST', '/api/escalations', 'ops.forms'],
    ['DELETE', '/api/escalations/1', 'ops.forms'],
    ['POST', '/api/incidents', 'ops.forms'],
    ['DELETE', '/api/incidents/1', 'ops.forms'],
    ['POST', '/api/daily-reports', 'ops.forms'],
    ['DELETE', '/api/daily-reports/1', 'ops.forms'],
    ['POST', '/api/save-air-ambulance', 'ops.forms'],
    ['DELETE', '/api/delete-air-ambulance/1', 'ops.forms'],
    ['POST', '/api/senior-shifts', 'ops.forms'],
    ['DELETE', '/api/senior-shifts/1', 'ops.forms'],
    ['POST', '/api/save-control-notes', 'ops.forms'],
    ['POST', '/api/signouts', 'ops.team_exit'],
    ['POST', '/api/staffing/volunteer', 'ops.volunteers'],
    ['POST', '/api/vehicles/assignment', 'ops.vehicles'],
    ['POST', '/api/vehicles/assignment/end', 'ops.vehicles'],
    ['POST', '/api/vehicles/assignment/switch', 'ops.vehicles'],
    ['POST', '/api/vehicles/support', 'ops.vehicles'],
    ['POST', '/api/vehicles/support/end', 'ops.vehicles'],
    ['POST', '/api/vehicles/events', 'ops.vehicles'],
    ['POST', '/api/upload-operational', 'ops.files'],
    ['POST', '/api/ops-files', 'ops.files'],
    ['DELETE', '/api/ops-files/1', 'ops.files'],
    ['POST', '/api/upload-doc', 'ops.files'],
    ['DELETE', '/api/delete-doc/1', 'ops.files'],
    ['DELETE', '/api/delete-operational/1', 'ops.files'],
    ['POST', '/api/shifts/alerts/1/acknowledge', 'ops.alerts'],
    ['POST', '/api/shifts/alerts/calculate', 'ops.alerts'],
    ['POST', '/api/workflow/prepare', 'workflow.manage'],
    ['PUT', '/api/workflow/version/1', 'workflow.manage'],
    ['POST', '/api/workflow/version/1/reissue', 'workflow.manage'],
    ['POST', '/api/workflow/version/1/approve', 'workflow.approve'],
    ['GET', '/api/workflow/shift/1', 'workflow.view'],
    ['GET', '/api/workflow/version/1', 'workflow.view'],
    ['GET', '/api/workflow/version/1/pdf', 'workflow.view'],
    ['POST', '/api/start-new-shift', 'shift.lifecycle'],
    ['POST', '/api/update-shift-data', 'shift.lifecycle'],
    ['POST', '/api/shift-save', 'shift.lifecycle'],
    ['POST', '/api/shift/1/end', 'shift.lifecycle'],
    ['POST', '/api/shift/1/handover-approve', 'shift.approve']
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

    // ── فحص ساكن: الربط موجود في server.js ──
    console.log('\n🧪 الفحص الساكن للربط:');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    let staticOk = 0;
    const staticBad = [];
    // مطابقة دقيقة: لكل مسار نبحث عن سطر الربط الأصلي بصيغة المعاملات
    const ORIG = {
        '/api/shift-absences/1': '/api/shift-absences/:shiftId', '/api/shift-absences/1/x': '/api/shift-absences/:shiftId/:absenceId',
        '/api/shift-notes/1': '/api/shift-notes/:shiftId', '/api/shift-notes/1/x': '/api/shift-notes/:shiftId/:noteId',
        '/api/shift-events/1': '/api/shift-events/:shiftId', '/api/shift-events/1/x': '/api/shift-events/:shiftId/:eventId',
        '/api/report-entry/1': '/api/report-entry/:id', '/api/peak-plans/1': '/api/peak-plans/:id',
        '/api/e-cases/1': '/api/e-cases/:id', '/api/escalations/1': '/api/escalations/:id',
        '/api/incidents/1': '/api/incidents/:id', '/api/daily-reports/1': '/api/daily-reports/:id',
        '/api/delete-air-ambulance/1': '/api/delete-air-ambulance/:id', '/api/senior-shifts/1': '/api/senior-shifts/:id',
        '/api/ops-files/1': '/api/ops-files/:id', '/api/delete-doc/1': '/api/delete-doc/:id',
        '/api/delete-operational/1': '/api/delete-operational/:id', '/api/shifts/alerts/1/acknowledge': '/api/shifts/alerts/:id/acknowledge',
        '/api/workflow/version/1': '/api/workflow/version/:id', '/api/workflow/version/1/reissue': '/api/workflow/version/:id/reissue',
        '/api/workflow/version/1/approve': '/api/workflow/version/:id/approve', '/api/workflow/version/1/pdf': '/api/workflow/version/:id/pdf',
        '/api/workflow/shift/1': '/api/workflow/shift/:shiftId', '/api/shift/1/end': '/api/shift/:id/end',
        '/api/shift/1/handover-approve': '/api/shift/:id/handover-approve'
    };
    for (const [m, p, key] of BOUND) {
        const origPath = ORIG[p] || p;
        const frag = `app.${m.toLowerCase()}('${origPath}', authenticate, authorizePerm('${key}')`;
        if (serverSrc.includes(frag)) staticOk++;
        else staticBad.push(`${m} ${origPath} ← ${key}`);
    }
    check('الـ61 مسارًا كلها مربوطة في server.js بالمفتاح الصحيح', staticOk === BOUND.length, staticBad.join(' | '));
    check('ops.execute القديم لا يحرس أي مسار (legacy شكلي فقط)', !serverSrc.includes("authorizePerm('ops.execute')"));

    // ── بوابات الواجهة (فحص ساكن) ──
    const rcSrc = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
    const reSrc = fs.readFileSync(path.join(ROOT, 'public', 'report-entry.html'), 'utf8');
    const wfSrc = fs.readFileSync(path.join(ROOT, 'public', 'workflow.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    check('التكميل: بوابة أزرار ops.completion/team_exit/vehicles/volunteers', rcSrc.includes("perm: 'ops.completion'") && rcSrc.includes("perm: 'ops.team_exit'") && rcSrc.includes("perm: 'ops.vehicles'") && rcSrc.includes("perm: 'ops.volunteers'"));
    check('البلاغ التفصيلي: لفّ saveQuickReport/undoLastReport بمفاتيحهما', reSrc.includes("guard('saveQuickReport', 'ops.report_detail')") && reSrc.includes("guard('undoLastReport', 'ops.report_revert')"));
    check('سير العمل: بوابة btnApprove بـ workflow.approve + سقوط 403 للمعتمدة', wfSrc.includes("perm: 'workflow.approve'") && wfSrc.includes('e.status === 403 && locked'));
    check('لوحة العمليات: لفّ التوزيع/التراجع/النماذج/التمركزات', appSrc.includes("opsGuard('addReportToServer', 'ops.dispatch')") && appSrc.includes("opsGuard('undoLastReport', 'ops.report_revert')") && appSrc.includes("opsGuard('saveIncident', 'ops.forms')") && appSrc.includes("opsGuard('savePeakPlan', 'ops.deployments')"));

    // ── منح فردية لمجسّات ──
    const grant = (uid, key) => dbw.prepare('INSERT OR REPLACE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)').run(uid, key, 'اختبار');
    const PROBES = [
        ['probe-comp', 'ops.completion'], ['probe-disp', 'ops.dispatch'], ['probe-depl', 'ops.deployments'],
        ['probe-forms', 'ops.forms'], ['probe-exit', 'ops.team_exit'], ['probe-vol', 'ops.volunteers'],
        ['probe-veh', 'ops.vehicles'], ['probe-files', 'ops.files'], ['probe-alerts', 'ops.alerts'],
        ['probe-revert', 'ops.report_revert'], ['probe-detail', 'ops.report_detail'], ['probe-wfappr', 'workflow.approve']
    ];
    PROBES.forEach(([uid, key]) => grant(uid, key));
    dbw.close();

    console.log('\n🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    if (!(await waitReady())) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security.js'));
        const tok = (id, role) => jwt.sign({ id, role, name: 'مجس ' + id }, securityConfig.JWT_SECRET);
        const T_VIEWER = tok('probe-viewer-nothing', 'viewer');
        const T_LEGACY = tok('probe-legacy-user', 'user'); // role user = ops.execute القديم
        const T_OP = tok('probe-operator', 'operator');
        const T_FL = tok('probe-field', 'field_leadership');
        const T_SYS = tok('probe-sys', 'sysadmin');
        const TK = {};
        PROBES.forEach(([uid]) => { TK[uid] = tok(uid, 'viewer'); });

        // ① viewer: كل المسارات الـ61 ← 403
        console.log('\n🚫 viewer بلا منح على كل المسارات الـ61:');
        let denied = 0; const wrong = [];
        for (const [m, p] of BOUND) {
            const r = await api(p, { method: m, token: T_VIEWER, body: m === 'GET' ? undefined : {} });
            if (r.status === 403 && r.data && r.data.code === 'PERMISSION_DENIED') denied++;
            else wrong.push(m + ' ' + p + '=' + r.status);
        }
        check('الـ61 مسارًا كلها ← 403 PERMISSION_DENIED', denied === BOUND.length, wrong.join(' | '));

        // ① القراءات تبقى مفتوحة للموثّق (قرار المالك الأول)
        const reads = await Promise.all([
            api('/api/current-shift', { token: T_VIEWER }),
            api('/api/teams', { token: T_VIEWER }),
            api('/api/vehicles/board', { token: T_VIEWER }),
            api('/api/staffing/timeline', { token: T_VIEWER }),
            api('/api/signouts', { token: T_VIEWER }),
            api('/api/e-cases', { token: T_VIEWER })
        ]);
        check('قرار ①: قراءات العمليات الست تبقى مفتوحة لـ viewer (لا 403)', reads.every(r => r.status !== 403), reads.map(r => r.status).join(','));

        // ② كل مفتاح يفتح مساراته فقط — لا تسلل
        console.log('\n🔑 عزل المفاتيح (كل مجس يحمل مفتاحًا واحدًا):');
        // مسارات تمثيلية لكل مفتاح (تجتاز البوابة ≠403)
        const OWN = {
            'probe-comp': [['POST', '/api/shift-completion', { shiftType: 'صباحية', shiftDate: '2026-08-17', teams: [] }]],
            'probe-disp': [['POST', '/api/report', { center: 'الخالدية', unit: 'جنوب 2' }]],
            'probe-depl': [['POST', '/api/peak-plans', { title: 'مجس', location: 'مجس' }]],
            'probe-forms': [['POST', '/api/e-cases', { probe: true }]],
            'probe-exit': [['POST', '/api/signouts', { team: 'A1', members: ['مجس'] }]],
            'probe-vol': [['POST', '/api/staffing/volunteer', { employeeCode: '999001', employeeName: 'مجس' }]],
            'probe-veh': [['POST', '/api/vehicles/events', { vehicleId: 1, eventType: 'probe' }]],
            'probe-files': [['POST', '/api/upload-doc', { probe: true }]],
            'probe-alerts': [['POST', '/api/shifts/alerts/1/acknowledge', {}]],
            'probe-revert': [['POST', '/api/undo', { center: 'الخالدية', unit: 'جنوب 2' }]],
            'probe-detail': [['POST', '/api/report-entry', { probe: true }]],
            'probe-wfappr': [['POST', '/api/workflow/version/1/approve', {}]]
        };
        for (const [uid] of PROBES) {
            const results = [];
            for (const [m, p, b] of OWN[uid]) {
                const r = await api(p, { method: m, token: TK[uid], body: b });
                results.push(r.status !== 403);
            }
            check(uid + ': مساره يجتاز البوابة (≠403)', results.every(Boolean), '');
        }
        // التسلل: كل مجس على مسارات الآخرين التمثيلية ← 403
        const CROSS = [
            ['probe-comp', [['POST', '/api/report', {}], ['POST', '/api/peak-plans', {}], ['POST', '/api/e-cases', {}], ['POST', '/api/signouts', {}], ['POST', '/api/vehicles/events', {}], ['POST', '/api/undo', {}]]],
            ['probe-disp', [['POST', '/api/shift-completion', {}], ['POST', '/api/peak-plans', {}]]],
            ['probe-depl', [['POST', '/api/shift-completion', {}], ['POST', '/api/report', {}]]],
            ['probe-forms', [['POST', '/api/shift-completion', {}], ['POST', '/api/report', {}], ['POST', '/api/signouts', {}]]],
            ['probe-exit', [['POST', '/api/shift-completion', {}], ['POST', '/api/report', {}]]],
            ['probe-veh', [['POST', '/api/shift-completion', {}], ['POST', '/api/signouts', {}]]],
            ['probe-wfappr', [['POST', '/api/shift-completion', {}], ['POST', '/api/report', {}], ['POST', '/api/peak-plans', {}], ['POST', '/api/e-cases', {}], ['POST', '/api/signouts', {}], ['POST', '/api/vehicles/events', {}]]]
        ];
        for (const [uid, routes] of CROSS) {
            const codes = [];
            for (const [m, p, b] of routes) { const r = await api(p, { method: m, token: TK[uid], body: b }); codes.push(r.status); }
            check(uid + ': مسارات الآخرين كلها 403 (لا تسلل)', codes.every(c => c === 403), codes.join(','));
        }

        // ③ تنفيذ فعلي حقيقي بمفتاح واحد
        console.log('\n🧪 تنفيذ فعلي حقيقي:');
        const realComp = await api('/api/shift-completion', { method: 'POST', token: TK['probe-comp'], body: { shiftType: 'صباحية', shiftDate: '2026-08-17', teams: [] } });
        check('ops.completion: حفظ تكميل فعلي ناجح (200 + success)', realComp.status === 200 && realComp.data && realComp.data.success === true, JSON.stringify(realComp.data || {}).slice(0, 120));
        const realDisp = await api('/api/report', { method: 'POST', token: TK['probe-disp'], body: { center: 'الخالدية', unit: 'جنوب 2' } });
        check('ops.dispatch: توزيع بلاغ فعلي يجتاز البوابة والمنطق', realDisp.status !== 403 && realDisp.status !== 500, 'status=' + realDisp.status);

        // ④ ops.execute القديم لا يفتح شيئًا
        console.log('\n🕰️ المفتاح القديم (role=user ← ops.execute):');
        const leg1 = await api('/api/shift-completion', { method: 'POST', token: T_LEGACY, body: {} });
        const leg2 = await api('/api/report', { method: 'POST', token: T_LEGACY, body: {} });
        const leg3 = await api('/api/e-cases', { method: 'POST', token: T_LEGACY, body: {} });
        check('ops.execute legacy: التكميل والتوزيع والنماذج كلها 403', leg1.status === 403 && leg2.status === 403 && leg3.status === 403, [leg1.status, leg2.status, leg3.status].join(','));

        // ⑤ الأدوار المعتمدة
        console.log('\n👤 الأدوار:');
        const opComp = await api('/api/shift-completion', { method: 'POST', token: T_OP, body: { shiftType: 'صباحية', shiftDate: '2026-08-17', teams: [] } });
        const opDisp = await api('/api/report', { method: 'POST', token: T_OP, body: {} });
        const opDepl = await api('/api/peak-plans', { method: 'POST', token: T_OP, body: {} });
        const opForm = await api('/api/e-cases', { method: 'POST', token: T_OP, body: {} });
        check('operator: التكميل+التوزيع+التمركزات+النماذج تجتاز (≠403)', [opComp, opDisp, opDepl, opForm].every(r => r.status !== 403), [opComp.status, opDisp.status, opDepl.status, opForm.status].join(','));
        const opApprove = await api('/api/workflow/version/1/approve', { method: 'POST', token: T_OP, body: {} });
        const opUsers = await api('/api/permissions/grant', { method: 'POST', token: T_OP, body: {} });
        const opSched = await api('/api/shift-roster', { token: T_OP });
        const opSymbols = await api('/api/schedule-symbols', { method: 'POST', token: T_OP, body: {} });
        check('operator: اعتماد سير العمل+إدارة المستخدمين+الرموز+الجداول ← 403', opApprove.status === 403 && opUsers.status === 403 && opSched.status === 403 && opSymbols.status === 403, [opApprove.status, opUsers.status, opSched.status, opSymbols.status].join(','));
        const flComp = await api('/api/shift-completion', { method: 'POST', token: T_FL, body: { shiftType: 'صباحية', shiftDate: '2026-08-17', teams: [] } });
        const flApprove = await api('/api/workflow/version/1/approve', { method: 'POST', token: T_FL, body: {} });
        const flUsers = await api('/api/permissions/grant', { method: 'POST', token: T_FL, body: {} });
        check('field_leadership: التكميل ✅ + اعتماد سير العمل يجتاز (≠403) + إدارة المستخدمين 403', flComp.status !== 403 && flApprove.status !== 403 && flUsers.status === 403, [flComp.status, flApprove.status, flUsers.status].join(','));
        const sysComp = await api('/api/shift-completion', { method: 'POST', token: T_SYS, body: { shiftType: 'صباحية', shiftDate: '2026-08-17', teams: [] } });
        const sysApprove = await api('/api/workflow/version/1/approve', { method: 'POST', token: T_SYS, body: {} });
        const sysClear = await api('/api/shift-roster/clear', { method: 'POST', token: T_SYS, body: {} });
        check('sysadmin (*): التكميل والاعتماد والمسح كلها تجتاز', sysComp.status !== 403 && sysApprove.status !== 403 && sysClear.status !== 403, [sysComp.status, sysApprove.status, sysClear.status].join(','));

        // ⑥ workflow.approve وحدها لا تمنح تشغيلًا — غطّيناها في CROSS أعلاه (probe-wfappr)
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) { } }
    }

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + (passed + failed));
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); process.exit(1); }
    process.exit(0);
})();
