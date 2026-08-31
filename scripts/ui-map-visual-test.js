/**
 * ═══ اختبار بصري UI-Map المرحلة B — ui-map-visual-test.js ═══
 * اعتماد المالك 2026-08-31 — إثبات فعلي باللقطات والقياسات (لا «يبدو سليمًا»):
 *   الحالة 1: الشاشة العادية (لا دفع، القائمة مغلقة)
 *   الحالة 2: فتح الـSidebar ← دفع تخطيط (container/topbar ينكمشان 280px، لا تغطية)
 *   الحالة 3: بطاقة شرح (minfo-pop) مع القائمة مفتوحة ← تبقى داخل المساحة المتاحة
 *   + الخريطة dark-v11 فعلًا + /api/audit-log ← 200 من المتصفح
 * العزل: VACUUM INTO + DATA_DIR مؤقت. Chrome headless عبر CDP خام (بلا مكتبات).
 * التشغيل: node scripts/ui-map-visual-test.js
 */
'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'uimap-vis-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'uimap-vis-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'uimap-vis-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'ui-map-' + STAMP);
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9333;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// توكن Mapbox العام يُمرَّر من البيئة فقط (ممنوع في Git — Push Protection):
//   MAPBOX_PUBLIC_TOKEN=pk... node scripts/ui-map-visual-test.js
// غيابه لا يُسقط الاختبار: تبقى فحوص التخطيط/الـAPI سارية، وفحص النمط الداكن
// يعتمد على نص runtime-config المحقون (الخادم يقرأ المتغير نفسه).
const MAPBOX_PK = process.env.MAPBOX_PUBLIC_TOKEN || '';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}

// ---------- CDP خام ----------
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
async function shot(name) {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT_DIR, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('  📸 ' + p);
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // ── عزل البيانات ──
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت (نسخ كل JSON)...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    // ── خادم معزول مع توكن Mapbox من البيئة (لإثبات dark-v11 فعليًا) ──
    console.log('🚀 خادم الاختبار على ' + PORT + (MAPBOX_PK ? ' (MAPBOX_PUBLIC_TOKEN مضبوط)' : ' (⚠️ بلا توكن — البلاطات مؤقتة)'));
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    if (MAPBOX_PK) env.MAPBOX_PUBLIC_TOKEN = MAPBOX_PK;
    else delete env.MAPBOX_PUBLIC_TOKEN;
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let chrome = null;
    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');

        // ── إثبات dark-v11 من مسار الإنتاج نفسه ──
        const cfgRes = await fetch(BASE + '/js/map-config.runtime.js');
        const cfgText = await cfgRes.text();
        check('/js/map-config.runtime.js يحقن dark-v11', cfgText.includes('mapbox/dark-v11'), cfgText.slice(0, 120));
        check('لا أثر لـ light-v11 في إعداد الإنتاج', !cfgText.includes('light-v11'));

        // ── Chrome headless عبر CDP ──
        console.log('🌐 تشغيل Chrome headless (1600×900 — سطح مكتب)...');
        chrome = spawn(CHROME, [
            '--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=1600,900', '--no-first-run', '--disable-gpu',
            '--user-data-dir=' + CHROME_PROFILE, 'about:blank'
        ], { stdio: 'ignore' });
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

        // ── تسجيل دخول حقيقي ──
        console.log('🔑 تسجيل دخول operator (4252) عبر النموذج الحقيقي...');
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(4000);
        const hasLogin = await evalJs("!!document.getElementById('loginUsername') && document.getElementById('loginScreen') && getComputedStyle(document.getElementById('loginScreen')).display !== 'none'");
        if (hasLogin) {
            await evalJs("document.getElementById('loginUsername').value='4252'; document.getElementById('loginPassword').value='4252'; document.getElementById('loginBtn').click(); 'ok'");
            let authed = false;
            for (let i = 0; i < 20; i++) { await sleep(700); authed = await evalJs("!!localStorage.getItem('auth_access_token')"); if (authed) break; }
            check('تسجيل الدخول الحقيقي نجح (auth_access_token)', authed);
        } else {
            check('صفحة الدخول ظاهرة', false, 'لم تظهر — ربما جلسة سابقة في البروفايل المؤقت');
        }

        // ── انتظار إقلاع الخريطة (Mapbox canvas) ──
        let mapUp = false;
        for (let i = 0; i < 30; i++) { await sleep(1000); mapUp = await evalJs("!!document.querySelector('#opsMap .mapboxgl-canvas, #opsMap canvas')"); if (mapUp) break; }
        check('خريطة Mapbox أقلعت داخل #opsMap', mapUp);
        await sleep(4000); // بلاطات + علامات

        // ═══ الحالة 1: الشاشة العادية ═══
        console.log('\n📐 الحالة 1 — الشاشة العادية:');
        let m = await evalJs("({mr: getComputedStyle(document.querySelector('.container')).marginRight, open: document.body.classList.contains('sidebar-open')})");
        check('القائمة مغلقة ولا دفع للتخطيط (margin-right = 0)', m.mr === '0px' && !m.open, JSON.stringify(m));
        await shot('1-normal');

        // ═══ الحالة 2: فتح الـSidebar ═══
        console.log('\n📐 الحالة 2 — فتح الـSidebar:');
        await evalJs("document.getElementById('sidebarToggle').click(); 'ok'");
        await sleep(900); // انتقال 300ms + هامش
        // تشخيص: هل قاعدة CSS موجودة أصلًا في الصفحة؟ وهل الـmedia والمتغير يعملان؟
        const cssText = await evalJs(`fetch('/css/smart-toolbar.css?v=4').then(r => r.text()).then(t => ({
            hasRule: t.includes('sidebar-open'), len: t.length,
            tail: t.slice(-400).replace(/\\s+/g, ' ').slice(0, 300)
        }))`);
        console.log('  🔎 محتوى CSS عبر الشبكة:', JSON.stringify(cssText));
        const diag = await evalJs(`(() => {
            const out = { mq: matchMedia('(min-width: 769px)').matches,
                varVal: getComputedStyle(document.body).getPropertyValue('--sidebar-width'),
                rulesFound: [], sheetsCount: document.styleSheets.length, sheetsErr: 0 };
            for (const ss of document.styleSheets) {
                let rules; try { rules = ss.cssRules; } catch (e) { out.sheetsErr++; continue; }
                for (const r of rules) {
                    if (r.cssRules) for (const inner of r.cssRules)
                        if (inner.selectorText && inner.selectorText.includes('sidebar-open')) out.rulesFound.push((r.conditionText||'')+' :: '+inner.selectorText+' @ '+(ss.href||'inline').split('?')[0].split('/').pop());
                    if (r.selectorText && r.selectorText.includes('sidebar-open')) out.rulesFound.push(r.selectorText+' @ '+(ss.href||'inline').split('?')[0].split('/').pop());
                }
            }
            return out;
        })()`);
        console.log('  🔎 تشخيص CSS:', JSON.stringify(diag));
        check('قاعدة sidebar-open موجودة في CSS المحمّل', diag.rulesFound.length > 0, JSON.stringify(diag.rulesFound));
        m = await evalJs(`(() => {
            const c = document.querySelector('.container');
            const tb = document.querySelector('.smart-topbar');
            const sb = document.getElementById('smartSidebar');
            const sec = document.getElementById('opsMapSection');
            const sbr = sb.getBoundingClientRect(), secr = sec ? sec.getBoundingClientRect() : null;
            return {
                open: document.body.classList.contains('sidebar-open'),
                cmr: getComputedStyle(c).marginRight, tbr: getComputedStyle(tb).right,
                sbLeft: Math.round(sbr.left), sbWidth: Math.round(sbr.width), iw: window.innerWidth,
                secRight: secr ? Math.round(secr.right) : null
            };
        })()`);
        check('body.sidebar-open مفعّل', m.open === true);
        check('.container انكمش بعرض القائمة (280px)', m.cmr === '280px', m.cmr);
        check('.smart-topbar ابتعد عن حافة القائمة (right = 280px)', m.tbr === '280px', m.tbr);
        check('القائمة على الحافة اليمنى بعرض ~280', Math.abs(m.sbLeft - (m.iw - m.sbWidth)) <= 2 && Math.abs(m.sbWidth - 280) <= 3, JSON.stringify({ sbLeft: m.sbLeft, sbWidth: m.sbWidth, iw: m.iw }));
        check('قسم الخريطة لا يمتد تحت القائمة', m.secRight !== null && m.secRight <= m.sbLeft + 2, 'secRight=' + m.secRight + ' sbLeft=' + m.sbLeft);
        await shot('2-sidebar-open');

        // ═══ الحالة 3: بطاقة شرح (minfo-pop) مع القائمة مفتوحة ═══
        console.log('\n📐 الحالة 3 — بطاقة Popup/الحالة مع القائمة مفتوحة:');
        const infoState = await evalJs(`(() => {
            try {
                const btn = document.querySelector('#opsMapSection [data-info="kpi-alerts"]') || document.querySelector('#opsMapSection [data-info]');
                if (!btn) return { err: 'no button' };
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                const pop = document.querySelector('.minfo-pop');
                return { key: btn.getAttribute('data-info'), popExists: !!pop, display: pop && pop.style.display };
            } catch (e) { return { err: String(e) }; }
        })()`);
        console.log('  🔎 حالة البطاقة بعد النقر:', JSON.stringify(infoState));
        check('زر شرح [data-info] موجود ونُقر', !!(infoState && infoState.key), JSON.stringify(infoState));
        // ملاحظة: لقطة CDP قد تولّد حدث resize عرضيًا يغلق البطاقة (window resize → closeInfo)
        // لذلك نقيس بعد 350ms، وإن وُجدت مغلقة نعيد فتحها ونقيس — المطلوب إثبات الحدّ الأيمن لا استمرارية الفتح
        const measurePop = `(() => {
            const pop = document.querySelector('.minfo-pop');
            if (!pop || pop.style.display === 'none') return { visible: false };
            const r = pop.getBoundingClientRect();
            return { visible: true, right: Math.round(r.right), left: Math.round(r.left), iw: window.innerWidth, limit: window.innerWidth - 280 };
        })()`;
        await sleep(350);
        m = await evalJs(measurePop);
        if (!m.visible) {
            console.log('  ↻ البطاقة أُغلقت بحدث resize عرضي — إعادة فتح وقياس...');
            await evalJs(`(() => { const b = document.querySelector('#opsMapSection [data-info="kpi-alerts"]'); if (b) b.click(); return 'ok'; })()`);
            await sleep(350);
            m = await evalJs(measurePop);
        }
        check('بطاقة الشرح ظاهرة', m.visible === true, JSON.stringify(m));
        check('البطاقة داخل المساحة المتاحة (لا تدخل منطقة القائمة)', m.visible && m.right <= m.limit, 'right=' + m.right + ' limit=' + m.limit);
        await shot('3-popup-with-sidebar');

        // ── إثباتات API من المتصفح نفسه ──
        console.log('\n🔌 إثباتات API من سياق المتصفح:');
        m = await evalJs(`fetch('/api/audit-log', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('auth_access_token') } }).then(r => r.status).catch(() => 0)`);
        check('GET /api/audit-log ← 200 (ليس 500)', m === 200, 'status=' + m);

        // ── الحالة 4: إغلاق القائمة يعيد التخطيط الكامل ──
        console.log('\n📐 الحالة 4 — إغلاق القائمة:');
        await evalJs("document.getElementById('sidebarToggle').click(); 'ok'");
        await sleep(900);
        m = await evalJs("({mr: getComputedStyle(document.querySelector('.container')).marginRight, open: document.body.classList.contains('sidebar-open')})");
        check('التخطيط عاد كاملًا (margin-right = 0، لا sidebar-open)', m.mr === '0px' && !m.open, JSON.stringify(m));
        await shot('4-sidebar-closed');
    } catch (e) {
        check('سير الاختبار بلا استثناءات', false, e.message);
    } finally {
        try { if (ws) ws.close(); } catch (_) { }
        try { if (chrome) chrome.kill(); } catch (_) { }
        try { server.kill(); } catch (_) { }
        try { execFile('taskkill', ['/F', '/IM', 'chrome.exe', '/FI', 'WINDOWTITLE eq about:blank*'], () => { }); } catch (_) { }
    }

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    console.log('اللقطات: ' + OUT_DIR);
    if (failed) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
    console.log('🟢 الاختبار البصري اكتمل.');
})();
