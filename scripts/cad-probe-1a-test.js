/**
 * ═══ cad-probe-1a-test.js — اختبار مسبار 1A (اكتشاف مصدر CAD الثاني) ═══
 * (اعتماد المالك 2026-08-27 — المرحلة 1A فقط): المسبار قراءة فقط — يلتقط عينات
 * خام من استجابات CAD لاكتشاف endpoint صفحة المستشفيات وحقولها، بلا احتساب
 * وبلا إرسال للمنصة وبلا أي تغيير سلوكي. يثبت في vm sandbox بلا متصفح:
 *  أ) المسجل معرّض بعد الحقن ويعمل من مساري fetch وXHR الموسَّعين
 *  ب) المسارات غير المعروفة تُخزَّن بسعة كبيرة وبصمة المستشفى تُوسم hit
 *  ج) المسارات المعروفة تُقص (بنيتها موثقة) وdetail يستخرج eventId
 *  د) سقف المخزن ينزلق بلا انفجار ذاكرة
 *  هـ) التصدير JSON صافٍ وكامل (meta + buf + callsByEndpoint)
 *  و) لا أثر سلوكي: لا postMessage ولا استدعاء منصة بسبب المسبار إطلاقًا
 * التشغيل: node scripts/cad-probe-1a-test.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const OVERLAY_SRC = path.join(__dirname, 'cad-overlay.js');
const CAD = 'https://cad.example.com';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

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

const messages = [];
const msgListeners = new Set();
const locationObj = { href: CAD + '/list', origin: CAD };
const windowObj = {
    innerWidth: 1280, innerHeight: 800,
    addEventListener(t, fn) { if (t === 'message') msgListeners.add(fn); },
    removeEventListener(t, fn) { if (t === 'message') msgListeners.delete(fn); },
    postMessage(data) { messages.push(data); },
    fetch: async (url) => ({
        ok: true, url: String(url),
        headers: { get: (k) => /content-type/i.test(k) ? 'application/json; charset=utf-8' : null },
        json: async () => ({ data: { probe: true } }),
        clone() { return { json: async () => ({ data: { probe: true } }) }; }
    })
};
const ctx = {
    console,
    window: windowObj,
    document: { getElementById: () => null, createElement: () => elStub(), head: { appendChild() { } }, body: { innerText: '', appendChild() { } } },
    location: locationObj,
    localStorage: storageMock(), sessionStorage: storageMock(),
    setTimeout: () => 1, clearTimeout: () => { }, setInterval: () => 999, clearInterval: () => { },
    XMLHttpRequest: function () { },
};
ctx.XMLHttpRequest.prototype = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 5)); };

(async () => {
    console.log('🧪 اختبار مسبار 1A — vm sandbox بلا متصفح\n');
    vm.runInContext(fs.readFileSync(OVERLAY_SRC, 'utf8'), ctx, { filename: 'cad-overlay.js' });

    console.log('أ — التعريض والالتقاط من مسار fetch الحقيقي:');
    check('أ1 __southProbeRecord و__southProbeExportJson معرّضان بعد الحقن',
        typeof ctx.window.__southProbeRecord === 'function' && typeof ctx.window.__southProbeExportJson === 'function');
    await ctx.window.fetch(CAD + '/hospital-manager/api/v2/board?facility=12'); // endpoint افتراضي غير معروف
    await drain();
    let probe = ctx.window.__southProbe;
    check('أ2 استجابة JSON من مسار غير معروف التُقطت عبر خطاف fetch (via=fetch)',
        probe.buf.length === 1 && probe.buf[0].via === 'fetch' && /hospital-manager/.test(probe.buf[0].url));
    check('أ3 بصمة المستشفى من عنوان URL نفسه ← hit=true', probe.buf[0].hit === true);

    console.log('\nب — السعة والقص والبصمة من الحمولة:');
    ctx.window.__southProbeRecord(CAD + '/hospital-manager/api/v2/board', 'xhr',
        { rows: [{ unitCode: 'جنوب 8', facilityName: 'مستشفى الإيمان العام', elapsed: '11:23', state: 'تسليم' }] });
    probe = ctx.window.__southProbe;
    const last = probe.buf[probe.buf.length - 1];
    check('ب1 بصمة من الحمولة (مستشفى/تسليم) ← hit=true', last.hit === true);
    check('ب2 الترابط: unitCode جنوب 8 استُخرج للربط اللاحق', Array.isArray(last.units) && last.units.some(u => /unitCode/.test(u)));
    const bigUnknown = { blob: 'x'.repeat(200000) };
    ctx.window.__southProbeRecord(CAD + '/unknown-module/api/big', 'fetch', bigUnknown);
    const bigU = ctx.window.__southProbe.buf[ctx.window.__southProbe.buf.length - 1];
    check('ب3 مسار غير معروف كبير ← قُص عند ~120KB مع وسم truncated', bigU.truncated === true && bigU.sample.length <= 120500, 'sample=' + bigU.sample.length);
    const bigKnown = { data: { items: [], pad: 'y'.repeat(30000) } };
    ctx.window.__southProbeRecord(CAD + '/dispatch-manager/api/cfs/v2/operation-controller/incident-list?page=1', 'fetch', bigKnown);
    const bigK = ctx.window.__southProbe.buf[ctx.window.__southProbe.buf.length - 1];
    check('ب4 مسار معروف ← قص ~24KB (كافٍ لصيد اسم المنشأة في القائمة)', bigK.truncated === true && bigK.sample.length <= 24100, 'sample=' + bigK.sample.length);

    console.log('\nج — detail كامل السعة واستخراج eventId:');
    ctx.window.__southProbeRecord(CAD + '/event-manager/api/v2/event-dispatched/detail?eventId=1319001&showAbortedCancelledUnits=true', 'fetch',
        { data: { id: 1319001, units: [], destination: { pad: 'z'.repeat(6000) } } });
    const det = ctx.window.__southProbe.buf[ctx.window.__southProbe.buf.length - 1];
    check('ج1 eventId=1319001 استُخرج من عنوان detail', det.eventId === '1319001');
    check('ج2 detail لم يُقص عند 4KB (سعة 250KB لصيد حقل المنشأة)', det.truncated !== true && det.sample.length > 6000);

    console.log('\nهـ — التصدير (قبل الفيض — عينة المستشفى ما زالت في المخزن):');
    let out = JSON.parse(ctx.window.__southProbeExportJson());
    check('هـ1 meta يحمل ختم البناء وعدد العينات وإحصاء endpoints',
        /2026-08-27\.d/.test(out.meta.build) && out.meta.samples === ctx.window.__southProbe.buf.length &&
        out.meta.callsByEndpoint && Object.keys(out.meta.callsByEndpoint).length > 0);
    check('هـ2 buf كامل في التصدير وعينة المستشفى موجودة حرفيًا',
        Array.isArray(out.buf) && JSON.stringify(out.buf).includes('مستشفى الإيمان العام'));
    check('هـ3 تنبيه الخصوصية موجود في meta', /بيانات مرضى/.test(out.meta.note));

    console.log('\n د — سقف المخزن المنزلق:');
    for (let i = 0; i < 610; i++) ctx.window.__southProbeRecord(CAD + '/x/api/' + i, 'fetch', { i });
    probe = ctx.window.__southProbe;
    check('د1 المخزن لا يتجاوز السقف (600) مهما تراكم', probe.buf.length <= 600, 'len=' + probe.buf.length);
    out = JSON.parse(ctx.window.__southProbeExportJson());
    check('د2 التصدير بعد الفيض سليم ومتسق (samples = buf)', out.meta.samples === probe.buf.length && out.buf.length === probe.buf.length);

    console.log('\nو — لا أثر سلوكي:');
    const msgsBefore = messages.length; // جلب فرق الجنوب عند الإقلاع سلوك قائم قبل المسبار — المطلوب أن لا يضيف المسبار شيئًا
    ctx.window.__southProbeRecord(CAD + '/hospital-manager/api/v2/board', 'fetch', { rows: [] });
    ctx.window.__southProbeExportJson();
    await drain();
    check('و1 عمليات المسبار لم تُنتج أي postMessage إضافي للجسر (صفر دلتا)', messages.length === msgsBefore, 'delta=' + (messages.length - msgsBefore));
    check('و2 حمولة غير JSON (null) تُتجاهل بصمت',
        (ctx.window.__southProbeRecord(CAD + '/x/api/null', 'fetch', null), true));

    console.log('\n' + '═'.repeat(50));
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('★ مسبار 1A: التقاط خام قراءة فقط — بلا احتساب ولا إرسال ولا أثر سلوكي');
})().catch(e => { console.error('💥', e); process.exit(1); });
