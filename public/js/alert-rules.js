/**
 * ═══ محرك الأزمنة التشغيلية — alert-rules.js ═══
 * (اعتماد المالك 2026-08-25 — إعادة بناء تنبيهات الخريطة حسب مراحل البلاغ وتصنيفه)
 *
 * التعريف التشغيلي المعتمد للرحلة (من CAD Journey الفعلية):
 *   إنشاء البلاغ (createdDate) → قبول → التحرك → الاستجابة
 *     → البحث (PATIENT_REACH = وصول الفرقة)
 *     → العلاج (AT_PATIENT = مباشرة الحالة)
 *     → النقل (TO_HOSPITAL)
 *     → بدء التسليم (AT_HOSPITAL)
 *     → انتهاء التسليم (HANDOVER)
 *
 * أربع مراحل مستقلة تمامًا — كل مرحلة لها Start وEnd وTarget خاص:
 *   ① arrival  : createdDate → البحث          — الهدف 10 د (Echo = 8 د)
 *   ② direct   : البحث → العلاج                — الهدف 2 د  (لا تُحسب من الإنشاء إطلاقًا)
 *   ③ scene    : العلاج → النقل/نهاية البلاغ   — الهدف 10 د
 *   ④ facility : بدء التسليم → انتهاء التسليم  — الهدف 10 د
 *
 * قاعدة الحد (اعتماد المالك): التنبيه عند التجاوز الفعلي فقط —
 *   10:00 = لا تأخير · 10:01 = تأخير. ومستوى «قريب» (≥80%) مؤشر منفصل وليس تأخيرًا.
 *
 * المؤقت ينتقل مع المرحلة ولا تعمل مؤقتان معًا: عند تسجيل حدث نهاية المرحلة
 * يتوقف مؤقتها تمامًا ولا يستمر في إصدار تنبيهات (لا تنبيهات وهمية).
 *
 * تصنيف البلاغ (A/B/C/D/E) مصدره الوحيد: حرف proQACode القادم من CAD —
 * لا استنتاج من نوع البلاغ أو اسمه أو الرقم الأول. Parser مركزي واحد هنا
 * تستخدمه الخريطة والتنبيهات وأي مؤشر — لا استخراج موزعًا في الملفات.
 * (مُثبت من البيانات الفعلية: 140 كودًا في incident_registry كلها تطابق
 *  ^\d{1,2}[A-E]\d{2}[A-Z]?$ — بما فيها Echo حقيقي: 9E01)
 *
 * بوابة الأهلية الصارمة (قرار المالك 2026-08-21 — ما زالت سارية):
 *   فرقة بلا «التحرك» (phases=null أو {} أو قبول فقط) ← غير مؤهلة: لا Timer ولا Alert.
 *   بلاغ بلا وقت إنشاء CAD ← بلا مؤقت إطلاقًا (صدق البيانات).
 *   عبور منتصف الليل +1440 — مطابق حرفيًا لمنطق ReportService (_cadMinutes/_cadDiffMin).
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

    /* ─── التصنيف التشغيلي (proQACode → حرف → تصنيف → سياسة زمنية) ─── */
    var PRIORITY = {
        A: { name: 'Alpha',   label: 'بلاغ بارد / غير إسعافي' },
        B: { name: 'Bravo',   label: 'بلاغ متوسط' },
        C: { name: 'Charlie', label: 'بلاغ عادي' },
        D: { name: 'Delta',   label: 'بلاغ خطير' },
        E: { name: 'Echo',    label: 'مهدد للحياة', critical: true }
    };

    /**
     * Parser مركزي وحيد للتصنيف — يتحمل اختلاف شكل الكود المثبت في البيانات:
     * رقم أو رقمان + حرف A–E + رقمان + لاحقة حرفية اختيارية (9E01 · 31D02 · 25D03V).
     * يرجع {letter, name, label, critical} أو null إن لم يوجد كود صالح (بلا تخمين).
     */
    function classify(code) {
        if (!code) return null;
        var m = String(code).trim().match(/^\d{1,2}([A-E])\d{2}[A-Z]?$/i);
        if (!m) return null;
        var letter = m[1].toUpperCase();
        var p = PRIORITY[letter];
        return { letter: letter, name: p.name, label: p.label, critical: !!p.critical };
    }

    /* ─── الأهداف الزمنية المعتمدة (دقائق) ─── */
    var TARGETS = { arrival: 10, arrivalEcho: 8, direct: 2, scene: 10, facility: 10 };
    var STAGE_TXT = { arrival: 'تأخر وصول', direct: 'تأخر مباشرة', scene: 'تأخر في الموقع', facility: 'تأخر في المنشأة' };
    var STAGE_LABEL = { arrival: 'زمن الوصول', direct: 'زمن المباشرة', scene: 'البقاء في الموقع', facility: 'البقاء في المنشأة' };
    /* مفتاح المرحلة في phases الذي يبدأ عنده كل مؤقت (البحث/العلاج/بدء التسليم) */
    var STAGE_START_KEY = { direct: 'البحث', scene: 'العلاج', facility: 'بدء التسليم' };

    function arrivalTarget(cls) { return (cls && cls.letter === 'E') ? TARGETS.arrivalEcho : TARGETS.arrival; }
    function stageTarget(stage, cls) { return stage === 'arrival' ? arrivalTarget(cls) : TARGETS[stage]; }

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

    /** بوابة الأهلية: حدث «التحرك» الفعلي من CAD — لا مجرد ارتباط بالبلاغ */
    function hasMovement(phases) { return !!(phases && phases['التحرك']); }

    /**
     * المرحلة النشطة للفرقة من أحداث CAD الفعلية فقط — مؤقت واحد في أي لحظة:
     *  • بلا «التحرك»            ← null (غير مؤهلة إطلاقًا)
     *  • «انتهاء التسليم» مسجل   ← null (اكتملت الرحلة — توقفت كل المؤقتات)
     *  • «بدء التسليم»           ← facility (مؤقت المنشأة يعمل حتى HANDOVER)
     *  • «النقل» بلا بدء تسليم   ← null (في الطريق للمنشأة — لا مؤقت معتمد بين الحدثين)
     *  • «العلاج» بلا نقل        ← scene (حتى TO_HOSPITAL أو نهاية البلاغ)
     *  • «البحث» بلا علاج        ← direct (حتى AT_PATIENT)
     *  • تحركت بلا بحث           ← arrival (من createdDate حتى PATIENT_REACH)
     */
    function crewStage(phases) {
        if (!hasMovement(phases)) return null;
        if (phases['انتهاء التسليم']) return null;
        if (phases['بدء التسليم']) return 'facility';
        if (phases['النقل']) return null;
        if (phases['العلاج']) return 'scene';
        if (phases['البحث']) return 'direct';
        return 'arrival';
    }

    /**
     * مؤقت الفرقة الحالي على بلاغ:
     * {stage, classification, target, startAt, elapsed, overdue, level} أو null (غير مؤهلة / بلا وقت إنشاء).
     * level: 'over' تجاوز الهدف فعليًا (> target فقط — المساواة ليست تأخيرًا) ·
     *        'near' ≥80% من الهدف (مؤشر منفصل — ليس تأخيرًا) · 'ok' ضمنه.
     */
    function crewTimer(phases, cadCreatedAt, nowMinutes, cls) {
        var createdMin = cadMin(cadCreatedAt);
        if (createdMin === null) return null;
        var stage = crewStage(phases);
        if (!stage) return null;
        var startAt, startMin;
        if (stage === 'arrival') {
            startAt = cadCreatedAt; startMin = createdMin;
        } else {
            startAt = phases[STAGE_START_KEY[stage]];
            startMin = cadMin(startAt);
            if (startMin === null) return null;
        }
        var elapsed = cadDiff(startMin, nowMinutes);
        var target = stageTarget(stage, cls || null);
        var level = elapsed > target ? 'over' : (elapsed >= target * 0.8 ? 'near' : 'ok');
        return {
            stage: stage, classification: cls || null, target: target, startAt: startAt,
            elapsed: elapsed, overdue: elapsed > target ? elapsed - target : 0, level: level
        };
    }

    /**
     * حالة دورة حياة البلاغ (قرار المالك 2026-08-22): «النهائي يخرج فورًا من التشغيل».
     * البلاغ النهائي: لا تنبيه ولا مؤقت إطلاقًا — وهو أيضًا حدث نهاية مرحلة الموقع
     * عند غياب النقل (رفض نقل / إنهاء حالة): لا يستمر أي مؤقت بعد انتهاء البلاغ.
     */
    var FINAL_STATUSES = { closed: true, cancelled: true };
    function isFinal(status) {
        if (status === null || status === undefined || status === '' || status === 'active') return false;
        return FINAL_STATUSES[status] !== false; // أي قيمة غير active تُعامل نهائية — توسعة القاموس لا تكسر البوابة
    }

    /**
     * حساب تنبيهات مناوبة من ملخص المحرك: لكل (بلاغ × فرقة مؤهلة) مدخل واحد كحد أقصى.
     * الفرقة الملغاة/التي لم تتحرك لا تنتج شيئًا — والبلاغ بلا وقت إنشاء يُستثنى بصدق،
     * والبلاغ النهائي يخرج كاملًا من التنبيهات فورًا (قرار المالك 2026-08-22).
     * كل مدخل يحمل سبب التنبيه كاملًا (§9): المرحلة + التصنيف + الهدف + الفعلي + التجاوز.
     * مرتبة: المتجاوز أولًا (بالأكثر تجاوزًا) ثم القريب.
     */
    function computeAlerts(summary, nowMinutes) {
        var out = [];
        if (!summary || !summary.incidents) return out;
        summary.incidents.forEach(function (ic) {
            if (isFinal(ic.status)) return; // انتهى البلاغ ← تنتهي تنبيهاته ومؤقتاته معه فورًا
            var cls = classify(ic.code);    // التصنيف من proQACode — مصدر موحد
            (ic.crews || []).forEach(function (c) {
                if (c.withdrawn) return; // الفرقة المسحوبة من البلاغ: ينتهي كل ما يتعلق بها فورًا (§4)
                var t = crewTimer(c.phases, ic.cadCreatedAt, nowMinutes, cls);
                if (!t || t.level === 'ok') return;
                out.push({
                    number: String(ic.number), unit: c.unit,
                    stage: t.stage, classification: t.classification,
                    target: t.target, startAt: t.startAt,
                    elapsed: t.elapsed, overdue: t.overdue, level: t.level
                });
            });
        });
        out.sort(function (a, b) {
            if (a.level !== b.level) return a.level === 'over' ? -1 : 1;
            return (b.elapsed - b.target) - (a.elapsed - a.target);
        });
        return out;
    }

    return {
        PRIORITY: PRIORITY, classify: classify,
        TARGETS: TARGETS, STAGE_TXT: STAGE_TXT, STAGE_LABEL: STAGE_LABEL,
        arrivalTarget: arrivalTarget, stageTarget: stageTarget,
        FINAL_STATUSES: FINAL_STATUSES,
        cadMin: cadMin, cadDiff: cadDiff, isFinal: isFinal,
        hasMovement: hasMovement, crewStage: crewStage, crewTimer: crewTimer, computeAlerts: computeAlerts
    };
});
