/**
 * ═══ services/schedule-engine/config.js — قارئ إعدادات محرك الجدولة (FSS E-0) ═══
 *
 * قرارات المالك المجمّدة 2026-10-06 (M1–M14) — مصدر كل قيمة افتراضية موثّق أدناه.
 *
 * القواعد:
 *  ① هذه الوحدة نقية: لا تستورد db.js في أعلى الملف (كسر دورة الاستيراد —
 *     db.js يستورد ENGINE_DEFAULTS من هنا لغرض الزرع الخامل). الاستيراد كسول
 *     داخل الدوال فقط.
 *  ② القراءة من app_settings أولًا؛ إذا غاب المفتاح نسقط على الافتراضي
 *     المجمّد هنا — فلا ينكسر المحرك لو حُذف مفتاح يدويًا.
 *  ③ الزرع في db.js خاملة (Idempotent): لا يكتب فوق أي قيمة موجودة أبدًا.
 *  ④ monthly_required_hours=192 القائم لا يُمس ولا يُنسخ هنا — يقرأه المحرك
 *     من مفتاحه الحالي كما هو.
 *  ⑤ E-0 لا يحتوي أي منطق محرك: هذا الملف قارئ إعدادات فقط.
 */
'use strict';

// ── القيم الافتراضية المجمّدة — تعديلها هنا ممنوع؛ التعديل يكون عبر app_settings ──
const ENGINE_DEFAULTS = Object.freeze({
    // M1: حد أيام عدم التمكّن في المسار العادي (ما زاد → مراجعة مسؤول دائمًا M2)
    'schedule_engine.max_unable_days_per_month': 4,
    // M4: التغطية الدنيا العامة على فترتين تشغيليتين (نقطة انطلاق = القيم الحالية 2/2/8)
    'schedule_engine.coverage_default': Object.freeze({ day: 2, night: 2, total: 8 }),
    // M4: تجاوزات لكل فريق { [team_id]: {day, night, total} } — فارغة عند الإطلاق
    'schedule_engine.coverage_team_overrides': Object.freeze({}),
    // M6: سقف الأمان الصارم لليالي المتتالية (قيد تتابع فقط — لا تدوير إجباري)
    'schedule_engine.max_consecutive_nights': 3,
    // M7: الراحة الدنيا الصارمة بالساعات — لا كسر لها في أي مسار
    'schedule_engine.min_rest_hours': 8,
    // M8: تقويم دورة التوليد الشهرية (أفق شهر واحد)
    'schedule_engine.preference_window': Object.freeze({ open_day: 10, close_day: 20, publish_from: 21, publish_to: 25 }),
    // M9: حد التطبيق التلقائي للتبديل بالتراضي بالساعات قبل بداية المناوبة
    'schedule_engine.swap_auto_window_hours': 48,
    // M14: حد تفضيلات الزمالة الإيجابية لكل موظف (Soft Preference)
    'schedule_engine.max_colleague_preferences': 3
});

const ENGINE_SETTING_KEYS = Object.freeze(Object.keys(ENGINE_DEFAULTS));

/**
 * قراءة مفتاح واحد: app_settings أولًا، ثم الافتراضي المجمّد عند الغياب.
 * @param {string} key أحد ENGINE_SETTING_KEYS
 * @returns {Promise<*>} القيمة، أو undefined لمفتاح غير معروف
 */
async function getEngineSetting(key) {
    if (!Object.prototype.hasOwnProperty.call(ENGINE_DEFAULTS, key)) return undefined;
    const db = require('../../db.js'); // كسول — لا دورة استيراد
    const value = await db.AppSettings.get(key);
    return (value === null || value === undefined) ? ENGINE_DEFAULTS[key] : value;
}

/**
 * قراءة كل إعدادات المحرك دفعة واحدة (مفاتيح → قيم فعلية بعد الدمج مع app_settings).
 */
async function getEngineConfig() {
    const out = {};
    for (const key of ENGINE_SETTING_KEYS) {
        out[key] = await getEngineSetting(key);
    }
    return out;
}

module.exports = { ENGINE_DEFAULTS, ENGINE_SETTING_KEYS, getEngineSetting, getEngineConfig };
