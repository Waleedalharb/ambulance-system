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
const DAY_ONLY_CODES = ['D12', 'D10', 'D11', 'D8', 'D6', 'CPD', 'CP8'];
const NIGHT_ONLY_CODES = ['N12', 'N10', 'N11', 'N8', 'N6', 'LN8', 'LN10', 'CPN'];
const SHARED_CODES = ['CP24', 'M', 'ME', 'F', 'O12', 'O10', 'O6'];
const OFF_CODES = ['V', 'VC', 'E', 'EV', 'WO', 'C'];

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

    /** الخط الزمني الكامل (أو لكيان واحد) — مرتب زمنيًا، لا حذف إطلاقًا. */
    async getTimeline(shiftId, entityId = null) {
        let events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        if (entityId) events = events.filter(e => e.entity_id === entityId);
        return { shiftId, domain: DOMAIN, entityId: entityId || null, events };
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
        const events = await this.storage.getOperationalEventsByShift(shiftId, DOMAIN);
        if (!events.length) return null;
        const TEAM_STATUSES = ['ready', 'missing', 'offline'];
        const out = {};
        for (const e of events) {
            if (!e.team_id || e.entity_id) continue; // أحداث الفريق فقط (بلا كيان شخصي)
            if (TEAM_STATUSES.includes(e.event_type)) {
                out[e.team_id] = { status: e.event_type, reason: e.reason || '', missingPerson: '' };
            }
        }
        if (!Object.keys(out).length) return null;
        // الشخص المفتوح غيابه/تأخيره لفريق ناقص (arrival يغلقه دلاليًا)
        const folded = foldEvents(events, DOMAIN);
        for (const f of folded) {
            if (!f.entityId || !f.teamId || !out[f.teamId]) continue;
            if (out[f.teamId].status !== 'missing') continue;
            const stillOpen = f.open.some(o => o.event_type === 'absence' || o.event_type === 'late');
            if (stillOpen) out[f.teamId].missingPerson = f.entityId;
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

        const ALLOWED = ['absence', 'late', 'assignment', 'arrival', 'external_support', 'support_end', 'offline', 'ready'];
        const NEEDS_REASON = ['absence', 'late', 'offline'];
        const NEEDS_EMPLOYEE = ['absence', 'late', 'arrival', 'external_support', 'support_end', 'assignment'];

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
            // كل الأنواع مرتبطة بفريق إلا دعم الاحتياط (external_support بلا فريق هدف)
            const teamId = canonicalTeamId(ev.supportTargetTeamId || ev.teamId);
            if (!teamId && type !== 'external_support') {
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
        const teamOpenOf = (teamId) => {
            const f = folded.find(x => !x.entityId && canonicalTeamId(x.teamId) === teamId);
            return f ? f.open : [];
        };

        for (const ev of events) {
            const type = ev.type;
            const employee = ev.employeeName || ev.employeeId || null;
            const teamId = canonicalTeamId(ev.supportTargetTeamId || ev.teamId);
            const isTeamEvent = (type === 'offline' || type === 'ready' || type === 'missing');

            // منع التكرار/الإغلاق الفارغ (idempotency تشغيلية)
            if (employee) {
                const open = openOf(employee);
                if (['absence', 'late'].includes(type) && open.some(o => o.event_type === type)) continue;
                if (type === 'external_support' && open.some(o => (o.event_type === 'external_support' || o.event_type === 'volunteer_support') && canonicalTeamId(o.team_id) === teamId)) continue;
                if (type === 'assignment' && open.some(o => o.event_type === 'assignment' && canonicalTeamId(o.team_id) === teamId)) continue;
                if (type === 'arrival' && !open.some(o => o.event_type === 'absence' || o.event_type === 'late')) continue;
                if (type === 'support_end' && !open.some(o => o.event_type === 'external_support' || o.event_type === 'volunteer_support')) continue;
            } else if (isTeamEvent) {
                const open = teamOpenOf(teamId);
                if (type === 'offline' && open.some(o => o.event_type === 'offline')) continue;
                if (type === 'ready' && !open.some(o => o.event_type === 'offline' || o.event_type === 'missing')) continue;
            }

            const id = await this.storage.appendOperationalEvent({
                shiftId, shiftDate, shiftType, domain: DOMAIN,
                entityId: isTeamEvent ? null : employee,
                entityName: isTeamEvent ? null : employee,
                teamId, center: ev.center || null,
                eventType: type,
                reason: ev.reason || null,
                readinessBasis: type === 'external_support' ? 'external_support' : (type === 'ready' ? 'direct' : null),
                payload: { source: 'completion-person-events' },
                actorId, actorName, createdAt: at
            });
            out.push({ id, eventType: type, entityId: employee, teamId });
            // حدّث الطيّ المحلي حتى تتسلسل قرارات الإغلاق/الفتح داخل نفس الدفعة
            const synth = { id, domain: DOMAIN, entity_id: isTeamEvent ? null : employee, entity_name: isTeamEvent ? null : employee, team_id: teamId, event_type: type, reason: ev.reason || null, created_at: at };
            const key = isTeamEvent ? '(team:' + (teamId || '') + ')' : employee;
            let f = folded.find(x => (isTeamEvent ? (!x.entityId && canonicalTeamId(x.teamId) === teamId) : x.entityId === employee));
            if (!f) {
                f = { entityId: isTeamEvent ? null : employee, entityName: isTeamEvent ? null : employee, teamId, open: [], lastEvent: null, closedCount: 0, corrections: 0 };
                folded.push(f);
            }
            const CLOSES = { arrival: ['absence', 'late'], support_end: ['external_support', 'volunteer_support'], ready: ['missing', 'offline'] };
            const closes = CLOSES[type];
            if (closes) {
                const idx = f.open.findIndex(o => closes.includes(o.event_type));
                if (idx >= 0) f.open.splice(idx, 1);
            } else {
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
    async deriveTeamReadiness(shiftId) {
        const emptyWf = {
            totalStaff: 0, totalRequired: 0, totalCars: 0,
            readyTeams: 0, missingTeams: 0, offlineTeams: 0, pendingTeams: 0,
            supporters: 0, absentees: 0, readinessRate: null
        };
        if (!shiftId) return { shiftId: shiftId || null, teams: {}, workforce: emptyWf };
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { shiftId, teams: {}, workforce: emptyWf };

        const isNight = String(shift.shift_type || '').includes('ليل');
        const isoDate = toIsoDate(shift.shift_date);
        const validCodes = isNight
            ? [...NIGHT_ONLY_CODES, ...SHARED_CODES]
            : [...DAY_ONLY_CODES, ...SHARED_CODES];

        // الكادر المجدول لهذا التاريخ (رموز دوام فقط — الإجازات/الغياب المجدول ليس كادرًا)
        const teamRows = await this.storage.all(
            'SELECT id, name, center, team_type, requiredPersonnel FROM teams WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
        );
        let rosterRows = [];
        try {
            rosterRows = await this.storage.all(
                `SELECT sr.team_id, sr.shift_code, e.name, e.job_title
                 FROM shift_roster sr JOIN employees e ON e.id = sr.employee_id
                 WHERE sr.shift_date = ? AND e.is_active = 1`, [isoDate]
            );
        } catch (_) { rosterRows = []; }
        const crewByTeamId = {};
        for (const r of rosterRows) {
            const code = String(r.shift_code || '').toUpperCase();
            if (!code || OFF_CODES.includes(code) || !validCodes.includes(code)) continue;
            (crewByTeamId[r.team_id] = crewByTeamId[r.team_id] || []).push({ name: r.name, jobTitle: r.job_title || null });
        }

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

        const teams = {};
        const wf = { ...emptyWf };
        for (const t of teamRows) {
            const required = t.requiredPersonnel || 2;
            const crew = crewByTeamId[t.id] || [];
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
                        name: c.name, reason: openAbs.reason || null,
                        since: openAbs.created_at, recordedBy: openAbs.actor_name || null,
                        type: openAbs.event_type
                    });
                    members.push({ name: c.name, role: 'base', state: openAbs.event_type });
                } else if (openAway) {
                    members.push({ name: c.name, role: 'base', state: 'assignment' });
                } else {
                    activeCount++;
                    members.push({ name: c.name, role: 'base', state: 'active' });
                }
            }

            // الداعمون (دعم مفتوح لهذا الفريق) + المكلَّفون إلى هذا الفريق
            const supporters = [];
            const seenSupport = new Set();
            for (const f of folded) {
                if (!f.entityId) continue;
                for (const o of f.open) {
                    if ((o.event_type === 'external_support' || o.event_type === 'volunteer_support') && canonicalTeamId(o.team_id) === t.name) {
                        if (seenSupport.has(f.entityId)) continue;
                        seenSupport.add(f.entityId);
                        supporters.push({ name: f.entityId, role: 'support', state: 'external_support', since: o.created_at, recordedBy: o.actor_name || null });
                    } else if (o.event_type === 'assignment' && canonicalTeamId(o.team_id) === t.name && !crewNames.has(f.entityId)) {
                        if (seenSupport.has(f.entityId)) continue;
                        seenSupport.add(f.entityId);
                        supporters.push({ name: f.entityId, role: 'support', state: 'assignment', since: o.created_at, recordedBy: o.actor_name || null });
                    }
                }
            }
            activeCount += supporters.length;
            members.push(...supporters);

            const vehId = vehByTeamId[String(t.id)] || null;
            const vehSt = vehId ? (vehStatus[vehId] || null) : null;
            const vehicleOk = !vehSt || (vehSt !== 'breakdown' && vehSt !== 'out_of_service');

            const openTeamEv = teamOpen[t.name] || [];
            const explicitOffline = openTeamEv.some(o => o.event_type === 'offline');
            const hasRoster = crew.length > 0;

            let status;
            if (explicitOffline) {
                status = 'offline';
            } else if (!vehicleOk) {
                status = 'offline';
            } else if (hasRoster) {
                if (activeCount === 0) status = 'offline';
                else if (activeCount < required) status = 'missing';
                else status = 'ready';
            } else if (absentees.length > 0) {
                status = 'missing'; // نقص مسجل بلا كادر مجدول معروف
            } else if (supporters.length > 0) {
                status = activeCount >= required ? 'ready' : 'missing';
            } else {
                // بلا كادر وبلا أحداث أشخاص: آخر قرار فريق من السجل (توافق قديم) أو بانتظار
                const last = teamLastEvent[t.name];
                status = (last && ['ready', 'missing', 'offline'].includes(last.event_type)) ? last.event_type : 'pending';
            }

            teams[t.name] = {
                status,
                activeCount,
                requiredPersonnel: required,
                center: t.center || null,
                members,
                absentees,
                vacant: Math.max(0, required - activeCount),
                vehicleId: vehId,
                vehicleStatus: vehSt,
                vehicleOk
            };

            // مجاميع القوى (تُشتق هنا فقط)
            wf.totalStaff += activeCount;
            wf.totalRequired += required;
            wf.supporters += supporters.length;
            wf.absentees += absentees.length;
            if (status === 'ready') wf.readyTeams++;
            else if (status === 'missing') wf.missingTeams++;
            else if (status === 'offline') wf.offlineTeams++;
            else wf.pendingTeams++;
        }

        // السيارات العاملة = مركبات معينة بحالة غير متعطلة/خارج الخدمة
        for (const vehId of Object.keys(vehAssignByVeh)) {
            const st = vehStatus[vehId];
            if (st !== 'breakdown' && st !== 'out_of_service') wf.totalCars++;
        }
        const decided = wf.readyTeams + wf.missingTeams + wf.offlineTeams;
        wf.readinessRate = decided > 0 ? Math.round((wf.readyTeams / decided) * 100) : null;

        return { shiftId, teams, workforce: wf };
    }

    /** VA: نفس الاشتقاق بصيغة موجزة للمسارات الإحصائية. */
    async deriveWorkforce(shiftId) {
        return this.deriveTeamReadiness(shiftId);
    }

    /**
     * VA: القوى المتاحة للدعم — موظفون مجدولون (رمز دوام لهذه المناوبة)
     * ليسوا نشطين حاليًا في أي فريق مشتق، وبلا غياب/تأخر/خروج مفتوح.
     * يشمل حوض الاحتياط (external_support مفتوح بلا فريق هدف).
     */
    async getAvailableSupport(shiftId) {
        if (!shiftId) return { shiftId: shiftId || null, supporters: [] };
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { shiftId, supporters: [] };
        const isNight = String(shift.shift_type || '').includes('ليل');
        const isoDate = toIsoDate(shift.shift_date);
        const validCodes = isNight
            ? [...NIGHT_ONLY_CODES, ...SHARED_CODES]
            : [...DAY_ONLY_CODES, ...SHARED_CODES];

        let scheduled = [];
        try {
            scheduled = await this.storage.all(
                `SELECT e.id AS employee_id, e.employee_code, e.name, e.job_title, sr.team_id, t.name AS team_name
                 FROM shift_roster sr
                 JOIN employees e ON e.id = sr.employee_id
                 LEFT JOIN teams t ON t.id = sr.team_id
                 WHERE sr.shift_date = ? AND e.is_active = 1`, [isoDate]
            );
        } catch (_) { scheduled = []; }
        scheduled = scheduled.filter(r => {
            const code = String(r.shift_code || '').toUpperCase();
            return code && !OFF_CODES.includes(code) && validCodes.includes(code);
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
                if (m.state === 'active' || m.state === 'external_support' || m.state === 'assignment') busy.add(m.name);
            }
        }

        const supporters = [];
        for (const s of scheduled) {
            const open = openByEntity[s.name] || [];
            if (open.some(o => o.event_type === 'absence' || o.event_type === 'late' || o.event_type === 'exit')) continue;
            if (busy.has(s.name)) continue;
            supporters.push({
                name: s.name,
                employeeCode: s.employee_code || null,
                jobTitle: s.job_title || null,
                team: s.team_name || null
            });
        }
        return { shiftId, supporters };
    }
}

module.exports = StaffingEventsService;
