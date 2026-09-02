/**
 * ═══ تحقيق السبب الجذري للبطء — perf-rootcause-probe.js ═══
 * مرحلة Investigation فقط (اعتماد المالك 2026-09-02 — وثيقة «Performance Root Cause»).
 * صفر تعديل على أي كود موجود: هذا الملف مضاف جديد، يقيس ولا يغيّر.
 *
 * يقلع بخادم معزول (نسخة temp من قاعدة الإنتاج) ويقيس على مدى ~4.5 دقيقة مضغوطة:
 *   - RSS لعملية الخادم (PowerShell Get-Process — قراءة OS فقط)
 *   - زمن الاستجابة + حجم الرد لنقاط Polling الحقيقية: last-update(3s)/peak-data(10s)/current-shift(60s)/data
 *   - مقاييس المتصفح عبر CDP: JSHeapUsedSize · DOM Nodes · JSEventListeners
 *   - سيناريو A: تصفح متكرر بين النماذج والمودالات (بدون لمس الخريطة)
 *   - سيناريو B: تفاعل خريطة متكرر (renderIncidents ببيانات متغيرة + فتح/إغلاق بطاقات)
 * ثم يطبع جدول: بداية ← منتصف ← نهاية، لكشف أي مورد يتراكم.
 *
 * التشغيل: node scripts/perf-rootcause-probe.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'perf-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'perf-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'perf-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'perf-rootcause-' + STAMP);
const PORT = 3107;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9467;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
function serverRssMb(pid) {
    try {
        const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10000 });
        // "node.exe","1234","Console","1","123,456 K"
        const m = String(r.stdout).match(/"([\d,\.]+)\s*K"/);
        if (!m) return null;
        return Math.round(parseFloat(m[1].replace(/,/g, '')) / 1024 * 10) / 10;
    } catch (_) { return null; }
}
async function timeEndpoint(token, url, tag) {
    const t0 = process.hrtime.bigint();
    let status = 0, bytes = 0;
    try {
        const r = await fetch(BASE + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
        status = r.status;
        const buf = await r.arrayBuffer();
        bytes = buf.byteLength;
    } catch (_) { }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { tag, ms: Math.round(ms * 10) / 10, status, bytes };
}
function stats(arr) {
    if (!arr.length) return { avg: 0, p95: 0, max: 0 };
    const s = arr.slice().sort((a, b) => a - b);
    return {
        avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10) / 10,
        p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
        max: s[s.length - 1]
    };
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

    console.log('🚀 خادم معزول على ' + PORT + ' — تحقيق الأداء (قراءة/قياس فقط)');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let chrome = null;
    const timeline = [];
    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const tStart = Date.now();

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
            } catch (_) { }
        };
        await cdp('Page.enable');
        await cdp('Runtime.enable');
        await cdp('Performance.enable');
        await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
        await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('aiAssistantVisited','true');}catch(e){}" });

        // دخول عبر الواجهة — التطبيق يبدأ Polling الحقيقي (3s/10s/60s) وSSE بنفسه
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3500);
        if (await evalJs("!!document.getElementById('loginUsername')")) {
            await evalJs("document.getElementById('loginUsername').value='4252'; document.getElementById('loginPassword').value='4252'; document.getElementById('loginBtn').click(); 'ok'");
            for (let i = 0; i < 20; i++) { await sleep(700); if (await evalJs("!!localStorage.getItem('auth_access_token')")) break; }
        }
        const token = await evalJs("localStorage.getItem('auth_access_token')");
        if (!token) throw new Error('فشل تسجيل الدخول');
        await evalJs("window.__alerts=[]; window.alert=function(m){window.__alerts.push(String(m));}; 'ok'");
        await sleep(3000);

        async function browserMetrics() {
            const r = await cdp('Performance.getMetrics');
            const g = n => { const m = (r.metrics || []).find(x => x.name === n); return m ? m.value : null; };
            return {
                heapMB: g('JSHeapUsedSize') !== null ? Math.round(g('JSHeapUsedSize') / 1048576 * 10) / 10 : null,
                domNodes: g('Nodes'),
                listeners: g('JSEventListeners')
            };
        }
        async function sample(phase) {
            const tSec = Math.round((Date.now() - tStart) / 1000);
            const rss = serverRssMb(server.pid);
            const bm = await browserMetrics();
            const eps = [];
            for (const [url, tag] of [['/health', 'health'], ['/api/last-update', 'last-update'], ['/api/peak-data', 'peak-data'], ['/api/current-shift', 'current-shift'], ['/api/data', 'data']]) {
                eps.push(await timeEndpoint(token, url, tag));
            }
            const rec = { phase, tSec, serverRssMB: rss, browser: bm, endpoints: eps };
            timeline.push(rec);
            console.log(`  ⏱️ [${phase}] t=${tSec}s · RSS=${rss}MB · heap=${bm.heapMB}MB · DOM=${bm.domNodes} · listeners=${bm.listeners}`);
            for (const e of eps) console.log(`      ${e.tag}: ${e.ms}ms (${e.status}, ${Math.round(e.bytes / 1024)}KB)`);
            return rec;
        }

        // ── عينة الصفر (تعادل «بعد Restart مباشرة») ──
        await sample('T0-after-restart');

        // ── سيناريو A: تصفح مكثف بين النماذج/المودالات — 90 ثانية ──
        console.log('🔁 سيناريو A: تنقل مكثف (نماذج + مودالات) بلا خريطة...');
        const forms = ['e', 'incident', 'escalation', 'daily', 'senior', 'air'];
        const modals = ['controlModal', 'analyticsModal', 'hospitalModal'];
        const aEnd = Date.now() + 90000;
        let navCount = 0;
        while (Date.now() < aEnd) {
            const f = forms[navCount % forms.length];
            await evalJs(`try{ openModalById('formsModal'); loadFormsList(); loadForm('${f}'); }catch(e){}; 'ok'`).catch(() => { });
            await sleep(1400);
            if (navCount % 3 === 2) {
                const m = modals[navCount % modals.length];
                await evalJs(`try{ openModalById('${m}'); }catch(e){}; 'ok'`).catch(() => { });
                await sleep(700);
                await evalJs(`try{ closeModalById('${m}'); }catch(e){}; 'ok'`).catch(() => { });
            }
            navCount++;
        }
        await evalJs("try{ closeFormsModal(); }catch(e){}; 'ok'").catch(() => { });
        await sample('T90-after-navigation');

        // ── سيناريو B: تفاعل خريطة مكثف — 90 ثانية ──
        console.log('🗺️ سيناريو B: تفاعل خريطة متكرر (renderIncidents متغير + بطاقات)...');
        const bEnd = Date.now() + 90000;
        let mapIter = 0;
        while (Date.now() < bEnd) {
            // بيانات متغيرة قليلًا في كل مرة → يكسر بصمة التطابق ويفرض إعادة رسم فعلية
            await evalJs(`(() => { try {
                var incs = [];
                for (var i = 0; i < 30; i++) incs.push({ number: '9' + (100000 + i), type: 'medical', code: 'PERF', severity: ['green','yellow','red'][i % 3], cadCreatedAt: '02/09/2026 09:00:00 PM', address: 'اختبار أداء', lat: 24.6 + (i * 0.001) + (${mapIter} * 0.00001), lng: 46.7 + (i * 0.001), crews: [] });
                SmartMap.renderIncidents({ incidents: incs });
                SmartMap.focusOn('incident', '9' + (100000 + (${mapIter} % 30)));
                SmartMap.closeCard();
            } catch (e) {} return 'ok'; })()`).catch(() => { });
            mapIter++;
            await sleep(1500);
        }
        await sample('T180-after-map');

        // ── خمول 60 ثانية (Polling وحده يعمل) ──
        console.log('💤 خمول 60ث — Polling الخلفية فقط (3s/10s/60s + SSE)...');
        await sleep(60000);
        await sample('T240-idle-polling');

        // ── النتائج ──
        console.log('\n════════ جدول الموارد (بداية ← نهاية) ════════');
        console.log('المرحلة | RSS MB | Browser Heap MB | DOM | Listeners');
        for (const r of timeline) {
            console.log(`${r.phase} | ${r.serverRssMB} | ${r.browser.heapMB} | ${r.browser.domNodes} | ${r.browser.listeners}`);
        }
        console.log('\n════════ زمن الاستجابة لكل نقطة (avg/p95/max ms) ════════');
        const tags = ['health', 'last-update', 'peak-data', 'current-shift', 'data'];
        for (const tag of tags) {
            for (const r of timeline) {
                const e = r.endpoints.find(x => x.tag === tag);
                if (e) console.log(`${tag} @ ${r.phase}: ${e.ms}ms · ${Math.round(e.bytes / 1024)}KB · ${e.status}`);
            }
        }
        fs.writeFileSync(path.join(OUT_DIR, 'perf-timeline.json'), JSON.stringify({
            meta: { startedAt: new Date(tStart).toISOString(), port: PORT, navIterations: navCount, mapIterations: mapIter },
            timeline
        }, null, 2));
        console.log('\n📄 perf-timeline.json محفوظ في ' + OUT_DIR);
    } finally {
        try { if (chrome) chrome.kill(); } catch (_) { }
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(0);
})().catch(e => { console.error('⚠️ انهيار:', e.message); process.exit(1); });
