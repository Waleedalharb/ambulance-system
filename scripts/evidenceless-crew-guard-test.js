/**
 * ═══ evidenceless-crew-guard-test.js — «لا Journey = لا مشاركة» (اعتماد المالك 2026-08-26) ═══
 * إصلاح الـphantom المثبت بالرصد الحي: ممر lastJourneys الاحتياطي في الـOverlay
 * كان يولّد مشاركات عارية {team, phases:{}} قبل وجود Journey فعلية (بلاغ 1315542:
 * ميلاد السجل سبق ظهور الرحلة بثلاث دقائق، وبلاغات أُغلقت وبقيت وحداتها الوهمية
 * بلا رحلة إطلاقًا). ~119 صفًا وهميًا (~60% من المحتسبات) على كل الفرق.
 * الإصلاح بطبقتين:
 *   القسم أ — Overlay (vm sandbox): ممر lastJourneys مغلق — بلاغ بلا Journey يُسجَّل
 *             بلا فرق (يظهر على الخريطة)، وتنضم المشاركة عند ظهور رحلتها فعليًا.
 *   القسم ب — الخادم (قاعدة معزولة): حارس createIncidentEntries لمسار cad-auto —
 *             طاقم بلا أي دليل (وقت/هوية/urs/cadReached/withdrawn) ← لا سجل إطلاقًا.
 * الضوابط الثابتة: اليدوي الصريح الموسوم cad-manual لا يُمس (توسعة 2026-08-27: العاري
 * بلا وسم — cad-oneclick — يُحجب مثل cad-auto لسد ثغرة سقوط الوسم عبر watchTick) ·
 * الحارس على الإنشاء فقط (تحديث السجلات القائمة لا يُحجب) · isParticipationCounted
 * لم يُعدَّل · لا حذف ولا تعديل لأي سجل تاريخي.
 * التشغيل: node scripts/evidenceless-crew-guard-test.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OVERLAY_SRC = path.join(__dirname, 'cad-overlay.js');
const CAD = 'https://cad.example.com';
const INC = '8701';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
}

const timedStep = (code, iso, seq) => ({ journeyStepCode: code, journeyStepTime: iso, stepSeq: seq });
/* وحدة جنوبية ظاهرة في lastJourneys بمرحلة — بلا أي Journey في التفاصيل بعد (حالة phantom الحية) */
const listUnit = { unitCode: 'جنوب 7', journeyStepCode: 'ACCEPTANCE' };
/* التفاصيل: أولًا الوحدة بهيكل بلا أوقات ولا urs (لا دليل) — ثم تُرقَّى لرحلة فعلية */
let detailHasJourney = false;
const detailPayload = () => ({
    data: {
        id: Number(INC),
        units: [detailHasJourney
            ? { unitCode: 'جنوب 7', unitRequestStatus: 'A', unitId: 7007, runUnitId: 770007, journeys: [timedStep('ACCEPTANCE', '2026-08-26T09:00:00Z', 1), timedStep('TURNOUT', '2026-08-26T09:01:00Z', 2)] }
            : { unitCode: 'جنوب 7', unitRequestStatus: null, unitId: 7007, runUnitId: 770007, journeys: [] }],
        createdDate: '2026-08-26T08:55:00Z', address: 'حي الياسمين', zoneName: 'الجنوب'
    }
});

/* ═══════════ القسم أ — Overlay (vm sandbox بلا متصفح) ═══════════ */
const messages = [];
const msgListeners = new Set();
const fakeTimers = [];
let timerSeq = 0;
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
        setTimeout(() => {
            const resp = data.kind === 'cad-report'
                ? { success: true, created: false, addedCrews: [], skippedCrews: [], withdrawnCrews: [], planUnitsIgnored: [], evidencelessIgnored: [] }
                : data.kind === 'cad-stats'
                    ? { success: true, total: 0, byType: {}, byCrew: {} }
                    : { success: false };
            const evt = { data: { source: 'south-ext-bridge', reqId: data.reqId, status: 200, data: resp } };
            for (const fn of Array.from(msgListeners)) { try { fn(evt); } catch (_) { } }
        }, 0);
    },
    fetch: async (url) => {
        const u = String(url);
        const payload = /event-dispatched\/detail/.test(u) ? detailPayload() : { data: {} };
        return { ok: true, url: u, json: async () => payload, clone: () => ({ json: async () => payload }) };
    }
};
const ctx = {
    console,
    window: windowObj,
    document: { getElementById: () => null, createElement: () => elStub(), head: { appendChild() { } }, body: bodyEl },
    location: locationObj,
    localStorage: storageMock(),
    sessionStorage: storageMock(),
    setTimeout: (fn, ms) => { const id = ++timerSeq; fakeTimers.push({ id, fn, ms: ms || 0, cleared: false }); return id; },
    clearTimeout: (id) => { const t = fakeTimers.find(t => t.id === id); if (t) t.cleared = true; },
    setInterval: () => 999, clearInterval: () => { },
    XMLHttpRequest: function () { },
};
ctx.XMLHttpRequest.prototype = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 5)); };
const cadReportMsgs = () => messages.filter(m => m.kind === 'cad-report' && m.payload && m.payload.number === INC);
const lifeEvents = (kind) => (ctx.window.__southLife ? ctx.window.__southLife.events : []).filter(e => e.kind === kind);
function loadOverlay() { vm.runInContext(fs.readFileSync(OVERLAY_SRC, 'utf8'), ctx, { filename: 'cad-overlay.js' }); }
function listSnapshot() {
    // الحالة الحية المثبتة: الوحدة تظهر في lastJourneys بمرحلة قبل أن توجد Journey فعلية
    ctx.window.__southHandleCadResponse(CAD + '/dispatch-manager/api/cfs/v2/operation-controller/incident-list?page=1', {
        data: { last: true, items: [{ eventId: Number(INC), proQACode: '30A01', lastJourneys: [listUnit] }] }
    });
}
async function cycle() { await ctx.window.__southObsTick(); await drain(); await ctx.window.__southWatchTick(); await drain(); }

async function overlaySection() {
    console.log('🧪 القسم أ — Overlay: ممر lastJourneys مغلق\n');
    const srcText = fs.readFileSync(OVERLAY_SRC, 'utf8');
    check('A0 ختم البناء الجديد 2026-08-27.b ظاهر', /2026-08-27\.b/.test(srcText.match(/OVERLAY_BUILD = '([^']+)'/) ? srcText : ''));
    check('A0+ لا أثر لـcadListStep في المصدر إطلاقًا (الممر أُزيل لا عُطّل)', !/cadListStep/.test(srcText));

    loadOverlay();
    listSnapshot(); await drain(); await drain();
    locationObj.href = CAD + '/incidents/' + INC;
    await cycle();

    const m0 = cadReportMsgs();
    check('A1 وحدة ظاهرة في lastJourneys بلا Journey فعلية ← البلاغ يُسجَّل بلا فرق (crews=[])',
        m0.length >= 1 && m0[m0.length - 1].payload.crews.length === 0,
        m0.length ? 'crews=' + JSON.stringify(m0[m0.length - 1].payload.crews) : 'لا رسائل');
    check('A2 لا مشاركة وهمية: لا أي طاقم عارٍ {team, phases:{}} في الحمولة',
        m0.length >= 1 && m0.every(m => (m.payload.crews || []).every(c => Object.keys(c.phases || {}).length > 0 || c.cadUrs || c.cadReached === true)));
    check('A3 حدث auto-register-nojourney موثق (قرار قابل للتتبع — لا صمت)',
        lifeEvents('auto-register-nojourney').filter(e => e.incident === INC).length >= 1);

    // الترقية الذاتية: ظهرت Journey فعلية ← المشاركة تنضم بدليلها الكامل
    detailHasJourney = true;
    listSnapshot(); await drain(); await drain();
    await cycle(); await cycle();
    const m1 = cadReportMsgs();
    const last = m1[m1.length - 1];
    const crew7 = last && (last.payload.crews || []).find(c => c.team === 'جنوب 7');
    check('A4 بعد ظهور Journey فعلية ← المشاركة تنضم تلقائيًا بأوقاتها وهويتها',
        !!crew7 && crew7.phasesSource === 'cad-detail' && !!crew7.phases['التحرك'] && crew7.cadUrs === 'A',
        JSON.stringify(crew7 || (last && last.payload.crews) || null));
}

/* ═══════════ القسم ب — الخادم: الحارس السيرفري (قاعدة معزولة) ═══════════ */
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const NB = String(Date.now()).slice(-7);
const TMP_DIR = path.join(os.tmpdir(), 'evid-guard-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

async function api(p, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

async function serverSection() {
    console.log('\n🧪 القسم ب — الخادم: حارس cad-auto بلا دليل (قاعدة معزولة)\n');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    const dbCount = (num) => {
        const v = new Database(TMP_DB, { readonly: true });
        const rows = v.prepare(`SELECT r.unit, t.phases, t.withdrawn, t.manual_cancelled, t.cad_unit_status FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=?`).all(num);
        v.close();
        return rows;
    };

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) throw new Error('login');
        const post = (body) => api('/api/cad-reports', { method: 'POST', token: TK, body });
        const sum = () => api('/api/cad-reports', { token: TK }).then(r => r.data);
        const s0 = await sum();
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;

        /* ── S1: طاقم عارٍ cad-auto ← لا سجل، البلاغ يُنشأ، التوثيق موجود ── */
        const N1 = '9' + NB + '1';
        const r1 = await post({ number: N1, type: 'medical', source: 'cad-auto', createdAt: '26/08/2026 9:00:00 AM', lat: 24.7, lng: 46.7, crews: [{ team: 'جنوب 7', phases: {} }] });
        check('B1 طاقم عارٍ cad-auto ← صفر إنشاء + موثق evidencelessIgnored',
            r1.status === 200 && r1.data && (r1.data.addedCrews || []).length === 0
            && (r1.data.evidencelessIgnored || []).indexOf('جنوب 7') !== -1,
            JSON.stringify(r1.data));
        check('B1+ قاعدة البيانات: صفر مشاركات للبلاغ', dbCount(N1).length === 0, 'rows=' + dbCount(N1).length);
        let s = await sum();
        const inc1 = (s.incidents || []).find(i => i.number === N1);
        check('B1++ البلاغ نفسه أُنشئ ويظهر بالملخص بصفر فرق (يظهر على الخريطة)',
            !!inc1 && (inc1.crews || []).length === 0, JSON.stringify(inc1 && inc1.number));
        check('B1+++ byCrew لم يتحرك لجنوب 7', ((s.byCrew || {})['جنوب 7'] || 0) === c0('جنوب 7'));

        /* ── S2: الترقية — نفس الفرقة بـJourney فعلية ← تُنشأ صحيحة وتُحتسب ── */
        const r2 = await post({ number: N1, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 7', phases: { 'قبول': '9:00:00 AM', 'التحرك': '9:01:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 7007, cadRunUnitId: 770007 }] });
        const rows2 = dbCount(N1);
        s = await sum();
        check('B2 الترقية: عارية محجوبة ثم Journey فعلية ← سجل صحيح محتسب',
            r2.data && (r2.data.addedCrews || []).indexOf('جنوب 7') !== -1
            && rows2.length === 1 && !!rows2[0].phases && rows2[0].phases.indexOf('التحرك') !== -1
            && ((s.byCrew || {})['جنوب 7'] || 0) === c0('جنوب 7') + 1, JSON.stringify({ added: r2.data && r2.data.addedCrews, rows: rows2.length }));

        /* ── S3: طاقم عارٍ لاحق على مشاركة قائمة ← لا يسحبها ولا يعدّلها ولا ينشئ ثانية ── */
        const r3 = await post({ number: N1, type: 'medical', source: 'cad-auto', crews: [{ team: 'جنوب 7', phases: {} }] });
        const rows3 = dbCount(N1);
        s = await sum();
        check('B3 طاقم عارٍ لاحق على مشاركة قائمة ← لا سجل ثانٍ والمشاركة محفوظة بأوقاتها محتسبة',
            rows3.length === 1 && rows3[0].phases.indexOf('التحرك') !== -1
            && ((s.byCrew || {})['جنوب 7'] || 0) === c0('جنوب 7') + 1,
            JSON.stringify({ rows: rows3.length, ev: r3.data && r3.data.evidencelessIgnored, sk: r3.data && r3.data.skippedCrews }));

        /* ── S4: cad-auto بـurs=A بلا أوقات ← سلوك قائم محفوظ (قبول صريح = دليل) ── */
        const N4 = '9' + NB + '4';
        const r4 = await post({ number: N4, type: 'medical', source: 'cad-auto', crews: [{ team: 'سريع 2', phases: {}, cadUrs: 'A' }] });
        check('B4 cad-auto urs=A بلا أوقات ← يُنشأ (السلوك القائم محفوظ)',
            r4.data && (r4.data.addedCrews || []).indexOf('سريع 2') !== -1 && dbCount(N4).length === 1,
            JSON.stringify(r4.data && r4.data.addedCrews));

        /* ── S5: cad-auto بـurs=B بلا أوقات ← مسحوبة غير محتسبة (سلوك قائم) ── */
        const N5 = '9' + NB + '5';
        const r5 = await post({ number: N5, type: 'medical', source: 'cad-auto', crews: [{ team: 'جنوب 8', phases: {}, cadUrs: 'B' }] });
        const rows5 = dbCount(N5);
        s = await sum();
        check('B5 cad-auto urs=B ← موثقة مسحوبة (withdrawn) وغير محتسبة',
            rows5.length === 1 && rows5[0].withdrawn === 1 && ((s.byCrew || {})['جنوب 8'] || 0) === c0('جنوب 8'),
            JSON.stringify(rows5));

        /* ── S6: سد ثغرة سقوط الوسم (2026-08-27): العاري بلا وسم ← يُحجب — اليدوي
           الصريح وحده (cad-manual) يمر ── */
        const N6 = '9' + NB + '6';
        const r6 = await post({ number: N6, type: 'medical', crews: [{ team: 'جنوب 10' }] });
        check('B6 عارٍ بلا وسم إطلاقًا (cad-oneclick افتراضي) ← يُحجب كالموسوم cad-auto (لا ثغرة سقوط وسم)',
            r6.data && (r6.data.addedCrews || []).length === 0
            && (r6.data.evidencelessIgnored || []).indexOf('جنوب 10') !== -1
            && dbCount(N6).length === 0, JSON.stringify(r6.data));
        const r6b = await post({ number: N6, type: 'medical', source: 'cad-manual', crews: [{ team: 'جنوب 10' }] });
        s = await sum();
        check('B6b الضغطة اليدوية الصريحة (cad-manual) عارية ← تُنشأ وتُحتسب (الإدخال اليدوي الحقيقي محفوظ)',
            r6b.data && (r6b.data.addedCrews || []).indexOf('جنوب 10') !== -1
            && dbCount(N6).length === 1
            && ((s.byCrew || {})['جنوب 10'] || 0) === c0('جنوب 10') + 1, JSON.stringify(r6b.data));

        /* ── S6c: العاري على سجل قائم ← تحديث لا يُحجب (موضع الحارس بعد المطابقة) ── */
        const r6c = await post({ number: N6, type: 'medical', crews: [{ team: 'جنوب 10', withdrawn: false }] });
        check('B6c عارٍ (withdrawn=false) على سجل قائم ← لا يدخل evidencelessIgnored ولا ينشئ ثانيًا',
            r6c.data && (r6c.data.evidencelessIgnored || []).indexOf('جنوب 10') === -1
            && (r6c.data.skippedCrews || []).indexOf('جنوب 10') !== -1
            && dbCount(N6).length === 1, JSON.stringify(r6c.data));

        /* ── S7: crews=[] ← البلاغ يُسجَّل بصفر مشاركات (لا 400) ── */
        const N7 = '9' + NB + '7';
        const r7 = await post({ number: N7, type: 'medical', source: 'cad-auto', createdAt: '26/08/2026 9:30:00 AM', lat: 24.65, lng: 46.75, crews: [] });
        s = await sum();
        const inc7 = (s.incidents || []).find(i => i.number === N7);
        check('B7 crews=[] ← 200 والبلاغ أُنشئ ويظهر بالملخص بصفر فرق',
            r7.status === 200 && r7.data && r7.data.success === true && r7.data.created === true
            && !!inc7 && (inc7.crews || []).length === 0 && dbCount(N7).length === 0,
            'status=' + r7.status + ' ' + JSON.stringify(r7.data && { success: r7.data.success, created: r7.data.created }));

        /* ── S8: المرايا — byCrew والملخص لا يظهر فيهما أي محجوب ── */
        s = await sum();
        check('B8 مرآة الملخص النهائية: لا أثر للمحجوبين في byCrew (جنوب 7 +1 فقط من Journey الفعلية)',
            ((s.byCrew || {})['جنوب 7'] || 0) === c0('جنوب 7') + 1
            && ((s.byCrew || {})['جنوب 8'] || 0) === c0('جنوب 8')
            && ((s.byCrew || {})['سريع 2'] || 0) === c0('سريع 2') + 1);
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }
}

(async () => {
    await overlaySection();
    await serverSection();
    console.log('\n═══ النتيجة الإجمالية: ' + passed + ' ✅ / ' + failed + ' ❌ ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥 خطأ غير متوقع:', e); process.exit(1); });
