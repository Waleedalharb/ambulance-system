/**
 * Completion Service — Owner of Shift Completions (Slice 1)
 * ═══════════════════════════════════════════════════════════
 * Write path: Route → CompletionService → SQLite transaction → COMMIT
 *             → domain events on the engine's Event Bus.
 *
 * This service REUSES the existing opsEngine CompletionManager logic
 * (no rewrites); it adds transaction boundaries, event emission, and
 * ready/not-ready (مكتمل/ناقص) status-change detection around it.
 * It never touches broadcast/WebSocket directly.
 */

class CompletionService {
    /**
     * @param {Object} deps
     * @param {Object} deps.engine - OperationsEngine instance
     * @param {Object} deps.bus    - Event bus owned by the engine
     */
    constructor({ engine, bus }) {
        if (!engine) throw new Error('CompletionService requires an OperationsEngine instance');
        if (!bus) throw new Error('CompletionService requires an event bus');
        this.engine = engine;
        this.bus = bus;
        // W1-B: late-bound StaffingEventsService (wired in server.js after both
        // services exist — same pattern as ArchiveService late binding).
        this.staffingEventsService = null;
    }

    /**
     * Save a shift completion (radio quick log).
     * Wraps CompletionManager.saveCompletion in a SQLite transaction.
     * After COMMIT:
     *   - always emits `CompletionUpdated`
     *   - additionally emits `CenterStatusChanged` for every team whose
     *     ready/not-ready (مكتمل/ناقص) classification changed versus the
     *     previously stored completion for the same team + shift.
     *
     * @param {Object} payload - { shiftType, shiftDate, teams, notes, shiftId }
     * @param {Object} [actor] - req.user ({ id, username, name, role })
     * @returns {Object} the SAME result object CompletionManager.saveCompletion returns
     */
    async saveCompletion(payload, actor = null) {
        const { shiftType, shiftDate, teams, notes, shiftId } = payload;

        // Snapshot the previously stored completion BEFORE overwriting,
        // so we can diff ready/not-ready classifications afterwards.
        const previous = await this.engine.completions.getLatestCompletion(shiftDate, shiftType);

        // W1-B: the event-translation diff must be against the previous
        // completion OF THIS SAME SHIFT (not another shift sharing the
        // date+type label) — otherwise a new shift starting with identical
        // statuses would silently produce zero events.
        const previousByShift = shiftId
            ? await this.engine.completions.getLatestByShiftId(shiftId)
            : null;

        // W1-B: ONE atomic transaction — compatibility write (shift_completions)
        // + operational events (operational_events) commit together or roll
        // back together. Events are appended ONLY when a real shift container
        // exists (shiftId); prep-mode saves (shiftId=null) keep the legacy
        // compatibility write only (events are shift-scoped by architecture).
        let appendedEvents = 0;
        const result = await this.engine.runInTransaction(async () => {
            const res = await this.engine.completions.saveCompletion(shiftId, shiftType, shiftDate, teams, notes, actor);
            if (res && res.success && shiftId && this.staffingEventsService && teams && typeof teams === 'object') {
                const tr = await this.staffingEventsService.appendCompletionEvents({
                    shiftId, shiftDate, shiftType,
                    teams,
                    previousTeams: (previousByShift && previousByShift.teams) || null,
                    actor,
                    createdAt: new Date().toISOString()
                });
                appendedEvents = tr.appended;
            }
            return res;
        });

        if (result && result.success) {
            const actorInfo = actor ? { id: actor.id, name: actor.name || actor.username } : null;

            this.bus.emit('CompletionUpdated', {
                shift_id: shiftId,
                shift_date: shiftDate,
                shift_type: shiftType,
                completion_id: result.completionId,
                actor: actorInfo
            });

            // W1-B: operational events were appended → notify live listeners
            // (additive SSE type; existing clients ignore unknown types).
            if (appendedEvents > 0) {
                this.bus.emit('StaffingEventsAppended', {
                    shift_id: shiftId,
                    shift_date: shiftDate,
                    shift_type: shiftType,
                    count: appendedEvents,
                    actor: actorInfo
                });
            }

            // Ready/not-ready (مكتمل/ناقص) diff per team.
            const prevTeams = (previous && previous.teams) || {};
            const newTeams = teams || {};
            for (const team of Object.keys(newTeams)) {
                // Only flag changes for teams that existed in the previous
                // completion — a first-ever save is not a "change".
                if (!Object.prototype.hasOwnProperty.call(prevTeams, team)) continue;

                const from = CompletionService._readyClass(prevTeams[team]);
                const to = CompletionService._readyClass(newTeams[team]);
                if (from !== to) {
                    this.bus.emit('CenterStatusChanged', {
                        shift_id: shiftId,
                        shift_date: shiftDate,
                        shift_type: shiftType,
                        team,
                        from,
                        to,
                        actor: actorInfo
                    });
                }
            }
        }
        return result;
    }

    /**
     * VA: حفظ أحداث الأشخاص (التدفق الجديد لشاشة التكميل).
     * Route → CompletionService → SQLite tx (أحداث + إسقاط توافقي مشتق) → COMMIT
     *   → CompletionUpdated + StaffingEventsAppended (+ CenterStatusChanged عند
     *   انقلاب تصنيف فريق موجود في الإسقاط السابق).
     * القرار مشتق سيرفريًا: بعد إلحاق الأحداث تُعاد كتابة الإسقاط التوافقي
     * من اشتقاق deriveTeamReadiness (وليس من قرار العميل).
     *
     * @param {Object} payload - { shiftType, shiftDate, events, notes, shiftId }
     * @param {Object} [actor]
     */
    async savePersonEvents(payload, actor = null) {
        const { shiftType, shiftDate, events, notes, shiftId } = payload;
        if (!this.staffingEventsService) {
            const err = new Error('StaffingEventsService unavailable');
            err.statusCode = 503;
            throw err;
        }
        if (!shiftId) {
            const err = new Error('لا توجد مناوبة نشطة - ابدأ مناوبة أولاً');
            err.statusCode = 400;
            throw err;
        }

        const previousByShift = await this.engine.completions.getLatestByShiftId(shiftId);

        let appendedEvents = 0;
        const result = await this.engine.runInTransaction(async () => {
            const tr = await this.staffingEventsService.appendPersonEvents({
                shiftId, shiftDate, shiftType,
                events: events || [],
                actor,
                createdAt: new Date().toISOString()
            });
            appendedEvents = tr.appended;

            // الإسقاط التوافقي: الحالات من الاشتقاق السيرفري + paramedics من
            // الإسقاط السابق دومًا (D2). تُكتب الفرق غير «pending» فقط أو التي
            // كانت موجودة سابقًا حتى لا يتضخم الإسقاط بفرق بلا بيانات.
            const derived = await this.staffingEventsService.deriveTeamReadiness(shiftId);
            const prevTeams = (previousByShift && previousByShift.teams) || {};
            const teams = {};
            for (const k of Object.keys(prevTeams)) teams[k] = { ...prevTeams[k] };
            for (const tName of Object.keys(derived.teams || {})) {
                const d = derived.teams[tName];
                if (!d || (d.status === 'pending' && !prevTeams[tName])) continue;
                const cur = teams[tName] || {};
                const absentee = (d.absentees && d.absentees[0]) || null;
                teams[tName] = {
                    ...cur,
                    status: d.status,
                    reason: absentee ? (absentee.reason || '') : (cur.reason || ''),
                    missingPerson: absentee ? absentee.name : '',
                    centerName: cur.centerName || d.center || undefined
                };
            }

            const res = await this.engine.completions.saveCompletion(shiftId, shiftType, shiftDate, teams, notes, actor);
            return res;
        });

        if (result && result.success) {
            const actorInfo = actor ? { id: actor.id, name: actor.name || actor.username } : null;

            this.bus.emit('CompletionUpdated', {
                shift_id: shiftId,
                shift_date: shiftDate,
                shift_type: shiftType,
                completion_id: result.completionId,
                actor: actorInfo
            });

            if (appendedEvents > 0) {
                this.bus.emit('StaffingEventsAppended', {
                    shift_id: shiftId,
                    shift_date: shiftDate,
                    shift_type: shiftType,
                    count: appendedEvents,
                    actor: actorInfo
                });
            }

            // انقلاب التصنيف مكتمل/ناقص لكل فريق كان موجودًا في الإسقاط السابق
            const prevTeams = (previousByShift && previousByShift.teams) || {};
            const latest = await this.engine.completions.getLatestByShiftId(shiftId);
            const newTeams = (latest && latest.teams) || {};
            for (const team of Object.keys(newTeams)) {
                if (!Object.prototype.hasOwnProperty.call(prevTeams, team)) continue;
                const from = CompletionService._readyClass(prevTeams[team]);
                const to = CompletionService._readyClass(newTeams[team]);
                if (from !== to) {
                    this.bus.emit('CenterStatusChanged', {
                        shift_id: shiftId,
                        shift_date: shiftDate,
                        shift_type: shiftType,
                        team,
                        from,
                        to,
                        actor: actorInfo
                    });
                }
            }
        }
        return { ...result, appended: appendedEvents };
    }

    /**
     * Latest completion for a shift date + type.
     * Same behavior as today's GET /api/completion/latest.
     *
     * @param {Object} query - { shiftDate, shiftType }
     * @returns {Object|null} normalized completion or null when none exists
     */
    async getLatest({ shiftDate, shiftType }) {
        return this.engine.completions.getLatestCompletion(shiftDate, shiftType);
    }

    /**
     * OV-S6-01: latest completion by shift_id (label-agnostic read).
     *
     * @param {number} shiftId
     * @returns {Object|null} normalized completion or null when none exists
     */
    async getLatestByShiftId(shiftId) {
        return this.engine.completions.getLatestByShiftId(shiftId);
    }

    /**
     * Classify a team entry as ready (مكتمل) or not-ready (ناقص).
     * The radio UI stores status 'ready' for complete teams; every other
     * status ('missing', 'offline', 'pending', ...) is not-ready.
     */
    static _readyClass(teamEntry) {
        return (teamEntry && teamEntry.status === 'ready') ? 'مكتمل' : 'ناقص';
    }
}

module.exports = CompletionService;
