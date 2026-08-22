/**
 * اختبار «إجمالي أعمال العمليات = مجموع المؤشرات التسعة فقط» — contribution-ops-total-test.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * تحديث المواصفة 2026-08-15 (سلال العمليات التسع):
 *   التكميل · توزيع البلاغات · البلاغات · التراجع · البلاغات التفصيلية ·
 *   التمركزات · خروج الفرق · النماذج · سير العمل
 *
 * يعمل على نسخة قاعدة بيانات مؤقتة (DB_PATH) — لا يلمس القاعدة الأصلية:
 *   1) node .tmp-copydb.js  (أو VACUUM INTO لأي نسخة)
 *   2) PORT=3080 DB_PATH=<copy> node server.js
 *   3) DB_PATH=<copy> node scripts/contribution-ops-total-test.js
 *
 * القسم أ: بيانات حقيقية (أغسطس + يوليو 2026) — كل موظف عمليات: الإجمالي = مجموع التسعة.
 * القسم ب: حقن اصطناعي على النسخة لموظف 4252 — حدث واحد أو أكثر من كل نوع من التسعة
 *          (+ أفعال مستبعدة) ويتحقق من الدلتا حقلًا بحقل وأن المستبعد لا يحرك الإجمالي.
 * خروج غير صفري عند أي فشل.
 */

const Database = require('better-sqlite3');

const BASE = process.env.BASE_URL || 'http://localhost:3080';
const DBP = process.env.DB_PATH;
if (!DBP) { console.error('❌ DB_PATH مطلوب (نسخة القاعدة المؤقتة)'); process.exit(1); }

const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const NINE = (w) => w.completions + w.dispatchActions + w.reports + w.dispatchUndo
    + w.detailedReports + w.positioning.total + w.signouts + w.forms.total + w.workflowActions.total;

async function api(path, token) {
    const res = await fetch(BASE + path, { headers: { 'Authorization': 'Bearer ' + token } });
    return { status: res.status, data: await res.json() };
}

async function main() {
    // ── دخول admin ──
    const login = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '4252', password: '4252' })
    }).then(r => r.json());
    const TOKEN = login.accessToken;
    if (!TOKEN) { console.error('❌ فشل الدخول'); process.exit(1); }

    // ═══ القسم أ: بيانات حقيقية — الإجمالي = مجموع التسعة لكل موظف عمليات ═══
    const coverage = { completions: 0, dispatchActions: 0, reports: 0, dispatchUndo: 0, detailedReports: 0, positioning: 0, signouts: 0, forms: 0, workflow: 0 };
    for (const mm of ['8', '7']) {
        const { data } = await api('/api/indicators/contribution?year=2026&month=' + mm, TOKEN);
        let allOk = true, checked = 0;
        for (const e of data.groups.operations) {
            checked++;
            if (e.totalWorks !== NINE(e.works)) allOk = false;
            const w = e.works;
            if (w.completions > 0) coverage.completions++;
            if (w.dispatchActions > 0) coverage.dispatchActions++;
            if (w.reports > 0) coverage.reports++;
            if (w.dispatchUndo > 0) coverage.dispatchUndo++;
            if (w.detailedReports > 0) coverage.detailedReports++;
            if (w.positioning.total > 0) coverage.positioning++;
            if (w.signouts > 0) coverage.signouts++;
            if (w.forms.total > 0) coverage.forms++;
            if (w.workflowActions.total > 0) coverage.workflow++;
        }
        record(`أ${mm === '8' ? '1' : '2'}: بيانات حقيقية 2026-${mm.padStart(2, '0')} — الإجمالي = مجموع التسعة لكل موظف عمليات`, allOk, `${checked} موظفًا`);
    }

    // ═══ القسم ب: حقن اصطناعي على النسخة — حدث من كل نوع لموظف واحد ═══
    const before = (await api('/api/indicators/contribution?year=2026&month=8', TOKEN)).data;
    const b4252 = before.groups.operations.find(e => e.employeeCode === '4252');

    const db = new Database(DBP);
    db.pragma('busy_timeout = 5000');
    const A = 'emp-4252'; // مفتاح الفاعل لموظف 4252 (صيغة users.json — موثق في الخدمة)
    const ts = '2026-08-15T10:00:00.000Z';
    const insAudit = db.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)');
    const audits = [
        ['completion_saved', 2], ['report_created', 3], ['تسجيل بلاغ', 4],
        ['report_undone', 1], ['report_entry_added', 2], ['report_entry_deleted', 1],
        // أفعال مستبعدة من التسعة — يجب ألا تحرك إجمالي العمليات:
        ['doc_uploaded', 5], ['shift_cell_update', 5], ['shift_started', 3]
    ];
    for (const [action, c] of audits) for (let i = 0; i < c; i++) insAudit.run(A, 'اختبار', action, 'synthetic', 'test', ts);
    const insPos = db.prepare('INSERT INTO positioning_events (shift_id, plan_id, event_type, changed_fields, payload, actor_id, actor_name, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)');
    insPos.run('t1', 'created', '{}', '{}', A, 'اختبار', ts); insPos.run('t2', 'created', '{}', '{}', A, 'اختبار', ts); insPos.run('t3', 'updated', '{}', '{}', A, 'اختبار', ts);
    db.prepare('INSERT INTO shift_signout_events (shift_id, shift_date, shift_type, event_type, team, members, notes, actor_id, actor_name, created_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)')
        .run(0, '2026-08-15', 'signout', 'فريق اختبار', '[]', A, 'اختبار', ts);
    const insForm = db.prepare('INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by, created_at) VALUES (NULL, ?, ?, NULL, ?, ?)');
    insForm.run('T-1', 'نموذج اختبار', '4252', ts); insForm.run('T-2', 'نموذج اختبار', '4252', ts);
    db.prepare('INSERT INTO workflow_audit_log (workflow_id, version_no, action, actor_id, actor_name, at, details_json) VALUES (?, NULL, ?, ?, ?, ?, NULL)')
        .run('WF-TEST', 'create', A, 'اختبار', ts);
    db.close();

    const after = (await api('/api/indicators/contribution?year=2026&month=8', TOKEN)).data;
    const a4252 = after.groups.operations.find(e => e.employeeCode === '4252');
    const deltas = {
        completions: [2, a4252.works.completions - b4252.works.completions],
        dispatchActions: [3, a4252.works.dispatchActions - b4252.works.dispatchActions],
        reports: [4, a4252.works.reports - b4252.works.reports],
        dispatchUndo: [1, a4252.works.dispatchUndo - b4252.works.dispatchUndo],
        detailedReports: [3, a4252.works.detailedReports - b4252.works.detailedReports],
        positioning: [3, a4252.works.positioning.total - b4252.works.positioning.total],
        signouts: [1, a4252.works.signouts - b4252.works.signouts],
        forms: [2, a4252.works.forms.total - b4252.works.forms.total],
        workflow: [1, a4252.works.workflowActions.total - b4252.works.workflowActions.total]
    };
    let fieldsOk = true;
    for (const k of Object.keys(deltas)) {
        const [exp, got] = deltas[k];
        if (exp !== got) { fieldsOk = false; console.log(`   ✗ ${k}: متوقع +${exp} فعلي +${got}`); }
    }
    record('ب1: موظف لديه الأنواع التسعة في نفس الشهر — كل سلة ازدادت بدلالتها بالضبط', fieldsOk);

    const totalDelta = a4252.totalWorks - b4252.totalWorks;
    record('ب2: دلتا الإجمالي = مجموع دلتا التسعة (+20) رغم حقن 13 فعلًا مستبعدًا (ملفات/جداول/دورة مناوبة)', totalDelta === 20, `دلتا فعلية +${totalDelta}`);
    record('ب3: الإجمالي بعد الحقن = مجموع التسعة', a4252.totalWorks === NINE(a4252.works));

    // ── ملخص التغطية على البيانات الحقيقية + الاصطناعية ──
    console.log('\n── تغطية المؤشرات (عدد موظفي العمليات أصحاب قيم >0 في أغسطس/يوليو الحقيقيين) ──');
    console.log('   تكميل:', coverage.completions, '| توزيع:', coverage.dispatchActions, '| بلاغات:', coverage.reports,
        '| تراجع:', coverage.dispatchUndo, '| تفصيلية:', coverage.detailedReports, '| تمركزات:', coverage.positioning,
        '| خروج فرق:', coverage.signouts, '| نماذج:', coverage.forms, '| سير عمل:', coverage.workflow);
    console.log('   (التراجع والتفصيلية والنماذج صفر حقيقيًا — غطاها الحقن الاصطناعي في القسم ب)');

    const failed = results.filter(r => !r.ok).length;
    console.log(`\n═══ الملخص: ${results.length - failed}/${results.length} ناجح ═══`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('❌ خطأ تشغيل:', e.message); process.exit(1); });
