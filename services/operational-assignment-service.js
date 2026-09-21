/**
 * ═══ operational-assignment-service.js — التكليف التشغيلي الفعلي (معتمد 2026-09-21) ═══
 * «من هو فعليًا في الفرقة الآن» — اشتقاق قراءة صِرف بلا أي كتابة، مبني على
 * الاشتقاق المُثبت في StaffingEventsService.getState (طيّ الأحداث + التصحيحات +
 * effectiveRoster = من يُنهي المناوبة مع الفريق فعلًا). لا منطق موازٍ ولا نسخ قواعد.
 *
 * القرارات المعتمدة من المالك:
 *  1) التعارض: correction أولًا ثم طيّ زمني (كلاهما داخل getState) · الغياب أعلى من
 *     الإسناد · إسنادان متعارضان = رفض بلا تخمين (conflicting_assignment).
 *  2) مطابقة الشخص: employee_code أولًا ثم الاسم التام · الالتباس = لا مطابقة.
 *  3) لا مناوبة نشطة ← الجدولة فقط (لا تخمين أحداث من مناوبة أخرى).
 *  4) exit المفتوح = غياب (لا إرسال حتى إغلاقه بعودة return).
 *  5) activation المفتوح = إسناد تشغيلي (المفعَّل يرسل على فرقة تفعيله).
 *
 * النطاق: Team Live Location فقط. check-session لا يُمسّ (موضوع مستقل مؤجل).
 */
'use strict';

const MyPortalService = require('./my-portal-service'); // FIELD_TEAM_TYPES المشتركة

class OperationalAssignmentService {
    /**
     * @param {object} deps
     * @param {object} deps.db — طبقة القاعدة (أنواع الفرق)
     * @param {object} deps.portal — MyPortalService (resolveEmployee + _resolveTodayAssignment)
     * @param {Function} deps.getStaffingEventsService — مزوّد كسول لخدمة أحداث القوى البشرية
     * @param {Function} deps.getActiveShift — مزوّد كسول للمناوبة النشطة (opsEngine.shifts)
     */
    constructor({ db, portal, getStaffingEventsService, getActiveShift } = {}) {
        if (!db) throw new Error('OperationalAssignmentService: db مطلوب');
        if (!portal) throw new Error('OperationalAssignmentService: portal مطلوب');
        this.db = db;
        this.portal = portal;
        this.getStaffingEventsService = typeof getStaffingEventsService === 'function' ? getStaffingEventsService : () => null;
        this.getActiveShift = typeof getActiveShift === 'function' ? getActiveShift : async () => null;
    }

    /** مطابقة عضو مشتق مع موظف: الكود أولًا ثم الاسم التام — الالتباس = لا مطابقة (قرار 2). */
    static personMatches(member, emp) {
        if (!member) return false;
        if (member.code && emp.employee_code && String(member.code) === String(emp.employee_code)) return true;
        return !!member.name && member.name === emp.name;
    }

    /**
     * التكليف التشغيلي الفعلي لموظف بوابة.
     * @returns {Promise<{notFound?:boolean, deployable:boolean, blockReason?:string,
     *   teamId?:number, teamName?:string, source?:'roster'|'assignment_event',
     *   shiftMode:'roster_only'|'active_shift'|'staffing_unavailable', warnings:string[]}>}
     */
    async resolveEffectiveAssignment(user) {
        const emp = await this.portal.resolveEmployee(user);
        if (!emp) return { notFound: true, deployable: false, blockReason: 'no_employee', shiftMode: 'roster_only', warnings: [] };
        const base = { employeeId: emp.id, employeeName: emp.name };
        const { row } = await this.portal._resolveTodayAssignment(emp);
        const rosterTeamId = row && row.team_id != null ? row.team_id : null;
        const warnings = [];

        const teams = await this.db.all('SELECT id, name, team_type, is_active FROM teams');
        const teamById = new Map(teams.map(t => [t.id, t]));
        const teamByName = new Map(teams.map(t => [String(t.name), t]));
        const isField = t => !!t && !!t.is_active && MyPortalService.FIELD_TEAM_TYPES.indexOf(t.team_type) !== -1;

        const rosterResult = (mode) => {
            const t = rosterTeamId != null ? teamById.get(rosterTeamId) : null;
            if (!t || !isField(t)) {
                return { ...base, deployable: false, blockReason: t ? 'not_field_team' : 'no_assignment', shiftMode: mode, warnings };
            }
            return { ...base, deployable: true, teamId: t.id, teamName: t.name, source: 'roster', shiftMode: mode, warnings };
        };

        // قرار 3: لا مناوبة نشطة ← الجدولة فقط، بلا تخمين أحداث
        let activeShift = null;
        try { activeShift = await this.getActiveShift(); } catch (_) { activeShift = null; }
        if (!activeShift) return rosterResult('roster_only');

        const svc = this.getStaffingEventsService();
        if (!svc) {
            warnings.push('staffing_unavailable');
            return rosterResult('staffing_unavailable'); // سلوك TL1 القائم — موثق بصراحة
        }

        let state;
        try {
            state = await svc.getState(activeShift.id, { canPhone: false });
        } catch (e) {
            warnings.push('staffing_error:' + e.message);
            return rosterResult('staffing_unavailable');
        }

        // ── الحجب الشامل: غياب/تأخر مفتوح (من اشتقاق getState نفسه) في أي فرقة ──
        // الغياب أعلى من الإسناد (قرار 1): يُفحص قبل أي قبول، ويشمل المفعَّل الغائب.
        for (const t of Object.values((state && state.teams) || {})) {
            for (const m of (t.members || [])) {
                if (!OperationalAssignmentService.personMatches(m, emp)) continue;
                if (m.state === 'absence' || m.state === 'late') {
                    return { ...base, deployable: false, blockReason: 'absent', shiftMode: 'active_shift', warnings };
                }
            }
        }
        // ── قرار 4: exit مفتوح (بلا return يغلقه في الطيّ) = غياب ──
        for (const ent of (state && state.entities) || []) {
            if (ent.entityId !== emp.name) continue; // entity_id اسمي — مطابقة تامة فقط
            if ((ent.open || []).some(o => o.event_type === 'exit')) {
                return { ...base, deployable: false, blockReason: 'absent', shiftMode: 'active_shift', warnings };
            }
        }

        // ── العضوية الفعلية: effectiveRoster = من يُنهي المناوبة مع الفريق فعلًا ──
        // (نشط بلا غياب + دعم وارد + تكليف وارد + تفعيل حاضر — اشتقاق getState نفسه)
        const effective = [];
        for (const [teamName, t] of Object.entries((state && state.teams) || {})) {
            const teamRow = teamByName.get(teamName);
            if (!isField(teamRow)) continue; // الموقع للفرق الميدانية فقط
            for (const m of (t.effectiveRoster || [])) {
                if (OperationalAssignmentService.personMatches(m, emp)) {
                    effective.push({ team: teamRow, role: m.role, state: m.state });
                }
            }
        }
        // قرار 1: إسنادان متعارضان لفرقتين ميدانيتين = رفض بلا تخمين
        const distinctTeams = new Set(effective.map(e => e.team.id));
        if (distinctTeams.size > 1) {
            return { ...base, deployable: false, blockReason: 'conflicting_assignment', shiftMode: 'active_shift', warnings };
        }
        if (effective.length > 0) {
            const e = effective[0];
            return {
                ...base,
                deployable: true, teamId: e.team.id, teamName: e.team.name,
                source: e.role === 'base' ? 'roster' : 'assignment_event', // support/activation = إسناد تشغيلي (قرار 5)
                shiftMode: 'active_shift', warnings
            };
        }

        // مُسند خارجًا (base state=assignment) بلا مقابل وارد في فرق المناوبة ←
        // وجهته خارج فرق هذه المناوبة — صادق: لا تكليف فعلي يمكن إرسال موقع له
        for (const t of Object.values((state && state.teams) || {})) {
            for (const m of (t.members || [])) {
                if (OperationalAssignmentService.personMatches(m, emp) && m.role === 'base' && m.state === 'assignment') {
                    return { ...base, deployable: false, blockReason: 'no_assignment', shiftMode: 'active_shift', warnings };
                }
            }
        }

        // خارج رؤية المناوبة تمامًا (فرقته ليست في خطة هذه المناوبة مثلًا) ←
        // الجدولة أساسه الصادق، والحجب أعلاه سبق أن طُبق
        return rosterResult('active_shift');
    }
}

module.exports = OperationalAssignmentService;
