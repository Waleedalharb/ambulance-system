/**
 * ═══ services/schedule-engine/swap-service.js — التبديل بالتراضي (FSS E-6 / M9) ═══
 *
 * قرارات المالك المعتمدة 2026-10-06 (M9 + K1–K6، وK2 معدّلًا):
 *  ① K1: تبادل مناوبتين فعليتين بين موظفين — لا نقل أحادي الجانب. الخادم
 *     يشتق الصفين والرمزين من shift_roster (لا roster_id ولا shift_code من
 *     العميل)، وتُحفظ كـ«لقطات» في الطلب وتُطابَق عند القبول/التطبيق.
 *  ② K2 (معدّل): التاريخان يمكن أن يتساويا (أحمد صباح يوم 10 ↔ خالد ليل
 *     يوم 10 — كل واحد يبقى بمناوبة واحدة). لا قيد Business إضافي؛ E-4 هو
 *     الحكم النهائي على الراحة/التداخل/الليالي/الأهلية.
 *  ③ K3: نفس الفريق النشط (team_assignments هو SSOT للعضوية) — بنيويًا هذا
 *     يجعل عدّ تغطية M4 ثابتًا: تبادل نفس الفريق/التاريخ/الرمز لا يغيّر أي
 *     (team,date,code). فشل E-4 ⇒ تصعيد للمراجعة وليس رفضًا آليًا.
 *  ④ K4: نافذة التطبيق التلقائي = schedule_engine.swap_auto_window_hours
 *     (افتراضي 48) تُقاس لحظة قبول الطرف الثاني من بداية «أقرب» المناوبتين
 *     زمنيًا (date + time_start الفعليان من shift_codes، الرياض UTC+3 ثابتة).
 *     رمز بلا time_start ⇒ تحفظيًا داخل النافذة = تصعيد. النافذة لا تمنع
 *     المسؤول — هي سبب التصعيد أصلًا.
 *  ⑤ K5: إلغاء المبادر متاح من pending_consent/pending_review — بلا حذف فعلي
 *     أبدًا؛ cancelled/declined_by_peer/rejected حالات تاريخية نهائية.
 *  ⑥ M9/M4/M6/M7: لا مسار يكسر القواعد ولو بقرار مسؤول — approve يعيد
 *     validateAssignment للاتجاهين إلزاميًا؛ فاشلة ⇒ 409 والطلب يبقى
 *     pending_review. الشهر المنشور لا يمنع M9 (M13 يقيد محرك الاقتراحات،
 *     والتبديل بالتراضي مسار مستقل معتمد).
 *  ⑦ الحارس النهائي داخل نفس tx.immediate قبل أي كتابة على shift_roster:
 *     تحديث شرطي للحالة ⇒ فحص خام للصفين (موجود/موظف/رمز/فريق يطابق اللقطة)
 *     ⇒ فحص عضوية خام لكليهما في team_id بتاريخ صفّه ⇒ UPDATE شرطي لكل صف
 *     (changes=1 إلزامًا) ⇒ schedule_revisions (source='consent-swap') ⇒
 *     shift_audit_log×2 بنمط F-1 حرفيًا (change_type='swap') ⇒ audit_log.
 *     أي فشل = ROLLBACK كامل + صفر تعديل جزئي.
 *  ⑧ الإشعارات والبث بعد COMMIT فقط وتُطلق من server.js (سقوطها آمن ولا
 *     يُفقد التبديل). الفهرسان الجزئيان uq_swap_live_* يمنعان بنيويًا طلبين
 *     حيّين على نفس صف roster في نفس الدور، وفحص getLiveForRoster يغطي
 *     الدورين معًا ويُعاد خامًا داخل الترانزاكشن.
 *  ⑨ K6: Backend فقط — لا UI في E-6.
 */
'use strict';

const TimeRiyadh = require('../../public/js/time-riyadh.js');
const { getEngineSetting } = require('./config.js');
const { validateAssignment } = require('./validation-service.js');

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const LIVE_STATUSES = ['pending_consent', 'pending_review'];
const CANCELLABLE_STATUSES = ['pending_consent', 'pending_review'];

class SwapError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

class SwapService {
    constructor(db) { this.db = db; }

    _riyadhToday() {
        const p = TimeRiyadh.riyadhParts(new Date());
        return `${p.year}-${p.month}-${p.day}`;
    }

    // ═══════════════ القراءات ═══════════════

    /** طلباتي (مبادرًا أو هدفًا) مع أسماء الطرفين والفريق — قراءة فقط. */
    async getMine(emp) {
        return this.db.all(
            `SELECT s.*,
                    ei.name AS initiator_name, ei.employee_code AS initiator_code,
                    et.name AS target_name, et.employee_code AS target_code,
                    t.name AS team_name
             FROM shift_swap_requests s
             JOIN employees ei ON ei.id = s.initiator_employee_id
             JOIN employees et ON et.id = s.target_employee_id
             JOIN teams t ON t.id = s.team_id
             WHERE s.initiator_employee_id = ? OR s.target_employee_id = ?
             ORDER BY s.id DESC`, [emp.id, emp.id]);
    }

    async getReviewQueue(status) {
        return this.db.ShiftSwapRequests.getReviewQueue(status || 'pending_review');
    }

    // ═══════════════ التقديم (① K1) ═══════════════

    /**
     * تقديم طلب تبديل — الخادم يشتق الصفين والرمزين من shift_roster.
     * @param {object} emp موظف الجلسة (المبادر)
     * @param {object} user مستخدم الجلسة
     * @returns {Promise<{id, status, request}>}
     */
    async submit(emp, user, { target_employee_id, my_shift_date, target_shift_date }) {
        const targetId = Number(target_employee_id);
        if (!Number.isInteger(targetId) || targetId <= 0) {
            throw new SwapError(422, 'INVALID_TARGET', 'معرّف الزميل المستهدف غير صالح');
        }
        if (targetId === Number(emp.id)) {
            throw new SwapError(422, 'SWAP_SELF', 'لا يمكن تقديم طلب تبديل مع نفسك');
        }
        for (const [label, d] of [['my_shift_date', my_shift_date], ['target_shift_date', target_shift_date]]) {
            if (typeof d !== 'string' || !DATE_RE.test(d.trim())) {
                throw new SwapError(422, 'INVALID_DATE', `صيغة ${label} غير صالحة — المطلوب YYYY-MM-DD`);
            }
        }
        const myDate = my_shift_date.trim();
        const targetDate = target_shift_date.trim();
        const today = this._riyadhToday();
        if (myDate < today || targetDate < today) {
            throw new SwapError(422, 'PAST_DATE', 'لا يمكن تقديم طلب تبديل لمناوبة في الماضي');
        }

        const target = await this.db.get('SELECT id, name, is_active FROM employees WHERE id = ?', [targetId]);
        if (!target) throw new SwapError(404, 'TARGET_NOT_FOUND', 'الزميل المستهدف غير موجود');
        if (!target.is_active) throw new SwapError(422, 'TARGET_INACTIVE', 'الزميل المستهدف غير نشط');

        // اشتقاق الصفين خادميًا (① — لا roster_id/shift_code من العميل)
        const myRow = await this.db.ShiftRoster.getByEmployeeAndDate(emp.id, myDate);
        const targetRow = await this.db.ShiftRoster.getByEmployeeAndDate(targetId, targetDate);
        if (!myRow || !targetRow) {
            throw new SwapError(404, 'SWAP_ROSTER_NOT_FOUND',
                'لا توجد مناوبة مجدولة لأحد الطرفين في التاريخ المحدد');
        }
        // K3: نفس الفريق (من صفّي roster) + عضوية حية لكليهما عبر team_assignments (SSOT)
        if (!myRow.team_id || myRow.team_id !== targetRow.team_id) {
            throw new SwapError(422, 'SWAP_DIFFERENT_TEAMS',
                'التبديل بالتراضي في هذا الإصدار بين أعضاء الفريق نفسه فقط (K3)');
        }
        const teamId = myRow.team_id;
        for (const [empId, d] of [[emp.id, myDate], [targetId, targetDate]]) {
            const mem = await this._activeMembership(empId, teamId, d);
            if (!mem) {
                throw new SwapError(422, 'SWAP_DIFFERENT_TEAMS',
                    'أحد الطرفين ليس عضوًا نشطًا في الفريق بتاريخ مناوبته (team_assignments — K3)');
            }
        }
        // حارس «الصف مشغول بطلب حيٍّ» — يغطي الدورين (يُعاد خامًا داخل الترانزاكشن)
        for (const [empId, d] of [[emp.id, myDate], [targetId, targetDate]]) {
            const busy = await this.db.ShiftSwapRequests.getLiveForRoster(empId, d);
            if (busy) {
                throw new SwapError(409, 'SWAP_ROW_BUSY',
                    `إحدى المناوبتين مشمولة بطلب تبديل حيٍّ قائم (#${busy.id})`);
            }
        }

        const month = myDate.slice(0, 7);
        const id = this.db.tx.immediate((hdl) => {
            // إعادة حارس الازدحام خامًا (سباق محتمل بين الفحص والكتابة)
            for (const [empId, d] of [[emp.id, myDate], [targetId, targetDate]]) {
                const busy = hdl.prepare(
                    `SELECT id FROM shift_swap_requests
                     WHERE status IN ('pending_consent','pending_review')
                       AND ((initiator_employee_id = ? AND initiator_date = ?) OR (target_employee_id = ? AND target_date = ?))
                     LIMIT 1`).get(empId, d, empId, d);
                if (busy) {
                    throw new SwapError(409, 'SWAP_ROW_BUSY',
                        `إحدى المناوبتين مشمولة بطلب تبديل حيٍّ قائم (#${busy.id})`);
                }
            }
            const r = hdl.prepare(
                `INSERT INTO shift_swap_requests
                 (initiator_employee_id, target_employee_id, initiator_date, initiator_shift_code,
                  target_date, target_shift_code, team_id, month, status, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_consent', ?)`)
                .run(emp.id, targetId, myDate, myRow.shift_code, targetDate, targetRow.shift_code, teamId, month, user.id);
            const reqId = r.lastInsertRowid;
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || 'غير معروف', 'shift_swap_submit',
                    `طلب تبديل بالتراضي #${reqId}: ${emp.name} (${myDate} ${myRow.shift_code}) ↔ ${target.name} (${targetDate} ${targetRow.shift_code}) — فريق #${teamId}`, 'schedule');
            return reqId;
        });

        const request = await this.db.ShiftSwapRequests.getById(id);
        return { id, status: 'pending_consent', request };
    }

    // ═══════════════ موافقة/رفض الطرف الثاني ═══════════════

    /**
     * رد الهدف على الطلب: accept|decline.
     * accept ⇒ فحوصات (لقطات + نافذة K4 + E-4 للاتجاهين):
     *   كلها تنجح وخارج النافذة ⇒ تطبيق ذرّي (auto_applied).
     *   وإلا ⇒ تصعيد pending_review مع escalation_reason قابل للتفسير (M9: لا رفض آلي).
     * decline ⇒ declined_by_peer — إغلاق نهائي بلا تصعيد.
     */
    async consent(emp, user, requestId, decision) {
        if (!['accept', 'decline'].includes(decision)) {
            throw new SwapError(422, 'INVALID_DECISION', 'القرار يجب أن يكون accept أو decline');
        }
        const request = await this._getPartyRequest(requestId, emp, 'target');

        if (decision === 'decline') {
            this.db.tx.immediate((hdl) => {
                const r = hdl.prepare(
                    `UPDATE shift_swap_requests SET status='declined_by_peer', consent_by=?, consent_at=datetime('now'), updated_at=datetime('now')
                     WHERE id=? AND status='pending_consent'`).run(user.id, request.id);
                if (r.changes === 0) throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', 'تغيّرت حالة الطلب أثناء الرد');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || 'غير معروف', 'shift_swap_consent',
                        `رفض الطرف الثاني طلب التبديل #${request.id} ⇒ declined_by_peer (إغلاق نهائي بلا تصعيد)`, 'schedule');
            });
            return { id: request.id, status: 'declined_by_peer', request };
        }

        // ── accept: الفحوصات الكاملة (قراءات async أولًا) ──
        const checks = await this._runChecks(request, { withWindow: true });
        if (checks.rosterMismatch) {
            // اللقطات لم تعد تطابق الواقع — سابق التقديم مات: إلغاء ذرّي مع Audit
            this.db.tx.immediate((hdl) => {
                const r = hdl.prepare(
                    `UPDATE shift_swap_requests SET status='cancelled', updated_at=datetime('now'),
                            escalation_reason='roster_changed_at_consent'
                     WHERE id=? AND status='pending_consent'`).run(request.id);
                if (r.changes === 0) throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', 'تغيّرت حالة الطلب أثناء الرد');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || 'غير معروف', 'shift_swap_stale_cancel',
                        `طلب التبديل #${request.id} أُلغي عند الموافقة: ${checks.rosterMismatch} — اللقطات لم تعد تطابق shift_roster`, 'schedule');
            });
            throw new SwapError(409, 'SWAP_ROSTER_CHANGED',
                `تغيّرت المناوبات منذ تقديم الطلب (${checks.rosterMismatch}) — أُلغي الطلب، قدّم طلبًا جديدًا`);
        }

        const canAuto = !checks.insideWindow && checks.dirInitiator.valid && checks.dirTarget.valid;
        if (canAuto) {
            // تطبيق ذرّي فوري — الحارس النهائي الخام يُعاد داخل الترانزاكشن (⑦)
            const applied = this._applyTx(request, user, 'auto_applied', 'pending_consent');
            return {
                id: request.id, status: 'auto_applied', request,
                escalation_reason: null,
                applied: { ...applied, auto: true }
            };
        }

        // تصعيد للمراجعة (نافذة و/أو فشل E-4) — ليس رفضًا (M9)
        const escalation = JSON.stringify({
            window: checks.insideWindow,
            dir_initiator: { valid: checks.dirInitiator.valid, reasons: checks.dirInitiator.reasons },
            dir_target: { valid: checks.dirTarget.valid, reasons: checks.dirTarget.reasons }
        });
        this.db.tx.immediate((hdl) => {
            const r = hdl.prepare(
                `UPDATE shift_swap_requests SET status='pending_review', consent_by=?, consent_at=datetime('now'),
                        escalation_reason=?, updated_at=datetime('now')
                 WHERE id=? AND status='pending_consent'`).run(user.id, escalation, request.id);
            if (r.changes === 0) throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', 'تغيّرت حالة الطلب أثناء الرد');
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || 'غير معروف', 'shift_swap_escalate',
                    `موافقة الطرف الثاني على التبديل #${request.id} ⇒ تصعيد للمراجعة: ${escalation}`, 'schedule');
        });
        return { id: request.id, status: 'pending_review', request, escalation_reason: escalation };
    }

    // ═══════════════ إلغاء المبادر (K5) ═══════════════

    async cancelMine(emp, user, requestId) {
        const request = await this.db.ShiftSwapRequests.getById(requestId);
        if (!request) throw new SwapError(404, 'NOT_FOUND', 'طلب التبديل غير موجود');
        if (Number(request.initiator_employee_id) !== Number(emp.id)) {
            throw new SwapError(403, 'NOT_SWAP_PARTY', 'لا يمكن إلغاء طلب لست مبادره');
        }
        if (!CANCELLABLE_STATUSES.includes(request.status)) {
            throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', `لا يمكن إلغاء طلب بحالة ${request.status}`);
        }
        this.db.tx.immediate((hdl) => {
            const r = hdl.prepare(
                `UPDATE shift_swap_requests SET status='cancelled', updated_at=datetime('now')
                 WHERE id=? AND status IN ('pending_consent','pending_review')`).run(request.id);
            if (r.changes === 0) throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', 'تغيّرت حالة الطلب أثناء الإلغاء');
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || 'غير معروف', 'shift_swap_cancel',
                    `المبادر ألغى طلب التبديل #${request.id} من حالة ${request.status} (K5 — بلا حذف فعلي)`, 'schedule');
        });
        return { id: request.id, status: 'cancelled', request };
    }

    // ═══════════════ مراجعة المسؤول ═══════════════

    /**
     * قرار المسؤول على طلب مُصعَّد: approve|reject (ملاحظة اختيارية).
     * approve ⇒ إعادة فحوصات كاملة (لقطات + E-4 للاتجاهين — M9: لا كسر للقواعد
     * ولو بقرار مسؤول؛ النافذة وحدها لا تمنعه) ثم تطبيق ذرّي.
     * فاشلة ⇒ 409 والطلب يبقى pending_review كما هو.
     * reject ⇒ rejected نهائي — لا كتابة على shift_roster إطلاقًا.
     */
    async review(user, requestId, decision, note) {
        if (!['approve', 'reject'].includes(decision)) {
            throw new SwapError(422, 'INVALID_DECISION', 'القرار يجب أن يكون approve أو reject');
        }
        const request = await this.db.ShiftSwapRequests.getById(requestId);
        if (!request) throw new SwapError(404, 'NOT_FOUND', 'طلب التبديل غير موجود');
        if (request.status !== 'pending_review') {
            throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', `لا يمكن مراجعة طلب بحالة ${request.status}`);
        }

        if (decision === 'reject') {
            this.db.tx.immediate((hdl) => {
                const r = hdl.prepare(
                    `UPDATE shift_swap_requests SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'),
                            review_note=?, updated_at=datetime('now')
                     WHERE id=? AND status='pending_review'`).run(user.id, note || null, request.id);
                if (r.changes === 0) throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', 'تغيّرت حالة الطلب أثناء المراجعة');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || 'غير معروف', 'shift_swap_review',
                        `رفض المسؤول طلب التبديل #${request.id}${note ? ' — ' + String(note).slice(0, 200) : ''} (لا كتابة على shift_roster)`, 'schedule');
            });
            return { id: request.id, status: 'rejected', request };
        }

        // ── approve: إعادة الفحوصات إلزاميًا (بدون النافذة — K4 لا تمنع المسؤول) ──
        const checks = await this._runChecks(request, { withWindow: false });
        if (checks.rosterMismatch) {
            throw new SwapError(409, 'SWAP_ROSTER_CHANGED',
                `تغيّرت المناوبات منذ التصعيد (${checks.rosterMismatch}) — الطلب يبقى معلقًا؛ ارفضه أو اطلب طلبًا جديدًا`);
        }
        if (!checks.dirInitiator.valid || !checks.dirTarget.valid) {
            throw new SwapError(409, 'SWAP_VALIDATION_FAILED',
                'فشل تحقق E-4 عند الاعتماد — لا كسر للقواعد ولو بقرار مسؤول (M9): ' +
                `مبادر[${checks.dirInitiator.reasons.join(',') || 'سليم'}] هدف[${checks.dirTarget.reasons.join(',') || 'سليم'}]`);
        }
        const applied = this._applyTx(request, user, 'applied', 'pending_review', note);
        return { id: request.id, status: 'applied', request, applied: { ...applied, auto: false } };
    }

    // ═══════════════ الفحوصات المشتركة ═══════════════

    async _getPartyRequest(requestId, emp, role) {
        const request = await this.db.ShiftSwapRequests.getById(requestId);
        if (!request) throw new SwapError(404, 'NOT_FOUND', 'طلب التبديل غير موجود');
        const col = role === 'target' ? 'target_employee_id' : 'initiator_employee_id';
        if (Number(request[col]) !== Number(emp.id)) {
            throw new SwapError(403, 'NOT_SWAP_PARTY', 'لست طرفًا في طلب التبديل هذا');
        }
        if (request.status !== 'pending_consent') {
            throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', `لا يمكن الرد على طلب بحالة ${request.status}`);
        }
        return request;
    }

    async _activeMembership(employeeId, teamId, date) {
        return this.db.get(
            `SELECT 1 AS x FROM team_assignments
             WHERE employee_id = ? AND team_id = ?
               AND (end_date IS NULL OR end_date = '' OR end_date >= ?) LIMIT 1`,
            [employeeId, teamId, date]);
    }

    /**
     * فحوصات القبول/الاعتماد (قراءات فقط):
     *  ① الصفان الحاليان يطابقان اللقطات (موظف/رمز/فريق) — وإلا rosterMismatch.
     *  ② النافذة (اختيارية — لمسار القبول فقط): أقرب بداية مناوبة من الآن.
     *  ③ E-4 للاتجاهين: نفس التاريخ ⇒ 'change' مع تجاهل COVERAGE_BELOW_MINIMUM
     *     فقط (إيجابية كاذبة بنيوية — K3 يجعل التغطية ثابتة بالبناء) · تاريخان
     *     مختلفان ⇒ 'add' على تاريخ/رمز الآخر (صف الموظف المجاور قد يسبب رفض
     *     راحة تحفظي كاذب ⇒ تصعيد، موثق).
     */
    async _runChecks(request, { withWindow }) {
        const myRow = await this.db.ShiftRoster.getByEmployeeAndDate(request.initiator_employee_id, request.initiator_date);
        const targetRow = await this.db.ShiftRoster.getByEmployeeAndDate(request.target_employee_id, request.target_date);
        let rosterMismatch = null;
        if (!myRow || !targetRow) rosterMismatch = 'أحد صفّي المناوبة لم يعد موجودًا';
        else if (myRow.shift_code !== request.initiator_shift_code || targetRow.shift_code !== request.target_shift_code) rosterMismatch = 'تغيّر رمز إحدى المناوبتين';
        else if (myRow.team_id !== request.team_id || targetRow.team_id !== request.team_id) rosterMismatch = 'تغيّر فريق إحدى المناوبتين';
        if (rosterMismatch) return { rosterMismatch };

        let insideWindow = null;
        if (withWindow) {
            const windowHours = await getEngineSetting('schedule_engine.swap_auto_window_hours');
            const codes = await this.db.ShiftCodes.getAll();
            const codeMap = new Map((codes || []).map(c => [String(c.code), c]));
            // K4: بداية «أقرب» المناوبتين من لحظة القبول — الرياض UTC+3 ثابتة
            const starts = [[request.initiator_date, request.initiator_shift_code], [request.target_date, request.target_shift_code]]
                .map(([d, c]) => {
                    const ts = codeMap.get(String(c)) && codeMap.get(String(c)).time_start;
                    // رمز بلا time_start ⇒ تحفظيًا داخل النافذة (تصعيد)
                    if (!ts || !/^\d{2}:\d{2}/.test(ts)) return 0;
                    return Date.parse(`${d}T${ts.slice(0, 5)}:00+03:00`);
                });
            const earliest = Math.min(...starts);
            insideWindow = (earliest - Date.now()) < windowHours * 3600e3;
        }

        const sameDate = request.initiator_date === request.target_date;
        const dirInitiator = await this._validateDirection(
            request.initiator_employee_id, request, request.target_date, request.target_shift_code, sameDate);
        const dirTarget = await this._validateDirection(
            request.target_employee_id, request, request.initiator_date, request.initiator_shift_code, sameDate);

        return { rosterMismatch: null, insideWindow, dirInitiator, dirTarget };
    }

    /** اتجاه واحد: موظف سيأخذ (date, shiftCode) — E-4 حكم نهائي (K2). */
    async _validateDirection(employeeId, request, date, shiftCode, sameDate) {
        const v = await validateAssignment(this.db, {
            employeeId, date, shiftCode,
            operation: sameDate ? 'change' : 'add',
            teamId: request.team_id
        });
        let reasons = v.reasons || [];
        if (sameDate) {
            // تجاهل COVERAGE_BELOW_MINIMUM فقط — تبادل نفس الفريق/التاريخ/الرمز
            // لا يغيّر أي (team,date,code) فالتغطية ثابتة بنيويًا (K3)
            reasons = reasons.filter(r => r !== 'COVERAGE_BELOW_MINIMUM');
        }
        return { valid: reasons.length === 0, reasons, validation: v };
    }

    // ═══════════════ التطبيق الذرّي (⑦ الحارس النهائي) ═══════════════

    /**
     * تبديل الصفين على shift_roster داخل tx.immediate واحدة — كل الحراس
     * الخامون يُعادون داخلها، وأي فشل = ROLLBACK كامل + صفر تعديل جزئي.
     * @returns {{revisionId, auditIds, roster_id_1, roster_id_2}}
     */
    _applyTx(request, actor, newStatus, fromStatus, note) {
        return this.db.tx.immediate((hdl) => {
            // ⓪ قفل شرطي للحالة — أولًا، فأي فشل لاحق يعيدها مع كل شيء
            const upd = hdl.prepare(
                `UPDATE shift_swap_requests SET status=?, reviewed_by=CASE WHEN ?='applied' THEN ? ELSE reviewed_by END,
                        reviewed_at=CASE WHEN ?='applied' THEN datetime('now') ELSE reviewed_at END,
                        review_note=CASE WHEN ?='applied' THEN ? ELSE review_note END,
                        updated_at=datetime('now')
                 WHERE id=? AND status=?`)
                .run(newStatus, newStatus, actor.id, newStatus, newStatus, note || null, request.id, fromStatus);
            if (upd.changes === 0) throw new SwapError(409, 'SWAP_ALREADY_PROCESSED', 'تغيّرت حالة الطلب أثناء التطبيق');

            // ①②③ فحص خام للصفين: موجود/موظف/رمز/فريق يطابق اللقطة
            const row1 = hdl.prepare('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?')
                .get(request.initiator_employee_id, request.initiator_date);
            const row2 = hdl.prepare('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?')
                .get(request.target_employee_id, request.target_date);
            if (!row1 || !row2 ||
                row1.shift_code !== request.initiator_shift_code ||
                row2.shift_code !== request.target_shift_code ||
                row1.team_id !== request.team_id || row2.team_id !== request.team_id) {
                throw new SwapError(409, 'SWAP_ROSTER_CHANGED', 'تغيّرت المناوبات أثناء التطبيق — ROLLBACK كامل');
            }
            // ④ العضوية الحية لكليهما في الفريق بتاريخ صفّه (team_assignments SSOT)
            for (const [empId, d] of [[request.initiator_employee_id, request.initiator_date], [request.target_employee_id, request.target_date]]) {
                const mem = hdl.prepare(
                    `SELECT 1 AS x FROM team_assignments
                     WHERE employee_id = ? AND team_id = ?
                       AND (end_date IS NULL OR end_date = '' OR end_date >= ?) LIMIT 1`)
                    .get(empId, request.team_id, d);
                if (!mem) throw new SwapError(409, 'SWAP_MEMBERSHIP_LOST', 'فقد أحد الطرفين عضويته النشطة في الفريق — ROLLBACK كامل');
            }
            // ⑥ التحديث الشرطي للصفين — changes=1 إلزامًا لكل صف.
            // نفس التاريخ (K2): الفهرس الفريد idx_shift_roster_unique_date على
            // (employee_id, shift_date) يمنع التحديث التسلسلي — الحالة الوسيطة
            // تكرر (الهدف، التاريخ) فيرتطم بـUNIQUE. الحل داخل نفس الترانزاكشن:
            // حذف شرطي للصفين ثم إعادة إدراجهما بنفس id وكل الأعمدة الأصلية عدا
            // employee_id — لا FK يشير إلى shift_roster (تحقق sqlite_master)
            // ولا triggers عليها، وأي فشل يعيد كل شيء (ROLLBACK كامل).
            if (row1.shift_date === row2.shift_date) {
                const del = hdl.prepare('DELETE FROM shift_roster WHERE id = ? AND employee_id = ? AND shift_code = ?');
                const d1 = del.run(row1.id, request.initiator_employee_id, request.initiator_shift_code);
                const d2 = del.run(row2.id, request.target_employee_id, request.target_shift_code);
                if (d1.changes !== 1 || d2.changes !== 1) {
                    throw new SwapError(409, 'SWAP_ROSTER_CHANGED', 'سباق على صفوف المناوبات أثناء التطبيق — ROLLBACK كامل');
                }
                const ins = hdl.prepare(
                    'INSERT INTO shift_roster (id, employee_id, team_id, shift_date, shift_code, month, year, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
                ins.run(row1.id, request.target_employee_id, row1.team_id, row1.shift_date, row1.shift_code, row1.month, row1.year, row1.created_at);
                ins.run(row2.id, request.initiator_employee_id, row2.team_id, row2.shift_date, row2.shift_code, row2.month, row2.year, row2.created_at);
            } else {
                const u1 = hdl.prepare('UPDATE shift_roster SET employee_id = ? WHERE id = ? AND employee_id = ? AND shift_code = ?')
                    .run(request.target_employee_id, row1.id, request.initiator_employee_id, request.initiator_shift_code);
                const u2 = hdl.prepare('UPDATE shift_roster SET employee_id = ? WHERE id = ? AND employee_id = ? AND shift_code = ?')
                    .run(request.initiator_employee_id, row2.id, request.target_employee_id, request.target_shift_code);
                if (u1.changes !== 1 || u2.changes !== 1) {
                    throw new SwapError(409, 'SWAP_ROSTER_CHANGED', 'سباق على صفوف المناوبات أثناء التطبيق — ROLLBACK كامل');
                }
            }
            // مراجعة واحدة للتبديل + قيدا shift_audit_log بنمط F-1 حرفيًا
            const rev = hdl.prepare(
                'INSERT INTO schedule_revisions (source, actor_id, actor_name, stats_json) VALUES (?, ?, ?, ?)')
                .run('consent-swap', String(actor.id), actor.name || null, JSON.stringify({
                    swap_request_id: request.id,
                    roster_ids: [row1.id, row2.id],
                    employee_ids: [request.initiator_employee_id, request.target_employee_id],
                    auto: newStatus === 'auto_applied'
                }));
            const revisionId = rev.lastInsertRowid;
            const insShiftAudit = hdl.prepare(
                `INSERT INTO shift_audit_log (roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code,
                     old_team_id, new_team_id, changed_by, changed_by_name, change_type, reason, revision_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'swap', ?, ?)`);
            const changedBy = actor.username || actor.name || 'system';
            const sa1 = insShiftAudit.run(row1.id, request.initiator_employee_id, row1.team_id, row1.shift_date,
                row1.shift_code, row2.shift_code, row1.team_id, row2.team_id,
                changedBy, actor.name || null,
                `تبديل بالتراضي — طلب #${request.id} مع سجل ${row2.id}`, revisionId).lastInsertRowid;
            const sa2 = insShiftAudit.run(row2.id, request.target_employee_id, row2.team_id, row2.shift_date,
                row2.shift_code, row1.shift_code, row2.team_id, row1.team_id,
                changedBy, actor.name || null,
                `تبديل بالتراضي — طلب #${request.id} مع سجل ${row1.id}`, revisionId).lastInsertRowid;
            // ⑦ قيد audit_log العام في نفس الترانزاكشن
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(actor.id, actor.name || 'غير معروف', 'shift_swap_apply',
                    `تطبيق تبديل بالتراضي #${request.id} (${newStatus}): موظف #${request.initiator_employee_id} (${request.initiator_date} ${request.initiator_shift_code}) ↔ موظف #${request.target_employee_id} (${request.target_date} ${request.target_shift_code}) — مراجعة #${revisionId}`, 'schedule');
            return { revisionId, auditIds: [sa1, sa2], roster_id_1: row1.id, roster_id_2: row2.id };
        });
    }
}

module.exports = { SwapService, SwapError };
