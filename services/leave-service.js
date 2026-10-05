/**
 * ═══ leave-service.js — منطق طلبات الإجازات (A-4.3) ═══
 * المصدر الوحيد لقواعد R1–R10 + تعديلات المالك M1–M4:
 *
 *  R1  حدّ موظفَين/يوم — يُحتسب على approved فقط.
 *      · عند التقديم: رفض إن كان يوم ما مكتملًا بـ 2 approved (فحص إرشادي)،
 *        + تحذير غير حاجب لأيام فيها pending متداخلة لموظفين آخرين.
 *      · عند الاعتماد (الفحص الحاسم): داخل tx.immediate — قفل كتابة فوري +
 *        UPDATE شرطي WHERE status='pending'؛ changes=0 = سباق = ROLLBACK.
 *  R2  لا تداخل pending/approved لنفس الموظف (تقديم/تعديل).
 *  R3  start<=end ولا ماضٍ (start>=today). المرضية بأثر رجعي = D3 مفتوح —
 *      لا قاعدة خاصة، تخضع لنفس المنع.
 *  R7  إلغاء المخوَّل لإجازة معتمدة يتطلب cancel_reason إلزاميًا.
 *  R8  كشف تعارض المناوبات المنشورة للعرض فقط — D7: صفر كتابة في shift_roster.
 *  R9  عدد الأيام شامل الطرفين، بحد أقصى 90 يومًا.
 *  R10 الرفض يتطلب denial_reason إلزاميًا.
 *
 *  M1  لا حذف فيزيائي إطلاقًا — كل إلغاء = status 'cancelled' + حدث تدقيق.
 *  M2  PUT للمالك فقط، pending فقط، قبل start_date، مع إعادة R2/R3/R9.
 *  M3  نطاق الرؤية يُفرض هنا (سيرفريًا) — الموظف يرى طلباته فقط.
 *  M4  db.tx/tx.immediate additive — run/get/all في db.js لا تُلمس.
 *
 * التدقيق: كل انتقال حالة = صف في leave_status_events (from_status=NULL عند
 * الإنشاء) داخل نفس معاملة التغيير — لا حالة بلا حدث ولا حدث بلا حالة.
 *
 * الإشعارات لا تُبنى هنا: تُطلق من server.js بعد COMMIT حصرًا (بنية A-1)،
 * والخدمة تعيد كل ما يلزم لبنائها (request + wasApproved + warnings).
 */
'use strict';

const MAX_PER_DAY = 2;   // R1
const MAX_DAYS = 90;     // R9
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// أنواع الإجازة — مطابقة لقيد CHECK في مخطط leave_requests (db.js).
// التحقق هنا يعيد 400 مفهومًا بدل 500 SQLITE_CONSTRAINT عند نوع غير معروف.
const LEAVE_TYPES = ['إجازة', 'مرضية', 'استثنائية'];

/** خطأ عمل مُنمَّط — الـ routes تحوّله لرد HTTP دون التفافات خاصة. */
function fail(httpStatus, error, extra) {
    const e = new Error(error);
    e.httpStatus = httpStatus;
    if (extra) Object.assign(e, extra);
    return e;
}

/** أيام النطاق شاملًا الطرفين (R9) — ['YYYY-MM-DD', ...] بترتيب تصاعدي. */
function daysInRange(startDate, endDate) {
    const days = [];
    const cur = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    while (cur <= end) {
        days.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
}

class LeaveService {
    /**
     * @param {object} deps
     * @param {object} deps.db — وحدة db.js (tx / tx.immediate / LeaveRequests / LeaveEvents)
     */
    constructor({ db } = {}) {
        if (!db || typeof db.tx !== 'function' || typeof db.tx.immediate !== 'function') {
            throw new Error('LeaveService: db مع tx/tx.immediate مطلوب');
        }
        this.db = db;
    }

    // ── تحققات صرفة (بلا قاعدة) ─────────────────────────────────────────

    /** R3 + R9 على مدخلات التواريخ. todayStr = 'YYYY-MM-DD' بتوقيت السيرفر. */
    _validateDates(start_date, end_date, todayStr) {
        if (!DATE_RE.test(start_date) || !DATE_RE.test(end_date)) {
            throw fail(400, 'صيغة التاريخ يجب أن تكون YYYY-MM-DD');
        }
        if (start_date > end_date) {
            throw fail(400, 'تاريخ البداية يجب أن يسبق أو يساوي تاريخ النهاية');
        }
        if (start_date < todayStr) {
            throw fail(400, 'لا يمكن طلب إجازة بتاريخ ماضٍ', { code: 'LEAVE_PAST_DATE' });
        }
        const count = daysInRange(start_date, end_date).length;
        if (count > MAX_DAYS) {
            throw fail(400, `الحد الأقصى لطلب الإجازة ${MAX_DAYS} يومًا (المطلوب ${count})`, { code: 'LEAVE_TOO_LONG' });
        }
    }

    /** نوع الإجازة ضمن قيد CHECK للمخطط — 400 مفهوم بدل قيد قاعدة صامت. */
    _validateType(type) {
        if (type != null && !LEAVE_TYPES.includes(type)) {
            throw fail(400, 'نوع الإجازة يجب أن يكون: ' + LEAVE_TYPES.join(' / '), { code: 'LEAVE_TYPE_INVALID' });
        }
    }

    // ── فحوص داخل المعاملة (handle متزامن) ──────────────────────────────

    /** R2: تداخل pending/approved لنفس الموظف. excludeId لاستثناء الذات عند التعديل. */
    _checkOwnOverlap(h, employeeId, start_date, end_date, excludeId) {
        const row = h.prepare(
            `SELECT id, status, start_date, end_date FROM leave_requests
             WHERE employee_id = ? AND status IN ('pending','approved')
               AND start_date <= ? AND end_date >= ? AND id != ?`
        ).get(employeeId, end_date, start_date, excludeId || -1);
        if (row) {
            throw fail(400, 'يوجد طلب إجازة متداخل لنفس الموظف', {
                code: 'LEAVE_OVERLAP',
                conflict: { id: row.id, status: row.status, start_date: row.start_date, end_date: row.end_date }
            });
        }
    }

    /**
     * R1 على الأيام: approved لموظفين آخرين >= 2 = يوم مكتمل.
     * pending الآخرون لا يُحتسبون في الحد — يُعادون كتحذيرات غير حاجبة.
     * @returns {{ warnings: Array<{date, pendingCount}> }}
     */
    _checkDailyLimit(h, employeeId, days, { blockOnFull = true } = {}) {
        const approvedStmt = h.prepare(
            `SELECT COUNT(*) AS c FROM leave_requests
             WHERE employee_id != ? AND status = 'approved'
               AND start_date <= ? AND end_date >= ?`
        );
        const pendingStmt = h.prepare(
            `SELECT COUNT(*) AS c FROM leave_requests
             WHERE employee_id != ? AND status = 'pending'
               AND start_date <= ? AND end_date >= ?`
        );
        const warnings = [];
        for (const day of days) {
            const approvedCount = approvedStmt.get(employeeId, day, day).c;
            if (approvedCount >= MAX_PER_DAY) {
                throw fail(400, `لا يمكن قبول الإجازة: يوجد ${approvedCount} موظفين في إجازة معتمدة بتاريخ ${day}. الحد الأقصى ${MAX_PER_DAY}.`, {
                    code: 'LEAVE_DAY_FULL',
                    date: day
                });
            }
            const pendingCount = pendingStmt.get(employeeId, day, day).c;
            if (pendingCount > 0) warnings.push({ date: day, pendingCount });
        }
        return { warnings };
    }

    // ── العمليات ─────────────────────────────────────────────────────────

    /**
     * تقديم طلب جديد (R1-تقديم + R2 + R3 + R9) + حدث تدقيق — ذريًا.
     * @returns {{ id:number, warnings:Array }}
     */
    submit({ employee_id, start_date, end_date, type, reason }, { todayStr, actor }) {
        this._validateDates(start_date, end_date, todayStr);
        this._validateType(type);
        const days = daysInRange(start_date, end_date);
        let id = null;
        let warnings = [];
        this.db.tx((h) => {
            this._checkOwnOverlap(h, employee_id, start_date, end_date, null);           // R2
            warnings = this._checkDailyLimit(h, employee_id, days).warnings;              // R1 + تحذيرات
            const r = h.prepare(
                `INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason, created_by)
                 VALUES (?, ?, ?, ?, 'pending', ?, ?)`
            ).run(employee_id, start_date, end_date, type || 'إجازة', reason || null, actor.userId);
            id = r.lastInsertRowid;
            h.prepare(
                `INSERT INTO leave_status_events (request_id, from_status, to_status, actor_user_id, actor_role, reason)
                 VALUES (?, NULL, 'pending', ?, ?, ?)`
            ).run(id, actor.userId, actor.role, reason || null);
        });
        return { id, warnings };
    }

    /**
     * قائمة الطلبات — M3: نطاق الرؤية يُفرض هنا.
     * canReview=true → الكل (مع فلاتر اختيارية). غير ذلك → طلبات المشاهد فقط؛
     * طلب employee_id أجنبي صراحة = 403. بلا موظف مربوط = قائمة فارغة.
     */
    async list({ canReview, viewerEmployeeId, status, employee_id }) {
        if (canReview) {
            if (employee_id) return this.db.LeaveRequests.getByEmployee(employee_id);
            if (status) return this.db.LeaveRequests.getByStatus(status);
            return this.db.LeaveRequests.getAll();
        }
        if (viewerEmployeeId == null) return [];
        if (employee_id && Number(employee_id) !== Number(viewerEmployeeId)) {
            throw fail(403, 'لا يمكنك عرض طلبات موظف آخر', { code: 'LEAVE_SCOPE' });
        }
        const rows = await this.db.LeaveRequests.getByEmployee(viewerEmployeeId);
        return status ? rows.filter((r) => r.status === status) : rows;
    }

    /**
     * تعديل طلب — M2: المالك فقط، pending فقط، قبل start_date، إعادة R2/R3/R9.
     * يُسجَّل كحدث تدقيق pending→pending بسبب «تعديل».
     */
    edit(id, { start_date, end_date, type, reason }, { todayStr, actor, viewerEmployeeId }) {
        this._validateDates(start_date, end_date, todayStr);
        this._validateType(type);
        const days = daysInRange(start_date, end_date);
        this.db.tx((h) => {
            const row = h.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
            if (!row) throw fail(404, 'الطلب غير موجود');
            if (viewerEmployeeId == null || Number(row.employee_id) !== Number(viewerEmployeeId)) {
                throw fail(403, 'يمكن لصاحب الطلب فقط تعديله', { code: 'LEAVE_NOT_OWNER' });
            }
            if (row.status !== 'pending') {
                throw fail(403, 'لا يمكن تعديل طلب تمت معالجته', { code: 'LEAVE_PROCESSED' });
            }
            if (todayStr >= row.start_date) {
                throw fail(400, 'لا يمكن تعديل طلب بدأ تاريخه', { code: 'LEAVE_STARTED' });
            }
            this._checkOwnOverlap(h, row.employee_id, start_date, end_date, row.id);      // R2 باستثناء الذات
            const r = h.prepare(
                `UPDATE leave_requests
                 SET start_date = ?, end_date = ?, type = ?, reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'`
            ).run(start_date, end_date, type || row.type, reason != null ? reason : row.reason, id);
            if (r.changes === 0) throw fail(409, 'تعذر التعديل — الطلب تمت معالجته أثناء العملية', { code: 'LEAVE_RACE' });
            h.prepare(
                `INSERT INTO leave_status_events (request_id, from_status, to_status, actor_user_id, actor_role, reason)
                 VALUES (?, 'pending', 'pending', ?, ?, 'تعديل الطلب')`
            ).run(id, actor.userId, actor.role);
        });
    }

    /**
     * إلغاء — M1: لا حذف فيزيائي، status='cancelled' + تدقيق.
     * pending: المالك فقط وقبل start_date. approved: canReview + سبب إلزامي (R7).
     * @returns {{ wasApproved:boolean, request:object }} — request = الصف قبل الإلغاء (للإشعار)
     */
    cancel(id, { actor, canReview, reason, todayStr, viewerEmployeeId }) {
        let snapshot = null;
        this.db.tx((h) => {
            const row = h.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
            if (!row) throw fail(404, 'الطلب غير موجود');
            snapshot = row;
            if (row.status === 'pending') {
                const isOwner = viewerEmployeeId != null && Number(row.employee_id) === Number(viewerEmployeeId);
                if (!isOwner) throw fail(403, 'يمكن لصاحب الطلب فقط إلغاؤه قبل معالجته', { code: 'LEAVE_NOT_OWNER' });
                if (todayStr >= row.start_date) {
                    throw fail(400, 'لا يمكن إلغاء طلب بدأ تاريخه', { code: 'LEAVE_STARTED' });
                }
            } else if (row.status === 'approved') {
                if (!canReview) throw fail(403, 'لا يمكن إلغاء إجازة معتمدة إلا بصلاحية مراجعة الإجازات', { code: 'LEAVE_REVIEW_REQUIRED' });
                if (!reason || !String(reason).trim()) {
                    throw fail(400, 'سبب الإلغاء إلزامي عند إلغاء إجازة معتمدة', { code: 'LEAVE_CANCEL_REASON_REQUIRED' });
                }
            } else {
                throw fail(400, 'الطلب تمت معالجته مسبقًا', { code: 'LEAVE_PROCESSED' });
            }
            const r = h.prepare(
                `UPDATE leave_requests
                 SET status = 'cancelled', cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP,
                     cancel_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = ?`
            ).run(actor.userId, reason ? String(reason).trim() : null, id, row.status);
            if (r.changes === 0) throw fail(409, 'تعذر الإلغاء — الطلب تمت معالجته أثناء العملية', { code: 'LEAVE_RACE' });
            h.prepare(
                `INSERT INTO leave_status_events (request_id, from_status, to_status, actor_user_id, actor_role, reason)
                 VALUES (?, ?, 'cancelled', ?, ?, ?)`
            ).run(id, row.status, actor.userId, actor.role, reason || null);
        });
        return { wasApproved: snapshot.status === 'approved', request: snapshot };
    }

    /**
     * اعتماد/رفض — الفحص الحاسم لـ R1 داخل tx.immediate (قفل كتابة فوري):
     * اعتمادان متزامنان لنفس اليوم المكتمل = واحد فقط ينجح، والثاني يرى
     * إما LEAVE_DAY_FULL أو LEAVE_RACE — وكلاهما ROLLBACK كامل بلا صف جزئي.
     * R10: الرفض يتطلب denial_reason.
     * @returns {{ request:object }} — الصف قبل التحديث (للإشعار)
     */
    review(id, decision, { actor, denial_reason }) {
        if (!['approved', 'denied'].includes(decision)) {
            throw fail(400, 'الحالة يجب أن تكون approved أو denied');
        }
        if (decision === 'denied' && (!denial_reason || !String(denial_reason).trim())) {
            throw fail(400, 'سبب الرفض إلزامي', { code: 'LEAVE_DENIAL_REASON_REQUIRED' });
        }
        let snapshot = null;
        this.db.tx.immediate((h) => {
            const row = h.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
            if (!row) throw fail(404, 'الطلب غير موجود');
            snapshot = row;
            if (row.status !== 'pending') {
                throw fail(400, 'الطلب تمت معالجته مسبقًا', { code: 'LEAVE_PROCESSED' });
            }
            if (decision === 'approved') {
                const days = daysInRange(row.start_date, row.end_date);
                // R2 دفاعي: لا اعتماد لطلب يتداخل مع approved آخر لنفس الموظف
                const ownApproved = h.prepare(
                    `SELECT id FROM leave_requests
                     WHERE employee_id = ? AND status = 'approved' AND id != ?
                       AND start_date <= ? AND end_date >= ?`
                ).get(row.employee_id, row.id, row.end_date, row.start_date);
                if (ownApproved) {
                    throw fail(400, 'لا يمكن الاعتماد — للموظف إجازة معتمدة متداخلة', { code: 'LEAVE_OVERLAP' });
                }
                // R1 الحاسم — كل يوم في النطاق
                this._checkDailyLimit(h, row.employee_id, days);
            }
            const r = h.prepare(
                `UPDATE leave_requests
                 SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP,
                     denial_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'`
            ).run(decision, actor.userId, decision === 'denied' ? String(denial_reason).trim() : null, id);
            if (r.changes === 0) throw fail(409, 'تعذرت المعالجة — الطلب عولج أثناء العملية', { code: 'LEAVE_RACE' });
            h.prepare(
                `INSERT INTO leave_status_events (request_id, from_status, to_status, actor_user_id, actor_role, reason)
                 VALUES (?, 'pending', ?, ?, ?, ?)`
            ).run(id, decision, actor.userId, actor.role, decision === 'denied' ? String(denial_reason).trim() : null);
        });
        return { request: snapshot };
    }

    /**
     * R8: مناوبات الموظف المنشورة خلال أيام الطلب — للعرض فقط.
     * D7: هذه قراءة صرفة؛ لا توجد أي كتابة في shift_roster من مسار الإجازات.
     */
    async conflictsForRequest(row) {
        return this.db.all(
            `SELECT sr.shift_date AS date, sr.shift_code AS code,
                    t.name AS team, t.center AS center
             FROM shift_roster sr
             LEFT JOIN teams t ON sr.team_id = t.id
             WHERE sr.employee_id = ? AND sr.shift_date BETWEEN ? AND ?
             ORDER BY sr.shift_date`,
            [row.employee_id, row.start_date, row.end_date]
        );
    }

    /** سجل التدقيق لطلب واحد — مرتب زمنيًا. */
    async getEvents(requestId) {
        return this.db.LeaveEvents.getByRequest(requestId);
    }
}

module.exports = LeaveService;
module.exports.daysInRange = daysInRange;
module.exports.MAX_PER_DAY = MAX_PER_DAY;
module.exports.MAX_DAYS = MAX_DAYS;
