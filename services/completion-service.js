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

        const result = await this.engine.runInTransaction(async () => {
            return this.engine.completions.saveCompletion(shiftId, shiftType, shiftDate, teams, notes, actor);
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
