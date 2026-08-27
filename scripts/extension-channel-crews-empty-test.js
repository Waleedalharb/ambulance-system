/**
 * ═══ extension-channel-crews-empty-test.js — قناة الإضافة × بلاغ بلا فرق ═══
 * (اعتماد المالك 2026-08-27 — بعد provenance النقطة الحمراء): التلميح
 * «إضافة منصة الجنوب غير مثبتة أو لا تستجيب» ثبت أنه مهلة sendToPlatform
 * (4ث بلا رد)، وسببها أن bridge.js كان يسقط crews=[] صامتًا — وهي الحالة
 * الرسمية «بلاغ بلا Journey = بلاغ بلا فرق» منذ 0da9cff.
 * يثبت معزولًا (vm + محاكاة chrome/window — بلا متصفح):
 *  أ) الجسر: crews=[] يُمرَّر للخلفية ولا يُسقَط — والشكل غير الصالح يُرد
 *     برسالة صادقة بدل الصمت (لا مهلة 4ث ولا 🔴 كاذب).
 *  ب) الخلفية المولّدة (extension-builder): crews=[] تصل fetch فعليًا —
 *     و11+ فرقة تُرفض «حمولة غير صالحة» قبل أي شبكة.
 *  ج) تناسق الحزمة: bridge المولّد = extension/bridge.js حرفيًا.
 * التشغيل: node scripts/extension-channel-crews-empty-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 160) : '')); }
}

/* ─── محاكاة بيئة الجسر (ISOLATED content script) ─── */
function loadBridge() {
    const handlers = [];
    const posted = [];
    const sent = [];
    const win = {
        addEventListener: (ev, fn) => { if (ev === 'message') handlers.push(fn); },
        removeEventListener: () => {},
        postMessage: (msg) => posted.push(msg),
    };
    const chrome = {
        runtime: {
            lastError: null,
            sendMessage: (msg, cb) => { sent.push(msg); cb({ status: 200, data: { success: true } }); },
        },
    };
    const src = fs.readFileSync(path.join(ROOT, 'extension', 'bridge.js'), 'utf8');
    vm.runInNewContext(src, { window: win, chrome });
    return {
        posted, sent,
        emit: (data) => handlers.forEach(h => h({ source: win, data })),
    };
}

/* ─── محاكاة بيئة الخلفية (Service Worker مولّد) ─── */
function loadBackground() {
    const stamp = Date.now().toString(36);
    const tmp = path.join(os.tmpdir(), 'ext-bg-' + stamp);
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'integration-keys.json'), JSON.stringify([
        { key: 'test-key-' + stamp, scope: 'cad-reports', active: true }
    ]));
    const { buildExtensionFiles } = require(path.join(ROOT, 'scripts', 'extension-builder'));
    const files = buildExtensionFiles('https://emsoperations.online', { dataDir: tmp });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }

    let listener = null;
    const calls = { fetch: [], responses: [] };
    const sandbox = {
        chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        fetch: async (url, opts) => {
            calls.fetch.push({ url, opts });
            return { status: 200, json: async () => ({ success: true, created: true }) };
        },
    };
    vm.runInNewContext(files.background, sandbox);
    return { files, calls, fire: (msg) => listener(msg, {}, (resp) => calls.responses.push(resp)) };
}

(async () => {
    console.log('🧪 أ — الجسر: crews=[] تمر ولا تُسقَط\n');
    {
        const b = loadBridge();
        b.emit({ source: 'south-cad-overlay', kind: 'cad-report', reqId: 'r1',
                 payload: { number: '1319001', crews: [], lat: 24.62, lng: 46.72 } });
        check('أ1 crews=[] وصلت chrome.runtime.sendMessage (لا إسقاط صامت)',
            b.sent.length === 1 && Array.isArray(b.sent[0].payload.crews) && b.sent[0].payload.crews.length === 0);
        check('أ2 الرد عاد للصفحة status=200 (لا مهلة 4ث ولا 🔴)',
            b.posted.length === 1 && b.posted[0].source === 'south-ext-bridge' && b.posted[0].reqId === 'r1' && b.posted[0].status === 200);
    }
    {
        const b = loadBridge();
        b.emit({ source: 'south-cad-overlay', kind: 'cad-report', reqId: 'r2',
                 payload: { number: '1319002', crews: [{ team: 'جنوب 1', phases: {} }] } });
        check('أ3 crews بفرقة واحدة ما زالت تمر (لا كسر للمسار القائم)',
            b.sent.length === 1 && b.posted.length === 1 && b.posted[0].status === 200);
    }
    {
        const b = loadBridge();
        b.emit({ source: 'south-cad-overlay', kind: 'cad-report', reqId: 'r3',
                 payload: { number: '1319003', crews: Array.from({ length: 11 }, (_, i) => ({ team: 'ف' + i })) } });
        check('أ4 11 فرقة ← رد صريح «مرفوضة» بلا شبكة (بدل الصمت)',
            b.sent.length === 0 && b.posted.length === 1 && b.posted[0].status === 0 &&
            /مرفوضة/.test(b.posted[0].data && b.posted[0].data.error || ''));
        const b2 = loadBridge();
        b2.emit({ source: 'south-cad-overlay', kind: 'cad-report', reqId: 'r4', payload: { number: 'abc', crews: [] } });
        check('أ5 رقم غير صالح ← رد صريح مرفوض بلا شبكة',
            b2.sent.length === 0 && b2.posted.length === 1 && b2.posted[0].status === 0 &&
            /رقم البلاغ/.test(b2.posted[0].data && b2.posted[0].data.error || ''));
        const b3 = loadBridge();
        b3.emit({ source: 'someone-else', kind: 'cad-report', reqId: 'r5', payload: { number: '1319004', crews: [] } });
        check('أ6 رسالة أجنبية (source مختلف) تُتجاهل كالسابق', b3.sent.length === 0 && b3.posted.length === 0);
    }

    console.log('\n🧪 ب — الخلفية المولّدة: crews=[] تصل الشبكة\n');
    {
        const g = loadBackground();
        g.fire({ kind: 'cad-report', payload: { number: '1319010', crews: [], lat: 24.62, lng: 46.72 } });
        await new Promise(r => setTimeout(r, 50));
        check('ب1 crews=[] ← fetch نُفّذ فعليًا للمنصة',
            g.calls.fetch.length === 1 && /emsoperations\.online\/api\/cad-reports$/.test(g.calls.fetch[0].url));
        check('ب2 الجسم المرسل يحمل crews=[] كما هي',
            g.calls.fetch.length === 1 && JSON.parse(g.calls.fetch[0].opts.body).crews.length === 0);
        check('ب3 الرد للجسر status=200 success', g.calls.responses.length === 1 && g.calls.responses[0].status === 200);
        check('ب4 المفتاح في الترويسة (الفصل الأمني قائم)',
            g.calls.fetch.length === 1 && !!g.calls.fetch[0].opts.headers['X-Integration-Key']);
    }
    {
        const g = loadBackground();
        g.fire({ kind: 'cad-report', payload: { number: '1319011', crews: Array.from({ length: 11 }, (_, i) => ({ team: 'ف' + i })) } });
        await new Promise(r => setTimeout(r, 50));
        check('ب5 11 فرقة ← «حمولة غير صالحة» قبل أي fetch',
            g.calls.fetch.length === 0 && g.calls.responses.length === 1 &&
            /غير صالحة/.test(g.calls.responses[0].data && g.calls.responses[0].data.error || ''));
    }

    console.log('\n🧪 ج — تناسق الحزمة\n');
    {
        const g = loadBackground();
        check('ج1 bridge المولّد = extension/bridge.js حرفيًا',
            g.files.bridge === fs.readFileSync(path.join(ROOT, 'extension', 'bridge.js'), 'utf8'));
        check('ج2 لا أثر لشرط الرفض القديم (length < 1) في الجسر ولا الخلفية',
            !/length < 1/.test(g.files.bridge) && !/length < 1/.test(g.files.background));
        check('ج3 نص المهلة الجديد صادق (لا «غير مثبتة» المضللة)',
            !/غير مثبتة أو لا تستجيب/.test(g.files.content) && /لم يصل رد من جسر الإضافة/.test(g.files.content));
    }

    console.log('\n' + '═'.repeat(50));
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('★ قناة الإضافة: بلاغ بلا فرق يمر كاملًا — ولا إسقاط صامت ولا 🔴 كاذب');
})().catch(e => { console.error('💥', e); process.exit(1); });
