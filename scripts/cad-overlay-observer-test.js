/**
 * ═══ اختبار Incident Observer للـCAD Overlay — cad-overlay-observer-test.js ═══
 * (اعتماد المالك 2026-08-24 — جولة Observer): يثبت أن الـOverlay أصبح Observer
 * يعمل لحاله بلا أي تدخل من المستخدم. السيناريو المحاكى حرفيًا بطلب المالك:
 *   فتح البلاغ → لا Journey في اللحظة الأولى → تظهر Journey → تتغير حالة الوحدة
 *   → يتغير وقت مرحلة → تختفي وحدة — وكل تغيير يُلتقط تلقائيًا.
 * البيئة: vm sandbox يحاكي DOM/fetch/postMessage — لا متصفح ولا خادم.
 * القواعد المثبتة: لا نسخ أوقات بين الفرق (من لا Journey له phases فارغة) ·
 * بصمة التغيير (نفس البيانات = لا إرسال) · اختفاء وحدة ≠ إلغاء (لا استنتاج) ·
 * إعادة فتح/إعادة حقن الصفحة لا تنشئ تسجيلًا ثانيًا.
 * التشغيل: node scripts/cad-overlay-observer-test.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const OVERLAY_SRC = path.join(__dirname, 'cad-overlay.js');
const CAD = 'https://cad.example.com';
const INC = '7001';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// ─── حمولة detail المتغيرة عبر السيناريو (نفس بنية event-dispatched/detail) ───
const unitA = { unitCode: 'جنوب 6', unitRequestStatus: 'A', journeys: [], unitId: 61, runUnitId: 6101 };
const unitB = { unitCode: 'سريع 1', unitRequestStatus: 'A', journeys: [], unitId: 62, runUnitId: 6201 };
let detailUnits = [unitA, unitB];
const detailPayload = () => ({ data: { id: Number(INC), units: detailUnits, createdDate: '2026-08-24T08:00:00Z', address: 'حي الروضة', zoneName: 'الجنوب' } });

// ─── محاكاة المتصفح ───
const messages = [];       // كل ما أرسله الـOverlay للجسر (postMessage)
const msgListeners = new Set();
const fakeTimers = [];     // setTimeout الملتقطة (لا تعمل تلقائيًا)
let timerSeq = 0;
let detailFetches = 0;     // عدّاد القراءات النشطة لتفاصيل البلاغ (Observer)

function elStub() {
    return {
        id: '', style: {}, title: '', textContent: '', innerHTML: '', disabled: false,
        offsetLeft: 0, offsetTop: 0, offsetWidth: 100,
        classList: { toggle() { } }, dataset: {},
        append() { }, appendChild() { }, addEventListener() { }, remove() { },
        setPointerCapture() { }, querySelectorAll() { return []; }
    };
}
const bodyEl = { innerText: '', appendChild() { } };

function storageMock() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

const locationObj = { href: CAD + '/list', origin: CAD };

const windowObj = {
    innerWidth: 1280, innerHeight: 800,
    addEventListener(type, fn) { if (type === 'message') msgListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') msgListeners.delete(fn); },
    postMessage(data) {
        messages.push(data);
        // الجسر يجيب فورًا (مؤقت حقيقي من المضيف — خارج سيطرة الـOverlay)
        setTimeout(() => {
            const resp = data.kind === 'cad-report'
                ? { success: true, created: false, addedCrews: [], skippedCrews: [], withdrawnCrews: [] }
                : data.kind === 'cad-stats'
                    ? { success: true, total: 0, byType: {}, byCrew: {} }
                    : { success: false };
            const evt = { data: { source: 'south-ext-bridge', reqId: data.reqId, status: 200, data: resp } };
            for (const fn of Array.from(msgListeners)) { try { fn(evt); } catch (_) { } }
        }, 0);
    },
    fetch: async (url) => {
        const u = String(url);
        if (/event-dispatched\/detail/.test(u)) detailFetches++;
        let payload = { data: {} };
        if (/event-dispatched\/detail/.test(u)) payload = detailPayload();
        const res = { ok: true, url: u, json: async () => payload, clone: () => ({ json: async () => payload }) };
        return res;
    }
};

const ctx = {
    console,
    window: windowObj,
    document: {
        getElementById: () => null,
        createElement: () => elStub(),
        head: { appendChild() { } },
        body: bodyEl
    },
    location: locationObj,
    localStorage: storageMock(),
    sessionStorage: storageMock(),
    setTimeout: (fn, ms) => { const id = ++timerSeq; fakeTimers.push({ id, fn, ms: ms || 0, cleared: false }); return id; },
    clearTimeout: (id) => { const t = fakeTimers.find(t => t.id === id); if (t) t.cleared = true; },
    setInterval: () => 999, clearInterval: () => { },
    XMLHttpRequest: function () { },
};
ctx.XMLHttpRequest.prototype = {};
ctx.window = Object.assign(windowObj, { }); // window === مرجع مستقل
ctx.globalThis = ctx;
vm.createContext(ctx);

const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 5)); };
const cadReportMsgs = () => messages.filter(m => m.kind === 'cad-report' && m.payload && m.payload.number === INC);
const lifeEvents = (kind) => (ctx.window.__southLife ? ctx.window.__southLife.events : []).filter(e => e.kind === kind);

function loadOverlay() {
    vm.runInContext(fs.readFileSync(OVERLAY_SRC, 'utf8'), ctx, { filename: 'cad-overlay.js' });
}

// لقطة قائمة CAD مكتملة تحتوي البلاغ (تصفير الغياب + الاكتشاف)
function listSnapshot() {
    ctx.window.__southHandleCadResponse(CAD + '/dispatch-manager/api/cfs/v2/operation-controller/incident-list?page=1', {
        data: { last: true, items: [{ eventId: Number(INC), proQACode: '30A01', lastJourneys: detailUnits.map(u => ({ unitCode: u.unitCode, journeyStepCode: 'ACCEPTANCE' })) }] }
    });
}
// دورة مراقبة واحدة كاملة: Observer ينشط ثم مسار الإرسال الواحد — بلا أي تدخل مستخدم
async function cycle() {
    await ctx.window.__southObsTick(); await drain();
    await ctx.window.__southWatchTick(); await drain();
}

(async () => {
    console.log('🧪 اختبار Incident Observer — vm sandbox بلا متصفح\n');
    loadOverlay();
    check('T0 الـOverlay انحقن وختم البناء الجديد ظاهر', /2026-08-27\.d/.test(ctx.window.__southBuild || ''));

    // ─── التسجيل التلقائي من لقطة القائمة (البلاغ بلا Journey بعد) ───
    listSnapshot(); await drain(); await drain();
    const m0 = cadReportMsgs();
    // لا Journey = لا مشاركة (اعتماد المالك 2026-08-26): البلاغ يُسجَّل بلا فرق —
    // الظهور في lastJourneys لم يعد ينشئ مشاركة وهمية {team, phases:{}}
    check('A اكتُشف البلاغ وسُجّل تلقائيًا من القائمة بلا فرق (لا Journey بعد = لا مشاركة)', m0.length === 1 && m0[0].payload.crews.length === 0);
    check('E لا طاقم عارٍ {team, phases:{}} في أي رسالة إطلاقًا (القاعدة الجذرية ضد الـphantom)',
        m0.length === 1 && cadReportMsgs().every(m => (m.payload.crews || []).every(c => Object.keys(c.phases || {}).length > 0 || !!c.cadUrs || c.cadReached === true)));

    // ─── فتح صفحة البلاغ — الـObserver يبدأ تلقائيًا ───
    locationObj.href = CAD + '/incidents/' + INC;
    bodyEl.innerText = 'العلاج\n11:20:56 AM\n'; // وقت ظاهر في الصفحة وغائب عن journeys — لكشف obs-gap
    const fetchesBeforeOpen = detailFetches;
    await cycle();
    check('Observer قرأ التفاصيل نشطًا فور فتح الصفحة (fetch جديد بلا فتح قسم الأوقات)', detailFetches > fetchesBeforeOpen);
    check('units البلاغ محدثة في مخزن الوحدات بعد دورة الـObserver', lifeEvents('units').some(e => e.incident === INC));
    check('obs-gap: وقت في الصفحة بلا Journey سُجّل دليلًا صادقًا (تحقق برمجي)', lifeEvents('obs-gap').some(e => e.incident === INC));
    // ─── No Journey = No Participation (اعتماد المالك 2026-08-24 — التصحيح الدلالي) ───
    // الوحدات في الحمولة بلا journeys = «الوحدات المتاحة» في نافذة خطة الاستجابة:
    // اقتراحات CAD للمشغل وليست مشاركة — تُتجاهل وتُوثَّق، ولا تدخل المخزن إطلاقًا
    const av1 = lifeEvents('available-ignored').filter(e => e.incident === INC);
    check('V1 وحدات بلا Journey ← «available-ignored» موثقة (اقتراحات الخطة ليست مشاركة)',
        av1.length > 0 && av1[av1.length - 1].units.length === 2);
    const storeNow = (ctx.window.__southUnits[INC] && ctx.window.__southUnits[INC].units) || [];
    check('V2 صفر مشاركة من detail: مخزن الوحدات فارغ رغم ظهور الوحدتين في الحمولة', storeNow.length === 0);
    let msgs = cadReportMsgs();
    // إثراء أزمنة الصفحة على مستوى البلاغ سلوك معتمد (مراقبة سلبية) — المحظور هو
    // ترقية «الفرق» من وحدات بلا Journey: لا cadUrs ولا phases ولا reached من detail
    const lastV3 = msgs[msgs.length - 1];
    check('V3 Available Units + لا Journey ← لا مشاركة ولا إنجاز ولا توقيت للفرق من detail',
        lastV3.payload.crews.every(c => !c.cadUrs && !c.cadReached && Object.keys(c.phases || {}).length === 0));
    const lastT1 = msgs[msgs.length - 1];
    check('E بعد فتح الصفحة: أوقات الصفحة المشتركة لم تُنسخ لأي فرقة (قاعدة جذرية)',
        msgs.every(m => m.payload.crews.every(c => Object.keys(c.phases || {}).length === 0)));

    // ─── T2: تظهر Journey بعد ~10 ثوانٍ (قبول بوقت فعلي) — عندها فقط تصبح الوحدة مشاركة ───
    bodyEl.innerText = '';
    unitA.journeys = [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-08-24T08:07:08Z', stepSeq: 1 }];
    await cycle();
    msgs = cadReportMsgs();
    const t2 = msgs[msgs.length - 1];
    const crewA2 = t2.payload.crews.find(c => c.team === 'جنوب 6');
    const crewB2 = t2.payload.crews.find(c => c.team === 'سريع 1');
    check('D ظهور Journey جديدة لوحدة بعد فتح البلاغ ← اُكتشفت وأُرسلت تلقائيًا', msgs.length >= 2 && crewA2 && crewA2.phases['قبول'] === '11:07:08 AM');
    check('D+ phasesSource = cad-detail (مصدرها journeys الوحدة نفسها)', crewA2 && crewA2.phasesSource === 'cad-detail');
    check('J أوقات جنوب 6 لم تلمس سريع 1 — سريع 1 لا تُرسل إطلاقًا بلا Journey (لا مشاركة وهمية)', !crewB2);
    check('سُجّل obs-unit-seen للوحدة عند أول ظهور Journey لها (No Journey = No Participation)', lifeEvents('obs-unit-seen').some(e => e.incident === INC && e.unit === 'جنوب 6'));
    // وحدة بلا Journey تبقى مُتجاهَلة حتى بعد أن صارت أختها مشاركة (لا عدوى مشاركة)
    const av2 = lifeEvents('available-ignored').filter(e => e.incident === INC);
    check('V4 سريع 1 بلا Journey ما زالت «available-ignored» رغم مشاركة جنوب 6 الفعلية',
        av2.length > 0 && av2[av2.length - 1].units.length === 1 && av2[av2.length - 1].units[0] === 'سريع 1');

    // ─── T3: تتغير حالة الوحدة (A → B إلغاء قبل المباشرة) ───
    unitA.unitRequestStatus = 'B';
    await cycle();
    msgs = cadReportMsgs();
    const t3 = msgs[msgs.length - 1];
    const crewA3 = t3.payload.crews.find(c => c.team === 'جنوب 6');
    check('C تغيّر حالة الوحدة A→B ← وصل التحديث تلقائيًا (cadUrs=B, cadReached=false)', crewA3 && crewA3.cadUrs === 'B' && crewA3.cadReached === false);
    check('C+ سُجّل obs-change للوحدة المتغيرة بعد رؤيتها (بصمة لكل وحدة)', lifeEvents('obs-change').some(e => e.incident === INC && e.unit === 'جنوب 6'));

    // ─── T4: يتغير وقت مرحلة (مباشرة فعلية AT_PATIENT) ───
    unitA.journeys = unitA.journeys.concat([{ journeyStepCode: 'AT_PATIENT', journeyStepTime: '2026-08-24T08:20:56Z', stepSeq: 5 }]);
    await cycle();
    msgs = cadReportMsgs();
    const t4 = msgs[msgs.length - 1];
    const crewA4 = t4.payload.crews.find(c => c.team === 'جنوب 6');
    const crewB4 = t4.payload.crews.find(c => c.team === 'سريع 1');
    check('B تغيّر وقت مرحلة (العلاج 11:20:56 AM) ← وصل تلقائيًا', crewA4 && crewA4.phases['العلاج'] === '11:20:56 AM');
    check('B+ المباشرة الفعلية انعكست: cadReached=true رغم cadUrs=B (مشاركة بعد المباشرة)', crewA4 && crewA4.cadReached === true);
    check('J2 سريع 1 ما زالت غير مرسلة بعد كل تغييرات جنوب 6 (لا Journey لها بعد)', !crewB4);

    // ─── T4b: نفس البيانات مجددًا = لا إرسال (بصمة — لا spam) ───
    const before = cadReportMsgs().length;
    await cycle(); await cycle();
    check('I تكرار نفس اللقطة مرتين ← صفر إرسال إضافي (Fingerprint)', cadReportMsgs().length === before);

    // ─── T5: تختفي الوحدة من التفاصيل — توثيق بلا استنتاج إلغاء ───
    detailUnits = [unitB];
    await cycle();
    check('اختفاء الوحدة من detail ← وُثّق obs-unit-gone', lifeEvents('obs-unit-gone').some(e => e.incident === INC));
    check('اختفاء الوحدة ≠ إلغاء: لا إرسال جديد ولا تغيير حالة (لا استنتاج من الغياب)', cadReportMsgs().length === before);

    // ─── H: إعادة فتح/إعادة حقن الصفحة لا تنشئ تسجيلًا ثانيًا ───
    detailUnits = [unitA, unitB];
    loadOverlay(); // إعادة حقن كاملة (كأن الصفحة أُعيد فتحها)
    await drain();
    listSnapshot(); await drain(); await drain();
    await cycle();
    const created1 = cadReportMsgs().length;
    check('H إعادة الحقن + لقطة القائمة + دورة مراقبة ← لا تسجيل ثانٍ للبلاغ نفسه', created1 === before);

    // ─── مؤشر الحالة ───
    check('مؤشر المقبض 🟢 متزامن بعد نجاح الدورات', ctx.window.__southObsState && ctx.window.__southObsState.state === 'synced');

    // ─── الوسم الصارم (اعتماد المالك 2026-08-27): لا مسار آلي غير موسوم ───
    check('TAG كل رسالة آلية في السيناريو كله تحمل source=cad-auto (لا سقوط وسم إطلاقًا)',
        cadReportMsgs().length > 0 && cadReportMsgs().every(m => m.payload.source === 'cad-auto'),
        JSON.stringify(cadReportMsgs().map(m => m.payload.source || null)));

    console.log('\n═══ النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌ ═══');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); process.exit(1); }
})().catch(e => { console.error('💥 خطأ غير متوقع:', e); process.exit(1); });
