/**
 * Storage Adapter — Single Gateway to SQLite
 * ═══════════════════════════════════════════════════════════
 * No Manager or Endpoint talks to SQLite directly.
 * All data operations go through this adapter.
 *
 * NOTE: db.js run/get/all are async (Promise-returning).
 * Every call below MUST await so SQL errors surface instead of
 * being swallowed as unhandled rejections.
 */

class StorageAdapter {
    constructor(db) {
        this.db = db;
    }

    // ─── Shifts ───
    async createShift(data) {
        const result = await this.db.run(
            `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time, status, total_reports, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', 0, datetime('now'), datetime('now'))`,
            [data.shiftName, data.shiftDate, data.shiftTime, data.shiftType, data.shiftDay, data.startTime]
        );
        return result.id;
    }

    async getShiftById(id) {
        return this.db.get('SELECT * FROM shifts WHERE id = ?', [id]);
    }

    async getActiveShift() {
        return this.db.get("SELECT * FROM shifts WHERE status = 'active' ORDER BY id DESC LIMIT 1");
    }

    async archiveShift(id) {
        await this.db.run(
            "UPDATE shifts SET status = 'archived', archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            [id]
        );
    }

    async endShift(id, notes) {
        await this.db.run(
            "UPDATE shifts SET status = 'pending_handover', general_notes = ?, end_time = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            [notes || '', id]
        );
    }

    async updateShiftTotalReports(shiftId, total) {
        await this.db.run("UPDATE shifts SET total_reports = ?, updated_at = datetime('now') WHERE id = ?", [total, shiftId]);
    }

    async getAllShifts(limit = 100) {
        return this.db.all('SELECT * FROM shifts ORDER BY id DESC LIMIT ?', [limit]);
    }

    // ─── Reports ───
    async getReport(shiftId, center, unit) {
        return this.db.get(
            'SELECT id, count FROM reports WHERE shift_id = ? AND center = ? AND unit = ?',
            [shiftId, center, unit]
        );
    }

    async createReport(shiftId, center, unit) {
        const result = await this.db.run(
            'INSERT INTO reports (shift_id, center, unit, count) VALUES (?, ?, ?, 1)',
            [shiftId, center, unit]
        );
        return { id: result.id, count: 1 };
    }

    async incrementReport(id) {
        await this.db.run('UPDATE reports SET count = count + 1 WHERE id = ?', [id]);
        const row = await this.db.get('SELECT count FROM reports WHERE id = ?', [id]);
        return row ? row.count : 0;
    }

    async decrementReport(id) {
        await this.db.run('UPDATE reports SET count = count - 1 WHERE id = ? AND count > 0', [id]);
        const row = await this.db.get('SELECT count FROM reports WHERE id = ?', [id]);
        return row ? row.count : 0;
    }

    async getTotalReports(shiftId) {
        const row = await this.db.get('SELECT SUM(count) as total FROM reports WHERE shift_id = ?', [shiftId]);
        return row ? (row.total || 0) : 0;
    }

    async getReportsByShift(shiftId) {
        return this.db.all('SELECT * FROM reports WHERE shift_id = ?', [shiftId]);
    }

    // ─── Shift Completions ───
    async createCompletion(data) {
        const result = await this.db.run(
            `INSERT INTO shift_completions (shift_type, shift_date, shift_id, teams_data, notes, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [data.shiftType, data.shiftDate, data.shiftId, JSON.stringify(data.teams), data.notes || '', data.createdBy, data.createdAt]
        );
        return result.id;
    }

    async getLatestCompletion(shiftDate, shiftType) {
        return this.db.get(
            'SELECT * FROM shift_completions WHERE shift_date = ? AND shift_type = ? ORDER BY created_at DESC LIMIT 1',
            [shiftDate, shiftType]
        );
    }

    // ─── Audit Log ───
    async logAudit(data) {
        await this.db.run(
            `INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [data.shiftId, data.userId, data.userName, data.action, data.detail, data.type]
        );
    }

    // ─── Generic ───
    async exec(sql) {
        await this.db.exec(sql);
    }

    async run(sql, params = []) {
        return this.db.run(sql, params);
    }

    async get(sql, params = []) {
        return this.db.get(sql, params);
    }

    async all(sql, params = []) {
        return this.db.all(sql, params);
    }
}

module.exports = StorageAdapter;
