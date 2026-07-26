/**
 * Managers — Domain-specific business logic
 * ═══════════════════════════════════════════════════════════
 * Each manager handles one domain. No manager talks to SQLite directly.
 * All data access goes through StorageAdapter.
 */

// ─── Helpers ───
const TimeRiyadh = require('./public/js/time-riyadh.js');

// يُرجع Date محليًا ساعته الجدارية = توقيت الرياض، مشتقًا من الطبقة المركزية
// (مستقل عن منطقة الخادم الزمنية — بلا إزاحة يدوية +3)
function getSaudiDateTime() {
    const p = TimeRiyadh.riyadhParts(new Date());
    return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

function getSaudiDateString(date = getSaudiDateTime()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getSaudiTimeString(date = getSaudiDateTime()) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function getCurrentShiftType() {
    const hour = getSaudiDateTime().getHours();
    return (hour >= 5 && hour < 17) ? 'صباحية' : 'ليلية';
}

function generateId() {
    return Date.now() + Math.floor(Math.random() * 1000);
}

// ═══════════════════════════════════════════════════════════
// SHIFT MANAGER
// ═══════════════════════════════════════════════════════════
class ShiftManager {
    constructor(storage) {
        this.storage = storage;
    }

    async startShift(shiftType, user = null) {
        const now = getSaudiDateTime();
        const today = getSaudiDateString(now);
        const type = shiftType || getCurrentShiftType();

        // Step 1: Archive any currently active shift
        const active = await this.storage.getActiveShift();
        if (active) {
            await this.storage.archiveShift(active.id);
        }

        // Step 2: Create in SQLite
        const shiftName = `${type} - ${today}`;
        const newId = await this.storage.createShift({
            shiftName,
            shiftDate: today,
            shiftTime: getSaudiTimeString(now),
            shiftType: type,
            shiftDay: TimeRiyadh.formatDayName(new Date()),
            startTime: now.toISOString()
        });

        // Step 3: Audit log
        await this.storage.logAudit({
            shiftId: newId,
            userId: user ? user.id : null,
            userName: user ? user.name || user.username : 'system',
            action: 'shift_started',
            detail: `بدء مناوبة ${type}`,
            type: 'shifts'
        });

        return {
            success: true,
            shiftId: newId,
            type,
            date: today,
            message: `تم بدء المناوبة ${type} بنجاح`,
            status: 'started'
        };
    }

    async endShift(shiftId, user = null, notes = '') {
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { success: false, error: 'المناوبة غير موجودة' };
        if (shift.status !== 'active') return { success: false, error: 'المناوبة ليست نشطة' };

        await this.storage.endShift(shiftId, notes);

        await this.storage.logAudit({
            shiftId,
            userId: user ? user.id : null,
            userName: user ? user.name || user.username : 'system',
            action: 'shift_ended',
            detail: 'إنهاء المناوبة',
            type: 'shifts'
        });

        return { success: true, message: 'تم إنهاء المناوبة' };
    }

    async archiveShift(shiftId, user = null, reason = '') {
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { success: false, error: 'المناوبة غير موجودة' };

        await this.storage.archiveShift(shiftId);

        await this.storage.logAudit({
            shiftId,
            userId: user ? user.id : null,
            userName: user ? user.name || user.username : 'system',
            action: 'shift_archived',
            detail: reason || 'أرشفة المناوبة',
            type: 'shifts'
        });

        return { success: true, message: 'تم أرشفة المناوبة' };
    }

    async getActiveShift() {
        return this.storage.getActiveShift();
    }

    async getShiftById(id) {
        return this.storage.getShiftById(id);
    }

    async getAllShifts(limit = 100) {
        return this.storage.getAllShifts(limit);
    }

    async resolveShiftId(req = null, shiftDate = null, shiftType = null) {
        // 1. From request
        if (req) {
            const bodyId = req.body?.shift_id || req.body?.shiftId || null;
            if (bodyId) return parseInt(bodyId);
            const queryId = req.query?.shift_id || req.query?.shiftId || null;
            if (queryId) return parseInt(queryId);
        }

        // 2. From date + type (explicit search)
        if (shiftDate && shiftType) {
            const shifts = await this.storage.all(
                'SELECT id FROM shifts WHERE shift_date = ? AND shift_type = ? AND status = ? ORDER BY id DESC LIMIT 1',
                [shiftDate, shiftType, 'active']
            );
            if (shifts && shifts.length > 0) return shifts[0].id;
            // Explicit query not found → don't fall back to active
            return null;
        }

        // 3. Get current active shift
        const active = await this.storage.getActiveShift();
        if (active) return active.id;

        return null;
    }

    async getCurrentSession() {
        const activeShift = await this.storage.getActiveShift();
        const today = getSaudiDateString();
        const shiftType = getCurrentShiftType();

        return {
            timestamp: new Date().toISOString(),
            currentShift: activeShift ? {
                id: activeShift.id,
                type: activeShift.shift_type,
                date: activeShift.shift_date,
                name: activeShift.shift_name,
                key: `${activeShift.shift_date}::${activeShift.shift_type}`,
                totalReports: activeShift.total_reports || 0,
                status: activeShift.status,
                startTime: activeShift.start_time
            } : null,
            currentShiftType: shiftType,
            currentDate: today,
            currentTime: getSaudiTimeString(),
            hasActiveShift: !!activeShift
        };
    }
}

// ═══════════════════════════════════════════════════════════
// REPORT MANAGER
// ═══════════════════════════════════════════════════════════
class ReportManager {
    constructor(storage) {
        this.storage = storage;
    }

    async addReport(shiftId, center, unit, type) {
        if (!shiftId) return { success: false, error: 'لا توجد مناوبة نشطة' };

        // Find existing report for this center/unit/shift
        const existing = await this.storage.getReport(shiftId, center, unit);
        let newCount;
        let reportId;

        if (existing) {
            newCount = await this.storage.incrementReport(existing.id);
            reportId = existing.id;
        } else {
            const created = await this.storage.createReport(shiftId, center, unit);
            newCount = created.count;
            reportId = created.id;
        }

        // Single source: record the report time (+ type) in report_times
        await this.storage.addReportTime(reportId, new Date().toISOString(), type || null);

        // Update shift total
        const total = await this.storage.getTotalReports(shiftId);
        await this.storage.updateShiftTotalReports(shiftId, total);

        return { success: true, newCount, totalReports: total, shiftId };
    }

    async undoReport(shiftId, center, unit) {
        if (!shiftId) return { success: false, error: 'لا توجد مناوبة نشطة' };

        const existing = await this.storage.getReport(shiftId, center, unit);
        if (!existing || existing.count <= 0) {
            return { success: false, error: 'لا يوجد بلاغات للتراجع' };
        }

        const newCount = await this.storage.decrementReport(existing.id);
        // Single source: remove the most recent report_times row for this report
        await this.storage.deleteLastReportTime(existing.id);
        const total = await this.storage.getTotalReports(shiftId);
        await this.storage.updateShiftTotalReports(shiftId, total);

        return { success: true, newCount, totalReports: total, shiftId };
    }

    async getReportsByShift(shiftId) {
        return this.storage.getReportsByShift(shiftId);
    }

    async getTotalReports(shiftId) {
        return this.storage.getTotalReports(shiftId);
    }
}

// ═══════════════════════════════════════════════════════════
// COMPLETION MANAGER
// ═══════════════════════════════════════════════════════════
class CompletionManager {
    constructor(storage) {
        this.storage = storage;
    }

    async saveCompletion(shiftId, shiftType, shiftDate, teams, notes, user) {
        const createdBy = user ? user.name || user.username || 'system' : 'system';
        const createdAt = new Date().toISOString();

        const completionId = await this.storage.createCompletion({
            shiftType,
            shiftDate,
            shiftId,
            teams,
            notes: notes || '',
            createdBy,
            createdAt
        });

        return {
            success: true,
            completionId,
            shiftId
        };
    }

    async getLatestCompletion(shiftDate, shiftType) {
        const row = await this.storage.getLatestCompletion(shiftDate, shiftType);
        return CompletionManager._normalize(row);
    }

    // OV-S6-01: latest completion bound to a shift row, regardless of the
    // stamped type label (historically mis-stamped rows remain readable).
    async getLatestByShiftId(shiftId) {
        const row = await this.storage.getLatestCompletionByShiftId(shiftId);
        return CompletionManager._normalize(row);
    }

    static _normalize(row) {
        if (!row) return null;

        return {
            id: row.id,
            shiftDate: row.shift_date,
            shiftType: row.shift_type,
            shiftId: row.shift_id,
            teams: JSON.parse(row.teams_data),
            notes: row.notes || '',
            createdBy: row.created_by,
            createdAt: row.created_at
        };
    }
}

module.exports = {
    ShiftManager,
    ReportManager,
    CompletionManager,
    getSaudiDateTime,
    getSaudiDateString,
    getSaudiTimeString,
    getCurrentShiftType
};