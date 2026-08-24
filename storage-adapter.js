/**
 * Storage Adapter — Single Gateway to SQLite
 * ═══════════════════════════════════════════════════════════
 * No Manager or Endpoint talks to SQLite directly.
 * All data operations go through this adapter.
 *
 * NOTE: db.js run/get/all are async (Promise-returning).
 * Every call below MUST await so SQL errors surface instead of
 * being swallowed as unhandled rejections.
 */

class StorageAdapter {
    constructor(db) {
        this.db = db;
    }

    // ─── Shifts ───
    async createShift(data) {
        const result = await this.db.run(
            `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time, status, total_reports, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', 0, datetime('now'), datetime('now'))`,
            [data.shiftName, data.shiftDate, data.shiftTime, data.shiftType, data.shiftDay, data.startTime]
        );
        return result.id;
    }

    async getShiftById(id) {
        return this.db.get('SELECT * FROM shifts WHERE id = ?', [id]);
    }

    async getActiveShift() {
        return this.db.get("SELECT * FROM shifts WHERE status = 'active' ORDER BY id DESC LIMIT 1");
    }

    async archiveShift(id) {
        await this.db.run(
            "UPDATE shifts SET status = 'archived', archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            [id]
        );
    }

    async endShift(id, notes) {
        await this.db.run(
            "UPDATE shifts SET status = 'pending_handover', general_notes = ?, end_time = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            [notes || '', id]
        );
    }

    async updateShiftTotalReports(shiftId, total) {
        await this.db.run("UPDATE shifts SET total_reports = ?, updated_at = datetime('now') WHERE id = ?", [total, shiftId]);
    }

    async getAllShifts(limit = 100) {
        return this.db.all('SELECT * FROM shifts ORDER BY id DESC LIMIT ?', [limit]);
    }

    // ─── Reports ───
    async getReport(shiftId, center, unit) {
        return this.db.get(
            'SELECT id, count FROM reports WHERE shift_id = ? AND center = ? AND unit = ?',
            [shiftId, center, unit]
        );
    }

    async createReport(shiftId, center, unit) {
        const result = await this.db.run(
            'INSERT INTO reports (shift_id, center, unit, count) VALUES (?, ?, ?, 1)',
            [shiftId, center, unit]
        );
        return { id: result.id, count: 1 };
    }

    async incrementReport(id) {
        await this.db.run('UPDATE reports SET count = count + 1 WHERE id = ?', [id]);
        const row = await this.db.get('SELECT count FROM reports WHERE id = ?', [id]);
        return row ? row.count : 0;
    }

    async decrementReport(id) {
        await this.db.run('UPDATE reports SET count = count - 1 WHERE id = ? AND count > 0', [id]);
        const row = await this.db.get('SELECT count FROM reports WHERE id = ?', [id]);
        return row ? row.count : 0;
    }

    async addReportTime(reportId, timestamp, type, incidentNumber = null, phases = null, respArrivalMin = null, respMubasharaMin = null) {
        await this.db.run(
            'INSERT INTO report_times (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [reportId, timestamp, type || null, incidentNumber || null, phases || null, respArrivalMin, respMubasharaMin]
        );
    }

    // ─── سجل البلاغات برقم Incident ID (محرك التوزيع 2026-08-20) ───
    async findIncident(shiftId, number) {
        return this.db.get('SELECT * FROM incident_registry WHERE shift_id = ? AND number = ?', [shiftId, number]);
    }
    /** رقم البلاغ هو المفتاح بنيويًا (قرار المالك 2026-08-21): بحث عابر للمناوبات —
        يمنع تكرار البلاغ عند التسليم بين مناوبتين (نفس البلاغ كان يُنشأ من جديد) */
    async findIncidentByNumber(number) {
        return this.db.get('SELECT * FROM incident_registry WHERE number = ? ORDER BY id DESC LIMIT 1', [number]);
    }
    async createIncident(shiftId, number, code, type, source, cadCreatedAt = null, address = null, region = null, district = null, street = null, city = null, lat = null, lng = null) {
        const result = await this.db.run(
            'INSERT INTO incident_registry (shift_id, number, code, type, source, created_at, cad_created_at, address, region, district, street, city, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [shiftId, number, code || null, type || null, source || null, new Date().toISOString(), cadCreatedAt || null, address || null, region || null, district || null, street || null, city || null, lat, lng]
        );
        return result.id;
    }
    async updateIncidentCode(id, code) {
        await this.db.run('UPDATE incident_registry SET code = ? WHERE id = ? AND code IS NULL', [code, id]);
    }
    /** وقت إنشاء البلاغ في CAD يُستكمل إن وصل متأخرًا — الموجود لا يُمس أبدًا */
    async updateIncidentCadCreatedAt(id, cadCreatedAt) {
        await this.db.run('UPDATE incident_registry SET cad_created_at = ? WHERE id = ? AND cad_created_at IS NULL', [cadCreatedAt, id]);
    }
    /** استكمال بيانات الموقع إن وصلت متأخرة — الموجود لا يُمس أبدًا */
    async updateIncidentLocation(id, address, region, district, street = null, city = null, lat = null, lng = null) {
        await this.db.run(
            `UPDATE incident_registry SET
               address = COALESCE(address, ?),
               region = COALESCE(region, ?),
               district = COALESCE(district, ?),
               street = COALESCE(street, ?),
               city = COALESCE(city, ?),
               lat = COALESCE(lat, ?),
               lng = COALESCE(lng, ?)
             WHERE id = ?`,
            [address, region, district, street, city, lat, lng, id]);
    }
    /** تصحيح موقع CAD (قرار المالك 2026-08-21): يكتب فوق الإحداثيات فقط — بقية الحقول لا تُمس */
    async updateIncidentCoords(id, lat, lng) {
        await this.db.run('UPDATE incident_registry SET lat = ?, lng = ? WHERE id = ?', [lat, lng, id]);
    }
    /** حالة دورة حياة البلاغ (قرار المالك 2026-08-22): active/closed/cancelled —
        القرار (لصق النهائي ومنع الارتداد) في ReportService، هنا كتابة صرفة */
    async updateIncidentStatus(id, status) {
        await this.db.run('UPDATE incident_registry SET status = ? WHERE id = ?', [status, id]);
    }
    /** هل شاركت هذه الفرقة في هذا البلاغ داخل هذه المناوبة؟ (القاعدة ③) */
    async findParticipation(shiftId, unit, incidentNumber) {
        return this.db.get(
            `SELECT t.id, t.phases, r.unit FROM report_times t JOIN reports r ON r.id = t.report_id
             WHERE r.shift_id = ? AND r.unit = ? AND t.incident_number = ? LIMIT 1`,
            [shiftId, unit, incidentNumber]
        );
    }
    /** مطابقة المشاركة بهوية الوحدة الثابتة في CAD (قرار المالك 2026-08-23):
        eventId + cad_run_unit_id (الأقوى — فريد لكل إسناد) ثم cad_unit_id.
        تسبق مطابقة الاسم حتى لا تتكرر المشاركة إذا تغيّر المسمى (ظهور الفرقة
        في التكميل لاحقًا بصيغة مختلفة) — نفس المشاركة تُحدَّث ولا تُنشأ ثانية. */
    async findParticipationByCadUnit(shiftId, incidentNumber, runUnitId, unitId) {
        if (Number.isInteger(runUnitId)) {
            const row = await this.db.get(
                `SELECT t.id, t.phases, r.unit FROM report_times t JOIN reports r ON r.id = t.report_id
                 WHERE r.shift_id = ? AND t.incident_number = ? AND t.cad_run_unit_id = ? LIMIT 1`,
                [shiftId, incidentNumber, runUnitId]);
            if (row) return row;
        }
        if (Number.isInteger(unitId)) {
            const row = await this.db.get(
                `SELECT t.id, t.phases, r.unit FROM report_times t JOIN reports r ON r.id = t.report_id
                 WHERE r.shift_id = ? AND t.incident_number = ? AND t.cad_unit_id = ? LIMIT 1`,
                [shiftId, incidentNumber, unitId]);
            if (row) return row;
        }
        return null;
    }
    /**
     * دمج الأزمنة التصاعدي (قاعدة العدالة 2026-08-20): لقطة CAD تتطور مع الوقت،
     * فعند تكرار نفس الفرقة على نفس البلاغ نستكمل مفاتيح phases الناقصة فقط —
     * القيم الموجودة لا تُمس أبدًا، ولا يُنشأ سجل جديد (لا تضاعف للعدّاد).
     * يعيد phases النهائية بعد الدمج لإعادة حساب زمني الاستجابة.
     */
    async mergeParticipationPhases(id, incomingPhases) {
        const row = await this.db.get('SELECT phases FROM report_times WHERE id = ?', [id]);
        if (!row) return { merged: 0, phases: null };
        let current = {};
        try { current = row.phases ? JSON.parse(row.phases) : {}; } catch (_) { current = {}; }
        let merged = 0;
        for (const k of Object.keys(incomingPhases || {})) {
            if (current[k] === undefined || current[k] === null || current[k] === '') {
                current[k] = incomingPhases[k];
                merged++;
            }
        }
        if (merged > 0) {
            await this.db.run('UPDATE report_times SET phases = ? WHERE id = ?', [JSON.stringify(current), id]);
        }
        return { merged, phases: current };
    }
    /** تصحيح الأزمنة من Journey الوحدة الموثوقة (قرار المالك 2026-08-23):
        عندما تصل phases مصدرها journeys الخاصة بالوحدة (phasesSource='cad-detail')
        تستبدل اللقطة المخزنة بالكامل — بما فيها إزالة الأوقات الخاطئة التي نُسخت
        سابقًا من وحدات أخرى (أصل خلل 1307875). القيمة القديمة تُعاد لسجل التدقيق —
        تصحيح موثق، لا حذف صامت للتاريخ. */
    async replaceParticipationPhases(id, newPhases) {
        const row = await this.db.get('SELECT phases FROM report_times WHERE id = ?', [id]);
        if (!row) return { replaced: false, oldPhases: null };
        const oldPhases = row.phases;
        const n = (newPhases && Object.keys(newPhases).length) ? JSON.stringify(newPhases) : null;
        if (oldPhases === n) return { replaced: false, oldPhases };
        await this.db.run('UPDATE report_times SET phases = ? WHERE id = ?', [n, id]);
        return { replaced: true, oldPhases };
    }
    /** يحفظ زمني الاستجابة المحسوبين مع المشاركة (قابلان للتتبع إلى phases الخام) */
    async updateParticipationResponse(id, arrivalMin, mubasharaMin) {
        await this.db.run('UPDATE report_times SET resp_arrival_min = ?, resp_mubashara_min = ? WHERE id = ?', [arrivalMin, mubasharaMin, id]);
    }
    /** حالة المشاركة الحالية (قرار المالك 2026-08-21 — §4): سحب/إلغاء الفرقة من البلاغ
        يُعلَّم على السجل نفسه — لا حذف ولا إخفاء واجهة، بل مصدر قرار واحد */
    async setParticipationWithdrawn(shiftId, unit, incidentNumber, withdrawn) {
        await this.db.run(
            `UPDATE report_times SET withdrawn = ?
             WHERE incident_number = ? AND report_id IN
               (SELECT id FROM reports WHERE shift_id = ? AND unit = ?)`,
            [withdrawn ? 1 : 0, incidentNumber, shiftId, unit]);
    }
    /** قراءة حالة الإلغاء اليدوي لمشاركة بمعرّفها (تغليف طبقة التخزين — 2026-08-24) */
    async getParticipationManualState(id) {
        return this.db.get(
            'SELECT id, manual_cancelled, manual_cancelled_by, manual_cancelled_at, manual_cancel_reason FROM report_times WHERE id = ?', [id]);
    }
    /** الإلغاء اليدوي للمشاركة من توزيع البلاغات (اعتماد المالك 2026-08-24):
        تعليم/رفع manual_cancelled على صف المشاركة نفسه بالهوية — لا حذف إطلاقًا.
        بالفاعل والوقت والسبب عند التعليم، ويحتفظ بها عند الرفع (التاريخ يبقى) */
    async setParticipationManualCancelled(id, cancelled, by, reason) {
        if (cancelled) {
            await this.db.run(
                `UPDATE report_times SET manual_cancelled = 1, manual_cancelled_by = ?, manual_cancelled_at = ?, manual_cancel_reason = ? WHERE id = ?`,
                [by || null, new Date().toISOString(), reason || null, id]);
        } else {
            await this.db.run('UPDATE report_times SET manual_cancelled = 0 WHERE id = ?', [id]);
        }
    }
    /** حالة الوحدة في CAD (قرار المالك 2026-08-22): تُحفظ خامًا ومطبَّعة للتتبع —
        cad_unit_status = حرف unitRequestStatus (A/B/C/R)، cad_reached = وصول/مباشرة
        فعلية من journeys (1/0). لا قرار هنا — القرار في ReportService، هنا تتبع فقط */
    async setParticipationCadUnitState(shiftId, unit, incidentNumber, urs, reached, unitId, runUnitId) {
        await this.db.run(
            `UPDATE report_times SET cad_unit_status = ?, cad_reached = ?, cad_unit_id = ?, cad_run_unit_id = ?
             WHERE incident_number = ? AND report_id IN
               (SELECT id FROM reports WHERE shift_id = ? AND unit = ?)`,
            [urs, reached === true ? 1 : (reached === false ? 0 : null),
             Number.isInteger(unitId) ? unitId : null, Number.isInteger(runUnitId) ? runUnitId : null,
             incidentNumber, shiftId, unit]);
    }
    /** كل مشاركات بلاغ (لإعادة حساب الأزمنة عند وصول وقت إنشائه متأخرًا) */
    async getIncidentParticipations(shiftId, number) {
        return this.db.all(
            `SELECT t.id, t.phases FROM report_times t JOIN reports r ON r.id = t.report_id
             WHERE r.shift_id = ? AND t.incident_number = ?`, [shiftId, number]);
    }
    /** إحصائية المحرك: الإجمالي بأرقام البلاغات الفريدة + اليدوي، والنوع مرة لكل بلاغ */
    async getIncidentSummary(shiftId) {
        const incidents = await this.db.all(
            'SELECT * FROM incident_registry WHERE shift_id = ? ORDER BY created_at ASC, id ASC', [shiftId]);
        // مشاركات البلاغات المرقّمة (لكل فرقة أزمنتها وأزمنة استجابتها المحسوبة وحالة مشاركتها)
        const parts = await this.db.all(
            `SELECT t.id, t.incident_number, t.timestamp, r.unit, t.phases, t.resp_arrival_min, t.resp_mubashara_min, t.withdrawn, t.cad_unit_status, t.cad_reached, t.cad_unit_id, t.cad_run_unit_id, t.manual_cancelled, t.manual_cancelled_by, t.manual_cancelled_at, t.manual_cancel_reason
             FROM report_times t JOIN reports r ON r.id = t.report_id
             WHERE r.shift_id = ? AND t.incident_number IS NOT NULL`, [shiftId]);
        // الضغطات اليدوية (بلا رقم) — كل واحدة بلاغ مستقل كما هو معتاد
        const manual = await this.db.all(
            `SELECT t.id, t.timestamp, t.type, r.unit
             FROM report_times t JOIN reports r ON r.id = t.report_id
             WHERE r.shift_id = ? AND t.incident_number IS NULL`, [shiftId]);
        return { incidents, parts, manual };
    }

    /** بيانات الذاكرة التاريخية للخريطة (H1 — اعتماد المالك 2026-08-24، وثيقة
        DECISION-HISTORICAL-ANALYTICS): كل البلاغات المسجلة في incident_registry
        عبر كل المناوبات + مشاركاتها المرقّمة (مع shift_id لأن تفرد الرقم مضمون
        داخل المناوبة فقط). قراءة صرفة بلا قرار — الترشيح الزمني وقواعد الاحتساب
        (لا Journey = لا مشاركة · لا withdrawn/manual_cancelled) كلها في
        ReportService.getHistoricalSummary حتى تبقى قاعدة الاحتساب واحدة. */
    async getIncidentHistoryData() {
        const incidents = await this.db.all(
            'SELECT * FROM incident_registry ORDER BY created_at ASC, id ASC');
        const parts = await this.db.all(
            `SELECT r.shift_id, t.incident_number, t.timestamp, r.unit, t.phases, t.resp_arrival_min, t.resp_mubashara_min, t.withdrawn, t.cad_unit_status, t.cad_reached, t.cad_unit_id, t.cad_run_unit_id, t.manual_cancelled, t.manual_cancelled_by, t.manual_cancelled_at, t.manual_cancel_reason
             FROM report_times t JOIN reports r ON r.id = t.report_id
             WHERE t.incident_number IS NOT NULL`);
        return { incidents, parts };
    }

    /** سجل التمركز التاريخي كاملًا (H3/H4 — اعتماد المالك 2026-08-24): كل أحداث
        positioning_events (append-only) بحمولاتها — لقطة الخطة وقت كل حدث.
        قراءة صرفة: تفسير الحمولة والنوافذ الزمنية في ReportService.getCoverage. */
    async getPositioningHistory() {
        return this.db.all(
            'SELECT id, shift_id, plan_id, event_type, changed_fields, payload, actor_id, actor_name, created_at FROM positioning_events ORDER BY created_at ASC, id ASC');
    }

    async deleteLastReportTime(reportId) {
        await this.db.run(
            'DELETE FROM report_times WHERE id = (SELECT id FROM report_times WHERE report_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1)',
            [reportId]
        );
    }

    async getTotalReports(shiftId) {
        const row = await this.db.get('SELECT SUM(count) as total FROM reports WHERE shift_id = ?', [shiftId]);
        return row ? (row.total || 0) : 0;
    }

    async getReportsByShift(shiftId) {
        return this.db.all('SELECT * FROM reports WHERE shift_id = ?', [shiftId]);
    }

    /** كل صفوف المشاركات لمناوبة (قرار المالك 2026-08-24 — مصدر واحد للاحتساب):
        صف report_times + مركز/وحدة reports مع حقول الاستبعاد (withdrawn /
        manual_cancelled) ولقطة phases الخام. لا قرار هنا — القاعدة الواحدة في
        ReportService.isParticipationCounted، هنا قراءة صرفة قابلة للتتبع. */
    async getShiftParticipationRows(shiftId) {
        return this.db.all(
            `SELECT r.center, r.unit, t.id, t.timestamp, t.type, t.incident_number, t.phases, t.withdrawn, t.manual_cancelled
             FROM reports r
             LEFT JOIN report_times t ON t.report_id = r.id
             WHERE r.shift_id = ?
             ORDER BY r.id ASC, t.id ASC`, [shiftId]);
    }

    // ─── Shift Completions ───
    async createCompletion(data) {
        const result = await this.db.run(
            `INSERT INTO shift_completions (shift_type, shift_date, shift_id, teams_data, notes, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [data.shiftType, data.shiftDate, data.shiftId, JSON.stringify(data.teams), data.notes || '', data.createdBy, data.createdAt]
        );
        return result.id;
    }

    async getLatestCompletion(shiftDate, shiftType) {
        return this.db.get(
            'SELECT * FROM shift_completions WHERE shift_date = ? AND shift_type = ? ORDER BY created_at DESC LIMIT 1',
            [shiftDate, shiftType]
        );
    }

    // OV-S6-01: read by shift_id — label-agnostic, so even historically
    // mis-stamped rows stay visible through their own shift.
    async getLatestCompletionByShiftId(shiftId) {
        return this.db.get(
            'SELECT * FROM shift_completions WHERE shift_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
            [shiftId]
        );
    }

    // ─── Audit Log ───
    async logAudit(data) {
        await this.db.run(
            `INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [data.shiftId, data.userId, data.userName, data.action, data.detail, data.type]
        );
    }

    // ─── Generic ───
    async exec(sql) {
        await this.db.exec(sql);
    }

    async run(sql, params = []) {
        return this.db.run(sql, params);
    }

    async get(sql, params = []) {
        return this.db.get(sql, params);
    }

    async all(sql, params = []) {
        return this.db.all(sql, params);
    }

    // ─── W1-A: Operational Event Log (append-only — لا توجد دوال UPDATE/DELETE هنا أصلًا) ───
    async appendOperationalEvent(e) {
        const result = await this.db.run(
            `INSERT INTO operational_events
             (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center,
              event_type, status, reason, readiness_basis, corrects_event_id, payload, note,
              actor_id, actor_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [e.shiftId, e.shiftDate, e.shiftType, e.domain, e.entityId || null, e.entityName || null,
             e.teamId || null, e.center || null, e.eventType, e.status || null, e.reason || null,
             e.readinessBasis || null, e.correctsEventId || null,
             e.payload ? JSON.stringify(e.payload) : null, e.note || null,
             e.actorId, e.actorName, e.createdAt]
        );
        return result.id;
    }

    async getOperationalEventsByShift(shiftId, domain = null) {
        if (domain) {
            return this.db.all(
                'SELECT * FROM operational_events WHERE shift_id = ? AND domain = ? ORDER BY created_at ASC, id ASC',
                [shiftId, domain]
            );
        }
        return this.db.all(
            'SELECT * FROM operational_events WHERE shift_id = ? ORDER BY created_at ASC, id ASC',
            [shiftId]
        );
    }

    // ─── W1-D: سجل المركبات المرجعي (قرار 7-3) — قراءة فقط هنا؛ التوليد ذاتي في db.js ───
    async getVehicles() {
        return this.db.all('SELECT * FROM vehicles WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
    }

    async getVehicleById(id) {
        return this.db.get('SELECT * FROM vehicles WHERE id = ?', [String(id)]);
    }

    async getVehicleByPlate(plate) {
        return this.db.get('SELECT * FROM vehicles WHERE plate_number = ?', [String(plate).trim()]);
    }

    // ─── Fleet Engine V1 ②: كتابة السجل المرجعي للمركبات (إضافة/تعديل) ───
    // لا حذف ولا تعطيل هنا إطلاقًا — السجل التشغيلي append-only ولا يُمس.
    async getCenters() {
        return this.db.all('SELECT id, name FROM centers WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
    }

    async createVehicle(data) {
        // المعرف مولّد ذاتيًا: veh_ + أعلى تسلسل موجود + 1 (عبر كل المركبات،
        // بما فيها غير النشطة، حتى لا يصطدم بالمفتاح الأساسي).
        const row = await this.db.get("SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS maxn FROM vehicles WHERE id LIKE 'veh_%'");
        const next = (row && row.maxn ? row.maxn : 0) + 1;
        const id = 'veh_' + String(next).padStart(6, '0');
        await this.db.run(
            `INSERT INTO vehicles
             (id, plate_number, call_sign, vehicle_type, model_year, category, designation, admin_status, owner_center_id, sort_order, is_active, created_at, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [id, data.plateNumber, data.callSign || null, data.vehicleType, data.modelYear,
             data.category, data.designation, data.adminStatus || 'أساسية',
             data.ownerCenterId || null, data.sortOrder || 0, new Date().toISOString(), data.notes || null]
        );
        return id;
    }

    async updateVehicle(id, fields) {
        // قائمة بيضاء صارمة — is_active والمعرف وcreated_at خارج التعديل دائمًا
        const allowed = ['plate_number', 'call_sign', 'vehicle_type', 'model_year', 'category',
            'designation', 'admin_status', 'owner_center_id', 'sort_order', 'notes'];
        const cols = Object.keys(fields).filter(k => allowed.includes(k));
        if (!cols.length) return false;
        const sql = `UPDATE vehicles SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`;
        await this.db.run(sql, [...cols.map(c => fields[c]), String(id)]);
        return true;
    }

    async getOperationalEventsByEntity(domain, entityId, limit = 500) {
        return this.db.all(
            'SELECT * FROM operational_events WHERE domain = ? AND entity_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
            [domain, entityId, limit]
        );
    }

    async getOperationalEventById(id) {
        return this.db.get('SELECT * FROM operational_events WHERE id = ?', [id]);
    }

    // اللقطات: تُكتب مرة واحدة (UNIQUE(shift_id, domain)) — إعادة الكتابة ممنوعة معماريًا
    async appendOperationalSnapshot(shiftId, domain, snapshotJson, eventsHash, createdAt) {
        const result = await this.db.run(
            `INSERT INTO operational_shift_snapshots (shift_id, domain, snapshot_json, events_hash, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [shiftId, domain, JSON.stringify(snapshotJson), eventsHash || null, createdAt]
        );
        return result.id;
    }

    async getOperationalSnapshot(shiftId, domain) {
        return this.db.get(
            'SELECT * FROM operational_shift_snapshots WHERE shift_id = ? AND domain = ?',
            [shiftId, domain]
        );
    }
}

module.exports = StorageAdapter;
