/**
 * ═══ services/schedule-engine/flex-service.js — مرونة الموظف (FSS E-8) ═══
 *
 * قرارات المالك المجمّدة 2026-10-06 (Design v2 المعتمد + Final Schema Review):
 *  ① مساران منفصلان: نقل التزام الموظف (A→B) ≠ التغطية التشغيلية. البديل
 *     يغطي الفراغ في يوم A فقط ولا يرث مناوبة أحد؛ flex_requests لا يحمل
 *     replacement_employee_id — نتيجة التغطية كلها في flex_offers (مراجعة ①).
 *  ② قاعدة الـ8 ساعات مستقلة (لا M7 ولا M9/48h): التقديم ≥ flex_notice_hours
 *     قبل بداية المناوبة الفعلية (date+time_start، الرياض UTC+3). داخلها ⇒
 *     422 FLEX_NOTICE_WINDOW بلا صف أصلًا — الطلب لم يدخل المسار فلا يستهلك
 *     العدّاد ولا يُعد غيابًا (قرار §4-أ). رمز بلا time_start ⇒ تحفظيًا داخل
 *     النافذة = نفس الرفض (نمط K4 الحسابي فقط).
 *  ③ المسار المباشر آلي (L2): بديل صالح (E-4) + التغطية تصمد بعد الإزالة ⇒
 *     تطبيق ذري فوري في نفس الاستدعاء مع Audit كامل.
 *  ④ البحث المتدرج عند سقوط التغطية: same_team ← same_center ← جنوب 1–10
 *     (نمط الاسم ^جنوب ([1-9]|10)$ — 13–19 مستبعدة بنيويًا كونها غير جغرافية)
 *     ← rapid (اسم يحوي «تدخل سريع»). داخل الطبقة: M5 عبر ranking-service.
 *     كل مرشح يجتاز validateAssignment (teamId=null — العضوية تُشتق من فريقه
 *     هو؛ فحص شخصي صِرف) قبل عرضه. Overlap وأي فشل E-4 ⇒ استبعاد وتقدُّم —
 *     لا كسر تلقائي إطلاقًا (مراجعة §6). العبور بين الفرق استثناء E-8 موثّق
 *     ولا يغيّر M11 لأي مسار آخر.
 *  ⑤ المفتاحان المعلّقان (max_flex_moves_per_month / makeup_search_days)
 *     غير موجودَين في ENGINE_DEFAULTS عمدًا: غيابهما من app_settings ⇒
 *     503 FLEX_CONFIG_MISSING (Fail-Closed — مراجعة ⑥⑦)، ليس unlimited
 *     وليس رقمًا صامتًا. المفتاحان المعتمدان فقط في DEFAULTS (8 ساعات / 3 بدائل).
 *  ⑥ العدّاد: الطلبات الحية + applied في شهر المناوبة الأصلية. rejected/
 *     cancelled/expired لا تستهلك. رفض النافذة لا يُنشئ صفًا (②).
 *  ⑦ الحراس البنيوية (مراجعة ②⑧): uq_flex_live_roster يمنع طلبين حيّين على
 *     نفس الصف؛ uq_flex_offer_live عرضًا واحدًا حيًّا لكل طلب (التسلسل يحفظ
 *     التاريخ — مراجعة ④)؛ uq_flex_offer_live_emp_date حارس M7. التعايش مع
 *     E-6: فحص getLiveForRoster عند التقديم (قراءة فقط — صفر تعديل على E-6)
 *     + حارسان نهائيان شرطيان (changes=1) في كلا المسارين ⇒ مستحيل تطبيق
 *     مزدوج. عدم تمكّن محسوم (approved/auto_approved) على يوم المناوبة
 *     الأصلية ⇒ 409 FLEX_UNABLE_CONFLICT (قاعدة سلامة — لا ازدواج مسارين
 *     على نفس اليوم؛ pending_review لا يمنع — فلسفة ج2).
 *  ⑧ التطبيق الذري (نمط E-6 حرفيًا): tx.immediate واحدة — تحديث شرطي
 *     للحالة ⇒ فحص خام للقطة roster (موجود/موظف/رمز/تاريخ) ⇒ لا مناوبة
 *     للموظف في يوم البديل ولا للبديل في يوم التغطية ⇒ UPDATE/INSERT
 *     شرطي (changes=1) ⇒ schedule_revisions (source='flex-move') ⇒
 *     shift_audit_log (edit للنقل + add للتغطية — بنمط F-1) ⇒ audit_log.
 *     أي فشل = ROLLBACK كامل + صفر تعديل جزئي.
 *  ⑨ الإشعارات بعد COMMIT فقط وتُطلق من server.js (سقوطها آمن).
 *  ⑩ لا Auto-Apply خارج L2: التصعيد لا يُطبَّق إلا بقرار مسؤول
 *     (schedule.requests.review) — والموظف لا يعتمد لنفسه بنيويًا.
 */
'use strict';

const TimeRiyadh = require('../../public/js/time-riyadh.js');
const { getEngineSetting } = require('./config.js');
const { validateAssignment } = require('./validation-service.js');
const coverageService = require('./coverage-service.js');
const { rankCandidates } = require('./ranking-service.js');

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const LIVE_STATUSES = ['submitted', 'pending_validation', 'replacement_search', 'offer_pending', 'ready', 'escalated'];
const CANCELLABLE_STATUSES = LIVE_STATUSES.slice();
const TIER_ORDER = ['same_team', 'same_center', 'south_1_10', 'rapid'];

class FlexError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** فرق جنوب الجغرافية 1–10 بالاسم التشغيلي — 11–19 والفرق الإضافية مستبعدة بنيويًا. */
const SOUTH_1_10_RE = /^جنوب ([1-9]|10)$/;

class FlexService {
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

    _daysBetween(a, b) {
        return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
    }

    // ═══ الإعدادات — ⑤ Fail-Closed للمفتاحين المعلّقين ═══
    async _assertConfig() {
        const maxFlex = await this.db.AppSettings.get('schedule_engine.max_flex_moves_per_month');
        if (maxFlex === null || maxFlex === undefined || isNaN(Number(maxFlex))) {
            throw new FlexError(503, 'FLEX_CONFIG_MISSING',
                'إعداد المحرك غير مكتمل: schedule_engine.max_flex_moves_per_month غير مضبوط — قرار Business معلّق (TBD). لا يُفترض رقم ولا يُعامل الغياب كسماح غير محدود');
        }
        const searchDays = await this.db.AppSettings.get('schedule_engine.flex_makeup_search_days');
        if (searchDays === null || searchDays === undefined || isNaN(Number(searchDays))) {
            throw new FlexError(503, 'FLEX_CONFIG_MISSING',
                'إعداد المحرك غير مكتمل: schedule_engine.flex_makeup_search_days غير مضبوط — قرار Business معلّق (TBD). لا يُفترض رقم ولا يُعامل الغياب كسماح غير محدود');
        }
        return {
            maxFlex: Number(maxFlex),
            searchDays: Number(searchDays),
            noticeHours: Number(await getEngineSetting('schedule_engine.flex_notice_hours')),
            maxOptions: Number(await getEngineSetting('schedule_engine.flex_max_makeup_options'))
        };
    }

    // ═══ القراءات ═══

    /** طلباتي مع اسم الفريق — قراءة فقط (+ انقضاء كسول). */
    async getMine(emp) {
        await this._lazyExpire();
        return this.db.all(
            `SELECT f.*, t.name AS team_name
             FROM flex_requests f LEFT JOIN teams t ON t.id = f.orig_team_id
             WHERE f.employee_id = ? ORDER BY f.id DESC`, [emp.id]);
    }

    /** العروض الموجهة إليّ كمرشح تغطية — قراءة فقط. */
    async getMyOffers(emp) {
        await this._lazyExpire();
        return this.db.all(
            `SELECT o.*, f.employee_id AS requester_id, e.name AS requester_name, e.employee_code AS requester_code,
                    t.name AS cover_team_name
             FROM flex_offers o
             JOIN flex_requests f ON f.id = o.flex_request_id
             JOIN employees e ON e.id = f.employee_id
             LEFT JOIN teams t ON t.id = o.team_id
             WHERE o.employee_id = ? ORDER BY o.id DESC`, [emp.id]);
    }

    /** قائمة مراجعة المسؤول — قراءة فقط. */
    async getReviewQueue(status) {
        await this._lazyExpire();
        return this.db.all(
            `SELECT f.*, e.name AS employee_name, e.employee_code, t.name AS team_name
             FROM flex_requests f
             JOIN employees e ON e.id = f.employee_id
             LEFT JOIN teams t ON t.id = f.orig_team_id
             WHERE f.status = ? ORDER BY f.orig_shift_date, f.id`, [status || 'escalated']);
    }

    /** عروض طلب معين (للمسؤول/التشخيص) — قراءة فقط. */
    async getOffersForRequest(id) {
        return this.db.all(
            `SELECT o.*, e.name AS employee_name, e.employee_code, t.name AS team_name
             FROM flex_offers o
             JOIN employees e ON e.id = o.employee_id
             LEFT JOIN teams t ON t.id = o.team_id
             WHERE o.flex_request_id = ? ORDER BY o.rank_position`, [id]);
    }

    /** انقضاء كسول: حالة حية تجاوزت تاريخ مناوبتها الأصلية ⇒ expired (+ سحب عرضها الحي). */
    async _lazyExpire() {
        const today = this._riyadhToday();
        const stale = await this.db.all(
            `SELECT id FROM flex_requests WHERE status IN ('submitted','pending_validation','replacement_search','offer_pending','ready','escalated')
             AND orig_shift_date < ?`, [today]);
        for (const r of stale) {
            this.db.tx.immediate((hdl) => {
                const u = hdl.prepare(
                    `UPDATE flex_requests SET status='expired', updated_at=datetime('now') WHERE id=? AND status IN ('submitted','pending_validation','replacement_search','offer_pending','ready','escalated')`)
                    .run(r.id);
                if (u.changes !== 1) return;
                hdl.prepare(`UPDATE flex_offers SET status='expired', responded_at=datetime('now') WHERE flex_request_id=? AND status='offered'`).run(r.id);
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run('system', 'النظام', 'flex_expire', `انقضاء طلب مرونة #${r.id} — تجاوز تاريخ المناوبة الأصلية`, 'schedule');
            });
        }
    }

    // ═══ ① التقديم ═══

    /**
     * تقديم طلب مرونة — الخادم يشتق صف roster من (الموظف، التاريخ) فقط.
     * @param {object} emp موظف الجلسة
     * @param {object} user مستخدم الجلسة
     * @param {object} body { orig_shift_date, makeup_options: [date, ...] }
     */
    async submit(emp, user, body) {
        const cfg = await this._assertConfig(); // ⑤ Fail-Closed أولًا
        const orig = String((body || {}).orig_shift_date || '');
        if (!DATE_RE.test(orig)) throw new FlexError(422, 'FLEX_INVALID_DATE', 'تاريخ المناوبة الأصلية غير صالح');
        const options = Array.isArray(body.makeup_options) ? body.makeup_options.map(String) : [];
        if (!options.length || options.length > cfg.maxOptions) {
            throw new FlexError(422, 'FLEX_MAKEUP_OPTIONS', `الأيام البديلة مطلوبة: من 1 إلى ${cfg.maxOptions} أيام مرتبة بالأولوية`);
        }
        const uniq = new Set(options);
        if (uniq.size !== options.length || options.some(d => !DATE_RE.test(d))) {
            throw new FlexError(422, 'FLEX_MAKEUP_OPTIONS', 'الأيام البديلة غير صالحة أو مكررة');
        }
        if (options.includes(orig)) throw new FlexError(422, 'FLEX_MAKEUP_OPTIONS', 'اليوم البديل لا يمكن أن يكون نفس يوم المناوبة الأصلية');
        const today = this._riyadhToday();
        if (orig < today) throw new FlexError(422, 'FLEX_PAST_DATE', 'لا يمكن تقديم طلب مرونة لمناوبة في الماضي');
        if (options.some(d => d < today)) throw new FlexError(422, 'FLEX_MAKEUP_PAST', 'اليوم البديل لا يمكن أن يكون في الماضي');
        if (options.some(d => Math.abs(this._daysBetween(orig, d)) > cfg.searchDays)) {
            throw new FlexError(422, 'FLEX_MAKEUP_OUT_OF_RANGE', `اليوم البديل خارج مدى البحث المعتمد (±${cfg.searchDays} يومًا من المناوبة الأصلية)`);
        }

        // اشتقاق صف المناوبة من SSOT — لا roster_id ولا shift_code من العميل
        const row = await this.db.get('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [emp.id, orig]);
        if (!row) throw new FlexError(404, 'FLEX_ROSTER_NOT_FOUND', 'لا توجد مناوبة مسجلة لك في هذا التاريخ');
        const month = orig.slice(0, 7);

        // ② نافذة الـ8 ساعات — قبل إنشاء أي صف (الطلب لم يدخل المسار)
        const codes = await this.db.ShiftCodes.getAll();
        const codeMap = new Map((codes || []).map(c => [String(c.code), c]));
        const code = codeMap.get(String(row.shift_code));
        const hoursUntil = code && code.time_start
            ? (Date.parse(`${orig}T${code.time_start}:00+03:00`) - Date.now()) / 3600000
            : 0; // بلا time_start ⇒ تحفظيًا داخل النافذة
        if (!(hoursUntil >= cfg.noticeHours)) {
            throw new FlexError(422, 'FLEX_NOTICE_WINDOW',
                `مسار المرونة يتطلب التقديم قبل ${cfg.noticeHours} ساعة على الأقل من بداية المناوبة. للحالات العاجلة استخدم المسارات التشغيلية المعتمدة لدى المسؤول المباشر`);
        }

        // ⑥ العدّاد الشهري (حيّة + applied فقط)
        const cnt = await this.db.get(
            `SELECT COUNT(*) AS n FROM flex_requests WHERE employee_id = ? AND month = ?
             AND status IN ('submitted','pending_validation','replacement_search','offer_pending','ready','escalated','applied')`,
            [emp.id, month]);
        if (cnt.n >= cfg.maxFlex) {
            throw new FlexError(422, 'FLEX_MONTHLY_LIMIT', `بلغت الحد الشهري لطلبات المرونة (${cfg.maxFlex}) لهذا الشهر`);
        }

        // ⑦ الحراس المتبادلة (قراءات فقط — الفهارس الجزئية حارس أخير)
        const dup = await this.db.get(
            `SELECT id FROM flex_requests WHERE roster_id = ? AND status IN ('submitted','pending_validation','replacement_search','offer_pending','ready','escalated')`,
            [row.id]);
        if (dup) throw new FlexError(409, 'FLEX_DUPLICATE_REQUEST', 'يوجد طلب مرونة قائم على هذه المناوبة');
        const liveSwap = await this.db.ShiftSwapRequests.getLiveForRoster(emp.id, orig);
        if (liveSwap) throw new FlexError(409, 'FLEX_ROSTER_BUSY', 'هذه المناوبة مرتبطة بطلب تبديل بالتراضي قائم — أكمله أو ألغِه أولًا');
        const ua = await this.db.UnableAttendRequests.getByEmployeeDate(emp.id, orig);
        if (ua && (ua.status === 'approved' || ua.status === 'auto_approved')) {
            throw new FlexError(409, 'FLEX_UNABLE_CONFLICT', 'لديك عدم تمكّن معتمد في نفس يوم المناوبة — لا يمكن فتح مسارين على اليوم نفسه');
        }

        // المسار أ: فحص البدائل بالترتيب عبر E-4 (إضافة بفريق المناوبة الأصلية)
        let makeupDate = null, makeupResult = null;
        const optionResults = [];
        for (const opt of options) {
            const v = await validateAssignment(this.db, {
                employeeId: emp.id, date: opt, shiftCode: row.shift_code, operation: 'add', teamId: row.team_id
            });
            optionResults.push({ date: opt, valid: v.valid, reasons: (v.reasons || []) });
            if (v.valid && !makeupDate) { makeupDate = opt; makeupResult = v; }
        }

        const base = {
            employee_id: emp.id, month, roster_id: row.id,
            orig_shift_date: orig, orig_shift_code: row.shift_code, orig_team_id: row.team_id,
            makeup_options_json: JSON.stringify(options)
        };

        // لا بديل صالح ⇒ rejected (دخل المسار وفشل التحقق — سجل وAudit)
        if (!makeupDate) {
            const id = this._guardUnique(() => this.db.tx.immediate((hdl) => {
                const r = hdl.prepare(
                    `INSERT INTO flex_requests (employee_id, month, roster_id, orig_shift_date, orig_shift_code, orig_team_id,
                        makeup_options_json, status, escalation_reason, created_by, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?, datetime('now'))`)
                    .run(base.employee_id, base.month, base.roster_id, base.orig_shift_date, base.orig_shift_code, base.orig_team_id,
                        base.makeup_options_json,
                        JSON.stringify({ code: 'NO_VALID_MAKEUP', options: optionResults }),
                        user.id);
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || emp.name, 'flex_submit_rejected',
                        `طلب مرونة #${r.lastInsertRowid} مرفوض عند التحقق: لا يوم بديل صالح (${orig} ${row.shift_code})`, 'schedule');
                return r.lastInsertRowid;
            }));
            return { id, status: 'rejected', reasons: optionResults };
        }

        // المسار ب: محاكاة التغطية يوم A (E-4 BEFORE/AFTER)
        const cov = await coverageService.assessChange(this.db, {
            teamId: row.team_id, date: orig, removeEmployeeIds: [emp.id]
        });

        if (cov.coverage_after.met) {
            // ③ L2 آلي: ready ← applied في ترانزاكشن واحدة
            const out = this._createAndApply(base, makeupDate, null, cov, user, emp, true);
            return { id: out.id, status: 'applied', makeup_date: makeupDate, coverage: 'holds', revision_id: out.revisionId };
        }

        // التغطية تسقط ⇒ البحث المتدرج (④)
        const reqId = this._guardUnique(() => this.db.tx.immediate((hdl) => {
            const r = hdl.prepare(
                `INSERT INTO flex_requests (employee_id, month, roster_id, orig_shift_date, orig_shift_code, orig_team_id,
                    makeup_options_json, makeup_date, coverage_state, status, created_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'broken', 'replacement_search', ?, datetime('now'))`)
                .run(base.employee_id, base.month, base.roster_id, base.orig_shift_date, base.orig_shift_code, base.orig_team_id,
                    base.makeup_options_json, makeupDate, user.id);
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || emp.name, 'flex_submit',
                    `طلب مرونة #${r.lastInsertRowid}: نقل ${orig} ${row.shift_code} ← ${makeupDate} — التغطية تسقط، بدء البحث عن بديل`, 'schedule');
            return r.lastInsertRowid;
        }));

        const offer = await this._offerNext(reqId, user, emp);
        if (offer) return { id: reqId, status: 'offer_pending', makeup_date: makeupDate, coverage: 'broken', offer };
        return { id: reqId, status: 'escalated', makeup_date: makeupDate, coverage: 'broken', escalation_reason: 'queue_exhausted' };
    }

    /** إنشاء الطلب + تطبيقه ذريًا (L2) أو بعد قبول بديل — ترانزاكشن واحدة. */
    _createAndApply(base, makeupDate, acceptedOffer, cov, user, emp, auto) {
        return this._guardUnique(() => this.db.tx.immediate((hdl) => {
            const r = hdl.prepare(
                `INSERT INTO flex_requests (employee_id, month, roster_id, orig_shift_date, orig_shift_code, orig_team_id,
                    makeup_options_json, makeup_date, coverage_state, status, created_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, datetime('now'))`)
                .run(base.employee_id, base.month, base.roster_id, base.orig_shift_date, base.orig_shift_code, base.orig_team_id,
                    base.makeup_options_json, makeupDate, cov ? 'holds' : 'broken', user.id);
            const reqId = r.lastInsertRowid;
            const revisionId = this._applyInTx(hdl, {
                id: reqId, employee_id: base.employee_id, roster_id: base.roster_id,
                orig_shift_date: base.orig_shift_date, orig_shift_code: base.orig_shift_code,
                orig_team_id: base.orig_team_id, makeup_date: makeupDate
            }, acceptedOffer, user, emp, auto, 'ready');
            return { id: reqId, revisionId };
        }));
    }

    /** تحويل خرق UNIQUE (سباق تقديم/عرض متزامن) إلى خطأ عمل 409 بدل 500 — الترانزاكشن تُسترجع كاملة. */
    _guardUnique(fn) {
        try { return fn(); }
        catch (e) {
            const msg = e && e.message ? String(e.message) : '';
            if (/UNIQUE constraint failed: flex_requests\.roster_id/.test(msg)) {
                throw new FlexError(409, 'FLEX_DUPLICATE_REQUEST', 'يوجد طلب مرونة قائم على هذه المناوبة');
            }
            if (/UNIQUE constraint failed: flex_offers\./.test(msg)) {
                throw new FlexError(409, 'FLEX_OFFER_RACE', 'تعارض متزامن على عرض التغطية — أعد المحاولة');
            }
            throw e;
        }
    }

    /**
     * ⑧ قلب التطبيق الذري داخل ترانزاكشن مفتوحة — كل الحراس النهائية خامًا.
     * @returns {number} revision_id
     */
    _applyInTx(hdl, req, acceptedOffer, actor, emp, auto, expectedStatus) {
        // تحديث شرطي للحالة — سباقان ينجح أحدهما فقط
        const u = hdl.prepare(
            `UPDATE flex_requests SET status='applied', applied_at=datetime('now'), updated_at=datetime('now')
             WHERE id = ? AND status = ?`).run(req.id, expectedStatus);
        if (u.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب أثناء التطبيق — ROLLBACK كامل');

        // فحص اللقطة خامًا
        const row = hdl.prepare('SELECT * FROM shift_roster WHERE id = ?').get(req.roster_id);
        if (!row || row.employee_id !== req.employee_id || row.shift_date !== req.orig_shift_date || row.shift_code !== req.orig_shift_code) {
            throw new FlexError(409, 'FLEX_ROSTER_CHANGED', 'تغيّرت المناوبة الأصلية قبل التطبيق — ROLLBACK كامل');
        }
        // لا مناوبة للموظف في يوم البديل
        const clash = hdl.prepare('SELECT id FROM shift_roster WHERE employee_id = ? AND shift_date = ?').get(req.employee_id, req.makeup_date);
        if (clash) throw new FlexError(409, 'FLEX_MAKEUP_CONFLICT', 'أصبح لديك مناوبة في اليوم البديل — ROLLBACK كامل');
        // عضوية حية في الفريق بتاريخ البديل
        const mem = hdl.prepare(
            `SELECT id FROM team_assignments WHERE employee_id = ? AND team_id = ?
             AND (end_date IS NULL OR end_date = '' OR end_date >= ?) LIMIT 1`)
            .get(req.employee_id, req.orig_team_id, req.makeup_date);
        if (!mem) throw new FlexError(409, 'FLEX_MEMBERSHIP_LOST', 'فقدت عضويتك النشطة في الفريق — ROLLBACK كامل');

        // نقل الالتزام: تحديث شرطي لصف المناوبة (changes=1 إلزامًا)
        const mY = Number(req.makeup_date.slice(0, 4)), mM = Number(req.makeup_date.slice(5, 7));
        const upd = hdl.prepare(
            'UPDATE shift_roster SET shift_date = ?, month = ?, year = ? WHERE id = ? AND employee_id = ? AND shift_date = ? AND shift_code = ?')
            .run(req.makeup_date, mM, mY, req.roster_id, req.employee_id, req.orig_shift_date, req.orig_shift_code);
        if (upd.changes !== 1) throw new FlexError(409, 'FLEX_ROSTER_CHANGED', 'سباق على صف المناوبة أثناء التطبيق — ROLLBACK كامل');

        // إدراج صف البديل إن وُجد (تغطية يوم A بفريق المناوبة الأصلية — استثناء M11 الموثق لـE-8)
        let replacementRosterId = null;
        if (acceptedOffer) {
            const cClash = hdl.prepare('SELECT id FROM shift_roster WHERE employee_id = ? AND shift_date = ?')
                .get(acceptedOffer.employee_id, acceptedOffer.cover_date);
            if (cClash) throw new FlexError(409, 'FLEX_COVER_CONFLICT', 'أصبح للبديل مناوبة في يوم التغطية — ROLLBACK كامل');
            const oY = Number(acceptedOffer.cover_date.slice(0, 4)), oM = Number(acceptedOffer.cover_date.slice(5, 7));
            const ins = hdl.prepare(
                'INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)')
                .run(acceptedOffer.employee_id, req.orig_team_id, acceptedOffer.cover_date, acceptedOffer.shift_code, oM, oY);
            if (!ins.lastInsertRowid) throw new FlexError(500, 'FLEX_COVER_INSERT_FAILED', 'فشل إدراج مناوبة البديل — ROLLBACK كامل');
            replacementRosterId = ins.lastInsertRowid;
        }

        // مراجعة واحدة + أقياد F-1 + audit_log — كلها في نفس الترانزاكشن
        const rev = hdl.prepare(
            'INSERT INTO schedule_revisions (source, actor_id, actor_name, stats_json) VALUES (?, ?, ?, ?)')
            .run('flex-move', String(actor.id), actor.name || null, JSON.stringify({
                flex_request_id: req.id,
                roster_id: req.roster_id,
                replacement_roster_id: replacementRosterId,
                offer_id: acceptedOffer ? acceptedOffer.id : null,
                auto: !!auto
            }));
        const revisionId = rev.lastInsertRowid;
        const changedBy = actor.username || actor.name || 'system';
        hdl.prepare(
            `INSERT INTO shift_audit_log (roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code,
                 old_team_id, new_team_id, changed_by, changed_by_name, change_type, reason, revision_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edit', ?, ?)`)
            .run(req.roster_id, req.employee_id, req.orig_team_id, req.makeup_date,
                req.orig_shift_code, req.orig_shift_code, req.orig_team_id, req.orig_team_id,
                changedBy, actor.name || null,
                `نقل التزام بطلب مرونة #${req.id} — من ${req.orig_shift_date} إلى ${req.makeup_date}`, revisionId);
        if (acceptedOffer) {
            hdl.prepare(
                `INSERT INTO shift_audit_log (roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code,
                     old_team_id, new_team_id, changed_by, changed_by_name, change_type, reason, revision_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'add', ?, ?)`)
                .run(replacementRosterId, acceptedOffer.employee_id, req.orig_team_id, acceptedOffer.cover_date,
                    null, acceptedOffer.shift_code, null, req.orig_team_id,
                    changedBy, actor.name || null,
                    `تغطية مرونة — طلب #${req.id} (عرض #${acceptedOffer.id})`, revisionId);
        }
        hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
            .run(actor.id, actor.name || 'غير معروف', 'flex_apply',
                `تطبيق مرونة #${req.id}${auto ? ' (آلي — التغطية صمدت)' : ''}: موظف #${req.employee_id} من ${req.orig_shift_date} إلى ${req.makeup_date}` +
                (acceptedOffer ? ` — تغطية بموظف #${acceptedOffer.employee_id}` : '') + ` — مراجعة #${revisionId}`, 'schedule');
        return revisionId;
    }

    // ═══ ④ البحث المتدرج عن بديل ═══

    /** فرق طبقة البحث. */
    async _tierTeams(tier, origTeam) {
        if (tier === 'same_team') return [origTeam.id];
        if (tier === 'same_center') {
            const rows = await this.db.all(
                'SELECT id FROM teams WHERE center = ? AND id != ? AND is_active = 1', [origTeam.center, origTeam.id]);
            return rows.map(r => r.id);
        }
        if (tier === 'south_1_10') {
            const rows = await this.db.all('SELECT id, name FROM teams WHERE is_active = 1');
            return rows.filter(t => SOUTH_1_10_RE.test(t.name) && t.id !== origTeam.id).map(t => t.id);
        }
        // rapid: فرق التدخل السريع القائمة فعليًا (لا تعريف جديد)
        const rows = await this.db.all(`SELECT id FROM teams WHERE name LIKE '%تدخل سريع%' AND is_active = 1`);
        return rows.map(r => r.id);
    }

    /**
     * تقدُّم التسلسل: يستبعد من رفض/استُبعد/سُحب سابقًا، يفحص كل مرشح بـE-4
     * (شخصي صِرف — teamId=null)، وأول صالح يُعرض عليه. لا نتيجة ⇒ تصعيد.
     * @returns {object|null} العرض الجديد أو null (queue_exhausted)
     */
    async _offerNext(reqId, user, emp) {
        const req = await this.db.get('SELECT * FROM flex_requests WHERE id = ?', [reqId]);
        if (!req || req.status !== 'replacement_search') return null;
        const origTeam = await this.db.get('SELECT * FROM teams WHERE id = ?', [req.orig_team_id]);
        if (!origTeam) return null;
        const tried = new Set((await this.db.all(
            `SELECT employee_id FROM flex_offers WHERE flex_request_id = ? AND status IN ('declined','invalidated','withdrawn','expired','accepted')`,
            [reqId])).map(r => r.employee_id));
        tried.add(req.employee_id);
        const coverMonth = req.orig_shift_date.slice(0, 7);

        for (const tier of TIER_ORDER) {
            const teamIds = await this._tierTeams(tier, origTeam);
            if (!teamIds.length) continue;
            const marks = teamIds.map(() => '?').join(',');
            const cands = await this.db.all(
                `SELECT DISTINCT ta.employee_id FROM team_assignments ta
                 JOIN employees e ON e.id = ta.employee_id AND e.is_active = 1
                 WHERE ta.team_id IN (${marks})
                   AND (ta.end_date IS NULL OR ta.end_date = '' OR ta.end_date >= ?)`,
                [...teamIds, req.orig_shift_date]);
            const pool = cands.map(c => c.employee_id).filter(id => !tried.has(id));
            if (!pool.length) continue;
            // استبعاد من لديه عرض حيّ (offered/accepted) على نفس تاريخ التغطية من طلب آخر —
            // E-4 لا يرى العروض غير المطبقة، وuq_flex_offer_live_emp_date حارس أخير فقط
            const liveHolders = new Set((await this.db.all(
                `SELECT DISTINCT employee_id FROM flex_offers WHERE cover_date = ? AND status IN ('offered','accepted')`,
                [req.orig_shift_date])).map(r => r.employee_id));
            const avail = pool.filter(id => !liveHolders.has(id));
            if (!avail.length) continue;
            const ranked = await rankCandidates(this.db, { month: coverMonth, candidates: avail });
            for (const cand of ranked) {
                // كل مرشح يجتاز E-4 قبل عرضه — فشل ⇒ استبعاد وتقدُّم (لا كسر)
                const v = await validateAssignment(this.db, {
                    employeeId: cand.employee_id, date: req.orig_shift_date,
                    shiftCode: req.orig_shift_code, operation: 'add', teamId: null
                });
                if (!v.valid) continue;
                const offerId = this._guardUnique(() => this.db.tx.immediate((hdl) => {
                    // لا عرض حيٌّ آخر لنفس الطلب (سباق) — uq_flex_offer_live حارس أخير
                    const live = hdl.prepare(`SELECT id FROM flex_offers WHERE flex_request_id = ? AND status = 'offered'`).get(reqId);
                    if (live) throw new FlexError(409, 'FLEX_OFFER_RACE', 'يوجد عرض حيٌّ بالفعل لهذا الطلب');
                    const pos = (hdl.prepare('SELECT COUNT(*) AS n FROM flex_offers WHERE flex_request_id = ?').get(reqId).n) + 1;
                    const ins = hdl.prepare(
                        `INSERT INTO flex_offers (flex_request_id, employee_id, team_id, cover_date, shift_code, tier, rank_position, m5_json)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                        .run(reqId, cand.employee_id, req.orig_team_id, req.orig_shift_date, req.orig_shift_code,
                            tier, pos, JSON.stringify({ m5: cand.m5, validated: true }));
                    const u = hdl.prepare(
                        `UPDATE flex_requests SET status='offer_pending', updated_at=datetime('now') WHERE id = ? AND status = 'replacement_search'`)
                        .run(reqId);
                    if (u.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب أثناء العرض — ROLLBACK كامل');
                    hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                        .run(user.id, user.name || 'غير معروف', 'flex_offer',
                            `عرض تغطية #${ins.lastInsertRowid} لطلب مرونة #${reqId}: موظف #${cand.employee_id} (${tier}) — ${req.orig_shift_date} ${req.orig_shift_code}`, 'schedule');
                    return ins.lastInsertRowid;
                }));
                return {
                    id: offerId, employee_id: cand.employee_id, tier,
                    cover_date: req.orig_shift_date, shift_code: req.orig_shift_code
                };
            }
        }

        // استنفاد كل الطبقات ⇒ تصعيد (⑩ لا تطبيق إلا بقرار مسؤول)
        this.db.tx.immediate((hdl) => {
            const u = hdl.prepare(
                `UPDATE flex_requests SET status='escalated', escalation_reason='queue_exhausted', updated_at=datetime('now')
                 WHERE id = ? AND status = 'replacement_search'`).run(reqId);
            if (u.changes === 1) {
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || 'غير معروف', 'flex_escalate',
                        `تصعيد طلب مرونة #${reqId} — استُنفدت قنوات البحث الآلي (فريق/مركز/جنوب 1–10/تدخل سريع)`, 'schedule');
            }
        });
        return null;
    }

    // ═══ رد المرشح على العرض ═══

    /**
     * @param {number} offerId
     * @param {object} emp موظف الجلسة (يجب أن يكون صاحب العرض — ownership)
     * @param {object} user مستخدم الجلسة
     * @param {string} action 'accept' | 'decline'
     */
    async respondOffer(offerId, emp, user, action) {
        if (!['accept', 'decline'].includes(action)) throw new FlexError(422, 'FLEX_INVALID_ACTION', 'الإجراء غير صالح');
        const offer = await this.db.get('SELECT * FROM flex_offers WHERE id = ?', [offerId]);
        if (!offer) throw new FlexError(404, 'FLEX_OFFER_NOT_FOUND', 'العرض غير موجود');
        if (offer.employee_id !== emp.id) throw new FlexError(403, 'FLEX_FORBIDDEN', 'هذا العرض ليس لك');
        if (offer.status !== 'offered') throw new FlexError(409, 'FLEX_OFFER_STALE', 'هذا العرض لم يعد قائمًا');
        const req = await this.db.get('SELECT * FROM flex_requests WHERE id = ?', [offer.flex_request_id]);
        if (!req || req.status !== 'offer_pending') throw new FlexError(409, 'FLEX_STATUS_STALE', 'طلب المرونة لم يعد بانتظار ردك');

        if (action === 'decline') {
            this.db.tx.immediate((hdl) => {
                const u = hdl.prepare(
                    `UPDATE flex_offers SET status='declined', responded_at=datetime('now') WHERE id = ? AND status = 'offered'`)
                    .run(offerId);
                if (u.changes !== 1) throw new FlexError(409, 'FLEX_OFFER_RACE', 'سباق على العرض — ROLLBACK كامل');
                const u2 = hdl.prepare(
                    `UPDATE flex_requests SET status='replacement_search', updated_at=datetime('now') WHERE id = ? AND status = 'offer_pending'`)
                    .run(req.id);
                if (u2.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || emp.name, 'flex_offer_decline',
                        `رفض عرض التغطية #${offerId} (طلب مرونة #${req.id}) — التقدم للمرشح التالي`, 'schedule');
            });
            const requester = await this.db.get('SELECT id, name FROM employees WHERE id = ?', [req.employee_id]);
            const next = await this._offerNext(req.id, user, requester || { id: req.employee_id });
            return { status: next ? 'offer_pending' : 'escalated', next_offer: next, request_id: req.id, requester_id: req.employee_id };
        }

        // accept: إعادة تحقق لحظية كاملة قبل التطبيق (لا ثقة بفحص سابق)
        const v = await validateAssignment(this.db, {
            employeeId: emp.id, date: offer.cover_date, shiftCode: offer.shift_code, operation: 'add', teamId: null
        });
        if (!v.valid) {
            this.db.tx.immediate((hdl) => {
                hdl.prepare(`UPDATE flex_offers SET status='invalidated', responded_at=datetime('now') WHERE id = ? AND status = 'offered'`).run(offerId);
                const u2 = hdl.prepare(
                    `UPDATE flex_requests SET status='replacement_search', updated_at=datetime('now') WHERE id = ? AND status = 'offer_pending'`)
                    .run(req.id);
                if (u2.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || emp.name, 'flex_offer_invalidated',
                        `استبعاد عرض #${offerId} عند إعادة التحقق اللحظية (طلب #${req.id})`, 'schedule');
            });
            const requester = await this.db.get('SELECT id, name FROM employees WHERE id = ?', [req.employee_id]);
            const next = await this._offerNext(req.id, user, requester || { id: req.employee_id });
            return { status: next ? 'offer_pending' : 'escalated', invalidated: true, next_offer: next, request_id: req.id, requester_id: req.employee_id };
        }

        // قبول صالح ⇒ قبول العرض ثم التطبيق الذري الكامل
        this.db.tx.immediate((hdl) => {
            const u = hdl.prepare(
                `UPDATE flex_offers SET status='accepted', responded_at=datetime('now') WHERE id = ? AND status = 'offered'`)
                .run(offerId);
            if (u.changes !== 1) throw new FlexError(409, 'FLEX_OFFER_RACE', 'سباق على العرض — ROLLBACK كامل');
            const u2 = hdl.prepare(
                `UPDATE flex_requests SET status='ready', updated_at=datetime('now') WHERE id = ? AND status = 'offer_pending'`)
                .run(req.id);
            if (u2.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
        });
        try {
            const revisionId = this.db.tx.immediate((hdl) =>
                this._applyInTx(hdl, req, offer, user, emp, false, 'ready'));
            return { status: 'applied', revision_id: revisionId, request_id: req.id, requester_id: req.employee_id };
        } catch (e) {
            // فشل حارس التطبيق (سباق roster) ⇒ تصعيد للمسؤول بدل ترك الطلب معلقًا —
            // العرض يبقى accepted ومراجعة المسؤول تعيد المحاولة بنفس الحراس.
            if (!(e && e.code)) throw e;
            this.db.tx.immediate((hdl) => {
                hdl.prepare(
                    `UPDATE flex_requests SET status='escalated', escalation_reason=?, updated_at=datetime('now')
                     WHERE id = ? AND status = 'ready'`)
                    .run('apply_guard_failed:' + e.code, req.id);
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || emp.name, 'flex_escalate',
                        `تصعيد طلب مرونة #${req.id} — فشل حارس التطبيق (${e.code})`, 'schedule');
            });
            return { status: 'escalated', escalation_reason: 'apply_guard_failed:' + e.code, request_id: req.id, requester_id: req.employee_id };
        }
    }

    // ═══ إلغاء الموظف (K5-like — بلا حذف فعلي) ═══

    async cancel(id, emp, user) {
        const req = await this.db.get('SELECT * FROM flex_requests WHERE id = ?', [id]);
        if (!req) throw new FlexError(404, 'FLEX_NOT_FOUND', 'الطلب غير موجود');
        if (req.employee_id !== emp.id) throw new FlexError(403, 'FLEX_FORBIDDEN', 'هذا الطلب ليس لك');
        if (!CANCELLABLE_STATUSES.includes(req.status)) {
            throw new FlexError(409, 'FLEX_NOT_CANCELLABLE', 'لا يمكن إلغاء الطلب في حالته الحالية');
        }
        let withdrawnOffer = null;
        this.db.tx.immediate((hdl) => {
            const live = hdl.prepare(`SELECT * FROM flex_offers WHERE flex_request_id = ? AND status = 'offered'`).get(id);
            if (live) {
                hdl.prepare(`UPDATE flex_offers SET status='withdrawn', responded_at=datetime('now') WHERE id = ? AND status = 'offered'`).run(live.id);
                withdrawnOffer = live;
            }
            const u = hdl.prepare(
                `UPDATE flex_requests SET status='cancelled', updated_at=datetime('now') WHERE id = ? AND status = ?`)
                .run(id, req.status);
            if (u.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || emp.name, 'flex_cancel', `إلغاء طلب مرونة #${id} من حالة ${req.status}`, 'schedule');
        });
        return { status: 'cancelled', withdrawn_offer: withdrawnOffer };
    }

    // ═══ مراجعة المسؤول (⑩ — escalate فقط؛ approve يعيد الحراس) ═══

    async review(id, actor, action, note) {
        if (!['approve', 'reject'].includes(action)) throw new FlexError(422, 'FLEX_INVALID_ACTION', 'الإجراء غير صالح');
        const req = await this.db.get('SELECT * FROM flex_requests WHERE id = ?', [id]);
        if (!req) throw new FlexError(404, 'FLEX_NOT_FOUND', 'الطلب غير موجود');
        if (req.status !== 'escalated') throw new FlexError(409, 'FLEX_NOT_ESCALATED', 'هذا الطلب ليس في حالة تصعيد');

        if (action === 'reject') {
            this.db.tx.immediate((hdl) => {
                const u = hdl.prepare(
                    `UPDATE flex_requests SET status='rejected', review_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now')
                     WHERE id = ? AND status = 'escalated'`).run(note || null, actor.id, id);
                if (u.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(actor.id, actor.name || 'غير معروف', 'flex_review_reject', `رفض طلب مرونة #${id} بعد التصعيد`, 'schedule');
            });
            return { status: 'rejected', request_id: req.id, requester_id: req.employee_id };
        }

        // approve: تطبيق ذري — الحارس النهائي يعيد كل الفحوص الخام؛ فشله ⇒ يبقى escalated
        const revisionId = this.db.tx.immediate((hdl) => {
            const u = hdl.prepare(
                `UPDATE flex_requests SET status='approved', review_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now')
                 WHERE id = ? AND status = 'escalated'`).run(note || null, actor.id, id);
            if (u.changes !== 1) throw new FlexError(409, 'FLEX_STATUS_RACE', 'تغيّرت حالة الطلب — ROLLBACK كامل');
            const accepted = hdl.prepare(`SELECT * FROM flex_offers WHERE flex_request_id = ? AND status = 'accepted'`).get(id);
            return this._applyInTx(hdl, req, accepted || null, actor, null, false, 'approved');
        });
        return { status: 'applied', revision_id: revisionId, request_id: req.id, requester_id: req.employee_id };
    }
}

module.exports = { FlexService, FlexError };
