/**
 * Smart Awareness Service — الجهاز العصبي للمشغل الذكي (المرحلة 6-ج)
 * ═══════════════════════════════════════════════════════════
 * ليست تحديثات لحظية ولا نظام تنبيهات — جهاز عصبي:
 *   لا يُبثّ إلا عندما يتغيّر «المعنى التشغيلي» (ظهور/زوال خطر، انقلاب
 *   شدة، تغيّر توصية، انتقال مرحلة مناوبة، انقلاب حالة الجاهزية).
 *
 * قانون الزناد: بصمة ذاكرة القرار هي الزناد الوحيد.
 *   append.reason === 'fingerprint-change'  ⇒ بثّ واحد.
 *   'heartbeat' / 'dedup'                    ⇒ صمت تام.
 * تغيّر واحد = حدث واحد. دفعة أحداث متلاحقة = دورة تقييم واحدة (debounce).
 *
 * مسار واحد لرؤية العالم: buildSnapshot مُحقونة (نفس تجميعة مسار HTTP)،
 * يستخدمها المستمع والمسار معًا — لا توجد طريقتان لقراءة المنصة.
 *
 * الحمولة ذكاء تشغيلي فقط: بلا HTML، بلا ألوان، بلا أيقونات، بلا عدادات
 * قراءة/عدم قراءة، بلا أي حالة عميل. الفروق تُحسب من سجلات الذاكرة
 * (بصمات المحتوى، لا النثر الوصفي).
 */

const DEFAULT_DEBOUNCE_MS = 3000; // 3 ثوانٍ — دمج دفعات الأحداث (حفظ تكميل قد يطلق عدة أحداث)

// موضوعات ناقل المحرك المؤثرة في اللقطة (قوى بشرية/تكميل/دورة حياة مناوبة)
const BUS_TOPICS = Object.freeze([
    'CompletionUpdated',        // completion-service.js (حفظ تكميل/أشخاص)
    'CenterStatusChanged',      // انقلاب مكتمل/ناقص لفريق
    'StaffingEventsAppended',   // أحداث قوى بشرية جديدة
    'ShiftStarted', 'ShiftUpdated', 'ShiftEnded', 'ShiftArchived' // دورة حياة المناوبة
]);

// أنواع SSE القديمة المؤثرة التي لا تعبر ناقل المحرك (تُبث من المسارات مباشرة):
// vehicles_updated (أحداث/تعيين/دعم مركبات — server.js:4767-4981)
// shift_roster_updated (الجدولة تغيّر اشتقاق الكادر — server.js:8031-8073)
const LEGACY_WAKE_TYPES = Object.freeze(['vehicles_updated', 'shift_roster_updated']);

const EVENT_TYPE = 'smart_operator_update';

// مفتاح الخطر للمقارنة: الرمز + الفريق (فريقان مختلفان بنفس الرمز = خطران)
function riskKey(r) {
    return (r && r.code ? r.code : '') + '|' + (r && r.team ? r.team : '');
}

function recSignature(recs) {
    return JSON.stringify((Array.isArray(recs) ? recs : []).map(r => [r.code || null, r.target || null]));
}

/**
 * بناء حمولة الوعي من سجلَّي الذاكرة (السابق/الجديد) — فروق المحتوى فقط،
 * وتُدرج فقط الفئات التي حدثت فعلًا (الفئات الفارغة تُحذف).
 */
function buildAwarenessPayload(previous, record) {
    const prevRisks = previous && Array.isArray(previous.risks) ? previous.risks : [];
    const newRisks = Array.isArray(record.risks) ? record.risks : [];
    const prevByKey = new Map(prevRisks.map(r => [riskKey(r), r]));
    const newByKey = new Map(newRisks.map(r => [riskKey(r), r]));

    const risksRaised = [];
    const risksResolved = [];
    const severityChanges = [];
    for (const [k, r] of newByKey) {
        const o = prevByKey.get(k);
        const base = { code: r.code, severity: r.severity };
        if (r.team) base.team = r.team;
        if (!o) risksRaised.push({ ...base, title: r.title });
        else if (o.severity !== r.severity) severityChanges.push({ code: r.code, ...(r.team ? { team: r.team } : {}), from: o.severity, to: r.severity });
    }
    for (const [k, r] of prevByKey) {
        if (newByKey.has(k)) continue;
        risksResolved.push({ code: r.code, ...(r.team ? { team: r.team } : {}), title: r.title });
    }

    const changes = {};
    if (risksRaised.length) changes.risksRaised = risksRaised;
    if (risksResolved.length) changes.risksResolved = risksResolved;
    if (severityChanges.length) changes.severityChanges = severityChanges;
    const prevPhase = previous ? previous.shiftPhase : null;
    if (prevPhase !== record.shiftPhase) changes.phaseChange = { from: prevPhase, to: record.shiftPhase };
    const prevRecs = previous ? previous.recommendations : [];
    if (recSignature(prevRecs) !== recSignature(record.recommendations)) changes.recommendationChanged = true;

    const readiness = {
        percent: record.readiness ? record.readiness.percent : null,
        status: record.readiness ? record.readiness.status : null
    };
    const prevStatus = previous && previous.readiness ? previous.readiness.status : null;
    if (prevStatus !== readiness.status) readiness.previousStatus = prevStatus;

    return {
        type: EVENT_TYPE,
        at: record.recordedAt,
        shiftId: record.shiftId,
        shiftPhase: record.shiftPhase,
        readiness,
        changes,
        summary: record.summary
    };
}

class SmartAwarenessService {
    /**
     * @param {Object} deps
     * @param {Object} deps.engine        - decisionEngine (assess — منطق معتمد، يُستورد فقط)
     * @param {Object} deps.memory        - DecisionMemoryService (البصمة = الزناد)
     * @param {Function} deps.buildSnapshot - async () => snapshot — نفس تجميعة مسار HTTP
     * @param {Function} deps.broadcast   - broadcast(data) القائمة (قناة SSE الواحدة)
     * @param {number} [deps.debounceMs]  - تجاوز مدة الدمج (اختبارات/ضبط)
     */
    constructor({ engine, memory, buildSnapshot, broadcast, debounceMs } = {}) {
        if (!engine) throw new Error('SmartAwarenessService requires the decision engine');
        if (!memory) throw new Error('SmartAwarenessService requires a DecisionMemoryService');
        if (typeof buildSnapshot !== 'function') throw new Error('SmartAwarenessService requires a buildSnapshot function');
        if (typeof broadcast !== 'function') throw new Error('SmartAwarenessService requires a broadcast function');
        this.engine = engine;
        this.memory = memory;
        this.buildSnapshot = buildSnapshot;
        this.broadcast = broadcast;
        this.debounceMs = debounceMs || DEFAULT_DEBOUNCE_MS;
        this._timer = null;
    }

    /** اشتراك في نبض المنصة — ناقل المحرك (idempotent). */
    subscribe(bus) {
        if (!bus || this._subscribed) return;
        this._subscribed = true;
        for (const topic of BUS_TOPICS) bus.on(topic, () => this.notify(topic));
    }

    /** إيقاظ من أنواع SSE القديمة المؤثرة التي لا تعبر ناقل المحرك. */
    notifyLegacyBroadcast(data) {
        if (data && LEGACY_WAKE_TYPES.indexOf(data.type) !== -1) this.notify(data.type);
    }

    /**
     * إيقاظ مدمج (trailing debounce): دفعة أحداث = دورة تقييم واحدة.
     * الدورة fire-and-forget — لا تُبطئ مسار الكتابة التشغيلي إطلاقًا.
     */
    notify(source) {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this._timer = null;
            this._runCycle(source); // بلا await — عزل كامل داخل الدورة
        }, this.debounceMs);
    }

    /** دورة وعي: لقطة ← تقييم ← ذاكرة ← (بصمة متغيرة فقط) بث. فشلها لا يكسر أحدًا. */
    async _runCycle(source) {
        try {
            const snapshot = await this.buildSnapshot();
            const assessment = this.engine.assess(snapshot);
            const shiftId = snapshot && snapshot.shift ? snapshot.shift.id : null;
            await this.ingest(assessment, { shiftId });
        } catch (err) {
            console.error('[SmartAwareness] cycle failed (ignored, source=' + source + '):', err.message);
        }
    }

    /**
     * المسار الواحد للاستيعاب — يستخدمه مسار HTTP ودورات الإيقاظ معًا:
     * ذاكرة أولًا، ثم بث إلا إذا كان سبب الإلحاق تغيّرَ بصمة.
     * @returns {Object} نتيجة الذاكرة + { broadcasted }
     */
    async ingest(assessment, { shiftId, now } = {}) {
        const result = await this.memory.append(assessment, { shiftId, now });
        if (result.appended && result.reason === 'fingerprint-change') {
            const payload = buildAwarenessPayload(result.previous || null, result.record);
            try {
                this.broadcast(payload);
            } catch (err) {
                console.error('[SmartAwareness] broadcast failed (ignored):', err.message);
            }
            return Object.assign({}, result, { broadcasted: true, payload });
        }
        return Object.assign({}, result, { broadcasted: false });
    }
}

SmartAwarenessService.DEFAULT_DEBOUNCE_MS = DEFAULT_DEBOUNCE_MS;
SmartAwarenessService.BUS_TOPICS = BUS_TOPICS;
SmartAwarenessService.LEGACY_WAKE_TYPES = LEGACY_WAKE_TYPES;
SmartAwarenessService.EVENT_TYPE = EVENT_TYPE;
SmartAwarenessService.buildAwarenessPayload = buildAwarenessPayload;

module.exports = SmartAwarenessService;
