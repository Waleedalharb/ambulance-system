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

// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد التوقيت —
// «اليوم» وأُسس الأسابيع تُشتق من توقيت الرياض/UTC الصريح، لا من منطقة الخادم.
const TimeRiyadh = require('../public/js/time-riyadh.js');

// ─── مؤشر المساهمة التشغيلية P1 (DECISION-CONTRIBUTION-INDICATOR-P1.md) ───
// التصنيف الإداري المعتمد: مطابقة تامة على employees.job_title — بلا مطابقة
// جزئية وبلا users.role. غير المطابقين يُرصدون للمراجعة اليدوية فقط.
const CONTRIBUTION_GROUPS = {
    operations: ['تحكم عملياتي', 'تنسيق استجابة'],
    fieldLeadership: ['كبير مسعفين', 'مساعد كبير مسعفين']
};
// سلال audit_log (أفعال موثقة في خريطة الفحص — لا يُخترع غيرها)
const AUDIT_BUCKET_MAP = {
    completion_saved: 'completions',
    // مسار قديم لنفس حدث «حفظ التكميل» (detail مطابق حرفيًا). أُثبت عدم التداخل
    // مع completion_saved: كل صفوفه shift_id=null وصفر توأمة زمنية (فحص 2026-08-15)
    // — استبعاده كان يُسقط تكميل يوليو الحقيقي، وهذا خطأ تعريفي يجيزه §8 من المواصفة.
    shift_completion_saved: 'completions',
    report_created: 'dispatchActions',
    // «البلاغات» (تحديث المواصفة 2026-08-15): سجل الواجهة لكل ضغطة تسجيل بلاغ
    // (addReportToServer في app.js) — سلة مستقلة عن report_created الخادمية.
    'تسجيل بلاغ': 'reports',
    report_undone: 'dispatchUndo',
    // «البلاغات التفصيلية»: إدخال/تعديل (صفحة معلومات بلاغات الفرق المدخلة) — سلة مدمجة
    report_entry_added: 'detailedReports',
    report_entry_deleted: 'detailedReports',
    report_entry_cleared: 'detailedReports',
    doc_uploaded: 'docs',
    identity_uploaded: 'docs',
    ops_files_uploaded: 'docs',
    shift_cell_update: 'scheduleEdits',
    employee_transfer_day: 'scheduleEdits',
    employee_transfer_from_date: 'scheduleEdits',
    roster_clear_all: 'scheduleEdits',
    import_overwrite_manual: 'scheduleEdits',
    shift_pattern_update: 'scheduleEdits',
    employee_pattern_update: 'scheduleEdits',
    shift_updated: 'shiftLifecycle',
    shift_deleted: 'shiftLifecycle',
    shift_started: 'shiftLifecycle',
    shift_ended: 'shiftLifecycle',
    shift_archived: 'shiftLifecycle',
    announcements_updated: 'announcements'
    // ملاحظة: shift_event_added مستبعد عمدًا — أحداث المناوبة اليدوية تُعدّ من
    // سجلها الرسمي operational_events(domain=logistics) حتى لا تُحسب مرتين.
    // user_login و«تسجيل دخول/خروج» مستبعدة بقرار المالك (الدخول ليس إنجازًا)،
    // و«بدء مناوبة جديدة» صدى عربي لـ shift_started — عدّها = ازدواج.
    // الاستثناء الوحيد: «تسجيل بلاغ» ليست صدى — لها عدد مستقل (انظر أعلاه).
};

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
        // P1 (حقن متأخر من server.js — نمط StaffingEventsService): محلل رموز
        // المناوبات المركزي الوحيد لحساب الساعات/المناوبات لكل موظف.
        this.scheduleMetrics = null;
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
        const today = TimeRiyadh.formatDate(new Date()); // تاريخ الرياض الجداري (كان UTC)
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
            // shift_date نص YYYY-MM-DD (تاريخ الرياض) — حساب الأسبوع بـ UTC الصريح
            // حتى لا تتأثر الحقول بمنطقة الخادم الزمنية (كان getDay/setDate محليين)
            const d = new Date(s.shift_date + 'T00:00:00.000Z');
            if (isNaN(d)) continue;
            const weekStart = new Date(d.getTime());
            weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
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
            "SELECT strftime('%H', timestamp) AS h, COUNT(*) AS c FROM report_times WHERE COALESCE(manual_cancelled, 0) = 0 GROUP BY h"
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

    /**
     * مؤشر المساهمة التشغيلية — المرحلة الأولى (أعداد خام، بلا نقاط ولا ترتيب).
     * DECISION-CONTRIBUTION-INDICATOR-P1.md — قراءة فقط، اشتقاق حي عند كل طلب.
     *
     * لكل موظف مصنَّف (job_title مطابقة تامة): التوظيف (ساعات/مناوبات من
     * shift_roster عبر محلل الرموز المركزي) + سلال الأعمال من:
     *   audit_log · operational_events · positioning_events · shift_signout_events
     *   · shift_forms · workflow_audit_log · shift_alerts
     *
     * مفاتيح الفاعل المختلفة بين الجداول (موثقة في خريطة الفحص):
     *   String(users.id)  → audit_log.user_id, operational_events.actor_id,
     *                       positioning_events.actor_id, signouts, workflow_audit
     *   users.username    → shift_forms.created_by (= الكود الوظيفي)
     *   الاسم             → shift_alerts.acknowledged_by
     *
     * @param {number} year  (ميلادي)
     * @param {number} month (1-12)
     */
    async getEmployeeContribution(year, month) {
        const y = Number(year), m = Number(month);
        if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12 || y < 2000) {
            throw new Error('سنة/شهر غير صالحين');
        }
        const mm = String(m).padStart(2, '0');
        const monthKey = `${y}-${mm}`;                       // لختم substr(created_at,1,7)
        const from = `${monthKey}-01`;
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const to = `${monthKey}-${String(lastDay).padStart(2, '0')}`;
        const storage = this.engine.storage;

        // ── 1) الموظفون النشطون + التصنيف بالمطابقة التامة ──
        const empRows = await storage.all(
            'SELECT id, employee_code, name, job_title FROM employees WHERE COALESCE(is_active, 1) != 0'
        );
        const classified = [];
        const unmatchedTitles = {};
        for (const e of empRows) {
            const jt = String(e.job_title || '');
            const group = CONTRIBUTION_GROUPS.operations.includes(jt) ? 'operations'
                : CONTRIBUTION_GROUPS.fieldLeadership.includes(jt) ? 'fieldLeadership' : null;
            if (!group) {
                unmatchedTitles[jt || '(فارغ)'] = (unmatchedTitles[jt || '(فارغ)'] || 0) + 1;
                continue;
            }
            classified.push({
                empId: e.id,
                code: String(e.employee_code || ''),
                name: e.name || '',
                jobTitle: jt,
                group,
                actorKeys: new Set(),   // String(users.id)
                hours: 0,
                shifts: 0,
                uncountedRosterDays: 0,
                hasSchedule: false,
                works: {
                    completions: 0, dispatchActions: 0, reports: 0, dispatchUndo: 0,
                    detailedReports: 0,
                    positioning: { created: 0, updated: 0, ended: 0, swept: 0, total: 0 },
                    signouts: 0,
                    forms: { total: 0, byType: {} },
                    staffingEvents: 0, vehicleEvents: 0, logisticsEvents: 0, centerEvents: 0,
                    workflowActions: { create: 0, approve: 0, pdf: 0, reissue: 0, edit_fields: 0, other: 0, total: 0 },
                    scheduleEdits: 0, shiftLifecycle: 0, docs: 0, announcements: 0,
                    alertsAcked: 0
                }
            });
        }
        const byCode = new Map(classified.map(c => [c.code, c]));
        const byName = new Map(classified.map(c => [c.name, c]));

        // ── 2) مفاتيح الفاعل: المصادقة تقرأ data/users.json حيث id='emp-<الكود>'،
        // بينما جدول users يحمل id رقميًا — نغطي الصيغتين معًا (موثق في خريطة الفحص).
        const userRows = await storage.all('SELECT id, username FROM users');
        for (const u of userRows) {
            const emp = byCode.get(String(u.username || ''));
            if (emp) emp.actorKeys.add(String(u.id));
        }
        for (const emp of classified) {
            emp.actorKeys.add('emp-' + emp.code); // صيغة users.json الفعلية
        }
        // فهرس عكسي: مفتاح الفاعل → الموظف (للجداول المختومة بـ users.id)
        const byActorKey = new Map();
        for (const emp of classified) {
            for (const k of emp.actorKeys) byActorKey.set(k, emp);
        }

        // ── 3) التوظيف: ساعات + مناوبات من shift_roster عبر المحلل المركزي ──
        const sm = this.scheduleMetrics;
        const rosterRows = await storage.all(
            'SELECT employee_id, shift_code FROM shift_roster WHERE shift_date >= ? AND shift_date <= ?',
            [from, to]
        );
        let codesByCode = null;
        if (sm) {
            codesByCode = new Map();
            for (const r of await storage.all('SELECT code, name, time_start, time_end FROM shift_codes')) {
                const c = String(r.code || '').trim();
                if (!c) continue;
                codesByCode.set(c, r);
                codesByCode.set(c.toUpperCase(), r);
            }
        }
        const byEmpId = new Map(classified.map(c => [c.empId, c]));
        for (const r of rosterRows) {
            const emp = byEmpId.get(r.employee_id);
            if (!emp) continue;
            emp.hasSchedule = true;
            if (!sm) { emp.hours = null; emp.shifts = null; continue; }
            // resolveCodeDurationHours → number|null؛ resolveCodeDurationKind → 'work'|'coverage'|null
            const hours = sm.resolveCodeDurationHours(r.shift_code, codesByCode);
            if (hours === null) { emp.uncountedRosterDays++; continue; }
            emp.hours = Math.round((emp.hours + hours) * 10) / 10;
            if (sm.resolveCodeDurationKind(r.shift_code, codesByCode) === 'work') emp.shifts++; // رموز التغطية (E/VC/V/S) ساعات محسوبة لا مناوبات — قرار المالك 2026-08-13
        }

        // ── 4) audit_log ──
        for (const r of await storage.all(
            'SELECT user_id, action, COUNT(*) AS c FROM audit_log WHERE substr(created_at, 1, 7) = ? GROUP BY user_id, action',
            [monthKey]
        )) {
            const emp = byActorKey.get(String(r.user_id));
            const bucket = AUDIT_BUCKET_MAP[r.action];
            if (!emp || !bucket) continue;
            emp.works[bucket] += r.c;
        }

        // ── 5) operational_events (السجل التشغيلي الموحد) ──
        const OE_DOMAIN_BUCKET = { staffing: 'staffingEvents', vehicle: 'vehicleEvents', logistics: 'logisticsEvents', center: 'centerEvents' };
        for (const r of await storage.all(
            'SELECT actor_id, domain, COUNT(*) AS c FROM operational_events WHERE substr(created_at, 1, 7) = ? GROUP BY actor_id, domain',
            [monthKey]
        )) {
            const emp = byActorKey.get(String(r.actor_id));
            const bucket = OE_DOMAIN_BUCKET[r.domain];
            if (!emp || !bucket) continue;
            emp.works[bucket] += r.c;
        }

        // ── 6) positioning_events ──
        for (const r of await storage.all(
            'SELECT actor_id, event_type, COUNT(*) AS c FROM positioning_events WHERE substr(created_at, 1, 7) = ? GROUP BY actor_id, event_type',
            [monthKey]
        )) {
            const emp = byActorKey.get(String(r.actor_id));
            if (!emp) continue;
            const p = emp.works.positioning;
            if (r.event_type === 'created') p.created += r.c;
            else if (r.event_type === 'updated') p.updated += r.c;
            else if (r.event_type === 'ended') p.ended += r.c;
            else if (r.event_type === 'swept') p.swept += r.c;
        }

        // ── 7) shift_signout_events ──
        for (const r of await storage.all(
            'SELECT actor_id, COUNT(*) AS c FROM shift_signout_events WHERE substr(created_at, 1, 7) = ? GROUP BY actor_id',
            [monthKey]
        )) {
            const emp = byActorKey.get(String(r.actor_id));
            if (emp) emp.works.signouts += r.c;
        }

        // ── 8) shift_forms (created_by = الكود الوظيفي) ──
        for (const r of await storage.all(
            'SELECT created_by, form_name, COUNT(*) AS c FROM shift_forms WHERE substr(created_at, 1, 7) = ? GROUP BY created_by, form_name',
            [monthKey]
        )) {
            const emp = byCode.get(String(r.created_by || ''));
            if (!emp) continue;
            emp.works.forms.total += r.c;
            emp.works.forms.byType[r.form_name] = (emp.works.forms.byType[r.form_name] || 0) + r.c;
        }

        // ── 9) workflow_audit_log ──
        try {
            for (const r of await storage.all(
                'SELECT actor_id, action, COUNT(*) AS c FROM workflow_audit_log WHERE substr(at, 1, 7) = ? GROUP BY actor_id, action',
                [monthKey]
            )) {
                const emp = byActorKey.get(String(r.actor_id));
                if (!emp) continue;
                const w = emp.works.workflowActions;
                if (Object.prototype.hasOwnProperty.call(w, r.action)) w[r.action] += r.c;
                else w.other += r.c;
            }
        } catch (e) { /* الجدول ذاتي الإنشاء — قد يسبق التهيئة في بيئات الاختبار */ }

        // ── 10) shift_alerts المُقروءة (acknowledged_by = الاسم) ──
        try {
            for (const r of await storage.all(
                `SELECT acknowledged_by, COUNT(*) AS c FROM shift_alerts
                 WHERE is_acknowledged = 1 AND acknowledged_by IS NOT NULL AND substr(acknowledged_at, 1, 7) = ?
                 GROUP BY acknowledged_by`,
                [monthKey]
            )) {
                const emp = byName.get(String(r.acknowledged_by || ''));
                if (emp) emp.works.alertsAcked += r.c;
            }
        } catch (e) { /* دفاعي */ }

        // ── التجميع النهائي: إجمالي الأعمال + تفكيك الحقول الداخلية ──
        const finalize = (emp) => {
            const w = emp.works;
            w.positioning.total = w.positioning.created + w.positioning.updated + w.positioning.ended; // swept = كنس آلي، ليس عمل موظف
            w.workflowActions.total = w.workflowActions.create + w.workflowActions.approve + w.workflowActions.pdf
                + w.workflowActions.reissue + w.workflowActions.edit_fields + w.workflowActions.other;
            // تحديث المواصفة 2026-08-15: إجمالي أعمال موظف العمليات = مجموع
            // المؤشرات التسعة المعتمدة فقط (تكميل/توزيع/بلاغات/تراجع/تفصيلية/
            // تمركزات/خروج فرق/نماذج/سير عمل). أحداث القوى والمركبات واللوجستية
            // وتعديلات الجداول والملفات والتنبيهات ودورة المناوبة لا تدخل فيه.
            const opsNineTotal = w.completions + w.dispatchActions + w.reports + w.dispatchUndo
                + w.detailedReports + w.positioning.total + w.signouts + w.forms.total + w.workflowActions.total;
            // القيادة الميدانية: تُعالج مؤشراتها لاحقًا بشكل مستقل (§6) — يبقى
            // إجمالها الشامل لكل المسجل كما هو دون تغيير في هذه المرحلة.
            const totalWorks = emp.group === 'operations' ? opsNineTotal
                : opsNineTotal + w.staffingEvents + w.vehicleEvents + w.logisticsEvents + w.centerEvents
                    + w.scheduleEdits + w.shiftLifecycle + w.docs + w.announcements + w.alertsAcked;
            return {
                employeeCode: emp.code,
                name: emp.name,
                jobTitle: emp.jobTitle,
                hasUserAccount: emp.actorKeys.size > 0,
                hasSchedule: emp.hasSchedule,
                scheduledHours: emp.hours,
                shifts: emp.shifts,
                uncountedRosterDays: emp.uncountedRosterDays,
                works: w,
                totalWorks
            };
        };
        // ترتيب محايد أبجدي بالاسم داخل كل فئة (ليس ترتيب أداء — قرار المالك)
        const byAlpha = (a, b) => a.name.localeCompare(b.name, 'ar');
        return {
            year: y,
            month: m,
            monthKey,
            range: { from, to },
            generatedAt: new Date().toISOString(),
            groups: {
                operations: classified.filter(c => c.group === 'operations').map(finalize).sort(byAlpha),
                fieldLeadership: classified.filter(c => c.group === 'fieldLeadership').map(finalize).sort(byAlpha)
            },
            unmatchedJobTitles: Object.entries(unmatchedTitles)
                .map(([jobTitle, count]) => ({ jobTitle, count }))
                .sort((a, b) => b.count - a.count),
            caveats: [
                'إجمالي أعمال العمليات = مجموع المؤشرات التسعة فقط؛ أحداث القوى البشرية والمركبات واللوجستية وتعديلات الجداول والملفات والتنبيهات ودورة المناوبة لا تدخل فيه.',
                '«البلاغات» من سجل الواجهة (كل ضغطة تسجيل) و«توزيع البلاغات» من سجل الخادم (إجراء لكل عملية؛ الإدخال الجماعي = إجراء واحد) — عدستان لنشاط متداخل وليستا بالضرورة متساويتين.',
                'التكميل يشمل المسار القديم shift_completion_saved بعد إثبات عدم تداخله مع completion_saved (يؤثر على يوليو 2026 وما قبله فقط).',
                'أعمال القيادة الميدانية المقاسة هي المسجلة في المنصة فقط؛ المتابعة بلا كتابة غير مسجلة بنيويًا، وإجمالها يبقى الشامل حتى تُضبط مؤشراتها لاحقًا.',
                'ملاحظات المناوبة مستبعدة (لا تحمل ختم مؤلف سيرفري).',
                'حدود الشهر محسوبة على الختم المخزن (UTC) وقد تزيح ساعات قليلة عن ليلة الرياض.'
            ]
        };
    }
}

module.exports = IndicatorService;
