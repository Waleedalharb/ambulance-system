/**
 * P1-B — تقييم تغطية مسودة التوليد في الذاكرة.
 * القيم من FSS فقط، ولا تُستخدم إلا مع إثبات اعتماد فعّال يطابق بصمتي الإعدادين.
 * لا fallback إلى 2/2/8 ولا requiredPersonnel ولا استنتاج من التاريخ، ولا حد total ثالث.
 */
'use strict';

const coverageService = require('./coverage-service.js');
const { canonicalStringify, contentHash, daysOfMonth } = require('./continuity-service.js');

const DEFAULT_KEY = 'schedule_engine.coverage_default';
const OVERRIDES_KEY = 'schedule_engine.coverage_team_overrides';

function key(employeeId, date) { return `${employeeId}|${date}`; }
function own(object, property) { return Object.prototype.hasOwnProperty.call(object, property); }
function validTarget(value) {
    return value && Number.isInteger(value.day) && value.day >= 0 &&
        Number.isInteger(value.night) && value.night >= 0;
}
function normalizeRule(value) {
    return validTarget(value) ? { day: value.day, night: value.night, total: value.day + value.night } : null;
}
function publicApproval(row) {
    return {
        id: row.id, team_id: row.team_id, applicability: row.applicability,
        coverage_default_hash: row.coverage_default_hash,
        coverage_overrides_hash: row.coverage_overrides_hash,
        source: row.source, approval_authority: row.approval_authority,
        approved_by: row.approved_by, approved_at: row.approved_at,
        effective_from: row.effective_from, effective_to: row.effective_to,
        status: row.status
    };
}
class GenerationCoverageService {
    constructor(db) { this.db = db; }

    async createContext(month, cells) {
        const [coverageDefault, overrides, approvalRows, teams, codes] = await Promise.all([
            this.db.AppSettings.get(DEFAULT_KEY),
            this.db.AppSettings.get(OVERRIDES_KEY),
            this.db.all(`SELECT * FROM schedule_coverage_approvals WHERE status = 'active'
                AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
                ORDER BY team_id, effective_from, approved_at, id`, [month + '-31', month + '-01']),
            this.db.all('SELECT id, name, center, is_active FROM teams ORDER BY id'),
            this.db.ShiftCodes.getAll()
        ]);
        const defaultHash = contentHash(coverageDefault);
        const overridesHash = contentHash(overrides);
        const policy = {
            schema: 'p1-b-coverage-v1', month,
            coverage_default: coverageDefault,
            coverage_team_overrides: overrides,
            coverage_default_hash: defaultHash,
            coverage_overrides_hash: overridesHash,
            approvals: approvalRows.map(publicApproval)
        };
        return {
            month, cells, teams, codeMap: new Map((codes || []).map(code => [String(code.code), code])),
            coverageDefault, overrides: overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {},
            overridesValid: !!overrides && typeof overrides === 'object' && !Array.isArray(overrides),
            defaultHash, overridesHash, approvalRows,
            coveragePolicyVersion: contentHash(policy),
            policy
        };
    }

    resolution(context, teamId, date) {
        const all = context.approvalRows.filter(row => Number(row.team_id) === Number(teamId) &&
            row.effective_from <= date && (!row.effective_to || row.effective_to >= date));
        const matching = all.filter(row => row.coverage_default_hash === context.defaultHash &&
            row.coverage_overrides_hash === context.overridesHash);
        if (!matching.length) {
            return {
                applicability: 'unresolved', rule: null, approvals: [],
                reason: all.length ? 'COVERAGE_APPROVAL_STALE' : 'COVERAGE_APPROVAL_MISSING'
            };
        }
        const kinds = [...new Set(matching.map(row => row.applicability))];
        if (kinds.length > 1) {
            return {
                applicability: 'unresolved', rule: null, approvals: matching.map(publicApproval),
                reason: 'COVERAGE_APPROVAL_CONFLICT'
            };
        }
        const selected = matching[matching.length - 1];
        if (selected.applicability === 'not_applicable') {
            return { applicability: 'not_applicable', rule: null, approvals: matching.map(publicApproval), reason: null };
        }
        let raw = context.coverageDefault;
        if (context.overridesValid && own(context.overrides, String(teamId))) raw = context.overrides[String(teamId)];
        const rule = normalizeRule(raw);
        if (!rule) {
            return {
                applicability: 'unresolved', rule: null, approvals: matching.map(publicApproval),
                reason: 'COVERAGE_VALUES_UNRESOLVED'
            };
        }
        return { applicability: 'required', rule, approvals: matching.map(publicApproval), reason: null };
    }

    async compute(context, teamId, date) {
        const team = context.teams.find(row => Number(row.id) === Number(teamId));
        const resolution = this.resolution(context, teamId, date);
        const count = { day: 0, night: 0, total: 0 };
        const periods = new Map();
        for (const cell of context.cells.values()) {
            if (Number(cell.team_id) !== Number(teamId) || cell.shift_date !== date) continue;
            const period = coverageService.periodOf(context.codeMap.get(String(cell.shift_code)));
            if (!period) continue;
            periods.set(Number(cell.employee_id), period);
            count[period]++; count.total++;
        }
        const approved = await this.db.UnableAttendRequests.getApprovedForTeamDate(teamId, date);
        let approvedOut = 0;
        for (const row of approved || []) {
            const period = periods.get(Number(row.employee_id));
            if (!period) continue;
            count[period]--; count.total--; approvedOut++;
        }
        const missing = [];
        if (resolution.applicability === 'required') {
            if (count.day < resolution.rule.day) missing.push('day');
            if (count.night < resolution.rule.night) missing.push('night');
        } else if (resolution.applicability === 'unresolved') {
            missing.push('unresolved');
        }
        return {
            ...count, rule: resolution.rule, met: missing.length === 0, missing,
            center: team ? team.center : null, approved_out: approvedOut,
            applicability: resolution.applicability,
            unresolved_reason: resolution.reason,
            approval_ids: resolution.approvals.map(row => row.id)
        };
    }

    async assessChange(context, { teamId, date, removeEmployeeIds = [], addShiftCode = null }) {
        const before = await this.compute(context, teamId, date);
        const after = { day: before.day, night: before.night, total: before.total };
        let removedCoverage = 0;
        for (const employeeId of removeEmployeeIds) {
            const cell = context.cells.get(key(employeeId, date));
            if (!cell || Number(cell.team_id) !== Number(teamId)) continue;
            const period = coverageService.periodOf(context.codeMap.get(String(cell.shift_code)));
            if (!period) continue;
            after[period]--; after.total--; removedCoverage++;
        }
        if (addShiftCode) {
            const period = coverageService.periodOf(context.codeMap.get(String(addShiftCode)));
            if (period) { after[period]++; after.total++; }
        }
        const missing = [];
        if (before.applicability === 'required') {
            if (after.day < before.rule.day) missing.push('day');
            if (after.night < before.rule.night) missing.push('night');
        } else if (before.applicability === 'unresolved') {
            missing.push('unresolved');
        }
        const met = missing.length === 0;
        const decreased = after.day < before.day || after.night < before.night || after.total < before.total;
        const strip = value => ({
            day: value.day, night: value.night, total: value.total,
            rule: value.rule, met: value.met, missing: value.missing, center: value.center,
            applicability: value.applicability, unresolved_reason: value.unresolved_reason || null
        });
        const afterValue = {
            ...after, rule: before.rule, met, missing, center: before.center,
            applicability: before.applicability, unresolved_reason: before.unresolved_reason
        };
        return {
            coverage_before: strip(before), coverage_after: strip(afterValue),
            wouldBreak: decreased && !met,
            still_below_minimum: !met,
            detail: { removed_coverage: removedCoverage, added: addShiftCode || null, approved_out: before.approved_out }
        };
    }

    async evaluateAll(context) {
        const coverage = [];
        const unresolvedTeams = new Map();
        const shortages = [];
        for (const team of context.teams.filter(row => row.is_active === 1)) {
            for (const date of daysOfMonth(context.month)) {
                const value = await this.compute(context, team.id, date);
                const item = { team_id: team.id, team_name: team.name, date, ...value };
                coverage.push(item);
                if (value.applicability === 'unresolved') {
                    if (!unresolvedTeams.has(team.id)) {
                        unresolvedTeams.set(team.id, {
                            team_id: team.id, team_name: team.name,
                            reason: value.unresolved_reason, dates: []
                        });
                    }
                    unresolvedTeams.get(team.id).dates.push(date);
                } else if (value.applicability === 'required' && !value.met) {
                    shortages.push({
                        team_id: team.id, team_name: team.name, date,
                        missing: value.missing,
                        required: { day: value.rule.day, night: value.rule.night },
                        actual: { day: value.day, night: value.night, total: value.total }
                    });
                }
            }
        }
        return { coverage, unresolved_teams: [...unresolvedTeams.values()], shortages };
    }
}

module.exports = { GenerationCoverageService, DEFAULT_KEY, OVERRIDES_KEY, key };
