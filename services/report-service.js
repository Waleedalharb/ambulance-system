/**
 * Report Service — Owner of the Dispatch Log (Slice 1)
 * ═══════════════════════════════════════════════════════════
 * Write path: Route → ReportService → SQLite transaction → COMMIT
 *             → domain event on the engine's Event Bus.
 *
 * This service REUSES the existing opsEngine ReportManager logic
 * (no rewrites); it only adds transaction boundaries and event
 * emission around it. It never touches broadcast/WebSocket directly.
 *
 * Read path: getCurrentData() builds the same shape that
 * GET /api/data has always served, extended with per-type counts
 * ({ "center|unit": { count, times[], types{} } })
 * but sourced from SQLite (reports + report_times for the ACTIVE shift)
 * instead of data/ambulance-data.json.
 */

class ReportService {
    /**
     * @param {Object} deps
     * @param {Object} deps.engine - OperationsEngine instance
     * @param {Object} deps.bus    - Event bus owned by the engine
     */
    constructor({ engine, bus }) {
        if (!engine) throw new Error('ReportService requires an OperationsEngine instance');
        if (!bus) throw new Error('ReportService requires an event bus');
        this.engine = engine;
        this.bus = bus;
    }

    /**
     * Create (increment) a dispatch-log report for a center/unit.
     * Wraps ReportManager.addReport in a SQLite transaction and emits
     * `DispatchLogCreated` after COMMIT.
     *
     * @param {Object} data
     * @param {string} data.center
     * @param {string} data.unit
     * @param {number} [data.count] - number of increments (default 1)
     * @param {string} [data.type]  - report type key (stored in report_times.type)
     * @param {number} data.shiftId - resolved by the route via ShiftManager
     * @param {Object} [actor] - req.user ({ id, username, name, role })
     * @returns {Object} the SAME result object ReportManager.addReport returns
     */
    async createReport({ center, unit, count = 1, shiftId, type }, actor = null) {
        const increments = (Number.isInteger(count) && count > 1) ? count : 1;

        const result = await this.engine.runInTransaction(async () => {
            let last = null;
            for (let i = 0; i < increments; i++) {
                last = await this.engine.reports.addReport(shiftId, center, unit, type);
                if (!last || !last.success) break;
            }
            return last;
        });

        if (result && result.success) {
            this.bus.emit('DispatchLogCreated', {
                shift_id: shiftId,
                center,
                unit,
                new_count: result.newCount,
                total_reports: result.totalReports,
                actor: actor ? { id: actor.id, name: actor.name || actor.username } : null
            });
        }
        return result;
    }

    /**
     * Undo the last dispatch-log report for a center/unit.
     * Wraps ReportManager.undoReport in a SQLite transaction and emits
     * `DispatchUndone` after COMMIT.
     *
     * @param {Object} data
     * @param {string} data.center
     * @param {string} data.unit
     * @param {number} data.shiftId
     * @param {Object} [actor]
     * @returns {Object} the SAME result object ReportManager.undoReport returns
     */
    async undoLastReport({ center, unit, shiftId }, actor = null) {
        const result = await this.engine.runInTransaction(async () => {
            return this.engine.reports.undoReport(shiftId, center, unit);
        });

        if (result && result.success) {
            this.bus.emit('DispatchUndone', {
                shift_id: shiftId,
                center,
                unit,
                new_count: result.newCount,
                total_reports: result.totalReports,
                actor: actor ? { id: actor.id, name: actor.name || actor.username } : null
            });
        }
        return result;
    }

    /**
     * Current dispatch data for the ACTIVE shift, from SQLite.
     * Shape matches data/ambulance-data.json field-for-field, plus types:
     *   { "<center>|<unit>": { count: <int>, times: [<string>, ...], types: { <type>: <int>, ... } } }
     *
     * @returns {Object} data map ({} when there is no active shift)
     */
    async getCurrentData() {
        const activeShift = await this.engine.shifts.getActiveShift();
        if (!activeShift) return {};

        const rows = await this.engine.storage.all(
            `SELECT r.id, r.center, r.unit, r.count, t.timestamp AS ts, t.type AS rtype
             FROM reports r
             LEFT JOIN report_times t ON t.report_id = r.id
             WHERE r.shift_id = ?
             ORDER BY r.id ASC, t.id ASC`,
            [activeShift.id]
        );

        const data = {};
        for (const row of rows) {
            const key = `${row.center}|${row.unit}`;
            if (!data[key]) {
                data[key] = { count: row.count || 0, times: [], types: {} };
            }
            if (row.ts) data[key].times.push(row.ts);
            if (row.rtype) data[key].types[row.rtype] = (data[key].types[row.rtype] || 0) + 1;
        }
        return data;
    }
}

module.exports = ReportService;
