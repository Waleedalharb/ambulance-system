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
 *   - getSaudiDate()        → date string (ar-SA, Asia/Riyadh)
 *   - getSaudiTime()        → time string (ar-SA, Asia/Riyadh)
 *   - getSaudiDateTime()    → full date+time string (ar-SA, Asia/Riyadh)
 *   - getSaudiDay()         → weekday name (ar-SA, Asia/Riyadh)
 *   - getSaudiMonthYear()   → year+month string (ar-SA, Asia/Riyadh)
 *   - getCurrentShiftType() → 'صباح' (05:00-17:00) | 'ليل' (17:00-05:00)
 *   - getCurrentShiftDate() → 'YYYY-MM-DD' shift date (night shift 00:00-05:00
 *                             belongs to previous day)
 */
(function(global) {
    'use strict';

    // ============================================
    // دوال الوقت السعودي (Asia/Riyadh)
    // ============================================
    var saudiFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
    var saudiTimeFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var saudiFullFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var saudiDayFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', weekday: 'long' });
    var saudiMonthYearFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit' });

    function getSaudiDate() {
        return saudiFormatter.format(new Date());
    }
    function getSaudiTime() {
        return saudiTimeFormatter.format(new Date());
    }
    function getSaudiDateTime() {
        return saudiFullFormatter.format(new Date());
    }
    function getSaudiDay() {
        return saudiDayFormatter.format(new Date());
    }
    function getSaudiMonthYear() {
        return saudiMonthYearFormatter.format(new Date());
    }

    // ============================================
    // نظام النوبة التلقائي (Auto-Shift)
    // ============================================
    function getCurrentShiftType() {
        var now = new Date();
        // Get UTC time first, then add Saudi offset (+3)
        var utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
        var saudiTime = new Date(utc + (3 * 60 * 60 * 1000));
        var hour = saudiTime.getHours();
        // صباح: 05:00 - 17:00 | ليل: 17:00 - 05:00
        return (hour >= 5 && hour < 17) ? 'صباح' : 'ليل';
    }

    function getCurrentShiftDate() {
        var now = new Date();
        var utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
        var saudiTime = new Date(utc + (3 * 60 * 60 * 1000));
        var year = saudiTime.getFullYear();
        var month = saudiTime.getMonth();
        var day = saudiTime.getDate();
        var hour = saudiTime.getHours();

        var shiftDate = new Date(year, month, day);

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
