/**
 * Operational Events Core — رزنامة النطاقات ومنطق الطيّ المشترك (W1-A)
 * ═══════════════════════════════════════════════════════════
 * كل قواعد الأنواع/الإغلاق/الاشتقاق معلنة هنا (لا مبعثرة في المسارات):
 * إضافة نطاق جديد مستقبلًا = إدخال تعريفي في DOMAIN_REGISTRY فقط.
 *
 * append-only: لا يوجد هنا أي منطق تعديل أو حذف — الإغلاق دلالي
 * (حدث إغلاق يطابق حدث فتح لنفس الكيان)، والتصحيح عبر correction.
 */

// ─── رزنامة النطاقات (Domain Registry) ───
const DOMAIN_REGISTRY = {
    staffing: {
        eventTypes: [
            'absence', 'late', 'arrival', 'exit', 'return',
            'assignment', 'overlap', 'external_support', 'volunteer_support', 'support_end',
            'activation', 'activation_end',
            'ready', 'missing', 'offline', 'note', 'correction'
        ],
        // حدث الإغلاق ← أنواع الفتح التي يغلقها (لنفس entity_id)
        closureRules: {
            arrival: ['absence', 'late'],
            return: ['exit'],
            support_end: ['external_support', 'volunteer_support'],
            // مرحلة الأوفرلاب 4 (التفعيل): إنهاء التفعيل يُغلق دلاليًا التفعيل المفتوح
            activation_end: ['activation'],
            // W1-B: عودة الفريق «جاهزًا» تُغلق دلاليًا نقصه/خروجه من الخدمة
            ready: ['missing', 'offline']
        },
        reasonRequired: ['absence', 'late', 'missing'],
        readinessBases: ['direct', 'external_support', 'volunteer', 'overlap', 'temporary_assignment'],
        // أنواع الفتح التي تجعل الكيان «غير حاضر» إن بقيت مفتوحة
        openStates: ['absence', 'late', 'exit', 'assignment', 'overlap', 'external_support', 'volunteer_support']
    },
    vehicle: {
        // V-A (v9): توسعة تعريفية فقط — التعيين/دورة الحياة/الصيانة/العدادات/السمات.
        // لا خدمات ولا مسارات جديدة هنا (تلك في V-B)؛ الأنواع تُقبل في السجل من الآن.
        eventTypes: [
            'status_change', 'workshop_in', 'workshop_out', 'note', 'correction',
            'assignment', 'assignment_end',
            'maintenance_requested', 'maintenance_record', 'odometer_log',
            'asset_metadata_updated',
            'acquired', 'received', 'entered_service',
            'ownership_transfer', 'decommissioned', 'scrapped'
        ],
        statuses: ['active', 'reserve', 'breakdown', 'out_of_service'],
        closureRules: {
            workshop_out: ['workshop_in'],
            assignment_end: ['assignment']
        },
        reasonRequiredStatuses: ['breakdown', 'out_of_service']
    },
    center: { eventTypes: ['supported', 'support_lifted', 'note', 'correction'], closureRules: { support_lifted: ['supported'] } },
    logistics: { eventTypes: ['item_status', 'note', 'correction'], closureRules: {} }
};

function isValidEventType(domain, eventType) {
    const d = DOMAIN_REGISTRY[domain];
    return !!d && d.eventTypes.includes(eventType);
}

function isReasonRequired(domain, eventType, status) {
    const d = DOMAIN_REGISTRY[domain];
    if (!d) return false;
    if (domain === 'vehicle') return (d.reasonRequiredStatuses || []).includes(status);
    return (d.reasonRequired || []).includes(eventType);
}

/**
 * طيّ أحداث مناوبة لنطاق واحد ⇒ الحالة الحالية لكل كيان.
 * المخرجات لكل كيان: { entityId, entityName, teamId, center, open: [أحداث فتح غير مغلقة],
 * lastEvent, closedCount } — والإغلاق يطابق أقدم حدث فتح مفتوح من نوع مطابق.
 */
function foldEvents(events, domain) {
    const d = DOMAIN_REGISTRY[domain] || { closureRules: {} };
    const byEntity = new Map();

    for (const e of events) {
        if (e.domain !== domain) continue;
        const key = e.entity_id || '(team:' + (e.team_id || '') + ')';
        if (!byEntity.has(key)) {
            byEntity.set(key, {
                entityId: e.entity_id, entityName: e.entity_name,
                teamId: e.team_id, center: e.center,
                open: [], lastEvent: null, closedCount: 0, corrections: 0
            });
        }
        const st = byEntity.get(key);
        st.lastEvent = e;
        if (e.entity_name) st.entityName = e.entity_name;
        if (e.team_id) st.teamId = e.team_id;
        if (e.center) st.center = e.center;

        if (e.event_type === 'correction') { st.corrections++; continue; }
        if (e.event_type === 'note') continue;

        const closes = d.closureRules[e.event_type];
        if (closes) {
            // أغلق أقدم حدث مفتوح من الأنواع المطابقة (دلاليًا — الأحداث نفسها لا تُمس)
            const idx = st.open.findIndex(o => closes.includes(o.event_type));
            if (idx >= 0) {
                const opened = st.open.splice(idx, 1)[0];
                st.closedCount++;
                // مدة مشتقة (لا تُخزن): الفرق بين الفتح والإغلاق
                opened.closedBy = { id: e.id, type: e.event_type, at: e.created_at };
                opened.durationMs = Date.parse(e.created_at) - Date.parse(opened.created_at);
                (st.closedPairs = st.closedPairs || []).push(opened);
            }
            continue;
        }
        // حدث فتح/حالة
        st.open.push(e);
    }
    return Array.from(byEntity.values());
}

/** المؤشرات المشتقة من الطيّ — لا تُحسب في أي مكان آخر. */
function deriveIndicators(events, domain) {
    const folded = foldEvents(events, domain);
    const openByType = {};
    const totalByType = {};
    let openEntities = 0;

    for (const e of events) {
        if (e.domain !== domain || e.event_type === 'correction') continue;
        totalByType[e.event_type] = (totalByType[e.event_type] || 0) + 1;
    }
    for (const st of folded) {
        if (st.open.length) openEntities++;
        for (const o of st.open) openByType[o.event_type] = (openByType[o.event_type] || 0) + 1;
    }

    const result = { domain, entities: folded.length, entitiesWithOpenState: openEntities, openByType, totalByType };
    if (domain === 'vehicle') {
        // الحالة الحالية لكل مركبة = آخر status مشتق
        const byStatus = { active: 0, reserve: 0, breakdown: 0, out_of_service: 0, unknown: 0 };
        for (const st of folded) {
            const lastStatusEvent = [...st.open].reverse().find(o => o.status) ||
                (st.lastEvent && st.lastEvent.status ? st.lastEvent : null);
            byStatus[lastStatusEvent ? lastStatusEvent.status : 'unknown']++;
        }
        result.vehiclesByStatus = byStatus;
    }
    return result;
}

module.exports = { DOMAIN_REGISTRY, isValidEventType, isReasonRequired, foldEvents, deriveIndicators };
