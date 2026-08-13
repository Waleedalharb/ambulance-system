/**
 * خدمة توليد PDF لجدول مناوبات مركز — تذكرة البند ⑤ «نظام الجداول — تصدير PDF»
 * ═══════════════════════════════════════════════════════════
 * تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): تصدير PDF سيرفري
 * للجداول لكل مركز — اختيار المركز ← تصدير جدوله فقط ← طباعة مباشرة A4 ←
 * ملف قابل للإرسال للفرق.
 *
 * البنية تتبع services/workflow-pdf-service.js حرفيًا (نفس المكتبة pdfkit،
 * نفس خط Amiri، نفس أنبوب العربية المحسوم، نفس طبقة time-riyadh) — لا مكتبة
 * PDF ثانية في المنصة. الفرق الوحيد عن سير العمل: الوثيقة هنا تصدير عند
 * الطلب (تُعاد Buffer للمسار ولا تُخزَّن في الأرشيف) لأنها ليست وثيقة مقفلة.
 *
 * نموذج البيانات (مصدره data/schedule-employees.json عبر readScheduleEmployees):
 *   الموظف: { id, employeeNumber, name, jobTitle, team, kind, schedule[] }
 *   السجل:  { date:'YYYY-MM-DD', shiftCode, location }
 * «المركز» = نفس دلالة فلتر «الموقع» في smart-schedule.html (getFilteredEmployees):
 *   يُبقى السجل إن كان s.location === المركز أو emp.team === المركز.
 */

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const bidi = require('bidi-js')();

const ROOT = path.join(__dirname, '..');
const FONT_PATH = path.join(ROOT, 'assets', 'fonts', 'Amiri-Regular.ttf');
const LOGO_PATH = path.join(ROOT, 'public', 'logo.png');

// القواميس المركزية المشتركة (تعمل في Node عبر module.exports) — نفس مصدر الشاشة
const ShiftTypeDictionary = require('../public/js/core/shift-type-dictionary.js');
const TimeRiyadh = require('../public/js/time-riyadh.js');
// تفويض «تصدير الجداول حسب فئة رمز القوة (A/B/C/D)»: فك الرموز عبر القاموس
// المركزي حصرًا (مصدر الحقيقة الوحيد — يُستدعى ولا يُعدَّل ولا يُصنَّف موازيًا)،
// وترتيب الأقسام/الفرق عبر قاموس الفرق المركزي، وحساب ساعات/مناوبات الموظف
// عبر محرك المقاييس الرسمي (resolveCodeDurationHours/_resolveWithKind) —
// صفر حساب مستقل هنا.
const SymbolDictionary = require('../public/js/core/symbol-dictionary.js');
const TeamDictionary = require('../public/js/core/team-dictionary.js');
const ScheduleMetricsService = require('./schedule-metrics-service.js');

// نسخة واحدة من محرك المقاييس لاستخدام دوال الحل النقية فقط
// (_resolveWithKind لا تلمس القاعدة إطلاقًا — المُحوِّل هيكلي لشرط المنشئ).
const metricsResolver = new ScheduleMetricsService({ db: { get: async () => null, all: async () => [] } });

// ─── فئة رمز القوة (قاعدة التجميع المعتمدة من المالك — تنفيذ حرفي) ───
// الفئة تُستخرج من الرمز المُطبَّع + مخرجات resolveSymbol فقط:
//   A1/AA10/A0/A00/AZ ⇒ الحرف الأول (حرف القوة) · RRA1 ⇒ الحرف بعد RR (الدورية)
//   O12A12 ⇒ حرف الطاقم (آخر حرف من overlapCrew) · O12B الكلاسيكي ⇒ حرفه B
//   أوفرلاب بلا حرف (O15) ⇒ null ⇒ يُستبعد من تصدير الفئة (معالجة موثقة —
//   الأقل كلفة: لا قسم خاص؛ الرمز لا يحمل فئة أصلًا فإدخاله في أي فئة اختلاق).
//   XX/XY/Z/0/Y وبلا symbol ⇒ null ⇒ مستبعدة (لا حرف قوة فيها).
function resolveGroupCategory(rawSym, jobTitle) {
    const resolved = SymbolDictionary.resolveSymbol(rawSym, jobTitle);
    if (!resolved) return null;
    const sym = SymbolDictionary.normalize(rawSym);
    let m = sym.match(/^RR([A-D])\d+$/);                    // RRA1 — الدورية
    if (m && resolved.kind === 'rapid') return m[1];
    if (resolved.overlapCrew) {                              // O12A12 — فئة صريحة من الطاقم
        const cm = String(resolved.overlapCrew).match(/([A-D])$/);
        return cm ? cm[1] : null;
    }
    if (resolved.kind === 'overlap') {                       // O12B ⇒ B · O15 ⇒ null
        m = sym.match(/^O\d+([A-D])$/);
        return m ? m[1] : null;
    }
    m = sym.match(/^([A-D])/);                               // حرف القوة الأول (مركز/قيادة/عمليات/دعم)
    return m ? m[1] : null;
}

// الأقسام التشغيلية وترتيبها المعتمد: كبير المسعفين ← العمليات ← المراكز ←
// سريع ← الأوفرلاب ← الإدارات (نفس ترتيب team-dictionary ORDER).
const GROUP_SECTION_ORDER = ['leadership', 'ops', 'center', 'rapid', 'overlap', 'admin'];
const GROUP_SECTION_LABELS = {
    leadership: 'كبير المسعفين', ops: 'العمليات', center: 'المراكز',
    rapid: 'سريع', overlap: 'الأوفرلاب', admin: 'الإدارات'
};

// اسم الفرقة الحقيقي للعرض: «جنوب 1 — A» · «سريع 2 — A» · «جنوب 12 — طاقم O12A — A»
function groupTeamLabel(resolved, category) {
    const base = resolved.team + (resolved.overlapCrew ? ' — طاقم ' + resolved.overlapCrew : '');
    return { sortName: base, label: base + ' — ' + category };
}

// ملخص الموظف للشهر المُصدَّر — من محرك المقاييس حصرًا:
//   الساعات = مجموع حلول _resolveWithKind (دوام + تغطية؛ EV/الغير قابل null لا يُحسب)
//   المناوبات = عدد خلايا العمل الفعلي (kind==='work') فقط — التغطية E/VC/V/S
//   «إجازة محسوبة» لا تدخل العد (قرار المالك 2026-08-13 نفسه في dayScope).
//   D/N من تصنيف القاموس المركزي للخلية: صباح/OVD ⇒ D · ليل/ليل8/أوفرلاب ⇒ N
//   (نفس قاعدة «صباحية/ليلية» في shift-type-dictionary — لا تصنيف مستقل).
function summarizeEmployeeCells(cells, codesByCode) {
    let hours = 0, work = 0, day = 0, night = 0;
    Object.keys(cells).forEach(d => {
        const s = cells[d];
        const r = metricsResolver._resolveWithKind(s.shiftCode || s.shift || '', codesByCode);
        if (!r) return;
        hours += r.hours;
        if (r.kind !== 'work') return;
        work++;
        const g = ShiftTypeDictionary.classifyEntry(s).group;
        const code = String(s.shiftCode || s.shift || '').trim().toUpperCase();
        if (g === 'morning' || code === 'OVD') day++;
        else if (g === 'night' || g === 'night8' || g === 'overlap') night++;
    });
    return { hours: Math.round(hours * 10) / 10, work, day, night };
}

// ─── خط أنبوب العربية (محسوم ومُثبت بصريًا في workflow-pdf-service — لا يُغيَّر) ───
function ar(t) {
    if (!/[؀-ۿ]/.test(t)) return t;              // لاتيني/أرقام خالصة: كما هي
    const V = bidi.getReorderedString(t, bidi.getEmbeddingLevels(t, 'rtl'));
    return '‏' + [...V].reverse().join('');
}

const ARABIC_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

// ألوان خلايا الأكواد — نفس لوحة وسيلة إيضاح العرض الكلاسيكي في smart-schedule.html
const GROUP_COLORS = {
    morning: '#DBEAFE', night: '#E9D5FF', night8: '#E9D5FF', overlap: '#E0F2FE',
    office: '#D1FAE5', mission: '#FEF3C7', vacation: '#FEE2E2', rest: '#F1F5F9',
    training: '#FFEDD5', off: '#F1F5F9', unscheduled: '#FFFFFF'
};

// نص الخلية — نفس قاعدة العرض الكلاسيكي: الكود كما هو، و«إجازة»/«راحة» إن كانت الحالة كذلك
function cellText(s) {
    if (s.status === 'إجازة') return 'إجازة';
    if (s.status === 'راحة') return 'راحة';
    return String(s.shiftCode || s.shift || s.status || '');
}

/**
 * بنّاء بيانات الجدول (نقي ومُصدَّر للاختبار):
 * يفلتر الموظفين/السجلات بمعيار فلتر «الموقع» نفسه، ويجمع أيام الفترة،
 * ويشتق الشهر/السنة من أول تاريخ إن لم يُمرَّر month.
 *
 * نمط المجموعة (تفويض «تصدير حسب فئة رمز القوة»): opts.group = A/B/C/D —
 * يدخل الموظف إن كانت فئة رمزه (resolveGroupCategory عبر symbol-dictionary
 * حصرًا) = المطلوبة، مع الاحتفاظ باسم الفرقة الحقيقي للعرض (teamLabel) وقسمه
 * التشغيلي (sectionKey) وملخص ساعاته/مناوباته (summary — من محرك المقاييس
 * عبر opts.codesByCode). فرع center أعلاه لم يُمس — سلوكه حرفي كما كان.
 */
function buildSchedulePdfData(allEmployees, opts) {
    opts = opts || {};
    const center = String(opts.center || '').trim();
    const group = String(opts.group || '').trim().toUpperCase();
    const codesByCode = (opts.codesByCode instanceof Map) ? opts.codesByCode : null;
    const month = String(opts.month || '').trim();        // YYYY-MM أو فراغ
    const employees = [];
    const daySet = {};
    (Array.isArray(allEmployees) ? allEmployees : []).forEach(e => {
        if (!e) return;
        // نمط المجموعة: الفئة من رمز القوة فقط؛ بلا رمز/بلا فئة ⇒ استبعاد موثق
        let resolved = null, category = null;
        if (group) {
            resolved = SymbolDictionary.resolveSymbol(e.symbol, e.jobTitle);
            category = resolveGroupCategory(e.symbol, e.jobTitle);
            if (!resolved || category !== group) return;
        }
        const entries = (Array.isArray(e.schedule) ? e.schedule : []).filter(s => {
            if (!s || !s.date) return false;
            if (center && s.location !== center && e.team !== center) return false;
            if (month && !String(s.date).startsWith(month)) return false;
            return true;
        });
        if (!entries.length) return;
        const cells = {};
        entries.forEach(s => { if (!cells[s.date]) cells[s.date] = s; daySet[s.date] = true; });
        const emp = {
            id: e.id || '',
            code: e.employeeNumber || e.id || '',
            name: e.name || '',
            jobTitle: e.jobTitle || '',
            team: e.team || '',
            cells
        };
        if (group) {
            const tl = groupTeamLabel(resolved, category);
            emp.sectionKey = resolved.kind;                 // leadership/ops/center/rapid/overlap/admin
            emp.teamSortName = tl.sortName;
            emp.teamLabel = tl.label;                       // «جنوب 1 — A»
            if (codesByCode) emp.summary = summarizeEmployeeCells(cells, codesByCode);
        }
        employees.push(emp);
    });
    employees.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));

    const days = Object.keys(daySet).sort().map(d => ({
        date: d,
        dayNum: parseInt(d.split('-')[2], 10),
        dayName: TimeRiyadh.formatDayName(d)
    }));

    // اشتقاق الفترة: الشهر الممرَّر أو شهر أول يوم في البيانات المفلترة
    let year = 0, monthNum = 0;
    if (month) {
        year = parseInt(month.split('-')[0], 10);
        monthNum = parseInt(month.split('-')[1], 10);
    } else if (days.length) {
        const p = days[0].date.split('-');
        year = parseInt(p[0], 10);
        monthNum = parseInt(p[1], 10);
    }
    const monthLabel = monthNum ? (ARABIC_MONTHS[monthNum - 1] + ' ' + year) : '';

    // ملخص الفئات (من القاموس المركزي فقط — صفر شرط على كود هنا)
    const groupCounts = {};
    employees.forEach(emp => {
        days.forEach(d => {
            const s = emp.cells[d.date];
            if (!s) return;
            const g = ShiftTypeDictionary.classifyEntry(s).group;
            groupCounts[g] = (groupCounts[g] || 0) + 1;
        });
    });

    const out = { center, month: month || (year ? year + '-' + String(monthNum).padStart(2, '0') : ''), monthLabel, year, monthNum, days, employees, groupCounts };

    // نمط المجموعة: هيكلة الأقسام والفرق (الترتيب من قاموس الفرق المركزي)
    if (group) {
        const byKey = {};   // sectionKey|sortName → { name, label, employees[] }
        employees.forEach(emp => {
            const k = emp.sectionKey + '|' + emp.teamSortName;
            if (!byKey[k]) byKey[k] = { sectionKey: emp.sectionKey, sortName: emp.teamSortName, label: emp.teamLabel, employees: [] };
            byKey[k].employees.push(emp);
        });
        out.group = group;
        out.sections = GROUP_SECTION_ORDER
            .filter(sk => Object.keys(byKey).some(k => k.indexOf(sk + '|') === 0))
            .map(sk => {
                const teams = Object.keys(byKey)
                    .filter(k => k.indexOf(sk + '|') === 0)
                    .map(k => byKey[k]);
                const sorted = TeamDictionary.sortTeamNames(teams.map(t => t.sortName));
                return {
                    key: sk,
                    label: GROUP_SECTION_LABELS[sk] || sk,
                    teams: sorted.map(sn => teams.find(t => t.sortName === sn))
                        .map(t => ({ name: t.label, employees: t.employees }))
                };
            });
    }

    return out;
}

/**
 * مولّد الـPDF — يستلم ناتج buildSchedulePdfData ويعيد Promise<Buffer>.
 * A4 أفقي (شبكة موظفين × أيام) — نفس اتجاه التصدير العميلي السابق.
 */
function generateSchedulePdf(data) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4', layout: 'landscape', margin: 26,
                info: { Title: 'جدول مناوبات ' + (data.center || '') + ' — ' + (data.monthLabel || '') }
            });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('error', reject);
            doc.on('end', () => resolve(Buffer.concat(chunks)));

            doc.registerFont('amiri', FONT_PATH);
            doc.font('amiri');

            const PAGE_W = doc.page.width;    // 841.89 (landscape)
            const PAGE_H = doc.page.height;   // 595.28
            const M = 26;
            const CW = PAGE_W - 2 * M;
            let y = M;

            const BLUE = '#1e3a8a', GRAY = '#475569', MUTED = '#64748b', BORDER = '#cbd5e1';

            // نص عربي بمحاذاة يمين — features:{} دائمًا (القاعدة الحرجة)
            function tr(txt, x, yy, w, opts) {
                doc.text(ar(String(txt)), x, yy, Object.assign({ width: w, align: 'right', features: {} }, opts || {}));
            }
            function tc(txt, x, yy, w, opts) {   // نص موسّط (خلايا الأكواد — لاتيني غالبًا)
                doc.text(ar(String(txt)), x, yy, Object.assign({ width: w, align: 'center', features: {} }, opts || {}));
            }

            // ═══ ترويسة المنصة (نفس هوية سير العمل — نفس المواضع والارتفاعات حرفيًا) ═══
            // تفويض المالك (2026-08-08): إزالة عناصر الإيحاء بالصدور الرسمي عن
            // الهيئة من قوالب PDF — التصميم كما هو. الشعار المرسوم شعار المنصة
            // الخاص (ليس شعار الهيئة) فيبقى؛ سطرا «المملكة»/«الهيئة» وسطر
            // «الإدارة العامة للخدمات الإسعافية» أُزيلت، مع الحفاظ على مواضع y
            // وارتفاع الشريط (54) وكل الألوان/الخطوط بلا أي تغيير بصري آخر.
            try {
                if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, PAGE_W - M - 46, y, { width: 46, height: 46 });
            } catch (_) { /* الشعار اختياري */ }
            doc.font('amiri').fontSize(8).fillColor(MUTED);
            tr('منصة إدارة العمليات الإسعافية', M, y + 1, CW - 56);
            doc.font('amiri').fontSize(12).fillColor(BLUE);
            tr('قطاع جنوب الرياض', M, y + 12, CW - 56);
            doc.font('amiri').fontSize(11).fillColor(BLUE);
            tr(data.group ? ('جدول المناوبات الشهري — فئة القوة ' + data.group) : 'جدول المناوبات الشهري للمركز', M, y + 40, CW - 56);
            y += 54;

            // شريط التعريف: المركز/الفئة • الفترة • عدد الكادر • وقت التوليد (الرياض)
            const generatedAt = TimeRiyadh.formatDateTime(new Date().toISOString());
            doc.roundedRect(M, y, CW, 22, 4).fill('#eff6ff');
            doc.font('amiri').fontSize(10).fillColor(BLUE);
            tr(data.group ? ('الفئة: ' + data.group) : ('المركز: ' + data.center), M + 10, y + 6, 200);
            doc.font('amiri').fontSize(9).fillColor('#0f172a');
            tr('الفترة: ' + data.monthLabel + '   •   الكادر: ' + data.employees.length + ' موظف   •   وُلِّد: ' + generatedAt, M + 10, y + 6.5, CW - 220);
            y += 28;
            doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(1.5).strokeColor(BLUE).stroke();
            doc.moveTo(M, y + 2.5).lineTo(M + CW, y + 2.5).lineWidth(0.5).strokeColor(BLUE).stroke();
            y += 8;

            // ═══ شبكة الجدول: الموظف (يمين) × الأيام ═══
            const days = data.days;
            const nameW = 128;
            const dayW = days.length ? (CW - nameW) / days.length : 0;
            const HEADER_H = 24;
            // نمط المجموعة: صف أعلى (24) ليسع خط الملخص تحت اسم الموظف؛ نمط المركز 15 كما كان حرفيًا
            const ROW_H = data.sections ? 24 : 15;

            // قياس خط الاسماء: تخفيض تناسبي حتى يتسع أطول اسم بسطر واحد (بلا التفاف أبدًا)
            let nameFs = 7;
            doc.font('amiri').fontSize(nameFs);
            let maxName = 0;
            data.employees.forEach(e => { maxName = Math.max(maxName, doc.widthOfString(ar(e.name || '—'), { features: {} })); });
            if (maxName > nameW - 8) nameFs = Math.max(4.6, nameFs * (nameW - 8) / maxName);
            const codeFs = Math.min(6.2, Math.max(4.2, dayW * 0.30));
            // اسم اليوم تحت الرقم: تخفيض تناسبي حتى يتسع أطول اسم («ثلاثاء») في عرض الخلية
            let dayNameFs = 4.6;
            doc.font('amiri').fontSize(dayNameFs);
            let maxDayName = 0;
            days.forEach(d => { maxDayName = Math.max(maxDayName, doc.widthOfString(ar(d.dayName.replace(/^ال/, '')), { features: {} })); });
            if (maxDayName > dayW) dayNameFs = Math.max(3.2, dayNameFs * dayW / maxDayName);

            function drawGridHeader() {
                doc.rect(M, y, CW, HEADER_H).fill('#eff6ff');
                doc.font('amiri').fontSize(7.5).fillColor(BLUE);
                tr('الموظف / اليوم', M + CW - nameW + 4, y + 8, nameW - 8);   // عمود الاسم = أقصى اليمين (RTL)
                days.forEach((d, i) => {
                    const x = M + CW - nameW - (i + 1) * dayW;   // RTL: اليوم الأول يلي عمود الاسم يسارًا
                    doc.font('amiri').fontSize(6.8).fillColor('#0f172a');
                    tc(String(d.dayNum), x, y + 3, dayW, { lineBreak: false });
                    doc.font('amiri').fontSize(dayNameFs).fillColor(MUTED);
                    tc(d.dayName.replace(/^ال/, ''), x, y + 13, dayW, { lineBreak: false });
                });
                y += HEADER_H;
                doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(1).strokeColor(BORDER).stroke();
                // فاصل عمودي بين عمود الاسم والأيام (يُرسم مع الترويسة وكل صف — يمتد عبر الصفحات)
                doc.moveTo(M + CW - nameW, y - HEADER_H).lineTo(M + CW - nameW, y).lineWidth(0.7).strokeColor(BORDER).stroke();
            }

            function drawRow(emp, idx) {
                if (idx % 2 === 1) doc.rect(M, y, CW, ROW_H).fill('#F8FAFC');
                days.forEach((d, i) => {
                    const x = M + CW - nameW - (i + 1) * dayW;
                    const s = emp.cells[d.date];
                    if (s) {
                        const g = ShiftTypeDictionary.classifyEntry(s).group;
                        const bg = GROUP_COLORS[g] || '#FFFFFF';
                        doc.rect(x + 0.5, y + 1.5, dayW - 1, ROW_H - 3).fill(bg);
                        doc.font('amiri').fontSize(codeFs).fillColor('#0f172a');
                        tc(cellText(s), x, y + 4.5, dayW, { lineBreak: false });
                    }
                });
                // الاسم أخيرًا ليبقى فوق أي خلية متاخمة — في عموده بأقصى اليمين
                doc.font('amiri').fontSize(nameFs).fillColor('#0f172a');
                tr(emp.name || '—', M + CW - nameW + 4, y + 4, nameW - 8, { lineBreak: false });
                // نمط المجموعة: تحت كل موظف ملخصه — إجمالي الساعات + إجمالي
                // المناوبات (خلايا العمل الفعلي) + تفصيل نوعها D/N
                if (emp.summary) {
                    const sm = emp.summary;
                    doc.font('amiri').fontSize(Math.max(4.2, nameFs - 1.6)).fillColor(MUTED);
                    tr(sm.hours + ' ساعة · مناوبات: ' + sm.work + ' · D:' + sm.day + ' N:' + sm.night,
                        M + CW - nameW + 4, y + 14, nameW - 8, { lineBreak: false });
                }
                y += ROW_H;
                doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.4).strokeColor(BORDER).stroke();
                doc.moveTo(M + CW - nameW, y - ROW_H).lineTo(M + CW - nameW, y).lineWidth(0.7).strokeColor(BORDER).stroke();
            }

            drawGridHeader();
            if (data.sections) {
                // ═══ نمط المجموعة: قسم ← فرقة باسمها الحقيقي ← موظفوها ═══
                const SEC_H = 17, TEAM_H = 13;
                let rowIdx = 0;
                data.sections.forEach(sec => {
                    const secCount = sec.teams.reduce((n, t) => n + t.employees.length, 0);
                    if (y + SEC_H + TEAM_H + ROW_H + 8 > PAGE_H - 56) { doc.addPage(); y = M; drawGridHeader(); }
                    doc.rect(M, y, CW, SEC_H).fill('#1e3a8a');
                    doc.font('amiri').fontSize(8.5).fillColor('#FFFFFF');
                    tr(sec.label + ' (' + secCount + ')', M + 8, y + 4.5, CW - 16, { lineBreak: false });
                    y += SEC_H;
                    doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.7).strokeColor(BORDER).stroke();
                    sec.teams.forEach(team => {
                        if (y + TEAM_H + ROW_H + 8 > PAGE_H - 56) { doc.addPage(); y = M; drawGridHeader(); }
                        doc.rect(M, y, CW, TEAM_H).fill('#e2e8f0');
                        doc.font('amiri').fontSize(7).fillColor('#0f172a');
                        tr(team.name + ' — ' + team.employees.length + ' موظف', M + 8, y + 3, CW - 16, { lineBreak: false });
                        y += TEAM_H;
                        doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.5).strokeColor(BORDER).stroke();
                        team.employees.forEach(emp => {
                            if (y + ROW_H + 8 > PAGE_H - 56) { doc.addPage(); y = M; drawGridHeader(); }
                            drawRow(emp, rowIdx++);
                        });
                    });
                });
            } else {
                data.employees.forEach((emp, idx) => {
                    if (y + ROW_H + 8 > PAGE_H - 56) { doc.addPage(); y = M; drawGridHeader(); }
                    drawRow(emp, idx);
                });
            }

            // ═══ ملخص الفئات + وسيلة الإيضاح (للمجموعات الحاضرة فقط) ═══
            const presentGroups = Object.keys(data.groupCounts);
            if (presentGroups.length) {
                if (y + 44 > PAGE_H - 40) { doc.addPage(); y = M; }
                y += 8;
                const parts = presentGroups
                    .sort((a, b) => data.groupCounts[b] - data.groupCounts[a])
                    .map(g => (ShiftTypeDictionary.LABELS[g] || g) + ' ' + data.groupCounts[g]);
                doc.font('amiri').fontSize(8).fillColor(GRAY);
                tr('ملخص الفترة: ' + parts.join(' • '), M, y, CW);
                y += 14;
                let lx = M + CW;
                presentGroups.forEach(g => {
                    const label = ShiftTypeDictionary.LABELS[g] || g;
                    doc.font('amiri').fontSize(7);
                    const w = doc.widthOfString(ar(label), { features: {} }) + 22;
                    lx -= w;
                    doc.rect(lx, y, 10, 8).fill(GROUP_COLORS[g] || '#FFFFFF');
                    doc.rect(lx, y, 10, 8).lineWidth(0.4).strokeColor(BORDER).stroke();
                    doc.font('amiri').fontSize(7).fillColor('#0f172a');
                    tr(label, lx + 12, y + 1, w - 14, { lineBreak: false });
                    lx -= 10;
                });
                y += 16;
            }

            // ═══ Footer (نفس لكنة سير العمل — توليد إلكتروني بتوقيت الرياض) ═══
            if (y + 30 > PAGE_H - 26) { doc.addPage(); y = M; }
            y += 6;
            doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(1).strokeColor(BLUE).stroke();
            y += 5;
            doc.font('amiri').fontSize(7.5).fillColor(MUTED);
            tr('هذا الجدول أُنشئ إلكترونيًا من منصة إدارة العمليات الإسعافية – قطاع جنوب الرياض • وقت التوليد: ' + generatedAt + ' (توقيت الرياض)', M, y, CW);
            y += 10;
            tr('نسخة قابلة للطباعة A4 وللإرسال للفرق — أي تحديث على الجدول يستلزم إعادة التصدير', M, y, CW);

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

module.exports = { buildSchedulePdfData, generateSchedulePdf, resolveGroupCategory };
