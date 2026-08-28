/**
 * تحقق إنتاجي فعلي — جولة 2026-08-28 (D) — المسار «ب» (MAPBOX_PUBLIC_TOKEN)
 * يفحص مسار الحقن في الإنتاج ويكشف حالته: no-op (المتغير غير مضبوط بعد)
 * أو mapbox (المتغير مضبوط). لا يطبع التوكن إطلاقًا — يعرض حالته فقط.
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
    console.log('═══ تحقق إنتاجي (D): ' + BASE + ' ═══\n');
    const home = await get('/');
    check('الرئيسية 200 + no-cache', home.status === 200 && /no-cache/.test(home.headers.get('cache-control') || ''));
    check('الرئيسية ترفع map-config.runtime.js', home.text.includes('js/map-config.runtime.js'));
    check('جولتا (B)/(C) ما زالتا منشورتين', home.text.includes('id="notifStrip"') && home.text.includes('app.css?v=35'));

    const rt = await get('/js/map-config.runtime.js');
    check('مسار الحقن يُقدَّم 200', rt.status === 200);
    check('no-store على الاستجابة', /no-store/.test(rt.headers.get('cache-control') || ''), rt.headers.get('cache-control'));
    const isActive = /provider:\s*"mapbox"/.test(rt.text);
    const isNoop = rt.text.includes('غير مضبوط');
    check('المسار بحالة مفهومة (مفعّل أو no-op صادق)', isActive || isNoop);
    if (isActive) {
        // لا يُطبع التوكن — نتحقق من بنيته فقط
        check('المزود الفعلي: mapbox', true);
        check('النمط الفعلي: light-v11', rt.text.includes('light-v11'));
        check('التوكن بصيغة pk. سليمة (يُفحص بلا طباعة)', /"pk\.[A-Za-z0-9._-]{20,}"/.test(rt.text));
        console.log('  ℹ️  الحالة: Mapbox مفعّل إنتاجيًا — التحقق البصري (طرق/أحياء/markers/زوم) على متصفح المالك');
    } else {
        console.log('  ℹ️  الحالة: no-op — MAPBOX_PUBLIC_TOKEN لم يُضبط في Render بعد (الخريطة تبقى Leaflet بوعي)');
    }

    const health = await get('/health');
    check('صحة الخادم /health', health.status === 200);

    console.log('\n═══════════════════════════');
    console.log('النتيجة الإنتاجية (D): ' + pass + ' ناجح / ' + fail + ' فاشل');
    if (failures.length) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log(isActive ? '✅ Mapbox Light مفعّل فعليًا في الإنتاج' : '✅ المسار منشور وجاهز — بانتظار ضبط المتغير');
})().catch(e => { console.error('انهار التحقق:', e.message); process.exit(1); });
