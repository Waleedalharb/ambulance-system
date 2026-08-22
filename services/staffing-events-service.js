/**
 * Staffing Events Service — المصدر الرسمي الوحيد لحالات القوى البشرية (W1-A)
 * ═══════════════════════════════════════════════════════════
 * واجهة نطاق staffing فوق السجل الموحّد operational_events.
 * القواعد: ختم سيرفري إلزامي (shift/actor/وقت من السيرفر)، append-only،
 * الإغلاق دلالي، التصحيح عبر correction (صلاحية + تدقيق — W1-E).
 * الكتابة الفعلية تُفعَّل في W1-B (ترجمة التكميل) — القراءات جاهزة الآن.
 */

const { isValidEventType, isReasonRequired, foldEvents, deriveIndicators, DOMAIN_REGISTRY } = require('./operational-events-core');
// T3 (إعادة التوزيع — «إنهاء التكليف»): support_end يُغلق دلاليًا التكليف المفتوح
// أيضًا (إضافةً إلى الدعم الخارجي/التطوعي). قاعدة الإغلاق المرجعية تعيش في
// operational-events-core المشترك، وتُوسَّع من هنا حتى يبقى التعديل كله ضمن
// خدمة القوى المالكة لدلالة أحداث staffing (append-only — الأحداث لا تُمس).
DOMAIN_REGISTRY.staffing.closureRules.support_end.push('assignment');
const { sortTeamsNatural } = require('./team-order'); // doc-v4 ⑫: الفرز الرقمي الطبيعي — مركزي
// مرحلة الأوفرلاب 3: محلل الأكواد التشغيلية الملحقة (UMD — نفس نسخة المتصفح)
const OperationalCodes = require('../public/js/core/operational-codes.js');

const DOMAIN = 'staffing';

// ─── VA: تطبيع مفاتيح الفرق (واجهة التكميل تستخدم rapid_N ← جدول teams يستخدم «سريع N») ───
function canonicalTeamId(teamId) {
    if (teamId == null) return null;
    let t = String(teamId).trim();
    const arabicToWestern = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
    t = t.split('').map(c => arabicToWestern[c] || c).join('');
    const rapid = t.match(/^(?:rapid_|تدخل سريع\s*)(\d+)$/);
    if (rapid) return 'سريع ' + parseInt(rapid[1], 10);
    return t;
}

// رموز الدوام (نفس مجموعات مسار /api/shift-completion/:shiftId/:teamName حرفيًا)
// ═══ قوائم الأكواد من القاموس المركزي فقط (public/js/core/shift-type-dictionary.js) ═══
// القاموس الرسمي: الأوفرلاب جزء من المناوبة الليلية — الاستثناء الوحيد OvD (نهاري بتعريف المالك)
let DAY_ONLY_CODES, NIGHT_ONLY_CODES, SHARED_CODES, OFF_CODES, STD, SymbolDictionary;
try {
    // المدقق المركزي: فحص القواميس الثلاثة عند الإقلاع — أي خطأ = رفض التشغيل مع تقرير
    require('../public/js/core/system-validator.js').assertValid();
    STD = require('../public/js/core/shift-type-dictionary.js');
    DAY_ONLY_CODES = STD.DAY_ONLY_CODES;
    NIGHT_ONLY_CODES = STD.NIGHT_ONLY_CODES;
    SHARED_CODES = STD.SHARED_CODES;
    OFF_CODES = STD.OFF_CODES;
    // قاموس الرموز (UMD نفس ملف المتصفح) — فك الأكواد الصريحة وتصنيف kind للحوض
    SymbolDictionary = require('../public/js/core/symbol-dictionary.js');
} catch (e) {
    throw new Error('القاموس المركزي مفقود أو معطوب: public/js/core/ — ارفع ملفات القواميس قبل تشغيل الخادم. ' + e.message);
}

// ── قبول كود يوم ك«يوم عمل» لهذه المناوبة — التطبيع المركزي الوحيد ──
// 1) يفك الكود الصريح إلى أساسه عبر القاموس (O12C13→O12C — يبقى ليليًا فقط
//    لأن أساسه ضمن NIGHT_ONLY_CODES، فلا يُكسر منطق الليل-فقط إطلاقًا).
// 2) الراحة/الإجازة/OFF مرفوضة دائمًا.
// 3) الأساس ضمن قائمة الوردية ⇒ عمل.
// 4) أساسٌ هو كود مناوبة معروف لكنه ليس لهذه الوردية (O12C صباحًا) ⇒ مرفوض —
//    لا فكّ رمزيًا للأكواد المعروفة حتى لا يتجاوز الفكُّ قوائمَ الوردية.
// 5) وإلا: تعيين صريح لوحدة ميدانية عاملة (RRC1→تدخل سريع…) يُقبل إن فكّه
//    قاموس الرموز إلى kind ميداني (rapid/center/overlap) — قرار المالك:
//    الإداري يضبط التوزيع في الإكسل بالأكواد الصريحة، فلا يُطرد الموظف.
function isWorkDayCode(rawCode, isNight) {
    const base = STD.normalizeDayCode(rawCode);
    if (!base || OFF_CODES.includes(base)) return false;
    const validCodes = isNight
        ? [...NIGHT_ONLY_CODES, ...SHARED_CODES]
        : [...DAY_ONLY_CODES, ...SHARED_CODES];
    if (validCodes.includes(base)) return true;
    const KNOWN_SHIFT_CODES = [...NIGHT_ONLY_CODES, ...DAY_ONLY_CODES, ...SHARED_CODES];
    if (KNOWN_SHIFT_CODES.includes(base)) return false;
    const sym = SymbolDictionary.resolveSymbol(base);
    return !!(sym && (sym.kind === 'rapid' || sym.kind === 'center' || sym.kind === 'overlap'));
}

// ─── بند 15: اشتقاق سجلات التأخير (بدأ/حضر/المدة/لم يحضر) — سيرفري بالكامل ───
// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): المرجع الوحيد لحساب
// التأخير = بداية المناوبة (صباحية 05:00 / ليلية 17:00 بتوقيت الرياض) — لا وقت
// الإدخال ولا وقت التعديل ولا وقت الحفظ. والغائب الذي يحضر لاحقًا = «حاضر متأخر»:
// arrival يُغلق أقدم late مفتوح ثم أقدم absence مفتوح (نفس قاعدة foldEvents)،
// وsourceEventType يوثّق مصدر الفتح. يطبّق آخر correction لوقت الحضور والمدة
// تُعاد من بداية المناوبة (لا من وقت التصحيح). السقوط على طابع حدث الفتح فقط
// عند تعذر حلّ نوع/تاريخ المناوبة (مع تحذير مسجل).
// لا يمس حالة الفرقة إطلاقًا — معلومات Timeline فقط.
function parsePayload(p) {
    if (!p) return {};
    if (typeof p === 'object') return p;
    try { return JSON.parse(p); } catch (_) { return {}; }
}
// بداية المناوبة بتوقيت الرياض (الإزاحة نص صريح +03:00 — بلا حساب إزاحة محلي):
// صباحية = dateT05:00:00+03:00 ، ليلية = dateT17:00:00+03:00 — تُعاد UTC ISO.
function shiftStartIso(shiftType, shiftDate) {
    const iso = toIsoDate(shiftDate);
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || !shiftType) return null;
    const isNight = String(shiftType).includes('ليل');
    const d = new Date(iso + (isNight ? 'T17:00:00+03:00' : 'T05:00:00+03:00'));
    return isNaN(d.getTime()) ? null : d.toISOString();
}
// مرحلة الأوفرلاب 3: تثبيت تاريخ البداية التشغيلية — لاحقة الكود على تاريخ
// المناوبة، وإن سبقت بداية المناوبة العالمية تُرحَّل لليوم التالي
// (RRA1-04 في ليلية D ⇒ D+1 04:00 · O12-09/12/14 وRRA1-16 في صباحية ⇒ نفس اليوم).
function opStartIsoForDate(shiftDate, shiftStartAtIso, startHHMM) {
    const iso = toIsoDate(shiftDate);
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || !shiftStartAtIso || !startHHMM) return null;
    let d = new Date(iso + 'T' + startHHMM + ':00+03:00');
    if (isNaN(d.getTime())) return null;
    if (d.getTime() < new Date(shiftStartAtIso).getTime()) d = new Date(d.getTime() + 86400000);
    return d.toISOString();
}
// إصلاح «حضر × التفعيل» — الخلل أ (قرار المالك النهائي): عائلة RRA الموقعة
// (حرف D/N صريح في الكود — explicitShift) بلا تدحرج إطلاقًا: البداية تُثبَّت
// على تاريخ المناوبة المسؤولة نفسه (04:00 لصباحيتها، و16:00 لليليتها ولو
// سبقت بدايتها العالمية 17:00). حرف D/N مصدر حقيقة الوردية، فالتثبيت على
// تاريخها متماسك دائمًا. أكواد الأوفرلاب O12-* والصيغة القديمة غير الموقعة
// (legacy — RRA1-04/16) تبقى على قاعدة التدحرج القائمة حرفيًا.
// نقية — بلا وصول للتخزين (كل المدخلات تُمرَّر).
function opStartIsoForParsed(shiftDate, shiftStartAtIso, parsed) {
    if (parsed && parsed.kind === 'rapid' && parsed.explicitShift === true) {
        const iso = toIsoDate(shiftDate);
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || !parsed.start) return null;
        const d = new Date(iso + 'T' + parsed.start + ':00+03:00');
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return opStartIsoForDate(shiftDate, shiftStartAtIso, parsed && parsed.start);
}
// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد التوقيت — وقت الحضور
// المصحَّح (correction.arrivalAt) وقت جداري بتوقيت الرياض. القيمة naive (بلا إزاحة)
// كانت تُفسَّر بمنطقة الخادم المحلية عند new Date فيزيح حساب التأخير على خادم UTC؛
// تُطبَّع هنا إلى UTC ISO بإزاحة +03:00 صريحة. القيم الحاملة لإزاحة/Z تُحترم كما هي.
function normalizeRiyadhWallIso(v) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
        const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}+03:00`);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function deriveLateRecords(events, shiftType, shiftDate, startByEmployee) {
    const sorted = (events || []).slice().sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) || ((a.id || 0) - (b.id || 0)));
    const shiftStartAt = shiftStartIso(shiftType, shiftDate);
    const openLate = {};     // entity_id -> [late events]
    const openAbsence = {};  // entity_id -> [absence events]
    const pairs = [];        // { entity, teamId, startedAt, arrivedAt, arrivalEventId, sourceEventType }
    const corrections = {};  // entity_id -> [{ at, createdAt }]
    let personOpenEvents = 0;
    for (const e of sorted) {
        const ent = e.entity_id;
        if (!ent) continue;
        if (e.event_type === 'late') {
            personOpenEvents++;
            (openLate[ent] = openLate[ent] || []).push(e);
        } else if (e.event_type === 'absence') {
            personOpenEvents++;
            (openAbsence[ent] = openAbsence[ent] || []).push(e);
        } else if (e.event_type === 'arrival') {
            // يُغلق أقدم تأخير مفتوح أولًا، وإلا أقدم غياب مفتوح (الغائب الحاضر = حاضر متأخر)
            let opened = null, sourceEventType = null;
            const ql = openLate[ent];
            if (ql && ql.length) { opened = ql.shift(); sourceEventType = 'late'; }
            else {
                const qa = openAbsence[ent];
                if (qa && qa.length) { opened = qa.shift(); sourceEventType = 'absence'; }
            }
            if (opened) {
                pairs.push({
                    employee: ent,
                    teamId: opened.team_id || e.team_id || null,
                    // المرجع: البداية التشغيلية للموظف إن وُجدت، وإلا بداية المناوبة
                    startedAt: (startByEmployee && startByEmployee[ent]) || shiftStartAt || opened.created_at,
                    arrivedAt: e.created_at,
                    arrivalEventId: e.id || null,
                    sourceEventType
                });
            }
        } else if (e.event_type === 'correction') {
            const p = parsePayload(e.payload);
            const correctedAt = p.arrivalAt || null;
            if (correctedAt && !isNaN(new Date(correctedAt).getTime())) {
                (corrections[ent] = corrections[ent] || []).push({ at: correctedAt, createdAt: e.created_at });
            }
        }
    }
    if (!shiftStartAt && personOpenEvents) {
        console.warn('[StaffingEventsService] تعذّر حلّ نوع/تاريخ المناوبة — التأخير يُحسب من طابع حدث الفتح (سلوك احتياطي فقط)');
    }
    // التصحيح يطبَّق على أحدث زوج وصول لنفس الموظف (الأحداث append-only — التصحيح حدث تدقيق)
    for (const ent of Object.keys(corrections)) {
        const entPairs = pairs.filter(p => p.employee === ent);
        if (!entPairs.length) continue;
        const latestCorrection = corrections[ent][corrections[ent].length - 1];
        entPairs[entPairs.length - 1].arrivedAt = latestCorrection.at;
    }
    const records = pairs.map(p => {
        const mins = Math.max(0, Math.round((new Date(p.arrivedAt) - new Date(p.startedAt)) / 60000));
        const rec = {
            employee: p.employee, teamId: p.teamId,
            startedAt: p.startedAt, arrivedAt: p.arrivedAt,
            durationMinutes: mins, status: 'arrived',
            sourceEventType: p.sourceEventType
        };
        // مرحلة الأوفرلاب 3: البداية التشغيلية تُوسَم فقط لمن له كود تشغيلي
        // (additive — سجلات بقية الموظفين تبقى مطابقة لما قبل المرحلة حرفيًا)
        const opStart = startByEmployee && startByEmployee[p.employee];
        if (opStart) rec.operationalStart = opStart;
        return rec;
    });
    // تأخير/غياب بلا وصول — «لم يحضر»
    for (const [queue, sourceEventType] of [[openLate, 'late'], [openAbsence, 'absence']]) {
        for (const ent of Object.keys(queue)) {
            for (const ev of queue[ent]) {
                const rec = {
                    employee: ent, teamId: ev.team_id || null,
                    startedAt: (startByEmployee && startByEmployee[ent]) || shiftStartAt || ev.created_at, arrivedAt: null,
                    durationMinutes: null, status: 'not_arrived',
                    sourceEventType
                };
                const opStart = startByEmployee && startByEmployee[ent];
                if (opStart) rec.operationalStart = opStart;
                records.push(rec);
            }
        }
    }
    records.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    return records;
}

// ─── بند 17: اشتقاق سجلات التغطية التشغيلية — سيرفري بالكامل ───
// يربط support_end بأقدم دعم مفتوح (external_support/volunteer_support) لنفس الموظف.
// نوع التغطية من payload.coverageType: volunteer/external/assignment/reserve.
const COVERAGE_TYPE_LABELS = { volunteer: 'تطوع', external: 'دعم من مركز آخر', assignment: 'تكليف', reserve: 'احتياط' };
function deriveCoverageRecords(events) {
    const sorted = (events || []).slice().sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) || ((a.id || 0) - (b.id || 0)));
    const open = {};   // entity_id -> [support events]
    const records = [];
    const pushRec = (s, endedAt) => {
        const p = parsePayload(s.payload);
        const coverageType = p.coverageType || (s.event_type === 'volunteer_support' ? 'volunteer' : 'external');
        records.push({
            employee: s.entity_id,
            employeeNumber: p.employeeNumber || null,
            fromCenter: s.center || null,
            coverageType,
            coverageTypeLabel: COVERAGE_TYPE_LABELS[coverageType] || coverageType,
            teamId: s.team_id || null,
            startedAt: s.created_at,
            endedAt: endedAt || null,
            durationMinutes: endedAt ? Math.max(0, Math.round((new Date(endedAt) - new Date(s.created_at)) / 60000)) : null,
            status: endedAt ? 'ended' : 'active',
            approvedBy: s.actor_name || null
        });
    };
    for (const e of sorted) {
        const ent = e.entity_id;
        if (!ent) continue;
        if (e.event_type === 'external_support' || e.event_type === 'volunteer_support') {
            (open[ent] = open[ent] || []).push(e);
        } else if (e.event_type === 'support_end') {
            const q = open[ent];
            if (q && q.length) pushRec(q.shift(), e.created_at);
        }
    }
    for (const ent of Object.keys(open)) for (const s of open[ent]) pushRec(s, null);
    records.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    return records;
}

// تحويل تاريخ المناوبة (قد يحمل أرقامًا عربية أو صيغة D/M/YYYY) إلى ISO
function toIsoDate(shiftDate) {
    if (!shiftDate || typeof shiftDate !== 'string') return shiftDate;
    const arabicNumerals = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    let normalized = shiftDate;
    for (let i = 0; i < 10; i++) normalized = normalized.split(arabicNumerals[i]).join(String(i));
    const m = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const iso = normalized.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return normalized;
    return normalized;
}

class StaffingEventsService {
    /**
     * @param {Object} deps
     * @param {Object} deps.storage - StorageAdapter (البوابة الوحيدة)
     * @param {Object} deps.engine  - OperationsEngine (المناوبة النشطة + المعاملات)
     *
     * SR-2: لا scheduleProvider ولا أي جسر — shift_roster هو المصدر الوحيد
     * للكادر أثناء التشغيل (يُغذّى عبر RosterSyncService من الجدولة).
     */
    constructor({ storage, engine }) {
        if (!storage) throw new Error('StaffingEventsService requires a StorageAdapter');
        if (!engine) throw new Error('StaffingEventsService requires an OperationsEngine');
        this.storage = storage;
        this.engine = engine;
    }

    // ═══════════════════════════════════════════════════════════
    // عقد الفصل (بقرار المالك): الحالة التشغيلية = قرار المشرف — تُخزَّن ولا تُشتق.
    // جدول مستقل بسيط shift_team_status: آخر قرار لكل فرقة في المناوبة
    // (Upsert — آخر ضغطة تحكم دائمًا). أحداث الأشخاص تبقى في
    // operational_events ولا يملك أي منها مسار كتابة إلى هذا الجدول إطلاقًا.
    // ═══════════════════════════════════════════════════════════

    async _runWrite(sql, params) {
        const s = this.storage;
        if (typeof s.run === 'function') return s.run(sql, params || []);
        if (typeof s.exec === 'function') return s.exec(sql, params || []);
        if (s.db && typeof s.db.run === 'function') return s.db.run(sql, params || []);
        throw new Error('Storage adapter lacks a write method (run/exec)');
    }

    async _ensureDecisionTable() {
        if (this._decisionTableReady) return;
        await this._runWrite(`CREATE TABLE IF NOT EXISTS shift_team_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shift_id INTEGER NOT NULL,
            team_id TEXT NOT NULL,
            status TEXT NOT NULL,
            reason TEXT,
            updated_by TEXT,
            updated_at TEXT NOT NULL,
            crew_key TEXT,
            UNIQUE(shift_id, team_id)
        )`);
        // W-تكامل ④: crew_key يربط قرار الفريق بهوية طاقمه الفعلية —
        // جداول قائمة قبل هذه الميزة تُرحَّل دفاعيًا بلا فقدان
        try {
            const cols = await this.storage.all('PRAGMA table_info(shift_team_status)');
            if (cols.length && !cols.some(c => c.name === 'crew_key')) {
                await this._runWrite('ALTER TABLE shift_team_status ADD COLUMN crew_key TEXT');
            }
        } catch (_) { /* عرض القرار يبقى صالحًا بلا العمود */ }
        this._decisionTableReady = true;
    }

    async _upsertDecision({ shiftId, teamId, status, reason, actor, at, crewKey }) {
        await this._ensureDecisionTable();
        await this._runWrite(
            `INSERT INTO shift_team_status (shift_id, team_id, status, reason, updated_by, updated_at, crew_key)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(shift_id, team_id) DO UPDATE SET
               status = excluded.status,
               reason = excluded.reason,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at,
               crew_key = excluded.crew_key`,
            [shiftId, canonicalTeamId(teamId), status, reason || null, actor || null, at, crewKey || null]
        );
    }

    /**
     * W-تكامل ④: هوية الطاقم لحظة كتابة القرار — قرار المالك:
     // مفتاح الطاقم يُشتق من هويات الأعضاء الفعليين للفريق (الكود الوظيفي،
     // وإلا الاسم) مرتبةً — قرار التكميل مرتبط بهوية الطاقم لا باسم الفريق،
     // فإذا تغيّر الأعضاء تغيّر المفتاح ولم يرث الطاقم الجديد قرار طاقم سابق.
     // (أُزيل اعتماده على dynamicCrew الذي لم يعد يُنتَج بعد إلغاء
     // الانتشار التلقائي للفرق الديناميكية.)
     */
    async _decisionCrewKey(shiftId, teamId) {
        try {
            const derived = await this.deriveTeamReadiness(shiftId);
            const cur = derived.teams[canonicalTeamId(teamId)];
            if (!cur || !Array.isArray(cur.members) || !cur.members.length) return null;
            const ids = cur.members
                .map(m => String(m.code || m.employeeCode || m.name || '').trim())
                .filter(Boolean)
                .sort();
            return ids.length ? ids.join('|') : null;
        } catch (_) { return null; }
    }

    /** قرارات المشرف للمناوبة — المصدر الوحيد لحالة الفرق (Current State). */
    async getTeamDecisions(shiftId) {
        await this._ensureDecisionTable();
        const rows = await this.storage.all(
            'SELECT team_id, status, reason, updated_by, updated_at, crew_key FROM shift_team_status WHERE shift_id = ?',
            [shiftId]
        );
        const out = {};
        for (const r of rows) out[canonicalTeamId(r.team_id)] = r;
        return out;
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
        const base = { shiftId, domain: DOMAIN, entities: foldEvents(events, DOMAIN) };
        // VA: إثراء إضافي — جاهزية الفرق المشتقة + مجاميع القوى (نفس الاشتقاق الوحيد)
        try {
            const derived = await this.deriveTeamReadiness(shiftId);
            base.teams = derived.teams;
            base.workforce = derived.workforce;
        } catch (e) {
            console.warn('[StaffingEventsService] deriveTeamReadiness overlay failed:', e.message);
        }
        return base;
    }

    /**
     * doc-v2: خريطة اسم → {jobTitle, code} من كادر المناوبة المجدول (shift_roster).
     * تُستخدم لإثراء سجلات التأخير وصفيًا (additive) — إن لم تُطابق الاسم يُترك بلا code.
     * مرحلة الأوفرلاب 3: يُحتفظ أيضًا بـ shiftCode (رمز الدوام المجدول مثل O12-12)
     * لاشتقاق البداية التشغيلية لكل موظف — نفس الاستعلام، بلا استعلام جديد.
     * مرحلة بدايات الفرق: يُحتفظ أيضًا بـ teamId (فرقة الموظف في الكادر) لطبقة
     * teams.operational_starts — نفس الاستعلام، عمود واحد إضافي فقط.
     */
    async _personInfoByName(shiftId) {
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return {};
        const isNight = String(shift.shift_type || '').includes('ليل');
        const isoDate = toIsoDate(shift.shift_date);
        let rows = [];
        try {
            rows = await this.storage.all(
                `SELECT sr.shift_code, sr.team_id, e.name, e.job_title, e.employee_code
                 FROM shift_roster sr JOIN employees e ON e.id = sr.employee_id
                 WHERE sr.shift_date = ? AND e.is_active = 1`, [isoDate]
            );
        } catch (_) { rows = []; }
        const map = {};
        for (const r of rows) {
            // التطبيع المركزي: الأكواد الصريحة (O12C13/RRC1) لا تُطرد — تُفك لأساسها
            if (!isWorkDayCode(r.shift_code, isNight)) {
                // مرحلة الأوفرلاب 3: الأكواد التشغيلية الملحقة (O12-09/RRA1-04…)
                // تُقبل في وردية تصنيفها القاموسي (O12-12 صباحية · RRA1-04 ليلية)
                // وإلا تُستبعد كما كانت — بلا أي تغيير على بقية الأكواد.
                if (OperationalCodes.isOperationalCode(r.shift_code)) {
                    const cls = STD.classifyDayCode(r.shift_code);
                    const clsNight = String((cls && cls.shift) || '').includes('ليل');
                    if (clsNight !== isNight) continue;
                } else {
                    // مرحلة بدايات الفرق: الأكواد الصرفة D/N — صباحية/ليلية في فئات
                    // القاموس الرسمي (GROUPS) لكنها خارج قوائم وردية الخادم — تُقبل
                    // في ورديتها لأن طبقة teams.operational_starts تُبنى عليها.
                    // الأكواد بلا وردية قاموسية (مكتب/مهمة/إجازة/غير معروف) تُستبعد
                    // كما كانت تمامًا — التوسعة تطابق D/N الصريحين فقط.
                    const cls = STD.classifyDayCode(r.shift_code);
                    const sh = String((cls && cls.shift) || '');
                    if (!sh || sh.includes('ليل') !== isNight) continue;
                }
            }
            if (!map[r.name]) map[r.name] = { jobTitle: r.job_title || null, code: r.employee_code || null, shiftCode: r.shift_code || null, teamId: r.team_id != null ? r.team_id : null };
        }
        return map;
    }

    /**
     * مرحلة بدايات الفرق التشغيلية: خريطة معرّف الفريق ← بداياته التشغيلية
     * المفكوكة ({day, night}) من teams.operational_starts — استعلام واحد.
     * الفرق بلا إعداد (NULL) بلا مدخل إطلاقًا ⇒ سلوك ما قبل المرحلة حرفيًا.
     * JSON تالف يُتجاهل؛ فشل القراءة (عمود غائب في قاعدة قديمة) يُسقط على {}.
     */
    async _teamOperationalStartsById() {
        const map = {};
        try {
            const rows = await this.storage.all('SELECT id, name, operational_starts FROM teams');
            for (const r of rows || []) {
                if (!r.operational_starts) continue;
                try {
                    const parsed = JSON.parse(r.operational_starts);
                    if (parsed && typeof parsed === 'object') map[r.id] = parsed;
                } catch (_) { /* JSON تالف يُتجاهل — لا يُسقط شيئًا */ }
            }
        } catch (_) { /* قراءة وصفية اختيارية — الفشل = بلا طبقة فريق */ }
        return map;
    }

    /**
     * مرحلة الأوفرلاب 3 + مرحلة بدايات الفرق: خريطة اسم ← بداية تشغيلية (UTC ISO).
     * سلسلة الحل بالترتيب:
     *   ① كود تشغيلي ملحق في الكادر (O12-09/RRA1-04…) ⇒ من لاحقة الكود مع قاعدة
     *     الترحيل القائمة (opStartIsoForDate: ما سبق بداية المناوبة يُرحَّل +1 يوم).
     *   ② طبقة الفريق: فرقة الموظف في الكادر ← teams.operational_starts ← المدخل
     *     بحسب نوع المناوبة (day صباحية / night ليلية) ⇒ البداية مثبتة على تاريخ
     *     المناوبة نفسه مباشرة — بلا قاعدة ترحيل هنا (قرار المالك الصريح:
     *     ليلية + 16:00 ⇒ نفس التاريخ D رغم أن 16:00 < 17:00).
     *   غير ذلك بلا مدخل إطلاقًا ⇒ سقوط تلقائي على بداية المناوبة العالمية
     *   (سلوك ما قبل المرحلتين حرفيًا). نقية — بلا وصول للتخزين.
     */
    _personStartMap(shiftType, shiftDate, infoMap, teamStartsById) {
        const out = {};
        const shiftStartAt = shiftStartIso(shiftType, shiftDate);
        if (!shiftStartAt) return out;
        const isNight = String(shiftType).includes('ليل');
        const isoDate = toIsoDate(shiftDate);
        for (const name of Object.keys(infoMap || {})) {
            const info = infoMap[name];
            // ① الكود التشغيلي الملحق — RRA الموقعة بلا تدحرج (الخلل أ)،
            //    وO12-*/القديمة بقاعدة الترحيل القائمة (عبر opStartIsoForParsed)
            const parsed = OperationalCodes.parseOperationalCode(info && info.shiftCode);
            if (parsed) {
                const iso = opStartIsoForParsed(shiftDate, shiftStartAt, parsed);
                if (iso) out[name] = iso;
                continue;
            }
            // ② طبقة الفريق — بداية مثبتة على تاريخ المناوبة نفسه (بلا ترحيل)
            const starts = (teamStartsById && info && info.teamId != null) ? teamStartsById[info.teamId] : null;
            const hhmm = starts ? (isNight ? starts.night : starts.day) : null;
            if (!hhmm || !/^\d{2}:\d{2}$/.test(String(hhmm)) || !isoDate) continue;
            const d = new Date(isoDate + 'T' + hhmm + ':00+03:00');
            if (!isNaN(d.getTime())) out[name] = d.toISOString();
        }
        return out;
    }

    /**
     * مرحلة الأوفرلاب 3: المناوبة السابقة المتعاقبة — ليلية التاريخ D ⇒ صباحية
     * التاريخ D، وصباحية التاريخ D ⇒ ليلية التاريخ D-1 (الترحيل بين مناوبتين
     * متتاليتين فقط). الأحدث id عند تعدد الصفوف.
     */
    async _findPreviousShift(shiftType, shiftDate) {
        const iso = toIsoDate(shiftDate);
        if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso) || !shiftType) return null;
        const isNight = String(shiftType).includes('ليل');
        let prevDate, prevIsNight;
        if (isNight) { prevDate = iso; prevIsNight = false; }
        else {
            prevDate = new Date(new Date(iso + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
            prevIsNight = true;
        }
        try {
            if (prevIsNight) {
                return await this.storage.get(
                    `SELECT * FROM shifts WHERE shift_date = ? AND shift_type LIKE '%ليل%' ORDER BY id DESC LIMIT 1`, [prevDate]) || null;
            }
            return await this.storage.get(
                `SELECT * FROM shifts WHERE shift_date = ? AND (shift_type IS NULL OR shift_type NOT LIKE '%ليل%') ORDER BY id DESC LIMIT 1`, [prevDate]) || null;
        } catch (_) { return null; }
    }

    /**
     * مرحلة الأوفرلاب 3: خريطة اسم ← رمز الدوام المجدول لتاريخ معطى — بلا فلتر
     * isWorkDayCode عامدًا: الترحيل يحتاج رمز مناوبة المنشأ كما هو (O12-12
     * نهاري التصنيف فلا يظهر في خريطة الليلية المفلترة).
     */
    async _rosterShiftCodeByName(shiftDate) {
        const isoDate = toIsoDate(shiftDate);
        const map = {};
        if (!isoDate) return map;
        try {
            const rows = await this.storage.all(
                `SELECT sr.shift_code, e.name
                 FROM shift_roster sr JOIN employees e ON e.id = sr.employee_id
                 WHERE sr.shift_date = ? AND e.is_active = 1`, [isoDate]
            );
            for (const r of rows || []) { if (!map[r.name]) map[r.name] = r.shift_code || null; }
        } catch (_) { /* قراءة وصفية اختيارية — لا تُسقط شيئًا */ }
        return map;
    }

    /**
     * مرحلة الأوفرلاب 3: بذور الترحيل — أحداث late/absence ما زالت مفتوحة في
     * المناوبة السابقة (نفس قاعدة طيّ deriveLateRecords) لموظف يحقق الشرطين
     * معًا (فلتر صارم بقرار المالك):
     *   ① رمز دوامه المجدول في مناوبة المنشأ كود تشغيلي ملحق؛
     *   ② نافذته [opStart, opStart+المدة) تتقاطع فعليًا مع نافذة المناوبة
     *      الحالية [shiftStart, shiftStart+12h): opStart < shiftEnd && opEnd > shiftStart.
     *      وجود كود الأوفرلاب وحده لا يكفي — D12 [05:00,17:00) مقابل ليلية
     *      [17:00,…) ⇒ 17:00 > 17:00 باطل ⇒ لا يُرحَّل أبدًا.
     * نقية — بلا وصول للتخزين (كل المدخلات تُمرَّر).
     */
    _computeCarrySeeds(prevShift, prevEvents, rosterCodeByName, currentShiftStartIso) {
        const seeds = [];
        if (!prevShift || !currentShiftStartIso) return seeds;
        const prevStartIso = shiftStartIso(prevShift.shift_type, prevShift.shift_date);
        if (!prevStartIso) return seeds;
        const stillOpen = deriveLateRecords(prevEvents, prevShift.shift_type, prevShift.shift_date)
            .filter(r => r.status === 'not_arrived');
        const shiftStartMs = new Date(currentShiftStartIso).getTime();
        const shiftEndMs = shiftStartMs + 12 * 3600000;
        for (const rec of stillOpen) {
            const parsed = OperationalCodes.parseOperationalCode(rosterCodeByName[rec.employee]);
            if (!parsed) continue; // ① ليس كودًا تشغيليًا ⇒ لا ترحيل إطلاقًا
            const opStartIso = opStartIsoForParsed(prevShift.shift_date, prevStartIso, parsed);
            if (!opStartIso) continue;
            const opStartMs = new Date(opStartIso).getTime();
            const opEndMs = opStartMs + parsed.durationH * 3600000;
            if (!(opStartMs < shiftEndMs && opEndMs > shiftStartMs)) continue; // ② لا تقاطع ⇒ لا ترحيل
            seeds.push({
                employee: rec.employee, teamId: rec.teamId,
                sourceEventType: rec.sourceEventType, opStartIso
            });
        }
        return seeds;
    }

    /** الخط الزمني الكامل (أو لكيان واحد) — مرتب زمنيًا، لا حذف إطلاقًا. */
    async getTimeline(shiftId, entityId = null) {
        let events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        if (entityId) events = events.filter(e => e.entity_id === entityId);
        // بند 15: سجلات التأخير المشتقة (بدأ/حضر/المدة/لم يحضر) — سيرفري بالكامل.
        // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): نوع/تاريخ المناوبة
        // يُحلّان سيرفريًا من سجل المناوبة (لا من المتصفح إطلاقًا) — بداية المناوبة
        // (05:00/17:00 الرياض) هي المرجع الوحيد لحساب مدة التأخير في كل الأسطح.
        let shiftType = null, shiftDate = null;
        try {
            const shift = await this.storage.getShiftById(shiftId);
            if (shift) { shiftType = shift.shift_type || null; shiftDate = shift.shift_date || null; }
        } catch (_) { /* deriveLateRecords يسقط على طابع حدث الفتح مع تحذير */ }
        // doc-v2 + مرحلة الأوفرلاب 3: خريطة الإثراء الوصفي + خريطة البدايات
        // التشغيلية لأصحاب الأكواد الملحقة (غيرهم بلا مدخل ⇒ سلوك اليوم حرفيًا)
        let info = {};
        try { info = await this._personInfoByName(shiftId); } catch (_) { info = {}; }
        // مرحلة بدايات الفرق: بدايات الفرق التشغيلية (استعلام واحد — فشله = بلا طبقة فريق)
        let teamStarts = {};
        try { teamStarts = await this._teamOperationalStartsById(); } catch (_) { teamStarts = {}; }
        const startByEmployee = this._personStartMap(shiftType, shiftDate, info, teamStarts);
        // مرحلة الأوفرلاب 3: ترحيل الأحداث الشخصية المفتوحة من المناوبة السابقة —
        // بذور اصطناعية تُطوى مع أحداث هذه المناوبة بنفس قاعدة deriveLateRecords
        // (arrival يُغلق الأقدم، وcorrection يطبَّق على أحدث زوج لنفس الكيان).
        // البذور لا تدخل مصفوفة events المُعادة — السجل append-only كما هو.
        // فشل الترحيل لا يُسقط الخط الزمني إطلاقًا.
        const seedEvents = [];
        const carryMeta = {};   // employee -> { carriedFromShiftId, responsibilityStart, opStartIso }
        try {
            const currentShiftStartIso = shiftStartIso(shiftType, shiftDate);
            const prev = currentShiftStartIso ? await this._findPreviousShift(shiftType, shiftDate) : null;
            if (prev) {
                const prevEvents = await this.storage.getOperationalEventsByShift(prev.id, DOMAIN);
                const rosterCodes = await this._rosterShiftCodeByName(prev.shift_date);
                const seeds = this._computeCarrySeeds(prev, prevEvents, rosterCodes, currentShiftStartIso);
                for (const s of seeds) {
                    if (entityId && s.employee !== entityId) continue;
                    seedEvents.push({
                        id: 0, shift_id: prev.id, entity_id: s.employee,
                        team_id: s.teamId, event_type: s.sourceEventType,
                        created_at: s.opStartIso, payload: null
                    });
                    carryMeta[s.employee] = {
                        carriedFromShiftId: prev.id,
                        responsibilityStart: currentShiftStartIso,
                        opStartIso: s.opStartIso
                    };
                    startByEmployee[s.employee] = s.opStartIso; // مثبتة على تاريخ مناوبة المنشأ
                }
            }
        } catch (e) {
            console.warn('[StaffingEventsService] تعذّر ترحيل الأحداث المفتوحة من المناوبة السابقة:', e.message);
        }
        const lateRecords = deriveLateRecords(events.concat(seedEvents), shiftType, shiftDate, startByEmployee);
        // مرحلة الأوفرلاب 3: توثيق السجلات المرحّلة بالطوابع الثلاثة —
        // operationalStart (بدايته التشغيلية في مناوبة المنشأ) + responsibilityStart
        // (بداية هذه المناوبة = لحظة انتقال المسؤولية، تُعرض أيضًا carryForwardAt)
        // + carriedFromShiftId. المدة الإجمالية تبقى من operationalStart،
        // وdelayUnderShiftMinutes = الحضور − بداية هذه المناوبة.
        for (const r of lateRecords) {
            const meta = carryMeta[r.employee];
            if (!meta || r.startedAt !== meta.opStartIso) continue;
            r.operationalStart = meta.opStartIso;
            r.responsibilityStart = meta.responsibilityStart;
            r.carryForwardAt = meta.responsibilityStart;
            r.carriedFromShiftId = meta.carriedFromShiftId;
            if (r.status === 'arrived' && r.arrivedAt) {
                r.delayUnderShiftMinutes = Math.max(0, Math.round((new Date(r.arrivedAt) - new Date(meta.responsibilityStart)) / 60000));
            }
        }
        // مرحلة الأوفرلاب 3: وسم مناوبة المنشأ (قراءة حتمية — بلا أي تعديل
        // للأحداث): سجل «لم يحضر» لموظف تتقاطع نافذته التشغيلية مع المناوبة
        // التالية يُوسَم carryForwardAt = نهاية هذه المناوبة («انتقلت المسؤولية»).
        try {
            const currentShiftStartIso = shiftStartIso(shiftType, shiftDate);
            if (currentShiftStartIso) {
                const rosterCodes = await this._rosterShiftCodeByName(shiftDate);
                const shiftEndMs = new Date(currentShiftStartIso).getTime() + 12 * 3600000;
                const nextEndMs = shiftEndMs + 12 * 3600000;
                for (const r of lateRecords) {
                    if (r.status !== 'not_arrived' || r.carryForwardAt) continue;
                    const parsed = OperationalCodes.parseOperationalCode(rosterCodes[r.employee]);
                    if (!parsed) continue;
                    const opIso = opStartIsoForParsed(shiftDate, currentShiftStartIso, parsed);
                    if (!opIso) continue;
                    const opStartMs = new Date(opIso).getTime();
                    const opEndMs = opStartMs + parsed.durationH * 3600000;
                    if (opStartMs < nextEndMs && opEndMs > shiftEndMs) {
                        r.carryForwardAt = new Date(shiftEndMs).toISOString();
                    }
                }
            }
        } catch (e) {
            console.warn('[StaffingEventsService] تعذّر وسم انتقال المسؤولية للمناوبة التالية:', e.message);
        }
        // doc-v2: إثراء وصفي — التخصص/المعرف الوظيفي بالمطابقة الاسمية (إن لم يُطابق يُترك بلا code)
        try {
            for (const r of lateRecords) {
                const p = info[r.employee];
                if (p) { r.jobTitle = p.jobTitle; r.code = p.code; }
            }
        } catch (_) { /* الإثراء اختياري — لا يُسقط الخط الزمني */ }
        // بند 17: سجلات التغطية التشغيلية المشتقة (دعم/تطوع — بدأ/انتهى/المدة/النوع) — سيرفري بالكامل
        const coverageRecords = deriveCoverageRecords(events);
        return { shiftId, domain: DOMAIN, entityId: entityId || null, events, lateRecords, coverageRecords };
    }

    /** مؤشرات القوى البشرية — تُشتق هنا فقط ولا تُحسب في مكان آخر. */
    async getIndicators(shiftId) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const base = { shiftId, ...deriveIndicators(events, DOMAIN) };
        // VA: نفس اشتقاق جاهزية الفرق (مصدر واحد للوحة الرئيسية والمؤشرات)
        try {
            const derived = await this.deriveTeamReadiness(shiftId);
            base.teams = derived.teams;
            base.workforce = derived.workforce;
        } catch (e) {
            console.warn('[StaffingEventsService] deriveTeamReadiness overlay failed:', e.message);
        }
        return base;
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
                // عقد الفصل: قرارات الحالة ← جدول القرار المستقل (Upsert)، لا سجل الأحداث.
                // W-تكامل ④: يُختم بهوية الطاقم الفعلية (لا وراثة بين الأطقم)
                await this._upsertDecision({
                    shiftId, teamId, status, reason: cur.reason || null, actor: actorName, at,
                    crewKey: await this._decisionCrewKey(shiftId, teamId)
                });
                out.push({ decision: status, teamId });
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

    /**
     * W1-E-A: عرض حالات الفرق المشتق من السجل (الطبقة المشتقة من القراءة الهجينة).
     * الحالة = أحدث حدث جاهزية على مستوى الفريق (ready/missing/offline)،
     * وmissingPerson = الشخص الذي ما زال غيابه/تأخيره مفتوحًا دلاليًا لذلك الفريق.
     * يعيد null عند غياب أحداث الجاهزية ⇒ يسقط المسار إلى الإسقاط التوافقي
     * (مناوبات ما قبل W1-B). لا يعيد paramedics إطلاقًا — بيانات النموذج
     * تبقى في shift_completions (قرار D2: السجل Event Log فقط).
     */
    async getCompletionTeamsView(shiftId) {
        if (!shiftId) return null;
        // عقد الفصل: الحالة من جدول قرار المشرف (وليست من أحداث الأشخاص)
        const decisions = await this.getTeamDecisions(shiftId);
        const keys = Object.keys(decisions);
        if (!keys.length) return null;
        const out = {};
        for (const k of keys) {
            const d = decisions[k];
            out[k] = { status: d.status, reason: d.reason || '', missingPerson: '' };
        }
        // الشخص المفتوح غيابه/تأخيره لفريق ناقص (arrival يغلقه دلاليًا) — من سجل الأشخاص
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const folded = foldEvents(events, DOMAIN);
        for (const f of folded) {
            if (!f.entityId || !f.teamId) continue;
            const key = canonicalTeamId(f.teamId);
            if (!out[key] || out[key].status !== 'missing') continue;
            const stillOpen = f.open.some(o => o.event_type === 'absence' || o.event_type === 'late');
            if (stillOpen) out[key].missingPerson = f.entityId;
        }
        return out;
    }

    /**
     * VA: إلحاق أحداث أشخاص (التدفق الجديد لشاشة التكميل) — تُستدعى من
     * CompletionService داخل معاملة الحفظ؛ الأختام تصل مختومة سيرفريًا من المسار.
     * القرار لا يسبق البيانات: الغياب/التأخر يتطلبان موظفًا + سببًا، وخارج
     * الخدمة يتطلب سببًا صريحًا — يُرفض الطلب الناقص (400) قبل أي كتابة.
     * idempotent: حدث فتح مكرر (نفس النوع/الشخص/الفريق وما زال مفتوحًا) يُتخطى،
     * وحدث إغلاق بلا ما يغلقه يُتخطى — السجل append-only ولا تكرار تشغيلي.
     *
     * @returns {{ appended: number, events: Array }}
     */
    async appendPersonEvents({ shiftId, shiftDate, shiftType, events, actor, createdAt }) {
        const out = [];
        if (!shiftId || !Array.isArray(events)) return { appended: 0, events: out };
        const actorId = String((actor && actor.id) || 'system');
        const actorName = (actor && (actor.name || actor.username)) || 'system';
        const at = createdAt || new Date().toISOString();

        const ALLOWED = ['absence', 'late', 'assignment', 'arrival', 'external_support', 'volunteer_support', 'support_end', 'offline', 'ready', 'missing', 'correction', 'activation', 'activation_end'];
        const NEEDS_REASON = ['absence', 'late', 'offline'];
        const NEEDS_EMPLOYEE = ['absence', 'late', 'arrival', 'external_support', 'volunteer_support', 'support_end', 'assignment', 'correction', 'activation', 'activation_end'];

        // التحقق الكامل قبل أي كتابة (القرار لا يسبق البيانات)
        for (const ev of events) {
            const type = ev && ev.type;
            if (!ALLOWED.includes(type)) {
                const err = new Error('نوع حدث غير صالح: ' + type);
                err.statusCode = 400;
                throw err;
            }
            const employee = ev.employeeName || ev.employeeId || null;
            if (NEEDS_EMPLOYEE.includes(type) && !employee) {
                const err = new Error('الموظف إلزامي لهذا النوع من الأحداث');
                err.statusCode = 400;
                throw err;
            }
            if (NEEDS_REASON.includes(type) && !ev.reason) {
                const err = new Error('السبب إلزامي لهذا النوع من الأحداث');
                err.statusCode = 400;
                throw err;
            }
            // بند 15: تصحيح وقت الحضور — وقت صالح إلزامي (صلاحية المشرف على المسار)
            // (تفويض 2026-08: naive يُقبل ثم يُطبَّع كتوقيت الرياض عند الختم أدناه)
            if (type === 'correction' && (!ev.arrivalAt || !normalizeRiyadhWallIso(ev.arrivalAt))) {
                const err = new Error('وقت الحضور المصحَّح غير صالح');
                err.statusCode = 400;
                throw err;
            }
            // كل الأنواع مرتبطة بفريق إلا دعم الاحتياط (external_support بلا فريق هدف)
            // المرحلة ب: وsupport_end — إنهاء متطوع الحوض (volunteer_support بلا
            // فريق) يُرسل بلا teamId فيُغلق أقدم دعم مفتوح للكيان (نفس دلالة الطيّ)
            const teamId = canonicalTeamId(ev.supportTargetTeamId || ev.teamId);
            if (!teamId && type !== 'external_support' && type !== 'support_end') {
                const err = new Error('الفريق إلزامي لهذا النوع من الأحداث');
                err.statusCode = 400;
                throw err;
            }
        }

        // الحالة المطوية الحالية — لمنع التكرار ولتحقق الإغلاق
        const existing = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const folded = foldEvents(existing, DOMAIN);
        const openOf = (entityId) => {
            const f = folded.find(x => x.entityId === entityId);
            return f ? f.open : [];
        };
        for (const ev of events) {
            const type = ev.type;
            const employee = ev.employeeName || ev.employeeId || null;
            const teamId = canonicalTeamId(ev.supportTargetTeamId || ev.teamId);

            // عقد الفصل (بقرار المالك): قرارات الحالة (ready/missing/offline) ← جدول
            // القرار المستقل (Upsert — آخر ضغطة تحكم دائمًا، بلا شروط تخطٍّ)،
            // ولا تُلحق في سجل الأحداث إطلاقًا. السجل للأشخاص فقط.
            if (type === 'ready' || type === 'missing' || type === 'offline') {
                // W-تكامل ④: يُختم بهوية الطاقم الفعلية (لا وراثة بين الأطقم)
                await this._upsertDecision({ shiftId, teamId, status: type, reason: ev.reason || null, actor: actorName, at, crewKey: await this._decisionCrewKey(shiftId, teamId) });
                out.push({ decision: type, teamId });
                continue;
            }

            // أحداث الأشخاص ← operational_events كما هي (لا تُمس).
            // منع التكرار/الإغلاق الفارغ (idempotency تشغيلية)
            if (employee) {
                const open = openOf(employee);
                if (['absence', 'late'].includes(type) && open.some(o => o.event_type === type)) continue;
                if ((type === 'external_support' || type === 'volunteer_support') && open.some(o => (o.event_type === 'external_support' || o.event_type === 'volunteer_support') && canonicalTeamId(o.team_id) === teamId)) continue;
                if (type === 'assignment' && open.some(o => o.event_type === 'assignment' && canonicalTeamId(o.team_id) === teamId)) continue;
                if (type === 'arrival' && !open.some(o => o.event_type === 'absence' || o.event_type === 'late')) continue;
                // T3: يُقبل «إنهاء التكليف» — support_end صالح أيضًا عند وجود تكليف مفتوح
                if (type === 'support_end' && !open.some(o => o.event_type === 'external_support' || o.event_type === 'volunteer_support' || o.event_type === 'assignment')) continue;
                // مرحلة الأوفرلاب 4 (التفعيل): تفعيل مكرر مفتوح لنفس الفريق يُتخطى،
                // وإنهاء بلا تفعيل مفتوح يُتخطى — نفس قاعدة الدعم/التكليف حرفيًا
                if (type === 'activation' && open.some(o => o.event_type === 'activation' && canonicalTeamId(o.team_id) === teamId)) continue;
                if (type === 'activation_end' && !open.some(o => o.event_type === 'activation')) continue;
            }

            const payload = { source: 'completion-person-events' };
            if (type === 'correction') { payload.corrects = 'arrival_time'; payload.arrivalAt = normalizeRiyadhWallIso(ev.arrivalAt); }
            if (ev.coverageType) payload.coverageType = ev.coverageType;
            if (ev.jobTitle) payload.jobTitle = ev.jobTitle;
            if (ev.employeeNumber) payload.employeeNumber = ev.employeeNumber;
            const id = await this.storage.appendOperationalEvent({
                shiftId, shiftDate, shiftType, domain: DOMAIN,
                entityId: employee,
                entityName: employee,
                teamId, center: ev.center || null,
                eventType: type,
                reason: ev.reason || null,
                readinessBasis: (type === 'external_support' || type === 'volunteer_support') ? type : null,
                payload,
                actorId, actorName, createdAt: at
            });
            out.push({ id, eventType: type, entityId: employee, teamId });
            // حدّث الطيّ المحلي حتى تتسلسل قرارات الإغلاق/الفتح داخل نفس الدفعة
            const synth = { id, domain: DOMAIN, entity_id: employee, entity_name: employee, team_id: teamId, event_type: type, reason: ev.reason || null, created_at: at };
            let f = folded.find(x => x.entityId === employee);
            if (!f) {
                f = { entityId: employee, entityName: employee, teamId, open: [], lastEvent: null, closedCount: 0, corrections: 0 };
                folded.push(f);
            }
            // T3: support_end يُغلق التكليف أيضًا (طيّ الدفعة المحلي — المرجع الدائم: closureRules أعلى الملف)
            const CLOSES = { arrival: ['absence', 'late'], support_end: ['external_support', 'volunteer_support', 'assignment'], activation_end: ['activation'] };
            const closes = CLOSES[type];
            if (closes) {
                const idx = f.open.findIndex(o => closes.includes(o.event_type));
                if (idx >= 0) f.open.splice(idx, 1);
            } else if (type !== 'correction') { // التصحيح حدث تدقيق — ليس حالة مفتوحة
                f.open.push(synth);
            }
            f.lastEvent = synth;
        }
        return { appended: out.length, events: out };
    }

    /**
     * VA: اشتقاق جاهزية الفرق — المصدر الوحيد للحقيقة (SSOT).
     * يطوي أحداث staffing + يقرأ الكادر المجدول (shift_roster) + requiredPersonnel
     * + حالة المركبة المعينة ⇒ لكل فريق:
     *   { status, activeCount, requiredPersonnel, members, absentees, vacant, vehicle* }
     * «النشط» = عضو مجدول بلا غياب/تأخر/تكليف مفتوح، أو داعم بدعم مفتوح للفريق،
     * أو مكلَّف إلى الفريق. لا شيء يُحسب في الواجهة إطلاقًا.
     */
    // دلالة الحقول (توثيق UAT-1 — إضافة حقول فقط، بلا حذف/إعادة تسمية):
    //   scheduledStaff  : الكادر المجدول — كل الأفراد المجدولين في الجدول الرسمي
    //                     (shift_roster برمز دوام صحيح) لفرق هذه المناوبة، بغض
    //                     النظر عن الغياب/التأخير/التكليف.
    //   totalStaff      : الكادر الحاضر فعليًا = المجدولون النشطون (بلا غياب/تأخر
    //                     مفتوح وغير مكلَّفين خارج فرقهم) + الدعم المؤقت (دعم خارجي
    //                     /تطوعي/تكليف وارد) + الأوفرلاب المدمج صراحة عبر roster.
    //                     لذلك قد يتجاوز scheduledStaff عند ورود دعم إضافي من
    //                     خارج الجدول — وهذا سلوك صحيح وليس خطأ.
    //   requiredTeams   : الفرق المطلوبة — عدد فرق خطة هذه المناوبة (لها كادر مجدول).
    //   operationalReadinessRate : نسبة الجاهزية التشغيلية =
    //                     (الفرق الجاهزة ÷ الفرق المطلوبة) × 100 — مقياس فرق
    //                     صرف لا علاقة له بعدد الأفراد. (readinessRate الأصلي
    //                     = جاهزة ÷ مقرَّرة ويبقى كما هو للتوافق الخلفي.)
    async deriveTeamReadiness(shiftId) {
        const emptyWf = {
            totalStaff: 0, totalRequired: 0, totalCars: 0,
            readyTeams: 0, missingTeams: 0, offlineTeams: 0, pendingTeams: 0,
            supporters: 0, absentees: 0, readinessRate: null,
            scheduledStaff: 0, requiredTeams: 0, operationalReadinessRate: null
        };
        if (!shiftId) return { shiftId: shiftId || null, teams: {}, workforce: emptyWf };
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { shiftId, teams: {}, workforce: emptyWf };

        const isNight = String(shift.shift_type || '').includes('ليل');
        const isoDate = toIsoDate(shift.shift_date);

        // الكادر المجدول لهذا التاريخ (رموز دوام فقط — الإجازات/الغياب المجدول ليس كادرًا)
        // doc-v4 ⑫: فرز رقمي طبيعي في JS بعد الجلب (بادئة ثم رقم) — الموضع المركزي
        // الذي تُشتق منه الفرق؛ ترتيب الإدراج هنا يسري على الحالة واللقطة والوثيقة والشاشات.
        const teamRows = sortTeamsNatural(await this.storage.all(
            'SELECT id, name, center, team_type, requiredPersonnel FROM teams WHERE is_active = 1'
        ), t => t.name);
        let rosterRows = [];
        try {
            rosterRows = await this.storage.all(
                `SELECT sr.team_id, sr.shift_code, e.name, e.job_title, e.employee_code, e.phone
                 FROM shift_roster sr JOIN employees e ON e.id = sr.employee_id
                 WHERE sr.shift_date = ? AND e.is_active = 1`, [isoDate]
            );
        } catch (_) { rosterRows = []; }
        const crewByTeamId = {};
        // doc-v2: خريطة اسم → {jobTitle, code} لإثراء الداعمين/المكلَّفين (مطابقة اسمية — additive فقط)
        const personInfo = {};
        for (const r of rosterRows) {
            // التطبيع المركزي: الأكواد الصريحة (O12C13/RRC1) لا تُطرد — تُفك لأساسها
            if (!isWorkDayCode(r.shift_code, isNight)) {
                // إصلاح «حضر × التفعيل»: الأكواد الصرفة D/N (ليست تشغيلية ملحقة)
                // ذات تصنيف قاموسي لوردية المناوبة — كادر فعلي لفرق
                // teams.operational_starts (سريع 1..4). نفس استثناء
                // _personInfoByName («مرحلة بدايات الفرق») حرفًا؛ بغيره لا يدخل
                // موظفو سريع المجدولون D/N بطاقة فريقهم إطلاقًا فلا يظهر
                // المتأخر منهم في absentees ولا يُرسم له زر «حضر».
                // الأكواد التشغيلية الملحقة تبقى مستبعدة هنا كما كانت
                // (تُدار عبر التفعيل/الحوض)، وبلا تصنيف قاموسي يُستبعد كما كان.
                if (OperationalCodes.isOperationalCode(r.shift_code)) continue;
                const cls = STD.classifyDayCode(r.shift_code);
                const sh = String((cls && cls.shift) || '');
                if (!sh || sh.includes('ليل') !== isNight) continue;
            }
            const info = { jobTitle: r.job_title || null, code: r.employee_code || null, phone: r.phone || null };
            (crewByTeamId[r.team_id] = crewByTeamId[r.team_id] || []).push({ name: r.name, ...info });
            if (!personInfo[r.name]) personInfo[r.name] = info;
        }

        // SR-2: أُزيل جسر جدولة JSON نهائيًا — الكادر من shift_roster فقط.
        // roster فارغ ⇒ كادر فارغ (صادق) حتى تتم مزامنة الجدولة عبر RosterSyncService.

        // طيّ أحداث staffing
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const folded = foldEvents(events, DOMAIN);
        const openByEntity = {};
        const teamOpen = {};
        const teamLastEvent = {};
        for (const f of folded) {
            if (f.entityId) { openByEntity[f.entityId] = f.open; continue; }
            const t = canonicalTeamId(f.teamId);
            if (!t) continue;
            teamOpen[t] = f.open;
            if (f.lastEvent) teamLastEvent[t] = f.lastEvent;
        }

        // مرحلة الأوفرلاب 4 (التفعيل): خريطة الفريق ← تفعيلات مفتوحة
        // (team_id = اسم الفريق القياسي، مُطبَّع عبر canonicalTeamId). التفعيل
        // يربط موظف كود تشغيلي (O12-09/12/14 · RRA1-04/16) بفريق قائم فقط —
        // لا ينشئ فريقًا ولا يغيّر أي تصنيف kind إطلاقًا (بقرار المالك:
        // موظف RRA يبقى تدخلًا سريعًا التصنيف، والتفعيل ربط تشغيلي فحسب).
        const activationByTeam = {};
        for (const f of folded) {
            if (!f.entityId) continue;
            for (const o of f.open) {
                if (o.event_type !== 'activation') continue;
                const tn = canonicalTeamId(o.team_id);
                if (!tn) continue;
                (activationByTeam[tn] = activationByTeam[tn] || []).push({ entityId: f.entityId, event: o });
            }
        }

        // المركبات: تعيين مفتوح + آخر حالة (خط المركبة كاملًا — ليس محصورًا بالمناوبة)
        const vehAssignByVeh = {};
        const vehStatus = {};
        try {
            const vehEvents = await this.storage.all(
                `SELECT entity_id, team_id, event_type, status FROM operational_events
                 WHERE domain = 'vehicle' AND event_type IN ('assignment','assignment_end','status_change')
                 ORDER BY created_at ASC, id ASC`
            );
            for (const e of vehEvents) {
                if (e.event_type === 'assignment') vehAssignByVeh[e.entity_id] = String(e.team_id);
                else if (e.event_type === 'assignment_end') delete vehAssignByVeh[e.entity_id];
                else if (e.event_type === 'status_change') vehStatus[e.entity_id] = e.status;
            }
        } catch (_) { /* بلا أحداث مركبات */ }
        const vehByTeamId = {};
        for (const vehId of Object.keys(vehAssignByVeh)) vehByTeamId[vehAssignByVeh[vehId]] = vehId;

        // V-B ②: دعم المركبات — دعم مفتوح لكل فريق (نطاق center: supported/support_lifted؛
        // نفس أحداث خدمة المركبات — اعتماد نوع مستقل لاحقًا يُحدّث هذا الاستعلام فقط)
        const supportByTeamId = {};
        try {
            const supEvents = await this.storage.all(
                `SELECT entity_id, team_id, event_type FROM operational_events
                 WHERE domain = 'center' AND event_type IN ('supported','support_lifted')
                 ORDER BY created_at ASC, id ASC`
            );
            const openSup = {};
            for (const e of supEvents) {
                if (e.event_type === 'supported') openSup[e.entity_id] = String(e.team_id);
                else delete openSup[e.entity_id];
            }
            for (const vehId of Object.keys(openSup)) {
                (supportByTeamId[openSup[vehId]] = supportByTeamId[openSup[vehId]] || []).push(vehId);
            }
        } catch (_) { /* بلا أحداث دعم */ }

        // عقد الفصل: قرارات المشرف من جدول الحالة — المصدر الوحيد لحالة الفرق
        const decisions = await this.getTeamDecisions(shiftId);

        const teams = {};
        const wf = { ...emptyWf };
        for (const t of teamRows) {
            const required = t.requiredPersonnel || 2;
            const crew = crewByTeamId[t.id] || []; // SR-2: roster فقط — لا بديل
            const activations = activationByTeam[t.name] || [];
            // مصدر الحقيقة = الفرق المطلوب تكميلها في هذا الشفت فقط:
            // فريق بلا كادر مجدول لهذه المناوبة ليس ضمن خطتها، فلا يدخل
            // الحالة ولا عدادات القوى (باقي X فريق/نسبة الإنجاز/شرط الاكتمال)
            // ولا سير العمل الرسمي — حتى لو كان نشطًا في جدول الفرق.
            // مرحلة الأوفرلاب 4: استثناء وحيد — فريق بلا كادر لكن عليه تفعيل
            // مفتوح يدخل الحالة (المفعَّلون طاقمه الفعلي لهذه المناوبة).
            if (crew.length === 0 && activations.length === 0) continue;
            const crewNames = new Set(crew.map(c => c.name));
            const members = [];
            const absentees = [];
            let activeCount = 0;

            for (const c of crew) {
                const open = openByEntity[c.name] || [];
                const openAbs = open.find(o => o.event_type === 'absence' || o.event_type === 'late');
                const openAway = open.find(o => o.event_type === 'assignment' && canonicalTeamId(o.team_id) !== t.name);
                if (openAbs) {
                    absentees.push({
                        name: c.name, jobTitle: c.jobTitle, code: c.code, phone: c.phone,
                        reason: openAbs.reason || null,
                        since: openAbs.created_at, recordedBy: openAbs.actor_name || null,
                        type: openAbs.event_type
                    });
                    members.push({ name: c.name, jobTitle: c.jobTitle, code: c.code, phone: c.phone, role: 'base', state: openAbs.event_type });
                } else if (openAway) {
                    members.push({ name: c.name, jobTitle: c.jobTitle, code: c.code, phone: c.phone, role: 'base', state: 'assignment' });
                } else {
                    activeCount++;
                    members.push({ name: c.name, jobTitle: c.jobTitle, code: c.code, phone: c.phone, role: 'base', state: 'active' });
                }
            }

            // الداعمون (دعم مفتوح لهذا الفريق) + المكلَّفون إلى هذا الفريق
            const supporters = [];
            const seenSupport = new Set();
            // قراءة payload الحدث (نوع التغطية + المسمى/الرقم المُدخلان يدويًا لغير المجدولين)
            const payloadOf = (o) => {
                try { return o.payload ? JSON.parse(o.payload) : null; }
                catch (e) { return null; }
            };
            for (const f of folded) {
                if (!f.entityId) continue;
                for (const o of f.open) {
                    if ((o.event_type === 'external_support' || o.event_type === 'volunteer_support') && canonicalTeamId(o.team_id) === t.name) {
                        if (seenSupport.has(f.entityId)) continue;
                        seenSupport.add(f.entityId);
                        const pi = personInfo[f.entityId] || {};
                        const pl = payloadOf(o) || {};
                        supporters.push({ name: f.entityId, jobTitle: pi.jobTitle || pl.jobTitle || null, code: pi.code || pl.employeeNumber || null, role: 'support', state: 'external_support', supportType: o.event_type, coverageType: pl.coverageType || null, since: o.created_at, recordedBy: o.actor_name || null, fromCenter: o.center || null });
                    } else if (o.event_type === 'assignment' && canonicalTeamId(o.team_id) === t.name && !crewNames.has(f.entityId)) {
                        if (seenSupport.has(f.entityId)) continue;
                        seenSupport.add(f.entityId);
                        const pi = personInfo[f.entityId] || {};
                        const pl = payloadOf(o) || {};
                        supporters.push({ name: f.entityId, jobTitle: pi.jobTitle || pl.jobTitle || null, code: pi.code || pl.employeeNumber || null, role: 'support', state: 'assignment', supportType: 'assignment', coverageType: pl.coverageType || null, since: o.created_at, recordedBy: o.actor_name || null, fromCenter: o.center || null });
                    }
                }
            }
            activeCount += supporters.length;
            members.push(...supporters);

            // مرحلة الأوفرلاب 4 (التفعيل): المفعَّلون لهذا الفريق (تفعيل مفتوح،
            // وليسوا من طاقمه المجدول) — نفس نمط حقن الداعمين: يُحسبون في
            // activeCount ويظهرون في members بدور «activation». لا يُنشأ فريق
            // جديد ولا يُمس تصنيف kind لأي موظف (RRA يبقى تدخلًا سريعًا).
            const seenActivation = new Set();
            for (const a of activations) {
                if (crewNames.has(a.entityId) || seenActivation.has(a.entityId)) continue;
                seenActivation.add(a.entityId);
                const pi = personInfo[a.entityId] || {};
                const pl = payloadOf(a.event) || {};
                // تمييز عرضي خالص (ملاحظة المالك — بلا أي تغيير منطقي): المفعَّل
                // الذي له volunteer_support مفتوح بلا فريق هو «متطوع الأصل»
                // (التطوع يبقى مفتوحًا طوال التفعيل) — وإلا فهو مفعَّل أوفرلاب.
                // حقل إضافي فقط: role/state/activeCount وكل اشتقاق آخر كما هي.
                const activationKind = (openByEntity[a.entityId] || [])
                    .some(o => o.event_type === 'volunteer_support' && !canonicalTeamId(o.team_id))
                    ? 'volunteer' : 'overlap';
                // إصلاح «حضر × التفعيل»: المفعَّل المتأخر/الغائب (حدث late/absence
                // مفتوح باسمه) يدخل absentees — زر «✋ حضر» في الواجهة مدفوع بهذه
                // الحالة السيرفرية وحدها — ويُوسم عضوه بحالة الغياب/التأخير بدل
                // «activation». التفعيل نفسه يبقى مفتوحًا (لا يُغلقه إلا
                // activation_end)، ولا يُحسب ضمن النشطين حتى يحضر — تمامًا
                // كعضو القاعدة المتأخر في حلقة الطاقم أعلاه.
                const openAbs = (openByEntity[a.entityId] || []).find(o => o.event_type === 'absence' || o.event_type === 'late');
                if (openAbs) {
                    absentees.push({
                        name: a.entityId,
                        jobTitle: pi.jobTitle || pl.jobTitle || null,
                        code: pi.code || pl.employeeNumber || null,
                        phone: pi.phone || null,
                        reason: openAbs.reason || null,
                        since: openAbs.created_at, recordedBy: openAbs.actor_name || null,
                        type: openAbs.event_type
                    });
                    members.push({
                        name: a.entityId,
                        jobTitle: pi.jobTitle || pl.jobTitle || null,
                        code: pi.code || pl.employeeNumber || null,
                        role: 'activation', state: openAbs.event_type,
                        activationKind, // تمييز عرضي: متطوع/أوفرلاب — بلا أثر منطقي
                        since: a.event.created_at, recordedBy: a.event.actor_name || null
                    });
                    continue;
                }
                members.push({
                    name: a.entityId,
                    jobTitle: pi.jobTitle || pl.jobTitle || null,
                    code: pi.code || pl.employeeNumber || null,
                    role: 'activation', state: 'activation',
                    activationKind, // تمييز عرضي: متطوع/أوفرلاب — بلا أثر منطقي
                    since: a.event.created_at, recordedBy: a.event.actor_name || null
                });
                activeCount++;
            }

            // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): التشكيلة
            // النهائية الفعلية — من يُنهي المناوبة مع الفريق فعلًا بعد طيّ كل
            // الأحداث (الغياب/التأخير/الدعم/الاستبدال/التطوع): القاعدة النشطة
            // (بلا غياب/تأخير مفتوح وغير مكلَّفة خارج الفريق) + الدعم الوارد
            // (خارجي/تطوعي/تكليف داخل). حقل مشتق هنا فقط (نفس دلالة activeCount
            // تمامًا — مصدر واحد بلا طيّ مكرر) وتسجيل الخروج يقرأه فلا يظهر
            // الغائب ويظهر البديل/المتطوع. additive: members يبقى كما هو.
            // تثبيت صفة «متطوع» عبر السلسلة: المفعَّلون (state='activation' —
            // الأوفرلاب والمتطوع المفعَّلان الحاضران) جزء من التشكيلة الفعلية
            // لمّا يُنهون المناوبة مع الفريق فعلًا؛ المفعَّل المتأخر/الغائب
            // (state='late'/'absence') يبقى مستبعدًا حتى يحضر. يحمل activationKind
            // تلقائيًا (على كائن العضو نفسه) — لا أثر على activeCount ولا عدادات القوى.
            const effectiveRoster = members.filter(m => m && (m.state === 'active' || m.role === 'support' || m.state === 'activation'));

            const vehId = vehByTeamId[String(t.id)] || null;
            const vehSt = vehId ? (vehStatus[vehId] || null) : null;
            const ownVehicleOk = !vehSt || (vehSt !== 'breakdown' && vehSt !== 'out_of_service');
            // V-B ②: مركبة دعم صالحة (غير متعطلة/خارج الخدمة) تُحسب في جاهزية الفريق المدعوم
            const supportVehicleIds = supportByTeamId[String(t.id)] || [];
            const supportVehicleOk = supportVehicleIds.some(id => {
                const st = vehStatus[id];
                return !st || (st !== 'breakdown' && st !== 'out_of_service');
            });
            const vehicleOk = ownVehicleOk || supportVehicleOk;

            // عقد الفصل (بقرار المالك): الحالة التشغيلية = آخر قرار للمشرف من جدول
            // shift_team_status — ولا تُشتق إطلاقًا من الغياب/التأخير/المركبة/الدعم.
            // كل تلك الحقائق تبقى معروضة (members/absentees/vehicleOk/supporters)
            // كمعلومة للمشرف، لكن لا يملك أي منها تغيير الحالة.
            // الافتراضي قبل أي قرار: pending (لم يُكمَّل).
            const decision = decisions[t.name] || null;
            const status = decision ? decision.status : 'pending';

            teams[t.name] = {
                status,
                // يُحافظ على شكل الاستجابة الأصلي: سبب قرار الحالة (خارج الخدمة مثلًا) أو فارغ
                reason: (decision && decision.reason) || '',
                activeCount,
                requiredPersonnel: required,
                center: t.center || null,
                members,
                effectiveRoster, // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): التشكيلة النهائية الفعلية
                absentees,
                vacant: Math.max(0, required - activeCount),
                vehicleId: vehId,
                vehicleStatus: vehSt,
                vehicleOk,
                supportVehicleIds,
                // بند 13: آخر قرار للمشرف (الحالة/السبب/من/متى) — يُعرض في التفاصيل/الـ Tooltip
                lastDecision: decision
                    ? { status: decision.status, reason: decision.reason || null, by: decision.updated_by || null, at: decision.updated_at || null }
                    : null
            };

            // مجاميع القوى (تُشتق هنا فقط)
            wf.totalStaff += activeCount;
            wf.totalRequired += required;
            wf.supporters += supporters.length;
            wf.absentees += absentees.length;
            wf.scheduledStaff += crew.length; // UAT-1: الكادر المجدول (roster) لهذا الفريق
            wf.requiredTeams++;               // UAT-1: الفرق المطلوبة (فرق خطة المناوبة)
            if (status === 'ready') wf.readyTeams++;
            else if (status === 'missing') wf.missingTeams++;
            else if (status === 'offline') wf.offlineTeams++;
            else wf.pendingTeams++;
        }

        // ── الأوفرلاب: تعيين صريح من الإكسل فقط (بقرار المالك — إلغاء الانتشار التلقائي) ──
        // أُزيل اشتقاق الفرق الديناميكية (③ب) بالكامل: لا إنشاء تلقائي لجنوب 11+
        // ولا بوابة نقص ولا اكتمال طاقم. من يحمل رمزًا برقم سيارة صريح (O12C13)
        // يدخل كادر الفريق المحدد عبر roster كأي عضو عادي، ومن بلا رقم صريح
        // (O12C) يبقى ضمن «الدعم المتاح» حتى يوزّعه الإداري من الإكسل أو
        // يُسنده المشرف بآلية الدعم من شاشة التكميل.

        // ترتيب المفاتيح نهائيًا بالفرز الطبيعي المركزي — فرق الاحتياط المعيَّنة
        // صراحة (جنوب 11+) تتخذ موضعها بعد جنوب 10 وقبل سريع، وبقية الترتيب كما هو
        const teamsOrdered = {};
        for (const n of sortTeamsNatural(Object.keys(teams))) teamsOrdered[n] = teams[n];

        // السيارات العاملة = مركبات معينة بحالة غير متعطلة/خارج الخدمة
        for (const vehId of Object.keys(vehAssignByVeh)) {
            const st = vehStatus[vehId];
            if (st !== 'breakdown' && st !== 'out_of_service') wf.totalCars++;
        }
        const decided = wf.readyTeams + wf.missingTeams + wf.offlineTeams;
        wf.readinessRate = decided > 0 ? Math.round((wf.readyTeams / decided) * 100) : null;
        // UAT-1: نسبة الجاهزية التشغيلية = (الجاهزة ÷ المطلوبة) × 100 — مقياس فرق صرف
        wf.operationalReadinessRate = wf.requiredTeams > 0
            ? Math.round((wf.readyTeams / wf.requiredTeams) * 100) : null;

        return { shiftId, teams: teamsOrdered, workforce: wf };
    }

    /** VA: نفس الاشتقاق بصيغة موجزة للمسارات الإحصائية. */
    async deriveWorkforce(shiftId) {
        return this.deriveTeamReadiness(shiftId);
    }

    /**
     * VA: القوى المتاحة للدعم — موظفون مجدولون (رمز دوام لهذه المناوبة)
     * ليسوا نشطين حاليًا في أي فريق مشتق، وبلا غياب/تأخر/خروج مفتوح.
     * يشمل حوض الاحتياط (external_support مفتوح بلا فريق هدف).
     * فلتر النوع (قرار المالك): القيادة الميدانية/التحكم العملياتي/تنسيق
     * الاستجابة فرق مستقلة — لا تدخل الحوض إطلاقًا (kind من قاموس الرموز:
     * leadership/ops — وتنسيق الاستجابة فرع ops بحسب طبيعة العمل).
     * كل مرشح يُوسم بمصدره (sourceUnit/kind) حتى تعرض الواجهة «المركز
     * القادم منه» بلا لبس — حقول إضافية فقط، لا يُحذف أي حقل قائم.
     */
    async getAvailableSupport(shiftId) {
        if (!shiftId) return { shiftId: shiftId || null, supporters: [] };
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { shiftId, supporters: [] };
        const isNight = String(shift.shift_type || '').includes('ليل');
        const isoDate = toIsoDate(shift.shift_date);

        let scheduled = [];
        try {
            scheduled = await this.storage.all(
                `SELECT e.id AS employee_id, e.employee_code, e.name, e.job_title, e.symbol, sr.team_id, sr.shift_code, t.name AS team_name
                 FROM shift_roster sr
                 JOIN employees e ON e.id = sr.employee_id
                 LEFT JOIN teams t ON t.id = sr.team_id
                 WHERE sr.shift_date = ? AND e.is_active = 1`, [isoDate]
            );
        } catch (_) { scheduled = []; }
        // رمز اليوم لكل اسم (قبل الفلترة — يشمل الإجازات/WO) لوسم عناصر الحوض
        const rosterCodeByName = {};
        for (const r of scheduled) if (!(r.name in rosterCodeByName)) rosterCodeByName[r.name] = r.shift_code || null;
        scheduled = scheduled.filter(r => {
            if (isWorkDayCode(r.shift_code, isNight)) return true; // التطبيع المركزي — لا مطابقة حرفية
            // مرحلة الأوفرلاب 4 (التفعيل): الأكواد التشغيلية الملحقة (O12-09/
            // O12-12/O12-14/RRA1-04/RRA1-16) تُقبل في وردية تصنيفها القاموسي —
            // نفس استثناء _personInfoByName حرفيًا، بلا تغيير لبقية الأكواد.
            if (!OperationalCodes.isOperationalCode(r.shift_code)) return false;
            const cls = STD.classifyDayCode(r.shift_code);
            const clsNight = String((cls && cls.shift) || '').includes('ليل');
            return clsNight === isNight;
        });

        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const folded = foldEvents(events, DOMAIN);
        const openByEntity = {};
        for (const f of folded) { if (f.entityId) openByEntity[f.entityId] = f.open; }

        // من هو نشط في فريق مشتق؟ (عضو أساسي نشط أو داعم بفريق هدف أو مكلَّف)
        const derived = await this.deriveTeamReadiness(shiftId);
        const busy = new Set();
        for (const tName of Object.keys(derived.teams)) {
            for (const m of derived.teams[tName].members) {
                // مرحلة الأوفرلاب 4: «activation» حالة انشغال — المفعَّل يغادر الحوض
                if (m.state === 'active' || m.state === 'external_support' || m.state === 'assignment' || m.state === 'activation') busy.add(m.name);
            }
        }

        const supporters = [];
        for (const s of scheduled) {
            const open = openByEntity[s.name] || [];
            if (open.some(o => o.event_type === 'absence' || o.event_type === 'late' || o.event_type === 'exit')) continue;
            if (busy.has(s.name)) continue;
            // تصنيف المرشح عبر قاموس الرموز (رمز الموظف + طبيعة عمله —
            // قاعدة «تنسيق الاستجابة» محسومة داخل القاموس)
            const sym = s.symbol ? SymbolDictionary.resolveSymbol(s.symbol, s.job_title) : null;
            const kind = sym ? sym.kind : null;
            if (kind === 'leadership' || kind === 'ops') continue; // فرق مستقلة — ممنوع دخول الحوض
            supporters.push({
                name: s.name,
                employeeCode: s.employee_code || null,
                jobTitle: s.job_title || null,
                team: s.team_name || null,
                // W-تكامل ③: رمز المناوبة (إضافي فقط) — يميّز الأوفرلاب (O12…)
                // في عرض الحوض حين لا يكون للموظف فريق مجدول (team=null).
                shiftCode: s.shift_code || null,
                // وسم المصدر (إضافي فقط): الوحدة القادم منها + نوعه من القاموس
                sourceUnit: sym ? sym.team : (s.team_name || null),
                kind: kind
            });
        }
        // المرحلة ب (تصحيح المالك — مسار الـOverlap): المتطوعون بلا فريق
        // (volunteer_support مفتوح بلا teamId) عناصر حوض بصفة «متطوع —
        // غير مفعّل» مع رمز اليوم إن وجد. الإضافة للحوض فقط؛ الإسناد
        // للفرقة عبر التفعيل (activateTeam). من عليه تفعيل مفتوح داخل
        // busy أصلًا (عضو activation في فريق مشتق) فيختفي تلقائيًا،
        // ويعود بعد activation_end لأن تطوعه يبقى مفتوحًا. الحقول إضافية
        // فقط (volunteer:true) — لا يتغير أي سلوك قائم للأحداث بفريق.
        for (const f of folded) {
            if (!f.entityId) continue;
            const openVol = (f.open || []).filter(o => o.event_type === 'volunteer_support' && !canonicalTeamId(o.team_id));
            if (!openVol.length) continue;
            if (busy.has(f.entityId)) continue; // مفعَّل/منشغل — ليس في الحوض
            if (supporters.some(s => s.name === f.entityId)) continue; // حارس ازدواج
            const pl = parsePayload(openVol[openVol.length - 1].payload);
            supporters.push({
                name: f.entityId,
                employeeCode: pl.employeeNumber ? String(pl.employeeNumber) : null,
                jobTitle: pl.jobTitle || null,
                team: null,
                shiftCode: rosterCodeByName[f.entityId] || null, // رمز اليوم إن وجد (V/WO/…)
                sourceUnit: null,
                kind: null,
                volunteer: true // وسم «متطوع — غير مفعّل» + أهلية زر «تفعيل فرقة»
            });
        }
        return { shiftId, supporters };
    }

    // ═══════════════════════════════════════════════════════════
    // مرحلة الأوفرلاب 4 (التفعيل) — Completion-Screen Activation
    // ربط موظف كود تشغيلي ملحق (O12-09/12/14 · RRA1-04/16) بفريق قائم نشط.
    // نفس نمط دعم المركبات (vehicle-events-service): التحقق الكامل قبل أي
    // كتابة، الختم سيرفري عبر appendEvent (المناوبة/الفاعل/الوقت من السيرفر)،
    // والإغلاق دلالي (activation_end يُغلق activation لنفس الكيان).
    // التفعيل ربط تشغيلي فحسب: لا ينشئ فريقًا ولا يحوّل فريقًا إلى عادي
    // ولا يغيّر تصنيف kind لموظفي التدخل السريع (RRA) إطلاقًا.
    // ═══════════════════════════════════════════════════════════

    /** فريق قائم ونشط باسمه القياسي — 404 إن لم يوجد، 400 إن كان معطّلًا. */
    async _requireActiveTeamByName(teamName) {
        const name = canonicalTeamId(teamName);
        const team = await this.storage.get(
            'SELECT id, name, center, is_active FROM teams WHERE name = ?', [name]);
        if (!team) {
            const err = new Error('الفريق غير موجود: ' + name);
            err.statusCode = 404;
            throw err;
        }
        if (!team.is_active) {
            const err = new Error('الفريق غير نشط حاليًا: ' + name);
            err.statusCode = 400;
            throw err;
        }
        return team;
    }

    /** صف الكادر المجدول للموظف بتاريخ معطى (الرمز + هوية الإثراء) — null إن لم يكن مجدولًا. */
    async _rosterRowFor(shiftDate, employeeName) {
        const isoDate = toIsoDate(shiftDate);
        try {
            return await this.storage.get(
                `SELECT sr.shift_code, e.employee_code, e.job_title FROM shift_roster sr
                 JOIN employees e ON e.id = sr.employee_id
                 WHERE sr.shift_date = ? AND e.name = ? AND e.is_active = 1`, [isoDate, employeeName]) || null;
        } catch (_) { return null; }
    }

    /** التفعيل المفتوح حاليًا لموظف في مناوبة (طيّ دلالي) أو null. */
    async _openActivation(shiftId, employeeName) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const folded = foldEvents(events, DOMAIN);
        const f = folded.find(x => x.entityId === employeeName);
        if (!f) return null;
        const opens = f.open.filter(o => o.event_type === 'activation');
        return opens.length ? opens[opens.length - 1] : null;
    }

    /**
     * تفعيل موظف كود تشغيلي على فريق قائم. الشروط (تُتحقق قبل أي كتابة):
     *  - مناوبة نشطة (الختم سيرفري).
     *  - الفريق موجود في teams (404) ونشط (400).
     *  - الموظف مجدول اليوم في shift_roster برمز دوام كود تشغيلي ملحق (400).
     *  - تفعيل مكرر مفتوح لنفس الفريق ⇒ تخطٍّ idempotent بلا حدث ثانٍ.
     *  - تفعيل مفتوح على فريق آخر ⇒ 400 (أنهِ الحالي أولًا — نمط دعم المركبات).
     */
    async activateTeam({ employeeName, teamName, note }, actor) {
        if (!employeeName || !teamName) {
            const err = new Error('بيانات ناقصة: الموظف والفريق إلزاميان');
            err.statusCode = 400;
            throw err;
        }
        const shift = await this.engine.shifts.getActiveShift();
        if (!shift) {
            const err = new Error('لا توجد مناوبة نشطة - ابدأ مناوبة أولاً');
            err.statusCode = 400;
            throw err;
        }
        const team = await this._requireActiveTeamByName(teamName);
        const rosterRow = await this._rosterRowFor(shift.shift_date, employeeName);
        const shiftCode = rosterRow ? (rosterRow.shift_code || null) : null;
        // المرحلة ب (تصحيح المالك): صاحب تطوع مفتوح بلا فريق («في الحوض»)
        // يُقبل للتفعيل تمامًا كصاحب الكود التشغيلي — نفس المسار ونفس
        // الفريق (مجدولة اليوم أو غير مجدولة طالما موجودة ونشطة)، وبقية
        // التحققات أدناه (منع الازدواج/idempotency) كما هي بلا تغيير.
        const openVolunteer = await this._openTeamlessVolunteer(shift.id, employeeName);
        if (!openVolunteer) {
            if (shiftCode == null) {
                const err = new Error('الموظف غير مجدول في مناوبة اليوم: ' + employeeName);
                err.statusCode = 400;
                throw err;
            }
            if (!OperationalCodes.isOperationalCode(shiftCode)) {
                const err = new Error('التفعيل لموظفي الأكواد التشغيلية الملحقة فقط (رمزه الحالي: ' + shiftCode + ')');
                err.statusCode = 400;
                throw err;
            }
        }
        const open = await this._openActivation(shift.id, employeeName);
        if (open && canonicalTeamId(open.team_id) === team.name) {
            return { success: true, appended: 0, skipped: 'already-activated', shiftId: shift.id, employeeName, teamName: team.name };
        }
        if (open) {
            const err = new Error('الموظف مفعَّل على فريق آخر حاليًا — أنهِ التفعيل الحالي أولاً');
            err.statusCode = 400;
            throw err;
        }
        // هوية الإثراء تُختم في الـ payload وقت الكتابة (نفس نمط أحداث الدعم:
        // jobTitle/employeeNumber) حتى يجدها اشتقاق الأعضاء حتى لو كان الموظف
        // بلا فريق مجدول (خارج خريطة personInfo). المرحلة ب: للمتطوع بلا صف
        // كادر تُؤخذ الهوية من payload حدث تطوعه (خُتمت من employees عند الإضافة).
        const volPayload = openVolunteer ? parsePayload(openVolunteer.payload) : {};
        const payload = { source: 'overlap-activation', shiftCode };
        const enrichJobTitle = (rosterRow && rosterRow.job_title) || volPayload.jobTitle || null;
        const enrichNumber = (rosterRow && rosterRow.employee_code) || volPayload.employeeNumber || null;
        if (enrichJobTitle) payload.jobTitle = enrichJobTitle;
        if (enrichNumber) payload.employeeNumber = String(enrichNumber);
        const result = await this.appendEvent({
            eventType: 'activation',
            entityId: employeeName, entityName: employeeName,
            teamId: team.name, center: team.center || null,
            note: note || null,
            payload
        }, actor);
        return { success: true, appended: 1, eventId: result.eventId, shiftId: result.shiftId, employeeName, teamName: team.name };
    }

    /** إنهاء تفعيل موظف (إغلاق دلالي). بلا تفعيل مفتوح ⇒ 409. */
    async endActivation({ employeeName, note }, actor) {
        if (!employeeName) {
            const err = new Error('بيانات ناقصة: الموظف إلزامي');
            err.statusCode = 400;
            throw err;
        }
        const shift = await this.engine.shifts.getActiveShift();
        if (!shift) {
            const err = new Error('لا توجد مناوبة نشطة - ابدأ مناوبة أولاً');
            err.statusCode = 400;
            throw err;
        }
        const open = await this._openActivation(shift.id, employeeName);
        if (!open) {
            const err = new Error('لا يوجد تفعيل مفتوح لهذا الموظف');
            err.statusCode = 409;
            throw err;
        }
        const result = await this.appendEvent({
            eventType: 'activation_end',
            entityId: employeeName, entityName: employeeName,
            teamId: open.team_id, center: open.center || null,
            note: note || null,
            payload: { source: 'overlap-activation' }
        }, actor);
        return { success: true, appended: 1, eventId: result.eventId, shiftId: result.shiftId, employeeName, teamName: canonicalTeamId(open.team_id) };
    }

    // ═══════════════════════════════════════════════════════════
    // المرحلة ب: إضافة متطوع من شاشة التكميل — Completion-Screen Volunteer
    // مسار الـOverlap حرفيًا (تصحيح المالك النهائي): الإضافة = دخول «الدعم
    // المتاح» فقط (volunteer_support مفتوح بلا فريق — حالة «متطوع — غير
    // مفعّل»)، والإسناد للفرقة يتم لاحقًا عبر التفعيل (activateTeam نفسه)،
    // وإنهاء التفعيل يعيده للحوض. جدوله الأصلي لا يُمسّ إطلاقًا.
    // قاعدة الاختيار السيرفرية الوحيدة (بقرار المالك):
    //   النشطون في النظام − المجدولون للعمل الفعلي اليوم = مرشحو التطوع.
    // «مجدول للعمل الفعلي» = نفس مصنّف اشتقاق الطاقم الثلاثي المعتمد في
    // _personInfoByName حرفيًا (isWorkDayCode ← تشغيلي في ورديته القاموسية
    // ← D/N الصرفة لوردية المناوبة) — يُستخدم هنا فقط، بلا إعادة هيكلة
    // للمصنّف القائم. OFF_CODES ليست قاعدة اختيار إطلاقًا: V/VC/E/EV/S
    // (إجازات بلا وردية قاموسية) وWO (دوام رسمي بلا وردية) والراحة وبلا
    // سجل كلها مرشحة. صفر كتابة على shift_roster: التطوع حدث تشغيلي فقط.
    // ═══════════════════════════════════════════════════════════

    /**
     * هل الرمز «عمل فعلي» لهذه المناوبة؟ — نفس منطق القبول الثلاثي في
     * _personInfoByName خطوة بخطوة (لا يُستدعى إلا من منطق المتطوع):
     *  ① isWorkDayCode (تطبيع مركزي: قوائم الوردية + فك رمزي ميداني)
     *  ② كود تشغيلي ملحق في وردية تصنيفه القاموسي
     *  ③ كود صنفه القاموس لوردية المناوبة (D/N الصرفة)
     * كل ما عداه (إجازات/راحة/WO/مكتب بلا وردية/بلا رمز) ليس عملًا فعليًا.
     */
    _isScheduledForActualWork(shiftCode, isNight) {
        if (!shiftCode) return false;
        if (isWorkDayCode(shiftCode, isNight)) return true;
        if (OperationalCodes.isOperationalCode(shiftCode)) {
            const cls = STD.classifyDayCode(shiftCode);
            const clsNight = String((cls && cls.shift) || '').includes('ليل');
            return clsNight === isNight;
        }
        const cls = STD.classifyDayCode(shiftCode);
        const sh = String((cls && cls.shift) || '');
        return !!sh && (sh.includes('ليل') === isNight);
    }

    /**
     * مرشحو التطوع لمناوبة: بحث LIKE (اسم/كود وظيفي) في الموظفين النشطين،
     * ثم استبعاد سيرفري: من هو مجدول للعمل الفعلي اليوم (المصنّف الثلاثي)،
     * ومن عليه تطوع/دعم/تفعيل/تكليف مفتوح في هذه المناوبة (طيّ الأحداث).
     * dayCode إرشادي للعرض فقط (رمز الكادر المجدول أو null — بلا سجل).
     */
    async getVolunteerCandidates(shiftId, q) {
        if (!shiftId) return { shiftId: shiftId || null, candidates: [] };
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { shiftId, candidates: [] };
        const isNight = String(shift.shift_type || '').includes('ليل');
        const isoDate = toIsoDate(shift.shift_date);
        const query = String(q || '').trim();
        if (query.length > 100) {
            const err = new Error('استعلام طويل');
            err.statusCode = 400;
            throw err;
        }
        const like = '%' + query + '%';
        let rows = [];
        try {
            rows = await this.storage.all(
                `SELECT e.employee_code, e.name, e.job_title
                 FROM employees e
                 WHERE e.is_active = 1 AND (? = '' OR e.name LIKE ? OR e.employee_code LIKE ?)
                 ORDER BY e.name LIMIT 40`, [query, like, like]);
        } catch (_) { rows = []; }
        // رموز كادر تاريخ المناوبة (استعلام واحد — نفس نمط _rosterShiftCodeByName)
        let rosterRows = [];
        try {
            rosterRows = await this.storage.all(
                `SELECT e.name, sr.shift_code FROM shift_roster sr
                 JOIN employees e ON e.id = sr.employee_id
                 WHERE sr.shift_date = ? AND e.is_active = 1`, [isoDate]);
        } catch (_) { rosterRows = []; }
        const codeByName = {};
        for (const r of rosterRows) if (!(r.name in codeByName)) codeByName[r.name] = r.shift_code || null;
        // مشغّلات مفتوحة (تطوع/دعم/تفعيل/تكليف) تُخرج صاحبها من المرشحين
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const folded = foldEvents(events, DOMAIN);
        const OPEN_TRIGGERS = ['volunteer_support', 'external_support', 'activation', 'assignment'];
        const busy = new Set();
        for (const f of folded) {
            if (!f.entityId) continue;
            if ((f.open || []).some(o => OPEN_TRIGGERS.includes(o.event_type))) busy.add(f.entityId);
        }
        const candidates = [];
        for (const r of rows) {
            if (busy.has(r.name)) continue;
            const dayCode = (r.name in codeByName) ? codeByName[r.name] : null;
            if (this._isScheduledForActualWork(dayCode, isNight)) continue;
            candidates.push({
                name: r.name,
                employeeCode: r.employee_code || null,
                jobTitle: r.job_title || null,
                dayCode
            });
            if (candidates.length >= 15) break;
        }
        return { shiftId, candidates };
    }

    /** التطوع المفتوح بلا فريق («في الحوض») لموظف في مناوبة (طيّ دلالي) أو null. */
    async _openTeamlessVolunteer(shiftId, employeeName) {
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        const folded = foldEvents(events, DOMAIN);
        const f = folded.find(x => x.entityId === employeeName);
        if (!f) return null;
        const opens = f.open.filter(o => o.event_type === 'volunteer_support' && !canonicalTeamId(o.team_id));
        return opens.length ? opens[opens.length - 1] : null;
    }

    /**
     * إضافة متطوع إلى «الدعم المتاح» من شاشة التكميل — بلا فريق (تصحيح
     * المالك: الإسناد للفرقة عبر التفعيل فقط، نفس مسار الـOverlap). الشروط
     * (تُتحقق قبل أي كتابة):
     *  - مناوبة نشطة (الختم سيرفري عبر appendEvent).
     *  - الموظف موجود ونشط في employees (404) — بالكود الوظيفي أو الاسم.
     *  - غير مجدول للعمل الفعلي اليوم وإلا 400 (نفس قاعدة المرشحين).
     *  - تطوع مكرر مفتوح (بفريق أو بلا فريق) ⇒ تخطٍّ idempotent بلا حدث ثانٍ.
     *  - مشغّل مفتوح آخر (دعم/تفعيل/تكليف) ⇒ 400 (أنهِ الحالي أولًا).
     * الحدث volunteer_support بلا teamId: يظهر في حوض الدعم المتاح بصفة
     * «متطوع — غير مفعّل» ويُغلق بـ support_end القائم، ولا يُكتب شيء على
     * shift_roster إطلاقًا. التوافق: volunteer_support بفريق (الأحداث
     * القائمة) يبقى يُشتق عضو support في فريقه كما هو — لا يُكسر.
     */
    async addVolunteer({ employeeCode, employeeName, note }, actor) {
        if (!employeeCode && !employeeName) {
            const err = new Error('بيانات ناقصة: الموظف (كود أو اسم) إلزامي');
            err.statusCode = 400;
            throw err;
        }
        const shift = await this.engine.shifts.getActiveShift();
        if (!shift) {
            const err = new Error('لا توجد مناوبة نشطة - ابدأ مناوبة أولاً');
            err.statusCode = 400;
            throw err;
        }
        // حلّ هوية الموظف من employees (SSOT) — الكود أولًا ثم الاسم
        let emp = null;
        try {
            if (employeeCode) {
                emp = await this.storage.get(
                    'SELECT name, employee_code, job_title FROM employees WHERE employee_code = ? AND is_active = 1',
                    [String(employeeCode).trim()]);
            }
            if (!emp && employeeName) {
                emp = await this.storage.get(
                    'SELECT name, employee_code, job_title FROM employees WHERE name = ? AND is_active = 1',
                    [String(employeeName).trim()]);
            }
        } catch (_) { emp = null; }
        if (!emp) {
            const err = new Error('الموظف غير موجود أو غير نشط: ' + (employeeCode || employeeName));
            err.statusCode = 404;
            throw err;
        }
        const name = emp.name;
        // الحاجز التشغيلي: مجدول للعمل الفعلي اليوم ⇒ مرفوض (نفس مصنّف الطاقم)
        const rosterRow = await this._rosterRowFor(shift.shift_date, name);
        const shiftCode = rosterRow ? (rosterRow.shift_code || null) : null;
        const isNight = String(shift.shift_type || '').includes('ليل');
        if (this._isScheduledForActualWork(shiftCode, isNight)) {
            const err = new Error('الموظف مجدول للعمل الفعلي في مناوبة اليوم (رمزه: ' + shiftCode + ') — لا يُقبل كمتطوع');
            err.statusCode = 400;
            throw err;
        }
        // المشغّلات المفتوحة باسمه في هذه المناوبة (طيّ دلالي واحد)
        const events = await this.storage.getOperationalEventsByShift(shift.id, DOMAIN);
        const folded = foldEvents(events, DOMAIN);
        const f = folded.find(x => x.entityId === name);
        const open = f ? (f.open || []) : [];
        if (open.some(o => o.event_type === 'volunteer_support')) {
            return { success: true, appended: 0, skipped: 'already-volunteering', shiftId: shift.id, employeeName: name };
        }
        if (open.some(o => ['external_support', 'activation', 'assignment'].includes(o.event_type))) {
            const err = new Error('للموظف دعم/تفعيل/تكليف مفتوح حاليًا — أنهِ الحالي أولاً');
            err.statusCode = 400;
            throw err;
        }
        // هوية الإثراء تُختم في الـ payload (نفس نمط أحداث الدعم) حتى يجدها
        // الحوض والتفعيل حتى لو كان المتطوع بلا صف كادر لهذه المناوبة
        const payload = { source: 'completion-volunteer', coverageType: 'volunteer' };
        if (emp.job_title) payload.jobTitle = emp.job_title;
        if (emp.employee_code) payload.employeeNumber = String(emp.employee_code);
        const result = await this.appendEvent({
            eventType: 'volunteer_support',
            entityId: name, entityName: name,
            teamId: null, center: null, // «في الحوض» — بلا فريق حتى يُفعَّل
            note: note || null,
            readinessBasis: 'volunteer_support',
            payload
        }, actor);
        return { success: true, appended: 1, eventId: result.eventId, shiftId: result.shiftId, employeeName: name };
    }
}

module.exports = StaffingEventsService;