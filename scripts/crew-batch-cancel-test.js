/**
 * ═══ crew-batch-cancel-test.js — اختبار الاختيار الجماعي لفرق البلاغ (اعتماد المالك 2026-08-25) ═══
 * يثبت أن التحسين معزول وواجهة صرفة فوق نفس الحماية القائمة:
 *   القسم أ — الوحدة (vm sandbox): وضع التحديد + العدّاد + تحديد الكل (يشمل
 *     الفعلية — قرار المالك) + تنفيذ الدفعة بتأكيد واحد وبرسمة واحدة فقط +
 *     نتيجة صادقة عند الفشل الجزئي + إلغاء المستخدم يوقف كل شيء.
 *   القسم ب — الخادم (قاعدة معزولة): إلغاء 3 فرق دفعة واحدة عبر نفس endpoint
 *     الفردي (لا تجاوز حماية) ← تُستبعد من العدّادات، والرابعة تبقى، والإلغاء
 *     الفردي والاستعادة يعملان كما كانا.
 *   القسم ج — فحوص ساكنة: تضمين السكربت بعد app.js + خطافا العرض + زر الإلغاء
 *     الفردي ✕ ما زال موصولًا (لا كسر للمسار القائم).
 * التشغيل: node scripts/crew-batch-cancel-test.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODULE_SRC = path.join(ROOT, 'public', 'js', 'crew-batch-cancel.js');
const NUM = '1312523';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
}

/* ═══════════ القسم أ — الوحدة في vm sandbox ═══════════ */
function makeSandbox(opts) {
    const calls = { api: [], prompts: 0, renders: 0, scrolls: 0, toasts: [] };
    const elements = {}; // سجل العناصر الوهمية بالمعرف
    const elStub = () => ({ textContent: '', disabled: false, checked: false });
    const boxes = (opts.boxes || []).map(u => { const b = elStub(); b.dataset = { unit: u }; return b; });
    const windowObj = {
        __opsPermsState: opts.perms === false ? { loaded: true, perms: [] } : { loaded: true, perms: ['ops.dispatch'] },
        scrollY: 0,
        scrollTo: () => { calls.scrolls++; },
        prompt: () => { calls.prompts++; return opts.promptNull ? null : 'سبب موحد للاختبار'; }
    };
    const ctx = {
        console,
        window: windowObj,
        document: {
            getElementById: (id) => elements[id] || (elements[id] = elStub()),
            querySelectorAll: (sel) => /data-cbc/.test(sel) ? boxes : []
        },
        AuthManager: {
            apiRequest: async (url, init) => {
                calls.api.push({ url, init });
                const m = /crews\/(.+)\/cancel$/.exec(url);
                const unit = m ? decodeURIComponent(m[1]) : '?';
                if (opts.failOn && unit === opts.failOn) return { ok: false, status: 500, json: async () => ({ error: 'خطأ مقصود' }) };
                if (opts.alreadyOn && unit === opts.alreadyOn) return { ok: true, status: 200, json: async () => ({ success: true, already: true, unit }) };
                return { ok: true, status: 200, json: async () => ({ success: true, already: false, unit }) };
            }
        },
        showToast: (msg, kind) => { calls.toasts.push({ msg, kind }); },
        Promise, Set, JSON, encodeURIComponent, decodeURIComponent, String, Array, Object
    };
    windowObj.renderAdvancedDistribution = async () => { calls.renders++; };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(MODULE_SRC, 'utf8'), ctx, { filename: 'crew-batch-cancel.js' });
    return { ctx, calls, api: ctx.window.CrewBatchCancel, boxes };
}
const IC = { number: NUM, crews: [
    { unit: 'جنوب 1' }, { unit: 'جنوب 4' }, { unit: 'جنوب 5' }, // جنوب 5 مشاركة فعلية
    { unit: 'جنوب 6', manualCancelled: true } // ملغاة يدويًا أصلًا — لا تُحدَّد
] };

async function moduleSection() {
    console.log('🧪 القسم أ — وحدة الاختيار الجماعي (vm sandbox)\n');

    // أ1: خارج الوضع — زر ☑ تحديد فقط، ولا checkboxes
    let sb = makeSandbox({});
    check('أ1 خارج الوضع: زر ☑ تحديد ظاهر ولا شريط أدوات', /☑ تحديد/.test(sb.api.incidentControlsHtml(IC)) && !/حذف المحدد/.test(sb.api.incidentControlsHtml(IC)));
    check('أ2 checkbox فارغة خارج وضع التحديد', sb.api.chipCheckboxHtml(NUM, 'جنوب 1') === '');

    // أ3: بلا صلاحية ops.dispatch — لا أدوات إطلاقًا (نفس حماية الزر الفردي)
    let sbNoPerm = makeSandbox({ perms: false });
    check('أ3 بلا صلاحية ops.dispatch ← لا زر ولا شريط (نفس الحماية)', sbNoPerm.api.incidentControlsHtml(IC) === '');

    // أ4: تفعيل الوضع ← شريط كامل + رسمة واحدة للتبديل
    sb.api.toggleMode(NUM);
    await new Promise(r => setTimeout(r, 5));
    const bar = sb.api.incidentControlsHtml(IC);
    check('أ4 الوضع مفعّل: تحديد الكل + إلغاء الكل + عدّاد + حذف المحدد + خروج',
        /تحديد الكل/.test(bar) && /إلغاء تحديد الكل/.test(bar) && /المحدد: 0/.test(bar) && /حذف المحدد \(0\)/.test(bar) && /✖ خروج/.test(bar));
    check('أ5 الملغاة يدويًا أصلًا (جنوب 6) خارج قائمة التحديد', !sb.api.isSelected(NUM, 'جنوب 6'));

    // أ6: «تحديد الكل» يحدد كل الظاهرة غير الملغاة — بما فيها الفعلية (قرار المالك)
    sb.api.selectAll(NUM);
    check('أ6 تحديد الكل ← 3 فرق بما فيها الفعلية جنوب 5 (المستخدم يستثني يدويًا)',
        sb.api.isSelected(NUM, 'جنوب 1') && sb.api.isSelected(NUM, 'جنوب 4') && sb.api.isSelected(NUM, 'جنوب 5'));
    check('أ7 checkboxes انعكست محددة في DOM', sb.boxes.every(b => b.checked === true));

    // أ8: استثناء الفعلية يدويًا ← العدّاد يتحدث مباشرة بلا إعادة رسم
    const rendersBefore = sb.calls.renders;
    sb.api.toggleUnit(NUM, 'جنوب 5', null);
    check('أ8 إلغاء تحديد الفعلية ← محدد=2 وبلا أي إعادة رسم', !sb.api.isSelected(NUM, 'جنوب 5') && sb.calls.renders === rendersBefore);
    check('أ9 إلغاء تحديد الكل ← صفر', (sb.api.clearSelection(NUM), !sb.api.isSelected(NUM, 'جنوب 1')));

    // أ10: المستخدم يلغي التأكيد ← لا طلبات ولا رسم
    let sbAbort = makeSandbox({ promptNull: true });
    sbAbort.api.toggleMode(NUM); sbAbort.api.incidentControlsHtml(IC); sbAbort.api.selectAll(NUM);
    await sbAbort.api.run(NUM);
    check('أ10 إلغاء التأكيد الواحد ← صفر طلبات وصفر رسم', sbAbort.calls.prompts === 1 && sbAbort.calls.api.length === 0 && sbAbort.calls.renders === 1); // رسمة toggleMode فقط

    // أ11: الدفعة الكاملة — تأكيد واحد + طلبات متسلسلة + رسمة واحدة في النهاية
    let sbRun = makeSandbox({});
    sbRun.api.toggleMode(NUM); // رسمة 1
    sbRun.api.incidentControlsHtml(IC); // renderer يعيد رسم الشريط بعد التفعيل (يملأ قائمة الفرق)
    sbRun.api.selectAll(NUM);
    sbRun.api.toggleUnit(NUM, 'جنوب 5', null); // نستثني الفعلية — المثال الحرفي للمالك
    const rendersPre = sbRun.calls.renders;
    await sbRun.api.run(NUM);
    check('أ11 تأكيد واحد فقط للدفعة كاملة', sbRun.calls.prompts === 1, 'prompts=' + sbRun.calls.prompts);
    check('أ12 طلبا cancel للمحددتين بنفس المسار الفردي والسبب الموحد',
        sbRun.calls.api.length === 2 &&
        sbRun.calls.api.every(c => /\/api\/cad-reports\/1312523\/crews\//.test(c.url) && /\/cancel$/.test(c.url) && c.init.method === 'POST' && c.init.body.includes('سبب موحد للاختبار')),
        JSON.stringify(sbRun.calls.api.map(c => c.url)));
    check('أ13 الترتيب كما حدد المستخدم: جنوب 1 ثم جنوب 4', /%D8%AC%D9%86%D9%88%D8%A8%201/.test(sbRun.calls.api[0].url) && /%D8%AC%D9%86%D9%88%D8%A8%204/.test(sbRun.calls.api[1].url));
    check('أ14 ⭐ رسمة واحدة فقط بعد الدفعة كلها (لا Refresh بعد كل فرقة)', sbRun.calls.renders === rendersPre + 1, 'renders=' + sbRun.calls.renders);
    check('أ15 الموضع يُستعاد بعد الرسمة (scrollTo)', sbRun.calls.scrolls >= 1);
    check('أ16 نتيجة ناجحة صادقة + الخروج من الوضع ومسح التحديد',
        sbRun.calls.toasts.some(t => t.kind === 'success' && /أُلغي تسجيل 2 فرقة/.test(t.msg)) && !sbRun.api.isActive(NUM));

    // أ17: فشل جزئي ← نتيجة صادقة بالاسم، ولا «نجاح كامل» كاذب، ورسمة واحدة
    let sbFail = makeSandbox({ failOn: 'جنوب 4' });
    sbFail.api.toggleMode(NUM); sbFail.api.incidentControlsHtml(IC); sbFail.api.selectAll(NUM); sbFail.api.toggleUnit(NUM, 'جنوب 5', null);
    await sbFail.api.run(NUM);
    const errToast = sbFail.calls.toasts.find(t => t.kind === 'error');
    check('أ17 فشل عنصر ← toast خطأ يذكر الفرقة والسبب ولا نجاح كاذب',
        !!errToast && /فشل 1/.test(errToast.msg) && /جنوب 4/.test(errToast.msg) && /خطأ مقصود/.test(errToast.msg) && /أُلغي تسجيل 1 فرقة/.test(errToast.msg),
        JSON.stringify(sbFail.calls.toasts));

    // أ18: «كانت ملغاة أصلًا» تُحسب منفصلة بصدق
    let sbAl = makeSandbox({ alreadyOn: 'جنوب 1' });
    sbAl.api.toggleMode(NUM); sbAl.api.incidentControlsHtml(IC); sbAl.api.selectAll(NUM); sbAl.api.toggleUnit(NUM, 'جنوب 5', null);
    await sbAl.api.run(NUM);
    check('أ18 الملغاة أصلًا تُذكر منفصلة (idempotent)', sbAl.calls.toasts.some(t => t.kind === 'success' && /كانت ملغاة أصلًا/.test(t.msg)), JSON.stringify(sbAl.calls.toasts));
}

/* ═══════════ القسم ب — الخادم (قاعدة معزولة) ═══════════ */
const PORT = 3096;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const NB = String(Date.now()).slice(-7);
const TMP_DIR = path.join(os.tmpdir(), 'cbc-srv-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

async function api(p, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

async function serverSection() {
    console.log('\n🧪 القسم ب — الخادم: دفعة عبر نفس endpoint الفردي (قاعدة معزولة)\n');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) throw new Error('login');
        const N = '7' + NB + '7';
        const sum = () => api('/api/cad-reports', { token: TK }).then(r => r.data);
        const s0 = await sum(); // خط الأساس قبل نشر البلاغ
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;
        const crewOf = (s, unit) => { const inc = (s.incidents || []).find(i => i.number === N); return inc ? (inc.crews || []).find(c => c.unit === unit) : null; };
        // بلاغ بأربع فرق (مسار يدوي — كلها محتسبة بالقاعدة القائمة)
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: N, type: 'medical', crews: [{ team: 'جنوب 1' }, { team: 'جنوب 4' }, { team: 'جنوب 5' }, { team: 'جنوب 6' }] } });

        // ب1: دفعة ثلاث فرق عبر نفس endpoint الفردي (محاكاة حرفية لتنفيذ الواجهة)
        const batch = ['جنوب 1', 'جنوب 4', 'جنوب 6'];
        const results = [];
        for (const u of batch) {
            const r = await api('/api/cad-reports/' + encodeURIComponent(N) + '/crews/' + encodeURIComponent(u) + '/cancel',
                { method: 'POST', token: TK, body: { reason: 'تنظيف جماعي — فرق خطة لم تستجب' } });
            results.push(r.data);
        }
        check('ب1 الدفعة: الثلاثة نجحوا عبر نفس الحماية القائمة (بلا تجاوز)', results.every(d => d && d.success === true));
        let s = await sum();
        check('ب2 الثلاثة manual_cancelled مستبعدون من العدّادات ومحفوظون في السجل',
            batch.every(u => { const c = crewOf(s, u); return c && c.manualCancelled === true && c.counted === false; }) &&
            batch.every(u => ((s.byCrew || {})[u] || 0) === c0(u)), JSON.stringify(batch.map(u => crewOf(s, u))));
        check('ب3 الفعلية جنوب 5 بقيت محتسبة لم تُمس', (() => { const c = crewOf(s, 'جنوب 5'); return c && c.counted === true && c.manualCancelled !== true && ((s.byCrew || {})['جنوب 5'] || 0) === c0('جنوب 5') + 1; })());
        check('ب4 البلاغ نفسه باقٍ ولم يُحذف (إزالة فرق فقط)', (s.incidents || []).some(i => i.number === N));

        // ب5: الإلغاء الفردي ما زال يعمل + الاستعادة
        const r5 = await api('/api/cad-reports/' + encodeURIComponent(N) + '/crews/' + encodeURIComponent('جنوب 5') + '/cancel', { method: 'POST', token: TK, body: { reason: null } });
        const r6 = await api('/api/cad-reports/' + encodeURIComponent(N) + '/crews/' + encodeURIComponent('جنوب 5') + '/restore', { method: 'POST', token: TK, body: {} });
        s = await sum();
        check('ب5 الفردي يعمل: إلغاء جنوب 5 ثم استعادتها محتسبة كما كانت',
            r5.data && r5.data.success && r6.data && r6.data.success && ((s.byCrew || {})['جنوب 5'] || 0) === c0('جنوب 5') + 1);

        // ب6: إلغاء عنصر ملغى أصلًا ← already بصدق (idempotent للدفعات المتكررة)
        const r7 = await api('/api/cad-reports/' + encodeURIComponent(N) + '/crews/' + encodeURIComponent('جنوب 1') + '/cancel', { method: 'POST', token: TK, body: {} });
        check('ب6 إعادة إلغاء الملغاة ← already=true بلا تكرار قيد', r7.data && r7.data.success && r7.data.already === true);
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }
}

/* ═══════════ القسم ج — فحوص ساكنة ═══════════ */
function staticSection() {
    console.log('\n🧪 القسم ج — فحوص ساكنة (الواجهة والتضمين)\n');
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const iApp = indexHtml.indexOf('js/app.js'), iCbc = indexHtml.indexOf('js/crew-batch-cancel.js');
    check('ج1 crew-batch-cancel.js مضمّن بعد app.js مباشرة', iApp !== -1 && iCbc > iApp);
    check('ج2 خطاف الشارة (chipCheckboxHtml) موصول في renderer', appJs.includes('window.CrewBatchCancel.chipCheckboxHtml(ic.number, c.unit)'));
    check('ج3 خطاف شريط البطاقة (incidentControlsHtml) موصول في renderer', appJs.includes('window.CrewBatchCancel.incidentControlsHtml(ic)'));
    check('ج4 زر الإلغاء الفردي ✕ ما زال موصولًا كما كان (لا كسر للمسار القائم)', /onclick="cancelCrewRegistration\(/.test(appJs) && appJs.includes('async function cancelCrewRegistration'));
    check('ج5 لا تعديل على منطق الاحتساب: الواجهة الجديدة لا تستدعي isParticipationCounted إطلاقًا', !fs.readFileSync(MODULE_SRC, 'utf8').includes('isParticipationCounted('));
}

(async () => {
    await moduleSection();
    await serverSection();
    staticSection();
    console.log('\n═══ النتيجة الإجمالية: ' + passed + ' ✅ / ' + failed + ' ❌ ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥 خطأ غير متوقع:', e); process.exit(1); });
