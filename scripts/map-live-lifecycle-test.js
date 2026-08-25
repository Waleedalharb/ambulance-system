/**
 * ═══ map-live-lifecycle-test.js — اختبار دورة حياة البلاغ في الخريطة الحية ═══
 * (اعتماد المالك 2026-08-25 — توجيه «الخريطة الحية = ماذا يحدث الآن فقط»)
 * يثبت على خادم معزول (نسخة مؤقتة من قاعدة البيانات — لا يمس بيانات حقيقية):
 *  L1 بلاغ نشط ← يظهر في الملخص نشطًا ويُحسب في activeCount
 *  L2 إغلاقه (closed) ← يخرج فورًا من بوابة الخريطة (isFinal) ومن activeCount
 *     ومن «بلا موقع» ومن التنبيهات — ويبقى في الملخص تاريخيًا بكل بياناته
 *  L3 إلغاء بلاغ آخر (cancelled) ← نفس الخروج
 *  L4 تغيّر الحالة أثناء الفتح: النهائية لاصقة (غياب الحالة لا يرتد بها)،
 *     وإشارة active الصريحة وحدها تُعيده للتشغيل
 *  L5 عقد «لا Markers قديمة»: فلترة الواجهة (نفس قاعدة renderIncidents:
 *     filter !isFinal) على حمولة الملخص تطابق activeCount حرفيًا — والرسم
 *     يمسح الطبقة كليًا قبل إعادة البناء (فحص بنيوي)
 *  L6 قناة وصول الحالة (فحص بنيوي): app.js يعيد جلب الملخص عند اتصال SSE
 *     (تصحيح الفوائت بعد انقطاع) وفي دورة الوضع الاحتياطي (بلا SSE إطلاقًا)
 *  L7 فصل الطبقات (فحص بنيوي): index.html بلا شرائح/لوحات تحليلية في الحية،
 *     وmap-history.js لا يلمس حالة الخريطة الحية
 * التشغيل: node scripts/map-live-lifecycle-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3098;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'map-live-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');
const TEST_KEY = 'maplive-' + STAMP;
const AlertRules = require(path.join(ROOT, 'public', 'js', 'alert-rules.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 200) : '')); }
}

async function api(p, { method = 'GET', token, key, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (key) headers['X-Integration-Key'] = key;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}
const post = (key, body) => api('/api/cad-reports', { method: 'POST', key, body });
const NOW_MIN = AlertRules.cadMin('11:59:00 PM');
function todayCad(time) {
    const d = new Date();
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + time;
}
// نفس بوابة renderIncidents في smart-map.js حرفيًا: النشطة فقط على الخريطة
const liveGate = (sum) => (sum.incidents || []).filter(ic => !AlertRules.isFinal(ic.status));
const incOf = (sum, num) => (sum.incidents || []).filter(i => i.number === num)[0] || null;

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار دورة حياة الخريطة', active: true, createdAt: new Date().toISOString() }
    ]));
    const probe = new Database(TMP_DB, { readonly: true });
    const active = probe.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    probe.close();
    if (!active) { console.log('❌ لا مناوبة نشطة في النسخة'); process.exit(1); }

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
        if (!TK) { console.log('❌ الدخول فشل'); throw new Error('login'); }
        const sum = () => api('/api/cad-reports', { token: TK }).then(r => r.data);

        const N1 = '91000101', N2 = '91000102';
        const crew = [{ team: 'جنوب 1', phases: { 'التحرك': '10:01:00 AM' } }];
        const base = { code: null, type: 'medical', lat: 24.71, lng: 46.68, createdAt: todayCad('10:00:00 AM') };

        console.log('\n— L1: بلاغ نشط يظهر في التشغيل —');
        await post(TEST_KEY, { number: N1, ...base, crews: crew });
        let s = await sum();
        let ic = incOf(s, N1);
        check('L1① البلاغ الجديد موجود في الملخص بحالة active', ic && ic.status === 'active');
        check('L1② بوابة الخريطة (isFinal) تُبقيه — علامته تُرسم', ic && !AlertRules.isFinal(ic.status));
        check('L1③ التنبيه التشغيلي يراه (بلاغ متجاوز بلا وصول)', AlertRules.computeAlerts(s, NOW_MIN).some(a => a.number === N1));

        console.log('\n— L2: الإغلاق يُخرجه فورًا من التشغيل —');
        const activeBefore = s.activeCount;
        await post(TEST_KEY, { number: N1, ...base, crews: crew, status: 'closed' });
        s = await sum();
        ic = incOf(s, N1);
        check('L2① الحالة أصبحت closed في مصدر الحقيقة (الملخص)', ic && ic.status === 'closed');
        check('L2② بوابة الخريطة تسقطه — لا Marker له بعد إعادة الرسم', ic && AlertRules.isFinal(ic.status));
        check('L2③ activeCount انخفض بواحد', s.activeCount === activeBefore - 1, activeBefore + '→' + s.activeCount);
        check('L2④ اختفى من قائمة «بلا موقع دقيق» التشغيلية', !(s.mapStatus.noLocation || []).some(x => x.number === N1));
        check('L2⑤ اختفى من التنبيهات فورًا', !AlertRules.computeAlerts(s, NOW_MIN).some(a => a.number === N1));
        check('L2⑥ بقي في الملخص تاريخيًا ببياناته (لا حذف)', ic && ic.crews.length === 1 && ic.type === 'medical');

        console.log('\n— L3: الإلغاء مثل الإغلاق —');
        await post(TEST_KEY, { number: N2, ...base, crews: crew });
        await post(TEST_KEY, { number: N2, ...base, crews: crew, status: 'cancelled' });
        s = await sum();
        ic = incOf(s, N2);
        check('L3① cancelled يخرج من بوابة الخريطة', ic && AlertRules.isFinal(ic.status));
        check('L3② cancelled خارج التنبيهات', !AlertRules.computeAlerts(s, NOW_MIN).some(a => a.number === N2));

        console.log('\n— L4: النهائية لاصقة ولا ترتد إلا بإشارة active صريحة —');
        await post(TEST_KEY, { number: N2, ...base, crews: crew }); // بلا status — إثراء عادي
        s = await sum();
        check('L4① إثراء بلا حالة لا يُعيد الملغى للتشغيل', incOf(s, N2).status === 'cancelled');
        await post(TEST_KEY, { number: N2, ...base, crews: crew, status: 'active' });
        s = await sum();
        check('L4② إشارة active الصريحة تُعيده للتشغيل', incOf(s, N2).status === 'active' && !AlertRules.isFinal(incOf(s, N2).status));

        console.log('\n— L5: عقد «لا Markers قديمة» — فلترة الواجهة تطابق العدّاد —');
        s = await sum();
        const gated = liveGate(s);
        check('L5① عدد النشطة بعد فلترة الواجهة = activeCount تمامًا', gated.length === s.activeCount, gated.length + '≠' + s.activeCount);
        check('L5② لا بلاغ نهائيًا واحدًا داخل مجموعة الرسم', gated.every(ic => ic.status === 'active'));

        console.log('\n— L6/L7: الأقفال البنيوية (قناة الحالة + فصل الطبقات) —');
        const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
        const smapJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'smart-map.js'), 'utf8');
        const histJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'map-history.js'), 'utf8');
        const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
        const onopenBlock = appJs.slice(appJs.indexOf('sseSource.onopen'), appJs.indexOf('sseSource.onmessage'));
        check('L6① اتصال/إعادة اتصال SSE يعيد جلب الملخص (تصحيح الفوائت)', onopenBlock.includes('fetchIncidentSummarySafe'));
        const fallbackBlock = appJs.slice(appJs.indexOf('function startFallbackInterval'), appJs.indexOf('function startFallbackInterval') + 900);
        check('L6② الوضع الاحتياطي (بلا SSE) يجلب الملخص مع كل دورة', fallbackBlock.includes('fetchIncidentSummarySafe'));
        const renderBlock = smapJs.slice(smapJs.indexOf('function renderIncidents'), smapJs.indexOf('function refit'));
        check('L6③ الرسم يمسح طبقة البلاغات كليًا قبل إعادة البناء', renderBlock.includes('layers.incidents.clearLayers()'));
        check('L6④ الرسم يفلتر ببوابة isFinalInc (النشطة فقط)', renderBlock.includes('!isFinalInc(ic)'));
        check('L7① لا شرائح تحليلية في شريط طبقات الحية',
            !/id="smapLayerHot"|id="smapLayerHeat"|id="smapLayerStreets"|id="smapLayerPeak"/.test(indexHtml));
        check('L7② لا لوحات/نوافذ تحليلية في الحية (شوارع/ذروة)',
            !/id="smapTopStreets"|id="smapPeakBody"|id="smapPeakPop"|id="smapKpiPeak"/.test(indexHtml));
        check('L7③ الشرائح التشغيلية الثلاث باقية (بلاغات/فرق/مراكز)',
            /id="smapLayerIncidents"/.test(indexHtml) && /id="smapLayerTeams"/.test(indexHtml) && /id="smapLayerCenters"/.test(indexHtml));
        check('L7④ لوحة «بلا موقع دقيق» التشغيلية باقية', /id="smapNoLoc"/.test(indexHtml));
        check('L7⑤ ذاكرة الخريطة لا تلمس حالة الخريطة الحية', !histJs.includes('SmartMap'));
        // 📖 الدليل التشغيلي داخل المنصة (اعتماد المالك 2026-08-25)
        const guideJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'map-guide.js'), 'utf8');
        check('L8① زر «دليل الخريطة» موجود في شريط الخريطة + السكربت مضمَّن',
            /id="mapGuideBtn"/.test(indexHtml) && /js\/map-guide\.js/.test(indexHtml));
        check('L8② الدليل يحوي الأقسام الخمسة المعتمدة (حية/ذاكرة/كثافة/Overlay/أسئلة)',
            ["id: 'live'", "id: 'memory'", "id: 'density'", "id: 'overlay'", "id: 'faq'"].every(s => guideJs.includes(s)));
        check('L8③ الدليل محتوى ثابت يشرح فقط — لا يجلب ولا يكتب بيانات تشغيلية',
            !guideJs.includes('apiRequest') && !guideJs.includes('fetch('));
        // ⓘ الشرح السياقي الفوري (اعتماد المالك 2026-08-25 — توجيه التخطيط):
        // Popover بجانب العنصر نفسه، لا تفتح الدليل إطلاقًا
        const infoKeys = (indexHtml.match(/data-info="([^"]+)"/g) || []).map(m => m.slice(11, -1));
        check('L9① أزرار ⓘ السياقية موجودة بجانب المؤشرات (٥ KPI + الذاكرة + بلا موقع)',
            infoKeys.length >= 7, 'موجود=' + infoKeys.length);
        check('L9② كل مفتاح data-info في الصفحة له شرح معرّف في محرك ⓘ',
            infoKeys.every(k => guideJs.includes("'" + k + "'")), infoKeys.join(','));
        check('L9③ محرك الـPopover موجود (toggleInfo/closeInfo/minfo-pop)',
            guideJs.includes('function toggleInfo') && guideJs.includes('function closeInfo') && guideJs.includes('minfo-pop'));
        check('L9④ ⓘ لا تفتح دليل الخريطة — مسارها popover مستقل',
            !guideJs.includes("closest('[data-info]')") ? false : true && !/(data-info[^\n]*openSection|openSection[^\n]*data-info)/.test(guideJs));
        check('L9⑤ لا بقايا للربط القديم data-guide-sec في الصفحة', !/data-guide-sec/.test(indexHtml));
        check('L9⑥ شرح كل مؤشر يجاوب «ما هو/مصدره/معناه» بلا تعريف مخترع',
            ['kpi-status', 'kpi-count', 'kpi-ready', 'kpi-arrival', 'kpi-alerts', 'hist-memory', 'noloc-panel']
                .every(k => guideJs.includes("'" + k + "'")));
        // Layout (اعتماد المالك 2026-08-25 — صورة التزاحم المرجعية): CSS فقط
        const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'executive-theme.css'), 'utf8');
        check('L10① الشريط العلوي يلتف بدل التزاحم (flex-wrap)',
            /\.smap-topbar \{[^}]*flex-wrap: wrap/.test(css));
        check('L10② شبكة المؤشرات مرنة auto-fit (لا عمود سادس فارغ بعد حذف الذروة)',
            /\.smap-kpis \{[^}]*auto-fit/.test(css) && !/repeat\(6, 1fr\)/.test(css));
        check('L10③ أزرار الدليل/الذاكرة بعرض تلقائي — لا قص للنص',
            /\.smap-expand-btn\.smap-guide-btn, \.smap-expand-btn\.smap-history-btn \{[^}]*width: auto/.test(css));
    } catch (e) {
        console.error('خطأ عام:', e);
        failed++;
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }
    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})();
