/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          UNIFIED DATA LAYER v4.0 — SQLite Only (No JSON)            ║
 * ║         for Ambulance Dispatch Platform (Refactored)                ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 * 
 * Phase 1: All data operations go through SQLite only.
 * No JSON fallback. No file-based storage for operational data.
 */

// ============================================
// DB Reference (injected from server.js)
// ============================================
let _db = null;
let _dbAvailable = () => false;

function init(db, dbAvailableFn) {
    _db = db;
    _dbAvailable = dbAvailableFn;
    console.log('[UnifiedDataLayer] v4.0 initialized — SQLite Only');
}

function ensureDb() {
    if (!_dbAvailable() || !_db) throw new Error('[UnifiedDataLayer] Database not available');
}

// ============================================
// Helpers: DB Query wrappers
// ============================================
async function dbAll(sql, params = []) {
    ensureDb();
    return _db.all(sql, params);
}
async function dbGet(sql, params = []) {
    ensureDb();
    return _db.get(sql, params);
}
async function dbRun(sql, params = []) {
    ensureDb();
    return _db.run(sql, params);
}

// ============================================
// SECTION 1: SHIFTS
// ============================================

function normalizeShift(row) {
    if (!row) return null;
    return {
        id: row.id,
        shiftName: row.shift_name,
        shiftDate: row.shift_date,
        shiftTime: row.shift_time,
        shiftType: row.shift_type,
        shiftDay: row.shift_day,
        startTime: row.start_time,
        totalReports: row.total_reports || 0,
        rapidLocations: row.rapid_locations ? JSON.parse(row.rapid_locations) : [],
        centersData: row.centers_data ? JSON.parse(row.centers_data) : {},
        vehicleData: row.vehicle_data ? JSON.parse(row.vehicle_data) : {},
        fuelData: row.fuel_data ? JSON.parse(row.fuel_data) : {},
        generalNotes: row.general_notes || '',
        lastUpdate: row.last_update,
        status: row.status || 'active',
        archivedAt: row.archived_at,
        createdAt: row.created_at
    };
}

async function getShiftsUnified(filters = {}) {
    ensureDb();
    let shifts = await _db.Shifts.getAll();
    shifts = shifts.map(normalizeShift);

    // Apply filters
    if (filters.dateFrom) shifts = shifts.filter(s => s.shiftDate >= filters.dateFrom);
    if (filters.dateTo) shifts = shifts.filter(s => s.shiftDate <= filters.dateTo);
    if (filters.shiftType) shifts = shifts.filter(s => s.shiftType === filters.shiftType);
    if (filters.status) shifts = shifts.filter(s => s.status === filters.status);
    if (filters.search) {
        const q = filters.search.toLowerCase();
        shifts = shifts.filter(s => 
            (s.shiftName || '').toLowerCase().includes(q) ||
            (s.supervisor || '').toLowerCase().includes(q)
        );
    }

    // Sort
    const sort = filters.sort || 'date_desc';
    shifts.sort((a, b) => {
        if (sort === 'date_desc') return new Date(b.shiftDate || 0) - new Date(a.shiftDate || 0);
        if (sort === 'date_asc') return new Date(a.shiftDate || 0) - new Date(b.shiftDate || 0);
        if (sort === 'completion_rate') return (b.completionRate || 0) - (a.completionRate || 0);
        if (sort === 'health_score') return (b.healthScore || 0) - (a.healthScore || 0);
        return 0;
    });

    return shifts;
}

async function getShiftByIdUnified(shiftId) {
    ensureDb();
    const shift = await _db.Shifts.getById(shiftId);
    return normalizeShift(shift);
}

async function saveShiftUnified(shift) {
    ensureDb();
    const data = {
        shiftName: shift.shiftName,
        shiftDate: shift.shiftDate,
        shiftTime: shift.shiftTime,
        shiftType: shift.shiftType,
        shiftDay: shift.shiftDay,
        startTime: shift.startTime,
        totalReports: shift.totalReports || 0,
        rapidLocations: shift.rapidLocations || [],
        centersData: shift.centersData || {},
        vehicleData: shift.vehicleData || {},
        fuelData: shift.fuelData || {},
        generalNotes: shift.generalNotes || '',
        lastUpdate: new Date().toISOString()
    };

    if (shift.id) {
        await _db.Shifts.update(shift.id, data);
    } else {
        shift.id = await _db.Shifts.create(data);
    }

    // Recalculate KPIs in memory (no JSON)
    await recalculateAllKPIs();

    return shift;
}

// ============================================
// SECTION 2: REPORTS
// ============================================

async function getReportsUnified(shiftId) {
    ensureDb();
    const reports = await _db.Reports.getByShift(shiftId);
    const obj = {};
    reports.forEach(r => {
        if (r.center && r.unit) {
            obj[`${r.center}|${r.unit}`] = { count: r.count || 0, times: r.times || [] };
        }
    });
    return obj;
}

async function saveReportsUnified(shiftId, reports) {
    ensureDb();
    // Update shift total
    const totalReports = Object.values(reports).reduce((sum, r) => sum + (r.count || 0), 0);
    await dbRun('UPDATE shifts SET total_reports = ? WHERE id = ?', [totalReports, shiftId]);

    // Save individual reports to reports table
    for (const [key, report] of Object.entries(reports)) {
        const [center, unit] = key.split('|');
        if (center && unit) {
            const existing = await dbGet(
                'SELECT id FROM reports WHERE shift_id = ? AND center = ? AND unit = ?',
                [shiftId, center, unit]
            );
            if (existing) {
                await dbRun('UPDATE reports SET count = ? WHERE id = ?', [report.count || 0, existing.id]);
            } else {
                await _db.Reports.create(center, unit, report.count || 0, shiftId);
            }
        }
    }

    await recalculateAllKPIs();
}

// ============================================
// SECTION 3: KPI CALCULATION (In-Memory)
// ============================================

let _kpiCache = { daily: null, weekly: null, monthly: null };

async function recalculateAllKPIs() {
    console.log('[UnifiedDataLayer] Recalculating KPIs...');

    const shifts = await getShiftsUnified({});
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    _kpiCache.daily = calculateDailyKPI(shifts, today);
    _kpiCache.weekly = calculateWeeklyKPI(shifts, getWeekStart(now));
    _kpiCache.monthly = calculateMonthlyKPI(shifts, getMonthStart(now));

    return _kpiCache;
}

function getKpiCache() {
    return _kpiCache;
}

function calculateDailyKPI(shifts, date) {
    const dayShifts = shifts.filter(s => s.shiftDate === date);
    const allReports = dayShifts.reduce((sum, s) => sum + (s.totalReports || 0), 0);
    return {
        date,
        totalShifts: dayShifts.length,
        totalReports: allReports,
        avgReportsPerShift: dayShifts.length ? Math.round(allReports / dayShifts.length) : 0,
        completionRate: dayShifts.length ? Math.round(dayShifts.filter(s => s.status === 'completed').length / dayShifts.length * 100) : 0
    };
}

function calculateWeeklyKPI(shifts, weekStart) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekShifts = shifts.filter(s => {
        const d = new Date(s.shiftDate || 0);
        return d >= new Date(weekStart) && d < weekEnd;
    });
    const allReports = weekShifts.reduce((sum, s) => sum + (s.totalReports || 0), 0);
    return {
        weekStart,
        totalShifts: weekShifts.length,
        totalReports: allReports,
        avgReportsPerShift: weekShifts.length ? Math.round(allReports / weekShifts.length) : 0
    };
}

function calculateMonthlyKPI(shifts, monthStart) {
    const [year, month] = monthStart.split('-').map(Number);
    const monthShifts = shifts.filter(s => {
        const d = new Date(s.shiftDate || 0);
        return d.getFullYear() === year && d.getMonth() + 1 === month;
    });
    const allReports = monthShifts.reduce((sum, s) => sum + (s.totalReports || 0), 0);
    return {
        monthStart,
        totalShifts: monthShifts.length,
        totalReports: allReports,
        avgReportsPerShift: monthShifts.length ? Math.round(allReports / monthShifts.length) : 0
    };
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d.toISOString().split('T')[0];
}

function getMonthStart(date) {
    return date.toISOString().slice(0, 7) + '-01';
}

// ============================================
// SECTION 4: ANNOUNCEMENTS
// ============================================

async function getAnnouncementsUnified(shiftId = null) {
    ensureDb();
    return _db.Announcements.getByShift(shiftId);
}

async function saveAnnouncementUnified(data) {
    ensureDb();
    return _db.Announcements.create(data);
}

// ============================================
// SECTION 5: TIMELINE / EVENTS
// ============================================

async function getTimelineUnified(shiftId = null) {
    ensureDb();
    return _db.Timeline.getByShift(shiftId);
}

async function addTimelineEventUnified(data) {
    ensureDb();
    return _db.Timeline.create(data);
}

// ============================================
// SECTION 6: AUDIT LOG
// ============================================

async function logAuditUnified(data) {
    ensureDb();
    return _db.AuditLog.log(data);
}

async function getAuditLogUnified(shiftId = null) {
    ensureDb();
    return _db.AuditLog.getByShift(shiftId);
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    init,

    // Shifts
    getShiftsUnified,
    getShiftByIdUnified,
    saveShiftUnified,

    // Reports
    getReportsUnified,
    saveReportsUnified,

    // KPIs
    recalculateAllKPIs,
    getKpiCache,

    // Announcements
    getAnnouncementsUnified,
    saveAnnouncementUnified,

    // Timeline
    getTimelineUnified,
    addTimelineEventUnified,

    // Audit
    logAuditUnified,
    getAuditLogUnified,
};
