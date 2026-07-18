/**
 * NotesService — مالك ملاحظات المناوبة الوحيد (Slice 5)
 * ═══════════════════════════════════════════════════════════
 * Single writer for shift_notes (سجل الملاحظات التشغيلية — E5 ShiftNote,
 * يشمل أعمال الدعم الطبي/اللوجستي حالياً — D-2).
 *
 * The store keeps the exact legacy semantics:
 *  - Save is a BULK REPLACE of the shift's register inside ONE transaction
 *    (the UI always sends the whole list), with the same id assignment.
 *  - After COMMIT, ShiftNoteAdded fires once per save; the engine's
 *    broadcast subscriber maps it to the legacy 'shift_note_added' payload.
 *
 * Documented exception: single-note DELETE has no catalogued domain event
 * (DOMAIN-MODEL §10.2 هـ lists ShiftNoteAdded only) — the legacy
 * 'shift_note_deleted' broadcast stays in the route until the catalog gains
 * the event (same status as PositioningUpdated in Slice 4).
 */

class NotesService {
    /**
     * @param {Object} deps
     * @param {Object} deps.engine - OpsEngine (runInTransaction)
     * @param {Object} deps.db     - db module (raw run/get/all)
     * @param {Object} deps.bus    - domain event bus (owned by the engine)
     */
    constructor({ engine, db, bus }) {
        this.engine = engine;
        this.db = db;
        this.bus = bus;
    }

    _rowToJson(row) {
        let data = {};
        try { data = row.data ? JSON.parse(row.data) : {}; } catch (e) {}
        return { ...data, id: row.id, shiftId: row.shift_id };
    }

    /** ملاحظات مناوبة (نفس ترتيب المسار القديم) */
    async list(shiftId) {
        const rows = await this.db.all('SELECT * FROM shift_notes WHERE shift_id = ? ORDER BY created_at DESC, id DESC', [shiftId]);
        return rows.map(r => this._rowToJson(r));
    }

    /**
     * حفظ السجل كاملاً (استبدال جماعي داخل معاملة واحدة — نفس دلالات كتابة JSON القديمة)
     * → ShiftNoteAdded بعد نجاح الحفظ
     */
    async replaceAll(shiftId, notes) {
        const newNotes = notes.map((n, i) => ({ ...n, shiftId, id: n.id ? String(n.id) : (Date.now() + i).toString() }));
        const runInTransaction = this.engine && typeof this.engine.runInTransaction === 'function'
            ? (fn) => this.engine.runInTransaction(fn)
            : (fn) => fn();
        await runInTransaction(async () => {
            await this.db.run('DELETE FROM shift_notes WHERE shift_id = ?', [shiftId]);
            for (const n of newNotes) {
                await this.db.run('INSERT INTO shift_notes (id, shift_id, data) VALUES (?, ?, ?)',
                    [String(n.id), shiftId, JSON.stringify(n)]);
            }
        });
        this.bus.emit('ShiftNoteAdded', { shift_id: shiftId, count: newNotes.length });
        return newNotes.length;
    }

    /** حذف ملاحظة واحدة — بلا حدث domain (لا ShiftNoteDeleted في الكتالوج بعد) */
    /** حذف ملاحظة → ShiftNoteDeleted (Catalog D-5 — مُفعَّل؛ يُطلق فقط عند وجود صف فعلي) */
    async remove(shiftId, noteId) {
        const result = await this.db.run('DELETE FROM shift_notes WHERE shift_id = ? AND id = ?', [shiftId, noteId]);
        if (result.changes > 0) {
            this.bus.emit('ShiftNoteDeleted', { shift_id: shiftId, note_id: noteId });
        }
        return true;
    }
}

module.exports = NotesService;
