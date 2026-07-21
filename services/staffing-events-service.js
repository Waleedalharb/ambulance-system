/**
 * Staffing Events Service — المصدر الرسمي الوحيد لحالات القوى البشرية (W1-A)
 * ═══════════════════════════════════════════════════════════
 * واجهة نطاق staffing فوق السجل الموحّد operational_events.
 * القواعد: ختم سيرفري إلزامي (shift/actor/وقت من السيرفر)، append-only،
 * الإغلاق دلالي، التصحيح عبر correction (صلاحية + تدقيق — W1-E).
 * الكتابة الفعلية تُفعَّل في W1-B (ترجمة التكميل) — القراءات جاهزة الآن.
 */

const { isValidEventType, isReasonRequired, foldEvents, deriveIndicators } = require('./operational-events-core');

const DOMAIN = 'staffing';

class StaffingEventsService {
    /**
     * @param {Object} deps
     * @param {Object} deps.storage - StorageAdapter (البوابة الوحيدة)
     * @param {Object} deps.engine  - OperationsEngine (المناوبة النشطة + المعاملات)
     */
    constructor({ storage, engine }) {
        if (!storage) throw new Error('StaffingEventsService requires a StorageAdapter');
        if (!engine) throw new Error('StaffingEventsService requires an OperationsEngine');
        this.storage = storage;
        this.engine = engine;
    }

    /**
     * إلحاق حدث أفراد — الختم سيرفري دائمًا.
     * لا يُقبل shift_id/التاريخ/النوع/الفاعل/الوقت من العميل:
     * المناوبة من getActiveShift()، الفاعل من JWT، الوقت من السيرفر.
     */
    async appendEvent(input, actor) {
        if (!isValidEventType(DOMAIN, input.eventType)) {
            const err = new Error('نوع حدث غير صالح: ' + input.eventType);
            err.statusCode = 400;
            throw err;
        }
        if (isReasonRequired(DOMAIN, input.eventType, null) && !input.reason) {
            const err = new Error('السبب إلزامي لهذا النوع من الأحداث');
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
            eventType: input.eventType,
            reason: input.reason, readinessBasis: input.readinessBasis,
            correctsEventId: input.correctsEventId,
            payload: input.payload, note: input.note,
            actorId: String(actor.id), actorName: actor.name || actor.username,
            createdAt: new Date().toISOString()
        });
        return { success: true, eventId: id, shiftId: activeShift.id };
    }

    /** الحالة الحالية المشتقة لكل كيان في المناوبة (طيّ الأحداث). */
    async getState(shiftId) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        return { shiftId, domain: DOMAIN, entities: foldEvents(events, DOMAIN) };
    }

    /** الخط الزمني الكامل (أو لكيان واحد) — مرتب زمنيًا، لا حذف إطلاقًا. */
    async getTimeline(shiftId, entityId = null) {
        let events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        if (entityId) events = events.filter(e => e.entity_id === entityId);
        return { shiftId, domain: DOMAIN, entityId: entityId || null, events };
    }

    /** مؤشرات القوى البشرية — تُشتق هنا فقط ولا تُحسب في مكان آخر. */
    async getIndicators(shiftId) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        return { shiftId, ...deriveIndicators(events, DOMAIN) };
    }
}

module.exports = StaffingEventsService;
