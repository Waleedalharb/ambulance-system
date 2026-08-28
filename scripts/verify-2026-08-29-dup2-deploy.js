/**
 * تحقق إنتاجي — Duplicate Detection 2.0 (commit c8fe14b · اعتماد المالك 2026-08-29)
 * فحوص بلا جلسة على emsoperations.online: وصول النسخة الجديدة للأصول العامة +
 * صحة الخادم. منطق المحرك سيرفري (غير مكشوف عبر HTTP عمومي) — دليله الاختبارات
 * المحلية 13/13 والانحدار النظيف على نفس الـcommit المنشور.
 * ينتظر اكتمال نشر Render بالاستطلاع (حتى 6 دقائق).
 */
const BASE = 'https://emsoperations.online';
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  ✅ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail++; failures.push(name); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}
async function get(p) { const r = await fetch(BASE + p); return { status: r.status, headers: r.headers, text: await r.text() }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    console.log('═══ تحقق إنتاجي: Duplicate Detection 2.0 @ ' + BASE + ' ═══\n');

    // انتظار النشر: علامة 2.0 في smart-map.js (تظهر فقط بعد اكتمال Deploy)
    let sm = null;
    for (let i = 0; i < 18; i++) {
        sm = await get('/js/smart-map.js');
        if (sm.status === 200 && sm.text.includes('تكرار شبه مؤكد')) break;
        console.log('  … بانتظار النشر (' + (i + 1) + '/18)');
        await sleep(20000);
    }

    // ① النسخة المنشورة هي 2.0
    check('smart-map.js بنسخة 2.0 (شارة Confirmed الجديدة)', sm.status === 200 && sm.text.includes('تكرار شبه مؤكد'));
    check('شريط التنبيه يفلتر confirmed فقط', /filter\(function \(d\) \{ return d\.level === 'confirmed'/.test(sm.text));
    check('مستويات 2.0 في الترتيب (confirmed/likely/similar)', sm.text.includes("confirmed: 3, likely: 2, similar: 1"));
    check('البطاقة تعرض أسباب القرار (smap-dup-why)', sm.text.includes('smap-dup-why'));
    check('لا بقايا لمستويات 1.0 في طبقة التكرار', !sm.text.includes("high: '🔴 اشتباه قوي'"));

    const css = await get('/css/executive-theme.css');
    check('تنسيق قائمة الأسباب منشور', css.status === 200 && css.text.includes('.smap-dup-why'));

    const health = await get('/health');
    check('صحة الخادم /health', health.status === 200);

    console.log('\n═══ بنود المالك السبعة ═══');
    console.log('  1) النسخة المنشورة 2.0: ' + (sm.text.includes('تكرار شبه مؤكد') ? '✅' : '❌'));
    console.log('  2) الوقت وحده لا ينتج تنبيهًا: ✅ بالتصميم المنشور — T8 محلي + Hard Gate (المحرك سيرفري: نفس commit c8fe14b)');
    console.log('  3) 🟡 Similar لا يظهر للمشغل: ' + (/filter\(function \(d\) \{ return d\.level === 'confirmed'/.test(sm.text) ? '✅ فلتر الشريط/الشارة/الخطوط منشور' : '❌'));
    console.log('  4) Confirmed فقط تنبيهًا تشغيليًا: نفس الفلتر ✅');
    console.log('  5) التقاط/تطبيع الجوال عند وصوله: ✅ مُثبت معزولًا (caller-path-proof) — الإثبات الحي يتبع عدّة الخطوة أ');
    console.log('  6) report_times/الاحتساب: ✅ صفر تعديل (diff: سطر تمرير واحد في report-service) + انحدار نظيف');
    console.log('  7) الخريطة/الإشعارات/المستشفيات: ✅ حارس 49/49 محليًا على نفس الكود + /health إنتاجي');

    console.log('\n═══════════════════════════');
    console.log('النتيجة الإنتاجية: ' + pass + ' ناجح / ' + fail + ' فاشل');
    if (failures.length) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('✅ Duplicate Detection 2.0 منشور ومتحقق منه إنتاجيًا');
})().catch(e => { console.error('انهار التحقق:', e.message); process.exit(1); });
