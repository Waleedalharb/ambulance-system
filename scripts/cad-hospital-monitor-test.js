/**
 * ═══ cad-hospital-monitor-test.js — اختبار Hospital Monitor 1B (معزول) ═══
 * (اعتماد المالك 2026-08-27 — 12 قاعدة): يثبت بلا خادم ولا متصفح:
 *  أ) الخدمة المستقلة: إنشاء/تحديث نفس الرحلة بالهوية الثابتة، history تدقيقي
 *     append-only، null لا يمسح (يُرفض عند الحدود ولا يصل)، dedupe، بلا هوية =
 *     لا حالة، persist/reload، نافذة زمنية، تجميع المنشآت مع زمن البقاء الممرّر
 *  ب) الـOverlay (vm sandbox): استخراج hospitalName من نفس استجابة incident-list
 *     القائمة، إرسال hospital-sighting عند التغيّر فقط، لا رسالة عند null،
 *     لا رسالة بلا هوية ثابتة، وصفر رسائل cad-report بسبب هذا المسار إطلاقًا
 * التشغيل: node scripts/cad-hospital-monitor-test.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HospitalMonitorService } = require('../services/hospital-monitor-service');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ─────────── أ — الخدمة المستقلة ─────────── */
function serviceSuite() {
    console.log('أ — HospitalMonitorService (مخزن مؤقت معزول):');
    const tmp = path.join(os.tmpdir(), 'hm-test-' + Date.now() + '.json');
    const svc = new HospitalMonitorService(tmp);

    const s1 = { eventId: '1318241', unitId: 1467, runUnitId: 2532116, unitCode: 'جنوب 9 - 2', hospitalName: 'مستشفى A', journeyStepCode: 'HANDOVER' };
    const r1 = svc.applySighting(s1, '2026-08-27T15:00:00.000Z');
    check('أ1 مشاهدة أولى ← created والمفتاح eventId:runUnitId', r1.kind === 'created' && r1.changed === true && r1.key === '1318241:2532116');

    const r2 = svc.applySighting(s1, '2026-08-27T15:00:10.000Z');
    check('أ2 نفس القيمة مكررة ← seen بلا تغيير', r2.kind === 'seen' && r2.changed === false);
    check('أ3 التكرار لم يُنمِّ history', svc.historyFor('1318241:2532116').length === 1);

    // قاعدة ⑥: المستشفى A ← B لنفس الرحلة
    const r3 = svc.applySighting({ ...s1, hospitalName: 'مستشفى B' }, '2026-08-27T15:05:00.000Z');
    const cur = svc._load().current['1318241:2532116'];
    const hist = svc.historyFor('1318241:2532116');
    check('أ4 تغيّر المنشأة A←B ← hospital-change لنفس المفتاح (لا حالة جديدة)', r3.kind === 'hospital-change' && cur.hospitalName === 'مستشفى B');
    check('أ5 history يوثق from=A to=B (القيمة السابقة محفوظة)', hist.some(h => h.field === 'hospitalName' && h.from === 'مستشفى A' && h.to === 'مستشفى B'));

    // قاعدة ⑤: الرمز 32←29 (هنا: جنوب 9-2 ← جنوب 9-1) لنفس runUnitId
    const r4 = svc.applySighting({ ...s1, hospitalName: 'مستشفى B', unitCode: 'جنوب 9 - 1' }, '2026-08-27T15:06:00.000Z');
    check('أ6 تغيّر unitCode لنفس الرحلة ← unitcode-change ولا حالة جديدة', r4.kind === 'unitcode-change' && svc._load().current['1318241:2532116'].unitCode === 'جنوب 9 - 1');
    check('أ7 history يوثق انتقال الرمز أيضًا', svc.historyFor('1318241:2532116').some(h => h.field === 'unitCode' && h.from === 'جنوب 9 - 2' && h.to === 'جنوب 9 - 1'));

    // قاعدة ④: unitId احتياطي عند غياب runUnitId
    const r5 = svc.applySighting({ eventId: '1318299', unitId: 1461, runUnitId: null, unitCode: 'جنوب 6 - 2', hospitalName: 'مستشفى A' }, '2026-08-27T15:07:00.000Z');
    check('أ8 بلا runUnitId ← مفتاح احتياطي eventId:u<unitId>', r5.key === '1318299:u1461' && r5.kind === 'created');

    // بلا هوية ثابتة إطلاقًا ← لا حالة
    const r6 = svc.applySighting({ eventId: '1318000', unitId: null, runUnitId: null, unitCode: 'جنوب 1', hospitalName: 'مستشفى X' }, '2026-08-27T15:08:00.000Z');
    check('أ9 بلا هوية ثابتة ← no-identity ولا كتابة', r6.kind === 'no-identity' && !svc._load().current['1318000:']);

    // persist/reload
    const svc2 = new HospitalMonitorService(tmp);
    check('أ10 بعد إعادة التحميل من الملف: الحالة الحالية والتاريخ باقيان',
        svc2._load().current['1318241:2532116'].hospitalName === 'مستشفى B' && svc2.historyFor('1318241:2532116').length >= 3);

    // نافذة زمنية + تجميع (nowTs مثبت صراحة حتى لا تتأثر الفحوص بتوقيت التشغيل)
    const NOW = Date.parse('2026-08-27T15:10:00Z');
    const dwell = {
        '1318241:2532116': { dwellMin: 12.5, ongoing: false },   // تجاوز > 10
        '1318299:u1461': { dwellMin: 6.0, ongoing: true }        // جارٍ
    };
    const sum = svc2.summarize(Date.parse('2026-08-27T14:00:00Z'), null, dwell, NOW);
    const facB = sum.facilities.find(f => f.facility === 'مستشفى B');
    const facA = sum.facilities.find(f => f.facility === 'مستشفى A');
    check('أ11 الإجمالي = رحلتان منقولتان', sum.totalTransferred === 2);
    check('أ12 التجميع بالمنشأة الحالية: B حالة واحدة وA حالة واحدة', !!facB && facB.cases === 1 && !!facA && facA.cases === 1);
    check('أ13 المتوسط والتجاوز من dwell الممرّر فقط: avg=9.3 (12.5+6)/2 وتجاوز=1', sum.avgDwellMin === 9.3 && sum.exceedances === 1);
    check('أ14 ongoing مميّز (رحلة قيد التسليم)', sum.ongoing === 1 && facA.ongoing === 1);

    const sumNone = svc2.summarize(Date.parse('2026-08-27T14:00:00Z'), null, {}, NOW);
    check('أ15 بلا أزمنة ← unmeasured=2 والمتوسط null بصدق (لا اختراع)', sumNone.unmeasured === 2 && sumNone.avgDwellMin === null);

    const sumOld = svc2.summarize(Date.parse('2026-08-28T00:00:00Z'), null, dwell, Date.parse('2026-08-28T01:00:00Z'));
    check('أ16 نافذة لاحقة لكل المشاهدات ← صفر (الفلترة الزمنية تعمل)', sumOld.totalTransferred === 0);

    // ── الفصل الدلالي: حالة حالية ≠ آخر منشأة معروفة (تثبيت المالك قبل النشر) ──
    const rc1 = svc2.closeEpisode({ eventId: '1318299', unitId: 1461, runUnitId: null, unitCode: 'جنوب 6 - 2', journeyStepCode: 'BACK_TO_SERVICE' }, '2026-08-27T15:12:00.000Z');
    const curClosed = svc2._load().current['1318299:u1461'];
    check('أ17 عودة للخدمة ← episode-closed وepisodeState=last-known', rc1.kind === 'episode-closed' && rc1.changed && curClosed.episodeState === 'last-known');
    check('أ18 الإغلاق لا يمسح الاسم — hospitalName محفوظ كآخر منشأة معروفة', curClosed.hospitalName === 'مستشفى A');
    check('أ19 history يوثق انتقال الحالة at-hospital←last-known', svc2.historyFor('1318299:u1461').some(h => h.field === 'episode' && h.from === 'at-hospital' && h.to === 'last-known'));

    const rc2 = svc2.closeEpisode({ eventId: '1318299', unitId: 1461, journeyStepCode: 'BACK_TO_SERVICE' }, '2026-08-27T15:13:00.000Z');
    check('أ20 إغلاق مكرر ← already-closed بلا تضخيم history', rc2.kind === 'already-closed' && rc2.changed === false &&
        svc2.historyFor('1318299:u1461').filter(h => h.field === 'episode').length === 1);

    const rc3 = svc2.closeEpisode({ eventId: '1318777', unitId: 999, journeyStepCode: 'BACK_TO_SERVICE' }, '2026-08-27T15:14:00.000Z');
    check('أ21 إغلاق بلا مشاهدة سابقة ← close-without-episode ولا سجل يُنشأ', rc3.kind === 'close-without-episode' && !svc2._load().current['1318777:u999']);

    // الملخص بعد الإغلاق: A مغلقة (last-known) وB ما زالت حالية
    const sum2 = svc2.summarize(Date.parse('2026-08-27T14:00:00Z'), null, dwell, Date.parse('2026-08-27T15:15:00Z'));
    check('أ22 الفصل في الملخص: حالية=1 (B) وآخر-معروفة=1 (A)', sum2.currentAtHospital === 1 && sum2.lastKnownOnly === 1);
    check('أ23 بقاء جارٍ لحالة مغلقة بلا وقت انتهاء ← لا ongoing ويُحسب unmeasured بصدق', sum2.ongoing === 0 && sum2.unmeasured === 1);

    // رحلة B تغدو قديمة (آخر مشاهدة قبل > 30د) ← ongoing لا يُحسب حتى لو بقيت «حالية»
    const sum3 = svc2.summarize(Date.parse('2026-08-27T14:00:00Z'), null, { '1318241:2532116': { dwellMin: 20, ongoing: true } }, Date.parse('2026-08-27T16:30:00Z'));
    check('أ24 حالة حالية لكن قديمة (>30د بلا مشاهدة) ← لا ongoing (اختفت من القائمة)', sum3.ongoing === 0 && sum3.currentAtHospital === 0 && sum3.lastKnownOnly === 2);

    // إعادة فتح موثقة: CAD أعاد اسماً لنفس الرحلة بعد الإغلاق
    const rr = svc2.applySighting({ eventId: '1318299', unitId: 1461, runUnitId: null, unitCode: 'جنوب 6 - 2', hospitalName: 'مستشفى A', southTeam: 'جنوب 6' }, '2026-08-27T15:20:00.000Z');
    check('أ25 قيمة جديدة بعد الإغلاق ← episode-reopened (Mutable — لا سجل جديد)', rr.kind === 'episode-reopened' && svc2._load().current['1318299:u1461'].episodeState === 'at-hospital');

    try { fs.unlinkSync(tmp); } catch (_) { }
}

/* ─────────── ب — الـOverlay في vm sandbox ─────────── */
const OVERLAY_SRC = path.join(__dirname, 'cad-overlay.js');
const CAD = 'https://cad.example.com';

function elStub() {
    return {
        id: '', style: {}, title: '', textContent: '', innerHTML: '', disabled: false,
        offsetLeft: 0, offsetTop: 0, offsetWidth: 100,
        classList: { toggle() { } }, dataset: {},
        append() { }, appendChild() { }, addEventListener() { }, remove() { },
        setPointerCapture() { }, querySelectorAll() { return []; }
    };
}
function storageMock() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

async function overlaySuite() {
    console.log('\nب — الـOverlay: استخراج وإرسال hospital-sighting (vm):');
    const messages = [];
    const msgListeners = new Set();
    // حمولة incident-list مبنية على بنية العينة الحقيقية الملتقطة 2026-08-27
    let payload = {
        data: {
            last: false, // صفحة جزئية: يمنع autoDiscover — نعزل مسار المشاهدات تمامًا
            items: [
                { id: 1, eventId: 1318241, proQACode: '28C01J', lastJourneys: [
                    { unitId: 1467, runUnitId: 2532116, unitCode: 'جنوب 9 - 2', journeyStepCode: 'HANDOVER', journeyStepDesc: 'انتهاء التسليم', hospitalName: 'DR Sulaiman Al Habib - Al Suwaidi' },
                    { unitId: 1459, runUnitId: 2532113, unitCode: 'جنوب 5 - 2', journeyStepCode: 'TO_HOSPITAL', journeyStepDesc: 'النقل', hospitalName: null } // null = لا قيمة
                ] },
                { id: 2, eventId: 1318299, proQACode: '7B00', lastJourneys: [
                    { unitCode: 'جنوب 6 - 2', journeyStepCode: 'AT_PATIENT', hospitalName: 'مستشفى بلا هوية' } // بلا unitId/runUnitId
                ] },
                { id: 3, eventId: 1318354, proQACode: '10D01', lastJourneys: [
                    { unitId: 1340, runUnitId: 2532253, unitCode: 'وسط 1 - 1', journeyStepCode: 'HANDOVER', hospitalName: 'مستشفى قطاع الوسط' } // خارج نطاق الجنوب
                ] }
            ]
        }
    };
    const windowObj = {
        innerWidth: 1280, innerHeight: 800,
        addEventListener(t, fn) { if (t === 'message') msgListeners.add(fn); },
        removeEventListener(t, fn) { if (t === 'message') msgListeners.delete(fn); },
        postMessage(data) { messages.push(data); },
        fetch: async (url) => ({
            ok: true, url: String(url),
            headers: { get: (k) => /content-type/i.test(k) ? 'application/json; charset=utf-8' : null },
            json: async () => JSON.parse(JSON.stringify(payload)),
            clone() { return { json: async () => JSON.parse(JSON.stringify(payload)) }; }
        })
    };
    const ctx = {
        console,
        window: windowObj,
        document: { getElementById: () => null, createElement: () => elStub(), head: { appendChild() { } }, body: { innerText: '', appendChild() { } } },
        location: { href: CAD + '/list', origin: CAD },
        localStorage: storageMock(), sessionStorage: storageMock(),
        setTimeout: () => 1, clearTimeout: () => { }, setInterval: () => 999, clearInterval: () => { },
        XMLHttpRequest: function () { },
    };
    ctx.XMLHttpRequest.prototype = {};
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(OVERLAY_SRC, 'utf8'), ctx, { filename: 'cad-overlay.js' });
    const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 5)); };
    const LIST_URL = CAD + '/dispatch-manager/api/cfs/v2/response-coordinator/incident-list?page=1';
    const sightings = () => messages.filter(m => m && m.kind === 'hospital-sighting' && !(m.payload && m.payload.episodeClose === true));
    const closes = () => messages.filter(m => m && m.kind === 'hospital-sighting' && m.payload && m.payload.episodeClose === true);

    await ctx.window.fetch(LIST_URL);
    await drain();
    check('ب1 مشاهدة واحدة فقط أُرسلت (null وبلا-هوية وخارج-القطاع لم تُرسل)', sightings().length === 1,
        'sightings=' + sightings().length);
    const p0 = sightings()[0] && sightings()[0].payload;
    check('ب2 الحمولة تحمل الهوية الثابتة والاسم والخطوة (للتتبع فقط)',
        !!p0 && p0.eventId === '1318241' && p0.unitId === '1467' && p0.runUnitId === '2532116' &&
        p0.hospitalName === 'DR Sulaiman Al Habib - Al Suwaidi' && p0.journeyStepCode === 'HANDOVER' && !!p0.observedAt);
    check('ب2ب فلتر القطاع: الحمولة تحمل southTeam=«جنوب 9» (مصدر الحقيقة mapToSouthTeam)', p0 && p0.southTeam === 'جنوب 9');

    await ctx.window.fetch(LIST_URL); // لقطة مكررة بنفس القيم
    await drain();
    check('ب3 لقطة مكررة بنفس القيمة ← لا إرسال جديد (dedupe)', sightings().length === 1);

    // تغيّر اسم المنشأة لنفس الرحلة (Mutable State)
    payload.data.items[0].lastJourneys[0].hospitalName = 'Ali Bin Ali Hospital';
    await ctx.window.fetch(LIST_URL);
    await drain();
    check('ب4 تغيّر المنشأة A←B لنفس runUnitId ← مشاهدة جديدة واحدة', sightings().length === 2 &&
        sightings()[1].payload.hospitalName === 'Ali Bin Ali Hospital' && sightings()[1].payload.runUnitId === '2532116');

    // تغيّر الرمز فقط (32←29) بنفس المنشأة
    payload.data.items[0].lastJourneys[0].unitCode = 'جنوب 9 - 1';
    await ctx.window.fetch(LIST_URL);
    await drain();
    check('ب5 تغيّر unitCode فقط ← يُرسَل (ليحدّث السيرفر الرمز في نفس الرحلة)', sightings().length === 3 &&
        sightings()[2].payload.unitCode === 'جنوب 9 - 1' && sightings()[2].payload.hospitalName === 'Ali Bin Ali Hospital');

    // null بعد قيمة ← لا إرسال (قاعدة ⑦: null لا يمسح — لا يصل أصلًا)
    payload.data.items[0].lastJourneys[0].hospitalName = null;
    await ctx.window.fetch(LIST_URL);
    await drain();
    check('ب6 hospitalName=null بعد قيمة ← لا رسالة إطلاقًا', sightings().length === 3);

    // الفصل الدلالي: عودة للخدمة بلا اسم ← إشارة إغلاق واحدة فقط (الاسم يبقى سيرفريًا)
    payload.data.items[0].lastJourneys[0].journeyStepCode = 'BACK_TO_SERVICE';
    await ctx.window.fetch(LIST_URL);
    await drain();
    check('ب8 BACK_TO_SERVICE + null لمشاهدة قائمة ← episodeClose واحدة', closes().length === 1 &&
        closes()[0].payload.runUnitId === '2532116' && closes()[0].payload.journeyStepCode === 'BACK_TO_SERVICE');
    await ctx.window.fetch(LIST_URL);
    await drain();
    check('ب9 تكرار عودة الخدمة ← لا إشارة إغلاق ثانية (dedupe)', closes().length === 1);

    // قيمة جديدة بعد الإغلاق ← تُرسل (السيرفر يعيد فتح الحالة موثقًا)
    payload.data.items[0].lastJourneys[0].journeyStepCode = 'HANDOVER';
    payload.data.items[0].lastJourneys[0].hospitalName = 'Ali Bin Ali Hospital';
    await ctx.window.fetch(LIST_URL);
    await drain();
    check('ب10 اسم بعد الإغلاق ← مشاهدة جديدة (إعادة فتح موثقة سيرفريًا)', sightings().length === 4);

    check('ب7 لا أثر جانبي: صفر رسائل cad-report/cad-stats بسبب هذا المسار',
        messages.filter(m => m && (m.kind === 'cad-report' || m.kind === 'cad-stats')).length === 0,
        'kinds=' + messages.map(m => m && m.kind).join(','));
}

(async () => {
    console.log('🧪 اختبار Hospital Monitor 1B — معزول بلا خادم ولا متصفح\n');
    serviceSuite();
    await overlaySuite();
    console.log('\n══════════════════════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:\n - ' + failures.join('\n - ')); process.exit(1); }
    console.log('★ 1B: معرفة المنشأة فقط — بلا استنتاج وصول، وبلا مساس بأي احتساب قائم');
})();
