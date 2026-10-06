/**
 * ═══ services/schedule-engine/coverage-helper.js — مهايئ تغطية محدود (FSS E-2) ═══
 *
 * شرط المالك 2026-10-06: هذا ليس خدمة Coverage الموحدة للمحرك (تُبنى في مرحلتها).
 * هو Adapter محدود يخدم قرار M2 فقط (فحص تصعيد عدم التمكّن)، ويطبق قواعد M4 حرفيًا:
 *   ① فترتان فقط: day / night — لا فحص لكل shift_code (قواعد هشّة ممنوعة).
 *   ② القيم: Default من schedule_engine.coverage_default (2/2/8 عند الإطلاق)
 *      + Team Override من schedule_engine.coverage_team_overrides (E-0).
 *   ③ Team-centric: التغطية تُحسب لفريق اليوم المعني من سطر roster الفعلي،
 *      والمركز يُشتق عبر الفريق (SSOT: team_assignments/teams) — لا مركز هنا أصلًا.
 *   ④ لا قاعدة تغطية خاصة بعدم التمكّن — نفس أرقام M4 لكل شيء.
 *
 * تصنيف الفترة حتمي من وقت البداية الفعلي في shift_codes: بداية ≥ 12:00 = night
 * (تشمل N6 17:00 والعابرات لمنتصف الليل N12/N8/LN10)، وإلا day (D6..D12 05:00–07:00).
 * رموز بلا أوقات (إجازات/راحة/تكميل بلا time_start) ليست مناوبة تغطية أصلًا
 * (status ≠ 'دوام') فلا تدخل العدّ.
 */
'use strict';

const { getEngineSetting } = require('./config.js');

function periodOf(code) {
    if (!code || code.status !== 'دوام' || !code.time_start) return null; // ليست مناوبة تغطية
    const hour = Number(String(code.time_start).slice(0, 2));
    return hour >= 12 ? 'night' : 'day';
}

/**
 * هل خروج موظف عن يوم معيّن يكسر تغطية فريقه (M2/M4)؟
 * @returns {Promise<{assessable:boolean, wouldBreak:boolean, detail:object}>}
 *   assessable=false ⇒ لا يوجد roster لذلك اليوم أو مناوبة الموظف ليست مناوبة
 *   تغطية — لا أساس للفحص (عندها يقرر المستدعي: اعتماد تلقائي مع إعادة
 *   التحقق عند التوليد لاحقًا — M2: القبول ليس ضمانًا مطلقًا).
 */
async function assessRemovalImpact(db, employeeId, offDate) {
    const rosterRow = await db.get('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employeeId, offDate]);
    if (!rosterRow) return { assessable: false, wouldBreak: false, detail: { reason: 'no_roster_for_date' } };

    const codes = await db.ShiftCodes.getAll();
    const codeMap = new Map((codes || []).map(c => [String(c.code), c]));
    const ownCode = codeMap.get(String(rosterRow.shift_code));
    const ownPeriod = periodOf(ownCode);
    if (!ownPeriod) return { assessable: false, wouldBreak: false, detail: { reason: 'not_a_coverage_shift', shift_code: rosterRow.shift_code } };

    const teamId = rosterRow.team_id;
    const def = await getEngineSetting('schedule_engine.coverage_default');
    const overrides = await getEngineSetting('schedule_engine.coverage_team_overrides');
    const rule = (overrides && overrides[String(teamId)]) || def;

    // عدّ الفريق لذلك اليوم: مناوبات تغطية فقط (status='دوام') مصنفة لفترتين
    const teamRows = await db.all('SELECT employee_id, shift_code FROM shift_roster WHERE team_id = ? AND shift_date = ?', [teamId, offDate]);
    const count = { day: 0, night: 0, total: 0 };
    for (const r of teamRows) {
        const p = periodOf(codeMap.get(String(r.shift_code)));
        if (!p) continue;
        count[p]++; count.total++;
    }

    // طرح من لديهم طلب عدم تمكّن معتمد لنفس اليوم (خروجهم محسوم سلفًا)
    const approved = await db.UnableAttendRequests.getApprovedForTeamDate(teamId, offDate);
    let approvedOut = 0;
    for (const r of approved) {
        const rr = teamRows.find(t => Number(t.employee_id) === Number(r.employee_id));
        const p = rr ? periodOf(codeMap.get(String(rr.shift_code))) : null;
        if (!p) continue;
        count[p]--; count.total--; approvedOut++;
    }

    // محاكاة خروج الموظف مقدّم الطلب
    count[ownPeriod]--; count.total--;

    const wouldBreak = count.day < rule.day || count.night < rule.night || count.total < rule.total;
    return {
        assessable: true,
        wouldBreak,
        detail: {
            team_id: teamId, period: ownPeriod,
            rule: { day: rule.day, night: rule.night, total: rule.total },
            after_removal: count, approved_out: approvedOut
        }
    };
}

module.exports = { assessRemovalImpact, periodOf };
