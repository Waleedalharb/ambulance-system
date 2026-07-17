/**
 * ShiftService — مالك دورة حياة المناوبة وبياناتها (Slice 2)
 * ═══════════════════════════════════════════════════════════
 * Single writer for everything that mutates a shift row:
 *   - startShift      (ACTIVE creation, auto-archives previous — via ShiftManager)
 *   - endShift        (ACTIVE → PENDING_HANDOVER — via ShiftManager)
 *   - markArchived    (any → ARCHIVED status transition; snapshot stays with
 *                      the archive engine until the dedicated Archive slice)
 *   - saveShiftData   (data-columns upsert: centers/vehicles/fuel/notes —
 *                      replaces the dead JSON write path, X2)
 *   - deleteShift     (admin-only hard delete)
 *
 * Every method emits its domain event AFTER persistence succeeds.
 * Routes must NOT broadcast shift WS messages directly — the engine's
 * broadcast subscriber translates events to the legacy message shapes.
 */

class ShiftService {
    /**
     * @param {Object} deps
     * @param {Object} deps.shiftManager - existing ShiftManager (lifecycle logic)
     * @param {Object} deps.storage      - StorageAdapter (SQLite gateway)
     * @param {Object} deps.bus          - domain event bus (owned by the engine)
     */
    constructor({ shiftManager, storage, bus }) {
        this.manager = shiftManager;
        this.storage = storage;
        this.bus = bus;
    }

    _actor(user) {
        return {
            user_id: user ? user.id : null,
            user_name: user ? (user.name || user.username) : 'system'
        };
    }

    /** بدء مناوبة جديدة → ShiftStarted */
    async startShift(shiftType, user) {
        const result = await this.manager.startShift(shiftType, user);
        if (result && result.success) {
            this.bus.emit('ShiftStarted', {
                shift_id: result.shiftId,
                shift_type: result.type,
                date: result.date,
                ...this._actor(user)
            });
        }
        return result;
    }

    /** إنهاء المناوبة ACTIVE → PENDING_HANDOVER → ShiftEnded (bus-only: no legacy WS message existed) */
    async endShift(shiftId, user, notes = '') {
        const result = await this.manager.endShift(shiftId, user, notes);
        if (result && result.success) {
            this.bus.emit('ShiftEnded', {
                shift_id: shiftId,
                notes: notes || '',
                ...this._actor(user)
            });
        }
        return result;
    }

    /**
     * الانتقال إلى ARCHIVED (ملكية الحالة فقط — إنشاء الـ snapshot يبقى مع
     * محرك الأرشفة حتى شريحة الأرشفة المستقلة) → ShiftArchived
     */
    async markArchived(shiftId, user, snapshotHash = null, reason = '') {
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { success: false, error: 'المناوبة غير موجودة' };

        await this.storage.archiveShift(shiftId);
        await this.storage.logAudit({
            shiftId,
            userId: user ? user.id : null,
            userName: user ? (user.name || user.username) : 'system',
            action: 'shift_archived',
            detail: reason || 'أرشفة المناوبة',
            type: 'shifts'
        });

        this.bus.emit('ShiftArchived', {
            shift_id: shiftId,
            snapshot_hash: snapshotHash || null,
            ...this._actor(user)
        });
        return { success: true };
    }

    /**
     * حفظ بيانات المناوبة (upsert لأعمدة البيانات فقط — لا يلمس status أبداً).
     * يستبدل مسار الكتابة الميت إلى shift-data.json (إصلاح X2) → ShiftUpdated
     * @param {Object} shift - كائن مناوبة بشكل JSON القديم (camelCase)
     */
    async saveShiftData(shift) {
        if (!shift || !shift.id) throw new Error('saveShiftData: shift.id مطلوب');
        const id = shift.id;
        const existing = await this.storage.getShiftById(id);
        const payload = [
            shift.shiftName || shift.shift_name || '',
            shift.shiftDate || shift.shift_date || '',
            shift.shiftTime || shift.shift_time || '',
            shift.shiftType || shift.shift_type || '',
            shift.shiftDay || shift.shift_day || '',
            shift.startTime || shift.start_time || '',
            shift.totalReports != null ? shift.totalReports : (shift.total_reports || 0),
            JSON.stringify(shift.rapidLocations || {}),
            JSON.stringify(shift.centersData || {}),
            JSON.stringify(shift.vehicleData || {}),
            JSON.stringify(shift.fuelData || {}),
            shift.generalNotes != null ? shift.generalNotes : (shift.general_notes || ''),
            shift.lastUpdate || new Date().toISOString()
        ];

        if (existing) {
            // أعمدة البيانات فقط — دورة الحياة (status/archived_at) مملوكة لمساراتها
            await this.storage.db.run(
                `UPDATE shifts SET shift_name=?, shift_date=?, shift_time=?, shift_type=?, shift_day=?, start_time=?,
                 total_reports=?, rapid_locations=?, centers_data=?, vehicle_data=?, fuel_data=?, general_notes=?, last_update=?
                 WHERE id=?`,
                [...payload, id]
            );
        } else {
            // سجل مناوبة تلقائي جديد (وضع update-shift-data التاريخي)
            await this.storage.db.run(
                `INSERT INTO shifts (id, shift_name, shift_date, shift_time, shift_type, shift_day, start_time,
                 total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, ...payload]
            );
        }

        this.bus.emit('ShiftUpdated', { shift_id: id, ...this._actor(null) });
        return { success: true, shiftId: id, lastSaved: payload[12] };
    }

    /** حذف مناوبة (admin فقط — يفرضه المسار) */
    async deleteShift(shiftId) {
        const result = await this.storage.db.run('DELETE FROM shifts WHERE id = ?', [shiftId]);
        return { success: true, deleted: result.changes > 0 };
    }
}

module.exports = ShiftService;
