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

    async addReportTime(reportId, timestamp, type) {
        await this.db.run(
            'INSERT INTO report_times (report_id, timestamp, type) VALUES (?, ?, ?)',
            [reportId, timestamp, type || null]
        );
    }

    async deleteLastReportTime(reportId) {
        await this.db.run(
            'DELETE FROM report_times WHERE id = (SELECT id FROM report_times WHERE report_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1)',
            [reportId]
        );
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

    // OV-S6-01: read by shift_id — label-agnostic, so even historically
    // mis-stamped rows stay visible through their own shift.
    async getLatestCompletionByShiftId(shiftId) {
        return this.db.get(
            'SELECT * FROM shift_completions WHERE shift_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
            [shiftId]
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

    // ─── W1-A: Operational Event Log (append-only — لا توجد دوال UPDATE/DELETE هنا أصلًا) ───
    async appendOperationalEvent(e) {
        const result = await this.db.run(
            `INSERT INTO operational_events
             (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center,
              event_type, status, reason, readiness_basis, corrects_event_id, payload, note,
              actor_id, actor_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [e.shiftId, e.shiftDate, e.shiftType, e.domain, e.entityId || null, e.entityName || null,
             e.teamId || null, e.center || null, e.eventType, e.status || null, e.reason || null,
             e.readinessBasis || null, e.correctsEventId || null,
             e.payload ? JSON.stringify(e.payload) : null, e.note || null,
             e.actorId, e.actorName, e.createdAt]
        );
        return result.id;
    }

    async getOperationalEventsByShift(shiftId, domain = null) {
        if (domain) {
            return this.db.all(
                'SELECT * FROM operational_events WHERE shift_id = ? AND domain = ? ORDER BY created_at ASC, id ASC',
                [shiftId, domain]
            );
        }
        return this.db.all(
            'SELECT * FROM operational_events WHERE shift_id = ? ORDER BY created_at ASC, id ASC',
            [shiftId]
        );
    }

    async getOperationalEventsByEntity(domain, entityId, limit = 500) {
        return this.db.all(
            'SELECT * FROM operational_events WHERE domain = ? AND entity_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
            [domain, entityId, limit]
        );
    }

    async getOperationalEventById(id) {
        return this.db.get('SELECT * FROM operational_events WHERE id = ?', [id]);
    }

    // اللقطات: تُكتب مرة واحدة (UNIQUE(shift_id, domain)) — إعادة الكتابة ممنوعة معماريًا
    async appendOperationalSnapshot(shiftId, domain, snapshotJson, eventsHash, createdAt) {
        const result = await this.db.run(
            `INSERT INTO operational_shift_snapshots (shift_id, domain, snapshot_json, events_hash, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [shiftId, domain, JSON.stringify(snapshotJson), eventsHash || null, createdAt]
        );
        return result.id;
    }

    async getOperationalSnapshot(shiftId, domain) {
        return this.db.get(
            'SELECT * FROM operational_shift_snapshots WHERE shift_id = ? AND domain = ?',
            [shiftId, domain]
        );
    }
}

module.exports = StorageAdapter;
