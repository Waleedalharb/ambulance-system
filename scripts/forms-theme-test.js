/**
 * ═══ اختبار توحيد ثيم النماذج — forms-theme-test.js ═══
 * اعتماد المالك 2026-09-01 (جولة Operations UI Theme Audit — المرحلة ②):
 * يثبت بعد تنفيذ R1–R10 على الخادم المعزول:
 *   R1: نص الحقول فاتح (lum>180) في النماذج الستة كلها
 *   R2/R3: جداول وتسميات داكنة/واضحة — صفر أسطح فاتحة + صفر نصوص منخفضة التباين
 *   R4: أسطح senior الداخلية (شبكة التواقيع/شرائح coral) داكنة + لكنة هوية باقية
 *   R5: قاعدة #analyticsModal .analytics-section محمية (حارس التعليق الآكل)
 *   R6: analyticsModal + controlModal داكنان بالكامل
 *   R8: Focus فعلي يغيّر الحد/الهالة لكل نموذج
 *   R9: checkbox/radio accent أزرق المنصة
 *   Placeholder أهدأ من النص الفعلي (طبقة بصرية مستقلة)
 *   حارسان ساكنان: لا نمط تعليق آكل في public/css/*.css + قاعدة analytics موجودة في cssRules الحية
 * العزل: VACUUM INTO + DATA_DIR مؤقت. التشغيل: node scripts/forms-theme-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'forms-th-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'forms-th-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'forms-th-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'forms-theme-test-' + STAMP);
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9453;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FORMS = ['senior', 'air', 'escalation', 'e', 'incident', 'daily'];

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

// قياس شامل داخل حاوية معطاة (formContent أو modal)
const MEASURE = `(rootSel => {
    const root = document.querySelector(rootSel);
    if (!root) return { error: 'no root: ' + rootSel };
    const parse = s => { const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/.exec(s || ''); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
    const lum = c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const effBg = el => { let n = el; while (n && n !== document.documentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; n = n.parentElement; } return { r: 11, g: 18, b: 32, a: 1 }; };
    const selOf = el => el.id ? '#' + el.id : el.tagName.toLowerCase() + (String(el.className || '').trim() ? '.' + String(el.className).trim().split(/\\s+/).slice(0, 2).join('.') : '');
    const S = { white: [], badText: [], inputColors: [], inputBgs: [], placeholders: [],
        inputCount: 0, selectCount: 0, checkboxAccent: null, btnBad: [], btnCount: 0 };
    for (const el of root.querySelectorAll('*')) {
        if (S.white.length >= 12 && S.badText.length >= 12) break;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const bg = parse(cs.backgroundColor);
        if (bg && bg.a > 0.8 && lum(bg) > 180 && r.width > 40 && r.height > 14)
            S.white.push({ sel: selOf(el), bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height), txt: (el.textContent || '').trim().slice(0, 30) });
        const ownText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (ownText) {
            const tc = parse(cs.color); const eb = effBg(el);
            if (tc && eb) { const tl = lum(tc), bl = lum(eb);
                if ((bl < 70 && tl < 100) || (bl > 180 && tl > 150))
                    S.badText.push({ sel: selOf(el), color: cs.color, onBgLum: Math.round(bl), txt: (el.textContent || '').trim().slice(0, 30) }); }
        }
    }
    for (const el of root.querySelectorAll('input, select, textarea')) {
        const cs = getComputedStyle(el); S.inputCount++;
        const col = parse(cs.color), bg = parse(cs.backgroundColor);
        if (col) S.inputColors.push(Math.round(lum(col)));
        if (bg) S.inputBgs.push(Math.round(lum(bg)));
        // Placeholder يُقاس فقط لعناصر تحمل السمة فعلًا (select/بلا سمة = لا placeholder حقيقي)
        if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.hasAttribute('placeholder')) {
            const ph = parse(getComputedStyle(el, '::placeholder').color);
            if (ph) S.placeholders.push(Math.round(lum(ph)));
        }
        if (el.tagName === 'SELECT') S.selectCount++;
    }
    const cb = root.querySelector('input[type="checkbox"], input[type="radio"]');
    if (cb) S.checkboxAccent = getComputedStyle(cb).accentColor;
    for (const el of root.querySelectorAll('button, .btn')) {
        const r = el.getBoundingClientRect(); if (r.width < 20 || r.height < 10) continue;
        const cs = getComputedStyle(el); const tc = parse(cs.color);
        S.btnCount++;
        if (tc && lum(tc) < 120) S.btnBad.push({ sel: selOf(el), color: cs.color, txt: (el.textContent || '').trim().slice(0, 24) });
    }
    return S;
})`;

// قياس Focus فعلي: قبل/بعد على أول حقل مرئي (المخفية لا تلتقط :focus)
const FOCUS_MEASURE = `(rootSel => {
    const root = document.querySelector(rootSel);
    if (!root) return { error: 'no root' };
    const cands = [...root.querySelectorAll('input, select, textarea')]
        .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 10 && !el.disabled);
    const fi = cands[0];
    if (!fi) return { error: 'no visible input' };
    const snap = el => { const cs = getComputedStyle(el); return { border: cs.borderTopColor, shadow: cs.boxShadow, outline: cs.outlineStyle + '|' + cs.outlineColor }; };
    const before = snap(fi);
    fi.focus();
    const after = snap(fi);
    const isActive = document.activeElement === fi;
    fi.blur();
    return { before, after, isActive, changed: JSON.stringify(before) !== JSON.stringify(after) };
})`;

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // ══ حارس ساكن (أ): لا نمط تعليق آكل «x-*/» داخل أي ورقة CSS ══
    console.log('\n══ حارس ساكن: التعليق الآكل ══');
    const cssDir = path.join(ROOT, 'public', 'css');
    let eaterHits = [];
    for (const f of fs.readdirSync(cssDir).filter(x => x.endsWith('.css'))) {
        const src = fs.readFileSync(path.join(cssDir, f), 'utf8');
        const re = /[A-Za-z0-9\u0600-\u06FF]-\*\//g;
        let m; while ((m = re.exec(src))) eaterHits.push(f + ' @' + src.slice(0, m.index).split('\n').length);
    }
    check('لا نمط «كلمة-*/» آكل للتعليقات في أي CSS', eaterHits.length === 0, eaterHits.join(' | '));

    // ══ خادم معزول ══
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }
    console.log('\n🚀 خادم معزول على ' + PORT + ' — اختبار ثيم النماذج');
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
        // محاكاة تركيز النافذة — بدونها headless لا يطابق :focus رغم صحة activeElement
        await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
        await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('aiAssistantVisited','true');}catch(e){}" });

        // ── دخول ──
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3500);
        if (await evalJs("!!document.getElementById('loginUsername')")) {
            await evalJs("document.getElementById('loginUsername').value='4252'; document.getElementById('loginPassword').value='4252'; document.getElementById('loginBtn').click(); 'ok'");
            for (let i = 0; i < 20; i++) { await sleep(700); if (await evalJs("!!localStorage.getItem('auth_access_token')")) break; }
        }
        check('تسجيل الدخول', await evalJs("!!localStorage.getItem('auth_access_token')") === true);
        await sleep(4000);

        // ══ حارس حي (ب): قاعدة analytics-section موجودة في cssRules (إثبات استعادتها من التعليق الآكل) ══
        const analyticsRuleAlive = await evalJs(`(() => {
            for (const sh of document.styleSheets) {
                let href = ''; try { href = sh.href || ''; } catch (_) { continue; }
                if (!href.includes('executive-theme.css')) continue;
                try {
                    for (const r of sh.cssRules) {
                        if (r.selectorText && r.selectorText.includes('#analyticsModal') && r.selectorText.includes('.analytics-section')) return true;
                    }
                } catch (_) { }
            }
            return false;
        })()`);
        check('حارس حي: قاعدة #analyticsModal .analytics-section محللة وموجودة في الورقة', analyticsRuleAlive === true);

        // ══ النماذج الستة ══
        await evalJs("openModalById('formsModal'); loadFormsList(); 'ok'");
        await sleep(1500);
        for (const id of FORMS) {
            console.log('\n══ نموذج: ' + id + ' ══');
            await evalJs("loadForm('" + id + "'); 'ok'");
            for (let i = 0; i < 24; i++) { await sleep(500); if (await evalJs("!!document.querySelector('#formContent *')").catch(() => false)) break; }
            await sleep(3000);
            const S = await evalJs(MEASURE + "('#formContent')");
            if (S.error) { check(id + ': الحاوية موجودة', false, S.error); continue; }
            await shot('after-' + id);
            check(id + ': صفر أسطح فاتحة', S.white.length === 0, JSON.stringify(S.white.slice(0, 3)));
            check(id + ': صفر نصوص منخفضة التباين', S.badText.length === 0, JSON.stringify(S.badText.slice(0, 3)));
            check(id + ': نص الحقول فاتح (lum>180) — ' + S.inputCount + ' حقلًا',
                S.inputCount > 0 && S.inputColors.every(l => l > 180), 'ألوان: ' + S.inputColors.join(','));
            const maxPh = S.placeholders.length ? Math.max(...S.placeholders) : 0;
            const minTxt = S.inputColors.length ? Math.min(...S.inputColors) : 999;
            check(id + ': Placeholder أهدأ من النص وضمن النطاق الهادئ (60–170)',
                S.placeholders.length === 0 || (maxPh <= 170 && maxPh >= 60 && maxPh < minTxt),
                'placeholder=' + S.placeholders.join(',') + ' نص=' + minTxt);
            if (S.checkboxAccent !== null)
                check(id + ': accent-color أزرق المنصة', S.checkboxAccent === 'rgb(59, 130, 246)', S.checkboxAccent);
            check(id + ': أزرار بنص مقروء (' + S.btnCount + ' زرًا)', S.btnBad.length === 0, JSON.stringify(S.btnBad.slice(0, 3)));
            const F = await evalJs(FOCUS_MEASURE + "('#formContent')");
            check(id + ': Focus فعلي يغيّر الحد/الهالة', !F.error && F.changed === true, JSON.stringify(F).slice(0, 220));
        }
        // لقطة Focus مرئية على آخر نموذج
        await evalJs("(() => { const fi = document.querySelector('#formContent input[type=\"text\"], #formContent input:not([type]), #formContent textarea'); if (fi) fi.focus(); return 'ok'; })()");
        await sleep(600);
        await shot('after-focus-visible');

        // ══ analyticsModal ══
        console.log('\n══ analyticsModal ══');
        await evalJs("closeModalById('formsModal'); openModalById('analyticsModal'); try{ renderAnalyticsDashboard(); }catch(e){}; 'ok'");
        await sleep(3500);
        const A = await evalJs(MEASURE + "('#analyticsModal .modal-content')");
        await shot('after-analytics');
        check('analytics: صفر أسطح فاتحة', !A.error && A.white.length === 0, JSON.stringify((A.white || []).slice(0, 3)));
        check('analytics: صفر نصوص منخفضة التباين', !A.error && A.badText.length === 0, JSON.stringify((A.badText || []).slice(0, 3)));

        // ══ controlModal ══
        console.log('\n══ controlModal ══');
        await evalJs("closeModalById('analyticsModal'); openModalById('controlModal'); try{ loadVacations().then(function(){ renderControlList(false); }); }catch(e){}; 'ok'");
        await sleep(3500);
        const C = await evalJs(MEASURE + "('#controlModal .modal-content')");
        await shot('after-control');
        check('control: صفر أسطح فاتحة', !C.error && C.white.length === 0, JSON.stringify((C.white || []).slice(0, 3)));
        check('control: صفر نصوص منخفضة التباين', !C.error && C.badText.length === 0, JSON.stringify((C.badText || []).slice(0, 3)));
        // بطاقات الأفراد داكنة تحديدًا — مع تركيب الشفافية فوق الخلفية الداكنة
        // (rgba(255,255,255,0.035) زجاج داكن صحيح، لا سطح فاتح)
        const personDark = await evalJs(`(() => {
            const el = document.querySelector('#controlModal .control-person');
            if (!el) return 'no-card';
            const bg = getComputedStyle(el).backgroundColor;
            const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(bg);
            if (!m) return 'unparsed:' + bg;
            const a = m[4] === undefined ? 1 : +m[4];
            // تركيب فوق خلفية المنصة الداكنة #0B1220
            const lum = 0.299 * (+m[1] * a + 11 * (1 - a)) + 0.587 * (+m[2] * a + 18 * (1 - a)) + 0.114 * (+m[3] * a + 32 * (1 - a));
            return lum < 90 ? 'dark' : 'light:' + bg + ' effLum=' + Math.round(lum);
        })()`);
        check('control: بطاقة .control-person داكنة', personDark === 'dark' || personDark === 'no-card', personDark);

        console.log('\n════════════════ نتيجة اختبار ثيم النماذج: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
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
