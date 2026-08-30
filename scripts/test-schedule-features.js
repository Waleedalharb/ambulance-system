/**
 * Schedule Features Test — أنماط A/B/C/D + تعديل الخلية + النقل + حماية اليدوي
 * ═══════════════════════════════════════════════════════════════════════════
 * يعمل ضد خادم معزول تمامًا: قاعدة SQLite مؤقتة (DB_PATH) ومجلد بيانات
 * مؤقت (DATA_DIR — يُنشئ users.json افتراضيًا مع admin 4252/4252).
 * لا يمس database.db ولا data/ الحقيقية إطلاقًا.
 *
 * التشغيل (يُشغَّل من جذر المشروع):
 *   node scripts/test-schedule-features.js
 * السكربت يُشغّل الخادم المعزول بنفسه على PORT 3085 ويوقفه عند الانتهاء.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3085;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const results = [];
let TOKEN = null;
let serverProc = null;
let TMP_DIR = null;

function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, p, body) {
    const opts = { method, headers: {} };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + p, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-json */ }
    return { status: res.status, data };
}

function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

async function waitForServer(timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const res = await fetch(BASE + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: '4252', password: '4252' })
            });
            if (res.status === 200) {
                const data = await res.json();
                if (data && data.accessToken) return data.accessToken;
            }
        } catch (_) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 800));
    }
    throw new Error('انتهت مهلة انتظار الخادم المعزول');
}

function startServer() {
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-features-'));
    const dbPath = path.join(TMP_DIR, 'test.db');
    serverProc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, DB_PATH: dbPath, DATA_DIR: TMP_DIR, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    serverProc.stdout.on('data', c => { buf += c.toString(); });
    serverProc.stderr.on('data', c => { buf += c.toString(); });
    serverProc._log = () => buf;
}

function stopServer() {
    return new Promise(resolve => {
        if (!serverProc) return resolve();
        serverProc.once('exit', () => resolve());
        try { serverProc.kill(); } catch (_) { resolve(); }
        setTimeout(resolve, 5000); // لا ننتظر أكثر من 5 ثوانٍ
    });
}

async function main() {
    console.log(`\n═══ Schedule Features Test @ ${BASE} (قاعدة معزولة) ═══\n`);
    startServer();
    TOKEN = await waitForServer();
    record('إقلاع الخادم المعزول + تسجيل الدخول admin', !!TOKEN);

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const mm = String(month).padStart(2, '0');
    const todayStr = localDateStr(now);
    const dayStr = (d) => `${year}-${mm}-${String(d).padStart(2, '0')}`;
    const prevDayStr = localDateStr(new Date(now.getTime() - 24 * 3600 * 1000));

    // ─── تجهيز: فرقتان + موظفون ───
    const teamsRes = await api('GET', '/api/teams');
    const teams = (teamsRes.data && teamsRes.data.teams) || [];
    const team1 = teams.find(t => t.name === 'جنوب 1');
    const team2 = teams.find(t => t.name === 'جنوب 2');
    record('الفرق المزروعة موجودة (جنوب 1 / جنوب 2)', !!(team1 && team2));
    if (!team1 || !team2) throw new Error('الفرق الافتراضية غير موجودة');

    const mkEmp = async (code, name, phone) => {
        const r = await api('POST', '/api/employees', { employee_code: code, name, phone: phone || null, job_title: 'مسعف' });
        if (!r.data || !r.data.id) throw new Error('فشل إنشاء موظف ' + code + ': ' + JSON.stringify(r.data));
        return r.data.id;
    };
    const e1 = await mkEmp('T001', 'اختبار أحمد', '0500000001');
    const e2 = await mkEmp('T002', 'اختبار بدر', null);
    const e3 = await mkEmp('T003', 'اختبار جاسم', '0500000003');
    const e4 = await mkEmp('T004', 'اختبار داود', null);
    const e5 = await mkEmp('T005', 'اختبار هاني', '0500000005');
    record('إنشاء 5 موظفين تجريبيين', true);

    // مناوبات الشهر (1..28) رمز D12 على جنوب 1 لـ E1 وE2
    const mkRoster = async (empId) => {
        for (let d = 1; d <= 28; d++) {
            const r = await api('POST', '/api/shift-roster', {
                employee_id: empId, team_id: team1.id,
                shift_date: dayStr(d), shift_code: 'D12', month, year
            });
            if (!r.data || !r.data.success) throw new Error('فشل إنشاء مناوبة: ' + JSON.stringify(r.data));
        }
    };
    await mkRoster(e1);
    await mkRoster(e2);
    // تعيينات نشطة: E2 وE3 وE5 على جنوب 1
    const mkAssign = async (empId) => {
        const r = await api('POST', '/api/team-assignments', { employee_id: empId, team_id: team1.id, assigned_date: '2026-01-01' });
        if (!r.data || !r.data.success) throw new Error('فشل إنشاء تعيين: ' + JSON.stringify(r.data));
    };
    await mkAssign(e2);
    await mkAssign(e3);
    await mkAssign(e5);
    record('بذر مناوبات الشهر + تعيينات نشطة', true);

    // ═══ 1) تعديل خلية مناوبة ليوم واحد ═══
    const c10 = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'T001', date: dayStr(10), shiftCode: 'N12' });
    const c11 = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'T001', date: dayStr(11), shiftCode: 'V' });
    const c12 = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'T001', date: dayStr(12), shiftCode: 'O12' });
    record('تعديل 3 خلايا (D12→N12 / D12→V إجازة / D12→O12)',
        c10.status === 200 && c11.status === 200 && c12.status === 200
        && c10.data.entry.shift_code === 'N12' && c11.data.entry.shift_code === 'V' && c12.data.entry.shift_code === 'O12'
        && c10.data.entry.team_id === team1.id,
        `s=${c10.status},${c11.status},${c12.status}`);

    const sched1 = await api('GET', `/api/shift-roster/employee-schedule/${e1}?month=${month}&year=${year}`);
    const byDate = {};
    for (const s of (sched1.data && sched1.data.schedule) || []) byDate[s.date] = s.shift_code;
    let othersIntact = true;
    for (let d = 1; d <= 28; d++) {
        if ([10, 11, 12].includes(d)) continue;
        if (byDate[dayStr(d)] !== 'D12') { othersIntact = false; break; }
    }
    record('إعادة القراءة من القاعدة: الأيام المعدّلة جديدة وبقية الشهر D12',
        sched1.status === 200
        && byDate[dayStr(10)] === 'N12' && byDate[dayStr(11)] === 'V' && byDate[dayStr(12)] === 'O12'
        && othersIntact);

    const badCode = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'T001', date: dayStr(13), shiftCode: 'ZZZ' });
    record('رفض رمز غير موجود في shift_codes', badCode.status === 404, `status=${badCode.status}`);
    const badEmp = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'NOPE', date: dayStr(13), shiftCode: 'D12' });
    record('رفض موظف غير موجود (404 عربي)', badEmp.status === 404, `status=${badEmp.status}`);

    // خلية جديدة ليوم بلا سطر: تُنشأ مع team_id التعيين النشط
    const c29 = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'T002', date: dayStr(27), shiftCode: 'N12' });
    // (T002 له سطر يوم 27 من البذر — نختبر يوم 29 غير الموجود)
    const cNew = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'T002', date: dayStr(28), shiftCode: 'N8' });
    record('تحديث خلية موجودة يبقي team_id كما هو',
        c29.status === 200 && c29.data.entry.team_id === team1.id && c29.data.entry.shift_code === 'N12'
        && cNew.status === 200 && cNew.data.entry.shift_code === 'N8');

    // ═══ 2) نقل الموظف ببنطاقين ═══
    const tDay = await api('POST', '/api/employees/T002/transfer', { teamId: team2.id, scope: 'day', date: dayStr(15) });
    const sched2 = await api('GET', `/api/shift-roster/employee-schedule/${e2}?month=${month}&year=${year}`);
    const rows2 = (sched2.data && sched2.data.schedule) || [];
    const d15 = rows2.find(r => r.date === dayStr(15));
    const d14 = rows2.find(r => r.date === dayStr(14));
    const d16 = rows2.find(r => r.date === dayStr(16));
    const assign2 = await api('GET', `/api/team-assignments/employee/${e2}`);
    const active2 = ((assign2.data && assign2.data.assignments) || []).filter(a => !a.end_date);
    record("نقل 'day': يوم واحد يتغير والأيام السابقة/اللاحقة ثابتة ولا team_assignments",
        tDay.status === 200 && d15 && d15.team_id === team2.id
        && d14 && d14.team_id === team1.id && d16 && d16.team_id === team1.id
        && active2.length === 1 && active2[0].team_id === team1.id,
        `status=${tDay.status}`);

    const tFrom = await api('POST', '/api/employees/T003/transfer', { teamId: team2.id, scope: 'from-date', date: todayStr });
    const assign3 = await api('GET', `/api/team-assignments/employee/${e3}`);
    const all3 = (assign3.data && assign3.data.assignments) || [];
    const closed3 = all3.find(a => a.team_id === team1.id);
    const open3 = all3.find(a => !a.end_date);
    record("نقل 'from-date': إغلاق القديم باليوم السابق + فتح manual جديد",
        tFrom.status === 200 && closed3 && closed3.end_date === prevDayStr
        && open3 && open3.team_id === team2.id && open3.source === 'manual'
        && open3.assigned_date === todayStr,
        `status=${tFrom.status} closed=${closed3 && closed3.end_date} open=${open3 && open3.source}`);

    const tBadScope = await api('POST', '/api/employees/T003/transfer', { teamId: team2.id, scope: 'forever', date: todayStr });
    const tBadDate = await api('POST', '/api/employees/T003/transfer', { teamId: team2.id, scope: 'day', date: '2026-13-40' });
    const tBadTeam = await api('POST', '/api/employees/T003/transfer', { teamId: 999999, scope: 'day', date: todayStr });
    record('validation النقل: نطاق/تاريخ/فرقة مرفوضة برسائل عربية',
        tBadScope.status === 400 && tBadDate.status === 400 && tBadTeam.status === 404,
        `scope=${tBadScope.status} date=${tBadDate.status} team=${tBadTeam.status}`);

    // ═══ 6) ربط نمط A ثم النقل → النمط يبقى ═══
    const patterns = await api('GET', '/api/shift-patterns');
    const pCodes = ((patterns.data && patterns.data.patterns) || []).map(p => p.code).sort().join(',');
    record('GET /api/shift-patterns يرجع A,B,C,D بلا دورة (cycle_json=null)',
        patterns.status === 200 && pCodes === 'A,B,C,D'
        && patterns.data.patterns.every(p => p.cycle_json === null), pCodes);

    const setPat = await api('PUT', '/api/employees/T001/pattern', { patternCode: 'A' });
    const tE1 = await api('POST', '/api/employees/T001/transfer', { teamId: team2.id, scope: 'from-date', date: todayStr });
    const prof1b = await api('GET', '/api/employees/T001/profile');
    record('ربط نمط A ثم نقل from-date → pattern_code يبقى A',
        setPat.status === 200 && tE1.status === 200
        && prof1b.status === 200 && prof1b.data.employee.patternCode === 'A'
        && prof1b.data.team && prof1b.data.team.id === team2.id,
        `pattern=${prof1b.data && prof1b.data.employee && prof1b.data.employee.patternCode}`);

    const badPat = await api('PUT', '/api/employees/T001/pattern', { patternCode: 'ZZZ' });
    record('رفض نمط غير موجود', badPat.status === 404, `status=${badPat.status}`);

    // ═══ 3) ملف الموظف (SSOT) ═══
    const prof1 = await api('GET', '/api/employees/T001/profile');
    const e1p = prof1.data && prof1.data.employee;
    const rosterOk = Array.isArray(prof1.data.roster) && prof1.data.roster.length === 28
        && prof1.data.roster.every(r => r.shift_date && r.shift_code && r.shift_name && 'team_name' in r);
    record('profile موظف بجوال: كل الحقول + فريق نشط + roster الشهر بأسماء الرموز',
        prof1.status === 200 && e1p && e1p.id === e1 && e1p.code === 'T001'
        && e1p.name === 'اختبار أحمد' && e1p.phone === '0500000001'
        && e1p.jobTitle === 'مسعف' && 'symbol' in e1p && e1p.patternCode === 'A'
        && prof1.data.team && prof1.data.team.name === 'جنوب 2' && !!prof1.data.team.center
        && rosterOk && Array.isArray(prof1.data.leaves),
        `roster=${prof1.data && prof1.data.roster && prof1.data.roster.length}`);

    const prof4 = await api('GET', '/api/employees/T004/profile');
    record('profile موظف بدون جوال/فريق: phone=null وteam=null ومصفوفات فارغة',
        prof4.status === 200 && prof4.data.employee.phone === null
        && prof4.data.team === null && prof4.data.roster.length === 0
        && prof4.data.leaves.length === 0);

    const prof404 = await api('GET', '/api/employees/NOPE/profile');
    record('profile موظف غير موجود → 404 عربي',
        prof404.status === 404 && prof404.data && /غير موجود/.test(prof404.data.error || ''),
        `status=${prof404.status}`);

    // ═══ 5) الجوال في التكميل ═══
    const startShift = await api('POST', '/api/start-new-shift', { shiftType: 'صباح' });
    const curShift = await api('GET', '/api/current-shift');
    const sh = curShift.data && curShift.data.shift;
    record('بدء مناوبة للتكميل', !!(startShift.status === 200 && sh && sh.id), `shiftId=${sh && sh.id}`);
    const workCode = sh && sh.type && sh.type.includes('ليل') ? 'N12' : 'D12';
    const c5 = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'T005', date: sh.date, shiftCode: workCode });
    const st = await api('GET', `/api/staffing/state?shift_id=${sh.id}`);
    const stStr = JSON.stringify(st.data || {});
    record('/api/staffing/state يتضمن phone في members',
        c5.status === 200 && st.status === 200 && stStr.includes('0500000005'),
        `cell=${c5.status} state=${st.status} phoneFound=${stStr.includes('0500000005')}`);

    // ═══ 4) حماية التعديل اليدوي من الاستيراد (أخيرًا — يعيد بناء roster) ═══
    // E3: تعيين manual على جنوب 2 (من اختبار 2) — الاستيراد يضعه على جنوب 1 ⇒ تعارض
    // G2 (اعتماد المالك 2026-08-30): الحمولة بلا أي مدخل بتاريخ صالح أصبحت
    // مرفوضة 422 (حارس المسح الصامت) — لذا تحمل الحمولة مدخلًا صالحًا واحدًا
    // لكل موظف؛ دلالة اختبار التعارض (فرق/تعيينات) لا تتغير.
    const importPayload = (confirm) => ({
        employees: [
            { employeeNumber: 'T001', name: 'اختبار أحمد', phone: '0500000001', team: 'جنوب 2', schedule: [{ date: '2026-08-15', shiftCode: 'D12' }] },
            { employeeNumber: 'T002', name: 'اختبار بدر', team: 'جنوب 1', schedule: [{ date: '2026-08-15', shiftCode: 'D12' }] },
            { employeeNumber: 'T003', name: 'اختبار جاسم', phone: '0500000003', team: 'جنوب 1', schedule: [{ date: '2026-08-15', shiftCode: 'D12' }] },
            { employeeNumber: 'T004', name: 'اختبار داود', team: 'جنوب 1', schedule: [{ date: '2026-08-15', shiftCode: 'D12' }] },
            { employeeNumber: 'T005', name: 'اختبار هاني', phone: '0500000005', team: 'جنوب 1', schedule: [{ date: '2026-08-15', shiftCode: 'D12' }] }
        ],
        ...(confirm ? { confirmOverwriteManual: true } : {})
    });
    const imp1 = await api('POST', '/api/schedule/employees', importPayload(false));
    const conf = (imp1.data && imp1.data.conflicts) || [];
    const conf3 = conf.find(c => c.employeeCode === 'T003');
    record('استيراد متعارض بدون تأكيد → 409 + conflicts',
        imp1.status === 409 && /تعارض/.test(imp1.data && imp1.data.error || '')
        && conf3 && conf3.manualTeam === 'جنوب 2' && conf3.importTeam === 'جنوب 1',
        `status=${imp1.status} conflicts=${conf.length}`);

    const assign3b = await api('GET', `/api/team-assignments/employee/${e3}`);
    const all3b = (assign3b.data && assign3b.data.assignments) || [];
    const stillManual = all3b.find(a => !a.end_date);
    record('409 لم يكتب شيئًا: التعيين اليدوي باقٍ ولا تعيين استيراد جديد',
        stillManual && stillManual.team_id === team2.id && stillManual.source === 'manual'
        && all3b.length === 2);

    const imp2 = await api('POST', '/api/schedule/employees', importPayload(true));
    const assign3c = await api('GET', `/api/team-assignments/employee/${e3}`);
    const all3c = (assign3c.data && assign3c.data.assignments) || [];
    const newActive = all3c.find(a => !a.end_date);
    const oldManual = all3c.find(a => a.source === 'manual');
    record('مع confirmOverwriteManual → يُطبَّق: إنهاء manual + تعيين import جديد',
        imp2.status === 200 && imp2.data && imp2.data.success
        && oldManual && !!oldManual.end_date
        && newActive && newActive.team_id === team1.id && newActive.source === 'import',
        `status=${imp2.status} overwritten=${imp2.data && imp2.data.rosterSync && imp2.data.rosterSync.manualOverwritten}`);

    // استيراد غير متعارض لاحقًا يمر طبيعيًا (لا 409 زائف)
    const imp3 = await api('POST', '/api/schedule/employees', importPayload(false));
    record('استيراد مطابق للتعيينات الحالية → لا 409',
        imp3.status === 200 && imp3.data && imp3.data.success, `status=${imp3.status}`);

    // ─── الخلاصة ───
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ النتيجة: ${results.length - failed.length}/${results.length} ناجح — فشل: ${failed.length} ═══`);
    if (failed.length) {
        for (const f of failed) console.log('   ❌ ' + f.name);
    }
    return failed.length === 0;
}

main()
    .then(async ok => { await stopServer(); process.exit(ok ? 0 : 1); })
    .catch(async err => {
        console.error('\n💥 خطأ قاتل:', err.message);
        if (serverProc && serverProc._log) console.error(serverProc._log().slice(-3000));
        record('اكتمال السكربت', false);
        await stopServer();
        process.exit(1);
    });
