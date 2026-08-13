// ============================================
// Phase 2: ScheduleMetricsService — مؤشرات الساعات الشهرية
// ============================================
// اشتقاق حي من shift_roster + shift_codes عند كل طلب — بلا عدادات مخزنة
// ولا جداول جديدة؛ تعديل أي خلية ينعكس في الحساب التالي مباشرة.
//
// حل مدة الرمز (resolveCodeDurationHours) بأولوية صارمة:
//  1) time_start/time_end في shift_codes (HH:MM) — الفرق بالساعات، وإن كان
//     end <= start يُضاف 24 (عبور منتصف الليل: 17:00→05:00 = 12).
//  2) الأكواد التشغيلية الملحقة: المحلل المشترك (operational-codes.js) يحسم
//     المدة من تعريف الكود نفسه (RRA1-D-04/RRA1-04 ⇒ 12) — يقتل خطأ القراءة
//     النصية «RRA1-04 ⇒ ساعة واحدة» لأي كود بلا صف تعريف.
//  3) خريطة التغطية المعتمدة إداريًا (2026-08-13): E/VC/V/S = 8 ساعات فعلية
//     لكل خلية — تغطية محسوبة لا خصم من المطلوب (المطلوب يبقى 192 ثابتًا).
//     EV تبقى خارج القاعدة صراحةً = غير محسوبة.
//  4) تحليل الاسم/الرمز: ^[A-Za-z]+(\d{1,2}) — الرقم بعد السابقة الحرفية
//     (D12→12، D8→8، O12-09→12 — لاحق الشرطة لا يُقرأ إطلاقًا).
//  5) خلاف ذلك null (WO/R/C/ME/EV…) غير قابلة للتخمين) — ممنوع افتراض 12.
//
// الحقن: { db } وحدة واجهة القاعدة (get/all) — يُختبر على قاعدة مؤقتة
// ويُستخدم إنتاجيًا عبر db.js نفسه (نفس نمط RosterSyncService).
// ============================================

const OperationalCodes = require('../public/js/core/operational-codes.js');

class ScheduleMetricsService {
    constructor({ db }) {
        if (!db || typeof db.get !== 'function' || typeof db.all !== 'function') {
            throw new Error('ScheduleMetricsService: db adapter (get/all) مطلوب');
        }
        this.db = db;
    }

    /** تقريب لخانة عشرية واحدة (الساعات قد تكون كسرية مثل 8.5). */
    _round1(n) {
        return Math.round(n * 10) / 10;
    }

    /** تصنيف التخصص من المسمى الوظيفي — مركزي هنا فقط، لا نسخة أخرى في النظام. */
    classifySpecialty(jobTitle) {
        const t = String(jobTitle || '');
        if (t.includes('أخصائي')) return 'specialist';
        if (t.includes('فني')) return 'technician';
        return 'other';
    }

    /**
     * مدة رمز المناوبة بالساعات وفق الأولوية الموثقة أعلاه.
     * @param {string} code رمز اليوم كما هو مخزن في shift_roster.
     * @param {Map} codesByCode خريطة shift_codes بالرمز (والمُحوَّل لأحرف كبيرة).
     * @returns {number|null} الساعات (خانة عشرية واحدة) أو null لغير القابل للتخمين.
     */
    resolveCodeDurationHours(code, codesByCode) {
        const r = this._resolveWithKind(code, codesByCode);
        return r ? r.hours : null;
    }

    /**
     * نوع حسم رمز اليوم — نفس سلسلة الأولوية المركزية، بلا أي منطق تصنيف جديد:
     * 'work'     ← ساعات من تعريف الرمز (time_start/end) أو الاسم (D12/N12/O12-09…)
     * 'coverage' ← خريطة التغطية المعتمدة E/VC/V/S (8 ساعات محسوبة — ليست دوامًا فعليًا)
     * null       ← غير قابل للحسم (WO/R/C/EV…)
     * يخدم مؤشرات اليوم الواحد (dayScope): العاملون = 'work' فقط.
     */
    resolveCodeDurationKind(code, codesByCode) {
        const r = this._resolveWithKind(code, codesByCode);
        return r ? r.kind : null;
    }

    /** النواة المشتركة: { hours, kind } أو null — المصدر الوحيد للدالتين أعلاه. */
    _resolveWithKind(code, codesByCode) {
        const raw = String(code || '').trim();
        if (!raw) return null;
        const row = codesByCode.get(raw) || codesByCode.get(raw.toUpperCase()) || null;

        // 1) وقت البداية/النهاية من جدول الرموز (الأدق — يشمل عبور منتصف الليل)
        if (row && row.time_start && row.time_end) {
            const p = /^(\d{1,2}):(\d{2})/;
            const ms = String(row.time_start).trim().match(p);
            const me = String(row.time_end).trim().match(p);
            if (ms && me) {
                const startMin = Number(ms[1]) * 60 + Number(ms[2]);
                let endMin = Number(me[1]) * 60 + Number(me[2]);
                if (endMin <= startMin) endMin += 24 * 60; // عبور منتصف الليل
                return { hours: this._round1((endMin - startMin) / 60), kind: 'work' };
            }
        }

        // 2) الأكواد التشغيلية الملحقة: المحلل المشترك يحسم المدة من تعريف الكود
        //    نفسه (RRA1-D-04/RRA1-04 ⇒ 12) — بعد أوقات الصف وقبل خريطة التغطية
        //    والتحليل النصي (يقتل خطأ «RRA1-04 ⇒ ساعة واحدة» لبلا صف تعريف).
        const _op = OperationalCodes.parseOperationalCode(raw);
        if (_op) return { hours: _op.durationH, kind: 'work' };

        // 3) خريطة التغطية المعتمدة إداريًا (2026-08-13): كل خلية من هذه
        //    الرموز = 8 ساعات فعلية (لا 12، ولا خصم من المطلوب — 192 ثابت).
        //    EV خارج القاعدة عمدًا: تبقى غير محسوبة (null ← القاعدة 4).
        const COVERAGE_8H = { E: 8, VC: 8, V: 8, S: 8 };
        const upper = raw.toUpperCase();
        if (Object.prototype.hasOwnProperty.call(COVERAGE_8H, upper)) {
            return { hours: COVERAGE_8H[upper], kind: 'coverage' };
        }

        // 4) تحليل نصي: أول رقم بعد سابقة حرفية لاتينية (D12→12، O12-09→12).
        //    يُجرَّب على الرمز ثم على الاسم — لاحق الشرطة لا يدخل المطابقة أصلًا.
        const name = row ? String(row.name || '') : '';
        const m = raw.match(/^[A-Za-z]+(\d{1,2})/) || name.match(/^[A-Za-z]+(\d{1,2})/);
        if (m) return { hours: Number(m[1]), kind: 'work' };

        // 5) غير قابل للتخمين (WO/R/C/ME/EV…) — null صريح، ممنوع افتراض 12
        return null;
    }

    /**
     * حساب مؤشرات الساعات لفترة [from, to] مقابل المطلوب الشهري.
     * @param {string} from تاريخ ISO (YYYY-MM-DD) شامل.
     * @param {string} to   تاريخ ISO (YYYY-MM-DD) شامل.
     * @param {number} requiredHours المطلوب الشهري (من app_settings).
     */
    async computeMetrics(from, to, requiredHours) {
        const required = Number(requiredHours);

        // رموز المناوبات تُقرأ مرة واحدة لكل طلب
        const codeRows = await this.db.all('SELECT code, name, time_start, time_end FROM shift_codes');
        const codesByCode = new Map();
        for (const r of codeRows) {
            const c = String(r.code || '').trim();
            if (!c) continue;
            codesByCode.set(c, r);
            codesByCode.set(c.toUpperCase(), r); // تسامح مع اختلاف حالة الأحرف المخزنة
        }

        // صفوف الفترة مع الموظفين النشطين (is_active = 0 وحدها تُقصى — NULL يُعامل نشطًا)
        const rows = await this.db.all(
            `SELECT sr.employee_id, sr.shift_date, sr.shift_code,
                    e.employee_code, e.name, e.job_title
             FROM shift_roster sr
             JOIN employees e ON e.id = sr.employee_id
             WHERE sr.shift_date >= ? AND sr.shift_date <= ?
               AND COALESCE(e.is_active, 1) != 0
             ORDER BY e.employee_code, sr.shift_date`, [from, to]);

        // تجميع لكل موظف بالرمز الوظيفي (مفتاح الهوية الوحيد — نفس عقد SR-2)
        const byEmp = new Map();
        let totalUncounted = 0;
        for (const r of rows) {
            const code = String(r.employee_code || r.employee_id);
            let emp = byEmp.get(code);
            if (!emp) {
                emp = {
                    employeeCode: code,
                    name: r.name || '',
                    jobTitle: r.job_title || '',
                    specialty: this.classifySpecialty(r.job_title),
                    scheduledHours: 0,
                    uncountedEntries: 0
                };
                byEmp.set(code, emp);
            }
            const hours = this.resolveCodeDurationHours(r.shift_code, codesByCode);
            if (hours === null) {
                emp.uncountedEntries++; // شفافية: يوم بلا ساعات قابلة للاشتقاق
                totalUncounted++;
            } else {
                emp.scheduledHours = this._round1(emp.scheduledHours + hours);
            }
        }

        // الحالة مقابل المطلوب: التساوي التام = مكتمل
        const employees = [...byEmp.values()].map(emp => {
            const scheduled = this._round1(emp.scheduledHours);
            const delta = this._round1(scheduled - required);
            return {
                employeeCode: emp.employeeCode,
                name: emp.name,
                jobTitle: emp.jobTitle,
                specialty: emp.specialty,
                scheduledHours: scheduled,
                requiredHours: required,
                deltaHours: delta,
                status: delta === 0 ? 'complete' : (delta < 0 ? 'under' : 'over'),
                uncountedEntries: emp.uncountedEntries
            };
        });

        const summary = {
            totalEmployees: employees.length,
            specialists: employees.filter(e => e.specialty === 'specialist').length,
            technicians: employees.filter(e => e.specialty === 'technician').length,
            other: employees.filter(e => e.specialty === 'other').length,
            complete: employees.filter(e => e.status === 'complete').length,
            under: employees.filter(e => e.status === 'under').length,
            over: employees.filter(e => e.status === 'over').length,
            totalHours: this._round1(employees.reduce((s, e) => s + e.scheduledHours, 0)),
            avgHours: employees.length
                ? this._round1(employees.reduce((s, e) => s + e.scheduledHours, 0) / employees.length)
                : 0,
            uncountedEntries: totalUncounted
        };

        // نطاق اليوم الواحد (from === to): العاملون = رموز الدوام الفعلي فقط ('work')،
        // ورموز التغطية E/VC/V/S «إجازة محسوبة» لا تدخل أعداد العاملين (قرار المالك
        // 2026-08-13). نفس المحلل والمصنف المركزيين — مجرد تجميع إضافي على rows.
        let dayScope = null;
        if (from === to) {
            dayScope = { working: 0, specialists: 0, technicians: 0, other: 0, leave: 0, off: 0 };
            for (const r of rows) {
                const kind = this.resolveCodeDurationKind(r.shift_code, codesByCode);
                if (kind === 'work') {
                    dayScope.working++;
                    const sp = this.classifySpecialty(r.job_title);
                    if (sp === 'specialist') dayScope.specialists++;
                    else if (sp === 'technician') dayScope.technicians++;
                    else dayScope.other++;
                } else if (kind === 'coverage') {
                    dayScope.leave++;
                } else {
                    dayScope.off++;
                }
            }
        }

        return { from, to, requiredHours: required, employees, summary, dayScope };
    }
}

module.exports = ScheduleMetricsService;
