/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          UNIFIED API ROUTES v3.0 — New Endpoints                     ║
 * ║                                                                      ║
 * ║  These routes provide a SINGLE source of data for ALL pages.        ║
 * ║  Pages should migrate from old endpoints to these new ones.          ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 * 
 * INTEGRATION: Add this to your existing server.js:
 *   const unifiedRoutes = require('./unified-api-routes');
 *   unifiedRoutes(app, authenticate, authorize);
 */

const { init: initUDL, 
    getShiftsUnified, getShiftByIdUnified, saveShiftUnified,
    getReportsUnified, saveReportsUnified,
    recalculateAllKPIs, buildDashboardResponse, buildArchiveResponse, buildKPIsResponse,
    addAuditTrail, getAuditTrailUnified,
    normalizeShiftFromDB
} = require('./unified-data-layer');

// Keep reference to server.js db and helpers
let _app = null;
let _authenticate = null;
let _authorize = null;

function initUDLFromServer(db, dbAvailableFn) {
    initUDL(db, dbAvailableFn);
}

function register(app, authenticate, authorize, db, dbAvailableFn) {
    _app = app;
    _authenticate = authenticate;
    _authorize = authorize;

    // Initialize the unified data layer
    initUDL(db, dbAvailableFn);

    // ═══════════════════════════════════════════════════════════════
    // ROUTE GROUP: /api/v2/unified/*
    // ═══════════════════════════════════════════════════════════════

    // ── DASHBOARD (Main KPIs + Summary) ──
    app.get('/api/v2/unified/dashboard', authenticate, async (req, res) => {
        try {
            const dashboard = await buildDashboardResponse();
            res.json({ success: true, ...dashboard });
        } catch (error) {
            console.error('[UnifiedAPI] Dashboard error:', error);
            res.status(500).json({ success: false, error: 'فشل في جلب لوحة التحكم' });
        }
    });

    // ── SHIFTS (List + Pagination + Filters) ──
    app.get('/api/v2/unified/shifts', authenticate, async (req, res) => {
        try {
            const filters = {
                page: parseInt(req.query.page) || 1,
                limit: parseInt(req.query.limit) || 20,
                dateFrom: req.query.date_from,
                dateTo: req.query.date_to,
                shiftType: req.query.shift_type,
                status: req.query.status,
                search: req.query.search,
                sort: req.query.sort || 'date_desc'
            };

            const shifts = await getShiftsUnified(filters);
            const total = shifts.length;
            const totalPages = Math.ceil(total / filters.limit);
            const paginated = shifts.slice((filters.page - 1) * filters.limit, filters.page * filters.limit);

            res.json({
                success: true,
                shifts: paginated.map(s => ({
                    id: s.id,
                    shiftName: s.shiftName || `${s.shiftType} - ${s.shiftDate}`,
                    shiftDate: s.shiftDate,
                    shiftType: s.shiftType,
                    status: s.status || 'active',
                    totalReports: s.totalReports || 0,
                    completionRate: s.completionRate || 0,
                    healthScore: s.healthScore || 0,
                    staffCount: s.staffCount || 0,
                    teamCount: s.teamCount || 0,
                    readyTeams: s.readyTeams || 0,
                    missingTeams: s.missingTeams || 0,
                    offlineTeams: s.offlineTeams || 0,
                    lastUpdate: s.lastUpdate,
                    archivedAt: s.archivedAt || null,
                    snapshotHash: s.snapshotHash || null
                })),
                pagination: {
                    page: filters.page,
                    limit: filters.limit,
                    total,
                    totalPages
                },
                generatedAt: new Date().toISOString()
            });
        } catch (error) {
            console.error('[UnifiedAPI] Shifts list error:', error);
            res.status(500).json({ success: false, error: 'فشل في جلب المناوبات' });
        }
    });

    // ── SINGLE SHIFT (Full Detail) ──
    app.get('/api/v2/unified/shifts/:id', authenticate, async (req, res) => {
        try {
            const shiftId = parseInt(req.params.id);
            const shift = await getShiftByIdUnified(shiftId);

            if (!shift) {
                return res.status(404).json({ success: false, error: 'المناوبة غير موجودة' });
            }

            // Get related data
            const reports = await getReportsUnified(shiftId);
            const timeline = []; // Will be populated from DB
            const auditTrail = []; // Will be populated from DB

            res.json({
                success: true,
                shift: {
                    id: shift.id,
                    shiftName: shift.shiftName,
                    shiftDate: shift.shiftDate,
                    shiftType: shift.shiftType,
                    shiftTime: shift.shiftTime,
                    status: shift.status || 'active',
                    totalReports: shift.totalReports || 0,
                    completedReports: shift.completedReports || 0,
                    completionRate: shift.completionRate || 0,
                    healthScore: shift.healthScore || 0,
                    staffCount: shift.staffCount || 0,
                    teamCount: shift.teamCount || 0,
                    readyTeams: shift.readyTeams || 0,
                    missingTeams: shift.missingTeams || 0,
                    offlineTeams: shift.offlineTeams || 0,
                    generalNotes: shift.generalNotes || '',
                    rapidLocations: shift.rapidLocations || {},
                    centersData: shift.centersData || {},
                    vehicleData: shift.vehicleData || {},
                    fuelData: shift.fuelData || {},
                    archivedAt: shift.archivedAt || null,
                    snapshotHash: shift.snapshotHash || null,
                    lastUpdate: shift.lastUpdate
                },
                reports,
                timeline,
                auditTrail,
                generatedAt: new Date().toISOString()
            });
        } catch (error) {
            console.error('[UnifiedAPI] Shift detail error:', error);
            res.status(500).json({ success: false, error: 'فشل في جلب تفاصيل المناوبة' });
        }
    });

    // ── KPIs (Daily / Weekly / Monthly) ──
    app.get('/api/v2/unified/kpis/:period', authenticate, async (req, res) => {
        try {
            const { period } = req.params;
            const date = req.query.date || new Date().toISOString().split('T')[0];

            if (!['daily', 'weekly', 'monthly'].includes(period)) {
                return res.status(400).json({ success: false, error: 'الفترة يجب أن تكون: daily, weekly, monthly' });
            }

            const kpis = await buildKPIsResponse(period, date);
            res.json({ success: true, kpis, generatedAt: new Date().toISOString() });
        } catch (error) {
            console.error('[UnifiedAPI] KPIs error:', error);
            res.status(500).json({ success: false, error: 'فشل في جلب المؤشرات' });
        }
    });

    // ── TREND DATA (for charts) ──
    app.get('/api/v2/unified/trend', authenticate, async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const shifts = await getShiftsUnified({});
            const now = new Date();
            const trend = [];

            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().split('T')[0];
                const dayShifts = shifts.filter(s => s.shiftDate === dateStr);
                trend.push({
                    date: dateStr,
                    totalReports: dayShifts.reduce((s, sh) => s + (sh.totalReports || 0), 0),
                    totalShifts: dayShifts.length
                });
            }

            res.json({ success: true, trend, generatedAt: new Date().toISOString() });
        } catch (error) {
            console.error('[UnifiedAPI] Trend error:', error);
            res.status(500).json({ success: false, error: 'فشل في جلب بيانات الاتجاه' });
        }
    });

    // ── ARCHIVE (Browse + Restore) ──
    app.get('/api/v2/unified/archive', authenticate, async (req, res) => {
        try {
            const filters = {
                page: parseInt(req.query.page) || 1,
                limit: parseInt(req.query.limit) || 20,
                dateFrom: req.query.date_from,
                dateTo: req.query.date_to,
                shiftType: req.query.shift_type,
                search: req.query.search,
                sort: req.query.sort || 'date_desc'
            };

            const result = await buildArchiveResponse(filters);
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('[UnifiedAPI] Archive error:', error);
            res.status(500).json({ success: false, error: 'فشل في جلب الأرشيف' });
        }
    });

    // ── ARCHIVE: Archive a shift ──
    app.post('/api/v2/unified/shifts/:id/archive', authenticate, authorize(['admin', 'director']), async (req, res) => {
        try {
            const shiftId = parseInt(req.params.id);
            const shift = await getShiftByIdUnified(shiftId);

            if (!shift) {
                return res.status(404).json({ success: false, error: 'المناوبة غير موجودة' });
            }

            shift.status = 'archived';
            shift.archivedAt = new Date().toISOString();
            shift.archivedBy = req.user.name;

            await saveShiftUnified(shift);
            await addAuditTrail('shift_archived', `تم أرشفة المناوبة #${shiftId}`, 'archive', req.user.name, req.user.role, req.user.id, shiftId);

            res.json({ success: true, message: 'تمت الأرشفة بنجاح', shiftId });
        } catch (error) {
            console.error('[UnifiedAPI] Archive error:', error);
            res.status(500).json({ success: false, error: 'فشل في الأرشفة' });
        }
    });

    // ── ARCHIVE: Restore a shift ──
    app.post('/api/v2/unified/shifts/:id/restore', authenticate, authorize(['admin', 'director']), async (req, res) => {
        try {
            const shiftId = parseInt(req.params.id);
            const shift = await getShiftByIdUnified(shiftId);

            if (!shift) {
                return res.status(404).json({ success: false, error: 'المناوبة غير موجودة' });
            }

            shift.status = 'active';
            shift.restoredAt = new Date().toISOString();
            shift.restoredBy = req.user.name;

            await saveShiftUnified(shift);
            await addAuditTrail('shift_restored', `تم استعادة المناوبة #${shiftId}`, 'archive', req.user.name, req.user.role, req.user.id, shiftId);

            res.json({ success: true, message: 'تمت الاستعادة بنجاح', shiftId });
        } catch (error) {
            console.error('[UnifiedAPI] Restore error:', error);
            res.status(500).json({ success: false, error: 'فشل في الاستعادة' });
        }
    });

    // ── DELETE: Soft delete a shift ──
    app.delete('/api/v2/unified/shifts/:id', authenticate, authorize(['admin']), async (req, res) => {
        try {
            const shiftId = parseInt(req.params.id);
            const shift = await getShiftByIdUnified(shiftId);

            if (!shift) {
                return res.status(404).json({ success: false, error: 'المناوبة غير موجودة' });
            }

            shift.status = 'deleted';
            shift.deletedAt = new Date().toISOString();
            shift.deletedBy = req.user.name;

            await saveShiftUnified(shift);
            await addAuditTrail('shift_deleted', `تم حذف المناوبة #${shiftId}`, 'archive', req.user.name, req.user.role, req.user.id, shiftId);

            res.json({ success: true, message: 'تم الحذف بنجاح', shiftId });
        } catch (error) {
            console.error('[UnifiedAPI] Delete error:', error);
            res.status(500).json({ success: false, error: 'فشل في الحذف' });
        }
    });

    // ── AUDIT TRAIL ──
    app.get('/api/v2/unified/audit', authenticate, async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 100;
            const logs = await getAuditTrailUnified(limit);
            res.json({ success: true, logs, generatedAt: new Date().toISOString() });
        } catch (error) {
            console.error('[UnifiedAPI] Audit error:', error);
            res.status(500).json({ success: false, error: 'فشل في جلب سجل التدقيق' });
        }
    });

    // ── RECALCULATE KPIs (manual trigger) ──
    app.post('/api/v2/unified/kpis/recalculate', authenticate, authorize(['admin']), async (req, res) => {
        try {
            const result = await recalculateAllKPIs();
            await addAuditTrail('kpis_recalculated', 'تم إعادة حساب المؤشرات', 'system', req.user.name, req.user.role, req.user.id);
            res.json({ success: true, message: 'تم إعادة حساب المؤشرات', kpis: result });
        } catch (error) {
            console.error('[UnifiedAPI] Recalculate error:', error);
            res.status(500).json({ success: false, error: 'فشل في إعادة الحساب' });
        }
    });

    // ── CENTERS DATA (Static reference data) ──
    app.get('/api/v2/unified/centers', authenticate, async (req, res) => {
        try {
            const centersData = {
                'المنصورة': ['جنوب 1', 'جنوب 11', 'جنوب 12', 'سريع 3'],
                'الخالدية': ['جنوب 2'],
                'منفوحة': ['جنوب 3'],
                'الدار البيضاء': ['جنوب 4', 'جنوب 5', 'سريع 1'],
                'الإسكان': ['جنوب 6'],
                'الحائر': ['جنوب 7'],
                'ديراب': ['جنوب 10'],
                'عكاظ': ['جنوب 9'],
                'الشفاء': ['جنوب 8', 'سريع 2'],
                'الفرق الإضافية': ['سريع 4', 'جنوب 13', 'جنوب 14', 'جنوب 15', 'جنوب 16', 'جنوب 17', 'جنوب 18', 'جنوب 19']
            };
            res.json({ success: true, centers: centersData });
        } catch (error) {
            res.status(500).json({ success: false, error: 'فشل في جلب بيانات المراكز' });
        }
    });

    console.log('[UnifiedAPI] v3.0 routes registered at /api/v2/unified/*');
}

module.exports = { register, initUDLFromServer };