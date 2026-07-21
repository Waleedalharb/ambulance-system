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

    /**
     * W1-B: ترجمة حفظ التكميل إلى أحداث تشغيلية (تُستدعى من CompletionService
     * داخل نفس معاملة الحفظ — لا معاملة خاصة هنا، ولا جلب للمناوبة:
     * الأختام تصل مُختومة سيرفريًا من المسار).
     *
     * قواعد الترجمة (حفريات الواجهة الحالية — لا تغيير عليها):
     *  - بصمة الفريق = (status|reason|missingPerson)؛ لا حدث إن لم تتغير
     *    عن آخر تكميل محفوظ «لنفس المناوبة» ⇒ لا تكرار مع الحفظ التلقائي.
     *  - pending = لم يُبتّ فيه ⇒ لا حدث.
     *  - ready   ⇒ حدث ready (readiness_basis=direct؛ الدعم يأتي في شرائح لاحقة).
     *  - missing ⇒ حدث missing + حدث شخصي (absence/late) عند سبب يستلزم اسمًا.
     *  - offline ⇒ حدث offline.
     *  - ready بعد missing بشخص معروف ⇒ حدث arrival لذلك الشخص (يُغلق غيابه/تأخيره).
     *
     * @returns {{ appended: number, events: Array }}
     */
    async appendCompletionEvents({ shiftId, shiftDate, shiftType, teams, previousTeams, actor, createdAt }) {
        const out = [];
        if (!shiftId || !teams || typeof teams !== 'object') return { appended: 0, events: out };
        const prev = (previousTeams && typeof previousTeams === 'object') ? previousTeams : {};
        const actorId = String((actor && actor.id) || 'system');
        const actorName = (actor && (actor.name || actor.username)) || 'system';
        const at = createdAt || new Date().toISOString();

        // أسباب الواجهة التي تستلزم اسمًا → نوع الحدث الشخصي
        const PERSON_REASON_MAP = { 'مسعف غائب': 'absence', 'مسعف متأخر': 'late' };

        for (const teamId of Object.keys(teams)) {
            const cur = teams[teamId] || {};
            const old = prev[teamId] || null;
            const sig = [cur.status || '', cur.reason || '', cur.missingPerson || ''].join('|');
            const oldSig = old ? [old.status || '', old.reason || '', old.missingPerson || ''].join('|') : null;
            if (sig === oldSig) continue; // لا تغيير ⇒ لا حدث (منع التكرار)
            const status = cur.status || 'pending';
            if (status === 'pending') continue; // لم يُبتّ فيه

            const base = {
                shiftId, shiftDate, shiftType, domain: DOMAIN,
                teamId, center: cur.centerName || null,
                actorId, actorName, createdAt: at,
                payload: {
                    source: 'completion',
                    prevStatus: old ? old.status || null : null,
                    prevReason: old ? old.reason || null : null,
                    prevMissingPerson: old ? old.missingPerson || null : null
                }
            };

            if (status === 'ready' || status === 'missing' || status === 'offline') {
                const id = await this.storage.appendOperationalEvent({
                    ...base,
                    eventType: status,
                    reason: cur.reason || null,
                    readinessBasis: status === 'ready' ? 'direct' : null
                });
                out.push({ id, eventType: status, teamId });
            }

            // حدث شخصي عند سبب يستلزم اسمًا واسم معروف (أفضل جهد موثق — R-6)
            const personEvent = PERSON_REASON_MAP[cur.reason];
            if (status === 'missing' && personEvent && cur.missingPerson) {
                const id = await this.storage.appendOperationalEvent({
                    ...base,
                    entityId: cur.missingPerson, entityName: cur.missingPerson,
                    eventType: personEvent, reason: cur.reason
                });
                out.push({ id, eventType: personEvent, entityId: cur.missingPerson, teamId });
            }

            // عودة الفريق جاهزًا بعد نقص بشخص معروف ⇒ وصول ذلك الشخص
            if (status === 'ready' && old && old.status === 'missing'
                && PERSON_REASON_MAP[old.reason] && old.missingPerson) {
                const id = await this.storage.appendOperationalEvent({
                    ...base,
                    entityId: old.missingPerson, entityName: old.missingPerson,
                    eventType: 'arrival'
                });
                out.push({ id, eventType: 'arrival', entityId: old.missingPerson, teamId });
            }
        }
        return { appended: out.length, events: out };
    }
}

module.exports = StaffingEventsService;
