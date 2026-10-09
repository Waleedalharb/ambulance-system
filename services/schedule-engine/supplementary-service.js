/**
 * ═══ services/schedule-engine/supplementary-service.js — المناوبة التكميلية ═══
 *
 * capability مستقلة كليًا عن E-8 (flex_requests): E-8 «نقل التزام قائم» يبقى
 * كما هو بلا حرف؛ هنا «إضافة مناوبة اختيارية» لا تمس shift_roster إلا بعد
 * مراجعة بشرية وتطبيق ذري.
 *
 * قرارات المالك المعتمدة 2026-10-08:
 *  ① المقترحات موجهة للموظف: أفقها بقية الشهر الحالي، لكل يوم × كل رمز
 *     «دوام» يجتاز E-4 — وليست brute-force بلا تحقق. candidates وunavailable
 *     بنفس مستوى التفاصيل، وأسباب عدم التوفر = أكواد E-4 كما هي (لا اختراع).
 *  ② الساعات (required/worked/remaining) عرض وتوجيه فقط — ليست eligibility
 *     gate إطلاقًا. required تُقرأ من مفتاحها القائم monthly_required_hours
 *     كما هو (لا يُمس ولا يُزرع من هنا).
 *  ③ الإعدادان Fail-Closed (نمط E-8 ⑤): schedule_engine.supp_max_per_month
 *     و schedule_engine.supp_min_notice_hours يُقرآن من app_settings مباشرة؛
 *     الغياب/NULL ⇒ 503 SUPP_CONFIG_MISSING — لا رقم صامت ولا unlimited.
 *     لا يُضافان إلى ENGINE_DEFAULTS عمدًا.
 *  ④ لا اعتماد آلي إطلاقًا: كل طلب pending_review يحسمه حامل
 *     schedule.requests.review. الاعتماد والتطبيق ذرّيان في ترانزاكشن واحدة
 *     (نمط E-8 L2) — لا حالة approved معلّقة؛ فشل حارس التطبيق ⇒ escalated
 *     (قرار مسؤول) والطلب لا يعلق.
 *  ⑤ الحراس البنيوية: uq_supp_live_emp_date يمنع طلبين حيّين لنفس الموظف
 *     في نفس اليوم؛ كل تحديث حالة شرطي (changes=1)؛ إعادة تحقق E-4 لحظية
 *     قبل الاعتماد (لا ثقة بفحص سابق)؛ فحوص اللقطة خامًا داخل الترانزاكشن.
 *     عملية 'add' لا تكسر التغطية بنيويًا (E-4 ج3: add ⇒ لا wouldBreak
 *     أبدًا) فلا حارس تغطية عند التطبيق — موثق.
 *  ⑥ التطبيق (نمط _applyInTx حرفيًا): UPDATE شرطي ⇒ لقطة خام (لا مناوبة
 *     للموظف بذلك اليوم · عضوية حية بنفس الفريق) ⇒ INSERT shift_roster ⇒
 *     schedule_revisions (source='supplementary') ⇒ shift_audit_log ('add'
 *     بنمط F-1) ⇒ audit_log — أي فشل = ROLLBACK كامل بصفر تعديل جزئي.
 *     roster_id يُكتب في الطلب داخل نفس الترانزاكشن.
 *  ⑦ الإشعارات بعد COMMIT فقط وتُطلق من server.js (سقوطها آمن) — الخدمة
 *     نقية: لا إشعارات ولا SSE ولا HTTP داخلها.
 *  ⑧ العدّاد الشهري: الحيّة (pending_review/escalated) + applied في شهر
 *     اليوم المستهدف. rejected/cancelled/expired لا تستهلك.
 *  ⑨ الانقضاء كسول (نمط E-8): طلب حيّ تجاوز يومه المستهدف ⇒ expired عند
 *     أول قراءة — بلا مجدول.
 *
 * قرارا المالك 2026-10-08:
 *  (أ) مصدر المناوبة التكميلية = رموز shift_codes بحالة 'تكميل' ذات الأوقات
 *     الفعلية (time_start/time_end) — حاليًا CPD/CPN، وأي رمز «تكميل» مستقبلي
 *     بأوقات يدخل تلقائيًا (لا hard-code لرموز بعينها). رموز «دوام» ليست
 *     مصدرًا هنا إطلاقًا، ومعنى shift_codes الحالية لا يتغير. الأهلية تمر عبر
 *     E-4 بسياق مستقل context='supplementary' — السياق الافتراضي يبقى كما هو
 *     حرفيًا (E-8/E-5 وكل المستدعين القائمين بلا تأثر).
 *  (ب) المناوبة التكميلية لا تدخل حساب الحد الأدنى للتغطية التشغيلية —
 *     coverage-service.js لا يُمس، وperiodOf يبقى «دوام» فقط؛ التكميلية
 *     سعة إضافية اختيارية لا ترفع ولا تخفض minimum coverage، وإلغاؤها لا
 *     «يكسر» التغطية. هذا القرار مقصود وموثق — لا يُفسَّر لاحقًا كخطأ.
 *     تبعًا لذلك وسم coverage_gap في المقترحات يقيس فجوة التغطية الأساسية
 *     فقط (رموز دوام) — مؤشر توجيهي للعرض وليس شرط أهلية.
 */
'use strict';

const TimeRiyadh = require('../../public/js/time-riyadh.js');
const { validateAssignment } = require('./validation-service.js');
const coverageService = require('./coverage-service.js');

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const LIVE_STATUSES = ['pending_review', 'escalated'];
const CANCELLABLE_STATUSES = LIVE_STATUSES.slice();
// ③ المفتاحان المعلّقان — لا قيمة افتراضية هنا ولا في ENGINE_DEFAULTS عمدًا
const KEY_MAX_PER_MONTH = 'schedule_engine.supp_max_per_month';
const KEY_MIN_NOTICE_HOURS = 'schedule_engine.supp_min_notice_hours';

class SupplementaryError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

class SupplementaryService {
    constructor(db) { this.db = db; }

    _riyadhToday() {
        const p = TimeRiyadh.riyadhParts(new Date());
        return `${p.year}-${p.month}-${p.day}`;
    }

    _addDays(date, n) {
        const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }

    // ═══ ③ الإعدادات — Fail-Closed ═══
    // القيمة المقبولة: عدد صحيح موجب حصرًا. الغياب/NULL/غير رقمية/كسرية/صفر/سالبة
    // كلها ⇒ 503 SUPP_CONFIG_MISSING. الصفر تحديدًا ليس «بلا حد» ولا «بلا نافذة» —
    // min_notice_hours=0 قرار تشغيلي صريح يتطلب تعديلًا مقصودًا هنا، لا قيمة تمر
    // صدفة من app_settings (توجيه المالك 2026-10-09).
    async _readPositiveIntSetting(key) {
        // AppSettings.get تفكّ JSON — قيمة فاسدة (JSON غير صالح) ترمي SyntaxError؛
        // نعاملها كإعداد غير صالح (Fail-Closed 503) لا كخطأ خادم 500.
        let raw;
        try { raw = await this.db.AppSettings.get(key); }
        catch { raw = undefined; }
        const n = raw === null || raw === undefined ? NaN : Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
            throw new SupplementaryError(503, 'SUPP_CONFIG_MISSING',
                `إعداد المحرك غير مكتمل: ${key} غير مضبوط أو غير صالح (المطلوب عدد صحيح موجب) — قرار Business معلّق. لا يُفترض رقم ولا يُعامل الغياب كسماح غير محدود`);
        }
        return n;
    }
    async _assertConfig() {
        const maxPerMonth = await this._readPositiveIntSetting(KEY_MAX_PER_MONTH);
        const minNotice = await this._readPositiveIntSetting(KEY_MIN_NOTICE_HOURS);
        return { maxPerMonth, minNoticeHours: minNotice };
    }

    /** عضوية الفريق الحية بتاريخ — اشتقاق خادمي صِرف (لا team_id من العميل). */
    async _membership(empId, date) {
        return this.db.get(
            `SELECT ta.team_id, t.name AS team_name FROM team_assignments ta
             JOIN teams t ON t.id = ta.team_id
             WHERE ta.employee_id = ? AND (ta.end_date IS NULL OR ta.end_date = '' OR ta.end_date >= ?)
             ORDER BY ta.is_primary DESC, ta.id DESC LIMIT 1`, [empId, date]);
    }

    /** مدة الرمز بالساعات — العابرة لمنتصف الليل +24 (عرض/حساب ساعات فقط). */
    _durationHours(code) {
        if (!code || !code.time_start || !code.time_end) return null;
        const p1 = String(code.time_start).split(':'), p2 = String(code.time_end).split(':');
        const s = Number(p1[0]) * 60 + Number(p1[1] || 0);
        let e = Number(p2[0]) * 60 + Number(p2[1] || 0);
        if (e <= s) e += 1440;
        return (e - s) / 60;
    }

    /** فترة العرض للرمز التكميلي من أوقاته الفعلية (تعريف M4: ≥12:00 ليل) —
     *  coverage-service.periodOf «دوام»-فقط ولا يُمس (قرار ب). */
    _periodFromTimes(code) {
        if (!code || !code.time_start) return null;
        return Number(String(code.time_start).slice(0, 2)) >= 12 ? 'night' : 'day';
    }

    /** ساعات حتى بداية المناوبة الفعلية (الرياض UTC+3)؛ بلا time_start ⇒ 0 تحفظيًا (نمط E-8 ②). */
    _hoursUntil(date, code) {
        if (!code || !code.time_start) return 0;
        return (Date.parse(`${date}T${code.time_start}:00+03:00`) - Date.now()) / 3600000;
    }

    /** ⑧ العدّاد الشهري — الحيّة + applied فقط. */
    async _monthlyUsed(empId, month) {
        const cnt = await this.db.get(
            `SELECT COUNT(*) AS n FROM supplementary_requests
             WHERE employee_id = ? AND month = ? AND status IN ('pending_review','escalated','applied')`,
            [empId, month]);
        return cnt.n;
    }

    // ═══ ① المقترحات — قراءة صِرفة (صفر كتابة) ═══

    /**
     * أيام بقية الشهر × رموز «دوام» — كل زوج يجتاز E-4 أو يُرجع بأسبابه.
     * @param {object} emp موظف الجلسة
     * @param {string} month YYYY-MM
     */
    async getCandidates(emp, month) {
        const cfg = await this._assertConfig(); // limits جزء من العقد — Fail-Closed أولًا
        if (!MONTH_RE.test(String(month || ''))) {
            throw new SupplementaryError(422, 'SUPP_INVALID_MONTH', 'الشهر غير صالح — الصيغة YYYY-MM');
        }
        const today = this._riyadhToday();
        const monthStart = `${month}-01`;
        // نهاية الشهر: اليوم السابق لبداية الشهر التالي
        const nextMonthStart = month.slice(5, 7) === '12'
            ? `${Number(month.slice(0, 4)) + 1}-01-01`
            : `${month.slice(0, 4)}-${String(Number(month.slice(5, 7)) + 1).padStart(2, '0')}-01`;
        const monthEnd = this._addDays(nextMonthStart, -1);
        const firstDay = this._addDays(today, 1) > monthStart ? this._addDays(today, 1) : monthStart;
        const candidates = [], unavailable = [];
        if (firstDay <= monthEnd) {
            // قرار (أ): المصدر = رموز «تكميل» بأوقات فعلية فقط — أي رمز مستقبلي
            // يحقق الشرط يدخل تلقائيًا؛ «دوام» وبلا-أوقات مستبعدان بنيويًا.
            const codes = (await this.db.ShiftCodes.getAll() || [])
                .filter(c => c.status === 'تكميل' && c.time_start && c.time_end);
            for (let date = firstDay; date <= monthEnd; date = this._addDays(date, 1)) {
                const membership = await this._membership(emp.id, date);
                // فجوة تغطية الفريق بهذا اليوم — وسم «خيار مناسب» ببيانات فعلية (①)
                let coverageGap = null;
                if (membership) {
                    const cov = await coverageService.computeCoverage(this.db, membership.team_id, date);
                    coverageGap = !cov.met;
                }
                for (const code of codes) {
                    const reasons = [];
                    if (!(this._hoursUntil(date, code) >= cfg.minNoticeHours)) reasons.push('SUPP_NOTICE_WINDOW');
                    const v = await validateAssignment(this.db, {
                        employeeId: emp.id, date, shiftCode: code.code, operation: 'add',
                        teamId: membership ? membership.team_id : null, context: 'supplementary'
                    });
                    if (!v.valid) reasons.push(...(v.reasons || []));
                    if (!reasons.length) {
                        candidates.push({
                            date, shift_code: code.code, shift_name: code.name || null,
                            time_start: code.time_start || null, time_end: code.time_end || null,
                            duration_hours: this._durationHours(code),
                            period: this._periodFromTimes(code),
                            coverage_gap: coverageGap
                        });
                    } else {
                        unavailable.push({ date, shift_code: code.code, reasons });
                    }
                }
            }
        }

        // ② الساعات — عرض فقط. required من مفتاحها القائم كما هو؛ الغياب ⇒ null بلا زرع.
        const requiredRaw = await this.db.AppSettings.get('monthly_required_hours');
        const required = (requiredRaw === null || requiredRaw === undefined || isNaN(Number(requiredRaw)))
            ? null : Number(requiredRaw);
        const rosterRows = await this.db.all(
            `SELECT r.shift_code FROM shift_roster r
             WHERE r.employee_id = ? AND r.shift_date >= ? AND r.shift_date <= ?`,
            [emp.id, monthStart, monthEnd]);
        const codeMap = new Map(((await this.db.ShiftCodes.getAll()) || []).map(c => [String(c.code), c]));
        let worked = 0;
        for (const r of rosterRows) worked += this._durationHours(codeMap.get(String(r.shift_code))) || 0;
        const used = await this._monthlyUsed(emp.id, month);

        return {
            month,
            limits: { max_per_month: cfg.maxPerMonth, used },
            hours: {
                required_hours: required,
                worked_hours: worked,
                remaining_hours: required === null ? null : required - worked
            },
            candidates,
            unavailable
        };
    }

    // ═══ القراءات ═══

    /** طلباتي مع اسم الفريق — قراءة فقط (+ انقضاء كسول ⑨). */
    async getMine(emp) {
        await this._lazyExpire();
        return this.db.all(
            `SELECT s.*, t.name AS team_name
             FROM supplementary_requests s LEFT JOIN teams t ON t.id = s.team_id
             WHERE s.employee_id = ? ORDER BY s.id DESC`, [emp.id]);
    }

    /** قائمة مراجعة المسؤول — قراءة فقط. */
    async getReviewQueue(status) {
        await this._lazyExpire();
        return this.db.all(
            `SELECT s.*, e.name AS employee_name, e.employee_code, t.name AS team_name
             FROM supplementary_requests s
             JOIN employees e ON e.id = s.employee_id
             LEFT JOIN teams t ON t.id = s.team_id
             WHERE s.status = ? ORDER BY s.target_date, s.id`, [status || 'pending_review']);
    }

    /** ⑨ انقضاء كسول: حيّة تجاوزت يومها المستهدف ⇒ expired. */
    async _lazyExpire() {
        const today = this._riyadhToday();
        const stale = await this.db.all(
            `SELECT id FROM supplementary_requests WHERE status IN ('pending_review','escalated') AND target_date < ?`,
            [today]);
        for (const r of stale) {
            this.db.tx.immediate((hdl) => {
                const u = hdl.prepare(
                    `UPDATE supplementary_requests SET status='expired', updated_at=datetime('now')
                     WHERE id = ? AND status IN ('pending_review','escalated')`).run(r.id);
                if (u.changes !== 1) return;
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run('system', 'النظام', 'supp_expire',
                        `انقضاء طلب مناوبة تكميلية #${r.id} — تجاوز اليوم المستهدف دون حسم`, 'schedule');
            });
        }
    }

    // ═══ التقديم ═══

    /**
     * تقديم طلب مناوبة تكميلية — الفريق يُشتق من العضوية الحية سيرفريًا.
     * @param {object} emp موظف الجلسة
     * @param {object} user مستخدم الجلسة
     * @param {object} body { target_date, shift_code }
     */
    async submit(emp, user, body) {
        const cfg = await this._assertConfig(); // ③ Fail-Closed أولًا
        const target = String((body || {}).target_date || '');
        if (!DATE_RE.test(target)) throw new SupplementaryError(422, 'SUPP_INVALID_DATE', 'تاريخ المناوبة التكميلية غير صالح');
        const today = this._riyadhToday();
        if (target < today) throw new SupplementaryError(422, 'SUPP_PAST_DATE', 'لا يمكن طلب مناوبة تكميلية في الماضي');
        const month = target.slice(0, 7);

        const codes = await this.db.ShiftCodes.getAll();
        const codeMap = new Map((codes || []).map(c => [String(c.code), c]));
        const code = codeMap.get(String((body || {}).shift_code || ''));
        if (!code) throw new SupplementaryError(422, 'SUPP_INVALID_CODE', 'رمز المناوبة غير معروف');
        // قرار (أ): المقبول هنا = «تكميل» بأوقات فعلية فقط — «دوام» مرفوض في هذا المسار
        if (!(code.status === 'تكميل' && code.time_start && code.time_end)) {
            throw new SupplementaryError(422, 'SUPP_INVALID_CODE', 'الرمز المطلوب ليس مناوبة تكميلية مؤهلة');
        }

        // نافذة التقديم الدنيا — قبل إنشاء أي صف (الطلب لم يدخل المسار فلا يستهلك العدّاد)
        if (!(this._hoursUntil(target, code) >= cfg.minNoticeHours)) {
            throw new SupplementaryError(422, 'SUPP_NOTICE_WINDOW',
                `طلب المناوبة التكميلية يتطلب التقديم قبل ${cfg.minNoticeHours} ساعة على الأقل من بداية المناوبة`);
        }

        // ⑧ العدّاد الشهري
        if ((await this._monthlyUsed(emp.id, month)) >= cfg.maxPerMonth) {
            throw new SupplementaryError(422, 'SUPP_MONTHLY_LIMIT',
                `بلغت الحد الشهري لطلبات المناوبة التكميلية (${cfg.maxPerMonth}) لهذا الشهر`);
        }

        // اشتقاق الفريق + تحقق E-4 الكامل — نتيجة الواجهة ليست مصدر ثقة
        const membership = await this._membership(emp.id, target);
        const v = await validateAssignment(this.db, {
            employeeId: emp.id, date: target, shiftCode: code.code, operation: 'add',
            teamId: membership ? membership.team_id : null, context: 'supplementary'
        });

        // فشل التحقق ⇒ سجل مرفوض + Audit (نمط E-8: دخل المسار وفشل التحقق) — لا يستهلك العدّاد
        if (!v.valid) {
            const id = this._guardUnique(() => this.db.tx.immediate((hdl) => {
                const r = hdl.prepare(
                    `INSERT INTO supplementary_requests (employee_id, month, target_date, shift_code, team_id,
                        validation_json, status, created_by, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?, datetime('now'))`)
                    .run(emp.id, month, target, code.code, membership ? membership.team_id : null,
                        JSON.stringify({ code: 'SUPP_VALIDATION_FAILED', reasons: v.reasons || [], checks: v.checks || [] }),
                        user.id);
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || emp.name, 'supp_submit_rejected',
                        `طلب مناوبة تكميلية #${r.lastInsertRowid} مرفوض عند التحقق (${target} ${code.code})`, 'schedule');
                return r.lastInsertRowid;
            }));
            return { id, status: 'rejected', reasons: v.reasons || [] };
        }

        // صالح ⇒ pending_review — ④ لا اعتماد آلي إطلاقًا، المراجعة بشرية دائمًا
        const id = this._guardUnique(() => this.db.tx.immediate((hdl) => {
            const r = hdl.prepare(
                `INSERT INTO supplementary_requests (employee_id, month, target_date, shift_code, team_id,
                    validation_json, status, created_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, datetime('now'))`)
                .run(emp.id, month, target, code.code, membership.team_id,
                    JSON.stringify({ code: 'OK', checks: v.checks || [] }), user.id);
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || emp.name, 'supp_submit',
                    `طلب مناوبة تكميلية #${r.lastInsertRowid}: ${target} ${code.code} — بانتظار المراجعة`, 'schedule');
            return r.lastInsertRowid;
        }));
        return { id, status: 'pending_review' };
    }

    // ═══ إلغاء الموظف (بلا حذف فعلي) ═══

    async cancel(id, emp, user) {
        const req = await this.db.get('SELECT * FROM supplementary_requests WHERE id = ?', [id]);
        if (!req) throw new SupplementaryError(404, 'SUPP_NOT_FOUND', 'الطلب غير موجود');
        if (req.employee_id !== emp.id) throw new SupplementaryError(403, 'SUPP_FORBIDDEN', 'هذا الطلب ليس لك');
        if (!CANCELLABLE_STATUSES.includes(req.status)) {
            throw new SupplementaryError(409, 'SUPP_NOT_CANCELLABLE', 'لا يمكن إلغاء الطلب في حالته الحالية');
        }
        this.db.tx.immediate((hdl) => {
            const u = hdl.prepare(
                `UPDATE supplementary_requests SET status='cancelled', updated_at=datetime('now')
                 WHERE id = ? AND status = ?`).run(id, req.status);
            if (u.changes !== 1) throw new SupplementaryError(409, 'SUPP_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || emp.name, 'supp_cancel',
                    `إلغاء طلب مناوبة تكميلية #${id} من حالة ${req.status}`, 'schedule');
        });
        return { status: 'cancelled' };
    }

    // ═══ ④ مراجعة المسؤول — اعتماد + تطبيق ذريان ═══

    async review(id, actor, action, note) {
        if (!['approve', 'reject'].includes(action)) throw new SupplementaryError(422, 'SUPP_INVALID_ACTION', 'الإجراء غير صالح');
        const req = await this.db.get('SELECT * FROM supplementary_requests WHERE id = ?', [id]);
        if (!req) throw new SupplementaryError(404, 'SUPP_NOT_FOUND', 'الطلب غير موجود');
        if (!LIVE_STATUSES.includes(req.status)) {
            throw new SupplementaryError(409, 'SUPP_NOT_REVIEWABLE', 'هذا الطلب ليس قيد المراجعة');
        }

        if (action === 'reject') {
            this.db.tx.immediate((hdl) => {
                const u = hdl.prepare(
                    `UPDATE supplementary_requests SET status='rejected', review_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now')
                     WHERE id = ? AND status = ?`).run(note || null, actor.id, id, req.status);
                if (u.changes !== 1) throw new SupplementaryError(409, 'SUPP_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(actor.id, actor.name || 'غير معروف', 'supp_review_reject',
                        `رفض طلب مناوبة تكميلية #${id} (${req.target_date} ${req.shift_code})`, 'schedule');
            });
            return { status: 'rejected', request_id: req.id, requester_id: req.employee_id };
        }

        // approve: إعادة تحقق E-4 لحظية كاملة قبل التطبيق (لا ثقة بفحص سابق — نمط E-8 accept)
        const v = await validateAssignment(this.db, {
            employeeId: req.employee_id, date: req.target_date, shiftCode: req.shift_code,
            operation: 'add', teamId: req.team_id, context: 'supplementary'
        });
        if (!v.valid) {
            if (req.status === 'pending_review') {
                this.db.tx.immediate((hdl) => {
                    hdl.prepare(
                        `UPDATE supplementary_requests SET status='escalated', escalation_reason=?, updated_at=datetime('now')
                         WHERE id = ? AND status = 'pending_review'`)
                        .run('revalidation_failed:' + ((v.reasons || [])[0] || 'UNKNOWN'), id);
                    hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                        .run(actor.id, actor.name || 'غير معروف', 'supp_escalate',
                            `تصعيد طلب تكميلية #${id} — فشل إعادة التحقق اللحظية (${(v.reasons || []).join(', ')})`, 'schedule');
                });
                return { status: 'escalated', escalation_reason: 'revalidation_failed', reasons: v.reasons || [], request_id: req.id, requester_id: req.employee_id };
            }
            throw new SupplementaryError(409, 'SUPP_REVALIDATION_FAILED',
                `فشلت إعادة التحقق اللحظية: ${(v.reasons || []).join(', ')}`);
        }

        // اعتماد + تطبيق في ترانزاكشن واحدة؛ فشل حارس التطبيق ⇒ escalated من pending_review
        // (من escalated يبقى escalated ويظهر الخطأ للمراجع — نمط E-8 review)
        try {
            const revisionId = this.db.tx.immediate((hdl) => {
                const u = hdl.prepare(
                    `UPDATE supplementary_requests SET status='approved', review_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now')
                     WHERE id = ? AND status = ?`).run(note || null, actor.id, id, req.status);
                if (u.changes !== 1) throw new SupplementaryError(409, 'SUPP_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
                return this._applyInTx(hdl, req, actor);
            });
            return { status: 'applied', revision_id: revisionId, request_id: req.id, requester_id: req.employee_id };
        } catch (e) {
            if (!(e && e.code)) throw e;
            if (req.status === 'pending_review') {
                this.db.tx.immediate((hdl) => {
                    hdl.prepare(
                        `UPDATE supplementary_requests SET status='escalated', escalation_reason=?, updated_at=datetime('now')
                         WHERE id = ? AND status = 'pending_review'`)
                        .run('apply_guard_failed:' + e.code, id);
                    hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                        .run(actor.id, actor.name || 'غير معروف', 'supp_escalate',
                            `تصعيد طلب تكميلية #${id} — فشل حارس التطبيق (${e.code})`, 'schedule');
                });
                return { status: 'escalated', escalation_reason: 'apply_guard_failed:' + e.code, request_id: req.id, requester_id: req.employee_id };
            }
            throw e;
        }
    }

    /** تحويل خرق UNIQUE (سباق تقديم متزامن) إلى 409 مفهوم بدل 500 — الترانزاكشن تُسترجع كاملة. */
    _guardUnique(fn) {
        try { return fn(); }
        catch (e) {
            const msg = e && e.message ? String(e.message) : '';
            if (/UNIQUE constraint failed: supplementary_requests\./.test(msg)) {
                throw new SupplementaryError(409, 'SUPP_DUPLICATE_REQUEST', 'يوجد طلب مناوبة تكميلية قائم على هذا اليوم');
            }
            throw e;
        }
    }

    /**
     * ⑥ قلب التطبيق الذري داخل ترانزاكشن مفتوحة — كل الحراس النهائية خامًا.
     * عملية 'add' لا تكسر التغطية بنيويًا (E-4 ج3) فلا حارس تغطية هنا.
     * @returns {number} revision_id
     */
    _applyInTx(hdl, req, actor) {
        // تحديث شرطي للحالة — سباقان ينجح أحدهما فقط
        const u = hdl.prepare(
            `UPDATE supplementary_requests SET status='applied', applied_at=datetime('now'), updated_at=datetime('now')
             WHERE id = ? AND status = 'approved'`).run(req.id);
        if (u.changes !== 1) throw new SupplementaryError(409, 'SUPP_STATUS_RACE', 'تغيّرت حالة الطلب أثناء التطبيق — ROLLBACK كامل');

        // فحص اللقطة خامًا: لا مناوبة للموظف في اليوم المستهدف
        const clash = hdl.prepare('SELECT id FROM shift_roster WHERE employee_id = ? AND shift_date = ?')
            .get(req.employee_id, req.target_date);
        if (clash) throw new SupplementaryError(409, 'SUPP_ROSTER_CONFLICT', 'أصبح للموظف مناوبة في اليوم المستهدف — ROLLBACK كامل');
        // عضوية حية بنفس الفريق بتاريخ الهدف
        const mem = hdl.prepare(
            `SELECT id FROM team_assignments WHERE employee_id = ? AND team_id = ?
             AND (end_date IS NULL OR end_date = '' OR end_date >= ?) LIMIT 1`)
            .get(req.employee_id, req.team_id, req.target_date);
        if (!mem) throw new SupplementaryError(409, 'SUPP_MEMBERSHIP_LOST', 'فقد الموظف عضويته النشطة في الفريق — ROLLBACK كامل');

        // إدراج المناوبة التكميلية
        const y = Number(req.target_date.slice(0, 4)), m = Number(req.target_date.slice(5, 7));
        const ins = hdl.prepare(
            'INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)')
            .run(req.employee_id, req.team_id, req.target_date, req.shift_code, m, y);
        if (!ins.lastInsertRowid) throw new SupplementaryError(500, 'SUPP_ROSTER_INSERT_FAILED', 'فشل إدراج المناوبة التكميلية — ROLLBACK كامل');
        const rosterId = ins.lastInsertRowid;

        // roster_id يُربط بالطلب داخل نفس الترانزاكشن
        hdl.prepare('UPDATE supplementary_requests SET roster_id = ? WHERE id = ?').run(rosterId, req.id);

        // مراجعة واحدة + قيد F-1 + audit_log — كلها في نفس الترانزاكشن
        const rev = hdl.prepare(
            'INSERT INTO schedule_revisions (source, actor_id, actor_name, stats_json) VALUES (?, ?, ?, ?)')
            .run('supplementary', String(actor.id), actor.name || null, JSON.stringify({
                supplementary_request_id: req.id,
                roster_id: rosterId,
                employee_id: req.employee_id,
                target_date: req.target_date,
                shift_code: req.shift_code
            }));
        const revisionId = rev.lastInsertRowid;
        const changedBy = actor.username || actor.name || 'system';
        hdl.prepare(
            `INSERT INTO shift_audit_log (roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code,
                 old_team_id, new_team_id, changed_by, changed_by_name, change_type, reason, revision_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'add', ?, ?)`)
            .run(rosterId, req.employee_id, req.team_id, req.target_date,
                null, req.shift_code, null, req.team_id,
                changedBy, actor.name || null,
                `مناوبة تكميلية — طلب #${req.id}`, revisionId);
        hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
            .run(actor.id, actor.name || 'غير معروف', 'supp_apply',
                `تطبيق مناوبة تكميلية #${req.id}: موظف #${req.employee_id} في ${req.target_date} ${req.shift_code} — مراجعة #${revisionId}`, 'schedule');
        return revisionId;
    }
}

module.exports = { SupplementaryService, SupplementaryError };
