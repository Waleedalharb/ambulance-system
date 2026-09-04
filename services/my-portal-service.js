/**
 * ═══ my-portal-service.js — بوابة الموظف التشغيلية v1+v2 (معتمدة 2026-09-04) ═══
 *
 * قراءة فقط صِرفة: لا INSERT/UPDATE/DELETE، لا جداول جديدة، لا منطق تشييك.
 * كل حقل مشتق من مصادر قائمة:
 *   الهوية:        users.username = employees.employee_code
 *   التكليف/الجدول: shift_roster(employee_id, shift_date, team_id, shift_code)
 *   أسماء الرموز:   shift_codes (السجل الرسمي — لا تفسير ذاتي للرموز)
 *   الفرقة/المركز:  teams(id, name, center, team_type)
 *   بلاغات الفرقة:  report_times × reports(unit) × shifts(shift_date)
 *                   مع استبعاد withdrawn/manual_cancelled (نفس قاعدة server.js:5069)
 *   مركبتي (v2):    VehicleEventsService.getTeamVehicles — نفس اشتقاق getBoard حرفيًا
 *   الجرد (v2):     assets(team_name, archived_at) + inventory_sessions(team_name)
 *                   — العرض بالارتباط بالبيانات، والإجراء (canOpen) يُحسب في المسار
 *
 * قرارات المالك المثبتة هنا:
 *   ① احتياطي team_assignments.is_primary لليوم الحالي فقط وموسوم primary_fallback.
 *   ② الأسبوع: السبت → الجمعة بتوقيت الرياض.
 *   ③ كسر فترة التكليف عند اليوم غير المجدول (فجوة roster) أو يوم بلا فرقة.
 *   ④ تفصيل العداد حسب الفرقة مع فترة التكليف داخل الشهر.
 *   ⑤ coverage: complete/partial/none — لا أصفار مموّهة عند غياب التغطية.
 *   ⑥ العداد يُحسب فقط داخل أيام التكليف الفعلية مع الفرقة نفسها.
 *   ⑦ (v2) «فرقة ميدانية معتمدة» = قائمة صريحة: جنوب/دعم/سريع (قرار المالك —
 *      ليست «كل ما عدا عمليات»). قيادة وعمليات وأي نوع غير مدرج = غير ميداني.
 *   ⑧ (v2) الأقسام تتكيّف بالتكليف الفعلي والارتباط بالبيانات — لا بطاقات فارغة.
 */
'use strict';

const TimeRiyadh = require('../public/js/time-riyadh.js'); // الطبقة المركزية للوقت (TIME-POLICY)

function pad2(v) { return String(Number(v)).padStart(2, '0'); }

// تاريخ الرياض اليوم بصيغة YYYY-MM-DD (من الطبقة المركزية — لا اختراع منطق وقت)
function riyadhToday() {
    const p = TimeRiyadh.riyadhParts(new Date());
    return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : null;
}
// تحويل أي طابع (UTC ISO) إلى تاريخ الرياض YYYY-MM-DD
function riyadhDateOf(v) {
    const p = TimeRiyadh.riyadhParts(v);
    return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : null;
}
function parseDay(s) { // YYYY-MM-DD → ms (UTC midnight)
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
function fmtDay(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function addDays(s, n) { const ms = parseDay(s); return isNaN(ms) ? null : fmtDay(ms + n * 86400000); }
function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); }
// حدود الأسبوع السبت→الجمعة المحيط بتاريخ الرياض المعطى (قرار المالك ②)
function weekBoundsSatFri(dateStr) {
    const ms = parseDay(dateStr);
    if (isNaN(ms)) return { start: null, end: null };
    const wd = new Date(ms).getUTCDay();        // 0=أحد … 6=سبت
    const sinceSat = (wd + 1) % 7;              // أيام منذ السبت
    const start = fmtDay(ms - sinceSat * 86400000);
    return { start, end: addDays(start, 6) };
}
function monthBounds(year, month) {
    const start = `${year}-${pad2(month)}-01`;
    const end = fmtDay(Date.UTC(year, month, 0)); // آخر يوم بالشهر
    return { start, end };
}

class MyPortalService {
    constructor({ db, getVehicleEventsService }) {
        this.db = db;
        // مزوّد كسول لخدمة أحداث المركبات (تُنشأ مع محرك العمليات) — v2
        this.getVehicleEventsService = typeof getVehicleEventsService === 'function' ? getVehicleEventsService : null;
    }

    /** هوية الموظف من الحساب: username = employee_code (🟢 قاعدة مثبتة 19/23). */
    async resolveEmployee(user) {
        if (!user || user.username == null) return null;
        return this.db.get(
            'SELECT id, employee_code, name, job_title FROM employees WHERE employee_code = ? AND is_active = 1',
            [String(user.username)]);
    }

    /** مراجع مشتركة: الفرق + سجل الرموز الرسمي. */
    async _refs() {
        const teams = await this.db.all('SELECT id, name, center, team_type FROM teams');
        const codes = await this.db.ShiftCodes.getAll();
        const teamById = new Map(teams.map(t => [t.id, t]));
        const teamIdByName = new Map(teams.map(t => [String(t.name), t.id]));
        const codeMap = new Map((codes || []).map(c => [String(c.code), c]));
        return { teamById, teamIdByName, codeMap };
    }

    /** قرار ⑦ (معدّل بقرار المالك 2026-09-04): «فرقة ميدانية معتمدة» = قائمة صريحة
     *  (جنوب/دعم/سريع) — ليست «كل ما عدا عمليات». قيادة وعمليات وأي نوع مستقبلي
     *  غير مدرج = غير ميداني. لا مطابقة جزئية ولا تفسير ذاتي. */
    static FIELD_TEAM_TYPES = ['جنوب', 'دعم', 'سريع'];
    _isFieldTeam(team) { return !!team && MyPortalService.FIELD_TEAM_TYPES.indexOf(team.team_type) !== -1; }

    /** تكليف اليوم: roster أولًا ثم احتياطي is_primary موسومًا (قرار ①) — مشترك بين الأقسام. */
    async _resolveTodayAssignment(emp) {
        const today = riyadhToday();
        let source = 'none';
        let row = await this.db.get(
            'SELECT shift_code, team_id FROM shift_roster WHERE employee_id = ? AND shift_date = ?',
            [emp.id, today]);
        if (row) {
            source = 'roster';
        } else {
            const fb = await this.db.get(
                `SELECT team_id FROM team_assignments
                 WHERE employee_id = ? AND is_primary = 1 AND (end_date IS NULL OR end_date >= ?)
                 ORDER BY id DESC LIMIT 1`, [emp.id, today]);
            if (fb) { row = { shift_code: null, team_id: fb.team_id }; source = 'primary_fallback'; }
        }
        return { today, row, source };
    }

    _teamView(teamById, teamId) {
        if (teamId == null) return { teamId: null, teamName: 'بدون فريق', center: null };
        const t = teamById.get(teamId);
        return { teamId, teamName: t ? t.name : 'بدون فريق', center: t ? (t.center || null) : null };
    }

    /** ملفي التشغيلي: الموظف + تكليف اليوم (roster ثم احتياطي is_primary موسومًا). */
    async getProfile(user) {
        const emp = await this.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const { teamById, codeMap } = await this._refs();
        const { today, row, source } = await this._resolveTodayAssignment(emp);

        const code = row && row.shift_code != null ? String(row.shift_code) : null;
        const codeRow = code ? codeMap.get(code) : null;
        const team = row ? this._teamView(teamById, row.team_id) : { teamId: null, teamName: null, center: null };
        // created_at وليس updated_at: المخطط القانوني لـshift_roster (db.js:369-380) لا يحوي updated_at
        // وإعادة الاستيراد تحذف الصفوف وتعيد إدراجها (server.js) فوقت الإنشاء = آخر كتابة فعلية
        const lastUpd = await this.db.get(
            'SELECT MAX(created_at) AS m FROM shift_roster WHERE employee_id = ?', [emp.id]);

        return {
            employee: { id: emp.id, code: emp.employee_code, name: emp.name, jobTitle: emp.job_title || null },
            today: {
                date: today,
                shiftCode: code,
                shiftName: codeRow ? codeRow.name : code,   // الاسم الرسمي أو الرمز خامًا (قرار ③ للرموز)
                timeStart: codeRow ? (codeRow.time_start || null) : null,
                timeEnd: codeRow ? (codeRow.time_end || null) : null,
                teamId: team.teamId, teamName: team.teamName, center: team.center,
                assignmentSource: source                       // roster | primary_fallback | none
            },
            lastRosterUpdate: lastUpd ? lastUpd.m : null
        };
    }

    /** جدولي: شهر كامل من roster + ترجمة رسمية للرموز + coverage صادقة. */
    async getSchedule(user, month, year) {
        const emp = await this.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const { teamById, codeMap } = await this._refs();
        // created_at بدل updated_at — نفس سبب profile أعلاه (المخطط القانوني بلا updated_at)
        const rows = await this.db.all(
            `SELECT shift_date, shift_code, team_id, created_at FROM shift_roster
             WHERE employee_id = ? AND month = ? AND year = ? ORDER BY shift_date`, [emp.id, month, year]);

        const days = rows.map(r => {
            const code = r.shift_code != null ? String(r.shift_code) : null;
            const c = code ? codeMap.get(code) : null;
            const team = this._teamView(teamById, r.team_id);
            return {
                date: r.shift_date, shiftCode: code,
                shiftName: c ? c.name : code,                 // رمز غير مسجل يُعرض خامًا — لا تفسير
                codeStatus: c ? (c.status || null) : null,    // دوام/إجازة/راحة… من السجل الرسمي
                teamId: team.teamId, teamName: team.teamName, center: team.center
            };
        });

        // قرار ⑤: coverage محسوبة على الأيام المنقضية فقط (حتى اليوم أو نهاية الشهر أيهما أسبق)
        const { start, end } = monthBounds(year, month);
        const today = riyadhToday();
        const effectiveEnd = today && today < end ? today : end;
        const elapsed = today && today < start ? 0 : daysBetween(start, effectiveEnd) + 1;
        const coveredDates = new Set(days.map(d => d.date)).size;
        const coverage = days.length === 0 ? 'none' : (coveredDates >= elapsed ? 'complete' : 'partial');
        const lastUpd = rows.reduce((m, r) => (r.created_at && r.created_at > m ? r.created_at : m), '');

        return { month, year, coverage, elapsedDays: elapsed, coveredDays: coveredDates, days, lastUpdate: lastUpd || null };
    }

    /** تجميع فترات التكليف: أيام متتالية لنفس الفرقة؛ الفجوة أو يوم بلا فرقة يكسر الفترة (قرار ③). */
    _buildPeriods(rows) {
        const periods = [];
        let cur = null;
        for (const r of rows) {
            const tid = r.team_id != null ? r.team_id : null;
            if (cur && tid === cur.teamId && addDays(cur.to, 1) === r.shift_date) {
                cur.to = r.shift_date;                        // امتداد متصل
            } else {
                if (cur) periods.push(cur);
                cur = { teamId: tid, from: r.shift_date, to: r.shift_date };
            }
        }
        if (cur) periods.push(cur);
        return periods;
    }

    /** تكليفاتي عبر الزمن — اشتقاق قراءة من roster، لا جدول جديد. */
    async getAssignments(user) {
        const emp = await this.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const { teamById } = await this._refs();
        const rows = await this.db.all(
            'SELECT shift_date, team_id FROM shift_roster WHERE employee_id = ? ORDER BY shift_date', [emp.id]);
        const periods = this._buildPeriods(rows)
            .filter(p => p.teamId != null)
            .map(p => ({ ...p, ...(() => { const t = this._teamView(teamById, p.teamId); return { teamName: t.teamName, center: t.center }; })() }))
            .reverse(); // الأحدث أولًا
        return { periods };
    }

    /**
     * بلاغات فرقتي أثناء تكليفي — تعريف معتمد:
     * بلاغ مميز (incident_number) على فرقة، تاريخه داخل يوم كان الموظف مكلفًا فيه
     * مع تلك الفرقة تحديدًا (قرار ⑥). المسحوبة والملغاة يدويًا مستبعدة
     * (نفس قاعدة المصدر القائمة). لا يمثل مباشرة شخصية — نص التوضيح ثابت بالرد.
     */
    async getTeamIncidents(user) {
        const emp = await this.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const { teamById, teamIdByName } = await this._refs();

        const rosterRows = await this.db.all(
            'SELECT shift_date, team_id FROM shift_roster WHERE employee_id = ? AND team_id IS NOT NULL ORDER BY shift_date',
            [emp.id]);
        const teamByDate = new Map(rosterRows.map(r => [r.shift_date, r.team_id]));
        const periods = this._buildPeriods(rosterRows).filter(p => p.teamId != null);

        const parts = await this.db.all(
            `SELECT t.incident_number, t.timestamp, r.unit, s.shift_date
             FROM report_times t
             JOIN reports r ON r.id = t.report_id
             LEFT JOIN shifts s ON s.id = r.shift_id
             WHERE (t.withdrawn IS NULL OR t.withdrawn = 0)
               AND (t.manual_cancelled IS NULL OR t.manual_cancelled = 0)`);

        // تجميع البلاغات المطابقة: مفتاح التمييز incident_number (بلاغ واحد بعدّة مشاركات = 1)
        const matched = []; // { incidentNumber, teamId, date }
        const seen = new Set();
        let unmatchedUnits = 0;
        for (const p of parts) {
            const teamId = p.unit != null ? teamIdByName.get(String(p.unit)) : undefined;
            if (teamId === undefined) { unmatchedUnits++; continue; }
            // التاريخ: ختم المناوبة أولًا، ثم سقوط لطابع CAD بتحويل الرياض (نمط المصدر القائم)
            const date = p.shift_date || riyadhDateOf(p.timestamp);
            if (!date) continue;
            if (teamByDate.get(date) !== teamId) continue;    // ليس يوم تكليفه مع هذه الفرقة
            const key = `${p.incident_number}::${teamId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            matched.push({ incidentNumber: p.incident_number, teamId, date });
        }

        const today = riyadhToday();
        const week = weekBoundsSatFri(today);
        const thisMonth = today ? today.slice(0, 7) : null;

        const inRange = d => d >= week.start && d <= week.end;
        const todayHasAssignment = today ? teamByDate.has(today) : false;

        // تفصيل الشهر حسب الفرقة (قرار ④): فترة التكليف ∩ الشهر + العدد داخلها
        const byTeam = [];
        if (thisMonth) {
            for (const per of periods) {
                const from = per.from < thisMonth + '-01' ? thisMonth + '-01' : per.from;
                const lastDay = monthBounds(+thisMonth.slice(0, 4), +thisMonth.slice(5, 7)).end;
                const to = per.to > lastDay ? lastDay : per.to;
                if (from > to) continue;
                const count = matched.filter(m => m.teamId === per.teamId && m.date >= from && m.date <= to).length;
                const tv = this._teamView(teamById, per.teamId);
                byTeam.push({ teamId: per.teamId, teamName: tv.teamName, center: tv.center, from, to, count });
            }
            byTeam.sort((a, b) => (a.from < b.from ? 1 : -1)); // الأحدث أولًا
        }

        return {
            today: {
                date: today,
                count: todayHasAssignment ? matched.filter(m => m.date === today).length : null,
                reason: todayHasAssignment ? null : 'no_assignment'  // لا صفر مموّه بلا تكليف
            },
            week: { start: week.start, end: week.end, count: matched.filter(m => inRange(m.date)).length },
            month: {
                year: thisMonth ? +thisMonth.slice(0, 4) : null,
                month: thisMonth ? +thisMonth.slice(5, 7) : null,
                count: thisMonth ? matched.filter(m => m.date.startsWith(thisMonth)).length : 0
            },
            byTeam,
            unmatchedUnits, // وحدات CAD لا تطابق اسم فرقة — تُعرض بصراحة ولا تُخفى
            note: 'تُحسب البلاغات المسجلة على الفرقة خلال الأيام التي كنت مكلّفًا فيها معها، ولا تمثل بالضرورة البلاغات التي باشرتها شخصيًا.'
        };
    }

    /**
     * v2: خريطة الأقسام — العرض بالتكليف الفعلي والارتباط بالبيانات (قرار ⑧).
     * profile/schedule/assignments ثابتة؛ البقية مشروطة:
     *   incidents ← أي تكليف roster فعلي بفرقة ميدانية (قرار ⑦).
     *   vehicle   ← فرقة اليوم (roster/احتياطي موسوم) ميدانية.
     *   inventory ← أصول غير مؤرشفة أو جلسة جرد مرتبطة بفرقة اليوم (assets.team_name).
     * canOpen للجرد يُحسب في المسار (صلاحية assets.inventory) — ليس هنا.
     */
    async getSections(user) {
        const emp = await this.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const { teamById } = await this._refs();
        const { row } = await this._resolveTodayAssignment(emp);
        const todayTeam = row && row.team_id != null ? teamById.get(row.team_id) : null;

        const rosterTeams = await this.db.all(
            'SELECT DISTINCT team_id FROM shift_roster WHERE employee_id = ? AND team_id IS NOT NULL', [emp.id]);
        const hasFieldAssignment = rosterTeams.some(r => this._isFieldTeam(teamById.get(r.team_id)));

        let inventory = false;
        if (todayTeam) {
            const a = await this.db.get(
                'SELECT COUNT(*) AS c FROM assets WHERE team_name = ? AND archived_at IS NULL', [todayTeam.name]);
            const s = await this.db.get(
                'SELECT COUNT(*) AS c FROM inventory_sessions WHERE team_name = ?', [todayTeam.name]);
            inventory = ((a && a.c) || 0) > 0 || ((s && s.c) || 0) > 0;
        }

        // v3: قسم التشييك — roster اليوم فقط (كتابة = بلا احتياطي) + فرقة ميدانية معتمدة
        let check = false;
        {
            const today = riyadhToday();
            const rr = await this.db.get(
                'SELECT team_id FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [emp.id, today]);
            const rt = rr && rr.team_id != null ? teamById.get(rr.team_id) : null;
            check = this._isFieldTeam(rt);
        }

        return {
            sections: {
                profile: true, schedule: true, assignments: true,
                incidents: hasFieldAssignment,
                vehicle: this._isFieldTeam(todayTeam),
                inventory,
                check
            }
        };
    }

    /** v2: مركبتي — مركبات فرقة اليوم المعيّنة حاليًا (اشتقاق getBoard نفسه عبر الخدمة الرسمية). */
    async getMyVehicle(user) {
        const emp = await this.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const { teamById } = await this._refs();
        const { row, source } = await this._resolveTodayAssignment(emp);
        const team = row && row.team_id != null ? teamById.get(row.team_id) : null;
        const view = team ? this._teamView(teamById, team.id) : { teamId: null, teamName: null, center: null };
        if (!this._isFieldTeam(team)) {
            return { team: view, assignmentSource: source, vehicles: [], available: true, reason: team ? 'ops_team' : 'no_team' };
        }
        const ves = this.getVehicleEventsService ? this.getVehicleEventsService() : null;
        if (!ves) return { team: view, assignmentSource: source, vehicles: [], available: false, reason: 'service_unavailable' };
        const vehicles = await ves.getTeamVehicles(team.id);
        return { team: view, assignmentSource: source, vehicles, available: true, reason: vehicles.length ? null : 'no_current_vehicle' };
    }

    /** v2: جرد فرقتي — ملخص الأصول غير المؤرشفة + آخر جلسة. قراءة فقط؛ الإجراء في المسار. */
    async getMyInventory(user) {
        const emp = await this.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const { teamById } = await this._refs();
        const { row, source } = await this._resolveTodayAssignment(emp);
        const team = row && row.team_id != null ? teamById.get(row.team_id) : null;
        const view = team ? this._teamView(teamById, team.id) : { teamId: null, teamName: null, center: null };
        if (!team) return { team: view, assignmentSource: source, hasData: false, assets: null, lastSession: null };

        const byStatus = {};
        let total = 0;
        const rows = await this.db.all(
            'SELECT status, COUNT(*) AS c FROM assets WHERE team_name = ? AND archived_at IS NULL GROUP BY status', [team.name]);
        for (const r of rows) { byStatus[r.status] = r.c; total += r.c; }
        const lastSession = await this.db.get(
            `SELECT id, status, started_at, submitted_at, approved_at, conductor_name
             FROM inventory_sessions WHERE team_name = ? ORDER BY id DESC LIMIT 1`, [team.name]);
        return {
            team: view, assignmentSource: source,
            hasData: total > 0 || !!lastSession,
            assets: { total, byStatus },
            lastSession: lastSession || null
        };
    }
}

module.exports = MyPortalService;
