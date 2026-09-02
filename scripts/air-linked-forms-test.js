/**
 * ═══ اختبار L-5/L-6 — air-linked-forms-test.js ═══
 * اعتماد المالك 2026-09-02 (دفعة L-4→L-5→L-6 بلا توقف):
 *
 * L-5 (الإسعاف الجوي — الجزء المعتمد فقط):
 *   1) GET /api/cad-reports/south-teams ← 200 + teams:[] (لا مناوبة نشطة في temp)
 *   2) فتح نموذج الجوي: القائمة الثابتة (23 فرقة + placeholder) تبقى — fallback مسار teams فارغة
 *   3) فشل الجلب (!ok) ← القائمة الثابتة تبقى (fallback مسار الخطأ)
 *   4) نجاح الجلب (فرقتان حيتان: سريع 7 · جنوب 99) ← القائمة تُستبدل بالقائمة الحية
 *   5) حفظ طلب جوي بفرقة من القائمة الحية يمر (انحدار saveAirAmbulance)
 *   ملاحظة: ربط airReportNumber بـIncident Lookup موقوف — سؤال تشغيلي غير محسوم (موثق في التقرير).
 *
 * L-6 («النماذج المرتبطة بالبلاغ» في بطاقة البلاغ الحية — عرض فقط):
 *   6) بطاقة 1310627 تعرض شارتين: نموذج E + حادث — ولا تصعيد (تصعيد temp مربوط ببلاغ آخر)
 *   7) سجل e_case قديم بلا incidentNumber لا يظهر (مطابقة تامة)
 *   8) بطاقة 1310628 (بلا نماذج) ← «لا توجد نماذج مرتبطة بهذا البلاغ»
 *   9) صفر أخطاء console/استثناءات طوال الجلسة
 *  10) اللقطات محفوظة (جوي ثابت · جوي حي · بطاقة مرتبطة · بطاقة بلا نماذج)
 *
 * العزل: VACUUM INTO + DATA_DIR مؤقت + أرشفة كل المناوبات في النسخة المؤقتة فقط.
 * التشغيل: node scripts/air-linked-forms-test.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'l56-air-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'l56-air-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'l56-air-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'air-linked-forms-' + STAMP);
const PORT = 3106;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9465;
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

    // ── عزل حتمي: لا مناوبة نشطة في النسخة المؤقتة (south-teams ← teams:[]) ──
    const tmp = new Database(TMP_DB);
    tmp.prepare("UPDATE shifts SET status='archived' WHERE status='active'").run();
    // عينات L-6 في shift_forms — لا تمس قاعدة الإنتاج إطلاقًا
    const insForm = tmp.prepare("INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (NULL, ?, ?, ?, 'l6-fixture')");
    insForm.run('l6-e-1', 'e_case', JSON.stringify({ id: 'l6-e-1', incidentNumber: '1310627', incidentUnit: 'سريع 1', responseTime: 6.8, createdAt: '2026-08-24T15:00:00.000Z' }));
    insForm.run('l6-inc-1', 'incident', JSON.stringify({ id: 'l6-inc-1', incidentNumber: '1310627', incidentUnit: 'سريع 1', createdAt: '2026-08-24T16:00:00.000Z' }));
    insForm.run('l6-esc-1', 'escalation', JSON.stringify({ id: 'l6-esc-1', incidentNumber: '77777777', createdAt: '2026-08-25T10:00:00.000Z' }));
    insForm.run('l6-legacy-1', 'e_case', JSON.stringify({ id: 'l6-legacy-1', reportNumber: 'LEG-NOINC', createdAt: '2026-08-01T09:00:00.000Z' }));
    tmp.close();

    console.log('🚀 خادم معزول على ' + PORT + ' — اختبار L-5 (الجوي) + L-6 (النماذج المرتبطة)');
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

        // ── دخول عبر الواجهة ──
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3500);
        if (await evalJs("!!document.getElementById('loginUsername')")) {
            await evalJs("document.getElementById('loginUsername').value='4252'; document.getElementById('loginPassword').value='4252'; document.getElementById('loginBtn').click(); 'ok'");
            for (let i = 0; i < 20; i++) { await sleep(700); if (await evalJs("!!localStorage.getItem('auth_access_token')")) break; }
        }
        if (await evalJs("!!localStorage.getItem('auth_access_token')") !== true) throw new Error('فشل تسجيل الدخول');
        await sleep(2500);
        await evalJs("window.__alerts=[]; window.alert=function(m){window.__alerts.push(String(m));}; 'ok'");

        // ════════════ L-5 — الإسعاف الجوي ════════════
        // فحص 1: النقطة الحية — بلا مناوبة نشطة ← teams فارغة
        const r1 = await evalJs(`AuthManager.apiRequest('/api/cad-reports/south-teams').then(async r => ({ status: r.status, teams: (await r.json()).teams }))`);
        check('1) south-teams ← 200 + teams:[] (كل المناوبات مؤرشفة في temp)',
            r1 && r1.status === 200 && Array.isArray(r1.teams) && r1.teams.length === 0,
            JSON.stringify(r1).slice(0, 200));

        // فحص 2: فتح النموذج — القائمة الثابتة fallback
        await evalJs("openModalById('formsModal'); loadFormsList(); loadForm('air'); 'ok'");
        let airMounted = false;
        for (let i = 0; i < 30; i++) { await sleep(500); if (await evalJs("!!document.querySelector('#formContent #airUnit')")) { airMounted = true; break; } }
        await sleep(1500); // يعطي loadAirUnitList الحقيقي فرصته (teams:[] ← fallback)
        const airOpts = `(() => { const s = document.querySelector('#formContent #airUnit'); return s ? [...s.options].map(o => o.value) : null; })()`;
        const o2 = await evalJs(airOpts);
        check('2) فتح الجوي بلا مناوبة نشطة: القائمة الثابتة تبقى (fallback — 23 فرقة + placeholder)',
            airMounted === true && o2 && o2.length === 24 && o2[0] === '' && o2.includes('جنوب 14') && o2.includes('سريع 4'),
            'mounted=' + airMounted + ' opts=' + (o2 ? o2.length : 'null'));
        await evalJs("(document.querySelector('#formContent #airUnit') || {scrollIntoView(){}}).scrollIntoView({block:'center'}); 'ok'");
        await sleep(400);
        await shot('shot-1-air-static');

        // فحص 3: فشل الجلب ← fallback
        await evalJs(`(() => {
            window.__origApi = AuthManager.apiRequest.bind(AuthManager);
            AuthManager.apiRequest = function (url, opts) {
                if (String(url).indexOf('south-teams') >= 0) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
                return window.__origApi(url, opts);
            };
            return 'ok'; })()`);
        await evalJs("loadAirUnitList(); 'ok'");
        await sleep(1200);
        const o3 = await evalJs(airOpts);
        check('3) فشل الجلب (!ok) ← القائمة الثابتة تبقى كما هي',
            o3 && o3.length === 24 && o3.includes('جنوب 14'), 'opts=' + (o3 ? o3.length : 'null'));

        // فحص 4: نجاح الجلب ← استبدال بالقائمة الحية
        await evalJs(`(() => {
            AuthManager.apiRequest = function (url, opts) {
                if (String(url).indexOf('south-teams') >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, teams: [{ name: 'سريع 7', status: null }, { name: 'جنوب 99', status: 'active' }] }) });
                return window.__origApi(url, opts);
            };
            return 'ok'; })()`);
        await evalJs("loadAirUnitList(); 'ok'");
        await sleep(1200);
        const o4 = await evalJs(airOpts);
        check('4) نجاح الجلب ← القائمة الحية (placeholder + سريع 7 + جنوب 99 فقط)',
            o4 && o4.length === 3 && o4[0] === '' && o4[1] === 'سريع 7' && o4[2] === 'جنوب 99',
            JSON.stringify(o4));
        await sleep(300);
        await shot('shot-2-air-live');

        // فحص 5: انحدار الحفظ بفرقة حية
        await evalJs(`(() => {
            const fq = id => document.querySelector('#formContent #' + id);
            fq('airReportNumber').value = 'L56-AIR-001';
            fq('airPickupLocation').value = 'موقع اختبار L5';
            fq('airDestinationHospital').value = 'مستشفى الاختبار';
            fq('airUnit').value = 'جنوب 99';
            window.__alerts = [];
            saveAirAmbulance();
            return 'ok'; })()`);
        await sleep(2000);
        const al5 = await evalJs("window.__alerts.join('|')");
        check('5) حفظ طلب جوي بفرقة من القائمة الحية يمر (انحدار saveAirAmbulance)',
            al5.includes('تم حفظ طلب الإسعاف الجوي'), al5.slice(0, 200));
        // استعادة الجلب الأصلي
        await evalJs("AuthManager.apiRequest = window.__origApi; 'ok'");

        // ════════════ L-6 — النماذج المرتبطة بالبلاغ ════════════
        await evalJs("closeFormsModal(); 'ok'").catch(() => { });
        await sleep(600);
        await evalJs(`(() => {
            SmartMap.renderIncidents({ incidents: [
                { number: '1310627', type: 'medical', code: 'TEST1', severity: 'yellow', cadCreatedAt: '24/08/2026 02:36:00 PM', address: 'حي الاختبار L6', lat: 24.61, lng: 46.71, crews: [] },
                { number: '1310628', type: 'medical', code: 'TEST2', severity: 'green', cadCreatedAt: '24/08/2026 03:00:00 PM', address: 'حي الاختبار L6', lat: 24.62, lng: 46.72, crews: [] }
            ] });
            return 'ok'; })()`);
        await sleep(1200);
        await evalJs("SmartMap.focusOn('incident', '1310627'); 'ok'");
        let badges = null;
        for (let i = 0; i < 24; i++) {
            await sleep(500);
            badges = await evalJs(`(() => { const b = document.querySelectorAll('#smapLinkedForms .smap-lf-badge');
                return b.length ? [...b].map(x => x.textContent.trim()) : null; })()`);
            if (badges) break;
        }
        check('6) بطاقة 1310627: شارتا «نموذج E» و«حادث» — ولا شارة تصعيد',
            badges && badges.length === 2
            && badges.some(t => t.includes('نموذج E')) && badges.some(t => t.includes('حادث'))
            && !badges.some(t => t.includes('تصعيد')),
            JSON.stringify(badges));
        check('7) سجل e_case القديم بلا incidentNumber لا يظهر (مطابقة تامة فقط)',
            badges && !badges.some(t => t.includes('LEG-NOINC')) && badges.length === 2,
            JSON.stringify(badges));
        await evalJs("(document.getElementById('smapLinkedForms') || {scrollIntoView(){}}).scrollIntoView({block:'nearest'}); 'ok'");
        await sleep(500);
        await shot('shot-3-card-linked');

        // فحص 8: بلاغ بلا نماذج
        await evalJs("SmartMap.focusOn('incident', '1310628'); 'ok'");
        let emptyTxt = '';
        for (let i = 0; i < 24; i++) {
            await sleep(500);
            emptyTxt = await evalJs(`(() => { const b = document.querySelector('#smapLinkedForms .smap-lf-body');
                return b ? b.textContent.trim() : ''; })()`);
            if (emptyTxt && emptyTxt !== 'جارٍ التحميل…') break;
        }
        check('8) بطاقة 1310628 (بلا نماذج) ← «لا توجد نماذج مرتبطة بهذا البلاغ»',
            emptyTxt.includes('لا توجد نماذج مرتبطة'), emptyTxt.slice(0, 120));
        await sleep(300);
        await shot('shot-4-card-none');

        check('9) صفر أخطاء console/استثناءات طوال الجلسة', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

        const missingShots = ['shot-1-air-static.png', 'shot-2-air-live.png', 'shot-3-card-linked.png', 'shot-4-card-none.png']
            .filter(f => !fs.existsSync(path.join(OUT_DIR, f)));
        check('10) اللقطات الأربع محفوظة (جوي ثابت · جوي حي · بطاقة مرتبطة · بلا نماذج)', missingShots.length === 0, 'missing=' + missingShots.join(','));

        console.log('\n════════════════ نتيجة L-5/L-6: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
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
