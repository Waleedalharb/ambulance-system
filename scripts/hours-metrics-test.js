/**
 * اختبارات Phase 2 — مؤشرات الساعات الشهرية (Monthly Hours Indicators)
 * ═══════════════════════════════════════════════════════════
 * نفس نمط العزل في multi-month-test.js حرفيًا:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (يُضبط قبل require db.js).
 *   - الكتابة تمر عبر RosterSyncService الحقيقي بمحوّل db.js نفسه — لا SQL
 *     اختباري موازٍ للكاتب الرسمي (استثناء موثّق: ⑧ يحاكي «تعديل خلية»
 *     بتحديث shift_code مباشرة، وهو نفس ما يفعله PUT /api/shift-roster/cell).
 *   - formatHoursBadge تُستخرج من مصدر smart-schedule.html الفعلي وتُقيَّم في
 *     sandbox (vm) — تُختبر النسخة المنشورة لا نسخة مكررة.
 *   - ④ الإعداد: طبقة بيانات + خدمة (بلا HTTP — نهج موثّق بدل إقلاع الخادم):
 *     نفس نص SQL الذي تستخدمه appSettingGet/appSettingSet في server.js حرفيًا
 *     على جدول app_settings، ثم computeMetrics بالقيمة الجديدة.
 *
 * التشغيل: node scripts/hours-metrics-test.js   (خروج غير صفري عند أي فشل)
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

/** استخراج مصدر دالة من ملف بعدّ الأقواس المتزنة (نفس أداة multi-month-test). */
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

/** تحميل formatHoursBadge من المصدر الفعلي داخل sandbox نظيف (بلا تبعيات). */
function loadFormatHoursBadge(htmlPath) {
    const src = extractFunctionSource(htmlPath, 'formatHoursBadge');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.formatHoursBadge = formatHoursBadge;', sandbox);
    if (typeof sandbox.formatHoursBadge !== 'function') throw new Error('فشل تقييم formatHoursBadge');
    return sandbox.formatHoursBadge;
}

/** بناء سلسلة أيام متتالية «YYYY-MM-DD» داخل شهر واحد. */
function daysOf(year, month, count, startDay = 1) {
    const pad = n => (n < 10 ? '0' : '') + n;
    const out = [];
    for (let i = 0; i < count; i++) out.push(`${year}-${pad(month)}-${pad(startDay + i)}`);
    return out;
}

async function main() {
    console.log('\n═══ اختبارات Phase 2 — مؤشرات الساعات الشهرية ═══\n');

    // ── قاعدة معزولة مؤقتة (Windows: %TEMP% = C:\Users\...\AppData\Local\Temp) ──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hours-metrics-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const db = require(path.join(__dirname, '..', 'db.js'));
    await db.init(false); // مخطط كامل بلا migrateAll — يزرع shift_codes الافتراضية
    const RosterSyncService = require(path.join(__dirname, '..', 'services', 'roster-sync-service'));
    const sync = new RosterSyncService({ db });
    const ScheduleMetricsService = require(path.join(__dirname, '..', 'services', 'schedule-metrics-service'));
    const metrics = new ScheduleMetricsService({ db });

    try {
        // ─── ① حل المدة: أوقات+عبور ليل+كسري ← خريطة 8 ساعات (E/VC/V/S) ← سقوط نصي ← null ───
        // خريطة مصطنعة تغطي عبور منتصف الليل والكسور والسقوط النصي
        const codesByCode = new Map([
            ['X1', { code: 'X1', name: 'اختبار', time_start: '17:00', time_end: '05:00' }], // عبور ليل = 12
            ['X2', { code: 'X2', name: 'اختبار', time_start: '12:00', time_end: '00:00' }], // حتى منتصف الليل = 12
            ['X3', { code: 'X3', name: 'اختبار', time_start: '09:00', time_end: '21:00' }], // نهاري = 12
            ['X4', { code: 'X4', name: 'اختبار', time_start: '08:00', time_end: '16:00' }], // 8 ساعات
            ['X5', { code: 'X5', name: 'اختبار', time_start: '07:00', time_end: '15:30' }], // كسري = 8.5
            ['D12', { code: 'D12', name: 'دوام 12 صباحاً', time_start: null, time_end: null }],
            ['D8', { code: 'D8', name: 'دوام 8 صباحاً', time_start: null, time_end: null }],
            ['N6', { code: 'N6', name: 'دوام 6 ليلاً', time_start: null, time_end: null }],
            ['O12-09', { code: 'O12-09', name: 'أوفرلاب', time_start: null, time_end: null }],
            ['E', { code: 'E', name: 'إجازة', time_start: null, time_end: null }],
            ['VC', { code: 'VC', name: 'إجازة اضطرارية', time_start: null, time_end: null }],
            ['V', { code: 'V', name: 'إجازة', time_start: null, time_end: null }],
            // S غير موجودة في shift_codes أصلًا — تُختبر هنا بلا صف تعريف (row=null)
            ['EV', { code: 'EV', name: 'إجازة استثنائية', time_start: null, time_end: null }],
            ['WO', { code: 'WO', name: 'Weekend Off', time_start: null, time_end: null }],
            ['R', { code: 'R', name: 'راحة', time_start: null, time_end: null }]
        ]);
        const r = c => metrics.resolveCodeDurationHours(c, codesByCode);
        const t1 = r('X1') === 12 && r('X2') === 12 && r('X3') === 12 && r('X4') === 8
            && r('X5') === 8.5
            && r('D12') === 12 && r('D8') === 8 && r('N6') === 6 && r('O12-09') === 12 // الرقم بعد السابقة، لا لاحق الشرطة
            && r('E') === 8 && r('VC') === 8 && r('V') === 8 && r('S') === 8          // خريطة التغطية المعتمدة — لا 12 إطلاقًا
            && r('EV') === null && r('WO') === null && r('R') === null;               // EV خارج القاعدة + غير القابلة — ممنوع افتراض 12
        // خطوة المحلل المشترك (بعد أوقات الصف، قبل التغطية والتحليل النصي):
        // أكواد تشغيلية بلا أي صف تعريف ⇒ المدة من تعريف الكود نفسه (12) —
        // يقتل خطأ «RRA1-04 ⇒ ساعة واحدة» الذي كان يعطيه التحليل النصي.
        const t1parser = r('RRA1-D-04') === 12 && r('RRA1-N-16') === 12
            && r('RRA1-04') === 12 && r('RRA1-16') === 12 && r('O12-12') === 12
            && metrics.resolveCodeDurationKind('RRA1-D-04', codesByCode) === 'work'
            && metrics.resolveCodeDurationKind('RRA1-N-16', codesByCode) === 'work';
        record('① حل المدة: أوقات+عبور ليل+كسري ← المحلل المشترك (RRA1-D-04/N-16/04/16 بلا صف=12) ← E/VC/V/S=8 ← سقوط نصي ← EV/WO/R=null',
            t1 && t1parser, `X1=${r('X1')} X5=${r('X5')} D12=${r('D12')} O12-09=${r('O12-09')} RRA1-D-04=${r('RRA1-D-04')} RRA1-04=${r('RRA1-04')} E=${r('E')} VC=${r('VC')} V=${r('V')} S=${r('S')} EV=${r('EV')} WO=${r('WO')}`);

        // ─── تجهيز بيانات مشتركة (②③⑤⑥) عبر الكاتب الرسمي RosterSyncService ───
        // D12 المزروع في db.js: 05:00→17:00 = 12 ساعة — وحدة البناء لكل المجاميع
        const scheduleFor = (year, month, count, code = 'D12') =>
            daysOf(year, month, count).map(d => ({ date: d, shiftCode: code }));
        await sync.syncFromSchedule([
            { employeeNumber: '201', name: 'موظف مكتمل', team: 'جنوب 3', jobTitle: 'أخصائي تمريض',
              schedule: scheduleFor(2026, 8, 16) },                                            // 16×12 = 192 = مكتمل
            { employeeNumber: '202', name: 'موظف ناقص', team: 'جنوب 3', jobTitle: 'فني إسعاف',
              schedule: scheduleFor(2026, 8, 15).concat([
                  { date: '2026-08-16', shiftCode: 'E' }]) },                                  // 15×12 + E×8 = 188 = ناقص 4
            { employeeNumber: '203', name: 'موظف زائد', team: 'سريع 2', jobTitle: 'مسعف',
              schedule: scheduleFor(2026, 8, 17) },                                            // 17×12 = 204 = زائد 12
            { employeeNumber: '204', name: 'موظف شهور', team: 'جنوب 3', jobTitle: 'مسعف',
              schedule: scheduleFor(2026, 7, 5).concat(scheduleFor(2026, 8, 10)) },            // يوليو 60 + أغسطس 120
            { employeeNumber: '205', name: 'موظف إجازات', team: 'جنوب 3', jobTitle: 'أخصائي إسعاف',
              schedule: scheduleFor(2026, 8, 10).concat([
                  { date: '2026-08-11', shiftCode: 'V' }, { date: '2026-08-12', shiftCode: 'V' },
                  { date: '2026-08-13', shiftCode: 'S' }, { date: '2026-08-14', shiftCode: 'WO' },
                  { date: '2026-08-15', shiftCode: 'EV' }]) },                                 // 120 + 8+8+8 = 144 + WO/EV غير محسوبتين
            { employeeNumber: '206', name: 'موظف مركب', team: 'جنوب 3', jobTitle: 'مسعف',
              schedule: scheduleFor(2026, 8, 14).concat([
                  { date: '2026-08-15', shiftCode: 'E' }, { date: '2026-08-16', shiftCode: 'VC' }]) } // 14×12 + E + VC = 184 = ناقص 8
        ]);
        const aug = await metrics.computeMetrics('2026-08-01', '2026-08-31', 192);
        const emp = code => aug.employees.find(e => e.employeeCode === code);

        // ─── ② الأمثلة المعتمدة إداريًا حرفيًا: 16 عادية=192 · 15+E=188 · 14+E+VC=184 · 17=204 ───
        const t2 = emp('201').scheduledHours === 192 && emp('201').status === 'complete' && emp('201').deltaHours === 0
            && emp('202').scheduledHours === 188 && emp('202').status === 'under' && emp('202').deltaHours === -4
            && emp('206').scheduledHours === 184 && emp('206').status === 'under' && emp('206').deltaHours === -8
            && emp('203').scheduledHours === 204 && emp('203').status === 'over' && emp('203').deltaHours === 12;
        record('② الأمثلة المعتمدة: 192=مكتمل · 15+E=188 ناقص 4 · 14+E+VC=184 ناقص 8 · 204=زائد 12',
            t2, `201=${emp('201').scheduledHours}/${emp('201').status} 202=${emp('202').scheduledHours}/${emp('202').status} 206=${emp('206').scheduledHours}/${emp('206').status} 203=${emp('203').scheduledHours}/${emp('203').status}`);

        // ─── ③ عزل الشهر: أغسطس يحسب أغسطس فقط (يوليو لا يتسرب) ───
        const july = await metrics.computeMetrics('2026-07-01', '2026-07-31', 192);
        const julyEmp = july.employees.find(e => e.employeeCode === '204');
        const t3 = emp('204').scheduledHours === 120 && july.employees.length === 1
            && julyEmp && julyEmp.scheduledHours === 60;
        record('③ عزل الشهر: نفس الموظف يوليو+أغسطس — حساب أغسطس يقتصر على أغسطس',
            t3, `أغسطس=${emp('204').scheduledHours} (متوقع 120) يوليو=${julyEmp ? julyEmp.scheduledHours : '—'} (متوقع 60)`);

        // ─── ④ الإعداد: الزرع 192 عند أول قراءة، وتغييره لـ180 يقلب الحالات ───
        // نهج موثّق: طبقة بيانات + خدمة (بلا HTTP). نفس نص SQL في appSettingGet/
        // appSettingSet بـ server.js حرفيًا على app_settings.
        const settingRowBefore = await db.get('SELECT value FROM app_settings WHERE key = ?', ['monthly_required_hours']);
        // أول قراءة بلا صف ⇒ يزرع 192 (نفس منطق getMonthlyRequiredHours)
        await db.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', ['monthly_required_hours', JSON.stringify(192)]);
        const seeded = JSON.parse((await db.get('SELECT value FROM app_settings WHERE key = ?', ['monthly_required_hours'])).value);
        await db.run("UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [JSON.stringify(180), 'monthly_required_hours']);
        const changed = JSON.parse((await db.get('SELECT value FROM app_settings WHERE key = ?', ['monthly_required_hours'])).value);
        const aug180 = await metrics.computeMetrics('2026-08-01', '2026-08-31', changed);
        const emp180 = code => aug180.employees.find(e => e.employeeCode === code);
        const t4 = settingRowBefore == null && seeded === 192 && changed === 180
            && emp180('201').status === 'over' && emp180('201').deltaHours === 12   // 192 مقابل 180
            && emp180('206').status === 'over' && emp180('206').deltaHours === 4;   // 184 مقابل 180
        record('④ الإعداد: غياب القيمة أولًا ثم زرع 192 (الثابت المعتمد)، وتغييرها لـ180 يقلب الحالات',
            t4, `قبل=${settingRowBefore} مزروع=${seeded} معدّل=${changed} 201=${emp180('201').status} 206=${emp180('206').status} (نهج: طبقة بيانات+خدمة بلا HTTP)`);

        // ─── ⑤ مصنّف التخصص: أخصائي/فني/غيره + عدّادات الملخص ───
        const cls = metrics.classifySpecialty.bind(metrics);
        const t5a = cls('أخصائي تمريض') === 'specialist' && cls('فني إسعاف') === 'technician'
            && cls('مسعف') === 'other' && cls('') === 'other';
        const t5b = aug.summary.totalEmployees === 6 && aug.summary.specialists === 2
            && aug.summary.technicians === 1 && aug.summary.other === 3
            && aug.summary.complete === 1 && aug.summary.under === 4 && aug.summary.over === 1
            && aug.summary.totalHours === 1032 && aug.summary.avgHours === 172;
        record('⑤ مصنّف التخصص مركزي + ملخص صحيح العدّادات والمجاميع',
            t5a && t5b, `تصنيف=${t5a} ملخص=${JSON.stringify(aug.summary)}`);

        // ─── ⑥ خريطة الـ8 ساعات في المسار التجميعي + شفافية غير المحسوبة ───
        // 205: 10×D12 (120) + V+V+S (8×3=24) = 144 محسوبة؛ WO+EV = غير محسوبتين فقط
        const t6 = emp('205').scheduledHours === 144 && emp('205').uncountedEntries === 2
            && aug.summary.uncountedEntries === 2;
        record('⑥ التغطية 8س تُجمع فعليًا (V+V+S=24) وWO/EV وحدهما غير محسوبتين',
            t6, `205=${emp('205').scheduledHours}h/غير_محسوبة=${emp('205').uncountedEntries} إجمالي=${aug.summary.uncountedEntries}`);

        // ─── ⑦ formatHoursBadge من المصدر الفعلي (regex + vm sandbox) ───
        const htmlPath = path.join(__dirname, '..', 'public', 'smart-schedule.html');
        const fmt = loadFormatHoursBadge(htmlPath);
        const b1 = fmt(192, 192), b2 = fmt(188, 192), b3 = fmt(204, 192);
        const t7 = b1.text === '192 / 192 — مكتمل' && b1.status === 'complete'
            && b2.text === '188 / 192 — ناقص 4' && b2.status === 'under'
            && b3.text === '204 / 192 — زائد 12' && b3.status === 'over';
        record('⑦ formatHoursBadge (المنشورة فعليًا): «188 / 192 — ناقص 4» ونظيرتاها',
            t7, `«${b1.text}» «${b2.text}» «${b3.text}»`);

        // ─── ⑧ اشتقاق بعد التعديل: لا عدادات مخزنة — الحساب الثاني يعكس التغيير ───
        // محاكاة «تعديل خلية» على طبقة البيانات: نفس فعل PUT /api/shift-roster/cell
        // (UPDATE shift_roster SET shift_code). أول صف أغسطس لـ202: D12 ← V.
        // 202 قبل: 15×D12 + E = 188 ← بعد: 14×D12 + E + V = 184 (V محسوبة 8 — لا غير محسوبة)
        const before = emp('202').scheduledHours;
        await db.run(
            `UPDATE shift_roster SET shift_code = 'V'
             WHERE shift_code = 'D12' AND shift_date = '2026-08-01'
               AND employee_id = (SELECT id FROM employees WHERE employee_code = '202')`);
        const after = await metrics.computeMetrics('2026-08-01', '2026-08-31', 192);
        const e202 = after.employees.find(e => e.employeeCode === '202');
        const t8 = before === 188 && e202.scheduledHours === 184 && e202.uncountedEntries === 0
            && e202.status === 'under' && e202.deltaHours === -8;
        record('⑧ اشتقاق بعد التعديل: D12←V تعطي 184 (−8) بلا عدادات مخزنة وبلا «غير محسوبة»',
            t8, `202 قبل=${before} بعد=${e202.scheduledHours}/غير_محسوبة=${e202.uncountedEntries}/${e202.status}`);

        // ─── ⑨ نطاق اليوم الواحد (dayScope): العاملون = دوام فعلي فقط ───
        // نوع الحسم من نفس المحلل المركزي — بلا منطق تصنيف جديد
        const kindOf = c => metrics.resolveCodeDurationKind(c, codesByCode);
        const t9a = kindOf('D12') === 'work' && kindOf('O12-09') === 'work'
            && kindOf('E') === 'coverage' && kindOf('VC') === 'coverage'
            && kindOf('V') === 'coverage' && kindOf('S') === 'coverage'
            && kindOf('WO') === null && kindOf('EV') === null && kindOf('R') === null;
        // 12 أغسطس: 201(D12/أخصائي)+202(D12/فني)+203(D12/أخرى)+206(D12/أخرى) عاملون=4
        //           (204 مجدول أيام 1–10 فقط ← لا صف له يوم 12 فيدل على دقة النطاق)
        //           و205(V/أخصائي) ← إجازة محسوبة لا تدخل العاملين
        const day12 = await metrics.computeMetrics('2026-08-12', '2026-08-12', 192);
        const ds12 = day12.dayScope;
        const t9b = ds12 && ds12.working === 4 && ds12.specialists === 1 && ds12.technicians === 1
            && ds12.other === 2 && ds12.leave === 1 && ds12.off === 0;
        // 5 يوليو أثناء وجود أغسطس: يحسب يوليو فقط (204 وحده عامل/أخرى)
        const day5j = await metrics.computeMetrics('2026-07-05', '2026-07-05', 192);
        const ds5j = day5j.dayScope;
        const t9c = ds5j && ds5j.working === 1 && ds5j.specialists === 0 && ds5j.technicians === 0
            && ds5j.other === 1 && ds5j.leave === 0 && ds5j.off === 0;
        // يوم بلا أي صفوف: كتلة موجودة بأصفار (وليست null)
        const dayEmpty = await metrics.computeMetrics('2026-09-10', '2026-09-10', 192);
        const dsE = dayEmpty.dayScope;
        const t9d = dsE && dsE.working === 0 && dsE.leave === 0 && dsE.off === 0
            && dayEmpty.employees.length === 0;
        // فترة شهرية: dayScope تبقى null (البطاقات الشهرية لا تتأثر)
        const t9e = aug.dayScope === null;
        record('⑨ نطاق اليوم: 12 أغسطس (عاملون=4: 1أ/1ف/2خ + إجازة=1 — 204 بلا صف يوم 12) · 5 يوليو منفصل · يوم فارغ · الشهر بلا dayScope',
            t9a && t9b && t9c && t9d && t9e,
            `أنواع=${t9a} 12أغسطس=${JSON.stringify(ds12)} 5يوليو=${JSON.stringify(ds5j)} فارغ=${JSON.stringify(dsE)} شهر_null=${t9e}`);

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
    console.log('✅ جميع اختبارات Phase 2 ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
