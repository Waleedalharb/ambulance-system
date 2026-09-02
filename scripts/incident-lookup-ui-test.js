/**
 * ═══ اختبار L-1 UI — incident-lookup-ui-test.js ═══
 * اعتماد المالك 2026-09-01 — مواصفة FORMS-LOOKUP-L1-SPEC.md §4.2:
 *   1) تركيب معزول + صفر أخطاء console
 *   2) آلة الحالات الخمس بالنصوص المعتمدة (بحث…/موجود/ناقص/غير موجود/تعذر)
 *   3) بطاقة 1310627: القيم تطابق رد الـAPI حرفيًا
 *   4) صفر حقل قابل للكتابة داخل بطاقة بيانات CAD (فحص DOM)
 *   5) زمن غير متاح يظهر «غير متاح» ولا يظهر «0 دقيقة» إطلاقًا
 *   6) شارة تعدد المناوبات لـ1300370
 *   7) الثيم الداكن: صفر أسطح فاتحة + لقطات الحالات
 * التركيب معزول: المكوّن يُحقن برمجيًا في حاوية اختبار — لا يُحمَّل في index.html.
 * التشغيل: node scripts/incident-lookup-ui-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'l1-ui-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'l1-ui-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'l1-ui-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'incident-lookup-ui-' + STAMP);
const PORT = 3102;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9457;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 260) : '')); }
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
    console.log('🚀 خادم معزول على ' + PORT + ' — اختبار L-1 UI');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let chrome = null;
    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        // مرجع الـAPI للمقارنة الحرفية (فحص 3)
        const loginR = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '4252', password: '4252' }) });
        const token = (await loginR.json()).accessToken;
        const apiRef = await (await fetch(BASE + '/api/incidents/lookup?number=1310627', { headers: { 'Authorization': 'Bearer ' + token } })).json();

        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=1200,900', '--no-first-run', '--disable-gpu',
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
        check('تسجيل الدخول', await evalJs("!!localStorage.getItem('auth_access_token')") === true);
        await sleep(3000);

        // ── تركيب معزول: حاوية اختبار + حقن CSS/JS للمكوّن ──
        await evalJs(`(async () => {
            const css = await fetch('/css/incident-lookup.css').then(r => r.text());
            const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
            const js = await fetch('/js/incident-lookup.js').then(r => r.text());
            (0, eval)(js);
            const host = document.createElement('div');
            host.id = 'il-test-host';
            host.style.cssText = 'position:fixed;inset:40px;z-index:99999;background:#0B1220;border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:20px;overflow-y:auto;max-width:640px;margin:0 auto;';
            document.body.appendChild(host);
            window.__il = window.IncidentLookup.mount(host, {});
            return 'mounted';
        })()`);
        check('1) تركيب معزول + IncidentLookup متاح', await evalJs("!!window.IncidentLookup && !!window.__il && !!document.querySelector('#il-test-host .il-input')") === true);

        async function search(number) {
            await evalJs(`(() => { const i = document.querySelector('#il-test-host .il-input'); i.value = '${number}'; document.querySelector('#il-test-host .il-btn').click(); return 'ok'; })()`);
        }
        async function waitCardOrStatus(tries = 30) {
            for (let i = 0; i < tries; i++) {
                await sleep(500);
                const s = await evalJs(`(() => { const c = document.querySelector('#il-test-host .il-card'); const st = document.querySelector('#il-test-host .il-status');
                    if (c && c.style.display !== 'none') return 'card';
                    if (st && st.style.display !== 'none' && !st.className.includes('busy')) return 'status:' + st.textContent; return ''; })()`);
                if (s) return s;
            }
            return '';
        }

        // ── حالة «جارٍ البحث…» (fetch مؤجل) ──
        await evalJs(`(() => { const of = window.fetch; window.__of = of; window.fetch = (u, o) => String(u).includes('/api/incidents/lookup') ? new Promise(r => setTimeout(() => r(of(u, o)), 4000)) : of(u, o); return 'ok'; })()`);
        await search('1310627');
        await sleep(1200);
        const busyTxt = await evalJs("document.querySelector('#il-test-host .il-status').textContent");
        const busyLocked = await evalJs("document.querySelector('#il-test-host .il-input').disabled && document.querySelector('#il-test-host .il-btn').disabled");
        await shot('state-1-busy');
        check('2أ) حالة «جارٍ البحث…» + قفل الإدخال أثناءها', busyTxt === 'جارٍ البحث…' && busyLocked === true, busyTxt);
        await evalJs("window.fetch = window.__of; 'ok'");

        // ── بطاقة بلاغ حقيقي (1310627 — كامل، فرقتان) ──
        await search('1310627');
        const st1 = await waitCardOrStatus();
        await sleep(800);
        await shot('state-2-found');
        check('2ب) حالة «✓ تم العثور على البلاغ»', st1 === 'card' && await evalJs("!!document.querySelector('#il-test-host .il-badge-ok')"), st1);

        // فحص 3: القيم تطابق الـAPI حرفيًا
        const dom2 = await evalJs(`(() => {
            const host = document.getElementById('il-test-host');
            const rows = [...host.querySelectorAll('.il-row')].map(r => r.innerText);
            return { rows, best: (host.querySelector('.il-best') || {}).textContent || '', text: host.innerText.slice(0, 400) };
        })()`);
        const unitsOk = apiRef.units.every(u => dom2.text.includes(u.unit));
        const bestOk = dom2.best.includes('6.8');
        const cadOk = dom2.rows.some(r => r.includes(apiRef.incident.cadCreatedAtRaw));
        check('3) البطاقة تعرض رقم البلاغ + خام CAD + الفرقتين + الأسرع 6.8 مطابقةً للـAPI',
            dom2.text.includes('1310627') && cadOk && unitsOk && bestOk, JSON.stringify(dom2).slice(0, 220));

        // فحص 4: صفر حقول قابلة للكتابة داخل بطاقة بيانات CAD
        const writable = await evalJs("document.querySelectorAll('#il-test-host .il-card input:not([disabled]), #il-test-host .il-card textarea, #il-test-host .il-card select, #il-test-host .il-card [contenteditable=\"true\"]').length");
        check('4) صفر حقل قابل للكتابة داخل البطاقة (read-only ببنية DOM)', writable === 0, 'count=' + writable);

        // ── بلاغ ناقص الأزمنة (99900127 — بلا cad_created_at) ──
        await search('99900127');
        const st2 = await waitCardOrStatus();
        await sleep(800);
        await shot('state-3-partial');
        const partial = await evalJs(`(() => { const host = document.getElementById('il-test-host');
            return { warn: !!host.querySelector('.il-badge-warn'), txt: host.innerText }; })()`);
        check('2ج) حالة «⚠️ موجود لكن بياناته الزمنية غير مكتملة»', st2 === 'card' && partial.warn === true, st2);
        check('5) «غير متاح — بيانات CAD ناقصة» تظهر و«0 دقيقة» لا تظهر إطلاقًا',
            partial.txt.includes('غير متاح') && !/\\b0 دقيقة/.test(partial.txt) && !partial.txt.includes('صفر'),
            partial.txt.slice(0, 180));

        // ── تعدد المناوبات (1300370) ──
        await search('1300370');
        const st3 = await waitCardOrStatus();
        await sleep(800);
        await shot('state-4-duplicate');
        const dup = await evalJs("(() => { const d = document.querySelector('#il-test-host .il-dup'); return d ? d.textContent : null; })()");
        check('6) شارة تعدد المناوبات لـ1300370', st3 === 'card' && !!dup && dup.includes('ظهر أيضًا'), String(dup));

        // ── غير موجود (0000000) ──
        await search('0000000');
        const st4 = await waitCardOrStatus();
        await shot('state-5-notfound');
        check('2د) حالة «✗ لا يوجد بلاغ بهذا الرقم»', String(st4).includes('لا يوجد بلاغ بهذا الرقم'), st4);

        // ── تعذر البحث (fetch يرفض) ──
        await evalJs("(() => { window.fetch = () => Promise.reject(new Error('offline-sim')); return 'ok'; })()");
        await search('1310627');
        const st5 = await waitCardOrStatus();
        await shot('state-6-error');
        await evalJs("window.fetch = window.__of; 'ok'");
        check('2هـ) حالة «✗ تعذر البحث — تحقق من الاتصال»', String(st5).includes('تعذر البحث'), st5);

        // ── فحص 7: الثيم الداكن على البطاقة ──
        await search('1310627');
        await waitCardOrStatus();
        await sleep(800);
        const theme = await evalJs(`(() => {
            const host = document.getElementById('il-test-host');
            const parse = s => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(s || ''); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
            const lum = c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
            let white = 0, darkText = 0;
            for (const el of host.querySelectorAll('*')) {
                const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) continue;
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                const bg = parse(cs.backgroundColor);
                if (bg && bg.a > 0.8 && lum(bg) > 180 && r.width > 40 && r.height > 14) white++;
                const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
                if (ownText) { const tc = parse(cs.color); if (tc && lum(tc) < 100) darkText++; }
            }
            return { white, darkText };
        })()`);
        check('7) ثيم داكن: صفر أسطح فاتحة + صفر نص داكن داخل المكوّن', theme.white === 0 && theme.darkText === 0, JSON.stringify(theme));

        // فحص 1 (تكملة): صفر أخطاء console/استثناءات طوال الجلسة
        check('1ب) صفر أخطاء console/استثناءات', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

        console.log('\n════════════════ نتيجة L-1 UI: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
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
