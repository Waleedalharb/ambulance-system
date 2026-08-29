/**
 * ═══ schedule-month-guard-test.js — إصلاح دورة الجداول متعددة الشهور (معزول) ═══
 * (اعتماد المالك 2026-08-29 — بعد إثبات سيناريو الفشل: ملف شهر 9 نُسب إلى شهر 8
 *  فدُمّر 8 ولم يظهر 9)
 * يثبت بلا خادم إنتاج:
 *  أ) ① الترويسة الرقمية لصيغة القطاع تُكتشف (رقم + «الشهر: 9») وأرقام الأيام لا تُلتقط
 *  ب) ② حارس التعارض: ملف 9 + اختيار 8 ⇒ رفض صارم بلا زر تجاوز، والقاعدة بايت-بايت كما هي
 *  ج) تحذير الاستبدال: ملف 9 + اختيار 9 و9 موجود ⇒ لا تعارض (مسار التحذير الطبيعي)
 *  د) استقلال الشهور عبر الكاتب الرسمي الحقيقي: 8→9 · 8→9→8→9 · 8،9،10
 *  هـ) ③ بعد الاستيراد: إعادة قراءة من القاعدة (فحص نصي للمصدر الفعلي) — اختيار 8 بلا Reload
 *  و) ثوابت المصدر: مودال التعارض بلا زر استبدال · الاقتراح لا يعتمد تاريخ الحفظ/آخر
 *     استيراد إذا تصرّح الملف · لا مسار تشغيلي يقرأ JSON كمصدر حقيقة
 * التشغيل: node scripts/schedule-month-guard-test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8');
const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

/** استخراج مصدر دالة من HTML بعدّ الأقواس المتزنة وتقييمها في sandbox نظيف. */
function loadFn(fnName) {
    const start = HTML.indexOf('function ' + fnName + '(');
    if (start === -1) throw new Error('الدالة ' + fnName + ' غير موجودة في smart-schedule.html');
    const braceStart = HTML.indexOf('{', start);
    let depth = 0, end = -1;
    for (let i = braceStart; i < HTML.length; i++) {
        if (HTML[i] === '{') depth++;
        else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) throw new Error('أقواس ' + fnName + ' غير متزنة');
    const src = HTML.slice(start, end + 1);
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.fn = ' + fnName + ';', sandbox);
    return sandbox.fn;
}

/* ─────────── أ — ① الترويسة الرقمية ─────────── */
function numericHeaderSuite() {
    console.log('أ — اكتشاف الترويسة الرقمية:');
    const scan = loadFn('oiScanNumericMonthYear');
    // صيغة القطاع: صف «الشهر | 9 | ... | 2026» أو خليتان رقميتان في أول عمودين
    check('أ1 صف ترويسة رقمي (9 في عمود أول + 2026) ← شهر 9/2026',
        JSON.stringify(scan([['الشهر', ''], [9, 2026, '']])) === JSON.stringify({ month: 9, year: 2026 }));
    check('أ2 خلية نصية «الشهر: 9» + سنة بنفس الصف ← شهر 9/2026',
        JSON.stringify(scan([['الشهر: 9', 2026]])) === JSON.stringify({ month: 9, year: 2026 }));
    // صف أرقام الأيام (1..31 عبر الأعمدة) بلا سنة ← لا يُلتقط
    const dayRow = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    check('أ3 صف أرقام الأيام بلا سنة ← لا التقاط', scan([dayRow]) === null);
    // شهر بلا سنة ← لا يكفي (الاقتراح يسقط للمصادر الأخرى بصدق)
    check('أ4 شهر رقمي بلا سنة ← لا التقاط (لا تخمين للسنة)', scan([[9, '', '']]) === null);
    check('أ5 صفوف فارغة/بلا ترويسة ← null', scan([[], ['الاسم', 'الكود', 'رمز']]) === null);
}

/* ─────────── ب+ج — ② حارس التعارض وتحذير الاستبدال ─────────── */
function conflictGuardSuite() {
    console.log('ب/ج — حارس تعارض الشهر:');
    const conflict = loadFn('oiCheckMonthConflict');
    const c1 = conflict({ month: 9, year: 2026 }, { month: 8, year: 2026 });
    check('ب1 ملف 9/2026 + اختيار 8/2026 ← تعارض صارم', !!c1 && c1.fileMonth === 9 && c1.chosenMonth === 8);
    check('ب2 ملف 9 + اختيار 9 (نفس الشهر) ← لا تعارض (مسار تحذير الاستبدال)',
        conflict({ month: 9, year: 2026 }, { month: 9, year: 2026 }) === null);
    check('ب3 اختلاف السنة (ملف 2026 + اختيار 2025) ← تعارض',
        !!conflict({ month: 9, year: 2026 }, { month: 9, year: 2025 }));
    check('ب4 الملف لا يصرّح بشهره ← لا حارس (الاقتراح يبقى إرشاديًا)',
        conflict(null, { month: 8, year: 2026 }) === null && conflict({ month: 0 }, { month: 8, year: 2026 }) === null);
    check('ب5 سنة الملف مجهولة + نفس الشهر ← لا تعارض زائف',
        conflict({ month: 8, year: 0 }, { month: 8, year: 2026 }) === null);
}

/* ─────────── د — استقلال الشهور عبر الكاتب الرسمي + Before/After للتعارض ─────────── */
async function monthIsolationSuite() {
    console.log('د — استقلال الشهور (RosterSync الحقيقي على قاعدة مؤقتة):');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-guard-'));
    process.env.DB_PATH = path.join(tmpDir, 'guard.db'); // قبل require إلزامًا
    const db = require(path.join(ROOT, 'db.js'));
    await db.init(false);
    const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
    const sync = new RosterSyncService({ db });
    const conflict = loadFn('oiCheckMonthConflict');

    const payload = (ym, spec) => spec.map(e => ({
        employeeNumber: e.code, name: e.name, team: e.team,
        schedule: e.days.map((d, i) => ({ date: ym + '-' + String(d).padStart(2, '0'), shiftCode: e.codes[i] || 'D12' }))
    }));
    const EMP8 = [
        { code: '301', name: 'أغسطس أ', team: 'جنوب 3', days: [1, 2], codes: ['D12', 'N12'] },
        { code: '302', name: 'أغسطس ب', team: 'سريع 2', days: [3], codes: ['D12'] }
    ];
    const EMP9 = [
        { code: '301', name: 'أغسطس أ', team: 'جنوب 3', days: [5], codes: ['N12'] },
        { code: '303', name: 'سبتمبر ج', team: 'جنوب 3', days: [6, 7], codes: ['D12', 'WO'] }
    ];
    const EMP10 = [{ code: '304', name: 'أكتوبر د', team: 'سريع 2', days: [1], codes: ['D12'] }];
    const rows = (y, m) => db.all('SELECT employee_id, shift_date, shift_code FROM shift_roster WHERE year=? AND month=? ORDER BY shift_date, employee_id', [y, m]);
    const sigOf = r => JSON.stringify(r);

    // 8 → 9
    await sync.syncFromSchedule(payload('2026-08', EMP8));
    const aug0 = sigOf(await rows(2026, 8));
    await sync.syncFromSchedule(payload('2026-09', EMP9));
    check('د1 8→9: شهر 8 ثابت بايت-بايت وشهر 9 موجود',
        sigOf(await rows(2026, 8)) === aug0 && (await rows(2026, 9)).length === 3);
    // 8 → 9 → 8 → 9
    await sync.syncFromSchedule(payload('2026-08', EMP8));
    const sepAfterRe8 = sigOf(await rows(2026, 9));
    await sync.syncFromSchedule(payload('2026-09', EMP9));
    check('د2 8→9→8→9: كل إعادة تعيد شهرها فقط والآخر ثابت',
        sigOf(await rows(2026, 8)) === aug0 && sigOf(await rows(2026, 9)) === sepAfterRe8);
    // 8 ، 9 ، 10
    await sync.syncFromSchedule(payload('2026-10', EMP10));
    check('د3 رفع 10 لا يمس 8 ولا 9',
        sigOf(await rows(2026, 8)) === aug0 && sigOf(await rows(2026, 9)) === sepAfterRe8 &&
        (await rows(2026, 10)).length === 1);

    // ─── Before/After سيناريو التعارض: ملف 9 + اختيار 8 ───
    // الحارس يرفض قبل أي كتابة ← لا استدعاء للكاتب إطلاقًا
    const allBefore = sigOf(await db.all('SELECT * FROM shift_roster ORDER BY id'));
    const blocked = conflict({ month: 9, year: 2026 }, { month: 8, year: 2026 });
    if (!blocked) await sync.syncFromSchedule(payload('2026-08', EMP9)); // لا يجب أن يحدث
    const allAfter = sigOf(await db.all('SELECT * FROM shift_roster ORDER BY id'));
    check('د4 ملف 9 + اختيار 8: الحارس رفض والقاعدة كاملة بايت-بايت كما كانت (Before ≡ After)',
        !!blocked && allAfter === allBefore);
    // تحذير الاستبدال الطبيعي: ملف 9 + اختيار 9 ← لا تعارض، والاستبدال يمس 9 فقط
    const augBeforeReplace = sigOf(await rows(2026, 8));
    await sync.syncFromSchedule(payload('2026-09', EMP9));
    check('د5 إعادة استيراد 9 (تطابق ملف/اختيار): شهر 8 لا يتغير إطلاقًا',
        sigOf(await rows(2026, 8)) === augBeforeReplace);
    try { await db.close(); } catch (e) {}
}

/* ─────────── هـ/و — ثوابت المصدر (فحص نصي للملف الفعلي) ─────────── */
function sourceSuite() {
    console.log('هـ/و — ثوابت المصدر:');
    check('هـ1 ③ oiApply يعيد القراءة من القاعدة بعد الحفظ (fetchEmployeesFromDBSilent + adoptServerEmployees)',
        /oiSaveToServer\(false\)[\s\S]{0,400}fetchEmployeesFromDBSilent\(\)[\s\S]{0,200}adoptServerEmployees\(fresh\)/.test(HTML));
    check('هـ2 السقوط للذاكرة فقط عند تعذّر القاعدة (refreshed flag)',
        /var refreshed = false;[\s\S]{0,500}if \(!refreshed\)/.test(HTML));
    check('و1 مودال التعارض بلا زر تجاوز — «تصحيح الشهر» و«إلغاء» فقط', (() => {
        const m = HTML.match(/id="oiConflictModal"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
        return !!m && !/تأكيد الاستبدال|متابعة|oiApply|oiProceedToReport/.test(m[0]) && m[0].includes('oiBackToMonthPicker');
    })());
    check('و2 oiConfirmMonth يستدعي حارس التعارض قبل أي متابعة',
        /oiConfirmMonth[\s\S]{0,900}checkMonthConflict\(oiState\.fileMY/.test(HTML));
    check('و3 «الملف يقول» = conf≥2 فقط (تاريخ الحفظ وآخر استيراد مستبعدان من الحارس)',
        /fileMY = \(sug && sug\.conf >= 2/.test(HTML));
    check('و4 الاقتراح يقرأ الترويسة الرقمية بأعلى ثقة (conf 4) قبل الأسماء',
        /oiScanNumericMonthYear\(rows0\)[\s\S]{0,200}conf: 4/.test(HTML));
    check('و5 الدالتان الجديدتان مكشوفتان على window.__oi (قابلية الاختبار)',
        HTML.includes('scanNumericMY: oiScanNumericMonthYear') && HTML.includes('checkMonthConflict: oiCheckMonthConflict'));
    // لا مسار تشغيلي يقرأ JSON كمصدر حقيقة: قراءات readScheduleEmployees =
    // عرض ملف الاستيراد + سقوط PDF المُنحط فقط (موثق — لا حساب ساعات/مشاركات منه)
    check('و6 سيرفريًا: JSON يُقرأ في مسارين فقط (عرض الاستيراد + سقوط PDF المُنحط) — لا قراءة تشغيلية',
        (SRV.match(/await readScheduleEmployees\(\)/g) || []).length === 3 &&
        /scheduleMetricsService\.computeMetrics/.test(SRV)); // المقاييس من القاعدة
}

(async () => {
    console.log('═══ اختبار إصلاح دورة الجداول متعددة الشهور (معزول) ═══\n');
    numericHeaderSuite();
    conflictGuardSuite();
    await monthIsolationSuite();
    sourceSuite();
    console.log('\n═══ النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('خطأ فادح:', e); process.exit(1); });
