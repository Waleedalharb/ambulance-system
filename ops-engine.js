/**
 * Operations Engine v2.0 — The Heart of the Platform
 * ═══════════════════════════════════════════════════════════
 * Architecture:
 *   Frontend → Engine → StorageAdapter → SQLite
 *   No direct SQLite/JSON access from Endpoints or Managers.
 */

const StorageAdapter = require('./storage-adapter');
const { createEventBus } = require('./services/event-bus');
const ShiftService = require('./services/shift-service');
const {
    ShiftManager,
    ReportManager,
    CompletionManager,
    getCurrentShiftType,
    getSaudiDateString
} = require('./managers');

class OperationsEngine {
    /**
     * @param {Object} options
     * @param {Object} options.db - better-sqlite3 database instance
     * @param {string} options.storagePath - Path for data directory
     */
    constructor(options = {}) {
        this.storagePath = options.storagePath || './data';

        // Storage Adapter — single gateway to SQLite
        this.storage = options.db ? new StorageAdapter(options.db) : null;

        // Managers — each handles one domain
        this.shifts = this.storage ? new ShiftManager(this.storage) : null;
        this.reports = this.storage ? new ReportManager(this.storage) : null;
        this.completions = this.storage ? new CompletionManager(this.storage) : null;

        // ─── Slice 1: Event-driven write path ───
        // The engine OWNS the internal domain Event Bus. Services emit
        // domain events into it; subscribers (broadcast, indicators,
        // timeline) are registered here in the engine wiring.
        this.bus = createEventBus();

        // Slice 2: ShiftService — single writer for shift lifecycle + shift data (X2)
        this.shiftService = this.storage
            ? new ShiftService({ shiftManager: this.shifts, storage: this.storage, bus: this.bus })
            : null;

        // Serializes SQLite write transactions across ALL services
        // (single shared connection — interleaved BEGINs would fail).
        this._txQueue = Promise.resolve();
        this._eventsWired = false;
    }

    // ─── Transactions ───
    /**
     * Run fn inside a SQLite transaction (BEGIN → fn → COMMIT, ROLLBACK
     * on throw). Transactions are serialized through an in-process queue
     * because all services share one better-sqlite3 connection.
     */
    runInTransaction(fn) {
        const exec = async () => {
            const dbm = this.storage && this.storage.db;
            const hasTx = dbm && typeof dbm.beginTransaction === 'function';
            if (hasTx) dbm.beginTransaction();
            try {
                const out = await fn();
                if (hasTx) dbm.commitTransaction();
                return out;
            } catch (err) {
                if (hasTx) {
                    try { dbm.rollbackTransaction(); } catch (_) { /* already rolled back */ }
                }
                throw err;
            }
        };
        const run = this._txQueue.then(exec);
        this._txQueue = run.catch(() => { /* keep the queue alive after failures */ });
        return run;
    }

    // ─── Event Wiring ───
    /**
     * Register the ONE broadcast subscriber that maps domain events to
     * the EXISTING broadcast() message types/payloads the frontend
     * already expects. server.js passes its own broadcast function here.
     * Idempotent — safe to call once after engine creation.
     *
     * @param {Object} deps
     * @param {Function} deps.broadcast - server.js broadcast(data)
     */
    wireEvents({ broadcast } = {}) {
        if (this._eventsWired) return;
        this._eventsWired = true;

        const safeBroadcast = (data) => {
            if (typeof broadcast !== 'function') return;
            try {
                broadcast(data);
            } catch (err) {
                console.error('[OpsEngine] Broadcast subscriber error:', err.message);
            }
        };

        // Dispatch log created → existing 'new_report' message
        this.bus.on('DispatchLogCreated', (e) => {
            safeBroadcast({ type: 'new_report', center: e.center, unit: e.unit, shiftId: e.shift_id });
        });

        // Dispatch undone → existing 'report_undone' message
        this.bus.on('DispatchUndone', (e) => {
            safeBroadcast({ type: 'report_undone', center: e.center, unit: e.unit, shiftId: e.shift_id });
        });

        // Completion saved → existing 'completion_updated' message type
        this.bus.on('CompletionUpdated', (e) => {
            safeBroadcast({
                type: 'completion_updated',
                shiftId: e.shift_id,
                shiftDate: e.shift_date,
                shiftType: e.shift_type
            });
        });

        // Team ready/not-ready flip → existing 'team_status_changed' message type
        this.bus.on('CenterStatusChanged', (e) => {
            safeBroadcast({
                type: 'team_status_changed',
                teamId: e.team,
                status: e.to === 'مكتمل' ? 'ready' : 'missing',
                shiftDate: e.shift_date,
                shiftType: e.shift_type
            });
        });

        // ─── Slice 2: Shift lifecycle events → legacy WS shapes (byte-identical) ───

        // ShiftStarted → existing 'shift_started' message (was broadcast by the route)
        this.bus.on('ShiftStarted', (e) => {
            safeBroadcast({ type: 'shift_started', shiftId: e.shift_id, shiftType: e.shift_type });
        });

        // ShiftUpdated → existing 'shift_updated' message (was broadcast by update-shift-data)
        this.bus.on('ShiftUpdated', (e) => {
            safeBroadcast({ type: 'shift_updated', message: 'تم تحديث بيانات المناوبة', shiftId: e.shift_id });
        });

        // ShiftArchived → existing 'shift_archived' message (was broadcast by handover-approve)
        this.bus.on('ShiftArchived', (e) => {
            safeBroadcast({
                type: 'shift_archived',
                shiftId: e.shift_id,
                message: '✅ تمت أرشفة المناوبة بنجاح',
                hash: e.snapshot_hash
            });
        });

        // ShiftEnded: bus-only — no legacy WS message existed for end-shift

        // ─── Slice 4: Positioning events → legacy WS shapes (byte-identical) ───

        // PositioningStarted → existing 'peak_plan_added' message (was broadcast by the route)
        this.bus.on('PositioningStarted', (e) => {
            safeBroadcast({
                type: 'peak_plan_added',
                message: 'تم إضافة خطة ذروة جديدة: ' + e.title,
                plan: e.plan
            });
        });

        // PositioningEnded → existing 'peak_plan_deleted' message (was broadcast by the route)
        this.bus.on('PositioningEnded', (e) => {
            safeBroadcast({ type: 'peak_plan_deleted', message: 'تم حذف خطة ذروة', planId: e.plan_id });
        });
    }

    // ─── Initialization ───
    async init() {
        if (!this.storage) {
            throw new Error('Storage adapter not available — cannot initialize Operations Engine');
        }
        console.log('[OpsEngine] Initialized — SQLite via StorageAdapter');
        return this;
    }

    // ─── Health Check ───
    async getHealth() {
        if (!this.storage) {
            return { status: 'unavailable', error: 'Storage adapter not initialized' };
        }

        const activeShift = await this.shifts.getActiveShift();

        return {
            status: 'ok',
            engine: 'OperationsEngine v2.0',
            currentDate: getSaudiDateString(),
            currentShiftType: getCurrentShiftType(),
            hasActiveShift: !!activeShift,
            activeShift: activeShift ? {
                id: activeShift.id,
                type: activeShift.shift_type,
                date: activeShift.shift_date,
                status: activeShift.status
            } : null
        };
    }
}

// ═══════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════
let engineInstance = null;

async function createEngine(options) {
    engineInstance = new OperationsEngine(options);
    await engineInstance.init();
    return engineInstance;
}

function getEngine() {
    if (!engineInstance) {
        throw new Error('Operations Engine not initialized. Call createEngine() first.');
    }
    return engineInstance;
}

module.exports = {
    OperationsEngine,
    createEngine,
    getEngine,
    StorageAdapter,
    ShiftManager,
    ReportManager,
    CompletionManager
};