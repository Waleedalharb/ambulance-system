/**
 * اختبارات §13.7 — الجدول متعدد الشهور (Phase 1: Multi-Month Schedule)
 * ═══════════════════════════════════════════════════════════
 * عزل كامل بلا خادم إنتاج:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (يُضبط قبل require db.js).
 *   - الكتابة تمر عبر RosterSyncService الحقيقي (نفس نمط regression-test SR-2)
 *     بمحوّل db.js نفسه — لا SQL اختباري موازٍ للكاتب الرسمي.
 *   - pickDefaultMonth تُستخرج من مصدر smart-schedule.html وتُقيَّم في sandbox
 *     (vm) — تُختبر النسخة الفعلية المنشورة لا نسخة مكررة.
 *   - اختبار PDF (⑦) على طبقة البيانات + الخدمة مباشرة (بلا HTTP): نفس نص
 *     استعلام readScheduleEmployeesFromDB(month) في server.js حرفيًا، ثم
 *     schedule-pdf-service الفعلي لتوليد ملفي PDF والمقارنة بالبايتات.
 *
 * التشغيل: node scripts/multi-month-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** استخراج مصدر دالة من ملف بعدّ الأقواس المتزنة (أمتن من regex هش). */
function extractFunctionSource(filePath, fnName) {
    const src = fs.readFileSync(filePath, 'utf8');
    const start = src.indexOf('function ' + fnName + '(');
    if (start === -1) throw new Error(`الدالة ${fnName} غير موجودة في ${filePath}`);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`أقواس ${fnName} غير متزنة`);
}

/** تحميل pickDefaultMonth من المصدر الفعلي داخل sandbox نظيف (بلا تبعيات). */
function loadPickDefaultMonth(htmlPath) {
    const src = extractFunctionSource(htmlPath, 'pickDefaultMonth');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.pickDefaultMonth = pickDefaultMonth;', sandbox);
    if (typeof sandbox.pickDefaultMonth !== 'function') throw new Error('فشل تقييم pickDefaultMonth');
    return sandbox.pickDefaultMonth;
}

/** نسخة طبق الأصل من منطق readScheduleEmployeesFromDB(month) في server.js (~7486):
 *  نفس نص الاستعلام المفلتر بالشهر ونفس بناء نموذج الموظفين — لاختبار طبقة
 *  البيانات التي يعتمد عليها GET /api/schedule/pdf دون إقلاع الخادم. */
async function readScheduleEmployeesFromDBReplica(db, month) {
    const employees = await db.Employees.getAll();
    const teams = await db.Teams.getAll();
    const assignments = await db.TeamAssignments.getAll();
    const teamsMap = {};
    teams.forEach(t => { teamsMap[t.id] = t.name; });
    const empTeamMap = {};
    assignments.forEach(a => {
        if (!empTeamMap[a.employee_id]) empTeamMap[a.employee_id] = teamsMap[a.team_id] || '';
    });
    const empMap = {};
    employees.forEach(e => {
        if (e.is_active === 0) return;
        const code = String(e.employee_code || e.id);
        empMap[e.id] = { id: code, employeeNumber: code, name: e.name || '', jobTitle: e.job_title || '', team: empTeamMap[e.id] || '', schedule: [] };
    });
    let rows;
    if (month) {
        const y = parseInt(month.split('-')[0], 10);
        const m = parseInt(month.split('-')[1], 10);
        rows = await db.all(
            `SELECT sr.employee_id, sr.shift_date, sr.shift_code, sr.team_id, t.name AS team_name
             FROM shift_roster sr LEFT JOIN teams t ON t.id = sr.team_id
             WHERE sr.month = ? AND sr.year = ? ORDER BY sr.shift_date`, [m, y]);
    } else {
        rows = await db.all(
            `SELECT sr.employee_id, sr.shift_date, sr.shift_code, sr.team_id, t.name AS team_name
             FROM shift_roster sr LEFT JOIN teams t ON t.id = sr.team_id ORDER BY sr.shift_date`);
    }
    rows.forEach(r => {
        const emp = empMap[r.employee_id];
        if (!emp) return;
        emp.schedule.push({ date: r.shift_date, shiftCode: r.shift_code, location: r.team_name || emp.team || '', status: 'دوام' });
    });
    return Object.values(empMap);
}

async function main() {
    console.log('\n═══ اختبارات §13.7 — الجدول متعدد الشهور ═══\n');

    // ── قاعدة معزولة مؤقتة (Windows: %TEMP% = C:\Users\...\AppData\Local\Temp) ──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-month-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const db = require(path.join(__dirname, '..', 'db.js'));
    await db.init(false); // مخطط كامل بلا migrateAll (لا قراءة لبيانات الإنتاج)
    const RosterSyncService = require(path.join(__dirname, '..', 'services', 'roster-sync-service'));
    const sync = new RosterSyncService({ db });

    // db.init يزرع الفرق الافتراضية أصلًا («جنوب 3»/«سريع 2» ضمن DEFAULT_TEAMS) — لا إدراج يدوي.

    const monthCount = (y, m) => db.all('SELECT COUNT(*) c FROM shift_roster WHERE year = ? AND month = ?', [y, m]).then(r => r[0].c);

    try {
        // ─── ① getMonths: يوليو + أغسطس ⇒ ['2026-07','2026-08'] مرتبة ───
        const emptyMonths = await db.ShiftRoster.getMonths();
        const julyAug = [
            { employeeNumber: '101', name: 'موظف أول', team: 'جنوب 3', schedule: [
                { date: '2026-07-10', shiftCode: 'D12' }, { date: '2026-08-05', shiftCode: 'N12' }] },
            { employeeNumber: '102', name: 'موظف ثان', team: 'سريع 2', schedule: [
                { date: '2026-07-11', shiftCode: 'D12' }, { date: '2026-08-06', shiftCode: 'N12' }] }
        ];
        await sync.syncFromSchedule(julyAug);
        const months1 = await db.ShiftRoster.getMonths();
        record('① getMonths بعد زرع يوليو+أغسطس 2026',
            emptyMonths.length === 0 && JSON.stringify(months1) === JSON.stringify(['2026-07', '2026-08']),
            `فارغة=${JSON.stringify(emptyMonths)} بعد الزرع=${JSON.stringify(months1)}`);

        // ─── ② منطق الشهر الافتراضي (مستخرج من المصدر الفعلي) ───
        const htmlPath = path.join(__dirname, '..', 'public', 'smart-schedule.html');
        const pick = loadPickDefaultMonth(htmlPath);
        const t2a = pick(['2026-07', '2026-08'], '2026-07') === '2026-07'; // الحالي موجود ⇒ يُختار
        const t2b = pick(['2026-07', '2026-08'], '2026-06') === '2026-08'; // غائب ⇒ الأحدث
        const t2c = pick([], '2026-07') === null;                          // فارغة ⇒ null
        record('② pickDefaultMonth: الحالي أولًا ثم الأحدث ثم null',
            t2a && t2b && t2c, `موجود=${t2a} غائب=${t2b} فارغ=${t2c}`);

        // ─── ③ عزل العرض: فلتر أغسطس لا يمس صفوف يوليو والقراءة لا تكتب ───
        const allBefore = await db.ShiftRoster.getAll();
        const snapshotBefore = JSON.stringify(allBefore);
        const julyRows = allBefore.filter(r => String(r.shift_date).startsWith('2026-07'));
        // محاكاة فلتر getFilteredEmployees: s.date.startsWith(monthFilter)
        const augView = allBefore.filter(r => String(r.shift_date).startsWith('2026-08'));
        const julyInAugView = augView.filter(r => String(r.shift_date).startsWith('2026-07')).length;
        const allAfter = await db.ShiftRoster.getAll();
        record('③ عزل العرض: فلتر 2026-08 يُظهر أغسطس فقط والقاعدة لا تتغير بالقراءة',
            julyRows.length === 2 && augView.length === 2 && julyInAugView === 0
                && JSON.stringify(allAfter) === snapshotBefore,
            `يوليو=${julyRows.length} عرض_أغسطس=${augView.length} تسرب=${julyInAugView}`);

        // ─── ④ استيراد سبتمبر: يُضاف للقائمة ولا يمس يوليو/أغسطس ───
        const julyCntBefore = await monthCount(2026, 7);
        const augCntBefore = await monthCount(2026, 8);
        await sync.syncFromSchedule([
            { employeeNumber: '101', name: 'موظف أول', team: 'جنوب 3', schedule: [{ date: '2026-09-01', shiftCode: 'D12' }] },
            { employeeNumber: '102', name: 'موظف ثان', team: 'سريع 2', schedule: [{ date: '2026-09-02', shiftCode: 'N12' }] },
            { employeeNumber: '103', name: 'موظف ثالث', team: 'جنوب 3', schedule: [{ date: '2026-09-03', shiftCode: 'D12' }] }
        ]);
        const months4 = await db.ShiftRoster.getMonths();
        const julyCnt4 = await monthCount(2026, 7);
        const augCnt4 = await monthCount(2026, 8);
        record('④ استيراد سبتمبر: القائمة تصبح ٣ شهور وعدّالات يوليو/أغسطس ثابتة',
            JSON.stringify(months4) === JSON.stringify(['2026-07', '2026-08', '2026-09'])
                && julyCnt4 === julyCntBefore && augCnt4 === augCntBefore,
            `الشهور=${JSON.stringify(months4)} يوليو=${julyCntBefore}→${julyCnt4} أغسطس=${augCntBefore}→${augCnt4}`);

        // ─── ⑤ إعادة استيراد أغسطس معدّل: يُحدَّث وحده ويوليو/سبتمبر حرفيًا كما هما ───
        const julySnap5 = JSON.stringify(await db.all('SELECT * FROM shift_roster WHERE year = 2026 AND month = 7 ORDER BY id'));
        const sepSnap5 = JSON.stringify(await db.all('SELECT * FROM shift_roster WHERE year = 2026 AND month = 9 ORDER BY id'));
        await sync.syncFromSchedule([
            { employeeNumber: '101', name: 'موظف أول', team: 'جنوب 3', schedule: [
                { date: '2026-08-05', shiftCode: 'D12' }, { date: '2026-08-07', shiftCode: 'N12' }] }, // كان N12 فقط
            { employeeNumber: '102', name: 'موظف ثان', team: 'سريع 2', schedule: [
                { date: '2026-08-06', shiftCode: 'WO' }] },                                            // كان N12
            { employeeNumber: '103', name: 'موظف ثالث', team: 'جنوب 3', schedule: [
                { date: '2026-08-08', shiftCode: 'D12' }] }                                            // صف أغسطس جديد
        ]);
        const augRows5 = await db.all('SELECT * FROM shift_roster WHERE year = 2026 AND month = 8 ORDER BY shift_date');
        const julySnap5After = JSON.stringify(await db.all('SELECT * FROM shift_roster WHERE year = 2026 AND month = 7 ORDER BY id'));
        const sepSnap5After = JSON.stringify(await db.all('SELECT * FROM shift_roster WHERE year = 2026 AND month = 9 ORDER BY id'));
        const augUpdated = augRows5.length === 4
            && augRows5.some(r => r.shift_date === '2026-08-05' && r.shift_code === 'D12')
            && augRows5.some(r => r.shift_date === '2026-08-06' && r.shift_code === 'WO');
        record('⑤ عزل الكاتب: أغسطس المعدّل يُعاد بناؤه ويوليو/سبتمبر بايت-بايت كما هما',
            augUpdated && julySnap5 === julySnap5After && sepSnap5 === sepSnap5After,
            `أغسطس=${augRows5.length} محدث=${augUpdated} يوليو_ثابت=${julySnap5 === julySnap5After} سبتمبر_ثابت=${sepSnap5 === sepSnap5After}`);

        // ─── ⑥ حتمية pickDefaultMonth: الناتج دالة في قائمة الشهور فقط ───
        const pickFresh = loadPickDefaultMonth(htmlPath); // sandbox جديد كليًا
        const monthsNow = await db.ShiftRoster.getMonths();
        const d1 = pick(monthsNow, '2026-06');
        const d2 = pick(monthsNow, '2026-06');       // تكرار في نفس الـ sandbox
        const d3 = pickFresh(monthsNow, '2026-06');  // sandbox طازج
        const d4 = pickFresh(monthsNow, '2026-09');  // الحالي موجود
        record('⑥ حتمية الافتراضي: نفس الناتج عبر التكرار والـ sandbox ولا اعتماد على حالة مخزنة',
            d1 === '2026-09' && d2 === d1 && d3 === d1 && d4 === '2026-09',
            `d1=${d1} d2=${d2} d3=${d3} d4=${d4}`);

        // ─── ⑦ فلتر شهر PDF — طبقة البيانات + الخدمة مباشرة (بلا HTTP) ───
        // النهج: نفس استعلام readScheduleEmployeesFromDB(month) حرفيًا + بناء PDF
        // فعلي عبر schedule-pdf-service والمقارنة بالبايتات (يوليو ≠ أغسطس).
        const pdfService = require(path.join(__dirname, '..', 'services', 'schedule-pdf-service'));
        const julyEmps = await readScheduleEmployeesFromDBReplica(db, '2026-07');
        const julyDates = [];
        julyEmps.forEach(e => e.schedule.forEach(s => julyDates.push(s.date)));
        const julyOnly = julyDates.length > 0 && julyDates.every(d => d.startsWith('2026-07'));
        const julyData = pdfService.buildSchedulePdfData(julyEmps, { center: 'جنوب 3', month: '2026-07' });
        const augEmps = await readScheduleEmployeesFromDBReplica(db, '2026-08');
        const augData = pdfService.buildSchedulePdfData(augEmps, { center: 'جنوب 3', month: '2026-08' });
        const julyPdf = await pdfService.generateSchedulePdf(julyData);
        const augPdf = await pdfService.generateSchedulePdf(augData);
        const isPdf = b => Buffer.isBuffer(b) && b.length > 500 && b.slice(0, 5).toString() === '%PDF-';
        record('⑦ فلتر شهر PDF: استعلام يوليو يعيد يوليو فقط + PDF غير فارغ والملفان مختلفان',
            julyOnly && julyData.employees.length > 0 && augData.employees.length > 0
                && isPdf(julyPdf) && isPdf(augPdf) && !julyPdf.equals(augPdf),
            `صفوف_يوليو=${julyDates.length} كلها_يوليو=${julyOnly} حجم=${julyPdf.length}/${augPdf.length} بايت (نهج: طبقة بيانات+خدمة بلا HTTP)`);

    } catch (err) {
        record('خطأ غير متوقع أثناء الاختبارات', false, err.message);
        console.error(err);
    } finally {
        try { await db.closeDb(); } catch (_) {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    // ─── الملخص ───
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ الملخص: ${results.length - failed.length}/${results.length} ناجح ═══`);
    if (failed.length) {
        failed.forEach(f => console.log(`   ❌ ${f.name}`));
        process.exit(1);
    }
    console.log('✅ جميع اختبارات §13.7 ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
