/**
 * Vehicle Events Service — المصدر الرسمي الوحيد لحالات المركبات (W1-A)
 * ═══════════════════════════════════════════════════════════
 * واجهة نطاق vehicle فوق السجل الموحّد operational_events.
 * حالات المركبة: active | reserve | breakdown | out_of_service
 * (السبب إلزامي عند breakdown/out_of_service) + دخول/خروج الورشة.
 * الختم سيرفري إلزامي، append-only، تاريخ المركبة كاملًا محفوظ.
 */

const { isValidEventType, isReasonRequired, foldEvents, deriveIndicators, DOMAIN_REGISTRY } = require('./operational-events-core');

const DOMAIN = 'vehicle';

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

    /** الحالة الحالية المشتقة لكل مركبة (آخر حالة + تاريخ مفتوح). */
    async getState(shiftId) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        return { shiftId, domain: DOMAIN, entities: foldEvents(events, DOMAIN) };
    }

    /** تاريخ مركبة (أو كل المركبات) — كاملًا ومرتبًا، لا حذف إطلاقًا. */
    async getTimeline(shiftId, entityId = null) {
        let events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        if (entityId) events = events.filter(e => e.entity_id === entityId);
        return { shiftId, domain: DOMAIN, entityId: entityId || null, events };
    }

    /** مؤشرات المركبات (عاملة/احتياط/متعطلة/خارج الخدمة) — تُشتق هنا فقط. */
    async getIndicators(shiftId) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        return { shiftId, ...deriveIndicators(events, DOMAIN) };
    }
}

module.exports = VehicleEventsService;
