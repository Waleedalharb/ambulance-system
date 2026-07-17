/**
 * PositioningService — مالك التمركزات الوحيد (Slice 4)
 * ═══════════════════════════════════════════════════════════
 * Single writer for peak_plans (خطط التمركز): list / create / update / remove.
 * Routes delegate and keep their exact legacy response shapes; domain events
 * fire AFTER the write succeeds, and the engine's broadcast subscriber maps
 * them to the legacy WS payloads (peak_plan_added / peak_plan_deleted).
 *
 * The store stays the unified peak_plans table (archive slice): rows keyed by
 * their string ids, shift_id stamped from the active shift on create, and the
 * archive engine's _getPositioning collector reads the same table — unchanged.
 *
 * Documented exceptions (DOMAIN-MODEL §10.2 د catalogues only Started/Ended):
 *  - update has no catalogued domain event — the legacy 'peak_plan_updated'
 *    broadcast stays in the route until the catalog gains PositioningUpdated
 *    (same status as ShiftDeleted in Slice 2).
 *  - remove emits PositioningEnded only when a row actually existed. The
 *    legacy route broadcast even for no-op deletes; events are facts, and no
 *    frontend listener exists for the message (loadPeakPlans is undefined),
 *    so this micro-deviation has zero observable effect.
 */

class PositioningService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db              - db module (raw run/get/all)
     * @param {Object} deps.bus             - domain event bus (owned by the engine)
     * @param {Function} deps.getActiveShiftId - resolves the active shift id (or null)
     */
    constructor({ db, bus, getActiveShiftId }) {
        this.db = db;
        this.bus = bus;
        this.getActiveShiftId = getActiveShiftId;
    }

    _rowToJson(row) {
        let data = {};
        try { data = row.data ? JSON.parse(row.data) : {}; } catch (e) {}
        return { ...data, id: row.id, shiftId: row.shift_id };
    }

    /** قائمة خطط التمركز (نفس ترتيب المسار القديم) */
    async list() {
        const rows = await this.db.all('SELECT * FROM peak_plans ORDER BY created_at DESC, id DESC');
        return rows.map(r => this._rowToJson(r));
    }

    /** إنشاء خطة تمركز → PositioningStarted (بعد نجاح الحفظ) */
    async create(payload, user) {
        const { title, description, location, units, startTime, endTime, priority } = payload || {};
        const plan = {
            id: Date.now().toString(),
            title,
            description: description || '',
            location,
            units: units || [],
            startTime: startTime || '',
            endTime: endTime || '',
            priority: priority || 'عادي',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: (user && user.username) || 'unknown'
        };
        const shiftId = typeof this.getActiveShiftId === 'function' ? await this.getActiveShiftId() : null;
        await this.db.run('INSERT INTO peak_plans (id, shift_id, data) VALUES (?, ?, ?)',
            [plan.id, shiftId != null ? shiftId : null, JSON.stringify(plan)]);
        this.bus.emit('PositioningStarted', { plan_id: plan.id, shift_id: shiftId, title: plan.title, plan });
        return plan;
    }

    /** تعديل خطة — بلا حدث domain (الكتالوج لا يعرف PositioningUpdated بعد) */
    async update(id, updates) {
        const row = await this.db.get('SELECT * FROM peak_plans WHERE id = ?', [id]);
        if (!row) return null;
        const plan = { ...this._rowToJson(row), ...updates, id: row.id };
        await this.db.run('UPDATE peak_plans SET data = ? WHERE id = ?', [JSON.stringify(plan), id]);
        return plan;
    }

    /** إنهاء/حذف تمركز → PositioningEnded فقط إذا وُجدت الخطة فعلاً */
    async remove(id) {
        const row = await this.db.get('SELECT id, shift_id FROM peak_plans WHERE id = ?', [id]);
        await this.db.run('DELETE FROM peak_plans WHERE id = ?', [id]);
        if (row) {
            this.bus.emit('PositioningEnded', { plan_id: id, shift_id: row.shift_id });
        }
        return true;
    }
}

module.exports = PositioningService;
