/**
 * ═══ services/schedule-engine/validation-service.js — طبقة التحقق الموحدة (FSS E-4) ═══
 *
 * قرارات المالك المعتمدة 2026-10-06 (ج1–ج4 + M4/M6/M7):
 *  ① Read/Validate صِرفة: لا Generation ولا Scheduler ولا Ranking ولا Fairness
 *     ولا كتابة على shift_roster ولا أي جدول. لا Endpoints — خدمة داخلية
 *     يستدعيها المحرك لاحقًا بمعرّفات مشتقة خادميًا (لا team_id من العميل).
 *  ② النتيجة منظمة وليست boolean: { valid, checks[], reasons[],
 *     coverage_before, coverage_after, wouldBreak, still_below_minimum }.
 *  ③ الطلبات غير المحسومة لا تمنع (ج2): leave.pending وunable.pending_review
 *     ⇒ 'warn' فقط. المانع: approved (إجازة) و auto_approved/approved (عدم تمكّن).
 *     rejected/cancelled لا تمنع إطلاقًا.
 *  ④ الراحة الدنيا (M7): 8 ساعات من الأوقات الفعلية time_start/time_end في
 *     shift_codes؛ العابرة لمنتصف الليل تمتد بقيمتها الحقيقية؛ < 8 ساعات =
 *     REST_BELOW_MINIMUM (FAIL)؛ لا Override في V1.
 *  ⑤ الليالي المتتالية (M6): السقف من schedule_engine.max_consecutive_nights
 *     (3) وتعريف الليلة = تعريف M4 حرفيًا (time_start ≥ 12:00) — لا تعريف ثانٍ.
 *  ⑥ التغطية عبر coverage-service (المصدر الموحد) مع تفريق ج3 الإلزامي:
 *     add ⇒ لا wouldBreak أبدًا (still_below_minimum=true إن بقي النقص) ·
 *     remove/change المنزلة تحت الحد ⇒ COVERAGE_BELOW_MINIMUM + wouldBreak.
 */
'use strict';

const { getEngineSetting } = require('./config.js');
const coverageService = require('./coverage-service.js');

function _toMinutes(hhmm) {
    const parts = String(hhmm).split(':');
    return Number(parts[0]) * 60 + Number(parts[1] || 0);
}

/** مدى المناوبة بالدقائق من بداية يومها؛ النهاية ≤ البداية ⇒ +1440 (عابرة لمنتصف الليل — M7). */
function _interval(code) {
    if (!code || !code.time_start || !code.time_end) return null;
    const start = _toMinutes(code.time_start);
    let end = _toMinutes(code.time_end);
    if (end <= start) end += 1440;
    return { start, end };
}

/** إزاحة يوم YYYY-MM-DD بـ n يوم (UTC — بلا حساسية توقيت). */
function _shiftDate(date, n) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function _result(checks, extra) {
    const fails = checks.filter(c => c.status === 'fail');
    return Object.assign({
        valid: fails.length === 0,
        checks,
        reasons: fails.map(c => c.reason).filter(Boolean)
    }, extra);
}

/**
 * تحقق شامل لعملية على مناوبة موظف في يوم — بلا أي كتابة.
 * @param {object} p { employeeId, date, shiftCode, operation: 'add'|'remove'|'change', teamId? }
 *   teamId اختياري: يُشتق من العضوية الحية عند غيابه؛ إن مُرّر وخالف العضوية = FAIL
 *   (لا يُقبل كمدخل موثوق من عميل — المستدعي خادم داخلي فقط).
 */
async function validateAssignment(db, { employeeId, date, shiftCode, operation = 'add', teamId = null }) {
    const checks = [];
    const add = (code, status, reason, detail) =>
        checks.push(Object.assign({ code, status },
            reason ? { reason } : {}, detail ? { detail } : {}));
    const isRemove = operation === 'remove';

    // ── ① الموظف نشط ──
    const emp = await db.get('SELECT id, is_active FROM employees WHERE id = ?', [employeeId]);
    if (!emp || emp.is_active !== 1) {
        add('EMPLOYEE_ACTIVE', 'fail', 'EMPLOYEE_NOT_ACTIVE', { employee_id: employeeId, exists: !!emp });
    } else {
        add('EMPLOYEE_ACTIVE', 'pass');
    }

    // ── ② الأهلية: عضوية فريق حية في التاريخ (+ اشتقاق/مطابقة teamId) ──
    const membership = await db.get(
        `SELECT ta.team_id, t.name AS team_name FROM team_assignments ta
         JOIN teams t ON t.id = ta.team_id
         WHERE ta.employee_id = ? AND (ta.end_date IS NULL OR ta.end_date = '' OR ta.end_date >= ?)
         ORDER BY ta.is_primary DESC, ta.id DESC LIMIT 1`, [employeeId, date]);
    if (!membership) {
        add('ELIGIBILITY', 'fail', 'EMPLOYEE_NO_ACTIVE_TEAM', { date });
    } else if (teamId && Number(membership.team_id) !== Number(teamId)) {
        add('ELIGIBILITY', 'fail', 'EMPLOYEE_NO_ACTIVE_TEAM',
            { requested_team: teamId, active_team: membership.team_id });
    } else {
        teamId = membership.team_id;
        add('ELIGIBILITY', 'pass', null, { team_id: teamId, team_name: membership.team_name });
    }
    const eligible = membership && (!checks.find(c => c.code === 'ELIGIBILITY') || checks.find(c => c.code === 'ELIGIBILITY').status === 'pass');

    // ── ③ الرمز معروف ومناوبة عمل ──
    const codes = await db.ShiftCodes.getAll();
    const codeMap = new Map((codes || []).map(c => [String(c.code), c]));
    const code = codeMap.get(String(shiftCode));
    if (!code) {
        add('SHIFT_CODE', 'fail', 'UNKNOWN_SHIFT_CODE', { shift_code: shiftCode });
    } else if (code.status !== 'دوام') {
        add('SHIFT_CODE', 'fail', 'NOT_A_WORK_SHIFT', { shift_code: shiftCode, status: code.status });
    } else {
        add('SHIFT_CODE', 'pass');
    }

    // ── ④ مناوبة واحدة في اليوم (لبنية shift_roster) ──
    const existing = await db.get('SELECT shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employeeId, date]);
    if (operation === 'add' && existing) {
        add('ONE_SHIFT_PER_DAY', 'fail', 'MULTIPLE_SHIFTS_SAME_DAY', { existing_code: existing.shift_code });
    } else {
        add('ONE_SHIFT_PER_DAY', 'pass', null, existing ? { existing_code: existing.shift_code } : undefined);
    }

    // ── ⑤⑥ الراحة والتداخل الزمني (M7) — مع جيران اليوم السابق/التالي ──
    // (في remove لا تُخلق تعارضات زمنية ⇒ skip موثق)
    const minRest = await getEngineSetting('schedule_engine.min_rest_hours');
    if (isRemove) {
        add('REST_MINIMUM', 'skip', null, { note: 'remove لا يُنشئ قيد راحة' });
        add('OVERLAP', 'skip', null, { note: 'remove لا يُنشئ تداخلًا' });
        add('NEXT_DAY', 'skip', null, { note: 'remove لا يُنشئ تعارض يوم تالٍ' });
    } else {
        const candIv = _interval(code);
        const prevRow = await db.get('SELECT shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employeeId, _shiftDate(date, -1)]);
        const nextRow = await db.get('SELECT shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employeeId, _shiftDate(date, 1)]);
        const prevIv = prevRow ? _interval(codeMap.get(String(prevRow.shift_code))) : null;
        const nextIv = nextRow ? _interval(codeMap.get(String(nextRow.shift_code))) : null;

        if (!candIv) {
            add('REST_MINIMUM', 'skip', null, { note: 'الرمز بلا أوقات فعلية' });
            add('OVERLAP', 'skip', null, { note: 'الرمز بلا أوقات فعلية' });
            add('NEXT_DAY', 'skip', null, { note: 'الرمز بلا أوقات فعلية' });
        } else {
            // المديات المزاحة ليوم المرشحة: السابق −1440 · التالي +1440
            // ⑥ التداخل مع امتداد مناوبة الأمس
            const overlapPrev = prevIv && candIv.start < (prevIv.end - 1440) && (prevIv.start - 1440) < candIv.end;
            if (overlapPrev) {
                add('OVERLAP', 'fail', 'SHIFT_OVERLAP',
                    { prev_code: prevRow.shift_code, prev_end_next_day: true });
            } else {
                add('OVERLAP', 'pass', null, prevRow && !prevIv ? { prev_note: 'مناوبة أمس بلا أوقات — لا تُقيّد' } : undefined);
            }
            // ⑥ اصطدام امتداد المرشحة بمناوبة الغد
            const overlapNext = nextIv && (nextIv.start + 1440) < candIv.end && candIv.start < (nextIv.end + 1440);
            if (overlapNext) {
                add('NEXT_DAY', 'fail', 'NEXT_DAY_CONFLICT',
                    { next_code: nextRow.shift_code, candidate_crosses_midnight: true });
            } else {
                add('NEXT_DAY', 'pass', null, nextRow && !nextIv ? { next_note: 'مناوبة الغد بلا أوقات — لا تُقيّد' } : undefined);
            }
            // ⑤ الراحة الدنيا من الجهتين (تُحسب فقط بلا تقاطع — التقاطع أفشل أعلاه)
            const restBeforeH = prevIv ? (candIv.start - (prevIv.end - 1440)) / 60 : null;
            const restAfterH = nextIv ? ((nextIv.start + 1440) - candIv.end) / 60 : null;
            const beforeShort = restBeforeH !== null && restBeforeH < minRest && !overlapPrev;
            const afterShort = restAfterH !== null && restAfterH < minRest && !overlapNext;
            if (beforeShort || afterShort) {
                add('REST_MINIMUM', 'fail', 'REST_BELOW_MINIMUM', {
                    required_hours: minRest,
                    rest_before_hours: restBeforeH, rest_after_hours: restAfterH
                });
            } else {
                add('REST_MINIMUM', 'pass', null, {
                    required_hours: minRest,
                    rest_before_hours: restBeforeH, rest_after_hours: restAfterH
                });
            }
        }
    }

    // ── ⑦ الإجازات: المعتمدة تمنع · pending تحذير فقط (ج2) ──
    const leave = await db.get(
        `SELECT id, status FROM leave_requests
         WHERE employee_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ?
         ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END LIMIT 1`, [employeeId, date, date]);
    if (leave && leave.status === 'approved') {
        add('LEAVE', 'fail', 'LEAVE_CONFLICT_APPROVED', { leave_id: leave.id });
    } else if (leave) {
        add('LEAVE', 'warn', null, { leave_id: leave.id, status: 'pending', note: 'طلب إجازة قيد المراجعة — لا يمنع (ج2)' });
    } else {
        add('LEAVE', 'pass'); // مرفوضة/ملغاة/غائبة لا تمنع
    }

    // ── ⑧ عدم التمكّن: المحسوم يمنع · pending_review تحذير فقط (ج2) ──
    const ua = await db.UnableAttendRequests.getByEmployeeDate(employeeId, date);
    if (ua && (ua.status === 'auto_approved' || ua.status === 'approved')) {
        add('UNABLE_ATTEND', 'fail', 'UNABLE_ATTEND_CONFLICT', { request_id: ua.id, status: ua.status });
    } else if (ua && ua.status === 'pending_review') {
        add('UNABLE_ATTEND', 'warn', null, { request_id: ua.id, status: 'pending_review', note: 'طلب قيد المراجعة — لا يمنع (ج2)' });
    } else {
        add('UNABLE_ATTEND', 'pass'); // rejected/cancelled/غائب لا يمنع
    }

    // ── ⑨ الليالي المتتالية (M6 — تعريف الليلة = M4) ──
    const maxNights = await getEngineSetting('schedule_engine.max_consecutive_nights');
    if (isRemove) {
        add('CONSECUTIVE_NIGHTS', 'skip', null, { note: 'remove لا يُنشئ تتابع ليالٍ' });
    } else if (coverageService.periodOf(code) !== 'night') {
        add('CONSECUTIVE_NIGHTS', 'pass', null, { candidate_night: false });
    } else {
        let back = 0, fwd = 0;
        for (let i = 1; i <= maxNights; i++) {
            const r = await db.get('SELECT shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employeeId, _shiftDate(date, -i)]);
            if (r && coverageService.periodOf(codeMap.get(String(r.shift_code))) === 'night') back++; else break;
        }
        for (let i = 1; i <= maxNights; i++) {
            const r = await db.get('SELECT shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employeeId, _shiftDate(date, i)]);
            if (r && coverageService.periodOf(codeMap.get(String(r.shift_code))) === 'night') fwd++; else break;
        }
        const run = back + 1 + fwd;
        if (run > maxNights) {
            add('CONSECUTIVE_NIGHTS', 'fail', 'CONSECUTIVE_NIGHTS_EXCEEDED', { run, max: maxNights, back, forward: fwd });
        } else {
            add('CONSECUTIVE_NIGHTS', 'pass', null, { run, max: maxNights, back, forward: fwd });
        }
    }

    // ── ⑩ التغطية (coverage-service الموحد — تفريق ج3) ──
    let coverage_before = null, coverage_after = null, wouldBreak = false, stillBelow = null;
    if (!eligible || !teamId) {
        add('COVERAGE', 'skip', null, { note: 'لا فريق نشط — لا أساس للفحص' });
    } else {
        const cov = await coverageService.assessChange(db, {
            teamId, date,
            removeEmployeeIds: isRemove || operation === 'change' ? [employeeId] : [],
            addShiftCode: isRemove ? null : shiftCode
        });
        coverage_before = cov.coverage_before;
        coverage_after = cov.coverage_after;
        wouldBreak = cov.wouldBreak;
        stillBelow = cov.still_below_minimum;
        if (cov.wouldBreak) {
            add('COVERAGE', 'fail', 'COVERAGE_BELOW_MINIMUM', {
                after: { day: cov.coverage_after.day, night: cov.coverage_after.night, total: cov.coverage_after.total },
                rule: cov.coverage_after.rule, missing: cov.coverage_after.missing
            });
        } else if (cov.still_below_minimum) {
            // ج3: الإضافة لا تكسر التغطية القائمة لكنها لم تعالج النقص بالكامل
            add('COVERAGE', 'pass', null, {
                still_below_minimum: true, missing: cov.coverage_after.missing,
                after: { day: cov.coverage_after.day, night: cov.coverage_after.night, total: cov.coverage_after.total }
            });
        } else {
            add('COVERAGE', 'pass');
        }
    }

    return _result(checks, { coverage_before, coverage_after, wouldBreak, still_below_minimum: stillBelow });
}

module.exports = { validateAssignment };
