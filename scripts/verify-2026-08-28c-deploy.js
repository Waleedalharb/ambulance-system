/**
 * تحقق إنتاجي فعلي — جولة 2026-08-28 (C) — commit 0e62c35
 * شكل التنبيه السفلي الجديد + استمرار جولة (B). الخريطة تبقى Leaflet
 * حتى يُحسم قرار التوكن (GitHub Push Protection).
 */
const BASE = 'https://emsoperations.online';
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ✅ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail++; failures.push(name); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}
async function get(p) { const r = await fetch(BASE + p); return { status: r.status, headers: r.headers, text: await r.text() }; }

(async () => {
    console.log('═══ تحقق إنتاجي (C): ' + BASE + ' ═══\n');
    const home = await get('/');
    check('الرئيسية 200', home.status === 200);
    check('HTML no-cache', /no-cache/.test(home.headers.get('cache-control') || ''));
    check('app.css?v=35 في المرجع', home.text.includes('app.css?v=35'));
    check('app.js?v=48 في المرجع', home.text.includes('js/app.js?v=48'));
    check('مركز الإشعارات (B) ما زال منشورًا', home.text.includes('id="notifStrip"') && home.text.includes('data-nc2tab="all"'));

    const css = await get('/css/app.css?v=35');
    check('app.css?v=35 يُقدَّم 200', css.status === 200);
    check('التوست الداكن الزجاجي منشور', css.text.includes('rgba(10,18,34,0.98)'));
    check('ألوان الأنواع التشغيلية منشورة (tk-report/tk-hospital/tk-completion)', ['tk-report', 'tk-hospital', 'tk-completion'].every(k => css.text.includes(k)));
    check('بنية التوست (toast-kind/toast-close/toast-action-btn)', ['toast-kind', 'toast-close', 'toast-action-btn'].every(k => css.text.includes(k)));
    check('الخلفيات الفاتحة القديمة للتوست أُزيلت', !/toast-notification\.(success|error|warning|info) \{ background: var\(--(teal|coral|gold|info)-50/.test(css.text));

    const appjs = await get('/js/app.js?v=48');
    check('منطق التوست الجديد منشور (toastActionRun/kindMap)', appjs.text.includes('toastActionRun') && appjs.text.includes('kindMap'));
    check('SSE يمرر النوع الحقيقي (_n.type)', appjs.text.includes("_n.type || 'info'"));

    const dash = await get('/operations-dashboard.html');
    check('تبويب المستشفيات (B) ما زال منشورًا', dash.text.includes('.hosp-kpi') && dash.text.includes('hosp-alert-banner'));

    const mapcfg = await get('/js/map-config.js');
    check('map-config.js: leaflet حاليًا (التوكن ينتظر قرار المالك)', mapcfg.text.includes("provider: 'leaflet'"));

    const health = await get('/health');
    check('صحة الخادم /health', health.status === 200);

    console.log('\n═══════════════════════════');
    console.log('النتيجة الإنتاجية (C): ' + pass + ' ناجح / ' + fail + ' فاشل');
    if (failures.length) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('✅ جولة التنبيهات منشورة فعليًا');
})().catch(e => { console.error('انهار التحقق:', e.message); process.exit(1); });
