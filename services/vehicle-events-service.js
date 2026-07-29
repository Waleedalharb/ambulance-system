/**
 * Vehicle Events Service — المصدر الرسمي الوحيد لحالات المركبات (W1-A)
 * ═══════════════════════════════════════════════════════════
 * واجهة نطاق vehicle فوق السجل الموحّد operational_events.
 * حالات المركبة: active | reserve | breakdown | out_of_service
 * (السبب إلزامي عند breakdown/out_of_service) + دخول/خروج الورشة.
 * الختم سيرفري إلزامي، append-only، تاريخ المركبة كاملًا محفوظ.
 */

const { isValidEventType, isReasonRequired, foldEvents, deriveIndicators, DOMAIN_REGISTRY } = require('./operational-events-core');
const TimeRiyadh = require('../public/js/time-riyadh.js'); // الطبقة المركزية الوحيدة للوقت (TIME-POLICY) — حقول عرض فقط

const DOMAIN = 'vehicle';

// V-B ②: دعم المركبات — يُنمذج اليوم بأحداث نطاق center المعتمدة مسبقًا
// (supported/support_lifted — إغلاق دلالي جاهز، بلا أنواع جديدة بقرار المالك).
// معزول في ثوابت: اعتماد نوع مستقل لاحقًا = تعديل هذه الأسطر الثلاثة فقط.
const SUPPORT_DOMAIN = 'center';
const SUPPORT_OPEN = 'supported';
const SUPPORT_CLOSE = 'support_lifted';

class VehicleEventsService {
    constructor({ storage, engine }) {
        if (!storage) throw new Error('VehicleEventsService requires a StorageAdapter');
        if (!engine) throw new Error('VehicleEventsService requires an OperationsEngine');
        this.storage = storage;
        this.engine = engine;
    }

    /** إلحاق حدث مركبة — ختم سيرفري دائمًا (المناوبة/الفاعل/الوقت من السيرفر). */
    async appendEvent(input, actor) {
        if (!isValidEventType(DOMAIN, input.eventType)) {
            const err = new Error('نوع حدث غير صالح: ' + input.eventType);
            err.statusCode = 400;
            throw err;
        }
        if (input.eventType === 'status_change') {
            const valid = DOMAIN_REGISTRY.vehicle.statuses.includes(input.status);
            if (!valid) {
                const err = new Error('حالة مركبة غير صالحة: ' + input.status);
                err.statusCode = 400;
                throw err;
            }
        }
        if (isReasonRequired(DOMAIN, input.eventType, input.status) && !input.reason) {
            const err = new Error('سبب العطل/الإخراج إلزامي');
            err.statusCode = 400;
            throw err;
        }
        const activeShift = await this.engine.shifts.getActiveShift();
        if (!activeShift) {
            const err = new Error('لا توجد مناوبة نشطة - ابدأ مناوبة أولاً');
            err.statusCode = 400;
            throw err;
        }
        const id = await this.storage.appendOperationalEvent({
            shiftId: activeShift.id,
            shiftDate: activeShift.shift_date,
            shiftType: activeShift.shift_type,
            domain: DOMAIN,
            entityId: input.entityId, entityName: input.entityName,
            teamId: input.teamId, center: input.center,
            eventType: input.eventType, status: input.status,
            reason: input.reason, payload: input.payload, note: input.note,
            actorId: String(actor.id), actorName: actor.name || actor.username,
            createdAt: new Date().toISOString()
        });
        return { success: true, eventId: id, shiftId: activeShift.id };
    }

    // ─── V-B ①: خدمة التعيين التفاعلية + التبديل الذري (C28) ───
    // تعيين المركبات للفرق ونقلها بينها عبر أحداث assignment/assignment_end
    // فقط (append-only). التحقق الكامل قبل أي كتابة (القرار لا يسبق البيانات)،
    // والتبديل = إغلاق القديم + فتح الجديد في معاملة واحدة (commit واحد).
    // idempotency تشغيلية: تعيين مكرر لنفس الفريق يُتخطى، وإنهاء بلا تعيين
    // مفتوح يُتخطى — لا تكرار ولا أحداث فارغة في السجل.

    /** مركبة موجودة في السجل المرجعي وإلا 404. */
    async _requireVehicle(vehicleId) {
        const vehicle = await this.storage.getVehicleById(vehicleId);
        if (!vehicle) {
            const err = new Error('مركبة غير موجودة في السجل');
            err.statusCode = 404;
            throw err;
        }
        return vehicle;
    }

    /** فريق موجود (المعرف الرقمي teams.id — نفس صيغة أحداث الافتتاح) وإلا 400. */
    async _requireTeam(teamId) {
        const id = parseInt(teamId, 10);
        if (isNaN(id)) {
            const err = new Error('معرف فريق غير صالح');
            err.statusCode = 400;
            throw err;
        }
        const team = await this.storage.get('SELECT * FROM teams WHERE id = ? AND is_active = 1', [id]);
        if (!team) {
            const err = new Error('فريق غير موجود');
            err.statusCode = 400;
            throw err;
        }
        return team;
    }

    /** مناوبة نشطة (الختم سيرفري دائمًا) وإلا 400. */
    async _requireActiveShift() {
        const activeShift = await this.engine.shifts.getActiveShift();
        if (!activeShift) {
            const err = new Error('لا توجد مناوبة نشطة - ابدأ مناوبة أولاً');
            err.statusCode = 400;
            throw err;
        }
        return activeShift;
    }

    /** آخر تعيين مفتوح للمركبة عبر كامل خطها الزمني (Asset Timeline — ليست محصورة بالمناوبة). */
    async _openAssignment(vehicleId) {
        const events = await this.storage.getOperationalEventsByEntity(DOMAIN, vehicleId);
        const f = foldEvents(events, DOMAIN)[0] || null;
        if (!f) return null;
        return [...f.open].reverse().find(o => o.event_type === 'assignment') || null;
    }

    /** إلحاق حدث تعيين/إنهاء مختوم سيرفريًا (المناوبة/الفاعل/الوقت من السيرفر). */
    async _appendAssignmentEvent({ shift, vehicle, teamId, center, eventType, note, actor }) {
        return this.storage.appendOperationalEvent({
            shiftId: shift.id, shiftDate: shift.shift_date, shiftType: shift.shift_type,
            domain: DOMAIN,
            entityId: vehicle.id, entityName: vehicle.call_sign || vehicle.plate_number,
            teamId: teamId != null ? String(teamId) : null, center: center || null,
            eventType, note: note || null,
            payload: { source: 'vehicle-assignment-vb' },
            actorId: String(actor.id), actorName: actor.name || actor.username,
            createdAt: new Date().toISOString()
        });
    }

    /**
     * تعيين مركبة لفريق. يُرفض إن كانت معيّنة لفريق آخر (استخدم التبديل الذري)،
     * ويُتخطى إن كانت معيّنة لنفس الفريق (idempotent).
     */
    async assignVehicle({ vehicleId, teamId, note }, actor) {
        if (!vehicleId || teamId == null || teamId === '') {
            const err = new Error('بيانات ناقصة: المركبة والفريق إلزاميان');
            err.statusCode = 400;
            throw err;
        }
        // التحقق الكامل قبل أي كتابة
        const vehicle = await this._requireVehicle(vehicleId);
        const team = await this._requireTeam(teamId);
        const shift = await this._requireActiveShift();
        const open = await this._openAssignment(vehicle.id);
        if (open && String(open.team_id) === String(team.id)) {
            return { success: true, appended: 0, skipped: 'already-assigned', shiftId: shift.id, vehicleId: vehicle.id, teamId: team.id };
        }
        if (open) {
            const err = new Error('المركبة معيّنة لفريق آخر — استخدم التبديل الذري');
            err.statusCode = 400;
            throw err;
        }
        const eventId = await this._appendAssignmentEvent({
            shift, vehicle, teamId: team.id, center: team.center, eventType: 'assignment', note, actor
        });
        return { success: true, appended: 1, eventId, shiftId: shift.id, vehicleId: vehicle.id, teamId: team.id };
    }

    /** إنهاء تعيين مركبة (إغلاق دلالي لآخر assignment مفتوح). بلا مفتوح = يُتخطى. */
    async endVehicleAssignment({ vehicleId, note }, actor) {
        if (!vehicleId) {
            const err = new Error('بيانات ناقصة: المركبة إلزامية');
            err.statusCode = 400;
            throw err;
        }
        const vehicle = await this._requireVehicle(vehicleId);
        const shift = await this._requireActiveShift();
        const open = await this._openAssignment(vehicle.id);
        if (!open) {
            return { success: true, appended: 0, skipped: 'no-open-assignment', shiftId: shift.id, vehicleId: vehicle.id };
        }
        const eventId = await this._appendAssignmentEvent({
            shift, vehicle, teamId: open.team_id, center: open.center, eventType: 'assignment_end', note, actor
        });
        return { success: true, appended: 1, eventId, shiftId: shift.id, vehicleId: vehicle.id, teamId: open.team_id != null ? Number(open.team_id) : null };
    }

    /**
     * التبديل الذري (نقل مركبة بين الفرق — C28): إغلاق التعيين الحالي (إن وُجد)
     * + فتح تعيين جديد في معاملة واحدة — commit واحد أو لا شيء.
     */
    async switchVehicleAssignment({ vehicleId, teamId, note }, actor) {
        if (!vehicleId || teamId == null || teamId === '') {
            const err = new Error('بيانات ناقصة: المركبة والفريق إلزاميان');
            err.statusCode = 400;
            throw err;
        }
        // التحقق الكامل قبل أي كتابة
        const vehicle = await this._requireVehicle(vehicleId);
        const team = await this._requireTeam(teamId);
        const shift = await this._requireActiveShift();
        return this.engine.runInTransaction(async () => {
            const open = await this._openAssignment(vehicle.id);
            if (open && String(open.team_id) === String(team.id)) {
                return { success: true, appended: 0, skipped: 'already-assigned', shiftId: shift.id, vehicleId: vehicle.id, teamId: team.id };
            }
            let appended = 0;
            let endEventId = null;
            if (open) {
                endEventId = await this._appendAssignmentEvent({
                    shift, vehicle, teamId: open.team_id, center: open.center, eventType: 'assignment_end', note, actor
                });
                appended++;
            }
            const eventId = await this._appendAssignmentEvent({
                shift, vehicle, teamId: team.id, center: team.center, eventType: 'assignment', note, actor
            });
            appended++;
            return { success: true, appended, endEventId, eventId, shiftId: shift.id, vehicleId: vehicle.id, teamId: team.id };
        });
    }

    // ─── V-B ②: دعم المركبات — المركبة تبقى مرتبطة بفريقها الأصلي دائمًا ───
    // الدعم مؤقت وموثق (بقرار المالك: سيناريو «أ» + يدخل في جاهزية المدعوم).
    // لا يُمس تعيين الفريق الأصلي؛ الدعم حدث مستقل بإغلاق دلالي.

    /** الدعم المفتوح حاليًا لمركبة (عبر كامل خطها الزمني) أو null. */
    async _openSupport(vehicleId) {
        const events = await this.storage.getOperationalEventsByEntity(SUPPORT_DOMAIN, vehicleId);
        let open = null;
        for (const e of events) {
            if (e.event_type === SUPPORT_OPEN) { if (!open) open = e; }
            else if (e.event_type === SUPPORT_CLOSE) { if (open) open = null; }
        }
        return open;
    }

    /** آخر حالة تشغيلية للمركبة من سجلها (نفس اشتقاق getBoard — آخر status يحكم). */
    async _lastVehicleStatus(vehicleId) {
        const events = await this.storage.getOperationalEventsByEntity(DOMAIN, vehicleId);
        const f = foldEvents(events, DOMAIN)[0] || null;
        const last = f ? [...f.open].reverse().find(o => o.status) : null;
        return last ? last.status : null;
    }

    /** إلحاق حدث دعم مختوم سيرفريًا (الكيان = المركبة، الفريق = المدعوم). */
    async _appendSupportEvent({ shift, vehicle, teamId, center, eventType, note, actor, homeTeamId }) {
        const payload = { source: 'vehicle-support-vb', kind: 'vehicle_support' };
        if (homeTeamId != null) payload.homeTeamId = String(homeTeamId);
        return this.storage.appendOperationalEvent({
            shiftId: shift.id, shiftDate: shift.shift_date, shiftType: shift.shift_type,
            domain: SUPPORT_DOMAIN,
            entityId: vehicle.id, entityName: vehicle.call_sign || vehicle.plate_number,
            teamId: teamId != null ? String(teamId) : null, center: center || null,
            eventType, note: note || null, payload,
            actorId: String(actor.id), actorName: actor.name || actor.username,
            createdAt: new Date().toISOString()
        });
    }

    /**
     * إرسال مركبة دعمًا لفريق آخر. يشترط تعيينًا أصليًا مفتوحًا (المركبة تذهب
     * من فريقها)، ويُرفض الدعم لفريقها الأصلي أو أثناء دعم مفتوح لفريق آخر.
     */
    async supportVehicle({ vehicleId, targetTeamId, note }, actor) {
        if (!vehicleId || targetTeamId == null || targetTeamId === '') {
            const err = new Error('بيانات ناقصة: المركبة والفريق المدعوم إلزاميان');
            err.statusCode = 400;
            throw err;
        }
        // التحقق الكامل قبل أي كتابة
        const vehicle = await this._requireVehicle(vehicleId);
        const team = await this._requireTeam(targetTeamId);
        const shift = await this._requireActiveShift();
        const home = await this._openAssignment(vehicle.id);
        if (!home) {
            const err = new Error('المركبة غير معيّنة لفريق أصلي — عيّنها أولاً');
            err.statusCode = 400;
            throw err;
        }
        // بند 14 (بقرار المالك): لا حالة مستحيلة — لا دعم بمركبة خارج الخدمة أو متعطلة
        const vehStatus = await this._lastVehicleStatus(vehicle.id);
        if (vehStatus === 'out_of_service' || vehStatus === 'breakdown') {
            const err = new Error('لا يمكن إرسال مركبة خارج الخدمة أو متعطلة للدعم');
            err.statusCode = 400;
            throw err;
        }
        if (String(home.team_id) === String(team.id)) {
            const err = new Error('المركبة معيّنة لهذا الفريق أصلًا — لا حاجة للدعم');
            err.statusCode = 400;
            throw err;
        }
        const openSupport = await this._openSupport(vehicle.id);
        if (openSupport && String(openSupport.team_id) === String(team.id)) {
            return { success: true, appended: 0, skipped: 'already-supporting', shiftId: shift.id, vehicleId: vehicle.id, teamId: team.id };
        }
        if (openSupport) {
            const err = new Error('المركبة تدعم فريقًا آخر حاليًا — أنهِ الدعم الحالي أولاً');
            err.statusCode = 400;
            throw err;
        }
        const eventId = await this._appendSupportEvent({
            shift, vehicle, teamId: team.id, center: team.center, eventType: SUPPORT_OPEN, note, actor, homeTeamId: home.team_id
        });
        return { success: true, appended: 1, eventId, shiftId: shift.id, vehicleId: vehicle.id, teamId: team.id, homeTeamId: Number(home.team_id) };
    }

    /** إنهاء دعم مركبة (إغلاق دلالي). بلا دعم مفتوح = يُتخطى (idempotent). */
    async endVehicleSupport({ vehicleId, note }, actor) {
        if (!vehicleId) {
            const err = new Error('بيانات ناقصة: المركبة إلزامية');
            err.statusCode = 400;
            throw err;
        }
        const vehicle = await this._requireVehicle(vehicleId);
        const shift = await this._requireActiveShift();
        const openSupport = await this._openSupport(vehicle.id);
        if (!openSupport) {
            return { success: true, appended: 0, skipped: 'no-open-support', shiftId: shift.id, vehicleId: vehicle.id };
        }
        const eventId = await this._appendSupportEvent({
            shift, vehicle, teamId: openSupport.team_id, center: openSupport.center, eventType: SUPPORT_CLOSE, note, actor
        });
        return { success: true, appended: 1, eventId, shiftId: shift.id, vehicleId: vehicle.id, teamId: openSupport.team_id != null ? Number(openSupport.team_id) : null };
    }

    /** الحالة الحالية المشتقة لكل مركبة (آخر حالة + تاريخ مفتوح). */
    async getState(shiftId) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        return { shiftId, domain: DOMAIN, entities: foldEvents(events, DOMAIN) };
    }

    /** تاريخ مركبة (أو كل المركبات) — كاملًا ومرتبًا، لا حذف إطلاقًا.
     *  V-B ②: أحداث الدعم تُدمج في خط المركبة الزمني (الكيان يربطها بالمركبة). */
    async getTimeline(shiftId, entityId = null) {
        let events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        if (entityId) events = events.filter(e => e.entity_id === entityId);
        const supportEvents = entityId
            ? await this.storage.getOperationalEventsByEntity(SUPPORT_DOMAIN, entityId)
            : await this.storage.getOperationalEventsByShift(shiftId, SUPPORT_DOMAIN);
        events = events.concat(supportEvents)
            .sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : (a.created_at < b.created_at ? -1 : 1)));
        return { shiftId, domain: DOMAIN, entityId: entityId || null, events };
    }

    /** مؤشرات المركبات (عاملة/احتياط/متعطلة/خارج الخدمة) — تُشتق هنا فقط. */
    async getIndicators(shiftId) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        return { shiftId, ...deriveIndicators(events, DOMAIN) };
    }

    /** Fleet Engine V1 ①: تاريخ مركبة عبر كل المناوبات (Asset Timeline كامل) —
     *  قراءة فقط، بلا ختم مناوبة. يدمج أحداث نطاق المركبة + أحداث الدعم
     *  (نطاق center بكيان المركبة) مرتبة زمنيًا تصاعديًا، مع الحالة الحالية
     *  المشتقة (نفس اشتقاق getBoard حرفيًا) وأسماء الفرق وحقول عرض الرياض
     *  (TIME-POLICY — عرض فقط، لا تُقارن ولا تُخزن). */
    async getVehicleHistory(vehicleId) {
        const vehicle = await this._requireVehicle(vehicleId);
        const events = await this.storage.getOperationalEventsByEntity(DOMAIN, vehicle.id, 1000);
        const supportEvents = await this.storage.getOperationalEventsByEntity(SUPPORT_DOMAIN, vehicle.id, 1000);
        const merged = events.concat(supportEvents)
            .sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : (a.created_at < b.created_at ? -1 : 1)));
        const teams = await this.storage.all('SELECT id, name FROM teams');
        const teamNameById = new Map(teams.map(t => [String(t.id), t.name]));
        // الحالة الحالية — اشتقاق مطابق لـ getBoard: آخر حالة + آخر تعيين مفتوح
        const f = foldEvents(events, DOMAIN)[0] || null;
        const openAssignment = f ? [...f.open].reverse().find(o => o.event_type === 'assignment') : null;
        const lastStatus = f ? [...f.open].reverse().find(o => o.status) : null;
        return {
            vehicle: {
                id: vehicle.id,
                name: vehicle.call_sign || vehicle.plate_number,
                plateNumber: vehicle.plate_number,
                callSign: vehicle.call_sign || null,
                vehicleType: vehicle.vehicle_type,
                modelYear: vehicle.model_year,
                category: vehicle.category,
                designation: vehicle.designation,
                adminStatus: vehicle.admin_status,
                homeCenterId: vehicle.owner_center_id || null,
                notes: vehicle.notes != null ? vehicle.notes : null
            },
            current: {
                status: lastStatus ? lastStatus.status : null,
                reason: lastStatus ? lastStatus.reason || null : null,
                since: lastStatus ? lastStatus.created_at : null,
                teamId: openAssignment && openAssignment.team_id != null ? Number(openAssignment.team_id) : null,
                teamName: openAssignment ? (teamNameById.get(String(openAssignment.team_id)) || null) : null
            },
            events: merged.map(e => ({
                id: e.id,
                domain: e.domain,
                eventType: e.event_type,
                status: e.status || null,
                reason: e.reason || null,
                note: e.note || null,
                teamId: e.team_id != null ? Number(e.team_id) : null,
                teamName: e.team_id != null ? (teamNameById.get(String(e.team_id)) || null) : null,
                center: e.center || null,
                shiftId: e.shift_id != null ? Number(e.shift_id) : null,
                shiftDate: e.shift_date || null,
                shiftType: e.shift_type || null,
                actorName: e.actor_name || null,
                createdAt: e.created_at,
                createdAtRiyadh: TimeRiyadh.formatDateTimeSec(e.created_at) // عرض فقط (TIME-POLICY)
            }))
        };
    }

    /**
     * لوحة المركبات — السجل المرجعي (هوية ثابتة) + الحالة المشتقة من
     * operational_events فقط. لا يُحفظ أي وضع حالي في أي جدول (SSOT).
     * V-A (v9 + قرار المالك 1): صفر تغيير مرئي — تُعرض المركبات المعيّنة فقط
     * (آخر assignment مفتوح = teamId)، وغير المعيّنة (احتياط/أوفر لاب/صيانة)
     * لا تظهر حتى V-B/V-D. الحالة تُشتق عبر كامل خط المركبة الزمني
     * (Asset Timeline — ليست محصورة بالمناوبة).
     */
    async getBoard(shiftId) {
        const registry = await this.storage.getVehicles();
        const counters = { active: 0, reserve: 0, breakdown: 0, out_of_service: 0, unset: 0 };
        const vehicles = [];
        const unassigned = [];
        // V-B ②: الدعم المفتوح لكل المركبات (دفعة واحدة — supported يفتح / support_lifted يغلق)
        const supportRows = await this.storage.all(
            `SELECT entity_id, team_id, event_type, created_at FROM operational_events
             WHERE domain = ? AND event_type IN (?, ?) ORDER BY created_at ASC, id ASC`,
            [SUPPORT_DOMAIN, SUPPORT_OPEN, SUPPORT_CLOSE]
        );
        const openSupportByVeh = {};
        for (const e of supportRows) {
            if (e.event_type === SUPPORT_OPEN) openSupportByVeh[e.entity_id] = e;
            else delete openSupportByVeh[e.entity_id];
        }
        const homeByVeh = {};
        for (const v of registry) {
            const events = await this.storage.getOperationalEventsByEntity(DOMAIN, v.id);
            const f = foldEvents(events, DOMAIN)[0] || null;
            const openAssignment = f ? [...f.open].reverse().find(o => o.event_type === 'assignment') : null;
            const lastStatus = f ? [...f.open].reverse().find(o => o.status) : null;
            const status = lastStatus ? lastStatus.status : null;
            const base = {
                id: v.id,
                name: v.call_sign || v.plate_number,
                status,
                reason: lastStatus ? lastStatus.reason || null : null,
                since: lastStatus ? lastStatus.created_at : null,
                inWorkshop: f ? f.open.some(o => o.event_type === 'workshop_in') : false
            };
            if (!openAssignment) { unassigned.push(base); continue; } // غير معيّنة — قائمة مستقلة (V-B ①)
            counters[status || 'unset']++;
            homeByVeh[v.id] = openAssignment.team_id;
            const openSupport = openSupportByVeh[v.id] || null;
            vehicles.push({
                ...base,
                teamId: openAssignment.team_id != null ? Number(openAssignment.team_id) : null,
                supportingTeamId: openSupport && openSupport.team_id != null ? Number(openSupport.team_id) : null
            });
        }
        // V-B ②: قائمة الدعم المفتوح — اشتقاق سيرفري (مركبة/فريق أصلي/فريق مدعوم/منذ)
        const support = Object.keys(openSupportByVeh).map(vehId => {
            const v = registry.find(r => r.id === vehId);
            const s = openSupportByVeh[vehId];
            return {
                vehicleId: vehId,
                name: v ? (v.call_sign || v.plate_number) : vehId,
                homeTeamId: homeByVeh[vehId] != null ? Number(homeByVeh[vehId]) : null,
                targetTeamId: s.team_id != null ? Number(s.team_id) : null,
                since: s.created_at
            };
        });
        // V-B ①: unassigned — اشتقاق سيرفري لغير المعيّنة (احتياط/أوفر لاب/صيانة)
        // لتغذية سير عمل التعيين في الواجهة. vehicles/counters بلا أي تغيير (Parity V-A).
        return { shiftId: shiftId || null, counters, vehicles, unassigned, support };
    }
}

module.exports = VehicleEventsService;