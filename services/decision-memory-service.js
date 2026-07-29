/**
 * Decision Memory Service — ذاكرة القرار التشغيلي (المرحلة 6-ب)
 * ═══════════════════════════════════════════════════════════
 * الغرض ليس الأرشفة لذاتها بل حفظ المعرفة التشغيلية: كل تقييم يصبح
 * حدثًا تشغيليًا غير قابل للتعديل يمكن لاحقًا تحليله لاستخراج
 * (النقص المتكرر / أعطال المركبات المتكررة / تأخر التكميل المتكرر /
 * أنماط الجاهزية عبر الزمن).
 *
 * عقد الثبات (Immutability by design):
 *   الخدمة تعرض إلحاقًا (append) واستعلامات (query) فقط.
 *   لا يوجد update ولا delete ولا rewrite لأي سجل سابق — لا هنا ولا
 *   في أي مستهلك؛ السجلات المكتوبة تُقرأ ولا تُمس. الاستثناء الوحيد:
 *   حارس النمو (RETENTION_MAX_RECORDS) يُسقط أقدم السجلات دفعة واحدة —
 *   نظافة تخزين، وليست تعديلًا للتقييمات.
 *
 * نمط التخزين: ملف JSON ضمن STORAGE_PATH نفسه (decision-memory.json) —
 *   نفس نمط timeline.json / announcements.json في server.js:
 *   قراءة كاملة → تعديل في الذاكرة → كتابة كاملة (read-modify-write)،
 *   وENOENT ⇒ سجل فارغ. التخزين UTC دائمًا؛ صيغة الرياض للعرض عبر
 *   TimeRiyadh (TIME-POLICY.md) في حقل مشتق لا يُستخدم للمقارنات.
 *
 * سياسة الإلحاق (معرفة لا ضجيج):
 *   تقييم المسار يُولَّد عند كل طلب GET؛ تسجيل كل طلب كان سيغرق الذاكرة
 *   بنسخ مكررة. لذلك لا يُلحق السجل إلا في حالتين:
 *     (أ) تغيّرت بصمة المحتوى التشغيلي (خطر ظهر/زال، شدة تغيّرت،
 *         توصيات تغيّرت، حالة الجاهزية تغيّرت، مرحلة المناوبة تغيّرت)، أو
 *     (ب) انقضت مدة النبضة (HEARTBEAT_MINUTES) منذ آخر سجل لنفس المناوبة
 *         — حتى المناوبة المستقرة تترك أثرًا زمنيًا قابلًا للتحليل.
 *   البصمة = hash مستقر لـ (رموز المخاطر+شدتها+فرقها، رموز التوصيات
 *   +أهدافها، readiness.status، shiftPhase) — بلا الطوابع الزمنية ولا
 *   الصياغات الوصفية حتى لا تُعدّ إعادة الصياغة تغييرًا تشغيليًا.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const TimeRiyadh = require('../public/js/time-riyadh.js'); // الطبقة المركزية الوحيدة للوقت (TIME-POLICY)

// ─── ثوابت مُسمّاة (قابلة للضبط — وتُحقن في الاختبارات عبر options) ───
const HEARTBEAT_MINUTES = 15;      // نبضة التسجيل للمناوبة المستقرة
const RETENTION_MAX_RECORDS = 5000; // حارس النمو — إبقاء الأحدث، إسقاط الأقدم
const MEMORY_FILE = 'decision-memory.json';

function minutesBetween(isoStart, isoEnd) {
    const a = Date.parse(isoStart);
    const b = Date.parse(isoEnd);
    if (isNaN(a) || isNaN(b)) return null;
    return Math.max(0, Math.round((b - a) / 60000));
}

/** البصمة التشغيلية المستقرة — ترتيب ثابت، بلا حقول زمنية/وصفية. */
function fingerprintOf(a) {
    const risks = Array.isArray(a.risks) ? a.risks : [];
    const recs = Array.isArray(a.recommendations) ? a.recommendations : [];
    const basis = {
        risks: risks.map(r => [r.code || null, r.severity || null, r.team || null]),
        recommendations: recs.map(r => [r.code || null, JSON.stringify(r.target || null)]),
        readinessStatus: (a.readiness && a.readiness.status) || null,
        shiftPhase: a.shiftPhase || null
    };
    return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 16);
}

/**
 * بناء سجل الذاكرة من التقييم — نسخة عميقة (السجل لا يشارك مراجع مع
 * كائن التقييم)، مع حقول مشتقة تجعل استعلامات الأنماط رخيصة لاحقًا
 * (تُحسب مرة عند الكتابة بدل إعادة تحليل الصياغات عند كل استعلام).
 */
function buildRecord(a, { shiftId, shiftType, fingerprint, now }) {
    const risks = Array.isArray(a.risks) ? a.risks : [];
    const recs = Array.isArray(a.recommendations) ? a.recommendations : [];
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const r of risks) { if (r && counts[r.severity] !== undefined) counts[r.severity]++; }

    const riskCodes = risks.map(r => r && r.code).filter(Boolean);
    const shortageTeams = [...new Set(risks
        .filter(r => r && (r.code === 'TEAM_MISSING' || r.code === 'TEAM_UNDERSTAFFED') && r.team)
        .map(r => r.team))];
    const vehicleIssues = [...new Set(recs
        .filter(r => r && (r.code === 'ASSIGN_RESERVE_VEHICLE' || r.code === 'ESCALATE_VEHICLE'))
        .map(r => (r.target && (r.target.vehicleName || r.target.team)) || null)
        .filter(Boolean))];

    return {
        id: 'dm-' + (Date.parse(now) || Date.now()) + '-' + crypto.randomBytes(3).toString('hex'),
        recordedAt: now,                                    // UTC ISO — مصدر المقارنات الزمنية
        recordedAtRiyadh: TimeRiyadh.formatDateTimeSec(now), // عرض فقط (TIME-POLICY) — لا يُقارن
        shiftId: shiftId != null ? shiftId : null,
        shiftType: shiftType || (a.shift && a.shift.type) || null,
        shiftPhase: a.shiftPhase || 'unknown',
        fingerprint,
        readiness: {
            percent: (a.readiness && typeof a.readiness.percent === 'number') ? a.readiness.percent : null,
            status: (a.readiness && a.readiness.status) || null
        },
        // الحمولة الكاملة محفوظة (نسخة عميقة — ثبات بنيوي)
        risks: JSON.parse(JSON.stringify(risks)),
        recommendations: JSON.parse(JSON.stringify(recs)),
        proactive: JSON.parse(JSON.stringify(Array.isArray(a.proactive) ? a.proactive : [])),
        summary: typeof a.summary === 'string' ? a.summary : '',
        counts,
        // حقول مشتقة للأنماط
        riskCodes,
        shortageTeams,
        vehicleIssues,
        completionDelay: riskCodes.includes('COMPLETION_PENDING')
    };
}

class DecisionMemoryService {
    /**
     * @param {Object} [options]
     * @param {string} [options.storagePath] - مجلد التخزين (نفس STORAGE_PATH)؛ قابل للحقن في الاختبارات
     * @param {string} [options.fileName]    - اسم الملف (افتراضي decision-memory.json)
     * @param {number} [options.heartbeatMinutes] - تجاوز مدة النبضة (اختبارات/ضبط)
     * @param {number} [options.retentionMax]     - تجاوز سقف الاحتفاظ (اختبارات/ضبط)
     */
    constructor(options = {}) {
        this.storagePath = options.storagePath || path.join(__dirname, '..', 'data');
        this.filePath = path.join(this.storagePath, options.fileName || MEMORY_FILE);
        this.heartbeatMinutes = options.heartbeatMinutes || HEARTBEAT_MINUTES;
        this.retentionMax = options.retentionMax || RETENTION_MAX_RECORDS;
        this._records = null;             // ذاكرة مؤقتة — تُحمَّل من الملف عند أول استخدام
        this._io = Promise.resolve();     // تسلسل الكتابة (ملف واحد — نفس مفهوم طابور المعاملات في المحرك)
    }

    async _load() {
        if (this._records) return this._records;
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const arr = JSON.parse(raw);
            this._records = Array.isArray(arr) ? arr : [];
        } catch (e) {
            this._records = []; // ENOENT أو تلف ⇒ سجل فارغ (نفس سلوك readTimeline)
        }
        return this._records;
    }

    async _persist() {
        await fs.mkdir(this.storagePath, { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(this._records, null, 2)); // نفس نمط writeTimeline
    }

    /**
     * إلحاق تقييم بالذاكرة — العملية الكتابية الوحيدة في الخدمة.
     * @param {Object} assessment - ناتج decisionEngine.assess (يُقرأ فقط)
     * @param {Object} [opts] - { shiftId, shiftType, now } — now قابل للحقن (اختبارات/نبضة)
     * @returns {Object} { appended, skipped?, fingerprint, record?, heartbeat? }
     */
    async append(assessment, opts = {}) {
        if (!assessment || typeof assessment !== 'object') return { appended: false, skipped: 'invalid-assessment' };
        const now = opts.now || new Date().toISOString();
        const job = async () => {
            const records = await this._load();
            const shiftId = opts.shiftId != null ? opts.shiftId : (assessment.shift ? assessment.shift.id : null);
            const fingerprint = fingerprintOf(assessment);

            // آخر سجل لنفس المناوبة — المقارنة ضمن سياق المناوبة (مناوبة جديدة = معرفة جديدة دائمًا)
            let last = null;
            for (let i = records.length - 1; i >= 0; i--) {
                if (records[i].shiftId === shiftId) { last = records[i]; break; }
            }
            if (last && last.fingerprint === fingerprint) {
                const since = minutesBetween(last.recordedAt, now);
                if (since !== null && since < this.heartbeatMinutes) {
                    return { appended: false, reason: 'dedup', skipped: 'duplicate-fingerprint', fingerprint };
                }
            }

            const isHeartbeat = !!(last && last.fingerprint === fingerprint);

            const record = buildRecord(assessment, { shiftId, shiftType: opts.shiftType, fingerprint, now });
            const before = records.slice(); // لقطة تراجع — فشل الكتابة لا يترك أثرًا
            records.push(record);
            // حارس النمو: إسقاط الأقدم فقط عند تجاوز السقف — نظافة تخزين، لا تعديل معرفة
            if (records.length > this.retentionMax) records.splice(0, records.length - this.retentionMax);
            try {
                await this._persist();
            } catch (err) {
                // اتساق الذاكرة مع القرص: السجل الفاشل يُسحب من الذاكرة المؤقتة حتى
                // لا يلوّث البصمة في المحاولات اللاحقة (skip وهمي) — الفشل يُرفع بصدق
                this._records = before;
                throw err;
            }
            // reason (6-ج): لماذا أُلحق — 'fingerprint-change' (تغيّر معنى تشغيلي؛
            // يشمل أول سجل للمناوبة) أم 'heartbeat' (نبضة زمنية بلا تغيّر).
            // previous: السجل السابق لنفس المناوبة — لحساب فروق الوعي (diff) بلا قراءة إضافية.
            return { appended: true, reason: isHeartbeat ? 'heartbeat' : 'fingerprint-change', fingerprint, record, previous: last || null, heartbeat: isHeartbeat };
        };
        const run = this._io.then(job);
        this._io = run.catch(() => { /* إبقاء الطابور حيًا بعد أي فشل */ });
        return run;
    }

    // ─── الاستعلامات (قراءة فقط — تعيد نسخًا عميقة حتى لا يُمس السجل المخزَّن) ───

    /** سجلات مناوبة بترتيب زمني (الإلحاق يضمن الترتيب) — limit يأخذ الأحدث مع بقاء الترتيب. */
    async listByShift(shiftId, limit = 50) {
        const records = await this._load();
        const out = records.filter(r => r.shiftId === shiftId);
        const sliced = out.slice(Math.max(0, out.length - limit));
        return JSON.parse(JSON.stringify(sliced));
    }

    /** أحدث سجل لمناوبة أو null. */
    async latest(shiftId) {
        const records = await this._load();
        for (let i = records.length - 1; i >= 0; i--) {
            if (records[i].shiftId === shiftId) return JSON.parse(JSON.stringify(records[i]));
        }
        return null;
    }

    /**
     * ملخص الأنماط — يُحسب من السجلات المخزنة فقط (صفر إعادة حساب حي):
     * تكرار كل رمز خطر، تكرار نقص كل فريق، تكرار عطل كل مركبة،
     * تكرار تأخر التكميل، ودنيا/متوسط نسبة الجاهزية.
     * @param {Object} [scope] - { shiftId?, from?, to? } — from/to بصيغة ISO شاملة الطرفين
     */
    async patternSummary(scope = {}) {
        const records = await this._load();
        let sel = records;
        if (scope.shiftId != null) sel = sel.filter(r => r.shiftId === scope.shiftId);
        if (scope.from) sel = sel.filter(r => r.recordedAt >= scope.from);
        if (scope.to) sel = sel.filter(r => r.recordedAt <= scope.to);

        const riskCodes = {};
        const shortageTeams = {};
        const vehicleIssues = {};
        let completionDelays = 0;
        let min = null, sum = 0, samples = 0;
        for (const r of sel) {
            for (const c of (r.riskCodes || [])) riskCodes[c] = (riskCodes[c] || 0) + 1;
            for (const t of (r.shortageTeams || [])) shortageTeams[t] = (shortageTeams[t] || 0) + 1;
            for (const v of (r.vehicleIssues || [])) vehicleIssues[v] = (vehicleIssues[v] || 0) + 1;
            if (r.completionDelay) completionDelays++;
            const p = r.readiness && r.readiness.percent;
            if (typeof p === 'number') {
                sum += p; samples++;
                if (min === null || p < min) min = p;
            }
        }
        return {
            scope: {
                shiftId: scope.shiftId != null ? scope.shiftId : null,
                from: scope.from || null,
                to: scope.to || null
            },
            records: sel.length,
            riskCodes,
            shortageTeams,
            vehicleIssues,
            completionDelays,
            readiness: { min, avg: samples ? Math.round(sum / samples) : null, samples }
        };
    }
}

DecisionMemoryService.HEARTBEAT_MINUTES = HEARTBEAT_MINUTES;
DecisionMemoryService.RETENTION_MAX_RECORDS = RETENTION_MAX_RECORDS;
DecisionMemoryService.MEMORY_FILE = MEMORY_FILE;

module.exports = DecisionMemoryService;
