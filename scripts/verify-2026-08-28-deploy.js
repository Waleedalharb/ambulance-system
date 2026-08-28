// تحقق ما بعد النشر — إصلاحا التكميل + إصلاح الوهج (2026-08-28) — قراءة فقط
const BASE = 'https://emsoperations.online';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log('  ✅ ' + n); } else { failed++; console.log('  ❌ ' + n + (x ? ' — ' + x : '')); } };
const COMMIT = 'f6bef28';

async function fetchText(p) {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(15000) });
    return r.ok ? r.text() : null;
}

(async () => {
    console.log('① انتظار اكتمال نشر Render (commit ' + COMMIT + ')…');
    let live = false;
    for (let i = 0; i < 40; i++) {
        try {
            const rc = await fetchText('/radio-completion.html?v=' + Date.now());
            // ختم الكود الجديد: وحدة Pointer DnD + الإدخال اليدوي
            if (rc && rc.includes('سحب المؤشر الموحّد') && rc.includes('moveTeamCode')) { live = true; break; }
        } catch (_) { }
        await sleep(15000);
    }
    check('الكود الجديد منشور فعليًا على الإنتاج (ختم Pointer DnD + moveTeamCode)', live);
    if (!live) { console.log('لم يصل النشر خلال المهلة'); process.exit(1); }

    const rc = await fetchText('/radio-completion.html');
    check('② HTML5 DnD متقاعد في الإنتاج (لا dragstart/dataTransfer/draggable)', rc && !/dragstart|dataTransfer|setAttribute\('draggable'/.test(rc));
    check('③ Pointer DnD كامل الأركان (pointerdown/up/cancel + elementFromPoint + rAF)', rc && ['pointerdown', 'pointerup', 'pointercancel', 'elementFromPoint', 'requestAnimationFrame'].every(k => rc.includes(k)));
    check('④ الإدخال اليدوي لرمز الفرقة + التحقق «غير صالح أو غير معروف»', rc && rc.includes('submitMoveTeamCode') && rc.includes('رمز الفرقة غير صالح أو غير معروف للنظام'));
    check('⑤ بوابة ops.completion على تأكيد النقل والنقل اليدوي', rc && rc.includes('confirmRedistribution()"]') && rc.includes('submitMoveTeamCode()"]') && rc.includes("perm: 'ops.completion'"));

    const idx = await fetchText('/');
    check('⑥ إصلاح الوهج منشور: .hc-kpi بلا backdrop-filter + تجاوز عزل حاوية الخريطة', idx && idx.includes('بلا backdrop-filter') && idx.includes('.ops-map-section') && idx.includes('backdrop-filter: none !important'));

    const cfg = await fetchText('/js/map-config.js');
    check('⑦ Mapbox خاملة في الإنتاج — المزود الافتراضي leaflet', cfg && /provider:\s*'leaflet'/.test(cfg));

    const dash = await fetchText('/operations-dashboard.html');
    check('⑧ تبويب «المستشفيات» التاسع موجود في أرشيف المناوبات', dash && dash.includes('data-mtab="hospital"') && dash.includes('renderHospitalTab'));

    console.log('\n──────────────────────────────');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌ · commit=' + COMMIT);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('خطأ: ' + e.message); process.exit(1); });
