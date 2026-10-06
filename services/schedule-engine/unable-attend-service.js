/**
 * ═══ services/schedule-engine/unable-attend-service.js — عدم التمكّن (FSS E-2) ═══
 *
 * قرارات المالك المعتمدة 2026-10-06 (M1/M2 + د1/د2/د3):
 *  ① كيان مستقل عن leave_requests — لا يُخصم من رصيد ولا يُعامل كإجازة (M1).
 *  ② حد الأيام (schedule_engine.max_unable_days_per_month=4) حد للمسار الطبيعي
 *     وليس رفضًا: الطلب الخامس+ ⇒ pending_review إجباريًا مع is_exception=1.
 *  ③ المسار المختلط (M2): ≤الحد بفحص تغطية لحظي عبر coverage-helper (M4 حرفيًا)
 *     — نظيف ⇒ auto_approved · تعارض ⇒ pending_review (تصعيد، ليس رفضًا).
 *     غياب roster لليوم ⇒ auto_approved مع إعادة تحقق لاحقة عند التوليد
 *     (القبول ليس ضمانًا مطلقًا — M2).
 *  ④ إلغاء المالك (د1): متاح لـ pending_review/auto_approved/approved طالما
 *     off_date في المستقبل — بلا حذف فعلي، وأثر الموافقة السابقة يبقى.
 *  ⑤ لا إجراء آلي للطلبات التي دخل تاريخها الماضي (د2) — والتقديم للماضي
 *     ممنوع أصلًا بـ PAST_DATE.
 *  ⑥ review_note اختياري (د3).
 *  ⑦ كل كتابة (submit/cancel/review) + قيد audit_log داخل tx.immediate واحدة
 *     — أي فشل = ROLLBACK للعملية والتدقيق معًا (نمط E-1). الإشعارات بعد
 *     COMMIT فقط وتُطلق من server.js (فشلها لا يُفقد الطلب).
 *  ⑧ E-2 لا يكتب في shift_roster إطلاقًا.
 */
'use strict';

const TimeRiyadh = require('../../public/js/time-riyadh.js');
const { getEngineSetting } = require('./config.js');
const { assessRemovalImpact } = require('./coverage-helper.js');

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const LIVE_STATUSES = ['auto_approved', 'pending_review', 'approved'];
const CANCELLABLE_STATUSES = ['pending_review', 'auto_approved', 'approved'];

class UAError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

class UnableAttendService {
    constructor(db) { this.db = db; }

    _riyadhToday() {
        const p = TimeRiyadh.riyadhParts(new Date());
        return `${p.year}-${p.month}-${p.day}`;
    }

    /** طلباتي لشهر + العدّ الحي + الحد الحالي من الإعدادات. */
    async getMine(emp, month) {
        const maxDays = await getEngineSetting('schedule_engine.max_unable_days_per_month');
        const rows = month
            ? await this.db.UnableAttendRequests.getByEmployeeMonth(emp.id, month)
            : await this.db.all('SELECT * FROM unable_attend_requests WHERE employee_id = ? ORDER BY off_date', [emp.id]);
        const live = rows.filter(r => LIVE_STATUSES.includes(r.status));
        return {
            max_days: maxDays,
            live_count: live.length,
            requests: rows
        };
    }

    /**
     * تقديم طلب عدم تمكّن — منطق القرار الكامل (M1/M2) داخل ترانزاكشن واحدة مع الـAudit.
     * @returns {Promise<{id, month, off_date, status, is_exception}>}
     */
    async submit(emp, user, offDate, reason) {
        if (typeof offDate !== 'string' || !DATE_RE.test(offDate.trim())) {
            throw new UAError(422, 'INVALID_OFF_DATE', 'صيغة التاريخ غير صالحة — المطلوب YYYY-MM-DD');
        }
        offDate = offDate.trim();
        if (offDate < this._riyadhToday()) {
            throw new UAError(422, 'PAST_DATE', 'لا يمكن تقديم طلب عدم تمكّن لتاريخ في الماضي');
        }
        const month = offDate.slice(0, 7);

        const existing = await this.db.UnableAttendRequests.getByEmployeeDate(emp.id, offDate);
        if (existing && !['rejected', 'cancelled'].includes(existing.status)) {
            throw new UAError(422, 'DUPLICATE_UNABLE_DATE', `لديك طلب قائم لهذا اليوم (${offDate}) بحالة ${existing.status}`);
        }

        const live = await this.db.UnableAttendRequests.getLiveByEmployeeMonth(emp.id, month);
        const maxDays = await getEngineSetting('schedule_engine.max_unable_days_per_month');
        const isException = (live.length + 1) > maxDays ? 1 : 0;

        let status, coverage = null;
        if (isException) {
            status = 'pending_review'; // M1: الطلب الخامس+ مراجعة إجبارية — وليس رفضًا
        } else {
            coverage = await assessRemovalImpact(this.db, emp.id, offDate);
            status = (coverage.assessable && coverage.wouldBreak) ? 'pending_review' : 'auto_approved';
        }

        const detail =
            `طلب عدم تمكّن: ${emp.name} (${emp.employee_code}) يوم ${offDate} ⇒ ${status}` +
            (isException ? ` · استثناء: تجاوز حد ${maxDays} أيام (رقم ${live.length + 1})` : '') +
            (coverage && coverage.assessable ? ` · تغطية بعد الخروج: day=${coverage.detail.after_removal.day}/night=${coverage.detail.after_removal.night}/total=${coverage.detail.after_removal.total} مقابل المطلوب day=${coverage.detail.rule.day}/night=${coverage.detail.rule.night}/total=${coverage.detail.rule.total}` : '') +
            (reason ? ` · السبب: ${String(reason).slice(0, 200)}` : '');

        const id = this.db.tx.immediate((hdl) => {
            let reqId;
            if (existing) {
                // إحياء سجل ملغى/مرفوض لنفس اليوم (UNIQUE employee+off_date) — لا INSERT مكرر
                hdl.prepare(`UPDATE unable_attend_requests SET month=?, reason=?, status=?, is_exception=?,
                             reviewed_by=NULL, reviewed_at=NULL, review_note=NULL, created_by=?, updated_at=datetime('now')
                             WHERE id=?`).run(month, reason || null, status, isException, user.id, existing.id);
                reqId = existing.id;
            } else {
                const r = hdl.prepare(`INSERT INTO unable_attend_requests (employee_id, month, off_date, reason, status, is_exception, created_by)
                                       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(emp.id, month, offDate, reason || null, status, isException, user.id);
                reqId = r.lastInsertRowid;
            }
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || 'غير معروف', 'unable_attend_submit', detail, 'schedule');
            return reqId;
        });

        return { id, month, off_date: offDate, status, is_exception: isException };
    }

    /** إلغاء المالك (د1): الحالات الثلاث ما دام اليوم في المستقبل — قفل شرطي ضد السباق. */
    async cancelMine(emp, user, requestId) {
        const request = await this.db.UnableAttendRequests.getById(requestId);
        if (!request) throw new UAError(404, 'NOT_FOUND', 'الطلب غير موجود');
        if (Number(request.employee_id) !== Number(emp.id)) {
            throw new UAError(403, 'NOT_REQUEST_OWNER', 'لا يمكنك إلغاء طلب ليس لك');
        }
        if (request.off_date < this._riyadhToday()) {
            throw new UAError(409, 'UNABLE_DATE_PAST', 'لا يمكن إلغاء طلب دخل تاريخه في الماضي');
        }
        if (!CANCELLABLE_STATUSES.includes(request.status)) {
            throw new UAError(409, 'UNABLE_ALREADY_PROCESSED', `لا يمكن إلغاء طلب بحالة ${request.status}`);
        }
        this.db.tx.immediate((hdl) => {
            const r = hdl.prepare(`UPDATE unable_attend_requests SET status='cancelled', updated_at=datetime('now')
                                   WHERE id=? AND status IN ('pending_review','auto_approved','approved')`).run(requestId);
            if (r.changes === 0) throw new UAError(409, 'UNABLE_ALREADY_PROCESSED', 'تغيّرت حالة الطلب أثناء الإلغاء — أعد المحاولة');
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || 'غير معروف', 'unable_attend_owner_cancel',
                    `إلغاء الموظف طلب عدم التمكّن #${requestId} (يوم ${request.off_date} — كان ${request.status}${request.status === 'approved' ? ' — أثر الموافقة محفوظ' : ''})`, 'schedule');
        });
        return { id: requestId, status: 'cancelled' };
    }

    /** قائمة المراجعة (حامل schedule.requests.review). */
    async getReviewQueue(status) {
        return this.db.UnableAttendRequests.getReviewQueue(status || 'pending_review');
    }

    /** قرار المراجعة: approve|reject — قفل شرطي على pending_review (409 عند السباق) + Audit ذرّي. */
    async review(requestId, reviewer, decision, note) {
        if (!['approve', 'reject'].includes(decision)) {
            throw new UAError(422, 'INVALID_REVIEW_DECISION', 'قرار المراجعة يجب أن يكون approve أو reject');
        }
        const request = await this.db.UnableAttendRequests.getById(requestId);
        if (!request) throw new UAError(404, 'NOT_FOUND', 'الطلب غير موجود');
        const newStatus = decision === 'approve' ? 'approved' : 'rejected';
        this.db.tx.immediate((hdl) => {
            const r = hdl.prepare(`UPDATE unable_attend_requests SET status=?, reviewed_by=?, reviewed_at=datetime('now'), review_note=?, updated_at=datetime('now')
                                   WHERE id=? AND status='pending_review'`).run(newStatus, reviewer.id, note || null, requestId);
            if (r.changes === 0) throw new UAError(409, 'UNABLE_ALREADY_PROCESSED', 'الطلب ليس قيد المراجعة (ربما عولج أو أُلغي)');
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(reviewer.id, reviewer.name || 'غير معروف', 'unable_attend_review',
                    `مراجعة طلب عدم التمكّن #${requestId} (موظف #${request.employee_id} يوم ${request.off_date}) ⇒ ${newStatus}${note ? ' · ملاحظة: ' + String(note).slice(0, 200) : ''}`, 'schedule');
        });
        return { id: requestId, status: newStatus, request };
    }
}

module.exports = { UnableAttendService, UAError };
