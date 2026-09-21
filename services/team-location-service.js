/**
 * ═══ team-location-service.js — الموقع التشغيلي الحي للفرق (TL1 معتمد 2026-09-21) ═══
 * النطاق: خدمة الموقع فقط — GPS ← Team Location SSOT ← API. لا خريطة ولا ETA
 * ولا أقرب فرقة ولا سجل تاريخي في هذه المرحلة (قرارات المالك 8/9).
 *
 * القواعد المعتمدة:
 *  - صف واحد لكل فرقة (PRIMARY KEY team_id) — استحالة ظهور الفرقة مرتين بنيويًا.
 *  - السيرفر يحسم الفرقة من **التكليف التشغيلي الفعلي** عبر operational-assignment-service
 *    (معتمد 2026-09-21): جدولة + أحداث staffing المناوبة النشطة — الغياب/الخروج
 *    المفتوح يحجب، والإسناد/التفعيل ينقل الفرقة للبديل. team_id من العميل مرفوض (400).
 *  - الإرسال للفرق الميدانية فقط (FIELD_TEAM_TYPES: جنوب/دعم/سريع) — لا مواقع لإداريين.
 *  - قاعدة العضوين: الأحدث recorded_at يفوز، وعند التعادل الأدق (accuracy الأقل)
 *    — تُفرَض ذرّيًا داخل القاعدة بـUPSERT واحد بشرط WHERE (اعتماد المالك
 *    2026-09-22): لا SELECT-then-write، فلا يمكن للأقدم أن يكتب فوق الأحدث
 *    مهما تداخلت الطلبات المتزامنة.
 *  - received_at سيرفري حتمًا. الحالة مشتقة عند القراءة — لا تُخزَّن:
 *      fresh ≤ 120s · stale ≤ 15min · unavailable > 15min أو accuracy > 500m
 *    (عتبات معتمدة من المالك — ثوابت أدناه فقط، لا نسخة ثانية).
 */
'use strict';

const MyPortalService = require('./my-portal-service'); // FIELD_TEAM_TYPES المشتركة — لا نسخة ثانية

// ── العتبات المعتمدة (قرار المالك 1 — 2026-09-21) ──
const FRESH_MAX_AGE_S = 120;        // fresh: عمر الموقع ≤ 120 ثانية
const STALE_MAX_AGE_S = 15 * 60;    // stale: حتى 15 دقيقة
const MAX_ACCURACY_M = 500;         // دقة أسوأ من 500م ← unavailable
const MAX_FUTURE_SKEW_S = 300;      // سماح انحراف ساعة الجهاز — recorded_at المستقبلي البعيد مرفوض

class TeamLocationService {
    /**
     * @param {object} deps
     * @param {object} deps.db — طبقة القاعدة (db.get/db.run/db.all)
     * @param {object} deps.portal — نسخة MyPortalService (احتياط توافقي)
     * @param {object} deps.assignment — OperationalAssignmentService (التكليف الفعلي — مصدر الحسم)
     */
    constructor({ db, portal, assignment } = {}) {
        if (!db) throw new Error('TeamLocationService: db مطلوب');
        if (!assignment) throw new Error('TeamLocationService: assignment مطلوب');
        this.db = db;
        this.portal = portal || null;
        this.assignment = assignment;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    /** اشتقاق الحالة من الخام — عند القراءة فقط، لا تُخزَّن (قرار المالك 1). */
    static deriveStatus(recordedAtMs, accuracy, nowMs) {
        if (!Number.isFinite(recordedAtMs)) return 'unavailable';
        if (accuracy != null && accuracy > MAX_ACCURACY_M) return 'unavailable';
        const ageS = Math.max(0, Math.round((nowMs - recordedAtMs) / 1000));
        if (ageS > STALE_MAX_AGE_S) return 'unavailable';
        if (ageS > FRESH_MAX_AGE_S) return 'stale';
        return 'fresh';
    }

    /**
     * إرسال موقع من موظف البوابة. السيرفر يحسم الفرقة — team_id من العميل مرفوض.
     * @returns {Promise<{success:true, applied:boolean, teamId:number, teamName:string, status:string, reason?:string}>}
     */
    async submit(user, body) {
        if (body && (body.team_id !== undefined || body.teamId !== undefined)) {
            throw this._err(400, 'team_id لا يُقبل من التطبيق — السيرفر يحدد الفرقة من التكليف', 'TEAM_ID_NOT_ACCEPTED');
        }
        const { latitude, longitude, accuracy, recordedAt } = body || {};
        if (typeof latitude !== 'number' || !isFinite(latitude) || Math.abs(latitude) > 90 ||
            typeof longitude !== 'number' || !isFinite(longitude) || Math.abs(longitude) > 180) {
            throw this._err(422, 'إحداثيات غير صالحة', 'BAD_INPUT');
        }
        if (accuracy != null && (typeof accuracy !== 'number' || !isFinite(accuracy) || accuracy < 0)) {
            throw this._err(422, 'accuracy غير صالحة', 'BAD_INPUT');
        }
        const recordedMs = Date.parse(recordedAt);
        if (!Number.isFinite(recordedMs)) {
            throw this._err(422, 'recordedAt مطلوب بصيغة تاريخ ISO', 'BAD_INPUT');
        }
        const nowMs = Date.now();
        if (recordedMs > nowMs + MAX_FUTURE_SKEW_S * 1000) {
            throw this._err(422, 'recordedAt في المستقبل البعيد — تحقق من ساعة الجهاز', 'BAD_INPUT');
        }

        // السيرفر يحسم التكليف التشغيلي الفعلي (operational-assignment-service —
        // معتمد 2026-09-21): الغياب/الخروج المفتوح يحجب، والإسناد/التفعيل ينقل
        // الفرقة الفعلية للبديل. الجدولة وحدها لم تعد كافية.
        const eff = await this.assignment.resolveEffectiveAssignment(user);
        if (eff.notFound) throw this._err(404, 'لا يوجد ملف موظف مرتبط بهذا الحساب', 'NO_EMPLOYEE');
        if (!eff.deployable) {
            if (eff.blockReason === 'absent') {
                throw this._err(422, 'لا يمكن إرسال موقع الفرقة — لديك غياب/تأخر/خروج مفتوح في المناوبة الحالية', 'ABSENT_TODAY');
            }
            if (eff.blockReason === 'conflicting_assignment') {
                throw this._err(422, 'تكليفات تشغيلية متعارضة لنفس الشخص — راجع غرفة العمليات', 'CONFLICTING_ASSIGNMENT');
            }
            throw this._err(422, 'لا يوجد تكليف ميداني فعلي لك اليوم — لا يُنشأ موقع فرقة', 'NO_FIELD_ASSIGNMENT');
        }
        const team = { id: eff.teamId, name: eff.teamName };

        // قاعدة العضوين تُفرَض ذرّيًا داخل القاعدة نفسها (اعتماد المالك 2026-09-22):
        // لا SELECT ثم قرار ثم كتابة — عبارة UPSERT واحدة بشرط WHERE يجعل قاعدة
        // البيانات نفسها ترفض كتابة الأقدم فوق الأحدث مهما تداخلت الطلبات.
        // الأحدث recorded_at يفوز دائمًا، وعند التعادل الأدق (accuracy الأقل؛
        // NULL في المقارنة يخسر — مطابق لدلالة القاعدة الأصلية).
        const nowIso = new Date(nowMs).toISOString();
        const recordedIso = new Date(recordedMs).toISOString();
        const wr = await this.db.run(
            `INSERT INTO team_live_locations
                (team_id, latitude, longitude, accuracy, recorded_at, received_at, source_employee_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(team_id) DO UPDATE SET
                latitude = excluded.latitude, longitude = excluded.longitude,
                accuracy = excluded.accuracy, recorded_at = excluded.recorded_at,
                received_at = excluded.received_at,
                source_employee_id = excluded.source_employee_id, updated_at = excluded.updated_at
             WHERE excluded.recorded_at > team_live_locations.recorded_at
                OR (excluded.recorded_at = team_live_locations.recorded_at
                    AND excluded.accuracy < team_live_locations.accuracy)`,
            [team.id, latitude, longitude, accuracy == null ? null : accuracy,
             recordedIso, nowIso, eff.employeeId, nowIso]);

        if (wr && wr.changes === 0) {
            // الصف موجود وشرط الأحدث/الأدق رفض الكتابة ذرّيًا — الموقع الحالي بقي.
            // تحديث أقدم من المخزن لا يُطبَّق ولا يفشل الطلب — applied:false بصدق.
            // القراءة هنا للتقرير فقط (reason/status) — لا أثر لها على الفائز.
            const current = await this.db.get(
                'SELECT recorded_at, accuracy FROM team_live_locations WHERE team_id = ?', [team.id]);
            const currentMs = current ? Date.parse(current.recorded_at) : NaN;
            return {
                success: true, applied: false, reason: 'older_than_current',
                teamId: team.id, teamName: team.name, source: eff.source,
                status: TeamLocationService.deriveStatus(currentMs, current ? current.accuracy : null, nowMs)
            };
        }

        return {
            success: true, applied: true,
            teamId: team.id, teamName: team.name, source: eff.source,
            status: TeamLocationService.deriveStatus(recordedMs, accuracy, nowMs)
        };
    }

    /**
     * قراءة مواقع الفرق لغرفة العمليات — الحالة مشتقة هنا (لا تُخزَّن).
     * unavailable تُعاد بالحالة + ageSeconds + آخر موقع معروف (الخيار A المعتمد
     * 2026-09-21): غياب الموقع الحي معلومة تشغيلية. قيد العقد: unavailable ليست
     * موقعًا حيًا ولا تدخل أقرب-فرقة/ETA مستقبلًا.
     * @returns {Promise<{version:1, generatedAt:string, teams:Object}>}
     */
    async list() {
        const nowMs = Date.now();
        const rows = await this.db.all(
            `SELECT l.team_id, l.latitude, l.longitude, l.accuracy,
                    l.recorded_at, l.received_at, l.updated_at,
                    t.name AS team_name, t.team_type, t.is_active,
                    e.name AS source_employee_name, e.employee_code AS source_employee_code
             FROM team_live_locations l
             JOIN teams t ON t.id = l.team_id
             LEFT JOIN employees e ON e.id = l.source_employee_id`);
        const types = MyPortalService.FIELD_TEAM_TYPES;
        const teams = {};
        for (const r of rows) {
            if (!r.is_active || types.indexOf(r.team_type) === -1) continue; // ميدانية نشطة فقط
            const recordedMs = Date.parse(r.recorded_at);
            const status = TeamLocationService.deriveStatus(recordedMs, r.accuracy, nowMs);
            teams[r.team_name] = {
                teamId: r.team_id,
                latitude: r.latitude, longitude: r.longitude, accuracy: r.accuracy,
                recordedAt: r.recorded_at, receivedAt: r.received_at,
                ageSeconds: Number.isFinite(recordedMs) ? Math.max(0, Math.round((nowMs - recordedMs) / 1000)) : null,
                status, // fresh | stale | unavailable — الأخيرة: آخر موقع معروف وليس موقعًا حيًا
                sourceEmployee: r.source_employee_name || null
            };
        }
        return { version: 1, generatedAt: new Date(nowMs).toISOString(), teams };
    }
}

TeamLocationService.FRESH_MAX_AGE_S = FRESH_MAX_AGE_S;
TeamLocationService.STALE_MAX_AGE_S = STALE_MAX_AGE_S;
TeamLocationService.MAX_ACCURACY_M = MAX_ACCURACY_M;

module.exports = TeamLocationService;
