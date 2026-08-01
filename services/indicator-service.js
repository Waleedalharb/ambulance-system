/**
 * Indicator Service — Read-only operational indicators (F5a)
 * ═══════════════════════════════════════════════════════════
 * READ + AGGREGATE ONLY. No writes, no event bus, no events.
 *
 * Every number is derived from the LIVE tables only:
 *   shifts, reports, report_times
 * The center distribution reuses the F4-fixed report read
 * (ReportService.getShiftReports — same source as /api/daily-report);
 * no third report read path is introduced.
 * shift_metrics / shift_kpi_* are NEVER touched (generated test
 * data — not a source, per owner decision).
 *
 * Bundle contract (GET /api/indicators/dashboard):
 *   {
 *     shiftStats:        { totalShifts, totalReports, avgReportsPerShift, maxReports, minReports, todayShifts }
 *     recentShifts:      [{ id, name, date, type, totalReports }]        // 10 newest
 *     dailySeries:       { labels: [YYYY-MM-DD], values: [int] }         // last 30 days
 *     shiftTypes:        { 'صباحية': int, 'ليلية': int }
 *     weekly:            [{ weekStart, shiftCount, reports, avg, max, min }]  // newest first
 *     centerDistribution:[{ center, count }]                             // desc
 *     hourlyProfile:     { '00': int, ..., '23': int }                   // from report_times
 *     positioning:       { total: int, byShift: [{ shiftId, count }] }   // المرحلة أ — من peak_plans
 *   }
 */

class IndicatorService {
    /**
     * @param {Object} deps
     * @param {Object} deps.engine        - OperationsEngine instance (storage access)
     * @param {Object} deps.reportService - ReportService (F4-fixed per-shift report read)
     */
    constructor({ engine, reportService }) {
        if (!engine) throw new Error('IndicatorService requires an OperationsEngine instance');
        if (!reportService) throw new Error('IndicatorService requires a ReportService instance');
        this.engine = engine;
        this.reportService = reportService;
    }

    /**
     * One bundle covering everything operations-dashboard.html computes today.
     * @returns {Object} the indicators bundle (see header contract)
     */
    async getDashboard() {
        const rows = await this.engine.storage.all(
            'SELECT id, shift_name, shift_date, shift_type, total_reports FROM shifts ORDER BY id DESC'
        );
        const shifts = Array.isArray(rows) ? rows : [];

        // ── Shift statistics (loadReports / loadAnalytics cards) ──
        const totalShifts = shifts.length;
        const totalReports = shifts.reduce((sum, s) => sum + (s.total_reports || 0), 0);
        const today = new Date().toISOString().split('T')[0];
        const todayShifts = shifts.filter(s => s.shift_date === today).length;
        let maxReports = 0, minReports = Infinity;
        for (const s of shifts) {
            const c = s.total_reports || 0;
            if (c > maxReports) maxReports = c;
            if (c < minReports) minReports = c;
        }
        const shiftStats = {
            totalShifts,
            totalReports,
            avgReportsPerShift: totalShifts ? Math.round(totalReports / totalShifts) : 0,
            maxReports,
            minReports: minReports === Infinity ? 0 : minReports,
            todayShifts
        };

        // ── Recent shifts (10 newest — dailyReportContent cards) ──
        const recentShifts = shifts.slice(0, 10).map(s => ({
            id: s.id,
            name: s.shift_name || '-',
            date: s.shift_date || '—',
            type: s.shift_type || '—',
            totalReports: s.total_reports || 0
        }));

        // ── Daily series (last 30 days — dailyChart) ──
        const dailyMap = {};
        for (const s of shifts) {
            if (!s.shift_date) continue;
            dailyMap[s.shift_date] = (dailyMap[s.shift_date] || 0) + (s.total_reports || 0);
        }
        const dailyLabels = Object.keys(dailyMap).sort().slice(-30);
        const dailySeries = { labels: dailyLabels, values: dailyLabels.map(d => dailyMap[d]) };

        // ── Shift type distribution (shiftTypeChart) ──
        const shiftTypes = { 'صباحية': 0, 'ليلية': 0 };
        for (const s of shifts) {
            if (shiftTypes[s.shift_type] !== undefined) shiftTypes[s.shift_type]++;
        }

        // ── Weekly aggregation (analytics table; week starts Sunday, newest first) ──
        const weeks = {};
        for (const s of shifts) {
            if (!s.shift_date) continue;
            const d = new Date(s.shift_date);
            if (isNaN(d)) continue;
            const weekStart = new Date(d);
            weekStart.setDate(d.getDate() - d.getDay());
            const key = weekStart.toISOString().split('T')[0];
            if (!weeks[key]) weeks[key] = { shiftCount: 0, reports: 0, max: 0, min: Infinity };
            const c = s.total_reports || 0;
            weeks[key].shiftCount++;
            weeks[key].reports += c;
            if (c > weeks[key].max) weeks[key].max = c;
            if (c < weeks[key].min) weeks[key].min = c;
        }
        const weekly = Object.keys(weeks).sort().reverse().map(w => {
            const v = weeks[w];
            return {
                weekStart: w,
                shiftCount: v.shiftCount,
                reports: v.reports,
                avg: v.shiftCount ? Math.round(v.reports / v.shiftCount) : 0,
                max: v.max,
                min: v.min === Infinity ? 0 : v.min
            };
        });

        // ── Center distribution — REAL, via the F4-fixed read
        // (ReportService.getShiftReports per shift; same source as /api/daily-report) ──
        const centerCounts = {};
        for (const s of shifts) {
            const reportsObj = await this.reportService.getShiftReports(s.id);
            for (const key in reportsObj) {
                const center = key.split('|')[0];
                if (!center) continue;
                centerCounts[center] = (centerCounts[center] || 0) + (reportsObj[key].count || 0);
            }
        }
        const centerDistribution = Object.entries(centerCounts)
            .map(([center, count]) => ({ center, count }))
            .sort((a, b) => b.count - a.count);

        // ── Hourly profile — REAL, from report_times (consumed by F5b later) ──
        const hourlyRows = await this.engine.storage.all(
            "SELECT strftime('%H', timestamp) AS h, COUNT(*) AS c FROM report_times GROUP BY h"
        );
        const hourlyProfile = {};
        for (let i = 0; i < 24; i++) hourlyProfile[String(i).padStart(2, '0')] = 0;
        for (const r of hourlyRows) {
            if (r.h !== null && r.h !== undefined) hourlyProfile[r.h] = r.c;
        }

        // ── جولة Operational Workflow Completion (المرحلة أ): التمركزات ──
        // سجل لا حالة: إجمالي خطط التمركز + توزيعها على المناوبات (peak_plans —
        // نفس مصدر اللقطة والتفاصيل). الخطط اليتيمة (shift_id NULL) تُحسب في
        // الإجمالي وتظهر تحت مفتاح null في byShift (قابلة للتصفية في العرض).
        let positioning = { total: 0, byShift: [] };
        try {
            const posRows = await this.engine.storage.all(
                'SELECT shift_id, COUNT(*) AS c FROM peak_plans GROUP BY shift_id ORDER BY c DESC'
            );
            const byShift = (Array.isArray(posRows) ? posRows : []).map(r => ({ shiftId: r.shift_id, count: r.c }));
            positioning = { total: byShift.reduce((a, r) => a + r.count, 0), byShift };
        } catch (e) { /* جدول قد لا يسبق التهيئة في بيئات الاختبار — الإجمالي صفر آمن */ }

        return { shiftStats, recentShifts, dailySeries, shiftTypes, weekly, centerDistribution, hourlyProfile, positioning };
    }
}

module.exports = IndicatorService;
