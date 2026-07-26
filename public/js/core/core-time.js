/**
 * TimeCore - Saudi Time Helpers (Asia/Riyadh), page-agnostic
 * منصة إدارة العمليات الإسعافية – قطاع جنوب الرياض
 *
 * Copied 1:1 from public/js/app.js (دوال الوقت السعودي / نظام النوبة التلقائي)
 * and exposed under the TimeCore namespace so any page can share them.
 *
 * Load order: core-auth.js → core-toast.js → core-time.js
 *
 * Global API: window.TimeCore
 *   - getSaudiDate()        → 'YYYY-MM-DD' (غلاف TimeRiyadh.formatDate)
 *   - getSaudiTime()        → 'HH:MM:SS' (غلاف TimeRiyadh.formatTimeSec)
 *   - getSaudiDateTime()    → 'YYYY-MM-DD HH:MM:SS' (غلاف TimeRiyadh.formatDateTimeSec)
 *   - getSaudiDay()         → weekday name (غلاف TimeRiyadh.formatDayName)
 *   - getSaudiMonthYear()   → year+month (غلاف TimeRiyadh.formatMonthYear)
 *   - getCurrentShiftType() → 'صباح' (05:00-17:00) | 'ليل' (17:00-05:00)
 *   - getCurrentShiftDate() → 'YYYY-MM-DD' shift date (night shift 00:00-05:00
 *                             belongs to previous day)
 */
(function(global) {
    'use strict';

    // ============================================
    // دوال الوقت السعودي (Asia/Riyadh)
    // أغلفة رقيقة — كل التحويل مفوَّض للطبقة المركزية /js/time-riyadh.js (window.TimeRiyadh)
    // (تُحمَّل بعد time-riyadh.js في كل الصفحات — ترتيب الإدراج مضمون)
    // ============================================
    function getSaudiDate() {
        return TimeRiyadh.formatDate(new Date());
    }
    function getSaudiTime() {
        return TimeRiyadh.formatTimeSec(new Date());
    }
    function getSaudiDateTime() {
        return TimeRiyadh.formatDateTimeSec(new Date());
    }
    function getSaudiDay() {
        return TimeRiyadh.formatDayName(new Date());
    }
    function getSaudiMonthYear() {
        return TimeRiyadh.formatMonthYear(new Date());
    }

    // ============================================
    // نظام النوبة التلقائي (Auto-Shift)
    // المنطق نفسه — مكوّنات الوقت من TimeRiyadh.riyadhParts (بلا إزاحة يدوية +3)
    // ============================================
    function getCurrentShiftType() {
        var p = TimeRiyadh.riyadhParts(new Date());
        var hour = parseInt(p.hour, 10);
        // صباح: 05:00 - 17:00 | ليل: 17:00 - 05:00
        return (hour >= 5 && hour < 17) ? 'صباح' : 'ليل';
    }

    function getCurrentShiftDate() {
        var p = TimeRiyadh.riyadhParts(new Date());
        var hour = parseInt(p.hour, 10);

        // تاريخ محلي مؤقت لمجرد حساب «اليوم السابق» — لا يُعرض ولا يُحوَّل
        var shiftDate = new Date(parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10));

        // Night shift runs from 17:00 to 05:00 next day
        // If time is between 00:00 and 05:00, we are in the night shift that started yesterday
        if (hour >= 0 && hour < 5) {
            shiftDate.setDate(shiftDate.getDate() - 1);
        }

        var shiftYear = shiftDate.getFullYear();
        var shiftMonth = (shiftDate.getMonth() + 1).toString().padStart(2, '0');
        var shiftDay = shiftDate.getDate().toString().padStart(2, '0');
        return shiftYear + '-' + shiftMonth + '-' + shiftDay;
    }

    // ============================================
    // PUBLIC API
    // ============================================
    global.TimeCore = {
        getSaudiDate: getSaudiDate,
        getSaudiTime: getSaudiTime,
        getSaudiDateTime: getSaudiDateTime,
        getSaudiDay: getSaudiDay,
        getSaudiMonthYear: getSaudiMonthYear,
        getCurrentShiftType: getCurrentShiftType,
        getCurrentShiftDate: getCurrentShiftDate
    };

})(window);
