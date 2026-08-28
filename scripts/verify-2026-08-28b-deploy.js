/**
 * تحقق إنتاجي فعلي — جولة 2026-08-28 (B) — commit bd6ef21
 * لا نكتفي بالاختبارات المحلية: نقرأ النسخة المنشورة نفسها ونثبت أن
 * التعديلات وصلت فعلًا (تعليم المالك: «الاختبارات وحدها لا تثبت الانعكاس»).
 */
const BASE = 'https://emsoperations.online';
const EXPECT_COMMIT = 'bd6ef21';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ✅ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail++; failures.push(name); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}
async function get(path) {
    const res = await fetch(BASE + path, { redirect: 'follow' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
}

(async () => {
    console.log('═══ تحقق إنتاجي: ' + BASE + ' ═══\n');

    // ① الصفحة الرئيسية — مركز الإشعارات + كسر الكاش
    const home = await get('/');
    check('الرئيسية 200', home.status === 200);
    const homeCC = home.headers.get('cache-control') || '';
    check('HTML بـ no-cache (إصلاح كسر الكاش)', /no-cache/.test(homeCC), 'Cache-Control: ' + homeCC);
    check('شريط الإشعارات (notifStrip) منشور', home.text.includes('id="notifStrip"'));
    check('تبويبات مركز الإشعارات منشورة', home.text.includes('data-nc2tab="unread"') && home.text.includes('data-nc2tab="all"'));
    check('app.js?v=48 مرقّى في المرجع', home.text.includes('js/app.js?v=48'));
    check('executive-theme.css?v=5 مرقّى في المرجع', home.text.includes('executive-theme.css?v=5'));
    check('أنماط nc2 الداكنة في الطبقة الختامية', home.text.includes('.nc2-tab') && home.text.includes('.notif-strip'));

    // ② app.js المنشور يحمل منطق التصميم ④ فعلًا
    const appjs = await get('/js/app.js?v=48');
    check('app.js?v=48 يُقدَّم 200', appjs.status === 200);
    check('منطق المركز منشور (updateNotifStrip/dedupeNotifications/nc2Esc)',
        ['updateNotifStrip', 'dedupeNotifications', 'nc2Esc', 'notifActionFor'].every(k => appjs.text.includes(k)));
    const appCC = appjs.headers.get('cache-control') || '';
    check('أصول JS سنة كاملة (كسرها بـ?v=)', /max-age=31536000/.test(appCC), 'Cache-Control: ' + appCC);

    // ③ صفحة الأرشيف — تبويب المستشفيات الجديد
    const dash = await get('/operations-dashboard.html');
    check('operations-dashboard.html 200', dash.status === 200);
    const dashCC = dash.headers.get('cache-control') || '';
    check('صفحة الأرشيف no-cache', /no-cache/.test(dashCC), 'Cache-Control: ' + dashCC);
    check('تبويب المستشفيات موجود', dash.text.includes('data-mtab="hospital"'));
    check('التصميم الجديد منشور (hosp-kpi/hosp-journey/hosp-timeline/hosp-calm)',
        ['.hosp-kpi', '.hosp-journey', '.hosp-timeline', '.hosp-calm', 'hosp-alert-banner'].every(k => dash.text.includes(k)));
    check('Timeline الحقيقي بأيقونات الأحداث منشور', ['tl-seen', 'tl-alert', 'tl-resolved'].every(k => dash.text.includes(k)));
    check('البطاقات البيضاء القديمة أُزيلت', !dash.text.includes('var(--gray-100,#f3f4f6)'));

    // ④ تعديلات الخريطة السابقة ما زالت موجودة في الإنتاج
    const adapter = await get('/js/map-adapter.js');
    check('map-adapter.js موجود في الإنتاج', adapter.status === 200 && adapter.text.length > 1000, 'bytes=' + adapter.text.length);
    const theme = await get('/css/executive-theme.css?v=5');
    check('executive-theme.css?v=5 يُقدَّم 200', theme.status === 200);
    check('ثيم الخريطة الفاتح (.smap-light-ops) موجود في CSS المنشور', theme.text.includes('.smap-light-ops'));

    // ⑤ صحة الخادم
    const health = await get('/health').catch(() => null);
    if (health) check('صحة الخادم /api/health', health.status === 200);
    else { const up = await get('/api/uptime').catch(() => null); check('صحة الخادم', !!up && up.status === 200); }

    console.log('\n═══════════════════════════');
    console.log('النتيجة الإنتاجية: ' + pass + ' ناجح / ' + fail + ' فاشل — commit متوقع: ' + EXPECT_COMMIT);
    if (failures.length) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('✅ النسخة المنشورة تحمل الجولة كاملة فعليًا');
})().catch(e => { console.error('انهار التحقق:', e.message); process.exit(1); });
