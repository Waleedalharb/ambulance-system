/**
 * ═══ services/schedule-engine/ranking-service.js — ترتيب M5 للمرشحين (FSS E-5) ═══
 *
 * قرارات المالك المجمّدة 2026-10-06 (Design Revision 2 + مراجعة E-5):
 *  ① ميزان التفضيلات: نسبة تحقق تفضيلات الشهر في roster الفعلي — shift مطابق
 *     + day_off بلا مناوبة + زميل مفضل يعمل نفس الفريق/اليوم. الأقل تحققًا يتقدم.
 *     موظف بلا تفضيلات يُعامل ratio=1.0 (سلوك v1 موثق — لا شيء يُوازَن له).
 *  ② عبء ليالٍ+عطلات: تعريف الليلة = M4 حرفيًا (time_start ≥ 12:00 عبر
 *     coverage-service.periodOf). **بُعد العطلات = 0 متعادل للجميع في v1** —
 *     قرار المالك في مراجعة E-5 (2026-10-06): لا يوجد Business Rule رسمي
 *     للعطلات في المشروع، فلا نخترع تعريفًا (ولا حتى جمعة/سبت) داخل الكود.
 *     يبقى الحقل burden_holidays=0 في العقد حفاظًا على الشكل، واعتماد مصدر
 *     العطلات الرسمي قرار Business مستقل لاحقًا يفعّل هذا البُعد. الأعلى يتقدم.
 *  ③ request_age = null للجميع (tied — لا طلبات في E-5): لا يحسم أبدًا ولا
 *     يُستخدم له تاريخ بديل (J3).
 *  ④ كاسر التعادل النهائي: employee_id ASC.
 * الترتيب: pref_ratio ASC ← burden (ليالٍ+عطلات) DESC ← employee_id ASC.
 * المثال المعتمد: A(33%) ← B(67%/عبء9) ← D(67%/عبء6/id96) ← C(67%/عبء6/id204).
 *
 * Read-Only صِرفة: لا كتابة على أي جدول إطلاقًا.
 */
'use strict';

const coverageService = require('./coverage-service.js');

/**
 * مقاييس M5 الشهرية لموظف واحد من roster الفعلي + تفضيلاته المخزنة.
 * @returns {Promise<{pref_fulfilled,pref_total,pref_ratio,burden_nights,burden_holidays,request_age}>}
 */
async function _metrics(db, employeeId, month, codeMap) {
    const rows = await db.all(
        'SELECT shift_date, shift_code, team_id FROM shift_roster WHERE employee_id = ? AND shift_date LIKE ?',
        [employeeId, month + '-%']);

    // ② العبء — الليالي فقط في v1 (بُعد العطلات متعادل 0 حتى اعتماد مصدر رسمي)
    let burdenNights = 0;
    for (const r of rows) {
        if (coverageService.periodOf(codeMap.get(String(r.shift_code))) === 'night') burdenNights++;
    }
    const burdenHolidays = 0; // ② لا Business Rule رسمي للعطلات — متعادل في v1 (قرار المالك)

    // ① ميزان التفضيلات
    const prefs = await db.EmployeePreferences.getByEmployeeMonth(employeeId, month);
    let fulfilled = 0;
    const rosterDates = new Set(rows.map(r => r.shift_date));
    for (const p of prefs) {
        if (p.pref_type === 'shift') {
            if (rows.some(r => String(r.shift_code) === String(p.pref_value))) fulfilled++;
        } else if (p.pref_type === 'day_off') {
            if (!rosterDates.has(p.pref_value)) fulfilled++;
        } else if (p.pref_type === 'colleague') {
            // زميل مفضل عمل معه نفس الفريق/اليوم ولو مرة في الشهر
            const hit = await db.get(
                `SELECT 1 AS x FROM shift_roster a
                 JOIN shift_roster b ON b.shift_date = a.shift_date AND b.team_id = a.team_id
                 WHERE a.employee_id = ? AND b.employee_id = ? AND a.shift_date LIKE ? LIMIT 1`,
                [employeeId, Number(p.pref_value), month + '-%']);
            if (hit) fulfilled++;
        }
    }
    const total = prefs.length;
    return {
        pref_fulfilled: fulfilled,
        pref_total: total,
        pref_ratio: total > 0 ? fulfilled / total : 1.0, // ① بلا تفضيلات = لا شيء يُوازَن (v1 موثق)
        burden_nights: burdenNights,
        burden_holidays: burdenHolidays,
        request_age: null // ③ J3: متعادل للجميع — لا يحسم ولا تاريخ بديل
    };
}

/**
 * ترتيب مرشحي فجوة حسب M5 حرفيًا — حتمي بالكامل (نفس المدخلات ⇒ نفس الترتيب).
 * @param {object} db مساحة db.js
 * @param {object} p { month: 'YYYY-MM', candidates: [employeeId, ...] }
 * @returns {Promise<Array<{employee_id, rank_position, m5, explanation}>>} مرتبة تصاعديًا بالأولوية
 */
async function rankCandidates(db, { month, candidates }) {
    const codes = await db.ShiftCodes.getAll();
    const codeMap = new Map((codes || []).map(c => [String(c.code), c]));

    const entries = [];
    for (const id of candidates) {
        const m5 = await _metrics(db, Number(id), month, codeMap);
        entries.push({
            employee_id: Number(id),
            m5,
            explanation: {
                dim1_pref_balance: { fulfilled: m5.pref_fulfilled, total: m5.pref_total, ratio: m5.pref_ratio, rule: 'الأقل تحققًا يتقدم (ratio ASC)' },
                dim2_burden: { nights: m5.burden_nights, holidays: m5.burden_holidays, total: m5.burden_nights + m5.burden_holidays, rule: 'الأعلى عبئًا يتقدم (burden DESC) · الليلة = M4 · بُعد العطلات متعادل 0 في v1 (لا مصدر رسمي معتمد)' },
                dim3_request_age: { value: null, rule: 'tied — لا طلبات في E-5 (J3): لا يحسم أبدًا' },
                dim4_tiebreak: { value: Number(id), rule: 'employee_id ASC' }
            }
        });
    }

    entries.sort((a, b) => {
        if (a.m5.pref_ratio !== b.m5.pref_ratio) return a.m5.pref_ratio - b.m5.pref_ratio; // ① ASC
        const ba = a.m5.burden_nights + a.m5.burden_holidays;
        const bb = b.m5.burden_nights + b.m5.burden_holidays;
        if (ba !== bb) return bb - ba; // ② DESC
        return a.employee_id - b.employee_id; // ④ ASC
    });
    entries.forEach((e, i) => { e.rank_position = i + 1; });
    return entries;
}

module.exports = { rankCandidates };
