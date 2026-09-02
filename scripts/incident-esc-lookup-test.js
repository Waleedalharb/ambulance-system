/**
 * ═══ اختبار L-3 — incident-esc-lookup-test.js ═══
 * اعتماد المالك 2026-09-02 — مواصفة FORMS-LOOKUP-L3-SPEC.md §7 بالقرارات الثلاثة:
 *   (1) حادث بلا فرقة محتسبة = حجب · (2) cadDescription يحفظ أصل CAD · (3) تصعيد partial مسموح
 *   1) فتح حادث: Lookup مركّب + incReportNumber غائب + صفر أخطاء console
 *   2) حادث 1310627: incDateTime/incLocation معبّآن read-only بوسم «من CAD»
 *   3) حادث 1310627: فرقتان محتسبتان + خيار إلزامي + لا اختيار تلقائي
 *   4) حادث 1310420: الملغاتان موسومتان معطّلتان + جنوب 5 تلقائي
 *   5) incType/incCenter يبقيان فارغين يدويين بعد التوثّق — لا اشتقاق من code
 *   6) حادث 99900127: شارة نقص + لا حفظ بلا فرقة محتسبة
 *   7) حادث 0000000: «لا يوجد بلاغ» + حارس الحمولة البالية + لا POST
 *   8) حادث — حفظ فعلي 1310627 بفرقة جنوب 14: يُثبت من shift_forms في temp DB
 *  8ب) إثبات cadDescription: عينة 90000003 — description المعدّل ≠ أصل CAD المحفوظ
 *   9) فتح تصعيد: Lookup مركّب + escReportNumber غائب
 *  10) تصعيد 90000003: تعبئة read-only + escEventType فارغ + escDetails مُعبأة مسبقًا
 *  11) تصعيد — حفظ فعلي بلا فرقة: incidentNumber + eventType يدوي + cadDescription
 *  12) تصعيد 0000000: الحفظ محظور
 *  13) توافق خلفي: سجلّا حادث/تصعيد قديمان يُعرضان بلا كسر
 *  14) انحدار: e-form-lookup-test + incident-lookup-api-test + forms-theme-test
 *  15) اللقطات السبع
 * العزل: VACUUM INTO + DATA_DIR مؤقت. التشغيل: node scripts/incident-esc-lookup-test.js
 * SKIP_REGRESSION=1 يتخطى فحص 14 (تُشغَّل الانحدارات منفصلة).
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'l3-forms-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'l3-forms-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'l3-forms-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'incident-esc-lookup-' + STAMP);
const PORT = 3104;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9461;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CAD_DESC = 'وصف CAD الأصلي للاختبار — حادث تصادم مركبتين';
const EDITED_DESC = 'وصف معدّل من الموظف: إصابتان بسيطتان';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
let ws = null, msgId = 0;
const pending = new Map();
const consoleErrors = [];
function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
}
async function evalJs(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result ? r.result.value : undefined;
}
async function shot(name) {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  📸 ' + name + '.png');
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    // ── عينات temp — لا تمس قاعدة الإنتاج إطلاقًا ──
    const tmp = new Database(TMP_DB);
    tmp.prepare(`INSERT INTO shifts (id, shift_name, shift_date, status, created_at, updated_at)
        VALUES (999999999997, 'مناوبة-اختبار-L3', '2026-09-02', 'archived', '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z')`).run();
    tmp.prepare(`INSERT INTO incident_registry (shift_id, number, code, type, source, created_at, cad_created_at, address, district, street, city, status, description)
        VALUES (999999999997, '90000003', '29D02', 'medical', 'l3-fixture', '2026-09-02T09:00:00.000Z', '02/09/2026 01:30:00 PM', 'طريق الاختبار 77', 'حي النموذج', 'شارع النموذج', 'الرياض', 'active', ?)`).run(CAD_DESC);
    const repL3 = tmp.prepare(`INSERT INTO reports (center, unit, count, created_at, shift_id) VALUES ('اختبار', 'جنوب 7', 1, '2026-09-02T09:05:00.000Z', 999999999997)`).run();
    tmp.prepare(`INSERT INTO report_times (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min, withdrawn, cad_unit_status, cad_reached, cad_unit_id, cad_run_unit_id, manual_cancelled)
        VALUES (?, '2026-09-02T09:05:00.000Z', 'medical', '90000003', ?, 15.0, 16.0, 0, 'ع', 1, 9201, 92011, 0)`)
        .run(repL3.lastInsertRowid, JSON.stringify({ 'قبول': '01:31:00 PM', 'التحرك': '01:33:00 PM', 'البحث': '01:46:00 PM' }));
    // سجلّان قديمان بلا الحقول الجديدة (فحص 13 — توافق خلفي)
    tmp.prepare(`INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (NULL, 'legacy-inc-1', 'incident', ?, 'l3-fixture')`)
        .run(JSON.stringify({ id: 'legacy-inc-1', reportNumber: 'LEGACY-INC-1', dateTime: '2026-08-01T10:00', type: 'تصادم مروري', location: 'موقع حادث قديم', unit: 'جنوب 2', createdAt: '2026-08-01T10:05:00.000Z' }));
    tmp.prepare(`INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (NULL, 'legacy-esc-1', 'escalation', ?, 'l3-fixture')`)
        .run(JSON.stringify({ id: 'legacy-esc-1', reportNumber: 'LEGACY-ESC-1', dateTime: '2026-08-01T11:00', location: 'موقع تصعيد قديم', eventType: 'حريق', injuries: 2, deaths: 0, agencies: [], createdAt: '2026-08-01T11:05:00.000Z' }));
    tmp.close();

    console.log('🚀 خادم معزول على ' + PORT + ' — اختبار L-3 (حادث + تصعيد ← IncidentLookup)');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let chrome = null;
    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');

        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=1280,1000', '--no-first-run', '--disable-gpu',
            '--user-data-dir=' + CHROME_PROFILE, 'about:blank'], { stdio: 'ignore' });
        let targets = null;
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json'); targets = await r.json(); break; } catch (_) { }
        }
        if (!targets) throw new Error('CDP غير متاح');
        const page = targets.find(t => t.type === 'page');
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = ev => {
            try {
                const m = JSON.parse(ev.data);
                if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
                else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 160));
                else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value).join(' ').slice(0, 160));
            } catch (_) { }
        };
        await cdp('Page.enable');
        await cdp('Runtime.enable');
        await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
        await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('aiAssistantVisited','true');}catch(e){}" });

        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3500);
        if (await evalJs("!!document.getElementById('loginUsername')")) {
            await evalJs("document.getElementById('loginUsername').value='4252'; document.getElementById('loginPassword').value='4252'; document.getElementById('loginBtn').click(); 'ok'");
            for (let i = 0; i < 20; i++) { await sleep(700); if (await evalJs("!!localStorage.getItem('auth_access_token')")) break; }
        }
        if (await evalJs("!!localStorage.getItem('auth_access_token')") !== true) throw new Error('فشل تسجيل الدخول');
        await sleep(2500);
        await evalJs("window.__alerts=[]; window.alert=function(m){window.__alerts.push(String(m));}; 'ok'");

        // ════════ نموذج حادث ════════
        await evalJs("openModalById('formsModal'); loadFormsList(); loadForm('incident'); 'ok'");
        let mounted = false;
        for (let i = 0; i < 30; i++) { await sleep(500); if (await evalJs("!!document.querySelector('#incIncidentLookup .il-input')")) { mounted = true; break; } }
        await sleep(600);
        await shot('shot-inc-1-before');
        check('1) حادث: Lookup مركّب + incReportNumber غائب من DOM',
            mounted === true && await evalJs("!document.getElementById('incReportNumber')") === true,
            'mounted=' + mounted);

        async function incSearch(number) {
            await evalJs(`(() => { const i = document.querySelector('#incIncidentLookup .il-input'); i.value = '${number}'; document.querySelector('#incIncidentLookup .il-btn').click(); return 'ok'; })()`);
        }
        async function escSearch(number) {
            await evalJs(`(() => { const i = document.querySelector('#escIncidentLookup .il-input'); i.value = '${number}'; document.querySelector('#escIncidentLookup .il-btn').click(); return 'ok'; })()`);
        }
        async function waitFor(sel, tries = 30) {
            for (let i = 0; i < tries; i++) {
                await sleep(500);
                const s = await evalJs(`(() => { const c = document.querySelector('${sel} .il-card'); const st = document.querySelector('${sel} .il-status');
                    if (c && c.style.display !== 'none') return 'card';
                    if (st && st.style.display !== 'none' && !st.className.includes('busy')) return 'status:' + st.textContent; return ''; })()`);
                if (s) return s;
            }
            return '';
        }
        const incUnitState = `(() => { const s = document.getElementById('incUnit');
            return { value: s.value, disabled: s.disabled,
                enabled: [...s.options].filter(o => !o.disabled).map(o => o.value),
                disabledOpts: [...s.options].filter(o => o.disabled).map(o => o.textContent) }; })()`;
        async function incSelectUnit(u) {
            await evalJs(`(() => { const s = document.getElementById('incUnit'); s.value = '${u}'; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
            await sleep(300);
        }

        // ── حادث 1310627 ──
        await incSearch('1310627');
        const stI = await waitFor('#incIncidentLookup');
        await sleep(800);
        await evalJs("(document.getElementById('incDateTime') || {scrollIntoView(){}}).scrollIntoView({block:'center'}); 'ok'");
        await sleep(400);
        await shot('shot-inc-2-resolve');
        const f2 = await evalJs(`(() => {
            const dt = document.getElementById('incDateTime'), loc = document.getElementById('incLocation');
            const tags = [...document.querySelectorAll('#formContent .e-cad-tag')].map(t => t.textContent);
            return { dtVal: dt.value, dtRO: dt.readOnly, dtTitle: dt.title, locVal: loc.value, locRO: loc.readOnly, tags }; })()`);
        check('2) حادث 1310627: incDateTime/incLocation معبّآن read-only بوسم «من CAD»',
            stI === 'card'
            && f2.dtVal === '2026-08-24T14:36' && f2.dtRO === true && f2.dtTitle.includes('24/08/2026')
            && f2.locVal.includes('الدار البيضاء') && f2.locRO === true
            && f2.tags.filter(t => t === 'من CAD').length === 2,
            JSON.stringify(f2).slice(0, 260));

        const iu3 = await evalJs(incUnitState);
        check('3) حادث: فرقتان محتسبتان + خيار إلزامي + لا اختيار تلقائي',
            iu3.value === '' && iu3.enabled.includes('سريع 1') && iu3.enabled.includes('جنوب 14')
            && iu3.enabled.length === 3 && iu3.disabled === false,
            JSON.stringify(iu3).slice(0, 220));

        // ── حادث 1310420 ──
        await incSearch('1310420');
        await waitFor('#incIncidentLookup');
        await sleep(700);
        const iu4 = await evalJs(incUnitState);
        check('4) حادث 1310420: الملغاتان موسومتان معطّلتان + «جنوب 5» تُختار تلقائيًا',
            iu4.disabledOpts.length === 2 && iu4.disabledOpts.every(t => t.includes('ملغاة'))
            && iu4.value === 'جنوب 5' && iu4.enabled.length === 1,
            JSON.stringify(iu4).slice(0, 220));
        check('5) incType/incCenter يبقيان فارغين يدويين بعد التوثّق — لا اشتقاق من code',
            await evalJs("document.getElementById('incType').value === '' && document.getElementById('incCenter').value === ''") === true);

        // ── حادث 99900127: بلا فرقة محتسبة ──
        await incSearch('99900127');
        const stI6 = await waitFor('#incIncidentLookup');
        await sleep(700);
        await shot('shot-4-missing');
        const f6 = await evalJs(`(() => ({ warn: !!document.querySelector('#incIncidentLookup .il-badge-warn'),
            unitDisabled: document.getElementById('incUnit').disabled,
            unitPH: (document.getElementById('incUnit').options[0] || {}).textContent || '' }))()`);
        await evalJs("document.getElementById('incType').value = 'تصادم مروري'; window.__alerts = []; saveIncident(); 'ok'");
        await sleep(600);
        const al6 = await evalJs("window.__alerts.join('|')");
        check('6) حادث 99900127: شارة نقص + لا فرقة محتسبة + الحفظ محظور',
            stI6 === 'card' && f6.warn === true && f6.unitDisabled === true
            && f6.unitPH.includes('لا توجد فرقة محتسبة') && al6.includes('الفرقة'),
            JSON.stringify({ warn: f6.warn, al6 }).slice(0, 200));

        // ── حادث 0000000: غير موجود ──
        await incSearch('0000000');
        const stI7 = await waitFor('#incIncidentLookup');
        await sleep(400);
        await shot('shot-5-notfound');
        const incBefore = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT COUNT(*) c FROM shift_forms WHERE form_name='incident'").get().c;
        await evalJs("window.__alerts = []; saveIncident(); 'ok'");
        await sleep(800);
        const al7 = await evalJs("window.__alerts.join('|')");
        const incAfter = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT COUNT(*) c FROM shift_forms WHERE form_name='incident'").get().c;
        check('7) حادث 0000000: «لا يوجد بلاغ» + الحفظ محظور ولا يصل POST',
            String(stI7).includes('لا يوجد بلاغ بهذا الرقم') && al7.includes('ابحث عن البلاغ')
            && incAfter === incBefore,
            'st=' + stI7 + ' alert=' + al7 + ' rows=' + incBefore + '→' + incAfter);

        // ── فحص 8: حفظ حادث فعلي 1310627 بفرقة جنوب 14 ──
        await incSearch('1310627');
        await waitFor('#incIncidentLookup');
        await sleep(600);
        await incSelectUnit('جنوب 14');
        await evalJs("(document.getElementById('incUnit') || {scrollIntoView(){}}).scrollIntoView({block:'center'}); 'ok'");
        await sleep(400);
        await shot('shot-inc-3-unit');
        await evalJs(`(() => {
            document.getElementById('incType').value = 'تصادم مروري';
            document.getElementById('incDescription').value = '${EDITED_DESC}';
            return 'ok'; })()`);
        await evalJs("window.__alerts = []; saveIncident(); 'ok'");
        await sleep(1800);
        const al8 = await evalJs("window.__alerts.join('|')");
        const incRows = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT form_data FROM shift_forms WHERE form_name='incident' AND form_data LIKE '%1310627%' ORDER BY id DESC LIMIT 1").all();
        const incSaved = incRows.length ? JSON.parse(incRows[0].form_data) : null;
        check('8) حادث — الحفظ الفعلي مثبت من shift_forms: incidentNumber + incidentUnit=جنوب 14 + type يدوي',
            al8.includes('تم حفظ') && incSaved
            && incSaved.incidentNumber === '1310627' && incSaved.incidentUnit === 'جنوب 14'
            && incSaved.type === 'تصادم مروري' && incSaved.reportNumber === '1310627',
            JSON.stringify(incSaved && { n: incSaved.incidentNumber, u: incSaved.incidentUnit, t: incSaved.type }).slice(0, 200) + ' alert=' + al8);

        // ── فحص 8ب: cadDescription يحفظ أصل CAD والمعدّل منفصلًا ──
        await incSearch('90000003');
        await waitFor('#incIncidentLookup');
        await sleep(700);
        const descPrefill = await evalJs("document.getElementById('incDescription').value");
        const unitAuto = await evalJs("document.getElementById('incUnit').value");
        await evalJs(`(() => {
            document.getElementById('incDescription').value = '${EDITED_DESC}';
            document.getElementById('incType').value = 'تصادم مروري';
            return 'ok'; })()`);
        await evalJs("window.__alerts = []; saveIncident(); 'ok'");
        await sleep(1800);
        const al8b = await evalJs("window.__alerts.join('|')");
        const rowDesc = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT form_data FROM shift_forms WHERE form_name='incident' AND form_data LIKE '%90000003%' ORDER BY id DESC LIMIT 1").get();
        const savedDesc = rowDesc ? JSON.parse(rowDesc.form_data) : null;
        check('8ب) cadDescription = أصل CAD حرفيًا · description = نص الموظف المعدّل — الأصل لا يضيع',
            descPrefill === CAD_DESC && unitAuto === 'جنوب 7' && al8b.includes('تم حفظ')
            && savedDesc && savedDesc.cadDescription === CAD_DESC && savedDesc.description === EDITED_DESC,
            JSON.stringify({ prefill: descPrefill && descPrefill.slice(0, 30), cad: savedDesc && savedDesc.cadDescription, desc: savedDesc && savedDesc.description }).slice(0, 280));

        // ════════ نموذج التصعيد ════════
        await evalJs("loadForm('escalation'); 'ok'");
        let escMounted = false;
        for (let i = 0; i < 30; i++) { await sleep(500); if (await evalJs("!!document.querySelector('#escIncidentLookup .il-input')")) { escMounted = true; break; } }
        await sleep(600);
        await shot('shot-esc-1-before');
        check('9) تصعيد: Lookup مركّب + escReportNumber غائب من DOM',
            escMounted === true && await evalJs("!document.getElementById('escReportNumber')") === true,
            'mounted=' + escMounted);

        // ── تصعيد 90000003 ──
        await escSearch('90000003');
        const stE = await waitFor('#escIncidentLookup');
        await sleep(800);
        await evalJs("(document.getElementById('escDateTime') || {scrollIntoView(){}}).scrollIntoView({block:'center'}); 'ok'");
        await sleep(400);
        await shot('shot-esc-2-resolve');
        const f10 = await evalJs(`(() => {
            const dt = document.getElementById('escDateTime'), loc = document.getElementById('escLocation');
            return { dtVal: dt.value, dtRO: dt.readOnly, locVal: loc.value, locRO: loc.readOnly,
                evType: document.getElementById('escEventType').value,
                details: document.getElementById('escDetails').value }; })()`);
        check('10) تصعيد: تعبئة read-only من CAD + escEventType فارغ يدوي + escDetails مُعبأة مسبقًا',
            stE === 'card' && f10.dtVal === '2026-09-02T13:30' && f10.dtRO === true
            && f10.locVal.includes('حي النموذج') && f10.locRO === true
            && f10.evType === '' && f10.details === CAD_DESC,
            JSON.stringify(f10).slice(0, 260));

        // ── فحص 11: حفظ تصعيد فعلي بلا فرقة ──
        await evalJs(`(() => {
            document.getElementById('escEventType').value = 'حادث تصادم مروري';
            document.getElementById('escDetails').value = '${EDITED_DESC}';
            document.getElementById('escInjuries').value = '2';
            return 'ok'; })()`);
        await evalJs("window.__alerts = []; saveEscalation(); 'ok'");
        await sleep(1800);
        const al11 = await evalJs("window.__alerts.join('|')");
        const escRow = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT form_data FROM shift_forms WHERE form_name='escalation' AND form_data LIKE '%90000003%' ORDER BY id DESC LIMIT 1").get();
        const escSaved = escRow ? JSON.parse(escRow.form_data) : null;
        check('11) تصعيد — الحفظ الفعلي بلا فرقة: incidentNumber + eventType يدوي + cadDescription أصل CAD',
            al11.includes('تم حفظ') && escSaved
            && escSaved.incidentNumber === '90000003' && escSaved.eventType === 'حادث تصادم مروري'
            && escSaved.cadDescription === CAD_DESC && escSaved.details === EDITED_DESC
            && escSaved.injuries === 2,
            JSON.stringify(escSaved && { n: escSaved.incidentNumber, ev: escSaved.eventType }).slice(0, 200) + ' alert=' + al11);

        // ── تصعيد 0000000: محظور ──
        await escSearch('0000000');
        const stE12 = await waitFor('#escIncidentLookup');
        await sleep(400);
        await evalJs("window.__alerts = []; saveEscalation(); 'ok'");
        await sleep(800);
        const al12 = await evalJs("window.__alerts.join('|')");
        check('12) تصعيد 0000000: «لا يوجد بلاغ» + الحفظ محظور',
            String(stE12).includes('لا يوجد بلاغ بهذا الرقم') && al12.includes('ابحث عن البلاغ'),
            'st=' + stE12 + ' alert=' + al12);

        // ── فحص 13: التوافق الخلفي ──
        await evalJs("loadForm('incident'); 'ok'");
        await sleep(1200);
        const incPrev = await evalJs("(document.getElementById('incidentPreviewList') || {}).innerText || ''");
        await evalJs("loadForm('escalation'); 'ok'");
        await sleep(1200);
        const escPrev = await evalJs("(document.getElementById('escalationPreviewList') || {}).innerText || ''");
        check('13) توافق خلفي: سجلّا حادث/تصعيد قديمان يُعرضان بلا كسر',
            incPrev.includes('LEGACY-INC-1') && escPrev.includes('LEGACY-ESC-1'),
            'inc=' + incPrev.slice(0, 60) + ' | esc=' + escPrev.slice(0, 60));

        // صفر أخطاء console طوال الجلسة
        check('1ب) صفر أخطاء console/استثناءات طوال الجلسة', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

        // ── فحص 14: الانحدار ──
        if (process.env.SKIP_REGRESSION !== '1') {
            for (const reg of ['e-form-lookup-test.js', 'incident-lookup-api-test.js', 'forms-theme-test.js']) {
                const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', reg)], { cwd: ROOT, encoding: 'utf8', timeout: 280000, env: { ...process.env, SKIP_REGRESSION: '1' } });
                const tail = (r.stdout || '').trim().split('\n').slice(-2).join(' | ');
                check('14) انحدار أخضر: ' + reg, r.status === 0, (r.status !== 0 ? tail + ' | ' + String(r.stderr || '').slice(0, 160) : tail));
            }
        } else {
            console.log('  ⏭ فحص 14 (الانحدار) مؤجل — يُشغَّل منفصلًا');
        }

        // ── فحص 15: اللقطات السبع ──
        const missingShots = ['shot-inc-1-before.png', 'shot-inc-2-resolve.png', 'shot-inc-3-unit.png', 'shot-4-missing.png', 'shot-5-notfound.png', 'shot-esc-1-before.png', 'shot-esc-2-resolve.png']
            .filter(f => !fs.existsSync(path.join(OUT_DIR, f)));
        check('15) اللقطات السبع محفوظة', missingShots.length === 0, 'missing=' + missingShots.join(','));

        console.log('\n════════════════ نتيجة L-3: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
        console.log('اللقطات: ' + OUT_DIR);
    } finally {
        try { if (chrome) chrome.kill(); } catch (_) { }
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('⚠️ انهيار:', e.message); process.exit(1); });
