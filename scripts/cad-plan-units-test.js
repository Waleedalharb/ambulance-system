/**
 * ═══ cad-plan-units-test.js — اختبار «Available ≠ Participating» (اعتماد المالك 2026-08-25) ═══
 * المشكلة المثبتة بالرصد الحي: وحدات «تغيير خطة الاستجابة» تظهر في units[] من
 * event-dispatched/detail بهيكل journeys كامل (9 مراحل) لكن كل أوقاته null ومعه
 * unitRequestStatus=null (لقطة جنوب 10-1 الحقيقية) — كان الهيكل وحده يمرّرها
 * مشاركة فتدخل تقرير المناوبة وتوزيع البلاغات والمنجزات (بلاغ ظهر فيه 17 بينما
 * المشاركة الفعلية 7).
 * القاعدة النهائية: Available/Plan ≠ Assigned ≠ Responding ≠ Positioning ≠
 * Participating — المشاركة لا تُثبت إلا بحدث رحلة فعلي (وقت موقوت) أو urs صريح.
 * يثبت هذا الملف طبقتي الدفاع:
 *   القسم أ — Overlay (vm sandbox): الفلتر الدلالي في crewsFromDetail/ingestDetailUnits
 *   القسم ب — الخادم (قاعدة معزولة): دفاع createIncidentEntries + planUnitsIgnored
 * السيناريو الرئيسي بطلب المالك حرفيًا: بلاغ واحد + 10 فرق في خطة الاستجابة +
 * فرقتان تحركتا فعليًا ← المشاركة = فرقتان فقط.
 * التشغيل: node scripts/cad-plan-units-test.js
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
const INC = '8801';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
}

/* هيكل Journey الكامل كما يرسله CAD لوحدة الخطة: 9 مراحل كل أوقاتها null */
const SKEL_CODES = ['ACCEPTANCE', 'TURNOUT', 'IN_ROUTE', 'PATIENT_REACH', 'AT_PATIENT', 'TO_HOSPITAL', 'AT_HOSPITAL', 'HANDOVER', 'BACK_TO_SERVICE'];
const skeletonJourneys = () => SKEL_CODES.map((code, i) => ({ journeyStepCode: code, journeyStepTime: null, stepSeq: i + 1 }));
const timedStep = (code, iso, seq) => ({ journeyStepCode: code, journeyStepTime: iso, stepSeq: seq });

/* 10 وحدات خطة (أسماء جنوبية) + فرقتان فعليتان — لا تداخل بين المجموعتين */
const PLAN_NAMES = ['جنوب 1', 'جنوب 2', 'جنوب 3', 'جنوب 4', 'جنوب 5', 'جنوب 7', 'جنوب 8', 'سريع 2', 'سريع 3', 'سريع 4'];
const planUnits = PLAN_NAMES.map((name, i) => ({
    unitCode: name, unitRequestStatus: null, journeys: skeletonJourneys(), unitId: 2000 + i, runUnitId: 910000 + i
}));
const realA = { unitCode: 'سريع 1', unitRequestStatus: 'A', unitId: 1729, runUnitId: 2518898, journeys: [timedStep('ACCEPTANCE', '2026-08-25T08:02:00Z', 1), timedStep('TURNOUT', '2026-08-25T08:02:47Z', 2)] };
const realB = { unitCode: 'جنوب 6', unitRequestStatus: 'A', unitId: 1460, runUnitId: 2518906, journeys: [timedStep('ACCEPTANCE', '2026-08-25T08:07:08Z', 1), timedStep('TURNOUT', '2026-08-25T08:07:11Z', 2)] };
const detailPayload = () => ({ data: { id: Number(INC), units: planUnits.concat([realA, realB]), createdDate: '2026-08-25T08:00:00Z', address: 'حي الروضة', zoneName: 'الجنوب' } });

/* ═══════════ القسم أ — Overlay (vm sandbox بلا متصفح) ═══════════ */
const messages = [];
const msgListeners = new Set();
const fakeTimers = [];
let timerSeq = 0;
let detailFetches = 0;
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
                ? { success: true, created: false, addedCrews: [], skippedCrews: [], withdrawnCrews: [], planUnitsIgnored: [] }
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
    // واقعيًا: وحدات الخطة لا تصل lastJourneys إطلاقًا (مثبت بالرصد) — الفعليتان فقط
    ctx.window.__southHandleCadResponse(CAD + '/dispatch-manager/api/cfs/v2/operation-controller/incident-list?page=1', {
        data: { last: true, items: [{ eventId: Number(INC), proQACode: '30A01', lastJourneys: [realA, realB].map(u => ({ unitCode: u.unitCode, journeyStepCode: 'TURNOUT' })) }] }
    });
}
async function cycle() { await ctx.window.__southObsTick(); await drain(); await ctx.window.__southWatchTick(); await drain(); }

async function overlaySection() {
    console.log('🧪 القسم أ — Overlay: الفلتر الدلالي لوحدات الخطة\n');
    loadOverlay();
    check('A0 ختم البناء الجديد 2026-08-25.a ظاهر', /2026-08-25\.a/.test(ctx.window.__southBuild || ''));

    listSnapshot(); await drain(); await drain();
    locationObj.href = CAD + '/incidents/' + INC;
    await cycle();

    const m0 = cadReportMsgs();
    check('A1 بلاغ + 10 وحدات خطة + فرقتان فعليتان ← المشاركة = فرقتان فقط',
        m0.length >= 1 && m0[m0.length - 1].payload.crews.length === 2,
        m0.length ? 'crews=' + m0[m0.length - 1].payload.crews.map(c => c.team).join(',') : 'لا رسائل');
    check('A2 الفرقتان المرسلتان هما الفعليتان فقط (سريع 1 + جنوب 6)',
        m0.length >= 1 && ['سريع 1', 'جنوب 6'].every(t => m0[m0.length - 1].payload.crews.some(c => c.team === t)));
    const planIgn = lifeEvents('plan-unit-ignored').filter(e => e.incident === INC);
    check('A3 وحدات الخطة العشر وثّقت plan-unit-ignored (قابلة للتتبع — لا قرار صامت)',
        planIgn.length > 0 && planIgn[planIgn.length - 1].units.length === 10,
        JSON.stringify(planIgn.length ? planIgn[planIgn.length - 1].units : []));
    const storeNow = (ctx.window.__southUnits[INC] && ctx.window.__southUnits[INC].units) || [];
    check('A4 مخزن الوحدات لا يحوي أي وحدة خطة (صفر هيكل فارغ)', storeNow.length === 2 && storeNow.every(u => PLAN_NAMES.indexOf(u.unit) === -1),
        JSON.stringify(storeNow.map(u => u.unit)));
    check('A5 لا available-ignored زائف — الوحدات لها هيكل Journey لكنها خطة (تصنيف دلالي صحيح)',
        lifeEvents('available-ignored').filter(e => e.incident === INC).length === 0);

    // Available ثم Assigned: وحدة خطة تثبت رحلتها لاحقًا ← تصبح مشاركة
    const p3 = planUnits.find(u => u.unitCode === 'جنوب 3');
    p3.unitRequestStatus = 'A';
    p3.journeys = [timedStep('ACCEPTANCE', '2026-08-25T08:20:00Z', 1), timedStep('TURNOUT', '2026-08-25T08:21:00Z', 2)];
    await cycle();
    const msgs = cadReportMsgs();
    const last = msgs[msgs.length - 1];
    const crew3 = last && last.payload.crews.find(c => c.team === 'جنوب 3');
    check('A6 وحدة الخطة «جنوب 3» بعد ثبوت رحلتها (urs=A + أوقات) ← أصبحت مشاركة مرسلة',
        !!crew3 && crew3.phasesSource === 'cad-detail' && !!crew3.phases['التحرك'], JSON.stringify(crew3 || null));
    check('A7 بقية وحدات الخطة التسع ما زالت مرفوضة بعد ترقية جنوب 3',
        last && last.payload.crews.length === 3, last ? 'crews=' + last.payload.crews.length : 'لا رسالة');
}

/* ═══════════ القسم ب — الخادم (قاعدة معزولة) ═══════════ */
const PORT = 3098;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const NB = String(Date.now()).slice(-7);
const TMP_DIR = path.join(os.tmpdir(), 'cad-plan-' + STAMP);
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
    console.log('\n🧪 القسم ب — الخادم: دفاع createIncidentEntries (قاعدة معزولة)\n');
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
        const rows = v.prepare(`SELECT r.unit, t.phases, t.withdrawn, t.manual_cancelled, t.cad_unit_status, t.cad_reached FROM report_times t JOIN reports r ON r.id=t.report_id WHERE t.incident_number=?`).all(num);
        v.close();
        return rows;
    };
    // نفس قاعدة الاحتساب الموحدة (isParticipationCounted) للتحقق المستقل
    const countedOf = (rows) => rows.filter(r => {
        if (r.withdrawn || r.manual_cancelled) return false;
        let ph = r.phases; if (typeof ph === 'string') { try { ph = JSON.parse(ph); } catch (_) { ph = null; } }
        if (!ph) return true; // القاعدة القديمة للمسار اليدوي فقط
        return !!ph['التحرك'];
    });

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) throw new Error('login');
        const post = (body) => api('/api/cad-reports', { method: 'POST', token: TK, body });
        const sum = () => api('/api/cad-reports', { token: TK }).then(r => r.data);
        const s0 = await sum();
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;
        const crewOf = (s, num, unit) => {
            const inc = (s.incidents || []).find(i => i.number === num);
            return inc ? (inc.crews || []).find(c => c.unit === unit) || null : null;
        };

        /* ── S1 السيناريو الرئيسي: بلاغ + 10 فرق خطة + فرقتان تحركتا فعليًا ──
           (المسار يسقف crews عند 10 للطلب الواحد — قيد قائم قبل الإصلاح — لذلك
           تصل وحدات الخطة في طلب والفعليتان في الطلب التالي على نفس البلاغ،
           تمامًا كما تصل لقطات الـOverlay المتتابعة واقعيًا) */
        const N1 = '8' + NB + '1';
        const planCrews = PLAN_NAMES.map((t, i) => ({ team: t, phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2000 + i, cadRunUnitId: 910000 + i }));
        const r1a = await post({ number: N1, type: 'medical', source: 'cad-auto', crews: planCrews });
        check('B1a لقطة وحدات الخطة العشر ← صفر إنشاء، والعشر موثقة planUnitsIgnored',
            r1a.data && (r1a.data.addedCrews || []).length === 0 && (r1a.data.planUnitsIgnored || []).length === 10,
            JSON.stringify(r1a.data && { a: r1a.data.addedCrews, p: r1a.data.planUnitsIgnored }));
        check('B1b قاعدة البيانات بعد لقطة الخطة: صفر مشاركات', dbCount(N1).length === 0, 'rows=' + dbCount(N1).length);
        const r1 = await post({ number: N1, type: 'medical', source: 'cad-auto', crews: [
            { team: 'سريع 1', phases: { 'قبول': '11:02:00 AM', 'التحرك': '11:02:47 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 1729, cadRunUnitId: 2518898 },
            { team: 'جنوب 6', phases: { 'قبول': '11:07:08 AM', 'التحرك': '11:07:11 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 1460, cadRunUnitId: 2518906 }] });
        check('B1 المشاركة = فرقتان فقط (addedCrews)', r1.data && (r1.data.addedCrews || []).length === 2, JSON.stringify(r1.data && r1.data.addedCrews));
        const rows1 = dbCount(N1);
        check('B1++ قاعدة البيانات تحوي مشاركتين فقط (لا سجلات لوحدات الخطة إطلاقًا)', rows1.length === 2, 'rows=' + rows1.length);
        let s = await sum();
        check('B1+++ byCrew: الفرقتان الفعليتان +1 وكل وحدات الخطة +0',
            ((s.byCrew || {})['سريع 1'] || 0) === c0('سريع 1') + 1 && ((s.byCrew || {})['جنوب 6'] || 0) === c0('جنوب 6') + 1
            && PLAN_NAMES.every(t => ((s.byCrew || {})[t] || 0) === c0(t)));

        /* ── S2: Available فقط ← صفر مشاركة ── */
        const N2 = '8' + NB + '2';
        const r2 = await post({ number: N2, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 1', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2001, cadRunUnitId: 910001 },
            { team: 'جنوب 2', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2002, cadRunUnitId: 910002 },
            { team: 'سريع 2', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2003, cadRunUnitId: 910003 }] });
        check('B2 Available فقط ← صفر مشاركة وصفر سجلات', r2.data && (r2.data.addedCrews || []).length === 0 && dbCount(N2).length === 0);
        check('B2+ الثلاثة موثقون في planUnitsIgnored', r2.data && (r2.data.planUnitsIgnored || []).length === 3);
        /* تكرار نفس لقطة الخطة الصفرية (كما يفعل الـOverlay بدورات المراقبة) ← يبقى صفرًا */
        const r2b = await post({ number: N2, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 1', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2001, cadRunUnitId: 910001 },
            { team: 'جنوب 2', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2002, cadRunUnitId: 910002 },
            { team: 'سريع 2', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2003, cadRunUnitId: 910003 }] });
        s = await sum();
        check('B2b تكرار لقطة الخطة الصفرية ← ما زال صفر مشاركة وصفر إضافة في byCrew',
            r2b.data && (r2b.data.addedCrews || []).length === 0 && dbCount(N2).length === 0
            && ['جنوب 1', 'جنوب 2', 'سريع 2'].every(t => ((s.byCrew || {})[t] || 0) === c0(t)),
            JSON.stringify({ added: r2b.data && r2b.data.addedCrews, rows: dbCount(N2).length }));

        /* ── S3: Available ثم Assigned ← تُحسب عند ثبوت الرحلة ── */
        const N3 = '8' + NB + '3';
        await post({ number: N3, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 4', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2004, cadRunUnitId: 910004 }] });
        check('B3 وحدة الخطة أولًا ← لا مشاركة', dbCount(N3).length === 0);
        const r3 = await post({ number: N3, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 4', phases: { 'قبول': '11:30:00 AM', 'التحرك': '11:31:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 2004, cadRunUnitId: 910004 }] });
        s = await sum();
        check('B3+ بعد ثبوت الرحلة ← مشاركة محتسبة', r3.data && (r3.data.addedCrews || []).indexOf('جنوب 4') !== -1
            && ((s.byCrew || {})['جنوب 4'] || 0) === c0('جنوب 4') + 1);

        /* ── S4: Assigned ثم إلغاء قبل الحركة ← لا تُحسب ── */
        const N4 = '8' + NB + '4';
        await post({ number: N4, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 2', phases: { 'قبول': '11:40:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 2002, cadRunUnitId: 910002 }] });
        await post({ number: N4, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 2', phases: { 'قبول': '11:40:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'B', cadReached: false, cadUnitId: 2002, cadRunUnitId: 910002 }] });
        const rows4 = dbCount(N4);
        s = await sum();
        const cw4 = crewOf(s, N4, 'جنوب 2');
        check('B4 ملغاة قبل الحركة ← موثقة (withdrawn) وغير محتسبة (cancelKind=before-arrival)',
            rows4.length === 1 && rows4[0].withdrawn === 1 && !!cw4 && cw4.counted === false && cw4.cancelKind === 'before-arrival'
            && ((s.byCrew || {})['جنوب 2'] || 0) === c0('جنوب 2'));

        /* ── S5: Assigned ثم تحرك ← تُحسب ── */
        const N5 = '8' + NB + '5';
        await post({ number: N5, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 5', phases: { 'قبول': '11:50:00 AM', 'التحرك': '11:51:00 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 2005, cadRunUnitId: 910005 }] });
        s = await sum();
        check('B5 Assigned + تحرك ← محتسبة', ((s.byCrew || {})['جنوب 5'] || 0) === c0('جنوب 5') + 1);

        /* ── S6: مشاركة فعلية ثم إلغاء بعد المباشرة ← تبقى محتسبة (القاعدة الحالية) ── */
        const N6 = '8' + NB + '6';
        await post({ number: N6, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 7', phases: { 'قبول': '12:00:00 PM', 'التحرك': '12:01:00 PM', 'العلاج': '12:20:00 PM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: true, cadUnitId: 2007, cadRunUnitId: 910007 }] });
        const r6 = await post({ number: N6, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 7', phases: { 'قبول': '12:00:00 PM', 'التحرك': '12:01:00 PM', 'العلاج': '12:20:00 PM' }, phasesSource: 'cad-detail', cadUrs: 'B', cadReached: true, cadUnitId: 2007, cadRunUnitId: 910007 }] });
        s = await sum();
        const cw6 = crewOf(s, N6, 'جنوب 7');
        check('B6 إلغاء بعد المباشرة ← تبقى محتسبة وموثقة after-arrival',
            r6.data && (r6.data.cancelAfterArrivalCrews || []).indexOf('جنوب 7') !== -1
            && !!cw6 && cw6.counted === true && cw6.cancelKind === 'after-arrival'
            && ((s.byCrew || {})['جنوب 7'] || 0) === c0('جنوب 7') + 1, JSON.stringify(cw6));

        /* ── S7: المسار اليدوي لا يتأثر إطلاقًا (بلا هوية CAD وبلا phasesSource) ── */
        const N7 = '8' + NB + '7';
        const r7 = await post({ number: N7, type: 'medical', crews: [{ team: 'جنوب 8' }] });
        s = await sum();
        check('B7 يدوي بلا phases ولا هوية CAD ← يُنشأ ويُحسب كما كان (القاعدة القديمة محفوظة)',
            r7.data && (r7.data.addedCrews || []).indexOf('جنوب 8') !== -1 && (r7.data.planUnitsIgnored || []).length === 0
            && ((s.byCrew || {})['جنوب 8'] || 0) === c0('جنوب 8') + 1, JSON.stringify(r7.data));

        /* ── S8: لقطة صفرية لاحقة على فرقة مشاركة ← لا تسحبها ولا تعدّلها ── */
        const r8 = await post({ number: N5, type: 'medical', source: 'cad-auto', crews: [
            { team: 'جنوب 5', phases: {}, phasesSource: 'cad-detail', cadReached: false, cadUnitId: 2005, cadRunUnitId: 910005 }] });
        const rows8 = dbCount(N5);
        s = await sum();
        check('B8 لقطة خطة صفرية على مشاركة قائمة ← تُتجاهل والمشاركة محفوظة بأوقاتها ومحتسبة',
            r8.data && (r8.data.planUnitsIgnored || []).indexOf('جنوب 5') !== -1
            && rows8.length === 1 && !!rows8[0].phases && rows8[0].phases.includes('التحرك')
            && ((s.byCrew || {})['جنوب 5'] || 0) === c0('جنوب 5') + 1, JSON.stringify(rows8));
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
