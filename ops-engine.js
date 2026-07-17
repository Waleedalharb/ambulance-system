/**
 * Operations Engine v2.0 — The Heart of the Platform
 * ═══════════════════════════════════════════════════════════
 * Architecture:
 *   Frontend → Engine → StorageAdapter → SQLite
 *   No direct SQLite/JSON access from Endpoints or Managers.
 */

const StorageAdapter = require('./storage-adapter');
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