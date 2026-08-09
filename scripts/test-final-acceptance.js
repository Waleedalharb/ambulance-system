/**
 * Final Acceptance Test — البند ⑤: اختبار القبول النهائي الشامل لتوحيد الجدول
 * ═══════════════════════════════════════════════════════════════════════════
 * المسار التشغيلي كاملًا من الطرف للطرف على قاعدة معزولة طازجة (PORT 3088)
 * مع JSON مسموم عمدًا في DATA_DIR (اسم مزيف + رموز ZZZ) لإثبات أن لا JSON
 * ولا Cache ولا مسار قديم يستطيع عرض بيانات مختلفة:
 *
 *  ① تعديل خلية → يثبت بعد إعادة الجلب (Refresh)
 *  ② JSON المسموم لا يظهر في البحث (اسم مزيف معدوم + ZZZ معدوم)
 *  ③ البحث بالاسم والكود يعطيان نفس الموظف
 *  ④ بطاقة الموظف تطابق الجدول حرفيًا
 *  ⑤ التكميل يعرض الكادر الصحيح من المصدر نفسه
 *  ⑥ نقل الموظف (يوم واحد) لا يغيّر السجلات خارج نطاقه
 *  ⑦ الاستيراد المتعارض: لا كتابة قبل التأكيد، واستبدال موثّق بعده
 *  ⑧ PDF يطابق الجدول (N12 ظاهر، ZZZ غائب)
 *  ⑨ رموز المناوبات الحالية كما هي (لا DAY/NIGHT/OFF)
 *  ⑩ Pattern A/B/C/D لا تختلط مع الرموز اليومية (ربط نمط لا يمس roster)
 *  ⑪ Clear All: مسح + تحييد JSON المسموم + لا بعث + القناة حيّة بعده
 *
 * التشغيل (من جذر المشروع):  node scripts/test-final-acceptance.js
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3088;
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
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'final-accept-'));
    // JSON مسموم: يدّعي أن F001 اسمه «اسم مزيف لا يوجد» ورموزه ZZZ طوال الشهر
    const poison = [{
        id: 'F001', employeeNumber: 'F001', name: 'اسم مزيف لا يوجد',
        jobTitle: 'مسعف', team: 'جنوب 1',
        schedule: [{ date: 'POISON', shiftCode: 'ZZZ', location: 'جنوب 1' }]
    }];
    fs.writeFileSync(path.join(TMP_DIR, 'schedule-employees.json'), JSON.stringify(poison, null, 2));
    serverProc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, DB_PATH: path.join(TMP_DIR, 'test.db'), DATA_DIR: TMP_DIR, PORT: String(PORT) },
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
        setTimeout(resolve, 5000);
    });
}

function extractPdfText(pdfPath) {
    const py = 'import sys\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\nprint("\\n".join((p.extract_text() or "") for p in r.pages))';
    const out = spawnSync('python', ['-c', py, pdfPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (out.status !== 0) throw new Error('فشل استخراج نص PDF');
    return out.stdout || '';
}

async function main() {
    console.log('\n═══════════════════════════════════════════════');
    console.log(' اختبار القبول النهائي — توحيد الجدول الكلاسيكي @ ' + BASE);
    console.log('═══════════════════════════════════════════════\n');
    startServer();
    TOKEN = await waitForServer();
    record('إقلاع الخادم المعزول + JSON مسموم مزروع في DATA_DIR', !!TOKEN);

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const mm = String(month).padStart(2, '0');
    const ym = `${year}-${mm}`;
    const dayStr = (d) => `${year}-${mm}-${String(d).padStart(2, '0')}`;
    const todayDay = now.getDate();

    // ─── تجهيز ───
    const teams = ((await api('GET', '/api/teams')).data || {}).teams || [];
    const team1 = teams.find(t => t.name === 'جنوب 1');
    const team2 = teams.find(t => t.name === 'جنوب 2');
    if (!team1 || !team2) throw new Error('الفرق المزروعة غير موجودة');
    const mkEmp = async (code, name) => {
        const r = await api('POST', '/api/employees', { employee_code: code, name, job_title: 'مسعف' });
        if (!r.data || !r.data.id) throw new Error('فشل إنشاء موظف ' + code);
        return r.data.id;
    };
    const f1 = await mkEmp('F001', 'قبول أحمد');
    const f2 = await mkEmp('F002', 'قبول بدر');
    for (let d = 1; d <= 28; d++) {
        await api('POST', '/api/shift-roster', { employee_id: f1, team_id: team1.id, shift_date: dayStr(d), shift_code: 'D12', month, year });
    }
    await api('POST', '/api/team-assignments', { employee_id: f1, team_id: team1.id, assigned_date: dayStr(1) });
    record('تجهيز: F001 (28 يوم D12 جنوب 1 + تعيين) + F002', true);

    const gridMap = async () => {
        const r = ((await api('GET', `/api/shift-roster?month=${month}&year=${year}`)).data || {}).roster || [];
        const m = {};
        r.forEach(row => { m[row.employee_id + '|' + row.shift_date] = row; });
        return m;
    };

    // ═══ ① تعديل خلية → يثبت بعد Refresh ═══
    // يوم 12 (وليس اليوم) حتى يبقى كود اليوم D12 نهاريًا ويظهر في تكميل الصباح ⑤
    const cell = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'F001', date: dayStr(12), shiftCode: 'N12' });
    const g1 = await gridMap();
    record('① تعديل خلية F001 يوم 12 (D12←N12) يثبت بعد إعادة الجلب',
        cell.status === 200 && g1[f1 + '|' + dayStr(12)] && g1[f1 + '|' + dayStr(12)].shift_code === 'N12',
        'stored=' + (g1[f1 + '|' + dayStr(12)] && g1[f1 + '|' + dayStr(12)].shift_code));

    // ═══ ② JSON المسموم لا يظهر ═══
    const fakeSearch = await api('GET', '/api/employees/search?q=' + encodeURIComponent('اسم مزيف'));
    const realSearch = await api('GET', '/api/employees/search?q=' + encodeURIComponent('قبول أحمد'));
    record('② JSON المسموم معدوم الأثر: الاسم المزيف لا يُجد والحقيقي يُجد من القاعدة',
        fakeSearch.status === 200 && (fakeSearch.data.results || []).length === 0
        && (realSearch.data.results || []).some(r => r.employee_code === 'F001' && r.name === 'قبول أحمد'),
        'fake=' + (fakeSearch.data.results || []).length + ' real=' + (realSearch.data.results || []).length);

    // ═══ ③ البحث بالاسم والكود = نفس الموظف ═══
    const byCode = await api('GET', '/api/employees/search?q=F001');
    const nameHit = (realSearch.data.results || []).find(r => r.employee_code === 'F001');
    const codeHit = (byCode.data.results || []).find(r => r.employee_code === 'F001');
    record('③ البحث بالاسم والكود الوظيفي يعطيان نفس الموظف',
        !!(nameHit && codeHit && nameHit.id === codeHit.id && codeHit.name === 'قبول أحمد'),
        'id=' + (codeHit && codeHit.id));

    // ═══ ④ بطاقة الموظف تطابق الجدول ═══
    const prof = await api('GET', '/api/employees/F001/profile');
    const profMap = {};
    ((prof.data && prof.data.roster) || []).forEach(r => { profMap[r.shift_date] = r.shift_code; });
    const g2 = await gridMap();
    let matchCount = 0, mismatch = 0;
    for (let d = 1; d <= 28; d++) {
        const ds = dayStr(d);
        const gridRow = g2[f1 + '|' + ds];
        if (gridRow && profMap[ds] === gridRow.shift_code) matchCount++;
        else mismatch++;
    }
    record('④ بطاقة الموظف تطابق الجدول حرفيًا (28/28 يومًا)',
        prof.status === 200 && matchCount === 28 && mismatch === 0 && profMap[dayStr(12)] === 'N12',
        'match=' + matchCount + ' mismatch=' + mismatch);

    // ═══ ⑤ التكميل يعرض الكادر من المصدر نفسه ═══
    const start = await api('POST', '/api/start-new-shift', { shiftType: 'صباح' });
    const shiftId = start.data && start.data.shiftId;
    const comp = shiftId ? await api('GET', `/api/shift-completion/${shiftId}/${encodeURIComponent('جنوب 1')}`) : { status: 0 };
    const members = (comp.data && (comp.data.paramedics || (comp.data.completion && comp.data.completion.paramedics))) || [];
    record('⑤ التكميل يعرض F001 ضمن كادر جنوب 1 (من القاعدة نفسها)',
        !!shiftId && comp.status === 200 && members.some(m => String(m.employee_code) === 'F001' || String(m.code) === 'F001'),
        'shift=' + shiftId + ' members=' + members.length);

    // ═══ ⑥ نقل الموظف ليوم واحد — لا يغيّر ما خارج النطاق ═══
    const tDay = await api('POST', '/api/employees/F001/transfer', { teamId: team2.id, scope: 'day', date: dayStr(15) });
    const g3 = await gridMap();
    const outsideOk =
        g3[f1 + '|' + dayStr(12)] && g3[f1 + '|' + dayStr(12)].shift_code === 'N12' && g3[f1 + '|' + dayStr(12)].team_id === team1.id &&
        g3[f1 + '|' + dayStr(14)] && g3[f1 + '|' + dayStr(14)].team_id === team1.id &&
        g3[f1 + '|' + dayStr(16)] && g3[f1 + '|' + dayStr(16)].team_id === team1.id &&
        g3[f1 + '|' + dayStr(20)] && g3[f1 + '|' + dayStr(20)].team_id === team1.id;
    record('⑥ نقل يوم 15 لجنوب 2: أيام 12/14/16/20 لم تتغير إطلاقًا',
        tDay.status === 200 && !!outsideOk,
        'transfer=' + tDay.status);

    // ═══ ⑦ الاستيراد المتعارض: لا كتابة قبل التأكيد ═══
    await api('POST', '/api/employees/F002/transfer', { teamId: team2.id, scope: 'from-date', date: dayStr(1) });
    // حمولة الاستيراد تُبنى من حالة القاعدة الحالية (كما يفعل العميل الحقيقي)
    const teamName = (tid) => tid === team1.id ? 'جنوب 1' : (tid === team2.id ? 'جنوب 2' : '');
    const currentRows = Object.values(g3).filter(r => r.employee_id === f1)
        .map(r => ({ employee_code: 'F001', team_name: teamName(r.team_id), shift_date: r.shift_date, shift_code: r.shift_code }));
    const importPayload = (confirm) => ({
        employees: [
            { employee_code: 'F001', name: 'قبول أحمد', job_title: 'مسعف', team_name: 'جنوب 1' },
            { employee_code: 'F002', name: 'قبول بدر', job_title: 'مسعف', team_name: 'جنوب 1' }
        ],
        roster: currentRows.concat([{ employee_code: 'F002', team_name: 'جنوب 1', shift_date: dayStr(3), shift_code: 'D12' }]),
        month, year, ...(confirm ? { confirmOverwriteManual: true } : {})
    });
    const imp409 = await api('POST', '/api/shift-roster/import', importPayload(false));
    const conf0 = imp409.data && imp409.data.conflicts && imp409.data.conflicts[0];
    const assignAfter = (((await api('GET', '/api/team-assignments/employee/' + f2)).data || {}).assignments) || [];
    const openAfter = assignAfter.find(a => !a.end_date);
    const g4 = await gridMap();
    record('⑦ استيراد متعارض → 409 بلا أي كتابة (التعيين والجدول كما هما)',
        imp409.status === 409 && conf0 && conf0.manualTeam === 'جنوب 2'
        && openAfter && openAfter.source === 'manual' && openAfter.team_id === team2.id
        && !(g4[f2 + '|' + dayStr(3)]),
        'status=' + imp409.status);
    const impOk = await api('POST', '/api/shift-roster/import', importPayload(true));
    record('⑦ب تأكيد صريح → استبدال موثّق (manualOverwritten=1) وكتابة الصف',
        impOk.status === 200 && impOk.data.rosterSync && impOk.data.rosterSync.manualOverwritten === 1,
        'status=' + impOk.status);

    // ═══ ⑧ PDF يطابق الجدول ═══
    const pdf = await fetch(BASE + `/api/schedule/pdf?center=${encodeURIComponent('جنوب 1')}&month=${ym}`,
        { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    let pdfOk = false, n12InPdf = 0, zzzInPdf = 0;
    if (pdf.status === 200) {
        const pdfPath = path.join(TMP_DIR, 'accept.pdf');
        fs.writeFileSync(pdfPath, pdfBuf);
        const text = extractPdfText(pdfPath);
        n12InPdf = (text.match(/N12/g) || []).length;
        zzzInPdf = (text.match(/ZZZ/g) || []).length;
        pdfOk = pdfBuf.slice(0, 4).toString() === '%PDF' && n12InPdf > 0 && zzzInPdf === 0;
    }
    record('⑧ PDF جنوب 1 يطابق الجدول: N12 ظاهر وZZZ المسموم غائب',
        pdf.status === 200 && pdfOk,
        'status=' + pdf.status + ' N12=' + n12InPdf + ' ZZZ=' + zzzInPdf);

    // ═══ ⑨ رموز المناوبات الحالية كما هي ═══
    const codes = ((await api('GET', '/api/shift-codes')).data || {}).codes || [];
    const codeList = codes.map(c => c.code);
    const hasOriginals = ['D12', 'N12', 'WO', 'O12'].every(c => codeList.includes(c));
    const hasTranslated = ['DAY', 'NIGHT', 'OFF'].some(c => codeList.includes(c));
    record('⑨ الرموز الحالية كما هي (D12/N12/WO/O12 موجودة، لا DAY/NIGHT/OFF)',
        hasOriginals && !hasTranslated,
        'count=' + codeList.length);

    // ═══ ⑩ Pattern لا تختلط مع الرموز اليومية ═══
    const gBefore = await gridMap();
    const f2RowBefore = gBefore[f2 + '|' + dayStr(3)];
    const setPat = await api('PUT', '/api/employees/F002/pattern', { patternCode: 'A' });
    const profF2 = await api('GET', '/api/employees/F002/profile');
    const gAfter = await gridMap();
    const f2RowAfter = gAfter[f2 + '|' + dayStr(3)];
    const rosterUntouched = JSON.stringify(f2RowBefore) === JSON.stringify(f2RowAfter);
    record('⑩ ربط نمط A بـ F002: pattern_code=A وروster لم يُمسّ إطلاقًا',
        setPat.status === 200 && profF2.data && profF2.data.employee.patternCode === 'A' && rosterUntouched,
        'pattern=' + (profF2.data && profF2.data.employee && profF2.data.employee.patternCode) + ' roster=' + (rosterUntouched ? 'ثابت' : 'تغير!'));

    // ═══ ⑪ Clear All: مسح + تحييد JSON المسموم + لا بعث + القناة حيّة ═══
    const clr = await api('POST', '/api/shift-roster/clear-all');
    const rosterAfterClear = ((await api('GET', '/api/shift-roster')).data || {}).roster || [];
    let jsonNeutral = false;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(TMP_DIR, 'schedule-employees.json'), 'utf8'));
        jsonNeutral = Array.isArray(j) && j.length === 0;
    } catch (_) { jsonNeutral = false; }
    const jsonGet = await api('GET', '/api/schedule/employees');
    record('⑪ Clear All: roster فارغ + JSON المسموم حُيّد ([]) + GET يعيد [] — لا بعث',
        clr.status === 200 && rosterAfterClear.length === 0 && jsonNeutral
        && jsonGet.data && Array.isArray(jsonGet.data.employees) && jsonGet.data.employees.length === 0,
        'roster=' + rosterAfterClear.length + ' json=' + (jsonNeutral ? '[]' : 'غير محيَّد!'));

    const reimport = await api('POST', '/api/shift-roster/import', {
        employees: [{ employee_code: 'F001', name: 'قبول أحمد', job_title: 'مسعف', team_name: 'جنوب 1' }],
        roster: [1, 2, 3, 4, 5].map(d => ({ employee_code: 'F001', team_name: 'جنوب 1', shift_date: dayStr(d), shift_code: 'D12' })),
        month, year
    });
    const rosterFinal = ((await api('GET', '/api/shift-roster')).data || {}).roster || [];
    record('⑪ب إعادة الاستيراد بعد المسح: القناة حيّة والبيانات تعود من القاعدة فقط',
        reimport.status === 200 && rosterFinal.length === 5,
        'roster=' + rosterFinal.length);

    // ─── الملخص ───
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    console.log('\n═══════════════════════════════════════════════');
    console.log(` النتيجة النهائية: ${passed}/${results.length} ${failed.length === 0 ? '— قبول كامل ✅' : '— فشل ❌'}`);
    failed.forEach(f => console.log('   ❌ ' + f.name));
    console.log('═══════════════════════════════════════════════');
    await stopServer();
    try { if (TMP_DIR) fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    process.exit(failed.length === 0 ? 0 : 1);
}

process.on('SIGINT', async () => { await stopServer(); process.exit(130); });

main().catch(async err => {
    console.error('❌ فشل تشغيل الاختبار:', err.message);
    if (serverProc && serverProc._log) console.error(serverProc._log().slice(-1200));
    await stopServer();
    process.exit(1);
});
