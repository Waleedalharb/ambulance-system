/**
 * ═══ اختبار L-4 — daily-senior-autofill-test.js ═══
 * اعتماد المالك 2026-09-02 — FORMS-LOOKUP-L4-SPEC.md بالقرارات الخمسة:
 *   S1 رقم اليومي = DAILY-YYYY-MM-DD (معرّف اليوم، read-only، بلا -2)
 *   S2 dailyAir = عدد طلبات الجوي المسجلة في المنصة لهذا اليوم (read-only)
 *   S3 الفرق المستجيبة يدوية · S4 قائمتا كبار المسعفين بالمطابقة التامة + «أخرى» · S5 المركبات يدوية
 *   1) رقم اليومي معرّف اليوم read-only + dailyAir=عدد مزروع فعلي (2 وليس صفرًا ثابتًا)
 *   2) dailyAir يتغير مع البيانات: سجلّان لليوم + قديم مستبعد
 *   3) الفرق المستجيبة يدوية قابلة للتحرير (S3)
 *   4) حفظ يومي فعلي يُثبت من shift_forms (daily_report): reportNumber + air:2 + responseTeams اليدوي
 *   5) قائمة كبير المسعفين = حملة المسمى بالمطابقة التامة فقط + «أخرى»
 *   6) قائمة مساعد كبير المسعفين كذلك
 *   7) senCmdrName يبقى نصًا حرًا فارغًا — لا اشتقاق
 *   8) أعداد المركبات تبقى يدوية قابلة للتحرير — لا اشتقاق من admin_status (S5)
 *   9) حفظ كبار فعلي يُثبت من shift_forms (senior_shift): chief من القائمة + asst عبر «أخرى»
 *  10) الحقول اليدوية تبقى قابلة للتحرير (ملاحظات/توقيعات/مناطق/مسارات)
 *  11) توافق خلفي: سجلا daily_report/senior_shift قديمان يُعرضان بلا كسر
 *  12) صفر أخطاء console
 *  13) انحدار: L-3 + L-2 + L-1 + الثيم (يُتخطى بـSKIP_REGRESSION=1)
 *  14) اللقطات
 * التشغيل: node scripts/daily-senior-autofill-test.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'l4-forms-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'l4-forms-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'l4-forms-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'daily-senior-autofill-' + STAMP);
const PORT = 3105;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9463;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const RIYADH_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

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

    // حملة المسميين من القاعدة الحقيقية (مرجع الفحصين 5/6)
    const ref = new Database(TMP_DB, { readonly: true });
    const chiefs = ref.prepare("SELECT name FROM employees WHERE job_title='كبير مسعفين' AND is_active=1 ORDER BY name").all().map(r => r.name);
    const assts = ref.prepare("SELECT name FROM employees WHERE job_title='مساعد كبير مسعفين' AND is_active=1 ORDER BY name").all().map(r => r.name);
    ref.close();
    if (!chiefs.length || !assts.length) throw new Error('لا يوجد حملة للمسميين في القاعدة — راجع F1');

    // ── عينات temp — لا تمس قاعدة الإنتاج ──
    const tmp = new Database(TMP_DB);
    const nowIso = new Date().toISOString();
    // سجلا جوي لليوم + سجل قديم مستبعد (إثبات أن العدد يتبع البيانات)
    for (let i = 1; i <= 2; i++) {
        tmp.prepare(`INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (NULL, ?, 'air_ambulance', ?, 'l4-fixture')`)
            .run('l4-air-' + i, JSON.stringify({ id: 'l4-air-' + i, reportNumber: 'AIR-T' + i, createdAt: nowIso }));
    }
    tmp.prepare(`INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (NULL, 'l4-air-old', 'air_ambulance', ?, 'l4-fixture')`)
        .run(JSON.stringify({ id: 'l4-air-old', reportNumber: 'AIR-OLD', createdAt: '2026-08-01T10:00:00.000Z' }));
    // سجلان قديمان (توافق خلفي)
    tmp.prepare(`INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (NULL, 'legacy-d-1', 'daily_report', ?, 'l4-fixture')`)
        .run(JSON.stringify({ id: 'legacy-d-1', reportNumber: 'LEGACY-D-1', date: '2026-08-01', responseTeams: 9, air: 1, createdAt: '2026-08-01T10:05:00.000Z' }));
    tmp.prepare(`INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (NULL, 'legacy-s-1', 'senior_shift', ?, 'l4-fixture')`)
        .run(JSON.stringify({ id: 'legacy-s-1', asstName: 'مساعد قديم', chiefName: 'كبير قديم', workingCars: 10, createdAt: '2026-08-01T11:05:00.000Z' }));
    tmp.close();

    console.log('🚀 خادم معزول على ' + PORT + ' — اختبار L-4 (يومي + كبار المسعفين)');
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

        // ════════ نموذج التقرير اليومي ════════
        await evalJs("openModalById('formsModal'); loadFormsList(); loadForm('daily'); 'ok'");
        for (let i = 0; i < 30; i++) { await sleep(500); if (await evalJs("!!document.getElementById('dailyReportNumber')")) break; }
        // انتظار اكتمال اشتقاق بلاغات الجوي (طلب async)
        for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs("document.getElementById('dailyAir').value === '2'")) break; }
        await sleep(400);
        await shot('shot-daily-1');
        const d1 = await evalJs(`(() => {
            const num = document.getElementById('dailyReportNumber'), air = document.getElementById('dailyAir'), teams = document.getElementById('dailyResponseTeams');
            return { num: num.value, numRO: num.readOnly, air: air.value, airRO: air.readOnly,
                teamsRO: teams.readOnly, teamsVal: teams.value, date: document.getElementById('dailyDate').value }; })()`);
        check('1) رقم اليومي = DAILY-' + RIYADH_TODAY + ' (read-only) + dailyAir=2 read-only + التاريخ معبأ',
            d1.num === 'DAILY-' + RIYADH_TODAY && d1.numRO === true
            && d1.air === '2' && d1.airRO === true && d1.date === RIYADH_TODAY,
            JSON.stringify(d1));
        check('2) dailyAir يتبع البيانات فعليًا: سجلّان لليوم محسوبان والقديم مستبعد (ليس صفرًا ثابتًا)',
            d1.air === '2');
        check('3) الفرق المستجيبة يدوية قابلة للتحرير (S3) — لا read-only ولا اشتقاق',
            d1.teamsRO === false && d1.teamsVal === '0', JSON.stringify({ teamsRO: d1.teamsRO, v: d1.teamsVal }));

        // ── حفظ يومي فعلي ──
        await evalJs(`(() => {
            document.getElementById('dailyResponseTeams').value = '7';
            document.getElementById('dailySummary').value = 'ملخص اختبار L-4';
            return 'ok'; })()`);
        await evalJs("window.__alerts = []; saveDailyReport(); 'ok'");
        await sleep(1800);
        const alD = await evalJs("window.__alerts.join('|')");
        const dRow = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT form_data FROM shift_forms WHERE form_name='daily_report' AND form_data LIKE '%DAILY-%' ORDER BY id DESC LIMIT 1").get();
        const dSaved = dRow ? JSON.parse(dRow.form_data) : null;
        check('4) الحفظ اليومي مثبت من shift_forms: reportNumber=معرّف اليوم + air:2 + responseTeams:7 اليدوي',
            alD.includes('تم حفظ') && dSaved
            && dSaved.reportNumber === 'DAILY-' + RIYADH_TODAY && dSaved.air === 2 && dSaved.responseTeams === 7,
            JSON.stringify(dSaved && { n: dSaved.reportNumber, air: dSaved.air, t: dSaved.responseTeams }) + ' alert=' + alD);

        // ════════ نموذج كبار المسعفين ════════
        await evalJs("loadForm('senior'); 'ok'");
        for (let i = 0; i < 30; i++) { await sleep(500); if (await evalJs("!!document.getElementById('senChiefName') && document.getElementById('senChiefName').options.length > 1")) break; }
        await sleep(500);
        await shot('shot-senior-1');
        const chiefOpts = await evalJs("[...document.getElementById('senChiefName').options].map(o => o.value)");
        const asstOpts = await evalJs("[...document.getElementById('senAsstName').options].map(o => o.value)");
        check('5) قائمة كبير المسعفين = حملة المسمى بالمطابقة التامة فقط + «أخرى» (لا مشرف/قائد فريق)',
            JSON.stringify(chiefOpts) === JSON.stringify(['', ...chiefs, '__other__']),
            JSON.stringify(chiefOpts).slice(0, 220));
        check('6) قائمة مساعد كبير المسعفين = حملة المسمى بالمطابقة التامة فقط + «أخرى»',
            JSON.stringify(asstOpts) === JSON.stringify(['', ...assts, '__other__']),
            JSON.stringify(asstOpts).slice(0, 220));

        const s7 = await evalJs(`(() => { const c = document.getElementById('senCmdrName');
            return { tag: c.tagName, type: c.type, value: c.value, ro: c.readOnly }; })()`);
        check('7) senCmdrName يبقى نصًا حرًا فارغًا — لا اشتقاق (لا مسمى «قائد المنطقة» في employees)',
            s7.tag === 'INPUT' && s7.type === 'text' && s7.value === '' && s7.ro === false,
            JSON.stringify(s7));
        const s8 = await evalJs(`(() => { const ids = ['senWorkingCars','senBrokenCars','senReserveCars','senOverlapTeams'];
            return ids.map(id => { const el = document.getElementById(id); return { ro: el.readOnly, v: el.value }; }); })()`);
        check('8) أعداد المركبات يدوية قابلة للتحرير — لا اشتقاق من admin_status (S5)',
            s8.every(x => x.ro === false && x.v === '0'),
            JSON.stringify(s8));

        // ── حفظ كبار فعلي: كبير من القائمة + مساعد عبر «أخرى» ──
        const otherVisibleBefore = await evalJs("document.getElementById('senAsstNameOther').style.display");
        await evalJs(`(() => {
            const chief = document.getElementById('senChiefName');
            chief.value = ${JSON.stringify(chiefs[0])};
            const asst = document.getElementById('senAsstName');
            asst.value = '__other__'; asst.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('senAsstNameOther').value = 'اسم حر اختباري';
            document.getElementById('senWorkingCars').value = '12';
            document.getElementById('senCmdrName').value = 'قائد منطقة يدوي';
            return 'ok'; })()`);
        await sleep(300);
        const otherVisibleAfter = await evalJs("document.getElementById('senAsstNameOther').style.display");
        await shot('shot-senior-2-filled');
        await evalJs("window.__alerts = []; saveSenior(); 'ok'");
        await sleep(1800);
        const alS = await evalJs("window.__alerts.join('|')");
        const sRow = new Database(TMP_DB, { readonly: true })
            .prepare("SELECT form_data FROM shift_forms WHERE form_name='senior_shift' AND form_data LIKE '%اسم حر اختباري%' ORDER BY id DESC LIMIT 1").get();
        const sSaved = sRow ? JSON.parse(sRow.form_data) : null;
        check('9) حفظ كبار مثبت من shift_forms: chief من القائمة + asst عبر «أخرى» + cmdr يدوي + المركبات يدوية',
            alS.includes('تم حفظ') && sSaved
            && sSaved.chiefName === chiefs[0] && sSaved.asstName === 'اسم حر اختباري'
            && sSaved.cmdrName === 'قائد منطقة يدوي' && String(sSaved.workingCars) === '12',
            JSON.stringify(sSaved && { c: sSaved.chiefName, a: sSaved.asstName }).slice(0, 200) + ' alert=' + alS);
        check('10) «أخرى — اسم حر» يُظهر حقل النص عند اختيارها فقط + الحقول اليدوية قابلة للتحرير',
            (otherVisibleBefore === 'none' || otherVisibleBefore === '') && otherVisibleAfter !== 'none'
            && await evalJs("document.getElementById('senNotes').readOnly === false && document.getElementById('senAsstSign').readOnly === false") === true,
            'before=' + otherVisibleBefore + ' after=' + otherVisibleAfter);

        // ── فحص 11: التوافق الخلفي ──
        await evalJs("loadForm('daily'); 'ok'");
        await sleep(1200);
        const dPrev = await evalJs("(document.getElementById('dailyPreviewList') || {}).innerText || ''");
        await evalJs("loadForm('senior'); 'ok'");
        await sleep(1200);
        const sPrev = await evalJs("(document.getElementById('seniorPreviewList') || {}).innerText || ''");
        check('11) توافق خلفي: سجلا اليومي/كبار القديمان يُعرضان بلا كسر',
            dPrev.includes('LEGACY-D-1') && sPrev.includes('كبير قديم'),
            'daily=' + dPrev.slice(0, 60) + ' | senior=' + sPrev.slice(0, 60));

        check('12) صفر أخطاء console/استثناءات طوال الجلسة', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

        // ── فحص 13: الانحدار ──
        if (process.env.SKIP_REGRESSION !== '1') {
            for (const reg of ['incident-esc-lookup-test.js', 'e-form-lookup-test.js', 'incident-lookup-api-test.js', 'forms-theme-test.js']) {
                const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', reg)], { cwd: ROOT, encoding: 'utf8', timeout: 280000, env: { ...process.env, SKIP_REGRESSION: '1' } });
                const tail = (r.stdout || '').trim().split('\n').slice(-2).join(' | ');
                check('13) انحدار أخضر: ' + reg, r.status === 0, (r.status !== 0 ? tail + ' | ' + String(r.stderr || '').slice(0, 160) : tail));
            }
        } else {
            console.log('  ⏭ فحص 13 (الانحدار) مؤجل — يُشغَّل منفصلًا');
        }

        // ── فحص 14: اللقطات ──
        const missingShots = ['shot-daily-1.png', 'shot-senior-1.png', 'shot-senior-2-filled.png']
            .filter(f => !fs.existsSync(path.join(OUT_DIR, f)));
        check('14) اللقطات محفوظة (يومي · كبار فارغ · كبار معبأ)', missingShots.length === 0, 'missing=' + missingShots.join(','));

        console.log('\n════════════════ نتيجة L-4: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
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
