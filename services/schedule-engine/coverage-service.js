/**
 * ═══ services/schedule-engine/coverage-service.js — خدمة التغطية الموحدة (FSS E-4) ═══
 *
 * قرارات المالك المعتمدة 2026-10-06 (M4 + ج3 المعدّل):
 *  ① المصدر الموحد الوحيد لمنطق التغطية — coverage-helper.js أصبح غلافًا رقيقًا
 *     يفوّض هنا (إزالة الازدواجية دون كسر عقد E-2). لا تعريف ثانٍ للتغطية.
 *  ② قواعد M4 حرفيًا: فترتان فقط (time_start ≥ 12:00 ⇒ night وإلا day) · رموز
 *     بلا «دوام» أو بلا time_start ليست مناوبة تغطية · Default من
 *     schedule_engine.coverage_default (2/2/8) + Team Override من
 *     schedule_engine.coverage_team_overrides · Team-centric والمركز يُشتق من
 *     teams.center (SSOT من A-2) للتشخيص · لا team_id/center_id من العميل —
 *     خدمة داخلية يستدعيها المحرك/الخدمات بمعرّفات مشتقة خادميًا.
 *  ③ BEFORE/AFTER: BEFORE = العدّ الفعّال الحالي (مناوبات التغطية مطروحًا منها
 *     عدم التمكّن المعتمد — خروجهم محسوم) · AFTER = محاكاة الإزالة/الإضافة.
 *  ④ ج3 المعدّل: التفريق إلزامي بين valid/wouldBreak/met — الإضافة لا تكسر
 *     التغطية أبدًا (wouldBreak=false حتى لو بقي الفريق ناقصًا:
 *     still_below_minimum=true) · wouldBreak=true فقط حين تُنقص العملية العدّ
 *     وتبقى النتيجة تحت الحد.
 *  ⑤ Read-Only صِرفة: لا كتابة على shift_roster ولا أي جدول إطلاقًا.
 */
'use strict';

const { getEngineSetting } = require('./config.js');

/** تصنيف الفترة حتمي من وقت البداية الفعلي: ≥ 12:00 = night وإلا day (M4/ج4). */
function periodOf(code) {
    if (!code || code.status !== 'دوام' || !code.time_start) return null; // ليست مناوبة تغطية
    const hour = Number(String(code.time_start).slice(0, 2));
    return hour >= 12 ? 'night' : 'day';
}

/** قاعدة التغطية لفريق: Default + Team Override (app_settings عبر E-0). */
async function getRule(teamId) {
    const def = await getEngineSetting('schedule_engine.coverage_default');
    const overrides = await getEngineSetting('schedule_engine.coverage_team_overrides');
    const rule = (overrides && overrides[String(teamId)]) || def;
    return { day: rule.day, night: rule.night, total: rule.total };
}

async function _codeMap(db) {
    const codes = await db.ShiftCodes.getAll();
    return new Map((codes || []).map(c => [String(c.code), c]));
}

async function _teamCenter(db, teamId) {
    const t = await db.get('SELECT center FROM teams WHERE id = ?', [teamId]);
    return t ? t.center : null;
}

function _evaluate(count, rule) {
    const missing = [];
    if (count.day < rule.day) missing.push('day');
    if (count.night < rule.night) missing.push('night');
    if (count.total < rule.total) missing.push('total');
    return { met: missing.length === 0, missing };
}

/**
 * العدّ الفعّال الحالي لتغطية فريق في يوم (BEFORE): مناوبات تغطية فقط، مطروحًا
 * منها من لديهم عدم تمكّن معتمد (auto_approved/approved) لنفس اليوم.
 * @returns {Promise<{day,night,total,rule,met,missing,center,approved_out}>}
 */
async function computeCoverage(db, teamId, date) {
    const [rule, center, codeMap] = await Promise.all([getRule(teamId), _teamCenter(db, teamId), _codeMap(db)]);
    const teamRows = await db.all('SELECT employee_id, shift_code FROM shift_roster WHERE team_id = ? AND shift_date = ?', [teamId, date]);
    const count = { day: 0, night: 0, total: 0 };
    const periods = new Map(); // employee_id → period (لطرح المعتمدين بدقة)
    for (const r of teamRows) {
        const p = periodOf(codeMap.get(String(r.shift_code)));
        if (!p) continue;
        periods.set(Number(r.employee_id), p);
        count[p]++; count.total++;
    }
    const approved = await db.UnableAttendRequests.getApprovedForTeamDate(teamId, date);
    let approvedOut = 0;
    for (const r of approved) {
        const p = periods.get(Number(r.employee_id));
        if (!p) continue; // معتمد بلا مناوبة تغطية فعلية — لا أثر على العدّ
        count[p]--; count.total--; approvedOut++;
    }
    const ev = _evaluate(count, rule);
    return { day: count.day, night: count.night, total: count.total, rule, met: ev.met, missing: ev.missing, center, approved_out: approvedOut };
}

/**
 * محاكاة تغيير على تغطية يوم: BEFORE (الفعّالة) ← AFTER (بعد إزالات/إضافة واحدة).
 * ج3: wouldBreak = (العملية أَنقصت العدّ) && (AFTER تحت الحد) ·
 *     still_below_minimum = AFTER تحت الحد (سواء كسرت أم لم تكسر).
 * @param {object} p { teamId, date, removeEmployeeIds = [], addShiftCode = null }
 */
async function assessChange(db, { teamId, date, removeEmployeeIds = [], addShiftCode = null }) {
    const before = await computeCoverage(db, teamId, date);
    const codeMap = await _codeMap(db);
    const after = { day: before.day, night: before.night, total: before.total };

    let removedCoverage = 0;
    if (removeEmployeeIds.length) {
        const marks = removeEmployeeIds.map(() => '?').join(',');
        const rows = await db.all(
            `SELECT employee_id, shift_code FROM shift_roster WHERE team_id = ? AND shift_date = ? AND employee_id IN (${marks})`,
            [teamId, date, ...removeEmployeeIds]);
        for (const r of rows) {
            const p = periodOf(codeMap.get(String(r.shift_code)));
            if (!p) continue;
            after[p]--; after.total--; removedCoverage++;
        }
    }
    if (addShiftCode) {
        const p = periodOf(codeMap.get(String(addShiftCode)));
        if (p) { after[p]++; after.total++; }
    }

    const ev = _evaluate(after, before.rule);
    const decreased = after.day < before.day || after.night < before.night || after.total < before.total;
    const wouldBreak = decreased && !ev.met;
    return {
        coverage_before: {
            day: before.day, night: before.night, total: before.total,
            rule: before.rule, met: before.met, missing: before.missing, center: before.center
        },
        coverage_after: {
            day: after.day, night: after.night, total: after.total,
            rule: before.rule, met: ev.met, missing: ev.missing, center: before.center
        },
        wouldBreak,
        still_below_minimum: !ev.met,
        detail: { removed_coverage: removedCoverage, added: addShiftCode || null, approved_out: before.approved_out }
    };
}

/**
 * عقد E-2 حرفيًا (يستهلكه unable-attend-service عبر coverage-helper): هل خروج
 * موظف عن يوم يكسر تغطية فريقه؟ assessable=false ⇒ لا أساس للفحص (لا roster
 * أو مناوبته ليست مناوبة تغطية) — والقبول ليس ضمانًا (M2).
 */
async function assessRemovalImpact(db, employeeId, offDate) {
    const rosterRow = await db.get('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employeeId, offDate]);
    if (!rosterRow) return { assessable: false, wouldBreak: false, detail: { reason: 'no_roster_for_date' } };

    const codeMap = await _codeMap(db);
    const ownPeriod = periodOf(codeMap.get(String(rosterRow.shift_code)));
    if (!ownPeriod) return { assessable: false, wouldBreak: false, detail: { reason: 'not_a_coverage_shift', shift_code: rosterRow.shift_code } };

    const res = await assessChange(db, { teamId: rosterRow.team_id, date: offDate, removeEmployeeIds: [employeeId] });
    const rule = res.coverage_before.rule;
    return {
        assessable: true,
        wouldBreak: !res.coverage_after.met, // نفس دلالة E-2: AFTER تحت الحد = يكسر
        detail: {
            team_id: rosterRow.team_id, period: ownPeriod,
            rule: { day: rule.day, night: rule.night, total: rule.total },
            after_removal: { day: res.coverage_after.day, night: res.coverage_after.night, total: res.coverage_after.total },
            approved_out: res.coverage_before.approved_out
        }
    };
}

module.exports = { periodOf, getRule, computeCoverage, assessChange, assessRemovalImpact };
