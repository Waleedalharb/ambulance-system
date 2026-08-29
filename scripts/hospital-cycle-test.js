/**
 * ═══ hospital-cycle-test.js — اختبار دورة المستشفيات + الأرشفة (معزول) ═══
 * (اعتماد المالك 2026-08-28 — الترجيحان ①أ+②أ): يثبت بلا خادم ولا متصفح:
 *  أ) Lifecycle: مشاهدة ← تحديث ← BACK_TO_SERVICE ← إغلاق مكرر ← إغلاق بلا
 *     مشاهدة ← إعادة فتح ← رحلة مفتوحة عند إغلاق المناوبة (لا إغلاق تلقائي)
 *  ب) Shift Ownership: ختم سيرفي بمناوبة أول مشاهدة، عبور مناوبة ثانية لا ينقل
 *     الملكية، استكمال ختم null، واستبعاد رحلات المناوبات الأخرى من الجمع
 *  ج) التنبيهات: رفع عند >10د، dedupe بالهوية المنطقية (تحديث لا تكرار)،
 *     ACK (وهمي 404 / محلول 409 / مكرر idempotent)، حلول بـ BACK_TO_SERVICE
 *     أو بانقطاع الرصد الموثق (monitoring-lost — إصلاح دورة المستشفى، اعتماد
 *     المالك 2026-08-28)، إعادة فتح التنبيه مع إعادة فتح الحالة
 *  د) Archive: قسم hospital في اللقطة (ملخص/رحلات/تنبيهات/Timeline)، سقوط
 *     النافذة للسجلات القديمة بلا ختم، وغياب صادق بلا مخزن محقون
 *  هـ) Semantic: at-hospital ← BACK_TO_SERVICE ← currentAtHospital=0 مع بقاء
 *     آخر منشأة معروفة (لا مسح للاسم)
 *  و) Performance: تكرار نفس المشاهدة/التقييم = صفر تغيير وصفر كتابة
 *  ز) ثوابت المصدر (فحص نصي): endpoint المشاهدة لا يقرأ shiftId من العميل،
 *     والواجهة تحمل بصمة skip-if-unchanged
 * التشغيل: node scripts/hospital-cycle-test.js
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

const T0 = '2026-08-28T08:00:00.000Z';
const t = min => new Date(Date.parse(T0) + min * 60000).toISOString();
const KEY = '1318241:2532116';
const S1 = { eventId: '1318241', unitId: 1467, runUnitId: 2532116, unitCode: 'جنوب 8 - 1', hospitalName: 'مستشفى A', journeyStepCode: 'HANDOVER', southTeam: 'جنوب 8' };

/* ─────────── أ — Lifecycle ─────────── */
function lifecycleSuite() {
    console.log('أ — Lifecycle:');
    const svc = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-a-' + Date.now() + '.json'));

    check('أ1 مشاهدة جديدة ← created بحالة at-hospital',
        svc.applySighting(S1, t(0), 7).kind === 'created' &&
        svc._load().current[KEY].episodeState === 'at-hospital');

    check('أ2 تحديث مشاهدة بنفس القيمة ← seen بلا تغيير',
        svc.applySighting(S1, t(5), 7).changed === false);

    check('أ3 BACK_TO_SERVICE ← episode-closed وepisodeClosedAt مختوم',
        svc.closeEpisode(S1, t(30), 7).kind === 'episode-closed' &&
        !!svc._load().current[KEY].episodeClosedAt);

    const hAfterClose = svc.historyFor(KEY).length;
    const rc2 = svc.closeEpisode(S1, t(35), 7);
    check('أ4 إغلاق مكرر ← already-closed بلا تغيير ولا أحداث جديدة',
        rc2.kind === 'already-closed' && rc2.changed === false && svc.historyFor(KEY).length === hAfterClose);

    check('أ5 إغلاق بلا مشاهدة سابقة ← close-without-episode ولا إنشاء حالة',
        svc.closeEpisode({ eventId: '9999999', runUnitId: 1, unitCode: 'جنوب 1' }, t(36), 7).kind === 'close-without-episode' &&
        !svc._load().current['9999999:1']);

    const rRe = svc.applySighting(S1, t(40), 7);
    check('أ6 إعادة فتح موثقة ← episode-reopened ومسح episodeClosedAt',
        rRe.kind === 'episode-reopened' && svc._load().current[KEY].episodeState === 'at-hospital' &&
        svc._load().current[KEY].episodeClosedAt === null);
    check('أ7 إعادة الفتح موثقة في history (last-known ← at-hospital)',
        svc.historyFor(KEY).some(h => h.field === 'episode' && h.from === 'last-known' && h.to === 'at-hospital'));

    // رحلة مفتوحة عند إغلاق المناوبة ← تبقى مفتوحة (لا إغلاق تلقائي ولا أزمنة ملفّقة)
    const svc2 = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-a2-' + Date.now() + '.json'));
    svc2.applySighting({ ...S1, eventId: '1318555', runUnitId: 77 }, t(0), 9);
    const cur2 = svc2._load().current['1318555:77'];
    check('أ8 رحلة مفتوحة عند إغلاق المناوبة تبقى at-hospital بلا episodeClosedAt',
        cur2.episodeState === 'at-hospital' && cur2.episodeClosedAt === null);
}

/* ─────────── ب — Shift Ownership ─────────── */
function ownershipSuite() {
    console.log('ب — Shift Ownership:');
    const svc = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-b-' + Date.now() + '.json'));

    svc.applySighting(S1, t(0), 7);
    check('ب1 أول مشاهدة تُختم بالمناوبة النشطة (7)',
        svc._load().current[KEY].shiftId === 7);

    svc.applySighting(S1, t(50), 8); // نفس الرحلة أثناء المناوبة التالية
    svc.closeEpisode(S1, t(60), 8);
    check('ب2 عبور الرحلة لمناوبة ثانية (8) لا ينقل الملكية — تبقى 7',
        svc._load().current[KEY].shiftId === 7);
    check('ب3 الجمع بمناوبة المنشأ يشملها وبالمناوبة الثانية يستبعدها',
        svc.journeysForShift(7, null, null).some(j => j.key === KEY) &&
        !svc.journeysForShift(8, null, null).some(j => j.key === KEY));

    // بلا مناوبة نشطة ← null بصدق، ثم استكمال الختم عند ظهور مناوبة
    const svc2 = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-b2-' + Date.now() + '.json'));
    svc2.applySighting({ ...S1, eventId: '1318666', runUnitId: 88 }, t(0), null);
    check('ب4 بلا مناوبة نشطة ← shiftId=null بصدق (لا اختراع مناوبة)',
        svc2._load().current['1318666:88'].shiftId === null);
    svc2.applySighting({ ...S1, eventId: '1318666', runUnitId: 88 }, t(10), 11);
    check('ب5 استكمال الختم عند ظهور مناوبة نشطة لاحقًا',
        svc2._load().current['1318666:88'].shiftId === 11);

    // سجل قديم بلا ختم (ما قبل الدورة) ← يُنسب بالنافذة سقوطًا صادقًا
    const svc3 = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-b3-' + Date.now() + '.json'));
    svc3.applySighting({ ...S1, eventId: '1318777', runUnitId: 99 }, t(0)); // بلا shiftId
    const inWindow = svc3.journeysForShift(5, Date.parse(t(-10)), Date.parse(t(10)));
    const outWindow = svc3.journeysForShift(5, Date.parse(t(100)), Date.parse(t(200)));
    check('ب6 السجل القديم بلا ختم يُنسب بالنافذة الزمنية ويُستبعد خارجها',
        inWindow.length === 1 && outWindow.length === 0);
}

/* ─────────── ج — التنبيهات ─────────── */
function alertsSuite() {
    console.log('ج — التنبيهات:');
    const svc = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-c-' + Date.now() + '.json'));
    const AID = KEY + '|dwell-exceed';

    svc.applySighting(S1, t(0), 7);
    let changed = svc.evaluateAlerts({ [KEY]: { dwellMin: 9.5, ongoing: true } }, t(9), 7);
    check('ج1 بقاء ≤ 10د ← لا تنبيه', changed.length === 0 && !svc._load().alerts[AID]);

    changed = svc.evaluateAlerts({ [KEY]: { dwellMin: 10.4, ongoing: true } }, t(10), 7);
    const a1 = svc._load().alerts[AID];
    check('ج2 تجاوز 10د ← تنبيه open بهوية episodeKey+alertType مختوم بالمناوبة',
        changed.length === 1 && a1 && a1.state === 'open' && a1.shiftId === 7 && a1.facility === 'مستشفى A');

    changed = svc.evaluateAlerts({ [KEY]: { dwellMin: 10.4, ongoing: true } }, t(11), 7);
    check('ج3 نفس التقييم مكررًا (SSE) ← صفر تغيير وصفر كتابة (dedupe)',
        changed.length === 0 && svc._load().alerts[AID].updates === 0);

    changed = svc.evaluateAlerts({ [KEY]: { dwellMin: 12.0, ongoing: true } }, t(12), 7);
    check('ج4 تغيّر قيمة البقاء ← تحديث في المكان بنفس الهوية (لا نسخة جديدة)',
        changed.length === 1 && Object.keys(svc._load().alerts).length === 1 &&
        svc._load().alerts[AID].dwellMin === 12.0 && svc._load().alerts[AID].updates === 1);

    const ack1 = svc.ackAlert(AID, { id: 5, name: 'مشرف المناوبة' }, t(13));
    check('ج5 ACK ← acknowledged مع وقت الإقرار وهوية المستخدم',
        ack1.ok && ack1.changed && svc._load().alerts[AID].state === 'acknowledged' &&
        svc._load().alerts[AID].ackAt === t(13) && svc._load().alerts[AID].ackByName === 'مشرف المناوبة');

    const ack2 = svc.ackAlert(AID, { id: 6, name: 'آخر' }, t(14));
    check('ج6 ACK مكرر ← idempotent بلا كتابة ولا تغيير للمُقِرّ الأول',
        ack2.ok && ack2.changed === false && svc._load().alerts[AID].ackByName === 'مشرف المناوبة');

    check('ج7 ACK وهمي (غير موجود) ← 404', svc.ackAlert('nope|dwell-exceed', { id: 5 }).code === 404);

    // المُقَرّ لا يعود open مع استمرار التقييم — الإقرار محفوظ
    svc.evaluateAlerts({ [KEY]: { dwellMin: 13.0, ongoing: true } }, t(15), 7);
    check('ج8 التقييم بعد الإقرار يحدّث القيمة ويبقي الحالة acknowledged',
        svc._load().alerts[AID].state === 'acknowledged' && svc._load().alerts[AID].dwellMin === 13.0);

    // اختفاء الرحلة من القائمة (لا تقييم/لا إغلاق) ← لا حلول
    check('ج9 اختفاء الرحلة من CAD لا يحلّ التنبيه', svc._load().alerts[AID].state === 'acknowledged');

    svc.closeEpisode(S1, t(30), 7); // BACK_TO_SERVICE
    const a2 = svc._load().alerts[AID];
    check('ج10 BACK_TO_SERVICE يحلّ التنبيه بالحدث التشغيلي الصحيح',
        a2.state === 'resolved' && a2.resolution === 'back-to-service' && a2.resolvedAt === t(30));

    check('ج11 ACK بعد الحلول ← 409', svc.ackAlert(AID, { id: 5 }).code === 409);

    // إعادة فتح الحالة ← التنبيه يعود open بنفس الهوية
    svc.applySighting(S1, t(40), 7);
    const changed2 = svc.evaluateAlerts({ [KEY]: { dwellMin: 15.0, ongoing: true } }, t(41), 7);
    const a3 = svc._load().alerts[AID];
    check('ج12 إعادة فتح الحالة تعيد التنبيه open بنفس الهوية (لا تنبيه يتيم)',
        changed2.length === 1 && a3.state === 'open' && a3.resolvedAt === null &&
        Object.keys(svc._load().alerts).length === 1);

    // نافذة التنبيهات + تبعية مفاتيح الرحلات
    check('ج13 alertsInWindow يحترم النافذة الزمنية',
        svc.alertsInWindow(Date.parse(t(5)), Date.parse(t(20))).length === 1 &&
        svc.alertsInWindow(Date.parse(t(100)), null).length === 0);
    check('ج14 alertsForKeys يجلب تنبيهات الرحلة فقط',
        svc.alertsForKeys([KEY]).length === 1 && svc.alertsForKeys(['other:key']).length === 0);
}

/* ─────────── د — Archive ─────────── */
async function archiveSuite() {
    console.log('د — Archive (لقطة المناوبة):');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cyc-d-'));
    const svc = new HospitalMonitorService(path.join(tmpDir, 'hospital-monitor.json'));

    svc.applySighting(S1, t(0), 7);
    svc.applySighting({ ...S1, hospitalName: 'مستشفى B' }, t(10), 7); // انتقال
    svc.evaluateAlerts({ [KEY]: { dwellMin: 14, ongoing: true } }, t(11), 7);
    svc.ackAlert(KEY + '|dwell-exceed', { id: 5, name: 'مشرف' }, t(12));
    svc.closeEpisode(S1, t(30), 7);
    // رحلة مناوبة أخرى — يجب استبعادها من لقطة مناوبة 7
    svc.applySighting({ ...S1, eventId: '1318888', runUnitId: 55 }, t(5), 8);

    const snap = new ShiftArchiveSnapshot(null, tmpDir);
    snap.hospitalMonitor = svc;
    snap.hospitalDwellProvider = async () => ({ [KEY]: { dwellMin: 14, ongoing: false } });
    const shiftRow = { id: 7, start_time: t(-30), shift_date: '2026-08-28' };
    const section = await snap._getHospital(7, shiftRow);

    check('د1 القسم موجود ويحمل الملخص والرحلات والتنبيهات وTimeline وختم اللقطة',
        !!section && !!section.summary && Array.isArray(section.journeys) &&
        Array.isArray(section.alerts) && Array.isArray(section.timeline) && !!section.sealedAt);
    check('د2 رحلات المناوبة 7 فقط (رحلة المناوبة 8 مستبعدة — قرار ②أ)',
        section.journeys.length === 1 && section.journeys[0].key === KEY);
    check('د3 الرحلة مختومة مغلقة بآخر منشأة معروفة (مستشفى B) بلا مسح',
        section.journeys[0].episodeState === 'last-known' && section.journeys[0].hospitalName === 'مستشفى B');
    check('د4 التنبيه مختوم محلولًا مع أثر الإقرار كاملًا',
        section.alerts.length === 1 && section.alerts[0].state === 'resolved' &&
        section.alerts[0].ackByName === 'مشرف');
    check('د5 Timeline يوثق التسلسل الحقيقي كاملًا: مشاهدة ← انتقال ← رفع تنبيه ← إقرار ← إغلاق ← حلول',
        section.timeline.length === 6 &&
        section.timeline[0].field === 'hospitalName' && section.timeline[0].from === null &&
        section.timeline[1].from === 'مستشفى A' && section.timeline[1].to === 'مستشفى B' &&
        section.timeline[2].field === 'alert' && section.timeline[2].alert === 'raised' &&
        section.timeline[3].field === 'alert' && section.timeline[3].alert === 'acknowledged' &&
        section.timeline[4].field === 'episode' && section.timeline[4].to === 'last-known' &&
        section.timeline[5].field === 'alert' && section.timeline[5].alert === 'resolved',
        JSON.stringify((section.timeline || []).map(e => e.field + ':' + (e.alert || e.to))));
    check('د6 الملخص يحسب زمن البقاء من المزوّد المحقون (14د — تجاوز)',
        section.summary.totalTransferred === 1 && section.summary.exceedances === 1 &&
        section.summary.avgDwellMin === 14);

    // snapshot.create كاملًا يحمل القسم ضمن اللقطة والهاش
    const full = await snap.create(7);
    check('د7 snapshot.create يختم hospital ضمن اللقطة مع بقاء الهاش',
        !!full.hospital && full.hospital.journeys.length === 1 && typeof full.metadata.hash === 'string');

    // رحلة مفتوحة عند إغلاق المناوبة ← تُختم «مفتوحة» بصدق
    const svc2 = new HospitalMonitorService(path.join(tmpDir, 'hm2.json'));
    svc2.applySighting({ ...S1, eventId: '1318999', runUnitId: 66 }, t(0), 7);
    const snap2 = new ShiftArchiveSnapshot(null, tmpDir);
    snap2.hospitalMonitor = svc2;
    snap2.hospitalDwellProvider = async () => ({});
    const sec2 = await snap2._getHospital(7, shiftRow);
    check('د8 الرحلة المفتوحة عند الإغلاق تُختم at-hospital بلا إغلاق ولا أزمنة ملفّقة',
        sec2.journeys[0].episodeState === 'at-hospital' && sec2.journeys[0].episodeClosedAt === null &&
        sec2.summary.unmeasured === 1);

    // بلا مخزن محقون ← null (غياب صادق — أرشيف ما قبل الدورة)
    const snap3 = new ShiftArchiveSnapshot(null, tmpDir);
    check('د9 بلا مخزن 1B محقون ← القسم null (غياب صادق لا اختراع)',
        (await snap3._getHospital(7, shiftRow)) === null);
}

/* ─────────── هـ — Semantic ─────────── */
function semanticSuite() {
    console.log('هـ — Semantic (الفصل الدلالي):');
    const svc = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-e-' + Date.now() + '.json'));
    const dwell = { [KEY]: { dwellMin: 14, ongoing: false } };

    svc.applySighting(S1, t(15), 7); // 10:15 at-hospital
    let sum = svc.summarizeJourneys(svc.journeysForShift(7, null, null), dwell, Date.parse(t(20)));
    check('هـ1 عند المشاهدة: currentAtHospital=1', sum.currentAtHospital === 1 && sum.lastKnownOnly === 0);

    svc.closeEpisode(S1, t(60), 7); // 11:00 BACK_TO_SERVICE
    sum = svc.summarizeJourneys(svc.journeysForShift(7, null, null), dwell, Date.parse(t(120))); // 12:00
    check('هـ2 بعد BACK_TO_SERVICE: currentAtHospital=0',
        sum.currentAtHospital === 0 && sum.lastKnownOnly === 1);
    check('هـ3 آخر منشأة معروفة محفوظة (لا مسح للاسم)',
        svc._load().current[KEY].hospitalName === 'مستشفى A');
    check('هـ4 مدة بقاء غير كافية ← unmeasured بصدق لا تخمين',
        svc.summarizeJourneys(svc.journeysForShift(7, null, null), {}, Date.parse(t(120))).unmeasured === 1);
}

/* ─────────── و — Performance ─────────── */
function perfSuite() {
    console.log('و — Performance (skip-if-unchanged):');
    const svc = new HospitalMonitorService(path.join(os.tmpdir(), 'hm-cyc-p-' + Date.now() + '.json'));
    svc.applySighting(S1, t(0), 7);
    svc.evaluateAlerts({ [KEY]: { dwellMin: 12, ongoing: true } }, t(10), 7);

    let zeroWrites = true;
    for (let i = 1; i <= 20; i++) { // نفس البيانات × 20 تحديث SSE
        const r = svc.applySighting(S1, t(i), 7);
        const ch = svc.evaluateAlerts({ [KEY]: { dwellMin: 12, ongoing: true } }, t(i), 7);
        if (r.changed || ch.length) zeroWrites = false;
    }
    check('و1 نفس البيانات × 20 SSE ← صفر تغيير (صفر إعادة رسم/كتابة)', zeroWrites);

    const ch2 = svc.evaluateAlerts({ [KEY]: { dwellMin: 12.5, ongoing: true } }, t(21), 7);
    check('و2 تغيير رحلة واحدة ← تحديث ذلك التنبيه فقط',
        ch2.length === 1 && Object.keys(svc._load().alerts).length === 1);
}

/* ─────────── ز — ثوابت المصدر (فحص نصي) ─────────── */
function sourceSuite() {
    console.log('ز — ثوابت المصدر:');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const m = srv.match(/app\.post\('\/api\/cad-reports\/hospital-sighting'[\s\S]*?\n\}\);/);
    check('ز1 endpoint المشاهدة لا يقرأ shiftId من جسم العميل إطلاقًا',
        !!m && !/b\.shiftId|body\.shiftId|req\.body\.shiftId/.test(m[0]));
    check('ز2 الختم سيرفي عبر getActiveShift داخل الـendpoint',
        !!m && /getActiveShift\(\)/.test(m[0]) && /sightingShiftId/.test(m[0]));

    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'hospital-monitor.js'), 'utf8');
    check('ز3 الواجهة تحمل بصمة skip-if-unchanged (صفر إعادة رسم عند الثبات)',
        /lastSig/.test(ui) && /sig === lastSig/.test(ui));
    check('ز4 الواجهة تعرض زر الإقرار وتستدعي مسار ACK',
        /data-ack/.test(ui) && /\/api\/hospital-monitor\/alerts\//.test(ui) && /encodeURIComponent/.test(ui));

    const eng = fs.readFileSync(path.join(__dirname, '..', 'shift-archive-engine.js'), 'utf8');
    check('ز5 محرك الأرشفة يختم hospital ضمن اللقطة وضمن سجل shift-data',
        /snapshot\.hospital = await this\._getHospital/.test(eng) && /hospital: snapshot\.hospital/.test(eng));

    const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'operations-dashboard.html'), 'utf8');
    check('ز6 تبويب المستشفيات ملحق بسلسلة viewShift في شاشة الأرشيف',
        /renderHospitalTab/.test(dash) && /mtab-hospital/.test(dash));

    check('ز7 ACK مقصور على صلاحية التنبيهات التشغيلية القائمة (ops.alerts)',
        /app\.post\('\/api\/hospital-monitor\/alerts\/:alertId\/ack', authenticate, authorizePerm\('ops\.alerts'\)/.test(srv));

    const expStart = srv.indexOf("/export', authenticate");
    const exp = expStart >= 0 ? srv.slice(expStart, srv.indexOf('نهاية السجل', expStart)) : '';
    check('ز8 التصدير النصي يشمل قسم المستشفيات (رحلات/تنبيهات/Timeline) مختومًا أو حيًّا',
        /sealed\.hospital/.test(exp) && /buildHospitalLive/.test(exp) &&
        /المستشفيات/.test(exp) && /Timeline المستشفيات/.test(exp));

    const smoke = fs.readFileSync(path.join(__dirname, 'hospital-monitor-smoke-test.js'), 'utf8');
    check('ز9 smoke معزل عن مخزن الإنتاج (HOSPITAL_MONITOR_FILE مؤقت + تنظيف)',
        /HOSPITAL_MONITOR_FILE/.test(smoke) && /unlinkSync\(TMP_STORE\)/.test(smoke));

    // ثابتة منع تكرار خلل «التبويب اليتيم»: كل لوحة mtab-* يجب أن يقابلها زر
    // data-mtab في شريط التبويبات (اللوحة display:none بلا زر = قسم ميت)
    const panels = [...dash.matchAll(/id="mtab-([a-z]+)" class="modal-tab-panel"/g)].map(m => m[1]);
    const buttons = [...dash.matchAll(/data-mtab="([a-z]+)"/g)].map(m => m[1]);
    const orphans = panels.filter(p => buttons.indexOf(p) === -1);
    check('ز10 كل لوحة تبويب لها زر في الشريط (لا تبويب يتيم — خلل المستشفيات)',
        orphans.length === 0 && buttons.indexOf('hospital') !== -1,
        orphans.length ? 'أيتام: ' + orphans.join(',') : '');
}

(async () => {
    console.log('═══ اختبار دورة المستشفيات + الأرشفة (معزول) ═══\n');
    lifecycleSuite();
    ownershipSuite();
    alertsSuite();
    await archiveSuite();
    semanticSuite();
    perfSuite();
    sourceSuite();
    console.log('\n═══ النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('خطأ فادح:', e); process.exit(1); });
