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

        // ─── Slice 5: Notes events → legacy WS shapes (byte-identical) ───

        // ShiftNoteAdded (bulk register save) → existing 'shift_note_added' message
        this.bus.on('ShiftNoteAdded', (e) => {
            safeBroadcast({ type: 'shift_note_added', message: 'تم تحديث سجل الملاحظات' });
        });

        // ─── Slice 6: Forms events → legacy WS shapes (byte-identical per form_type) ───
        const FORM_WS = {
            incident:      { type: 'incident_added',      message: () => 'تم إضافة حادث جديد' },
            senior_shift:  { type: 'senior_shift_added',  message: () => 'تم إضافة مناوبة كبار الضباط' },
            e_case:        { type: 'e_case_added',        message: () => 'تم إضافة حالة طوارئ جديدة' },
            escalation:    { type: 'escalation_added',    message: () => 'تم إضافة بلاغ تصعيد جديد' },
            daily_report:  { type: 'daily_report_added',  message: () => 'تم إضافة تقرير يومي جديد' },
            air_ambulance: { type: 'air_ambulance_saved', message: (e) => 'بلاغ إسعاف جوي جديد: ' + (e.record && e.record.reportNumber) }
        };

        // FormSubmitted → existing '<type>_added' / 'air_ambulance_saved' message
        this.bus.on('FormSubmitted', (e) => {
            const m = FORM_WS[e.form_type];
            if (!m) return;
            safeBroadcast({ type: m.type, message: m.message(e), record: e.record });
        });

        // ─── Event Activation Slice (Catalog D-3..D-7) → legacy WS shapes (byte-identical) ───

        // ShiftDeleted (Catalog D-3) → existing 'shift_deleted' message
        this.bus.on('ShiftDeleted', (e) => {
            safeBroadcast({ type: 'shift_deleted', message: 'تم حذف المناوبة', shiftId: e.shift_id });
        });

        // PositioningUpdated (Catalog D-4) → existing 'peak_plan_updated' message
        this.bus.on('PositioningUpdated', (e) => {
            safeBroadcast({ type: 'peak_plan_updated', message: 'تم تحديث خطة الذروة', plan: e.plan });
        });

        // ShiftNoteDeleted (Catalog D-5) → existing 'shift_note_deleted' message
        this.bus.on('ShiftNoteDeleted', (e) => {
            safeBroadcast({ type: 'shift_note_deleted', message: 'تم حذف ملاحظة من المناوبة', shiftId: e.shift_id, noteId: e.note_id });
        });

        // FormDeleted (Catalog D-6) → existing '<type>_deleted' message per form_type
        const FORM_DELETED_WS = {
            incident:      { type: 'incident_deleted',      message: 'تم حذف حادث' },
            senior_shift:  { type: 'senior_shift_deleted',  message: 'تم حذف مناوبة كبار الضباط' },
            e_case:        { type: 'e_case_deleted',        message: 'تم حذف حالة طوارئ' },
            escalation:    { type: 'escalation_deleted',    message: 'تم حذف بلاغ تصعيد' },
            daily_report:  { type: 'daily_report_deleted',  message: 'تم حذف تقرير يومي' },
            air_ambulance: { type: 'air_ambulance_deleted', message: 'تم حذف بلاغ إسعاف جوي' }
        };
        this.bus.on('FormDeleted', (e) => {
            const m = FORM_DELETED_WS[e.form_type];
            if (!m) return;
            safeBroadcast({ type: m.type, message: m.message, recordId: e.form_id });
        });

        // FormsCleared (Catalog D-7) → existing 'air_ambulance_cleared' message
        this.bus.on('FormsCleared', (e) => {
            if (e.form_type !== 'air_ambulance') return;
            safeBroadcast({ type: 'air_ambulance_cleared', message: 'تم حذف جميع بلاغات الإسعاف الجوي' });
        });

        // ─── OV-S7: مشتركا التدقيق المركزي والجدول الزمني ───
        // OV-S5-01: بلاغات الإرسالية (إنشاء/تراجع) وحفظ التكميل لم تكن تُدقَّق
        // إطلاقاً. OV-S9-05: shift_timeline_events بقي فارغاً لأن لا كاتب له.
        // ملاحظة مقصودة: دورة حياة المناوبة (بدء/إنهاء/أرشفة) تُدقَّق أصلاً في
        // audit_log عبر ShiftManager/ShiftService (storage.logAudit) — الاشتراك
        // فيها هنا كان سيضاعف السجلات، لذا يغطي مشترك التدقيق الأحداث اليتيمة فقط.
        const dbm = this.storage && this.storage.db;

        const safeAudit = (entry) => {
            if (!dbm || !dbm.AuditLog) return;
            Promise.resolve(dbm.AuditLog.create(entry)).catch((err) => {
                console.error('[OpsEngine] Audit subscriber error:', err.message);
            });
        };

        const safeTimeline = (entry) => {
            if (!dbm || !dbm.ShiftTimelineEvents || !entry.shift_id) return;
            Promise.resolve(dbm.ShiftTimelineEvents.create(entry)).catch((err) => {
                console.error('[OpsEngine] Timeline subscriber error:', err.message);
            });
        };

        // بلاغ إرسالية جديد → audit (report_created) + timeline (report_received)
        this.bus.on('DispatchLogCreated', (e) => {
            safeAudit({
                shift_id: e.shift_id,
                user_id: e.actor ? e.actor.id : null,
                user_name: e.actor ? e.actor.name : null,
                action: 'report_created',
                detail: `بلاغ جديد — ${e.center} / ${e.unit}`,
                type: 'reports'
            });
            safeTimeline({
                shift_id: e.shift_id,
                event_type: 'report_received',
                event_title: `بلاغ وارد — ${e.center} / ${e.unit}`,
                event_description: `العدد الجديد: ${e.new_count} (إجمالي المناوبة: ${e.total_reports})`,
                event_data: { center: e.center, unit: e.unit, new_count: e.new_count, total_reports: e.total_reports },
                created_by: e.actor ? e.actor.id : null,
                created_by_name: e.actor ? e.actor.name : null
            });
        });

        // تراجع عن بلاغ → audit (report_undone)
        this.bus.on('DispatchUndone', (e) => {
            safeAudit({
                shift_id: e.shift_id,
                user_id: e.actor ? e.actor.id : null,
                user_name: e.actor ? e.actor.name : null,
                action: 'report_undone',
                detail: `تراجع عن بلاغ — ${e.center} / ${e.unit}`,
                type: 'reports'
            });
        });

        // حفظ تكميل → audit (completion_saved)
        this.bus.on('CompletionUpdated', (e) => {
            safeAudit({
                shift_id: e.shift_id,
                user_id: e.actor ? e.actor.id : null,
                user_name: e.actor ? e.actor.name : null,
                action: 'completion_saved',
                detail: `حفظ تكميل المناوبة (${e.shift_type || ''})`,
                type: 'completions'
            });
        });

        // بدء المناوبة → timeline (start)
        this.bus.on('ShiftStarted', (e) => {
            safeTimeline({
                shift_id: e.shift_id,
                event_type: 'start',
                event_title: `بدء المناوبة (${e.shift_type || ''})`,
                created_by: e.user_id,
                created_by_name: e.user_name
            });
        });

        // إنهاء المناوبة → timeline (end — بانتظار اعتماد التسليم)
        this.bus.on('ShiftEnded', (e) => {
            safeTimeline({
                shift_id: e.shift_id,
                event_type: 'end',
                event_title: 'إنهاء المناوبة (بانتظار اعتماد التسليم)',
                event_description: e.notes || null,
                created_by: e.user_id,
                created_by_name: e.user_name
            });
        });

        // أرشفة المناوبة → timeline (end — الاعتماد النهائي)
        this.bus.on('ShiftArchived', (e) => {
            safeTimeline({
                shift_id: e.shift_id,
                event_type: 'end',
                event_title: 'اعتماد التسليم وأرشفة المناوبة',
                created_by: e.user_id,
                created_by_name: e.user_name
            });
        });

        // ملاحظة مناوبة → timeline (note_added)
        this.bus.on('ShiftNoteAdded', (e) => {
            safeTimeline({
                shift_id: e.shift_id,
                event_type: 'note_added',
                event_title: 'تحديث سجل الملاحظات',
                event_description: `عدد الملاحظات: ${e.count}`
            });
        });

        // نموذج محفوظ → timeline (form_filed)
        const FORM_TITLES = {
            incident: 'حادث',
            senior_shift: 'مناوبة كبار الضباط',
            e_case: 'حالة طوارئ',
            escalation: 'بلاغ تصعيد',
            daily_report: 'تقرير يومي',
            air_ambulance: 'بلاغ إسعاف جوي'
        };
        this.bus.on('FormSubmitted', (e) => {
            safeTimeline({
                shift_id: e.shift_id,
                event_type: 'form_filed',
                event_title: `نموذج محفوظ — ${FORM_TITLES[e.form_type] || e.form_type}`,
                event_data: { form_type: e.form_type, form_id: e.form_id }
            });
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