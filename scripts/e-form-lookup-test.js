/**
 * ═══ اختبار L-2 — e-form-lookup-test.js ═══
 * اعتماد المالك 2026-09-02 — مواصفة FORMS-LOOKUP-L2-SPEC.md §7:
 *   1) فتح نموذج E: مكوّن Lookup موجود + eResponseTime اليدوي غائب من DOM + صفر أخطاء console
 *   2) بحث 1310627 ← eDateTime/eLocation معبّآن read-only من CAD + وسم «من CAD»
 *   3) تعدد الفرق: فرقتان محتسبتان، لا اختيار تلقائي، الزمن يتبع الاختيار (سريع 1 ← 6.8 · جنوب 14 ← 26)
 *   4) 1310420: الملغاة يدويًا موسومة ومعطّلة — لا يمكن اختيارها
 *   5) فرقة واحدة محتسبة (جنوب 5) ← اختيار تلقائي
 *   6) 99900127: شارة النقص + «غير متاح» + «0 دقيقة» لا تظهر + لا حفظ بلا فرقة محتسبة
 *   7) 0000000: «لا يوجد بلاغ» + الحفظ محظور (حارس الحمولة البالية) + لا POST
 *   8) حفظ فعلي ×2 يُثبت من shift_forms في temp DB:
 *      سريع 1 ← responseTime 6.8 · جنوب 14 ← 26 (وليس bestArrivalMin) · responseTimeSource:'cad-central'
 *   9) عينة temp 90000002 (فرقة محتسبة بلا زمن): الحفظ يمر بـ responseTime:null + 'cad-unavailable'
 *  10) سجل قديم بلا الحقول الجديدة يُعرض في «الحالات المحفوظة» بلا كسر
 *  11) انحدار: incident-lookup-api-test + forms-theme-test أخضران
 *  12) لقطات: قبل البحث · بعد الربط · اختيار الفرقة · نقص · غير موجود
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت حر. التشغيل: node scripts/e-form-lookup-test.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'l2-eform-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'l2-eform-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'l2-eform-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'e-form-lookup-' + STAMP);
const PORT = 3103;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9459;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
    const p = path.join(OUT_DIR, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
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

    // ── عينات temp (فحص 9 + 10) — لا تمس قاعدة الإنتاج إطلاقًا ──
    const tmp = new Database(TMP_DB);
    tmp.prepare(`INSERT INTO shifts (id, shift_name, shift_date, status, created_at, updated_at)
        VALUES (999999999998, 'مناوبة-اختبار-L2', '2026-09-02', 'archived', '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z')`).run();
    tmp.prepare(`INSERT INTO incident_registry (shift_id, number, code, type, source, created_at, cad_created_at, address, district, status)
        VALUES (999999999998, '90000002', '32B03', 'medical', 'l2-fixture', '2026-09-02T09:00:00.000Z', '02/09/2026 12:00:00 PM', 'حي الاختبار L2', 'الاختبار', 'active')`).run();
    const repN = tmp.prepare(`INSERT INTO reports (center, unit, count, created_at, shift_id) VALUES ('اختبار', 'فرقة-بلا-زمن', 1, '2026-09-02T09:05:00.000Z', 999999999998)`).run();
    // محتسبة (لا withdrawn ولا manual_cancelled) لكن resp_arrival_min = NULL
    tmp.prepare(`INSERT INTO report_times (report_id, timestamp, type, incident_number, phases, resp_arrival_min, resp_mubashara_min, withdrawn, cad_unit_status, cad_reached, cad_unit_id, cad_run_unit_id, manual_cancelled)
        VALUES (?, '2026-09-02T09:05:00.000Z', 'medical', '90000002', ?, NULL, NULL, 0, 'ع', 1, 9101, 91011, 0)`)
        .run(repN.lastInsertRowid, JSON.stringify({ 'قبول': '12:01:00 PM', 'التحرك': '12:02:00 PM' }));
    // سجل e_case قديم بلا الحقول الجديدة (فحص 10 — توافق خلفي)
    tmp.prepare(`INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by)
        VALUES (NULL, 'legacy-e-1', 'e_case', ?, 'l2-fixture')`)
        .run(JSON.stringify({ id: 'legacy-e-1', reportNumber: 'LEGACY-77', dateTime: '2026-08-01T10:00', location: 'موقع قديم', unit: 'جنوب 3', outcome: 'نُقلت للمستشفى', createdAt: '2026-08-01T10:05:00.000Z' }));
    tmp.close();

    console.log('🚀 خادم معزول على ' + PORT + ' — اختبار L-2 (نموذج E ← IncidentLookup)');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let chrome = null;
    const shots = [];
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

        // ── دخول عبر الواجهة ──
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3500);
        if (await evalJs("!!document.getElementById('loginUsername')")) {
            await evalJs("document.getElementById('loginUsername').value='4252'; document.getElementById('loginPassword').value='4252'; document.getElementById('loginBtn').click(); 'ok'");
            for (let i = 0; i < 20; i++) { await sleep(700); if (await evalJs("!!localStorage.getItem('auth_access_token')")) break; }
        }
        if (await evalJs("!!localStorage.getItem('auth_access_token')") !== true) throw new Error('فشل تسجيل الدخول');
        await sleep(2500);
        // التقاط التنبيهات بدل الحوارات (headless)
        await evalJs("window.__alerts=[]; window.alert=function(m){window.__alerts.push(String(m));}; 'ok'");

        // ── فتح نموذج E ──
        await evalJs("openModalById('formsModal'); loadFormsList(); loadForm('e'); 'ok'");
        let mounted = false;
        for (let i = 0; i < 30; i++) { await sleep(500); if (await evalJs("!!document.querySelector('#eIncidentLookup .il-input')")) { mounted = true; break; } }
        await sleep(600);
        await shot('shot-1-before-search'); shots.push('shot-1-before-search.png');
        check('1) نموذج E: مكوّن Lookup مركّب + eResponseTime اليدوي غائب + عرض الزمن موجود',
            mounted === true
            && await evalJs("!document.getElementById('eResponseTime') && !!document.getElementById('eResponseTimeView')") === true,
            'mounted=' + mounted);

        // ── أدوات مساعدة داخل الصفحة ──
        async function search(number) {
            await evalJs(`(() => { const i = document.querySelector('#eIncidentLookup .il-input'); i.value = '${number}'; document.querySelector('#eIncidentLookup .il-btn').click(); return 'ok'; })()`);
        }
        async function waitCardOrStatus(tries = 30) {
            for (let i = 0; i < tries; i++) {
                await sleep(500);
                const s = await evalJs(`(() => { const c = document.querySelector('#eIncidentLookup .il-card'); const st = document.querySelector('#eIncidentLookup .il-status');
                    if (c && c.style.display !== 'none') return 'card';
                    if (st && st.style.display !== 'none' && !st.className.includes('busy')) return 'status:' + st.textContent; return ''; })()`);
                if (s) return s;
            }
            return '';
        }
        const unitState = `(() => { const s = document.getElementById('eUnit');
            return { value: s.value, disabled: s.disabled,
                enabled: [...s.options].filter(o => !o.disabled).map(o => o.value),
                disabledOpts: [...s.options].filter(o => o.disabled).map(o => o.textContent),
                view: (document.getElementById('eResponseTimeView') || {}).textContent || '' }; })()`;
        async function selectUnit(u) {
            await evalJs(`(() => { const s = document.getElementById('eUnit'); s.value = '${u}'; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
            await sleep(300);
        }

        // ── بحث 1310627 (فرقتان محتسبتان) ──
        await search('1310627');
        const st1 = await waitCardOrStatus();
        await sleep(800);
        await evalJs("(document.getElementById('eDateTime') || {scrollIntoView(){}}).scrollIntoView({block:'center'}); 'ok'");
        await sleep(400);
        await shot('shot-2-after-resolve'); shots.push('shot-2-after-resolve.png');
        const f2 = await evalJs(`(() => {
            const dt = document.getElementById('eDateTime'), loc = document.getElementById('eLocation');
            const tags = [...document.querySelectorAll('#formContent .e-cad-tag')].map(t => t.textContent);
            return { st: ${JSON.stringify('')}, dtVal: dt.value, dtRO: dt.readOnly, dtTitle: dt.title,
                locVal: loc.value, locRO: loc.readOnly, tags }; })()`);
        check('2) 1310627: eDateTime/eLocation معبّآن read-only من CAD + وسم «من CAD»',
            st1 === 'card'
            && f2.dtVal === '2026-08-24T14:36' && f2.dtRO === true && f2.dtTitle.includes('24/08/2026')
            && f2.locVal.includes('الدار البيضاء') && f2.locRO === true
            && f2.tags.filter(t => t === 'من CAD').length === 2,
            JSON.stringify(f2).slice(0, 260));

        const u3a = await evalJs(unitState);
        check('3أ) تعدد الفرق: فرقتان محتسبتان + خيار إلزامي + لا اختيار تلقائي',
            u3a.value === '' && u3a.enabled.includes('سريع 1') && u3a.enabled.includes('جنوب 14')
            && u3a.enabled.length === 3 && u3a.disabled === false,
            JSON.stringify(u3a).slice(0, 220));
        await selectUnit('سريع 1');
        const u3b = await evalJs(unitState);
        await selectUnit('جنوب 14');
        const u3c = await evalJs(unitState);
        await evalJs("(document.getElementById('eUnit') || {scrollIntoView(){}}).scrollIntoView({block:'center'}); 'ok'");
        await sleep(400);
        await shot('shot-3-unit-select'); shots.push('shot-3-unit-select.png');
        check('3ب) الزمن يتبع الاختيار: سريع 1 ← 6.8 · جنوب 14 ← 26 (وليس الأسرع)',
            u3b.view.includes('6.8') && u3b.view.includes('12')
            && u3c.view.includes('26') && !u3c.view.includes('6.8'),
            'سريع1=' + u3b.view + ' | جنوب14=' + u3c.view);

        // ── 1310420: ملغاة يدويًا + فرقة محتسبة واحدة ──
        await search('1310420');
        await waitCardOrStatus();
        await sleep(800);
        const u4 = await evalJs(unitState);
        check('4) الملغاة يدويًا موسومة ومعطّلة — لا يمكن اختيارها (البلاغ فيه ملغاتان)',
            u4.disabledOpts.length === 2 && u4.disabledOpts.every(t => t.includes('ملغاة')),
            JSON.stringify(u4.disabledOpts));
        check('5) فرقة واحدة محتسبة (جنوب 5) ← اختيار تلقائي + زمنها 20',
            u4.value === 'جنوب 5' && u4.enabled.length === 1 && u4.view.includes('20'),
            'value=' + u4.value + ' view=' + u4.view);

        // ── 99900127: بيانات زمنية ناقصة ──
        await search('99900127');
        const st6 = await waitCardOrStatus();
        await sleep(800);
        await shot('shot-4-missing'); shots.push('shot-4-missing.png');
        const f6 = await evalJs(`(() => { const host = document.getElementById('formContent');
            return { warn: !!host.querySelector('.il-badge-warn'), txt: host.innerText,
                unitDisabled: document.getElementById('eUnit').disabled,
                unitPH: (document.getElementById('eUnit').options[0] || {}).textContent || '' }; })()`);
        const noZero = !/\b0 دقيقة/.test(f6.txt) && !f6.txt.includes('صفر');
        check('6) 99900127: شارة النقص + «غير متاح» + «0 دقيقة» لا تظهر إطلاقًا',
            st6 === 'card' && f6.warn === true && f6.txt.includes('غير متاح') && noZero
            && f6.unitDisabled === true && f6.unitPH.includes('لا توجد فرقة محتسبة'),
            JSON.stringify({ warn: f6.warn, unitPH: f6.unitPH }).slice(0, 200));
        // لا حفظ بلا فرقة محتسبة
        await evalJs("window.__alerts = []; saveE(); 'ok'");
        await sleep(600);
        const al6 = await evalJs("window.__alerts.join('|')");
        check('6ب) لا فرقة محتسبة = لا حفظ (تنبيه حجب)', al6.includes('الفرقة') || al6.includes('ابحث'), al6);

        // ── 0000000: غير موجود + حارس الحمولة البالية ──
        await search('0000000');
        const st7 = await waitCardOrStatus();
        await sleep(400);
        await shot('shot-5-notfound'); shots.push('shot-5-notfound.png');
        const countBefore = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT COUNT(*) c FROM shift_forms WHERE form_name='e_case'").get().c;
        await evalJs("window.__alerts = []; saveE(); 'ok'");
        await sleep(800);
        const al7 = await evalJs("window.__alerts.join('|')");
        const countAfter = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT COUNT(*) c FROM shift_forms WHERE form_name='e_case'").get().c;
        check('7) 0000000: «لا يوجد بلاغ» + الحفظ محظور ولا يصل POST',
            String(st7).includes('لا يوجد بلاغ بهذا الرقم') && al7.includes('ابحث عن البلاغ')
            && countAfter === countBefore,
            'st=' + st7 + ' alert=' + al7 + ' rows=' + countBefore + '→' + countAfter);

        // ── فحص 8: حفظ فعلي ×2 وإثبات من temp DB ──
        await search('1310627');
        await waitCardOrStatus();
        await sleep(600);
        await evalJs(`(() => {
            document.getElementById('eAge').value = '55';
            document.getElementById('eGender').value = 'ذكر';
            document.getElementById('eHospital').value = 'مستشفى الاختبار';
            document.getElementById('eOutcome').value = [...document.getElementById('eOutcome').options].map(o => o.value).find(v => v) || '';
            return 'ok'; })()`);
        await selectUnit('سريع 1');
        await evalJs("window.__alerts = []; saveE(); 'ok'");
        await sleep(1800);
        const al8a = await evalJs("window.__alerts.join('|')");
        // حفظ ثانٍ بنفس البلاغ لكن بفرقة جنوب 14
        await search('1310627');
        await waitCardOrStatus();
        await sleep(600);
        await selectUnit('جنوب 14');
        await evalJs("window.__alerts = []; saveE(); 'ok'");
        await sleep(1800);
        const al8b = await evalJs("window.__alerts.join('|')");
        const saved = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT form_data FROM shift_forms WHERE form_name='e_case' AND form_data LIKE '%1310627%' ORDER BY id DESC LIMIT 2").all()
            .map(r => JSON.parse(r.form_data));
        const sA = saved.find(r => r.incidentUnit === 'سريع 1') || {};
        const sB = saved.find(r => r.incidentUnit === 'جنوب 14') || {};
        check('8) الحفظ الفعلي: incidentNumber + incidentUnit + responseTime + source مثبتة من shift_forms',
            al8a.includes('تم حفظ') && al8b.includes('تم حفظ')
            && sA.incidentNumber === '1310627' && sA.responseTime === 6.8 && sA.responseTimeSource === 'cad-central'
            && sB.incidentNumber === '1310627' && sB.responseTime === 26 && sB.responseTimeSource === 'cad-central',
            JSON.stringify({ a: { u: sA.incidentUnit, t: sA.responseTime, s: sA.responseTimeSource }, b: { u: sB.incidentUnit, t: sB.responseTime, s: sB.responseTimeSource }, al8a, al8b }).slice(0, 300));

        // ── فحص 9: فرقة محتسبة بلا زمن (90000002) ──
        await search('90000002');
        const st9 = await waitCardOrStatus();
        await sleep(600);
        const u9 = await evalJs(unitState);
        await evalJs("window.__alerts = []; saveE(); 'ok'");
        await sleep(1800);
        const al9 = await evalJs("window.__alerts.join('|')");
        const row9raw = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT form_data FROM shift_forms WHERE form_name='e_case' AND form_data LIKE '%90000002%' ORDER BY id DESC LIMIT 1").get();
        const row9 = row9raw ? JSON.parse(row9raw.form_data) : null;
        check('9) فرقة بلا زمن: الحفظ يمر بـ responseTime:null + cad-unavailable — لا صفر',
            st9 === 'card' && u9.value === 'فرقة-بلا-زمن' && u9.view.includes('غير متاح')
            && al9.includes('تم حفظ')
            && row9 && row9.responseTime === null && row9.responseTimeSource === 'cad-unavailable'
            && row9.incidentUnit === 'فرقة-بلا-زمن',
            JSON.stringify({ view: u9.view, row9: row9 && { t: row9.responseTime, s: row9.responseTimeSource }, al9 }).slice(0, 300));

        // ── فحص 10: سجل قديم بلا الحقول الجديدة ──
        await evalJs("loadERecords(); 'ok'");
        await sleep(1500);
        const previewTxt = await evalJs("(document.getElementById('ePreviewList') || {}).innerText || ''");
        check('10) سجل e_case قديم (LEGACY-77) يُعرض في القائمة بلا كسر',
            previewTxt.includes('LEGACY-77') && previewTxt.includes('موقع قديم'),
            previewTxt.slice(0, 160));

        // صفر أخطاء console طوال الجلسة
        check('1ب) صفر أخطاء console/استثناءات طوال الجلسة', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

        // ── فحص 11: الانحدار ──
        for (const reg of ['incident-lookup-api-test.js', 'forms-theme-test.js']) {
            const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', reg)], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
            const tail = (r.stdout || '').trim().split('\n').slice(-2).join(' | ');
            check('11) انحدار أخضر: ' + reg, r.status === 0, (r.status !== 0 ? tail + ' | ' + String(r.stderr || '').slice(0, 160) : tail));
        }

        // ── فحص 12: اللقطات الخمس ──
        const missingShots = ['shot-1-before-search.png', 'shot-2-after-resolve.png', 'shot-3-unit-select.png', 'shot-4-missing.png', 'shot-5-notfound.png']
            .filter(f => !fs.existsSync(path.join(OUT_DIR, f)));
        check('12) اللقطات الخمس محفوظة (قبل · ربط · فرقة · نقص · غير موجود)', missingShots.length === 0, 'missing=' + missingShots.join(','));

        console.log('\n════════════════ نتيجة L-2: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
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
