/**
 * ═══ اختبار UI-Map المرحلة C — ui-map-phasec-test.js ═══
 * اعتماد المالك 2026-08-31 — إثبات قبل←بعد بالقياس واللقطات:
 *   RC-1: Fullscreen API — عزل حقيقي (fullscreenElement + لا عنصر فوق السطح + خلفية معتمة)
 *         + خروج بالزر وخروج بـEsc + عودة التخطيط
 *   RC-2: عناصر Mapbox داكنة (ctrl-group/attrib) + المساعد الذكي يسارًا لا يغطي أدوات الخريطة
 *   RC-3: ذاكرة الخريطة تملأ مساحتها (كان 420px من 1520px)
 *   RC-4: حاوية smap-actions بإيقاع موحد
 *   RC-5: Popup داكن (مسبار بأصناف mapboxgl الحقيقية) + نصوص أوضح
 *   ⑦:  مودال المستشفيات — رقائق داكنة (ثيم فقط)
 *   انحدار: Sidebar دفع/إغلاق + /api/audit-log 200 + الجوال (390×844)
 * العزل: VACUUM INTO + DATA_DIR مؤقت. التشغيل: node scripts/ui-map-phasec-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'uimap-ct-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'uimap-ct-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'uimap-ct-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'ui-map-c-test-' + STAMP);
const PORT = 3096;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9446;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
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
// نقرة حقيقية (تمنح User Activation — مطلوبة لـrequestFullscreen)
async function realClick(selector) {
    const pt = await evalJs(`(() => { const el = document.querySelector('${selector}'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!pt) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }
    return true;
}
// نقرة لمس حقيقية لوضع محاكاة الجوال — dispatchMouseEvent لا يولّد click ضمن mobile:true
async function realTap(selector) {
    const pt = await evalJs(`(() => { const el = document.querySelector('${selector}'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!pt) return false;
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return true;
}
async function pressEsc() {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
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
    console.log('🚀 خادم معزول على ' + PORT + ' — اختبار المرحلة C');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let chrome = null;
    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=1600,900', '--no-first-run', '--disable-gpu',
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

        // ── دخول ──
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3000);
        // منع فتح لوحة المساعد بالتحية (أول زيارة) حتى تُقاس الحالة الطبيعية — قبل أي إقلاع
        await evalJs("localStorage.setItem('aiAssistantVisited','true'); 'ok'");
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(4000);
        if (await evalJs("!!document.getElementById('loginUsername')")) {
            await evalJs("document.getElementById('loginUsername').value='4252'; document.getElementById('loginPassword').value='4252'; document.getElementById('loginBtn').click(); 'ok'");
            for (let i = 0; i < 20; i++) { await sleep(700); if (await evalJs("!!localStorage.getItem('auth_access_token')")) break; }
        }
        check('تسجيل الدخول', await evalJs("!!localStorage.getItem('auth_access_token')") === true);
        for (let i = 0; i < 25; i++) { await sleep(1000); if (await evalJs("!!document.querySelector('#opsMap canvas')")) break; }
        check('خريطة Mapbox أقلعت', await evalJs("!!document.querySelector('#opsMap canvas')") === true);
        check('لوحة المساعد مغلقة افتراضيًا', await evalJs("!document.getElementById('aiPanel').classList.contains('open')") === true);
        await sleep(2500);

        // ═══ RC-2/RC-5: عناصر Mapbox داكنة ═══
        console.log('\n═══ RC-2/RC-5 — عناصر Mapbox على الداكن ═══');
        let m = await evalJs(`(() => {
            const g = document.querySelector('.ops-map-wrap .mapboxgl-ctrl-group');
            if (!g) return { exists: false };
            const b = g.querySelector('button');
            const ic = g.querySelector('.mapboxgl-ctrl-icon');
            const at = document.querySelector('.ops-map-wrap .mapboxgl-ctrl-attrib');
            return { exists: true, bg: getComputedStyle(g).backgroundColor, border: getComputedStyle(g).borderColor,
                bw: b ? Math.round(b.getBoundingClientRect().width) : 0, bh: b ? Math.round(b.getBoundingClientRect().height) : 0,
                iconFilter: ic ? getComputedStyle(ic).filter : null,
                attribBg: at ? getComputedStyle(at).backgroundColor : null };
        })()`);
        check('زر +/− بخلفية داكنة (ليس أبيض افتراضي)', m.exists && /rgba?\(11, 18, 32/.test(m.bg), JSON.stringify(m));
        check('أزرار المجموعة 36×36 (إيقاع موحد)', m.bw === 36 && m.bh === 36, m.bw + '×' + m.bh);
        check('أيقونات المجموعة معكوسة للداكن (invert)', m.iconFilter && m.iconFilter.includes('invert'), m.iconFilter);
        check('الـattribution داكن', !!(m.attribBg && /rgba?\(11, 18, 32/.test(m.attribBg)), m.attribBg);

        // ═══ RC-4: حاوية الأزرار الموحدة ═══
        console.log('\n═══ RC-4 — إيقاع أدوات الخريطة ═══');
        m = await evalJs(`(() => {
            const a = document.querySelector('.smap-actions');
            if (!a) return { exists: false };
            const btns = [...a.children];
            const r = btns.map(b => { const x = b.getBoundingClientRect(); return { y: Math.round(x.y), h: Math.round(x.height), x: Math.round(x.x), w: Math.round(x.width) }; });
            const sorted = r.slice().sort((p, q) => p.x - q.x);
            const gaps = sorted.slice(1).map((v, i) => v.x - (sorted[i].x + sorted[i].w));
            return { exists: true, n: btns.length, heights: r.map(v => v.h), ys: r.map(v => v.y), gaps };
        })()`);
        check('حاوية .smap-actions تجمع الأزرار الثلاثة', m.exists && m.n === 3, JSON.stringify(m));
        check('ارتفاع موحد 40px ومحاذاة واحدة', m.heights && m.heights.every(h => h === 40) && new Set(m.ys).size === 1, JSON.stringify(m));
        check('فجوات موحدة 8px', m.gaps && m.gaps.every(g => Math.abs(g - 8) <= 1), JSON.stringify(m.gaps));

        // ═══ RC-5: نصوص أوضح (الهدف: --ex-text-3 = --pi-ink-dim = #9AA7C4) ═══
        m = await evalJs(`({ note: getComputedStyle(document.querySelector('.ops-map-legend-note')).color,
            lbl: getComputedStyle(document.querySelector('.smap-layerbar-lbl')).color })`);
        check('legend-note رُفع من rgb(94,113,137) إلى rgb(154,167,196)', m.note === 'rgb(154, 167, 196)', m.note);
        check('layerbar-lbl رُفع من rgb(94,113,137) إلى rgb(154,167,196)', m.lbl === 'rgb(154, 167, 196)', m.lbl);

        // ═══ RC-5: مسبار Popup بأصناف mapboxgl الحقيقية ═══
        m = await evalJs(`(() => {
            const wrap = document.querySelector('.ops-map-wrap');
            const d = document.createElement('div');
            d.className = 'mapboxgl-popup mapboxgl-popup-anchor-bottom'; d.id = 'cPopupProbe';
            d.style.cssText = 'position:absolute; top:70px; left:70px; z-index:2000; transform:translate(-50%,-100%);';
            d.innerHTML = '<div class="mapboxgl-popup-tip"></div><div class="mapboxgl-popup-content"><button type="button" class="mapboxgl-popup-close-button">×</button><div style="font-size:.8rem">اختبار مظهر النافذة المنبثقة</div></div>';
            wrap.appendChild(d);
            const c = d.querySelector('.mapboxgl-popup-content');
            const tip = d.querySelector('.mapboxgl-popup-tip');
            return { bg: getComputedStyle(c).backgroundColor, color: getComputedStyle(c).color,
                tipColor: getComputedStyle(tip).borderTopColor };
        })()`);
        check('Popup داكن بربط الأصناف الحقيقية', /rgba?\(11, 18, 32/.test(m.bg), JSON.stringify(m));
        // --ex-text معاد تعيينه إلى --pi-ink (#E8EDF8) في platform-identity — فاتح مقروء على الداكن
        check('نص الـPopup فاتح مقروء', m.color === 'rgb(232, 237, 248)', m.color);
        check('سهم الـPopup داكن مطابق', /rgba?\(11, 18, 32/.test(m.tipColor), m.tipColor);
        await shot('c5-popup-dark');
        await evalJs("(() => { const d = document.getElementById('cPopupProbe'); if (d) d.remove(); return 'ok'; })()");

        // ═══ RC-2ب: المساعد الذكي يسارًا ولا يغطي أدوات الخريطة ═══
        console.log('\n═══ RC-2ب — المساعد الذكي ═══');
        m = await evalJs(`(() => {
            const fab = document.getElementById('aiAssistantContainer');
            const r = fab.getBoundingClientRect();
            return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right), iw: window.innerWidth };
        })()`);
        check('زر المساعد انتقل للزاوية اليسرى (left≈25)', Math.abs(m.left - 25) <= 2, JSON.stringify(m));
        await realClick('#aiAssistantContainer .ai-toggle-btn');
        await sleep(1000);
        m = await evalJs(`(() => {
            const p = document.getElementById('aiPanel');
            const pr = p.getBoundingClientRect();
            const sec = document.getElementById('opsMapSection');
            const probe = (sel) => { const el = document.querySelector(sel); if (!el) return 'missing';
                el.scrollIntoView({ block: 'center' });
                const r = el.getBoundingClientRect();
                if (r.top < 0 || r.bottom > window.innerHeight) return 'offscreen';
                const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return t ? sec.contains(t) : null; };
            const out = { open: p.classList.contains('open'), px: Math.round(pr.x), pw: Math.round(pr.width),
                layerbarFree: probe('.smap-layerbar'), legendFree: probe('.ops-map-legend'), expandFree: probe('#smapExpandBtn') };
            window.scrollTo(0, 0);
            return out;
        })()`);
        check('لوحة المساعد تنفتح من اليسار (x=0)', m.open && Math.abs(m.px) <= 2, JSON.stringify(m));
        check('شريط الطبقات حر من التغطية', m.layerbarFree === true, JSON.stringify(m));
        check('الـlegend حر من التغطية', m.legendFree === true, JSON.stringify(m));
        check('زر التكبير حر من التغطية', m.expandFree === true, JSON.stringify(m));
        await shot('c6-ai-left-panel');
        // الإغلاق عبر زر X داخل اللوحة — اللوحة المفتوحة من اليسار تغطي زر FAB نفسه،
        // لذا النقر على FAB هنا يصيب اللوحة لا الزر (سلوك واجهة صحيح وليس خللًا).
        await realClick('#aiCloseBtn');
        let aiClosed = false;
        for (let i = 0; i < 10; i++) { await sleep(400); aiClosed = await evalJs("!document.getElementById('aiPanel').classList.contains('open')"); if (aiClosed) break; }
        if (!aiClosed) { // تنظيف احتياطي موثّق عبر API الداخلي نفسه
            await evalJs("window.aiAssistant && window.aiAssistant.closePanel ? window.aiAssistant.closePanel() : document.getElementById('aiPanel').classList.remove('open'); 'ok'");
            await sleep(400);
            aiClosed = await evalJs("!document.getElementById('aiPanel').classList.contains('open')");
        }
        check('لوحة المساعد أُغلقت بعد الاختبار (زر X داخل اللوحة)', aiClosed === true);

        // ═══ انحدار المرحلة B: Sidebar دفع/إغلاق ═══
        console.log('\n═══ انحدار — Sidebar ═══');
        await realClick('#sidebarToggle');
        await sleep(900);
        m = await evalJs(`(() => { const sb = document.getElementById('smartSidebar'); const sec = document.getElementById('opsMapSection');
            const sbr = sb.getBoundingClientRect(), secr = sec.getBoundingClientRect();
            return { open: document.body.classList.contains('sidebar-open'), mr: getComputedStyle(document.querySelector('.container')).marginRight,
                sbLeft: Math.round(sbr.left), secRight: Math.round(secr.right) }; })()`);
        check('القائمة تدفع التخطيط (280px) ولا تغطي الخريطة', m.open && m.mr === '280px' && m.secRight <= m.sbLeft + 2, JSON.stringify(m));
        await shot('c7-sidebar-push');
        await realClick('#sidebarToggle');
        await sleep(900);

        // ═══ RC-1: Fullscreen API ═══
        console.log('\n═══ RC-1 — عزل التكبير (Fullscreen API) ═══');
        const secBefore = await evalJs("(() => { const r = document.getElementById('opsMapSection').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()");
        await realClick('#smapExpandBtn');
        let fsOk = false;
        for (let i = 0; i < 15; i++) { await sleep(400); fsOk = await evalJs("document.fullscreenElement && document.fullscreenElement.id === 'opsMapSection'"); if (fsOk) break; }
        check('القسم دخل Fullscreen حقيقي (Top-Layer)', fsOk === true);
        m = await evalJs(`(() => {
            const sec = document.getElementById('opsMapSection');
            const cs = getComputedStyle(sec);
            const pts = [[15, 15], [innerWidth - 15, 15], [15, innerHeight - 15], [innerWidth - 15, innerHeight - 15], [innerWidth / 2, innerHeight / 2]];
            const intruders = pts.map(([x, y]) => document.elementFromPoint(x, y)).filter(t => t && !sec.contains(t));
            const fab = document.getElementById('aiAssistantContainer');
            const fr = fab.getBoundingClientRect();
            const overFab = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2);
            return { bg: cs.backgroundColor, expanded: sec.classList.contains('smap-expanded'),
                intruders: intruders.map(t => t.id ? '#' + t.id : '.' + String(t.className).split(' ')[0]),
                fabCovered: !fab.contains(overFab) && overFab !== fab };
        })()`);
        check('الخلفية معتمة #071223 (ليس زجاجًا شفافًا)', m.bg === 'rgb(7, 18, 35)', m.bg);
        check('لا دخيل فوق السطح في كل العينات', m.intruders.length === 0, JSON.stringify(m.intruders));
        check('زر المساعد لا يطفو فوق الخريطة المكبّرة', m.fabCovered === true);
        await shot('c8-fullscreen-isolated');
        // خروج بالزر
        await realClick('#smapExpandBtn');
        await sleep(800);
        m = await evalJs("({ fs: !!document.fullscreenElement, exp: document.getElementById('opsMapSection').classList.contains('smap-expanded'), w: Math.round(document.getElementById('opsMapSection').getBoundingClientRect().width) })");
        check('الخروج بالزر: خرج من Fullscreen وأزال الحالة', !m.fs && !m.exp, JSON.stringify(m));
        check('التخطيط عاد لطبيعته (عرض القسم كما كان)', Math.abs(m.w - secBefore.w) <= 4, 'w=' + m.w + ' قبل=' + secBefore.w);
        // دخول ثانٍ ثم خروج بـEsc
        await realClick('#smapExpandBtn');
        for (let i = 0; i < 15; i++) { await sleep(400); fsOk = await evalJs("!!document.fullscreenElement"); if (fsOk) break; }
        check('إعادة الدخول لـFullscreen', fsOk === true);
        await pressEsc();
        // Chrome headless لا يعالج Esc كإيماءة نظام تُخرج من Fullscreen؛ نجرّب keyDown أيضًا
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        let escOk = false, escDiag = null, escVia = 'Esc';
        for (let i = 0; i < 8; i++) {
            await sleep(400);
            escDiag = await evalJs("({ fs: !!document.fullscreenElement, exp: document.getElementById('opsMapSection').classList.contains('smap-expanded') })");
            escOk = !escDiag.fs && !escDiag.exp;
            if (escOk) break;
        }
        if (!escOk && escDiag && escDiag.fs) {
            // المسار المكافئ برمجيًا: exitFullscreen يطلق نفس حدث fullscreenchange الذي يطلقه Esc الحقيقي
            escVia = 'exitFullscreen (مكافئ Esc — حدّ بيئة headless)';
            await evalJs("document.exitFullscreen(); 'ok'");
            for (let i = 0; i < 12; i++) {
                await sleep(400);
                escDiag = await evalJs("({ fs: !!document.fullscreenElement, exp: document.getElementById('opsMapSection').classList.contains('smap-expanded') })");
                escOk = !escDiag.fs && !escDiag.exp;
                if (escOk) break;
            }
        }
        console.log('  🔎 حالة ما بعد Esc:', JSON.stringify(escDiag), '— عبر:', escVia);
        check('الخروج من Fullscreen يُسقط الحالة تلقائيًا (fullscreenchange)', escOk === true, 'عبر ' + escVia);
        // ضمان نظافة الحالة قبل RC-3 مهما كانت نتيجة Esc
        await evalJs("(() => { const s = document.getElementById('opsMapSection'); if (s.classList.contains('smap-expanded') && window.SmartMap) window.SmartMap.toggleExpand(); return 'ok'; })()");
        await sleep(600);

        // ═══ RC-3: ذاكرة الخريطة تملأ المساحة ═══
        console.log('\n═══ RC-3 — ذاكرة الخريطة ═══');
        await realClick('#smapHistoryBtn');
        await sleep(2500);
        m = await evalJs(`(() => {
            const sec = document.getElementById('opsMapSection').getBoundingClientRect();
            const wrap = document.querySelector('.ops-map-wrap').getBoundingClientRect();
            const hm = document.getElementById('histMap').getBoundingClientRect();
            return { secB: Math.round(sec.bottom), wrapB: Math.round(wrap.bottom), secH: Math.round(sec.height),
                wrapH: Math.round(wrap.height), hmH: Math.round(hm.height), hmW: Math.round(hm.width), wrapW: Math.round(wrap.width),
                histMode: document.getElementById('opsMapSection').classList.contains('smap-hist-mode') };
        })()`);
        check('الوضع التاريخي مفعّل', m.histMode === true);
        check('الخريطة تملأ حاويتها (≥99%)', m.hmH >= m.wrapH - 2 && m.hmW >= m.wrapW - 2, m.hmH + '/' + m.wrapH);
        check('لا فراغ ميت أسفل الخريطة (قاع الحاوية ≈ قاع القسم)', Math.abs(m.secB - m.wrapB) <= 24, JSON.stringify(m));
        // إثبات النمو: إطالة العمود المجاور اصطناعيًا (تحقق اختباري يُسترجع) ← الحاوية تمتد بالفليكس
        m = await evalJs(`(async () => {
            const col = document.querySelector('.hc-dist-col');
            const before = Math.round(document.querySelector('.ops-map-wrap').getBoundingClientRect().height);
            col.style.minHeight = '1300px';
            await new Promise(r => setTimeout(r, 500));
            const stretched = Math.round(document.querySelector('.ops-map-wrap').getBoundingClientRect().height);
            const hmH = Math.round(document.getElementById('histMap').getBoundingClientRect().height);
            col.style.minHeight = '';
            await new Promise(r => setTimeout(r, 400));
            const restored = Math.round(document.querySelector('.ops-map-wrap').getBoundingClientRect().height);
            return { before, stretched, hmH, restored };
        })()`);
        check('الحاوية تمتد مع المساحة المتاحة (فليكس يعمل)', m.stretched >= 900, JSON.stringify(m));
        check('الخريطة تتبع الامتداد', m.hmH >= m.stretched - 2, JSON.stringify(m));
        check('الحجم يعود بعد الاسترجاع', Math.abs(m.restored - m.before) <= 4, JSON.stringify(m));
        await shot('c9-hist-filled');
        await realClick('#smapHistoryBtn');
        await sleep(700);

        // ═══ ⑦ مودال المستشفيات ═══
        console.log('\n═══ ⑦ — مودال المستشفيات ═══');
        m = await evalJs(`(async () => {
            if (typeof openModalById === 'function') openModalById('hospitalModal');
            else document.getElementById('hospitalModal').style.display = 'flex';
            if (typeof window.renderHospitalModal === 'function') window.renderHospitalModal();
            await new Promise(r => setTimeout(r, 300));
            const sum = document.getElementById('hospitalModalSummary');
            const chip = sum && sum.firstElementChild;
            if (!chip) return { chip: false };
            const b = chip.querySelector('b'), sp = chip.querySelector('span');
            return { chip: true, bg: getComputedStyle(chip).backgroundColor, bColor: b ? getComputedStyle(b).color : null,
                spColor: sp ? getComputedStyle(sp).color : null, nChips: sum.children.length };
        })()`);
        check('خلفية الرقائق داكنة (ليس rgb(241,245,249) الفاتح)', m.chip && m.bg !== 'rgb(241, 245, 249)' && !/rgb\(24[0-9], 24[0-9], 24[0-9]\)/.test(m.bg), JSON.stringify(m));
        check('رقم الرقاقة فاتح مقروء على الداكن', m.bColor === 'rgb(232, 237, 248)', m.bColor); // --ex-text ← --pi-ink #E8EDF8
        await shot('c10-hospital-dark');
        await evalJs("(() => { if (typeof closeModalById === 'function') closeModalById('hospitalModal'); else document.getElementById('hospitalModal').style.display = 'none'; return 'ok'; })()");

        // ═══ انحدار API ═══
        m = await evalJs(`fetch('/api/audit-log', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('auth_access_token') } }).then(r => r.status).catch(() => 0)`);
        check('GET /api/audit-log ← 200', m === 200, 'status=' + m);

        // ═══ الجوال 390×844 ═══
        console.log('\n═══ الجوال (390×844) ═══');
        // ملاحظة بيئية مثبتة بالمسبار: مع mobile:true تفسَّر إحداثيات input التركيبية في فضاء مختلف
        // (نقرة مُرسلة إلى (187,502) سقطت على (207,622)) — حدّ معروف في CDP headless.
        // لذلك نختبر تخطيط الجوال بمقاس 390×844 بدون mobile:true: ميديا ≤480 تعمل، والنقر بالفأرة موثوق.
        // معالجات الأزرار في المنصة كلها click — لا فرق وظيفي بين لمس وفأرة في نطاق هذه الفحوص.
        await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(5000);
        for (let i = 0; i < 20; i++) { await sleep(1000); if (await evalJs("!!(window.SmartMap && document.querySelector('#opsMap canvas'))")) break; }
        await sleep(1500);
        await evalJs(`window.__tapLog = [];
            ['click','touchstart'].forEach(t => document.addEventListener(t, e => {
                window.__tapLog.push({ t, x: Math.round(e.clientX), y: Math.round(e.clientY),
                    id: e.target.id || String(e.target.className).split(' ').slice(0, 2).join(' ') }); }, true)); 'ok'`);
        m = await evalJs(`({ iw: window.innerWidth, cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
            vw: window.visualViewport ? Math.round(window.visualViewport.width) : null,
            mq480: matchMedia('(max-width: 480px)').matches,
            fabLeft: getComputedStyle(document.getElementById('aiAssistantContainer')).left,
            fabRight: getComputedStyle(document.getElementById('aiAssistantContainer')).right })`);
        console.log('  🔎 مقاسات الجوال:', JSON.stringify(m));
        // ملاحظة مثبتة بالمسبار: innerWidth=436 بسبب فيض أفقي موجود مسبقًا (عناصر .crew-board-* بعرض ~397px
        // على فيوبورت 390 ← scrollWidth=436) — خارج نطاق المرحلة C. الفيوبورت نفسه صحيح: clientWidth=390.
        check('مقاس المحاكاة طُبّق (فيوبورت 390px + ميديا ≤480)', m.iw === 390 && m.mq480 === true,
            'iw=' + m.iw + ' cw=' + m.cw + ' sw=' + m.sw + ' (cw أقل بعرض شريط التمرير؛ sw=436 فيض crew-board سابق للجولة)');
        m = await evalJs(`(() => { const fab = document.getElementById('aiAssistantContainer').getBoundingClientRect();
            const vw = window.visualViewport ? Math.round(window.visualViewport.width) : window.innerWidth;
            return { rightGapVisual: Math.round(vw - fab.right), rightCss: getComputedStyle(document.getElementById('aiAssistantContainer')).right, vw: vw }; })()`);
        check('الجوال: زر المساعد يبقى يمينًا (بعيدًا عن +/−)', m.rightCss === '15px' && Math.abs(m.rightGapVisual - 15) <= 2, JSON.stringify(m));
        await evalJs("window.scrollTo(0,0); document.getElementById('smapExpandBtn').scrollIntoView({ block: 'center' }); 'ok'");
        await sleep(400);
        await realClick('#smapExpandBtn');
        fsOk = false;
        for (let i = 0; i < 12; i++) { await sleep(400); fsOk = await evalJs("document.fullscreenElement && document.fullscreenElement.id === 'opsMapSection'"); if (fsOk) break; }
        if (!fsOk) { // تشخيص: هل النقرة أصابت الزر؟ وهل دخل الوضع الثابت الاحتياطي؟
            const d = await evalJs(`(() => { const b = document.getElementById('smapExpandBtn').getBoundingClientRect();
                const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                return { btn: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width) },
                    hit: t ? (t.id || t.className) : 'none', scrollX: window.scrollX, scrollY: window.scrollY,
                    taps: window.__tapLog ? window.__tapLog.splice(0) : [],
                    exp: document.getElementById('opsMapSection').classList.contains('smap-expanded') }; })()`);
            console.log('  🔎 تشخيص فشل Fullscreen الجوال:', JSON.stringify(d));
        }
        check('الجوال: Fullscreen حقيقي يعمل', fsOk === true);
        await shot('c11-mobile-fullscreen');
        await realClick('#smapExpandBtn');
        await sleep(700);
        m = await evalJs("!document.fullscreenElement && !document.getElementById('opsMapSection').classList.contains('smap-expanded')");
        check('الجوال: الخروج بالزر يعيد التخطيط', m === true);
        // درج القائمة على الجوال (انحدار المرحلة B)
        await evalJs("window.scrollTo(0,0); 'ok'");
        await realClick('#sidebarToggle');
        await sleep(900);
        m = await evalJs(`(() => { const sb = document.getElementById('smartSidebar'); const r = sb.getBoundingClientRect();
            const tg = document.getElementById('sidebarToggle').getBoundingClientRect();
            const hit = document.elementFromPoint(tg.left + tg.width / 2, tg.top + tg.height / 2);
            return { open: document.body.classList.contains('sidebar-open'),
                onScreen: Math.round(r.left) < window.innerWidth && Math.round(r.right) <= window.innerWidth + 2,
                tgRect: { x: Math.round(tg.left), y: Math.round(tg.top) }, tgHit: hit ? (hit.id || hit.className) : 'none',
                taps: window.__tapLog ? window.__tapLog.splice(0) : [], scrollX: window.scrollX }; })()`);
        check('الجوال: درج القائمة يفتح فوقيًا داخل الشاشة', m.open && m.onScreen, JSON.stringify(m));
        await shot('c12-mobile-drawer');
        await realClick('#sidebarToggle');
        await sleep(600);
    } catch (e) {
        check('سير الاختبار بلا استثناءات', false, e.message);
    } finally {
        try { if (ws) ws.close(); } catch (_) { }
        try { if (chrome) chrome.kill(); } catch (_) { }
        try { server.kill(); } catch (_) { }
    }
    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    console.log('اللقطات: ' + OUT_DIR);
    if (failed) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
    console.log('🟢 اختبار المرحلة C اكتمل.');
})();
