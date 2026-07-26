/**
 * TimeRiyadh — الطبقة المركزية الوحيدة لتحويل وعرض الوقت (Asia/Riyadh)
 * ═══════════════════════════════════════════════════════════════════
 * التخزين UTC (لا يُمسّ). هذا الملف طبقة عرض فقط:
 * كل التنسيق يمر عبر Intl.DateTimeFormat بـ timeZone:'Asia/Riyadh' — بلا أي منطق تحويل آخر.
 *
 * نمط UMD: يعمل في المتصفح (window.TimeRiyadh) وفي Node (module.exports)
 * حتى تستخدمه خدمة PDF السيرفرية نفسها.
 *
 * تطبيع المدخل:
 *   - ISO بـZ أو إزاحة ('2026-07-26T11:23:19.996Z', '...+03:00') → يُحلَّل كما هو.
 *   - naive بمسافة ('2026-07-26 10:08:57') → تُستبدل المسافة بـT ويُلحَق 'Z' (UTC).
 *   - naive بـT بلا Z ('2026-07-26T10:08:57') → يُلحَق 'Z' (UTC).
 *   - تاريخ فقط ('2026-07-22') → يُعامل كتاريخ بلا تحويل ساعات:
 *       formatDate/ formatDateTime/ formatDateTimeSec تُرجع التاريخ كما هو،
 *       وformatTime/ formatTimeSec تُرجع '—' (لا معلومات وقت).
 *   - رقم epoch (مللي ثانية) → new Date(n).
 *   - null / '' / غير صالح → '—'.
 *
 * دوال العرض العربية (ar-SA):
 *   - formatDayName(v)   → اسم اليوم (weekday:'long')
 *   - formatMonthYear(v) → سنة+شهر (year:'numeric', month:'2-digit')
 *   - formatFullDate(v)  → تاريخ كامل باسم اليوم والشهر
 *     (weekday:'long', year:'numeric', month:'long', day:'numeric')
 *   التاريخ المجرد 'YYYY-MM-DD' في هذه الدوال يُفسَّر منتصف الليل UTC
 *   (= 03:00 الرياض، نفس اليوم) حتى يصح اسم اليوم.
 *
 * دالة المنطق (ليست للعرض):
 *   - riyadhParts(v) → { year, month, day, hour, minute, second } بتوقيت الرياض
 *     لمنطق كشف المناوبة ونحوه، حتى لا تحتاج أي صفحة Intl.DateTimeFormat مباشرة.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TimeRiyadh = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var TZ = 'Asia/Riyadh';

    var fmtTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
    });
    var fmtTimeSec = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23'
    });
    var fmtDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    var fmtDayName = new Intl.DateTimeFormat('ar-SA', {
        timeZone: TZ, weekday: 'long'
    });
    var fmtMonthYear = new Intl.DateTimeFormat('ar-SA', {
        timeZone: TZ, year: 'numeric', month: '2-digit'
    });
    var fmtFullDate = new Intl.DateTimeFormat('ar-SA', {
        timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    var fmtParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, hourCycle: 'h23'
    });

    // يُرجع { d: Date } أو { dateOnly: 'YYYY-MM-DD' } أو null
    function normalize(v) {
        if (v === null || v === undefined || v === '') return null;
        if (v instanceof Date) return isNaN(v.getTime()) ? null : { d: v };
        if (typeof v === 'number' && isFinite(v)) {
            var dn = new Date(v);
            return isNaN(dn.getTime()) ? null : { d: dn };
        }
        var s = String(v).trim();
        if (!s) return null;
        // تاريخ فقط — بلا تحويل ساعات
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { dateOnly: s };
        // naive بمسافة → UTC
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
            s = s.replace(' ', 'T') + 'Z';
        } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
            // naive بـT بلا إزاحة → UTC
            s = s + 'Z';
        }
        var d = new Date(s);
        return isNaN(d.getTime()) ? null : { d: d };
    }

    function formatTime(v) {
        var n = normalize(v);
        return (n && n.d) ? fmtTime.format(n.d) : '—';
    }

    function formatTimeSec(v) {
        var n = normalize(v);
        return (n && n.d) ? fmtTimeSec.format(n.d) : '—';
    }

    function formatDate(v) {
        var n = normalize(v);
        if (!n) return '—';
        if (n.dateOnly) return n.dateOnly;
        return fmtDate.format(n.d);
    }

    function formatDateTime(v) {
        var n = normalize(v);
        if (!n) return '—';
        if (n.dateOnly) return n.dateOnly;
        return fmtDate.format(n.d) + ' ' + fmtTime.format(n.d);
    }

    function formatDateTimeSec(v) {
        var n = normalize(v);
        if (!n) return '—';
        if (n.dateOnly) return n.dateOnly;
        return fmtDate.format(n.d) + ' ' + fmtTimeSec.format(n.d);
    }

    // الدوال العربية: التاريخ المجرد يُفسَّر منتصف الليل UTC (= 03:00 الرياض، نفس اليوم)
    function dateForAr(n) {
        if (!n) return null;
        if (n.dateOnly) return new Date(n.dateOnly + 'T00:00:00Z');
        return n.d;
    }

    function formatDayName(v) {
        var d = dateForAr(normalize(v));
        return d ? fmtDayName.format(d) : '—';
    }

    function formatMonthYear(v) {
        var d = dateForAr(normalize(v));
        return d ? fmtMonthYear.format(d) : '—';
    }

    function formatFullDate(v) {
        var d = dateForAr(normalize(v));
        return d ? fmtFullDate.format(d) : '—';
    }

    // منطق (وليس عرض): مكوّنات الوقت بتوقيت الرياض لكشف المناوبة ونحوه
    function riyadhParts(v) {
        var n = normalize(v);
        if (!n) return null;
        var d = n.dateOnly ? new Date(n.dateOnly + 'T00:00:00Z') : n.d;
        var out = {};
        fmtParts.formatToParts(d).forEach(function (p) {
            if (p.type !== 'literal') out[p.type] = p.value;
        });
        return out;
    }

    return {
        formatTime: formatTime,
        formatTimeSec: formatTimeSec,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        formatDateTimeSec: formatDateTimeSec,
        formatDayName: formatDayName,
        formatMonthYear: formatMonthYear,
        formatFullDate: formatFullDate,
        riyadhParts: riyadhParts
    };
}));
