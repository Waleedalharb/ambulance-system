/**
 * ═══ اختبار تسجيل خروج بوابة الموظف (قرار المالك 2026-09-05) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت معزول + مستخدم T001 مصطنع — لا تمس الإنتاج.
 *
 * يثبت أن الخروج إبطال خادمي حقيقي وليس مسحًا شكليًا:
 *  1) قبل الخروج: التوكن صالح (profile ← 200)
 *  2) POST /api/auth/logout ← 200
 *  3) التوكن نفسه بعد الخروج ← 401 (محظور — الجلسة القديمة لا تعود صالحة)
 *  4) الجلسة في auth_sessions: is_active=0 + logout_reason='manual_logout'
 *  5) الواجهة: الزر ظاهر في الشريط الثابت ← ضغطه يوجّه إلى '/' + يمسح المفاتيح الستة
 *  6) فتح البوابة مباشرة بعد الخروج ← بطاقة «مطلوب تسجيل الدخول»
 *  7) جلسة منتهية أصلًا (أُبطلت خادميًا قبل الضغط): الزر يكمل المسح والتوجيه بلا خطأ
 *  8) Console = صفر
 *
 * التشغيل: node scripts/my-portal-logout-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'logout-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'logout-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'logout-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'my-portal-logout-' + STAMP);
const PORT = 3127;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9487;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEYS = ['auth_access_token', 'auth_refresh_token', 'auth_user', 'auth_token_expires', 'authToken', 'currentUser'];

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── نسخة معزولة + مستخدم اختبار ──
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }
    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push({ id: 'emp-T001', username: 'T001', name: 'موظف اختبار الخروج', password: hash, role: 'user', isActive: true });
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    dbw.prepare("INSERT INTO employees (employee_code, name, job_title, is_active) VALUES ('T001','موظف اختبار الخروج','فني اسعاف',1)").run();
    dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-T001','ops.my_portal',1,'test')").run();
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — تسجيل خروج البوابة');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    let chrome = null, ws = null, msgId = 0;
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
    async function login(u, p) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        const b = await r.json();
        return b.accessToken || null;
    }
    async function apiGet(path_, tok) {
        const r = await fetch(BASE + path_, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const tok1 = await login('T001', 'test1234');
        if (!tok1) throw new Error('فشل تسجيل الدخول');

        // ── 1) قبل الخروج: التوكن صالح ──
        const before = await apiGet('/api/my/profile', tok1);
        check('1) قبل الخروج: profile ← 200 (الجلسة صالحة)', before.status === 200, 'status=' + before.status);

        // ── 2) الخروج الخادمي ──
        const lo = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + tok1, 'Content-Type': 'application/json' } });
        const loBody = await lo.json().catch(() => ({}));
        check('2) POST /api/auth/logout ← 200 success', lo.status === 200 && loBody.success === true, 'status=' + lo.status);

        // ── 3) الجلسة القديمة لا تعود صالحة ──
        const after = await apiGet('/api/my/profile', tok1);
        check('3) التوكن نفسه بعد الخروج ← 403 TOKEN_REVOKED (إبطال خادمي حقيقي موسوم، لا مسح شكلي)',
            after.status === 403 && after.body.code === 'TOKEN_REVOKED', 'status=' + after.status + ' code=' + after.body.code);

        // ── 4) حالة الجلسة في auth_sessions ──
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            const row = dbx.prepare("SELECT is_active, logout_reason FROM auth_sessions WHERE user_id='emp-T001' ORDER BY id DESC LIMIT 1").get();
            dbx.close();
            check('4) auth_sessions: is_active=0 + logout_reason=manual_logout', !!row && +row.is_active === 0 && row.logout_reason === 'manual_logout', JSON.stringify(row));
        }

        // ── 5) الواجهة: زر ظاهر ← ضغط ← توجيه + مسح ──
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=430,930', '--no-first-run', '--disable-gpu',
            '--user-data-dir=' + CHROME_PROFILE, 'about:blank'], { stdio: 'ignore' });
        let targets = null;
        for (let i = 0; i < 30; i++) { await sleep(500); try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json'); targets = await r.json(); break; } catch (_) { } }
        if (!targets) throw new Error('CDP غير متاح');
        const page = targets.find(t => t.type === 'page');
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = ev => {
            try {
                const m = JSON.parse(ev.data);
                if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
                else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
                else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value).join(' ').slice(0, 200));
            } catch (_) { }
        };
        await cdp('Page.enable'); await cdp('Runtime.enable');

        // جلسة جديدة للمتصفح (tok1 أُبطل في الفحص 2)
        const tok2 = await login('T001', 'test1234');
        if (!tok2) throw new Error('فشل تسجيل الدخول الثاني');
        const inj = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token','${tok2}');}catch(e){}` });
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4000);
        const uiBtn = await evalJs(`(() => { const b = document.getElementById('logoutBtn');
            return b ? { visible: b.style.display !== 'none', text: b.textContent.trim(), inTopbar: !!b.closest('.topbar') } : null; })()`);
        check('5أ) زر «تسجيل الخروج» ظاهر في الشريط العلوي الثابت (ليس قائمة مخفية)', !!uiBtn && uiBtn.visible && uiBtn.inTopbar, JSON.stringify(uiBtn));
        await shot('logout-1-button-visible');

        // نزيل الحاقن حتى لا يعيد كتابة التوكن في الصفحة التالية، ثم نضغط الزر
        await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
        await evalJs(`localStorage.setItem('auth_refresh_token','dummy-refresh'); localStorage.setItem('auth_user','{}'); document.getElementById('logoutBtn').click(); 'clicked'`);
        await sleep(2500);
        const afterClick = await evalJs(`(() => ({
            path: location.pathname,
            leftovers: ${JSON.stringify(KEYS)}.filter(k => localStorage.getItem(k) !== null)
        }))()`);
        check('5ب) الضغط ← توجيه إلى / + مسح المفاتيح الستة كلها', afterClick.path === '/' && afterClick.leftovers.length === 0, JSON.stringify(afterClick));

        // ── 6) فتح البوابة مباشرة بعد الخروج ──
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(2500);
        const direct = await evalJs(`document.body.textContent.includes('مطلوب تسجيل الدخول')`);
        check('6) فتح البوابة مباشرة بلا جلسة ← بطاقة «مطلوب تسجيل الدخول» (لا محتوى قديم)', direct === true);
        await shot('logout-2-direct-open-denied');

        // ── 7) جلسة منتهية أصلًا: أُبطلت خادميًا قبل ضغط الزر — يكمل بلا خطأ ──
        const tok3 = await login('T001', 'test1234');
        if (!tok3) throw new Error('فشل تسجيل الدخول الثالث');
        await evalJs(`localStorage.setItem('auth_access_token','${tok3}'); 'set'`);
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4000);
        // إبطال خادمي مسبق (محاكاة انتهاء/إبطال الجلسة من جهة أخرى) ثم ضغط الزر
        await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + tok3, 'Content-Type': 'application/json' } });
        await evalJs(`document.getElementById('logoutBtn').click(); 'clicked'`);
        await sleep(2500);
        const expired = await evalJs(`(() => ({
            path: location.pathname,
            leftovers: ${JSON.stringify(KEYS)}.filter(k => localStorage.getItem(k) !== null)
        }))()`);
        check('7) جلسة مُبطلة مسبقًا: الزر يكمل المسح والتوجيه بلا خطأ (401 متوقع ومتعامل معه)', expired.path === '/' && expired.leftovers.length === 0, JSON.stringify(expired));

        // ── 8) Console = صفر ──
        check('8) Console = صفر أخطاء طوال المسار', consoleErrors.length === 0, consoleErrors.join(' | '));

        console.log('\n════════════════ نتيجة تسجيل الخروج: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
    } catch (e) {
        failed++;
        console.error('❌ خطأ عام: ' + e.message);
    } finally {
        try { if (ws) ws.close(); } catch (_) { }
        try { if (chrome) chrome.kill(); } catch (_) { }
        try { server.kill(); } catch (_) { }
        for (const p of [TMP_DB, TMP_DIR, CHROME_PROFILE]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { } }
    }
    process.exit(failed ? 1 : 0);
})();
