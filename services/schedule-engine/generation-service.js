/**
 * P1-B — توليد مسودة من آخر مرجع معتمد مع E-4 وM5 وminimal-diff.
 *
 * - لا كتابة في shift_roster أو schedule_months، ولا اعتماد/نشر/إشعارات.
 * - الطور يأتي من لقطة P1-A والدورة الصريحة فقط، ويستمر خلال الإجازة/الاستثناء.
 * - قيم التغطية وإثباتاتها عبر GenerationCoverageService؛ لا قيم افتراضية بديلة.
 * - كل تشغيل وإصداره ومدخلاته وفروقاته ومدخلات التدقيق في معاملة واحدة غير قابلة للتعديل.
 */
'use strict';

const crypto = require('crypto');
const { assertScheduleGenerationAccess } = require('../schedule-generation-access.js');
const { ContinuityService, canonicalStringify, contentHash, daysOfMonth, parseCycleRow } = require('./continuity-service.js');
const { GenerationCoverageService, key } = require('./generation-coverage-service.js');
const { validateAssignment } = require('./validation-service.js');
const { rankCandidates } = require('./ranking-service.js');
const coverageService = require('./coverage-service.js');
const { getEngineSetting } = require('./config.js');
const { fail, actor, auditTx } = require('./generation-error.js');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const LEAVE_CODES = Object.freeze({ 'مرضية': 'S', 'استثنائية': 'EV' });

function parseJson(text, fallback = null) {
    try { return JSON.parse(text); } catch (_) { return fallback; }
}
function shiftDate(date, amount) {
    const value = new Date(date + 'T00:00:00Z');
    value.setUTCDate(value.getUTCDate() + amount);
    return value.toISOString().slice(0, 10);
}
function datesBetween(start, end, month) {
    const days = daysOfMonth(month);
    return days.filter(date => date >= start && date <= end);
}
function cellPublic(cell) {
    return {
        employee_id: Number(cell.employee_id), date: cell.shift_date,
        team_id: cell.team_id === null ? null : Number(cell.team_id),
        shift_code: cell.shift_code, source: cell.source, reason: cell.reason,
        leave_id: cell.leave_id || null, exception_id: cell.exception_id || null,
        affected: cell.affected ? 1 : 0
    };
}
function sameCell(a, b) {
    if (!a || !b) return a === b;
    return Number(a.employee_id) === Number(b.employee_id) && a.shift_date === b.shift_date &&
        (a.team_id === null ? null : Number(a.team_id)) === (b.team_id === null ? null : Number(b.team_id)) &&
        String(a.shift_code) === String(b.shift_code);
}
function mapById(rows) { return new Map((rows || []).map(row => [String(row.id), row])); }
function cloneCorrectionMetadata(metadata, baseVersion) {
    if (!metadata || !metadata.reason || !metadata.parent_version_id) {
        fail(409, 'CORRECTION_METADATA_REQUIRED', `بيانات التصحيح الموثقة مفقودة في الإصدار ${baseVersion.id}`);
    }
    return JSON.parse(JSON.stringify(metadata));
}
function changedRows(before, after) {
    const a = mapById(before), b = mapById(after);
    const ids = new Set([...a.keys(), ...b.keys()]);
    const changed = [];
    for (const id of ids) {
        if (canonicalStringify(a.get(id) || null) !== canonicalStringify(b.get(id) || null)) {
            changed.push({ before: a.get(id) || null, after: b.get(id) || null });
        }
    }
    return changed;
}

class ScheduleGenerationService {
    constructor(db, permissionServiceOrFactory) {
        if (!db || !db.tx || !db.tx.immediate) throw new Error('ScheduleGenerationService: db.tx.immediate مطلوب');
        this.db = db;
        this.permissionServiceOrFactory = permissionServiceOrFactory;
        this.continuity = new ContinuityService(db);
        this.coverage = new GenerationCoverageService(db);
    }

    async generate({ targetMonth, user, sourceNote = null }) {
        await assertScheduleGenerationAccess(user, this.permissionServiceOrFactory);
        return this._generate({ targetMonth, baseRunId: null, user, sourceNote });
    }

    async regenerate({ baseRunId, user, sourceNote = null }) {
        await assertScheduleGenerationAccess(user, this.permissionServiceOrFactory);
        if (!baseRunId) fail(422, 'BASE_RUN_REQUIRED', 'تشغيل الأساس مطلوب لإعادة التوليد');
        const base = await this.getRun(baseRunId);
        return this._generate({ targetMonth: base.target_month, baseRunId, user, sourceNote });
    }

    async _reference(targetMonth) {
        if (!MONTH_RE.test(String(targetMonth || ''))) fail(422, 'INVALID_MONTH', 'صيغة الشهر الهدف غير صالحة — المطلوب YYYY-MM');
        const result = await this.continuity.getReference(targetMonth);
        if (!result.usable || !result.reference) {
            fail(409, result.reason || 'NO_APPROVED_REFERENCE', 'لا يوجد مرجع معتمد للشهر السابق مباشرة');
        }
        const reference = result.reference;
        const snapshot = reference.current_snapshot;
        if (reference.version_kind !== 'bootstrap_reference' || !['approved', 'published'].includes(reference.status) ||
            !snapshot || snapshot.status !== 'approved') {
            fail(409, 'REFERENCE_NOT_USABLE', 'المرجع أو لقطة الاستمرارية ليسا معتمدين');
        }
        if (snapshot.source_content_hash !== contentHash({
            schema: 'p1-a-content-v1', content: reference.content,
            gap_reviews: reference.gap_reviews.map(g => ({
                employee_id: g.employee_id, gap_date: g.gap_date,
                resolution: g.resolution, reason: g.reason || null
            })), continuity: []
        })) {
            fail(409, 'STALE_SNAPSHOT', 'لقطة الاستمرارية لا تطابق محتوى المرجع');
        }
        return result;
    }

    async _baseRun(baseRunId, targetMonth, reference) {
        if (!baseRunId) return null;
        const base = await this.getRun(baseRunId);
        if (base.target_month !== targetMonth || base.reference_version_id !== reference.id ||
            base.reference_content_hash !== reference.content_hash || base.reference_snapshot_id !== reference.current_snapshot.id) {
            fail(409, 'STALE_REFERENCE', 'تغير المرجع أو بصمته؛ لا يجوز minimal-diff على مرجع قديم');
        }
        if (!['draft', 'ready_for_review'].includes(base.status) || !base.version ||
            !['generated_draft', 'correction'].includes(base.version.version_kind) ||
            !['draft', 'ready_for_review'].includes(base.version.status)) {
            fail(409, 'BASE_RUN_IMMUTABLE', 'إعادة التوليد متاحة فقط من مسودة توليد أو تصحيح غير معتمد وغير منشور');
        }
        return base;
    }

    async _memberships(employeeIds) {
        if (!employeeIds.length) return [];
        const marks = employeeIds.map(() => '?').join(',');
        return this.db.all(`SELECT ta.id, ta.employee_id, ta.team_id, ta.assigned_date, ta.end_date,
            ta.is_primary, t.name AS team_name FROM team_assignments ta
            JOIN teams t ON t.id = ta.team_id WHERE ta.employee_id IN (${marks})
            ORDER BY ta.employee_id, ta.is_primary DESC, ta.id DESC`, employeeIds);
    }

    _membership(rows, employeeId, date) {
        return rows.find(row => Number(row.employee_id) === Number(employeeId) &&
            (!row.end_date || row.end_date >= date)) || null;
    }

    _buildBaseline(reference, targetMonth, patterns, activeEmployees) {
        const cells = new Map();
        const blockers = [];
        const employees = new Map();
        const snapshot = reference.current_snapshot;
        const snapshotIds = new Set(snapshot.entries.map(entry => Number(entry.employee_id)));
        for (const employee of activeEmployees) {
            if (!snapshotIds.has(Number(employee.id))) {
                blockers.push({ type: 'continuity_missing_employee', employee_id: employee.id, reason: 'موظف نشط غير موجود في لقطة المرجع' });
            }
        }
        for (const entry of snapshot.entries) {
            const employeeId = Number(entry.employee_id);
            employees.set(employeeId, { continuity_status: entry.status, days: [] });
            if (entry.status === 'excluded') continue;
            if (entry.status !== 'resolved') {
                blockers.push({ type: 'continuity_' + entry.status, employee_id: employeeId, reason: entry.reason || null });
                continue;
            }
            if (entry.assignment_status !== 'resolved' || !entry.team_id) {
                blockers.push({ type: 'team_assignment_unresolved', employee_id: employeeId, reason: entry.reason || null });
                continue;
            }
            const pattern = patterns.get(entry.pattern_code);
            const cycle = pattern ? parseCycleRow(pattern) : null;
            if (!cycle || !Number.isInteger(entry.next_phase_index) || entry.next_phase_index < 0 || entry.next_phase_index >= cycle.length ||
                cycle[entry.next_phase_index] !== entry.next_shift_code || entry.effective_date !== `${targetMonth}-01`) {
                blockers.push({ type: 'continuity_phase_unresolved', employee_id: employeeId, reason: 'الدورة أو الطور أو تاريخ السريان غير صالح؛ لا يُفترض نمط' });
                continue;
            }
            daysOfMonth(targetMonth).forEach((date, index) => {
                const code = cycle[(entry.next_phase_index + index) % cycle.length];
                cells.set(key(employeeId, date), {
                    employee_id: employeeId, shift_date: date, team_id: Number(entry.team_id), shift_code: code,
                    source: 'baseline', reason: `استمرار الطور ${entry.next_phase_index} من اللقطة ${snapshot.id}`,
                    leave_id: null, exception_id: null, affected: 1
                });
            });
        }
        return { cells, blockers, employees };
    }

    _exceptionApplies(exception, cell) {
        if (exception.employee_id !== null) return Number(exception.employee_id) === Number(cell.employee_id);
        return cell.team_id !== null && Number(exception.scope_team_id) === Number(cell.team_id);
    }

    _applyLeavesAndExceptions(cells, leaves, exceptions, targetMonth) {
        const blockers = [];
        const notes = [];
        for (const exception of exceptions.filter(row => row.exception_type === 'operational_note')) {
            notes.push({
                id: exception.id, employee_id: exception.employee_id, scope_team_id: exception.scope_team_id,
                start_date: exception.start_date, end_date: exception.end_date, reason: exception.reason,
                approval_source: exception.approval_source, approval_authority: exception.approval_authority
            });
        }
        for (const cell of cells.values()) {
            const approvedLeaves = leaves.filter(row => Number(row.employee_id) === Number(cell.employee_id) &&
                row.status === 'approved' && row.start_date <= cell.shift_date && row.end_date >= cell.shift_date);
            const applicable = exceptions.filter(row => row.exception_type !== 'operational_note' && this._exceptionApplies(row, cell) &&
                row.start_date <= cell.shift_date && row.end_date >= cell.shift_date);
            if (applicable.length > 1) {
                blockers.push({
                    type: 'exception_conflict', employee_id: cell.employee_id, date: cell.shift_date,
                    exception_ids: applicable.map(row => row.id), reason: 'أكثر من استثناء مؤثر على الخلية؛ لا أولوية ضمنية'
                });
            }
            const exception = applicable.length === 1 ? applicable[0] : null;
            if (exception) {
                if (exception.effect_team_id !== null) cell.team_id = Number(exception.effect_team_id);
                if (exception.effect_shift_code) cell.shift_code = exception.effect_shift_code;
                cell.source = 'documented_exception';
                cell.reason = `استثناء موثق ${exception.id}: ${exception.reason}`;
                cell.exception_id = exception.id;
            }
            if (approvedLeaves.length) {
                const leave = approvedLeaves[approvedLeaves.length - 1];
                if (exception) {
                    blockers.push({
                        type: 'leave_exception_conflict', employee_id: cell.employee_id, date: cell.shift_date,
                        leave_id: leave.id, exception_id: exception.id,
                        reason: 'استثناء عمل متداخل مع إجازة معتمدة؛ الإجازة تمنع العمل ويلزم حسم الاستثناء'
                    });
                }
                cell.shift_code = LEAVE_CODES[leave.type] || 'V';
                cell.source = 'approved_leave';
                cell.reason = `إجازة معتمدة ${leave.id} (${leave.type}) مع استمرار طور الدورة`;
                cell.leave_id = leave.id;
                cell.exception_id = exception ? exception.id : null;
            }
        }
        return { blockers, notes };
    }

    async _validateCells(db, cells, membershipRows, exceptions, coverageContext, codeMap) {
        const blockers = [];
        const lookup = async (employeeId, date) => {
            const cell = cells.get(key(employeeId, date));
            if (cell) return { shift_code: cell.shift_code };
            if (coverageContext.referenceDays) {
                const code = coverageContext.referenceDays.get(key(employeeId, date));
                return code ? { shift_code: code } : null;
            }
            return null;
        };
        for (const cell of [...cells.values()].sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.employee_id - b.employee_id)) {
            const code = codeMap.get(String(cell.shift_code));
            if (!code || code.status !== 'دوام') continue;
            const exception = cell.exception_id ? exceptions.find(row => row.id === cell.exception_id) : null;
            const membershipLookup = async (employeeId, date) => {
                if (exception && exception.effect_team_id !== null && cell.shift_date === date) {
                    const team = coverageContext.teams.find(row => Number(row.id) === Number(exception.effect_team_id));
                    return team ? { team_id: team.id, team_name: team.name } : null;
                }
                return this._membership(membershipRows, employeeId, date);
            };
            const result = await validateAssignment(db, {
                employeeId: cell.employee_id, date: cell.shift_date, shiftCode: cell.shift_code,
                operation: 'change', teamId: cell.team_id,
                assignmentLookup: lookup, membershipLookup,
                coverageAssessor: input => this.coverage.assessChange(coverageContext, input)
            });
            cell.validation = result;
            if (!result.valid) {
                blockers.push({
                    type: 'e4_violation', employee_id: cell.employee_id, date: cell.shift_date,
                    team_id: cell.team_id, shift_code: cell.shift_code,
                    reasons: result.reasons,
                    checks: result.checks.filter(check => check.status === 'fail')
                });
            }
        }
        return blockers;
    }

    async _fillCoverage(coverageContext, cells, membershipRows, exceptions, patterns, codeMap, targetMonth, snapshotEntries) {
        const candidateRejections = [];
        const assignments = [];
        const entriesByTeam = new Map();
        for (const entry of snapshotEntries) {
            if (entry.status !== 'resolved' || entry.assignment_status !== 'resolved' || !entry.team_id) continue;
            if (!entriesByTeam.has(Number(entry.team_id))) entriesByTeam.set(Number(entry.team_id), []);
            entriesByTeam.get(Number(entry.team_id)).push(entry);
        }
        for (const team of coverageContext.teams.filter(row => row.is_active === 1)) {
            for (const date of daysOfMonth(targetMonth)) {
                let current = await this.coverage.compute(coverageContext, team.id, date);
                if (current.applicability !== 'required') continue;
                for (const period of ['day', 'night']) {
                    let guard = 0;
                    while (current.rule && current[period] < current.rule[period] && guard++ < 1000) {
                        const candidates = [];
                        const candidateCodes = new Map();
                        for (const entry of entriesByTeam.get(Number(team.id)) || []) {
                            const employeeId = Number(entry.employee_id);
                            const cell = cells.get(key(employeeId, date));
                            if (!cell || Number(cell.team_id) !== Number(team.id)) continue;
                            // M5 يسد الفراغ الأساسي فقط؛ لا يمحو أثر إجازة معتمدة
                            // أو استثناء موثق حتى لو كان رمز الأثر يوم راحة.
                            if (cell.source === 'approved_leave' || cell.source === 'documented_exception') continue;
                            if (coverageService.periodOf(codeMap.get(String(cell.shift_code)))) continue;
                            const cycle = parseCycleRow(patterns.get(entry.pattern_code));
                            const candidateCode = (cycle || []).find(code => coverageService.periodOf(codeMap.get(String(code))) === period);
                            if (!candidateCode) continue;
                            const membership = this._membership(membershipRows, employeeId, date);
                            const exception = cell.exception_id ? exceptions.find(row => row.id === cell.exception_id) : null;
                            if ((!membership || Number(membership.team_id) !== Number(team.id)) &&
                                (!exception || Number(exception.effect_team_id) !== Number(team.id))) continue;
                            candidates.push(employeeId);
                            candidateCodes.set(employeeId, candidateCode);
                        }
                        if (!candidates.length) break;
                        const ranked = await rankCandidates(this.db, { month: targetMonth, candidates: [...new Set(candidates)] });
                        let filled = false;
                        for (const candidate of ranked) {
                            const employeeId = candidate.employee_id;
                            const cell = cells.get(key(employeeId, date));
                            const shiftCode = candidateCodes.get(employeeId);
                            const exception = cell.exception_id ? exceptions.find(row => row.id === cell.exception_id) : null;
                            const result = await validateAssignment(this.db, {
                                employeeId, date, shiftCode, operation: 'change', teamId: team.id,
                                assignmentLookup: async (empId, day) => {
                                    const own = cells.get(key(empId, day));
                                    if (own) return { shift_code: own.shift_code };
                                    const historical = coverageContext.referenceDays.get(key(empId, day));
                                    return historical ? { shift_code: historical } : null;
                                },
                                membershipLookup: async (empId, day) => {
                                    if (exception && exception.effect_team_id !== null && day === date) {
                                        return { team_id: team.id, team_name: team.name };
                                    }
                                    return this._membership(membershipRows, empId, day);
                                },
                                coverageAssessor: input => this.coverage.assessChange(coverageContext, input)
                            });
                            if (!result.valid) {
                                candidateRejections.push({
                                    team_id: team.id, date, period, employee_id: employeeId,
                                    shift_code: shiftCode, rank_position: candidate.rank_position, reasons: result.reasons
                                });
                                continue;
                            }
                            cell.shift_code = shiftCode;
                            cell.source = 'm5_gap_fill';
                            cell.reason = `سد نقص ${period} للفريق ${team.id} في ${date} · M5 رتبة ${candidate.rank_position}`;
                            cell.leave_id = null;
                            cell.exception_id = null;
                            cell.affected = 1;
                            cell.m5 = candidate;
                            assignments.push({ team_id: team.id, date, period, employee_id: employeeId, shift_code: shiftCode, m5: candidate });
                            filled = true;
                            break;
                        }
                        if (!filled) break;
                        current = await this.coverage.compute(coverageContext, team.id, date);
                    }
                }
            }
        }
        return { candidateRejections, assignments };
    }

    _affectedCells(baseInput, input, baseCells, currentCells, targetMonth, maxNights) {
        const affected = new Set();
        const dates = daysOfMonth(targetMonth);
        const allCells = new Map([...baseCells, ...currentCells]);
        const markTeamDay = (teamId, date) => {
            if (teamId === null || teamId === undefined || !dates.includes(date)) return;
            for (const cell of allCells.values()) {
                if (Number(cell.team_id) === Number(teamId) && cell.shift_date === date) affected.add(key(cell.employee_id, date));
            }
        };
        const markEmployee = (employeeId, date, teamIds = []) => {
            for (let offset = -maxNights; offset <= maxNights; offset++) {
                const day = shiftDate(date, offset);
                if (dates.includes(day)) affected.add(key(employeeId, day));
            }
            for (const teamId of teamIds.filter(value => value !== null && value !== undefined)) markTeamDay(teamId, date);
        };
        const cellTeam = (employeeId, date, before, after) => {
            const cell = (before && baseCells.get(key(employeeId, date))) || (after && currentCells.get(key(employeeId, date))) ||
                baseCells.get(key(employeeId, date)) || currentCells.get(key(employeeId, date));
            return cell ? cell.team_id : null;
        };
        for (const change of changedRows(baseInput.leaves, input.leaves)) {
            const row = change.after || change.before;
            for (const date of datesBetween(row.start_date, row.end_date, targetMonth)) {
                const teams = [change.before, change.after].filter(Boolean).map(item => cellTeam(row.employee_id, date, !!change.before, !!change.after));
                markEmployee(row.employee_id, date, teams);
            }
        }
        for (const change of changedRows(baseInput.unable_attend || [], input.unable_attend || [])) {
            const row = change.after || change.before;
            const teams = [change.before, change.after].filter(Boolean).map(item => cellTeam(row.employee_id, row.off_date, !!change.before, !!change.after));
            markEmployee(row.employee_id, row.off_date, teams);
        }
        for (const change of changedRows(baseInput.exceptions, input.exceptions)) {
            const rows = [change.before, change.after].filter(Boolean);
            if (rows.every(row => row.exception_type === 'operational_note')) continue;
            for (const row of rows) {
                for (const date of datesBetween(row.start_date, row.end_date, targetMonth)) {
                    if (row.employee_id !== null) {
                        markEmployee(row.employee_id, date, [cellTeam(row.employee_id, date, true, true), row.effect_team_id]);
                    } else {
                        for (const cell of allCells.values()) {
                            if (cell.shift_date === date && Number(cell.team_id) === Number(row.scope_team_id)) {
                                markEmployee(cell.employee_id, date, [row.scope_team_id, row.effect_team_id]);
                            }
                        }
                        markTeamDay(row.scope_team_id, date);
                        markTeamDay(row.effect_team_id, date);
                    }
                }
            }
        }
        const baseMembers = new Map((baseInput.memberships || []).map(row => [String(row.employee_id), row]));
        const currentMembers = new Map((input.memberships || []).map(row => [String(row.employee_id), row]));
        for (const employeeId of new Set([...baseMembers.keys(), ...currentMembers.keys()])) {
            if (canonicalStringify(baseMembers.get(employeeId) || null) === canonicalStringify(currentMembers.get(employeeId) || null)) continue;
            for (const date of dates) {
                affected.add(key(employeeId, date));
                const beforeTeam = baseCells.get(key(employeeId, date));
                const afterTeam = currentCells.get(key(employeeId, date));
                markTeamDay(beforeTeam && beforeTeam.team_id, date);
                markTeamDay(afterTeam && afterTeam.team_id, date);
            }
        }
        if (canonicalStringify(baseInput.e4_config) !== canonicalStringify(input.e4_config)) {
            for (const cell of allCells.values()) affected.add(key(cell.employee_id, cell.shift_date));
        }
        const basePolicy = baseInput.coverage_policy;
        const policy = input.coverage_policy;
        if (basePolicy.coverage_default_hash !== policy.coverage_default_hash ||
            basePolicy.coverage_overrides_hash !== policy.coverage_overrides_hash) {
            for (const cell of allCells.values()) affected.add(key(cell.employee_id, cell.shift_date));
        } else {
            const beforeApprovals = new Map();
            const afterApprovals = new Map();
            for (const row of basePolicy.approvals || []) {
                if (!beforeApprovals.has(String(row.team_id))) beforeApprovals.set(String(row.team_id), []);
                beforeApprovals.get(String(row.team_id)).push(row);
            }
            for (const row of policy.approvals || []) {
                if (!afterApprovals.has(String(row.team_id))) afterApprovals.set(String(row.team_id), []);
                afterApprovals.get(String(row.team_id)).push(row);
            }
            for (const teamId of new Set([...beforeApprovals.keys(), ...afterApprovals.keys()])) {
                if (canonicalStringify(beforeApprovals.get(teamId) || []) === canonicalStringify(afterApprovals.get(teamId) || [])) continue;
                for (const cell of allCells.values()) {
                    if (String(cell.team_id) === teamId) affected.add(key(cell.employee_id, cell.shift_date));
                }
            }
        }
        return affected;
    }

    _mergeMinimalDiff(base, cells, affected) {
        const baseCells = new Map(base.entries.map(row => [key(row.employee_id, row.shift_date), {
            employee_id: Number(row.employee_id), shift_date: row.shift_date, team_id: row.team_id,
            shift_code: row.shift_code, source: row.source, reason: row.reason,
            leave_id: row.leave_id, exception_id: row.exception_id, affected: row.affected
        }]));
        const merged = new Map();
        const union = new Set([...baseCells.keys(), ...cells.keys()]);
        for (const cellKey of union) {
            const before = baseCells.get(cellKey);
            const computed = cells.get(cellKey);
            if (!affected.has(cellKey)) {
                if (!before && computed) {
                    fail(409, 'MINIMAL_DIFF_VIOLATION', `تغيير خارج نطاق التأثر في ${cellKey}`);
                }
                if (before) {
                    merged.set(cellKey, {
                        ...before, source: 'preserved', affected: 0,
                        reason: `حُفظ من التشغيل ${base.id} دون تأثر بالمدخلات الجديدة`
                    });
                }
            } else if (computed) {
                merged.set(cellKey, { ...computed, affected: 1 });
            }
        }
        return { merged, baseCells };
    }

    _diffs(mode, baseCells, cells) {
        const diffs = [];
        if (mode === 'initial') {
            for (const cell of [...cells.values()].sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.employee_id - b.employee_id)) {
                diffs.push({
                    employee_id: cell.employee_id, shift_date: cell.shift_date,
                    before_team_id: null, before_shift_code: null,
                    after_team_id: cell.team_id, after_shift_code: cell.shift_code,
                    change_type: 'added', reason: cell.reason, exception_id: cell.exception_id || null
                });
            }
            return diffs;
        }
        const union = new Set([...baseCells.keys(), ...cells.keys()]);
        for (const cellKey of union) {
            const before = baseCells.get(cellKey);
            const after = cells.get(cellKey);
            if (sameCell(before, after)) continue;
            const any = after || before;
            const changeType = !before ? 'added' : (!after ? 'removed' : 'changed');
            let reason = after ? after.reason : `زوال أثر المدخل السابق في ${cellKey}`;
            if (before && after && before.exception_id && !after.exception_id) {
                reason = `زوال أثر الاستثناء ${before.exception_id}: ${after.reason}`;
            } else if (before && after && before.leave_id && !after.leave_id) {
                reason = `زوال أثر الإجازة ${before.leave_id}: ${after.reason}`;
            } else if (after && after.exception_id && (!before || before.exception_id !== after.exception_id)) {
                reason = `تطبيق الاستثناء ${after.exception_id}: ${after.reason}`;
            } else if (after && after.leave_id && (!before || before.leave_id !== after.leave_id)) {
                reason = `تطبيق الإجازة ${after.leave_id}: ${after.reason}`;
            } else if (before && before.source === 'preserved' && after && after.source !== 'preserved') {
                reason = `إعادة تقييم الخلية المتأثرة: ${after.reason}`;
            }
            diffs.push({
                employee_id: any.employee_id, shift_date: any.shift_date,
                before_team_id: before ? before.team_id : null, before_shift_code: before ? before.shift_code : null,
                after_team_id: after ? after.team_id : null, after_shift_code: after ? after.shift_code : null,
                change_type: changeType, reason, exception_id: (after && after.exception_id) || (before && before.exception_id) || null
            });
        }
        return diffs.sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.employee_id - b.employee_id);
    }

    async _generate({ targetMonth, baseRunId, user, sourceNote }) {
        const a = actor(user);
        const referenceResult = await this._reference(targetMonth);
        const reference = referenceResult.reference;
        const base = await this._baseRun(baseRunId, targetMonth, reference);
        const [patternsRows, activeEmployees, codeRows, leaves, exceptions, unableAttend, minRest, maxNights] = await Promise.all([
            this.db.all('SELECT * FROM shift_patterns ORDER BY code'),
            this.db.all('SELECT id, employee_code, name, pattern_code, is_active FROM employees WHERE is_active = 1 ORDER BY id'),
            this.db.ShiftCodes.getAll(),
            this.db.all(`SELECT id, employee_id, start_date, end_date, type, status, reason, approved_by, approved_at
                FROM leave_requests WHERE status IN ('approved','pending') AND start_date <= ? AND end_date >= ?
                ORDER BY employee_id, id`, [targetMonth + '-31', targetMonth + '-01']),
            this.db.all(`SELECT * FROM schedule_exceptions WHERE status = 'active' AND start_date <= ? AND end_date >= ?
                ORDER BY employee_id, scope_team_id, start_date, id`, [targetMonth + '-31', targetMonth + '-01']),
            this.db.all(`SELECT id, employee_id, off_date, reason, status, reviewed_by, reviewed_at
                FROM unable_attend_requests WHERE off_date >= ? AND off_date <= ?
                ORDER BY employee_id, off_date, id`, [targetMonth + '-01', targetMonth + '-31']),
            getEngineSetting('schedule_engine.min_rest_hours'),
            getEngineSetting('schedule_engine.max_consecutive_nights')
        ]);
        const patterns = new Map(patternsRows.map(row => [row.code, row]));
        const codeMap = new Map((codeRows || []).map(row => [String(row.code), row]));
        const baseline = this._buildBaseline(reference, targetMonth, patterns, activeEmployees);
        const membershipRows = await this._memberships([...baseline.cells.values()].map(cell => cell.employee_id).filter((id, index, all) => all.indexOf(id) === index));
        const overlay = this._applyLeavesAndExceptions(baseline.cells, leaves, exceptions, targetMonth);
        const coverageContext = await this.coverage.createContext(targetMonth, baseline.cells);
        coverageContext.referenceDays = new Map();
        for (const employee of reference.content.employees || []) {
            for (const day of employee.days || []) {
                if (day.shift_code) coverageContext.referenceDays.set(key(employee.employee_id, day.date), day.shift_code);
            }
        }
        await this._validateCells(this.db, baseline.cells, membershipRows, exceptions, coverageContext, codeMap);
        const m5 = await this._fillCoverage(coverageContext, baseline.cells, membershipRows, exceptions, patterns, codeMap, targetMonth, reference.current_snapshot.entries);
        const membershipsInput = [...new Set(membershipRows.map(row => Number(row.employee_id)))].map(employeeId => ({
            employee_id: employeeId,
            assignments: membershipRows.filter(row => Number(row.employee_id) === employeeId).map(row => ({
                id: row.id, team_id: row.team_id, assigned_date: row.assigned_date,
                end_date: row.end_date, is_primary: row.is_primary
            }))
        }));
        const input = {
            schema: 'p1-b-generation-input-v1', target_month: targetMonth,
            reference: {
                version_id: reference.id, content_hash: reference.content_hash,
                snapshot_id: reference.current_snapshot.id,
                snapshot_status: reference.current_snapshot.status,
                entries: reference.current_snapshot.entries.map(entry => ({
                    employee_id: entry.employee_id, status: entry.status, pattern_code: entry.pattern_code,
                    next_phase_index: entry.next_phase_index, next_shift_code: entry.next_shift_code,
                    team_id: entry.team_id, assignment_status: entry.assignment_status,
                    effective_date: entry.effective_date, state_version: entry.state_version,
                    resolution_source: entry.resolution_source, reason: entry.reason || null
                }))
            },
            active_employees: activeEmployees.map(row => ({ id: row.id, pattern_code: row.pattern_code || null })),
            memberships: membershipsInput,
            leaves, exceptions, unable_attend: unableAttend,
            e4_config: { min_rest_hours: minRest, max_consecutive_nights: maxNights },
            coverage_policy: coverageContext.policy,
            base_run: base ? { id: base.id, input_hash: base.input_hash, output_hash: base.output_hash } : null
        };
        const inputHash = contentHash(input);
        let cells = baseline.cells;
        let baseCells = null;
        let affected = null;
        if (base) {
            affected = this._affectedCells(base.input, input, new Map(base.entries.map(row => [key(row.employee_id, row.shift_date), row])), cells, targetMonth, maxNights);
            const merged = this._mergeMinimalDiff(base, cells, affected);
            cells = merged.merged;
            baseCells = merged.baseCells;
            coverageContext.cells = cells;
        }
        const e4Blockers = await this._validateCells(this.db, cells, membershipRows, exceptions, coverageContext, codeMap);
        const coverageResult = await this.coverage.evaluateAll(coverageContext);
        const unresolvedBlockers = coverageResult.unresolved_teams.map(team => ({
            type: 'coverage_unresolved', team_id: team.team_id, team_name: team.team_name,
            reason: team.reason, dates: team.dates
        }));
        const shortageBlockers = coverageResult.shortages.map(shortage => ({ type: 'coverage_shortage', ...shortage }));
        const blockers = [...baseline.blockers, ...overlay.blockers, ...e4Blockers, ...unresolvedBlockers, ...shortageBlockers];
        const status = blockers.length === 0 ? 'ready_for_review' : 'draft';
        const mode = base ? 'minimal_diff' : 'initial';
        const diffs = this._diffs(mode, baseCells, cells);
        const versionKind = base && base.version.version_kind === 'correction' ? 'correction' : 'generated_draft';
        const content = {
            schema_version: 1, generator: 'p1-b-continuity-v1', month: targetMonth,
            reference: {
                version_id: reference.id, content_hash: reference.content_hash,
                snapshot_id: reference.current_snapshot.id
            },
            base_run_id: base ? base.id : null,
            coverage_policy_version: coverageContext.coveragePolicyVersion,
            operational_notes: overlay.notes,
            ...(versionKind === 'correction' ? { correction: cloneCorrectionMetadata(base.version.content.correction, base.version) } : {}),
            employees: reference.current_snapshot.entries.map(entry => ({
                employee_id: Number(entry.employee_id), continuity_status: entry.status,
                days: daysOfMonth(targetMonth).map(date => cells.get(key(entry.employee_id, date))).filter(Boolean).map(cellPublic)
            }))
        };
        const outputHash = contentHash({ schema: 'p1-a-content-v1', content, gap_reviews: [], continuity: [] });
        const summary = {
            schema: 'p1-b-generation-summary-v1', target_month: targetMonth, mode,
            base_run_id: base ? base.id : null, status,
            entry_count: cells.size, diff_count: diffs.length,
            affected_cell_count: affected ? affected.size : cells.size,
            blocker_count: blockers.length, blockers,
            continuity_blocker_count: baseline.blockers.length,
            exception_blocker_count: overlay.blockers.length,
            e4_blocker_count: e4Blockers.length,
            unresolved_teams: coverageResult.unresolved_teams,
            shortages: coverageResult.shortages,
            candidate_rejections: m5.candidateRejections,
            m5_assignments: m5.assignments,
            coverage: coverageResult.coverage,
            ready_for_review: status === 'ready_for_review',
            publication: 'لم يتم الاعتماد أو النشر؛ لا توجد كتابة في shift_roster أو schedule_months.'
        };
        const runId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        this.db.tx.immediate(hdl => {
            const currentReference = hdl.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(reference.id);
            const currentSnapshot = hdl.prepare('SELECT * FROM schedule_continuity_snapshots WHERE id = ?').get(reference.current_snapshot.id);
            if (!currentReference || currentReference.content_hash !== reference.content_hash ||
                !['approved', 'published'].includes(currentReference.status) ||
                !currentSnapshot || currentSnapshot.status !== 'approved' || currentSnapshot.is_current !== 1) {
                fail(409, 'STALE_REFERENCE', 'تغير المرجع قبل الحفظ؛ أُلغي التوليد دون كتابة');
            }
            if (base) {
                const currentBase = hdl.prepare('SELECT * FROM schedule_generation_runs WHERE id = ?').get(base.id);
                if (!currentBase || currentBase.input_hash !== base.input_hash || currentBase.output_hash !== base.output_hash) {
                    fail(409, 'STALE_BASE_RUN', 'تغير تشغيل الأساس قبل الحفظ');
                }
            }
            const versionNumber = (hdl.prepare('SELECT COALESCE(MAX(version_number), 0) AS n FROM schedule_versions WHERE month = ?').get(targetMonth).n || 0) + 1;
            hdl.prepare(`INSERT INTO schedule_versions
                (id, month, version_number, parent_version_id, reference_version_id, reference_content_hash,
                 version_kind, status, source_type, source_note, content_json, content_hash,
                 coverage_policy_version, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(versionId, targetMonth, versionNumber, base ? base.schedule_version_id : null,
                    reference.id, reference.content_hash, versionKind, status,
                    versionKind === 'correction' ? 'continuity_correction' : 'continuity_generation', sourceNote || null,
                    canonicalStringify(content), outputHash, coverageContext.coveragePolicyVersion, a.id);
            hdl.prepare(`INSERT INTO schedule_generation_runs
                (id, schedule_version_id, target_month, reference_version_id, reference_content_hash,
                 reference_snapshot_id, base_run_id, mode, status, input_json, input_hash,
                 output_hash, coverage_policy_version, summary_json, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(runId, versionId, targetMonth, reference.id, reference.content_hash,
                    reference.current_snapshot.id, base ? base.id : null, mode, status,
                    canonicalStringify(input), inputHash, outputHash,
                    coverageContext.coveragePolicyVersion, canonicalStringify(summary), a.id);
            const insertEntry = hdl.prepare(`INSERT INTO schedule_generation_entries
                (id, run_id, employee_id, shift_date, team_id, shift_code, source, reason,
                 leave_id, exception_id, affected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const cell of [...cells.values()].sort((x, y) => x.shift_date.localeCompare(y.shift_date) || x.employee_id - y.employee_id)) {
                insertEntry.run(crypto.randomUUID(), runId, cell.employee_id, cell.shift_date, cell.team_id,
                    cell.shift_code, cell.source, cell.reason, cell.leave_id || null,
                    cell.exception_id || null, cell.affected ? 1 : 0);
            }
            const insertDiff = hdl.prepare(`INSERT INTO schedule_generation_diffs
                (id, run_id, employee_id, shift_date, before_team_id, before_shift_code,
                 after_team_id, after_shift_code, change_type, reason, exception_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const diff of diffs) {
                insertDiff.run(crypto.randomUUID(), runId, diff.employee_id, diff.shift_date,
                    diff.before_team_id, diff.before_shift_code, diff.after_team_id,
                    diff.after_shift_code, diff.change_type, diff.reason, diff.exception_id || null);
            }
            auditTx(hdl, user, base ? 'schedule_generation_regenerated' : 'schedule_generation_created',
                `توليد ${targetMonth} · run=${runId} · version=${versionId} · mode=${mode} · status=${status} · entries=${cells.size} · diffs=${diffs.length} · blockers=${blockers.length} · input=${inputHash} · output=${outputHash}`);
        });
        return this.getRun(runId);
    }

    async getRun(id) {
        const row = await this.db.get('SELECT * FROM schedule_generation_runs WHERE id = ?', [String(id)]);
        if (!row) fail(404, 'GENERATION_RUN_NOT_FOUND', 'تشغيل التوليد غير موجود');
        const [entries, diffs, version] = await Promise.all([
            this.db.all('SELECT * FROM schedule_generation_entries WHERE run_id = ? ORDER BY shift_date, employee_id', [row.id]),
            this.db.all('SELECT * FROM schedule_generation_diffs WHERE run_id = ? ORDER BY shift_date, employee_id', [row.id]),
            this.db.get('SELECT * FROM schedule_versions WHERE id = ?', [row.schedule_version_id])
        ]);
        return {
            ...row, input: parseJson(row.input_json, {}), summary: parseJson(row.summary_json, {}),
            input_json: undefined, summary_json: undefined, entries, diffs,
            version: version ? { ...version, content: parseJson(version.content_json, null), content_json: undefined } : null
        };
    }

    async listRuns(filters = {}) {
        const where = [], params = [];
        if (filters.target_month) {
            if (!MONTH_RE.test(String(filters.target_month))) fail(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة');
            where.push('target_month = ?'); params.push(filters.target_month);
        }
        if (filters.status) {
            if (!['draft', 'ready_for_review'].includes(filters.status)) fail(422, 'INVALID_RUN_STATUS', 'حالة التشغيل غير صالحة');
            where.push('status = ?'); params.push(filters.status);
        }
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
        const rows = await this.db.all(`SELECT id, schedule_version_id, target_month, reference_version_id,
            reference_content_hash, reference_snapshot_id, base_run_id, mode, status,
            input_hash, output_hash, coverage_policy_version, created_by, created_at
            FROM schedule_generation_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, limit]);
        return { runs: rows };
    }
}

module.exports = { ScheduleGenerationService };
