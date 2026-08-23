/**
 * ═══ قواعد التنبيه التشغيلي — alert-rules.js ═══
 * (قرار المالك 2026-08-21): كل تنبيه/مؤقت في الخريطة يجب أن يرتبط بحدث CAD فعلي،
 * لا بمجرد ارتباط الفرقة بالبلاغ.
 *
 * بوابة الأهلية الصارمة:
 *  • فرقة بلا «التحرك» (phases=null أو {} أو قبول فقط) ← غير مؤهلة: لا Timer ولا Alert.
 *  • تحركت وبلا «البحث»      ← مرحلة الوصول: المنقضي من إنشاء البلاغ (حد 10 د).
 *  • وصلت («البحث») وبلا «العلاج» ← مرحلة المباشرة: المنقضي من الإنشاء (حد 12 د) — الوصول يتجمد.
 *  • باشرت («العلاج»)         ← مرحلة البقاء في الموقع: المنقضي من «البحث» (حد 15 د) — المباشرة تتجمد.
 *  • بلاغ بلا وقت إنشاء CAD   ← بلا مؤقت إطلاقًا (صدق البيانات).
 *  • عبور منتصف الليل +1440 — مطابق حرفيًا لمنطق ReportService (_cadMinutes/_cadDiffMin).
 *
 * ملاحظة حدودية: قاعدة «الاحتساب» في محرك التوزيع (isCountedParticipation) تبقى كما هي —
 * هذه القواعد خاصة بطبقة التنبيه/المؤقتات فقط، وأشد: لا تنبيه بلا حدث تحرك فعلي.
 *
 * موديول نقي بلا DOM: يعمل في المتصفح (window.AlertRules) وفي Node (module.exports)
 * حتى تُختبر القواعد نفسها برمجيًا (scripts/alert-rules-test.js).
 */
(function (root, factory) {
    var rules = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = rules;
    else root.AlertRules = rules;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var LIMITS = { arrival: 10, mubashara: 12, onscene: 15 };
    var STAGE_TXT = { arrival: 'تأخر وصول', mubashara: 'تأخر مباشرة', onscene: 'بقاء متجاوز للحد' };

    /** «7:11:38 AM» أو «20/08/2026 5:00:06 AM» → دقائق منذ منتصف الليل (null إن تعذر) */
    function cadMin(str) {
        if (!str) return null;
        var m = String(str).trim().match(/^(?:(\d{1,2})\/(\d{1,2})\/(\d{4})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|ص|م)?$/i);
        if (!m) return null;
        var h = parseInt(m[4], 10);
        var mer = m[7] || '';
        if (/pm|م/i.test(mer) && h < 12) h += 12;
        if (/am|ص/i.test(mer) && h === 12) h = 0;
        var min = parseInt(m[5], 10), sec = m[6] ? parseInt(m[6], 10) : 0;
        if (h > 23 || min > 59 || sec > 59) return null;
        return h * 60 + min + sec / 60;
    }
    function cadDiff(fromMin, toMin) { if (toMin < fromMin) toMin += 1440; return toMin - fromMin; }

    /**
     * مرحلة الفرقة من أحداث CAD الفعلية فقط.
     * null = لم تتحرك (بلا تحرك موثق) ← غير مؤهلة لأي مؤقت/تنبيه.
     */
    function crewStage(phases) {
        if (!phases || !phases['التحرك']) return null;
        if (!phases['البحث']) return 'arrival';
        if (!phases['العلاج']) return 'mubashara';
        return 'onscene';
    }

    /**
     * مؤقت الفرقة الحالي على بلاغ: {stage, elapsed, limit, level} أو null (غير مؤهلة / بلا وقت إنشاء).
     * level: 'over' تجاوز الحد · 'near' ≥80% منه · 'ok' ضمنه.
     */
    function crewTimer(phases, cadCreatedAt, nowMinutes) {
        var createdMin = cadMin(cadCreatedAt);
        if (createdMin === null) return null;
        var stage = crewStage(phases);
        if (!stage) return null;
        var startMin;
        if (stage === 'onscene') {
            startMin = cadMin(phases['البحث']);
            if (startMin === null) return null;
        } else {
            startMin = createdMin;
        }
        var elapsed = cadDiff(startMin, nowMinutes);
        var limit = LIMITS[stage];
        var level = elapsed > limit ? 'over' : (elapsed >= limit * 0.8 ? 'near' : 'ok');
        return { stage: stage, elapsed: elapsed, limit: limit, level: level };
    }

    /**
     * حالة دورة حياة البلاغ (قرار المالك 2026-08-22): «النهائي يخرج فورًا من التشغيل».
     * القاعدة: NULL/غير المعروف/'active' ← نشط (السجلات القديمة والبلاغات الجارية)،
     * وأي حالة نهائية معتمدة ('closed'/'cancelled' — قابلة للتمديد) ← نهائي.
     * البلاغ النهائي: لا تنبيه ولا مؤقت إطلاقًا — يبقى في السجل التاريخي فقط.
     */
    var FINAL_STATUSES = { closed: true, cancelled: true };
    function isFinal(status) {
        if (status === null || status === undefined || status === '' || status === 'active') return false;
        return FINAL_STATUSES[status] !== false; // أي قيمة غير active تُعامل نهائية — توسعة القاموس لا تكسر البوابة
    }

    /**
     * حساب تنبيهات مناوبة من ملخص المحرك: لكل (بلاغ × فرقة مؤهلة) مدخل واحد كحد أقصى.
     * الفرقة الملغاة/التي لم تتحرك لا تنتج شيئًا — والبلاغ بلا وقت إنشاء يُستثنى بصدق.
     * والبلاغ النهائي (مغلق/ملغى) يخرج كاملًا من التنبيهات فورًا — التنبيه حالة تشغيلية
     * حالية، لا سجل تاريخي (قرار المالك 2026-08-22).
     * مرتبة: المتجاوز أولًا (بالأكثر تجاوزًا) ثم القريب.
     */
    function computeAlerts(summary, nowMinutes) {
        var out = [];
        if (!summary || !summary.incidents) return out;
        summary.incidents.forEach(function (ic) {
            if (isFinal(ic.status)) return; // انتهى البلاغ ← تنتهي تنبيهاته ومؤقتاته معه فورًا
            (ic.crews || []).forEach(function (c) {
                if (c.withdrawn) return; // الفرقة المسحوبة من البلاغ: ينتهي كل ما يتعلق بها فورًا (§4)
                var t = crewTimer(c.phases, ic.cadCreatedAt, nowMinutes);
                if (!t || t.level === 'ok') return;
                out.push({ number: String(ic.number), unit: c.unit, stage: t.stage, elapsed: t.elapsed, limit: t.limit, level: t.level });
            });
        });
        out.sort(function (a, b) {
            if (a.level !== b.level) return a.level === 'over' ? -1 : 1;
            return (b.elapsed - b.limit) - (a.elapsed - a.limit);
        });
        return out;
    }

    return {
        LIMITS: LIMITS, STAGE_TXT: STAGE_TXT, FINAL_STATUSES: FINAL_STATUSES,
        cadMin: cadMin, cadDiff: cadDiff, isFinal: isFinal,
        crewStage: crewStage, crewTimer: crewTimer, computeAlerts: computeAlerts
    };
});
