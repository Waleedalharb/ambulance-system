/**
 * Crew Activity Engine — محرك نشاط الفرق الإسعافية (Phase B)
 * ═══════════════════════════════════════════════════════════
 * قرار المالك 2026-08-18: يجيب على سؤال واحد فقط — «من الأكثر نشاطًا؟»
 * (عدد البلاغات المباشرة + معدل النشاط بالنسبة للوقت). ليس تقييم أداء،
 * ولا يستخدم avg_response_time ولا report_entries إطلاقًا.
 *
 * قراءة فقط من SSOT (reports / report_times / shifts / operational_events /
 * shift_completions / shift_roster) — بلا كاش ولا تجميد ولا جداول موازية:
 * التراجع عن بلاغ (حذف صف report_times) ينعكس فورًا بحكم البنية.
 *
 * قاعدة الأسماء الذهبية (قرار المالك): أسماء أفراد الفرقة تُشتق من أحداث
 * المناوبة نفسها المقاسة (operational_events لذلك shift_id حصرًا)، بسقوط
 * صادق للمناوبات القديمة (shift_roster لتاريخها) — ولا يجوز إطلاقًا أن
 * تظهر أسماء مناوبة سابقة بجانب إنجاز مناوبة جديدة.
 *
 * الترتيب الثابت (قرار المالك): activity_rate_per_hour تنازليًا، عند
 * التعادل reports_count تنازليًا، ثم اسم الفرقة أبجديًا كـ tie-breaker ثابت.
 */

const TimeRiyadh = require('../public/js/time-riyadh.js');

// نفس منطق canonicalTeamId في staffing-events-service.js — يجب أن يبقيا متطابقين.
// rapid_N / «تدخل سريع N» → «سريع N»، والأرقام العربية → غربية.
function canonicalTeam(teamId) {
    if (teamId == null) return null;
    let t = String(teamId).trim();
    const arabicToWestern = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
    t = t.split('').map(c => arabicToWestern[c] || c).join('');
    const rapid = t.match(/^(?:rapid_|تدخل سريع\s*)(\d+)$/);
    if (rapid) return 'سريع ' + parseInt(rapid[1], 10);
    return t;
}

const PERIODS = ['current_shift', 'today', 'week', 'month'];
const TOPS = [3, 5];

// ─── حساب التقويم الرياضي الجداري (نقطة اصطلاح معتمدة: الأسبوع = أحد ← سبت) ───
// اليوميات النصية بصيغة YYYY-MM-DD؛ حساب اليوم الأسبوعي عبر UTC حتى لا يتأثر
// بمنطقة الخادم (اليوم الجداري ثابت لأي تاريخ ميلادي).
function riyadhToday() {
    return TimeRiyadh.formatDate(new Date());
}
function dateAdd(ymd, days) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
    return dt.toISOString().slice(0, 10);
}
function weekdayOf(ymd) { // 0=الأحد
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// أوقات المناوبة: start_time بصيغة ISO (…Z)، وend_time بصيغة datetime('now')
// في SQLite (UTC نصي بلا Z) — كلاهما UTC؛ التحويل هنا يوحّد التفسير.
function parseShiftTime(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    const iso = s.includes('T') ? s : s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
    const t = new Date(iso).getTime();
    return isNaN(t) ? null : t;
}

class CrewActivityService {
    /**
     * @param {Object} deps
     * @param {Object} deps.engine - OperationsEngine instance (قراءة storage فقط)
     */
    constructor({ engine }) {
        if (!engine) throw new Error('CrewActivityService requires an OperationsEngine instance');
        this.engine = engine;
    }

    storage() { return this.engine.storage; }

    /**
     * @param {Object} q
     * @param {string} [q.scope='south'] - اليوم قيمة واحدة فقط؛ البنية تقبل التوسعة
     * @param {string} [q.period='current_shift'] - current_shift|today|week|month
     * @param {number} [q.top=3] - 3 أو 5
     */
    async getActivity({ scope = 'south', period = 'current_shift', top = 3 } = {}) {
        if (scope !== 'south') {
            throw Object.assign(new Error('نطاق غير مدعوم حاليًا — المتاح: south'), { status: 400 });
        }
        if (!PERIODS.includes(period)) {
            throw Object.assign(new Error('فترة غير صالحة — المتاح: ' + PERIODS.join('/')), { status: 400 });
        }
        top = Number(top);
        if (!TOPS.includes(top)) {
            throw Object.assign(new Error('top المتاح: 3 أو 5'), { status: 400 });
        }

        const shifts = await this._shiftsInPeriod(period);
        if (period === 'current_shift' && !shifts.length) {
            throw Object.assign(new Error('لا توجد مناوبة نشطة'), { status: 404 });
        }

        const emptyRange = this._periodRange(period, shifts);
        if (!shifts.length) {
            return {
                success: true, scope, period, period_range: emptyRange,
                label: 'الأكثر نشاطًا', generated_at: new Date().toISOString(),
                standings: [],
                meta: { teams_ranked: 0, teams_active_without_reports: 0,
                    note: 'الترتيب نشاط فقط (عدد البلاغات المباشرة) — ليس تقييم أداء' }
            };
        }

        const shiftIds = shifts.map(s => s.id);
        const [reportRows, personRows, statusRows] = await Promise.all([
            // البلاغ الرسمي: كل صف report_times = بلاغ واحد (managers.js:218)
            this.storage().all(
                `SELECT r.shift_id, r.unit, COUNT(rt.id) AS cnt
                 FROM reports r JOIN report_times rt ON rt.report_id = r.id
                 WHERE r.shift_id IN (${shiftIds.map(() => '?').join(',')})
                 GROUP BY r.shift_id, r.unit`, shiftIds),
            // الأسماء: أحداث المناوبة نفسها حصرًا — لا أسماء ثابتة ولا مناوبة سابقة
            this.storage().all(
                `SELECT shift_id, team_id, entity_name, MIN(created_at) AS first_at
                 FROM operational_events
                 WHERE domain = 'staffing' AND entity_name IS NOT NULL AND entity_name != ''
                   AND shift_id IN (${shiftIds.map(() => '?').join(',')})
                 GROUP BY shift_id, team_id, entity_name
                 ORDER BY first_at`, shiftIds),
            // جاهزية الفرقة: الأحداث الجماعية (entity_id NULL) ready/missing/offline
            this.storage().all(
                `SELECT shift_id, team_id, event_type, created_at
                 FROM operational_events
                 WHERE domain = 'staffing' AND entity_id IS NULL
                   AND event_type IN ('ready', 'missing', 'offline')
                   AND shift_id IN (${shiftIds.map(() => '?').join(',')})
                 ORDER BY created_at, id`, shiftIds)
        ]);

        const shiftById = {};
        for (const s of shifts) shiftById[s.id] = s;

        // ─── تجميع لكل (مناوبة × فرقة) ───
        const cellKey = (sid, team) => sid + '|' + team;
        const cells = {}; // key → { shift, team, reports_count, members[], ... }
        const ensureCell = (sid, team) => {
            const k = cellKey(sid, team);
            if (!cells[k]) {
                cells[k] = { shift: shiftById[sid], team, reports_count: 0, members: [],
                    hasPersonEvents: false, hasStatusEvents: false, hasRoster: false };
            }
            return cells[k];
        };

        for (const r of reportRows) {
            const team = canonicalTeam(r.unit);
            if (!team || !shiftById[r.shift_id]) continue;
            ensureCell(r.shift_id, team).reports_count = r.cnt;
        }
        for (const p of personRows) {
            const team = canonicalTeam(p.team_id);
            if (!team || !shiftById[p.shift_id]) continue;
            const cell = ensureCell(p.shift_id, team);
            cell.hasPersonEvents = true;
            cell.members.push(p.entity_name);
        }
        for (const st of statusRows) {
            const team = canonicalTeam(st.team_id);
            if (!team || !shiftById[st.shift_id]) continue;
            const cell = ensureCell(st.shift_id, team);
            cell.hasStatusEvents = true;
            (cell.statusEvents = cell.statusEvents || []).push(st);
        }

        // ─── السقوط الصادق للأسماء: roster لتاريخ المناوبة نفسها (بلا اختلاق) ───
        for (const k of Object.keys(cells)) {
            const cell = cells[k];
            if (cell.members.length) continue;
            const named = await this.storage().all(
                `SELECT e.name AS name
                 FROM shift_roster sr
                 JOIN teams t ON t.id = sr.team_id
                 JOIN employees e ON e.id = sr.employee_id
                 WHERE sr.shift_date = ? AND t.name = ?`, [cell.shift.shift_date, cell.team]);
            for (const n of named) {
                if (!cell.members.includes(n.name)) cell.members.push(n.name);
            }
            if (named.length) cell.hasRoster = true;
        }

        // ─── الفرق العاملة بلا بلاغات: دليل عملها = أحداث/roster للفترة ───
        // (خلية وُجدت بأحداث لكن reports_count = 0)

        // ─── مدد المناوبة والنشاط ───
        const now = Date.now();
        for (const k of Object.keys(cells)) {
            const cell = cells[k];
            const s = cell.shift;
            const startMs = parseShiftTime(s.start_time);
            let endMs = parseShiftTime(s.end_time);
            if (endMs == null && s.status === 'active') endMs = now;
            cell.shift_minutes = (startMs != null && endMs != null && endMs > startMs)
                ? Math.round((endMs - startMs) / 60000) : 0;

            // active_minutes: مدة المناوبة − فترات missing/offline حتى ready التالي
            if (!cell.statusEvents || !cell.statusEvents.length) {
                cell.active_minutes = cell.shift_minutes;
                cell.active_minutes_estimated = true; // قرار المالك: سقوط صادق موسوم
            } else {
                let inactive = 0;
                let openAt = null;
                for (const ev of cell.statusEvents) {
                    const at = parseShiftTime(ev.created_at);
                    if (at == null) continue;
                    if (ev.event_type === 'missing' || ev.event_type === 'offline') {
                        if (openAt == null) openAt = at;
                    } else if (ev.event_type === 'ready') {
                        if (openAt != null) { inactive += Math.max(0, at - openAt); openAt = null; }
                    }
                }
                if (openAt != null && endMs != null) inactive += Math.max(0, endMs - openAt);
                cell.active_minutes = Math.max(0, cell.shift_minutes - Math.round(inactive / 60000));
                cell.active_minutes_estimated = false;
            }
        }

        // ─── تجميع الفرقة عبر مناوبات الفترة ───
        const teams = {}; // team → aggregate
        for (const k of Object.keys(cells)) {
            const cell = cells[k];
            const t = teams[cell.team] || (teams[cell.team] = {
                team: cell.team, center: null, reports_count: 0,
                members: [], shift_minutes: 0, active_minutes: 0,
                active_minutes_estimated: true, shifts: [], worked: false
            });
            const s = cell.shift;
            t.worked = t.worked || cell.hasPersonEvents || cell.hasStatusEvents || cell.hasRoster || cell.reports_count > 0;
            t.reports_count += cell.reports_count;
            t.shift_minutes += cell.shift_minutes;
            t.active_minutes += cell.active_minutes;
            if (!cell.active_minutes_estimated) t.active_minutes_estimated = false;
            // اتحاد الأسماء بترتيب ظهورها زمنيًا عبر مناوبات الفترة
            for (const m of cell.members) if (!t.members.includes(m)) t.members.push(m);
            if (cell.reports_count > 0 || cell.members.length || cell.hasStatusEvents) {
                t.shifts.push({
                    shift_id: s.id, shift_date: s.shift_date, shift_type: s.shift_type,
                    reports_count: cell.reports_count, members: cell.members
                });
            }
        }
        // المركز من أحدث مناوبة وردت فيها بلاغات الفرقة (عرضي فقط)
        const centerRows = await this.storage().all(
            `SELECT unit, center FROM reports WHERE shift_id IN (${shiftIds.map(() => '?').join(',')})
             ORDER BY id DESC`, shiftIds);
        for (const r of centerRows) {
            const team = canonicalTeam(r.unit);
            if (team && teams[team] && !teams[team].center) teams[team].center = r.center;
        }

        // ─── standings: فقط من له بلاغات ≥1 — العامل بلا بلاغات ليس «صفر أداء» ───
        const ranked = Object.values(teams).filter(t => t.reports_count >= 1);
        const activeNoReports = Object.values(teams).filter(t => t.reports_count === 0 && t.worked).length;

        for (const t of ranked) {
            t.activity_rate_per_hour = t.active_minutes > 0
                ? Math.round((t.reports_count / (t.active_minutes / 60)) * 100) / 100
                : null;
            t.shifts.sort((a, b) => String(b.shift_date).localeCompare(String(a.shift_date)) || (b.shift_id - a.shift_id));
        }
        // قاعدة الترتيب الثابتة (قرار المالك)
        ranked.sort((a, b) => {
            const ra = a.activity_rate_per_hour == null ? -1 : a.activity_rate_per_hour;
            const rb = b.activity_rate_per_hour == null ? -1 : b.activity_rate_per_hour;
            if (rb !== ra) return rb - ra;
            if (b.reports_count !== a.reports_count) return b.reports_count - a.reports_count;
            return a.team.localeCompare(b.team, 'ar');
        });
        ranked.forEach((t, i) => { t.rank = i + 1; });

        return {
            success: true, scope, period,
            period_range: this._periodRange(period, shifts),
            label: 'الأكثر نشاطًا',
            generated_at: new Date().toISOString(),
            standings: ranked.slice(0, top).map(t => ({
                rank: t.rank, team: t.team, center: t.center,
                reports_count: t.reports_count, members: t.members,
                shift_minutes: t.shift_minutes, active_minutes: t.active_minutes,
                active_minutes_estimated: t.active_minutes_estimated,
                activity_rate_per_hour: t.activity_rate_per_hour,
                shifts: t.shifts
            })),
            meta: {
                teams_ranked: ranked.length,
                teams_active_without_reports: activeNoReports,
                note: 'الترتيب نشاط فقط (عدد البلاغات المباشرة) — ليس تقييم أداء'
            }
        };
    }

    async _shiftsInPeriod(period) {
        if (period === 'current_shift') {
            return this.storage().all(
                `SELECT id, shift_date, shift_type, start_time, end_time, status
                 FROM shifts WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
        }
        const today = riyadhToday();
        let from, to;
        if (period === 'today') { from = today; to = today; }
        else if (period === 'week') { from = dateAdd(today, -weekdayOf(today)); to = dateAdd(from, 6); }
        else { from = today.slice(0, 8) + '01'; to = today.slice(0, 8) + '31'; }
        return this.storage().all(
            `SELECT id, shift_date, shift_type, start_time, end_time, status
             FROM shifts WHERE shift_date >= ? AND shift_date <= ? ORDER BY id`, [from, to]);
    }

    _periodRange(period, shifts) {
        if (period === 'current_shift') {
            const s = shifts[0];
            return { from: s ? s.shift_date : null, to: s ? s.shift_date : null, shifts_count: shifts.length };
        }
        const dates = shifts.map(s => s.shift_date).sort();
        return { from: dates[0] || null, to: dates[dates.length - 1] || null, shifts_count: shifts.length };
    }
}

module.exports = CrewActivityService;
