/**
 * ═══ hospital-monitoring-lost-test.js — إصلاح دورة المستشفى الكاملة (معزول) ═══
 * (اعتماد المالك 2026-08-28 — بعد إثبات تضخم البقاء 238/256د على 1321000/1320859)
 * يثبت بلا خادم ولا متصفح:
 *  أ) [1] حارس الطزاجة/الحالة: لا رفع ولا تحديث تنبيه لرحلة بالية/مغلقة/منقطعة
 *  ب) [2] انقطاع الرصد يوقف النمو: «آخر قيمة موثوقة» ولا تحول 12د إلى 238د
 *  ج) [3] الإغلاق الإداري monitoring-lost: لا BACK_TO_SERVICE مختلق، وسم + توثيق
 *  د) [4] وصول نهاية التسليم لاحقًا: قيمة حقيقية + completed-late-sync + Timeline
 *  هـ) [5] المصالحة البرمجية للتنبيهات المتأثرة: حلول موثق + unreliable + استبعاد
 *  و) [7] الفصل الثلاثي في الملخص: active/completed/monitoring-lost + العدّادات
 *  ز) الأرشيف يحتفظ بالحالة والتفسير (لقطة مختومة صادقة)
 *  ح) محاكاة حرفية للبلاغين 1321000 (238.4د) و1320859 (256.5د): مستحيل الوصول
 *     للتضخم — تُحلّ عند الانقطاع بقيمة آخر مشاهدة
 *  ح8) الصفر ممنوع: بلا نبضات (بصمة الإنتاج القديمة) ← dwellMin=null «غير مقاس»
 *  ح9) عدم تكرار التنبيه في changedIds عند تزامن المصالحة مع وصول النهاية الحقيقية
 *  ط) الانحدار: المسار الطبيعي (نشطة تكبر / مكتملة تثبت / BTS يحلّ) بلا تغيير
 *  ي) ثوابت المصدر (فحص نصي): الـOverlay يرسل monitoringLost + نبضة الحضور،
 *     والسيرفر يمرر القرار، ولا مساس بـ report_times/الاحتساب
 * التشغيل: node scripts/hospital-monitoring-lost-test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HospitalMonitorService } = require('../services/hospital-monitor-service');
const { ShiftArchiveSnapshot } = require('../shift-archive-engine');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// T0 = 20:39:08 الرياض = 17:39:08Z — لحظة «بدء التسليم» للبلاغ 1321000 الفعلية
const T0 = '2026-08-28T17:39:08.000Z';
const t = min => new Date(Date.parse(T0) + min * 60000).toISOString();
const svcFile = tag => path.join(os.tmpdir(), 'hm-ml-' + tag + '-' + Date.now() + '.json');

/* ─────────── ط — الانحدار: المسار الطبيعي بلا تغيير ─────────── */
function regressionSuite() {
    console.log('ط — الانحدار (المسار الطبيعي):');
    const K = '9000001:101';
    const S = { eventId: '9000001', unitId: 11, runUnitId: 101, unitCode: 'جنوب 7', hospitalName: 'مستشفى ط1', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 7' };
    const svc = new HospitalMonitorService(svcFile('reg'));

    svc.applySighting(S, t(0), 7);
    svc.applySighting(S, t(4), 7); // نبضة حضور
    let ch = svc.evaluateAlerts({ [K]: { dwellMin: 5, ongoing: true } }, t(5), 7);
    check('ط1 رحلة نشطة 5د ← لا تنبيه', ch.length === 0 && !svc._load().alerts[K + '|dwell-exceed']);

    ch = svc.evaluateAlerts({ [K]: { dwellMin: 11, ongoing: true } }, t(11), 7);
    check('ط2 نشطة طازجة 11د ← تنبيه open', ch.length === 1 && svc._load().alerts[K + '|dwell-exceed'].state === 'open');

    svc.applySighting(S, t(12), 7); // نبضة — تبقى طازجة
    ch = svc.evaluateAlerts({ [K]: { dwellMin: 12, ongoing: true } }, t(13), 7);
    check('ط3 النمو أثناء الرصد الطازج مسموح (11←12)', ch.length === 1 && svc._load().alerts[K + '|dwell-exceed'].dwellMin === 12);

    // مكتملة بنهاية حقيقية ← تثبت وتُحسب
    const K2 = '9000002:102';
    const S2 = { ...S, eventId: '9000002', runUnitId: 102 };
    svc.applySighting(S2, t(0), 7);
    svc.evaluateAlerts({ [K2]: { dwellMin: 8, ongoing: true } }, t(8), 7);
    check('ط4 مكتملة 8د ≤ 10 ← لا تنبيه', !svc._load().alerts[K2 + '|dwell-exceed']);
    const rc = svc.closeEpisode(S2, t(8), 7); // BACK_TO_SERVICE حقيقي
    const a2 = svc._load().alerts;
    check('ط5 الإغلاق الطبيعي يبقى episode-closed/back-to-service بلا وسم انقطاع',
        rc.kind === 'episode-closed' &&
        svc._load().current[K2].episodeState === 'last-known' && svc._load().current[K2].monitoringLost !== true);
    // تنبيه K1 ما زال طازجًا (نبضة t12) فلا تمسه المصالحة
    check('ط6 إغلاق رحلة أخرى لا يمس تنبيه الرحلة النشطة', svc._load().alerts[K + '|dwell-exceed'].state === 'open');

    // BTS يحلّ التنبيه النشط بالحدث الصحيح
    svc.applySighting(S, t(16), 7);
    svc.closeEpisode(S, t(17), 7);
    const a1 = svc._load().alerts[K + '|dwell-exceed'];
    check('ط7 BACK_TO_SERVICE يحلّ بالحدث الصحيح بلا unreliable',
        a1.state === 'resolved' && a1.resolution === 'back-to-service' && a1.unreliable !== true);

    // ملخص: المكتملة 8د تدخل المتوسط وتثبت
    const sum = svc.summarizeJourneys(svc.journeysForShift(7, null, null),
        { [K2]: { dwellMin: 8, ongoing: false } }, Date.parse(t(20)));
    check('ط8 المكتملة تُحسب: completed + avg=8 + بلا تجاوز',
        sum.lastKnownOnly === 2 && sum.monitoringLost === 0 && sum.avgDwellMin === 8 && sum.exceedances === 0,
        JSON.stringify({ lk: sum.lastKnownOnly, ml: sum.monitoringLost, avg: sum.avgDwellMin }));
}

/* ─────────── أ+ب+هـ — الانقطاع يوقف النمو ويحلّ التنبيه ─────────── */
function disappearanceSuite() {
    console.log('أ/ب/هـ — اختفاء بلا نهاية:');
    const K = '9000010:110';
    const S = { eventId: '9000010', unitId: 12, runUnitId: 110, unitCode: 'جنوب 4', hospitalName: 'مستشفى أ', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 4' };
    const svc = new HospitalMonitorService(svcFile('gone'));

    svc.applySighting(S, t(0), 7);
    svc.applySighting(S, t(4), 7); // نبضة
    svc.applySighting(S, t(8), 7); // نبضة — آخر حضور فعلي قبل الاختفاء
    svc.evaluateAlerts({ [K]: { dwellMin: 11, ongoing: true } }, t(11), 7); // تنبيه open
    const AID = K + '|dwell-exceed';

    // [1] الرحلة بالية (>30د بلا نبضة) ← لا تحديث رغم dwell منتفخ
    let ch = svc.evaluateAlerts({ [K]: { dwellMin: 45, ongoing: true } }, t(45), 7);
    const a = svc._load().alerts[AID];
    check('أ1 التنبيه لا ينتفخ بعد الاختفاء — يُحلّ monitoring-lost',
        a.state === 'resolved' && a.resolution === 'monitoring-lost' && a.unreliable === true);
    check('ب1 القيمة تُصحَّح إلى آخر مشاهدة (11د − 3د انتفاخ = 8د — لا 45د)',
        a.dwellMin === 8, 'dwellMin=' + a.dwellMin);
    check('هـ1 الحلول برمجي موثق: resolvedAt مختوم وchanged يشمل الحلول', ch.indexOf(AID) !== -1 && !!a.resolvedAt);

    // و/SSE: تكرار التقييم (تحديثات SSE) لا يعيد المؤقت ولا يغيّر شيئًا
    let churn = 0;
    for (let i = 1; i <= 10; i++) churn += svc.evaluateAlerts({ [K]: { dwellMin: 45 + i, ongoing: true } }, t(45 + i), 7).length;
    check('و1 ×10 تقييم SSE بعد الحلول ← صفر تغيير (لا إعادة مؤقت)', churn === 0);

    // [7] الملخص: monitoring-lost مستبعدة من العدّادات، وتُعرض «آخر قيمة موثوقة»
    const sum = svc.summarizeJourneys(svc.journeysForShift(7, null, null),
        { [K]: { dwellMin: 45, ongoing: true } }, Date.parse(t(45)));
    const row = sum.facilities[0] && sum.facilities[0].journeys[0];
    check('هـ2 monitoring-lost خارج المتوسط/التجاوزات/الجريان (unmeasured)',
        sum.currentAtHospital === 0 && sum.monitoringLost === 1 && sum.exceedances === 0 &&
        sum.ongoing === 0 && sum.unmeasured === 1 && sum.avgDwellMin === null);
    check('ب2 الصف يعرض آخر قيمة موثوقة موسومة (8د + dwellCapped)',
        row && row.monitoringLost === true && row.dwellCapped === true && row.dwellMin === 8,
        JSON.stringify(row));
    check('هـ3 التنبيه المحلول لا يدخل «النشطة»', svc.alertsInWindow(Date.parse(t(0)), null).filter(x => x.state !== 'resolved').length === 0);
    return { svc, K, S, AID };
}

/* ─────────── ج — الإغلاق الإداري المباشر (مسار الـOverlay) ─────────── */
function adminCloseSuite() {
    console.log('ج — الإغلاق الإداري monitoring-lost:');
    const K = '9000020:120';
    const S = { eventId: '9000020', unitId: 13, runUnitId: 120, unitCode: 'جنوب 8', hospitalName: 'مستشفى ج', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 8' };
    const svc = new HospitalMonitorService(svcFile('admin'));

    svc.applySighting(S, t(0), 7);
    svc.applySighting(S, t(4), 7);
    svc.evaluateAlerts({ [K]: { dwellMin: 10.5, ongoing: true } }, t(10.5), 7);
    // detail الأخير بلا نهاية ← الـOverlay يرسل episodeClose + monitoringLost
    const rc = svc.closeEpisode(S, t(12), 7, 'monitoring-lost');
    const cur = svc._load().current[K];
    const a = svc._load().alerts[K + '|dwell-exceed'];
    check('ج1 الإغلاق الإداري: kind مميّز + last-known + monitoringLost=true',
        rc.kind === 'episode-closed-monitoring-lost' && cur.episodeState === 'last-known' && cur.monitoringLost === true);
    check('ج2 لا BACK_TO_SERVICE مختلق: حدث history بختم MONITORING_LOST',
        svc.historyFor(K).some(h => h.field === 'episode' && h.to === 'last-known' && h.step === 'MONITORING_LOST') &&
        !svc.historyFor(K).some(h => h.step === 'BACK_TO_SERVICE'));
    check('ج3 التنبيه يُحلّ monitoring-lost + unreliable + تصحيح إلى آخر مشاهدة',
        a.state === 'resolved' && a.resolution === 'monitoring-lost' && a.unreliable === true && a.dwellMin === 4,
        'dwellMin=' + a.dwellMin); // 10.5 − (10.5−4) = 4

    // إعادة فتح بعد انقطاع: CAD أعاد القيمة ← وسم الانقطاع يسقط والتنبيه يعود نظيفًا
    const rr = svc.applySighting(S, t(50), 7);
    check('ج4 إعادة الفتح تسقط وسم الانقطاع', rr.kind === 'episode-reopened' && svc._load().current[K].monitoringLost === false);
    svc.evaluateAlerts({ [K]: { dwellMin: 12, ongoing: true } }, t(51), 7);
    const a2 = svc._load().alerts[K + '|dwell-exceed'];
    check('ج5 التنبيه يعود open نظيفًا (unreliable=false) بنفس الهوية',
        a2.state === 'open' && a2.unreliable === false && a2.resolution === null);
    return { svc, K, S };
}

/* ─────────── د — وصول النهاية الحقيقية لاحقًا ─────────── */
function lateSyncSuite() {
    console.log('د — وصول نهاية التسليم لاحقًا:');
    const K = '9000030:130';
    const S = { eventId: '9000030', unitId: 14, runUnitId: 130, unitCode: 'جنوب 9', hospitalName: 'مستشفى د', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 9' };
    const svc = new HospitalMonitorService(svcFile('late'));

    svc.applySighting(S, t(0), 7);
    svc.applySighting(S, t(4), 7);
    svc.evaluateAlerts({ [K]: { dwellMin: 11, ongoing: true } }, t(11), 7);
    svc.closeEpisode(S, t(12), 7, 'monitoring-lost'); // اختفاء بلا نهاية
    const AID = K + '|dwell-exceed';
    check('د0 قبل الوصول: محلول monitoring-lost غير موثوق',
        svc._load().alerts[AID].resolution === 'monitoring-lost' && svc._load().alerts[AID].unreliable === true);

    // detail/إثراء متأخر جلب «انتهاء التسليم» الحقيقي: 14د مكتملة
    const ch = svc.evaluateAlerts({ [K]: { dwellMin: 14, ongoing: false } }, t(40), 7);
    const a = svc._load().alerts[AID];
    check('د1 القيمة الحقيقية تحل محل التقدير (14د) + completed-late-sync + موثوقة',
        a.dwellMin === 14 && a.resolution === 'completed-late-sync' && a.unreliable === false && ch.indexOf(AID) !== -1);
    check('د2 التصحيح موثق في history (alert-dwell-corrected) ويظهر في Timeline',
        svc.historyFor(K).some(h => h.field === 'alert-dwell-corrected' && h.to === 14) &&
        svc.timelineForKeys([K]).some(e => e.field === 'alert-dwell-corrected'));
    // idempotent: التقييم المكرر لا يكرر التصحيح
    const before = svc.historyFor(K).length;
    const ch2 = svc.evaluateAlerts({ [K]: { dwellMin: 14, ongoing: false } }, t(41), 7);
    check('د3 تكرار التقييم بعد التصحيح ← صفر تغيير ولا حدث مكرر',
        ch2.length === 0 && svc.historyFor(K).length === before);
    // الملخص: القيمة الحقيقية المكتملة تُحسب رغم تاريخ الانقطاع
    const sum = svc.summarizeJourneys(svc.journeysForShift(7, null, null), { [K]: { dwellMin: 14, ongoing: false } }, Date.parse(t(42)));
    check('د4 المكتملة لاحقًا تدخل الإحصاء بقيمتها الحقيقية (تجاوز 14د)',
        sum.avgDwellMin === 14 && sum.exceedances === 1 && sum.unmeasured === 0);
}

/* ─────────── ح — محاكاة حرفية: 1321000 (238.4د) و1320859 (256.5د) ─────────── */
function productionSimSuite() {
    console.log('ح — محاكاة البلاغين الفعليين (مستحيل الوصول للتضخم):');
    const svc = new HospitalMonitorService(svcFile('prod'));

    // 1321000 — جنوب 9 — دلة-النمار — بدء التسليم 20:39:08
    const K1 = '1321000:2535587';
    const S1 = { eventId: '1321000', unitId: 1467, runUnitId: 2535587, unitCode: 'جنوب 9 - 1', hospitalName: 'Dr. Sulaiman Al Habib Hospital - Al Namar', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 9' };
    // 1320859 — جنوب 4 — الحبيب-السويدي — بدء التسليم 20:20:59 (T0−18.15د)
    const K2 = '1320859:2535459';
    const T0B = Date.parse(T0) - 18.15 * 60000;
    const tB = min => new Date(T0B + min * 60000).toISOString();
    const S2 = { eventId: '1320859', unitId: 1455, runUnitId: 2535459, unitCode: 'جنوب 4 - 1', hospitalName: 'Dr. Sulaiman Al Habib Hospital - Al Sweidi', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 4' };

    // رصد طبيعي مع نبضات ثم اختفاء كما حدث إنتاجيًا
    svc.applySighting(S1, t(0), 7);
    svc.applySighting(S1, t(4), 7);
    svc.applySighting(S1, t(8), 7);
    svc.applySighting(S2, tB(0), 7);
    svc.applySighting(S2, tB(4), 7);
    svc.applySighting(S2, tB(8), 7);
    svc.evaluateAlerts({ [K1]: { dwellMin: 10.2, ongoing: true } }, t(10.2), 7);
    svc.evaluateAlerts({ [K2]: { dwellMin: 10.4, ongoing: true } }, tB(10.4), 7);
    check('ح1 كلا التنبيهين رُفعا أثناء الرصد الطازج',
        svc._load().alerts[K1 + '|dwell-exceed'].state === 'open' && svc._load().alerts[K2 + '|dwell-exceed'].state === 'open');

    // CAD أغلق البلاغين ← اختفيا ← لا detail بنهاية ← إغلاق إداري (مسار الـOverlay)
    svc.closeEpisode(S1, t(12), 7, 'monitoring-lost');
    svc.closeEpisode(S2, tB(12), 7, 'monitoring-lost');

    // ساعات تمر — لقطة المالك 00:37: 238.4د و256.5د منتفختان في dwellByKey
    const ch = svc.evaluateAlerts(
        { [K1]: { dwellMin: 238.4, ongoing: true }, [K2]: { dwellMin: 256.5, ongoing: true } }, t(238.4), 7);
    const a1 = svc._load().alerts[K1 + '|dwell-exceed'];
    const a2 = svc._load().alerts[K2 + '|dwell-exceed'];
    check('ح2 1321000: مستحيل 238د — محلول عند الانقطاع بقيمة آخر مشاهدة (8د) وغير موثوق',
        a1.state === 'resolved' && a1.resolution === 'monitoring-lost' && a1.dwellMin === 8 && a1.unreliable === true,
        'dwellMin=' + a1.dwellMin + ' state=' + a1.state);
    check('ح3 1320859: مستحيل 256د — نفس السلوك (8د) وغير موثوق',
        a2.state === 'resolved' && a2.resolution === 'monitoring-lost' && a2.dwellMin === 8 && a2.unreliable === true,
        'dwellMin=' + a2.dwellMin);
    check('ح4 صفر تنبيهات نشطة بعد ساعات من الاختفاء',
        svc.alertsInWindow(Date.parse(tB(0)), null).filter(x => x.state !== 'resolved').length === 0);

    // الملخص عند لقطة 00:37: لا تضخم في أي عدّاد
    const sum = svc.summarizeJourneys(svc.journeysForShift(7, null, null),
        { [K1]: { dwellMin: 238.4, ongoing: true }, [K2]: { dwellMin: 256.5, ongoing: true } }, Date.parse(t(238.4)));
    check('ح5 الملخص عند اللقطة: monitoringLost=2 · تجاوزات=0 · متوسط=null · جارٍ=0',
        sum.monitoringLost === 2 && sum.exceedances === 0 && sum.avgDwellMin === null && sum.ongoing === 0 &&
        sum.currentAtHospital === 0, JSON.stringify({ ml: sum.monitoringLost, ex: sum.exceedances, avg: sum.avgDwellMin }));
    const r1 = sum.facilities.map(f => f.journeys[0]).find(j => j.eventId === '1321000');
    check('ح6 صف 1321000 يعرض 8د «عند آخر مشاهدة» لا 238.4د',
        r1 && r1.dwellMin === 8 && r1.dwellCapped === true, JSON.stringify(r1));

    // وصول النهاية الحقيقية لأحدهما لاحقًا (إثراء متأخر) ← تصحيح
    svc.evaluateAlerts({ [K2]: { dwellMin: 19, ongoing: false } }, t(240), 7);
    const a2b = svc._load().alerts[K2 + '|dwell-exceed'];
    check('ح7 نهاية حقيقية متأخرة لـ1320859 ← 19د completed-late-sync موثوقة',
        a2b.dwellMin === 19 && a2b.resolution === 'completed-late-sync' && a2b.unreliable === false);
}

/* ─────────── ح8/ح9 — حدّا «الصفر ممنوع» وعدم تكرار changedIds ─────────── */
function zeroAndDedupeSuite() {
    console.log('ح8/ح9 — الصفر ممنوع + عدم تكرار التنبيه في changedIds:');

    // ح8 — بصمة الإنتاج القديمة: مشاهدة وحدة بلا نبضات (المرساة = لحظة الإنشاء)
    const svc = new HospitalMonitorService(svcFile('nopulse'));
    const K = '9000050:150';
    const S = { eventId: '9000050', unitId: 16, runUnitId: 150, unitCode: 'جنوب 11', hospitalName: 'مستشفى ح8', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 11' };
    svc.applySighting(S, t(0), 7); // مشاهدة واحدة فقط — بلا نبضات حضور
    svc.evaluateAlerts({ [K]: { dwellMin: 11, ongoing: true } }, t(11), 7); // تنبيه open
    const AID = K + '|dwell-exceed';
    const ch = svc.evaluateAlerts({ [K]: { dwellMin: 45, ongoing: true } }, t(45), 7); // بالية + منتفخة
    const a = svc._load().alerts[AID];
    check('ح8 بلا نبضات: لا صفر — dwellMin=null «غير مقاس» + unreliable + monitoring-lost',
        a.state === 'resolved' && a.resolution === 'monitoring-lost' && a.unreliable === true && a.dwellMin === null,
        'dwellMin=' + a.dwellMin + ' res=' + a.resolution);
    check('ح8 الحلول موثق ويظهر في changed', ch.indexOf(AID) !== -1 && !!a.resolvedAt);

    // ح9 — مصالحة [5] ثم [4] بنفس التكة: النهاية الحقيقية تصل للرحلة البالية
    // ← completed-late-sync بالقيمة الحقيقية، والتنبيه يظهر مرة واحدة فقط في changed
    const svc9 = new HospitalMonitorService(svcFile('dedupe'));
    const K9 = '9000060:160';
    const S9 = { eventId: '9000060', unitId: 17, runUnitId: 160, unitCode: 'جنوب 12', hospitalName: 'مستشفى ح9', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 12' };
    svc9.applySighting(S9, t(0), 7);
    svc9.applySighting(S9, t(4), 7);
    svc9.evaluateAlerts({ [K9]: { dwellMin: 11, ongoing: true } }, t(11), 7); // تنبيه open
    const AID9 = K9 + '|dwell-exceed';
    // t(45): الرحلة بالية، لكن dwell مكتمل (نهاية حقيقية وصلت متأخرة) بنفس التقييم
    const ch9 = svc9.evaluateAlerts({ [K9]: { dwellMin: 14, ongoing: false } }, t(45), 7);
    const a9 = svc9._load().alerts[AID9];
    check('ح9 النهاية الحقيقية للرحلة البالية ← completed-late-sync بـ14د موثوقة',
        a9.state === 'resolved' && a9.resolution === 'completed-late-sync' && a9.dwellMin === 14 && a9.unreliable === false,
        'dwellMin=' + a9.dwellMin + ' res=' + a9.resolution);
    check('ح9 التنبيه يظهر مرة واحدة فقط في changedIds (لا تكرار)',
        ch9.filter(id => id === AID9).length === 1, JSON.stringify(ch9));
}

/* ─────────── ز — الأرشيف يحتفظ بالحالة والتفسير ─────────── */
async function archiveSuite() {
    console.log('ز — الأرشيف:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-ml-arch-'));
    const svc = new HospitalMonitorService(path.join(tmpDir, 'hospital-monitor.json'));
    const K = '9000040:140';
    const S = { eventId: '9000040', unitId: 15, runUnitId: 140, unitCode: 'جنوب 10', hospitalName: 'مستشفى ز', journeyStepCode: 'AT_HOSPITAL', southTeam: 'جنوب 10' };

    svc.applySighting(S, t(0), 7);
    svc.applySighting(S, t(4), 7);
    svc.evaluateAlerts({ [K]: { dwellMin: 11, ongoing: true } }, t(11), 7);
    svc.closeEpisode(S, t(12), 7, 'monitoring-lost');

    const snap = new ShiftArchiveSnapshot(null, tmpDir);
    snap.hospitalMonitor = svc;
    snap.hospitalDwellProvider = async () => ({ [K]: { dwellMin: 60, ongoing: true } }); // منتفخ افتراضي
    const sec = await snap._getHospital(7, { id: 7, start_time: t(-30), shift_date: '2026-08-28' });

    check('ز1 اللقطة تختم الرحلة monitoring-lost (episodeClass) لا «مفتوحة»',
        sec.journeys.length === 1 && sec.journeys[0].episodeClass === 'monitoring-lost');
    check('ز2 التنبيه المختوم يحمل التفسير الكامل (monitoring-lost + unreliable)',
        sec.alerts.length === 1 && sec.alerts[0].resolution === 'monitoring-lost' && sec.alerts[0].unreliable === true);
    check('ز3 Timeline المختوم يوثق: مشاهدة ← رفع ← إغلاق MONITORING_LOST ← حلول',
        sec.timeline.some(e => e.field === 'hospitalName') &&
        sec.timeline.some(e => e.field === 'alert' && e.alert === 'raised') &&
        sec.timeline.some(e => e.field === 'episode' && e.step === 'MONITORING_LOST') &&
        sec.timeline.some(e => e.field === 'alert' && e.alert === 'resolved' && e.to === 'monitoring-lost'),
        JSON.stringify(sec.timeline.map(e => e.field + ':' + (e.alert || e.step || ''))));
    check('ز4 ملخص اللقطة: monitoringLost=1 والمنتفخة 60د خارج العدّادات',
        sec.summary.monitoringLost === 1 && sec.summary.exceedances === 0 && sec.summary.avgDwellMin === null);
}

/* ─────────── ي — ثوابت المصدر (فحص نصي) ─────────── */
function sourceSuite() {
    console.log('ي — ثوابت المصدر:');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'hospital-monitor-service.js'), 'utf8');
    const ovl = fs.readFileSync(path.join(__dirname, '..', 'extension', 'cad-overlay-content.js'), 'utf8');

    const m = srv.match(/app\.post\('\/api\/cad-reports\/hospital-sighting'[\s\S]*?\n\}\);/);
    check('ي1 السيرفر يمرر monitoringLost من الـOverlay إلى closeEpisode',
        !!m && /b\.monitoringLost === true \? 'monitoring-lost' : 'back-to-service'/.test(m[0]));
    check('ي2 الـOverlay: detail أخير + monitoringLost=!realEnd في مسار الاختفاء',
        /fetchIncidentDetail\(num\)[\s\S]{0,2500}monitoringLost: !realEnd/.test(ovl));
    check('ي3 الـOverlay: نبضة الحضور (HOSPITAL_BEAT_MS + hospMon.beat)',
        /HOSPITAL_BEAT_MS = 4 \* 60 \* 1000/.test(ovl) && /hospMon\.beat\[key\] = nowMs/.test(ovl));
    check('ي4 ختم نسخة الـOverlay مرقّى (2026-08-29.a)', ovl.includes("'2026-08-29.a"));
    // ي5: الخدمة معزولة تخزينيًا — لا تقرأ قاعدة البيانات ولا تلمس الاحتساب.
    // (يُفحص الكود الفعلي بعد تجريد التعليقات — الترويسة تذكر report_times نهيًا لا استخدامًا)
    const svcCode = svc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const svcReqs = svc.match(/require\('([^']+)'\)/g) || [];
    check('ي5 الخدمة لا تلمس report_times/الاحتساب إطلاقًا (fs/path فقط — بلا SQL ولا تخزين)',
        svcReqs.every(r => r === "require('fs')" || r === "require('path')") &&
        !/report_times|isParticipationCounted|INSERT\s|UPDATE\s|DELETE\s|\.prepare\(|\.run\(|\.all\(|\.get\(/.test(svcCode));
    check('ي6 [1] حارس النشاط داخل evaluateAlerts (at-hospital + FRESH_MS + monitoringLost)',
        /const isActive = \(cur\)/.test(svc) && /FRESH_MS/.test(svc) && /cur\.monitoringLost !== true/.test(svc));
    check('ي7 [7] episodeClass مصدرًا واحدًا للفصل الثلاثي', /episodeClass\(j, nowTs\)/.test(svc));
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'hospital-monitor.js'), 'utf8');
    const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'operations-dashboard.html'), 'utf8');
    check('ي8 الواجهتان تعرضان وسم «انقطع الرصد» للتنبيهات والرحلات',
        ui.includes('انقطع الرصد') && dash.includes('انقطع الرصد') && dash.includes('alert-dwell-corrected'));
}

(async () => {
    console.log('═══ اختبار إصلاح دورة المستشفى الكاملة (معزول) ═══\n');
    regressionSuite();
    disappearanceSuite();
    adminCloseSuite();
    lateSyncSuite();
    productionSimSuite();
    zeroAndDedupeSuite();
    await archiveSuite();
    sourceSuite();
    console.log('\n═══ النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('خطأ فادح:', e); process.exit(1); });
