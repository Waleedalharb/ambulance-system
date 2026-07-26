// اختبار وحدات للملف المركزي public/js/time-riyadh.js
const T = require('C:/projects/Ambulance Dispatch/public/js/time-riyadh.js');

let pass = 0, fail = 0;
function eq(label, actual, expected) {
    const ok = actual === expected;
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | actual=' + JSON.stringify(actual) + ' | expected=' + JSON.stringify(expected));
}

// الحالات الإلزامية من المواصفة
eq("formatTime('2026-07-26T11:23:19.996Z')", T.formatTime('2026-07-26T11:23:19.996Z'), '14:23');
eq("formatTime('2026-07-26 10:08:57')", T.formatTime('2026-07-26 10:08:57'), '13:08');
eq("formatDate('2026-07-22')", T.formatDate('2026-07-22'), '2026-07-22');
eq("formatTime(null)", T.formatTime(null), '—');

// تغطية إضافية
eq("formatTimeSec('2026-07-26T11:23:19.996Z')", T.formatTimeSec('2026-07-26T11:23:19.996Z'), '14:23:19');
eq("formatTimeSec('2026-07-26 10:08:57')", T.formatTimeSec('2026-07-26 10:08:57'), '13:08:57');
eq("formatDate('2026-07-26T11:23:19.996Z')", T.formatDate('2026-07-26T11:23:19.996Z'), '2026-07-26');
eq("formatDateTime('2026-07-26T11:23:19.996Z')", T.formatDateTime('2026-07-26T11:23:19.996Z'), '2026-07-26 14:23');
eq("formatDateTimeSec('2026-07-26 10:08:57')", T.formatDateTimeSec('2026-07-26 10:08:57'), '2026-07-26 13:08:57');
eq("formatTime naive-T '2026-07-26T10:08:57'", T.formatTime('2026-07-26T10:08:57'), '13:08');
eq("formatTime offset '2026-07-26T11:23:19+03:00'", T.formatTime('2026-07-26T11:23:19+03:00'), '11:23');
eq("formatDateTime date-only", T.formatDateTime('2026-07-22'), '2026-07-22');
eq("formatDateTimeSec date-only", T.formatDateTimeSec('2026-07-22'), '2026-07-22');
eq("formatTime date-only", T.formatTime('2026-07-22'), '—');
eq("formatTime epoch", T.formatTime(new Date('2026-07-26T11:23:19.996Z').getTime()), '14:23');
eq("formatTime Date obj", T.formatTime(new Date('2026-07-26T11:23:19.996Z')), '14:23');
eq("formatDate('')", T.formatDate(''), '—');
eq("formatDateTime(undefined)", T.formatDateTime(undefined), '—');
eq("formatTime('garbage')", T.formatTime('garbage'), '—');
eq("formatTime invalid Date", T.formatTime(new Date('x')), '—');
// منتصف الليل UTC → 03:00 الرياض (فحص hourCycle h23)
eq("formatTime midnight '2026-07-26T21:00:00Z'", T.formatTime('2026-07-26T21:00:00Z'), '00:00');
// عبور منتصف الليل: 22:00 UTC → 01:00 اليوم التالي
eq("formatDate rollover '2026-07-26T22:30:00Z'", T.formatDate('2026-07-26T22:30:00Z'), '2026-07-27');
eq("formatDateTime rollover", T.formatDateTime('2026-07-26T22:30:00Z'), '2026-07-27 01:30');

// الدوال العربية الجديدة (ar-SA)
eq("formatDayName ISO", T.formatDayName('2026-07-26T11:23:19.996Z'), 'الأحد');
eq("formatMonthYear ISO", T.formatMonthYear('2026-07-26T11:23:19.996Z'), '٠٧‏/٢٠٢٦');
eq("formatFullDate ISO", T.formatFullDate('2026-07-26T11:23:19.996Z'), 'الأحد، ٢٦ يوليو ٢٠٢٦');
eq("formatDayName naive", T.formatDayName('2026-07-26 10:08:57'), 'الأحد');
eq("formatDayName date-only", T.formatDayName('2026-07-22'), 'الأربعاء');
eq("formatFullDate date-only", T.formatFullDate('2026-07-22'), 'الأربعاء، ٢٢ يوليو ٢٠٢٦');
eq("formatMonthYear date-only", T.formatMonthYear('2026-07-22'), '٠٧‏/٢٠٢٦');
eq("formatDayName(null)", T.formatDayName(null), '—');
eq("formatMonthYear('')", T.formatMonthYear(''), '—');
eq("formatFullDate('garbage')", T.formatFullDate('garbage'), '—');
// عبور منتصف الليل: 22:30 UTC = 01:30 اليوم التالي بالرياض → اسم يوم الاثنين
eq("formatDayName rollover", T.formatDayName('2026-07-26T22:30:00Z'), 'الاثنين');
eq("formatFullDate rollover", T.formatFullDate('2026-07-26T22:30:00Z'), 'الاثنين، ٢٧ يوليو ٢٠٢٦');

// riyadhParts — دالة المنطق (كشف المناوبة)
const p1 = T.riyadhParts('2026-07-26T11:23:19.996Z');
eq("riyadhParts hour ISO", p1 && p1.hour, '14');
eq("riyadhParts date ISO", p1 && (p1.year + '-' + p1.month + '-' + p1.day), '2026-07-26');
const p2 = T.riyadhParts('2026-07-26T22:30:00Z');
eq("riyadhParts rollover day", p2 && p2.day, '27');
eq("riyadhParts rollover hour", p2 && p2.hour, '01');
eq("riyadhParts(null)", T.riyadhParts(null), null);

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
