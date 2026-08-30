/**
 * ═══ اختبار Golden لـPlace Discovery Orchestrator — place-discovery-orchestrator-test.js ═══ (PI-7)
 * اعتماد المالك 2026-08-30. بلا شبكة: decide() صِرفة + discover() بمزود وهمي.
 * الثوابت من الاختبار الحي 2026-08-30: A (0م) · B (40م) · D (443م=443م) · F (أقرب 14.4كم).
 * يثبت: بوابة NEAR_CAP · الهيمنة · الغموض · التضارب · matchedText ·
 *        التحويل النوعي · حساب المسافة محليًا · لا Confirmed من الخارج إطلاقًا.
 * التشغيل: node scripts/place-discovery-orchestrator-test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { decide, discover, toPlaceCandidate, NEAR_CAP_M } = require(path.join(ROOT, 'services', 'place-discovery-orchestrator'));
const { toInternalPlaceType } = require(path.join(ROOT, 'services', 'place-type-map'));
const { haversineMeters } = require(path.join(ROOT, 'services', 'duplicate-detection'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// نقطة على بعد d متر شرقًا من الأصل (تقريب كافٍ لهذه المسافات)
function eastOf(lat, lng, dM) {
    return { lat, lng: lng + dM / (111320 * Math.cos(lat * Math.PI / 180)) };
}
const ORIGIN = { lat: 24.58384, lng: 46.75077 }; // ثانوية الرياض (إحداثية حقيقية من الجولة)
function candAt(name, dM, cats, matchedText) {
    const p = eastOf(ORIGIN.lat, ORIGIN.lng, dM);
    return { name, placeType: 'other', providerCategory: cats || [], lat: p.lat, lng: p.lng,
        distanceM: Math.round(haversineMeters(ORIGIN.lat, ORIGIN.lng, p.lat, p.lng)),
        provider: 'fake', providerRef: null, matchedText: !!matchedText };
}

(async () => {
    console.log('🧪 ① Golden A: النقطة داخل المعلم (0م) — dominant');
    let d = decide([candAt('الرياض', 0, ['school'])]);
    check('A: outcome=dominant', d.outcome === 'dominant');
    check('A: اقتراح وحيد = المدرسة', d.suggestions.length === 1 && d.suggestions[0].name === 'الرياض');

    console.log('\n🧪 ② Golden B: بجانب المعلم 40م والثاني بعيد — dominant');
    d = decide([candAt('الرياض', 40, ['school']), candAt('أخرى', 513, ['school'])]);
    check('B: outcome=dominant (40م + الثاني ≥ الضعف)', d.outcome === 'dominant' && d.suggestions[0].distanceM <= 41);

    console.log('\n🧪 ③ Golden D: بين مدرسة ومسجد (443م = 443م)');
    d = decide([candAt('مدرسة', 443, ['school']), candAt('مسجد', 443, ['mosque'])]);
    check('D: كلاهما فوق NEAR_CAP ← no-match (443 > ' + NEAR_CAP_M + ')', d.outcome === 'no-match');
    d = decide([candAt('مدرسة', 60, ['school']), candAt('مسجد', 63, ['mosque'])]);
    check('D′: 60م مقابل 63م (تقارب) ← ambiguous بلا حسم', d.outcome === 'ambiguous' && d.suggestions.length === 2);

    console.log('\n🧪 ④ Golden E: نتائج متعددة — قاعدة الهيمنة');
    d = decide([candAt('قريبة', 30, ['school']), candAt('ثانية', 65, ['mosque'])]);
    check('E: 30م + الثانية 65م ≥ 60م ← dominant', d.outcome === 'dominant');
    d = decide([candAt('قريبة', 30, ['school']), candAt('ثانية', 45, ['mosque'])]);
    check('E′: 30م + الثانية 45م < 60م ← ambiguous', d.outcome === 'ambiguous');

    console.log('\n🧪 ⑤ Golden F: لا معلم قريب — بوابة NEAR_CAP');
    d = decide([candAt('بعيدة جدًا', 14434, ['school'])]);
    check('F: أقرب نتيجة 14.4كم ← no-match بصدق', d.outcome === 'no-match' && d.suggestions.length === 0);
    d = decide([]);
    check('F′: صفر نتائج ← no-match', d.outcome === 'no-match');

    console.log('\n🧪 ⑥ Golden G: تضارب نصي↔إحداثي');
    d = decide([candAt('الأقرب إحداثيًا', 20, ['school']), candAt('المذكورة في البلاغ', 90, ['mosque'], true)]);
    check('G: outcome=conflict', d.outcome === 'conflict');
    check('G: يعرض الاثنين ولا يحسم', d.suggestions.length === 2);
    d = decide([candAt('الوحيدة والمذكورة', 25, ['school'], true)]);
    check('G′: توافق نصي على الأقرب نفسه ← dominant (لا تضارب)', d.outcome === 'dominant');

    console.log('\n🧪 ⑦ الحدود العامة:');
    d = decide([candAt('أ', 10), candAt('ب', 12), candAt('ج', 14), candAt('د', 16), candAt('هـ', 18)]);
    check('ambiguous لا تعرض أكثر من 3', d.outcome === 'ambiguous' && d.suggestions.length === 3);
    d = decide([candAt('على الحد', NEAR_CAP_M, ['school'])]);
    check('على حد NEAR_CAP بالضبط ← تدخل البوابة', d.suggestions.length === 1 || d.outcome !== 'no-match');
    d = decide([candAt('خارج الحد', NEAR_CAP_M + 1, ['school'])]);
    check('خارج NEAR_CAP بمتر ← no-match', d.outcome === 'no-match');

    console.log('\n🧪 ⑧ toPlaceCandidate: المسافة محلية + التحويل النوعي:');
    const school = eastOf(ORIGIN.lat, ORIGIN.lng, 30);
    const c = toPlaceCandidate({ name: 'ثانوية الرياض', providerCategory: ['school', 'تعليم'], lat: school.lat, lng: school.lng, providerRef: 'x1' },
        'mapbox-searchbox', ORIGIN.lat, ORIGIN.lng, { address: 'بجانب ثانوية الرياض', description: null });
    check('المسافة تُحسب محليًا (haversine) لا من المزود', Math.abs(c.distanceM - Math.round(haversineMeters(ORIGIN.lat, ORIGIN.lng, school.lat, school.lng))) === 0);
    check('school ← من poi_category_ids', c.placeType === 'school');
    check('matchedText من نص البلاغ', c.matchedText === true);
    const c2 = toPlaceCandidate({ name: 'مكان مجهول', providerCategory: ['unknown_cat'], lat: school.lat, lng: school.lng },
        'mapbox-searchbox', ORIGIN.lat, ORIGIN.lng, { address: 'شارع عام', description: null });
    check('فئة مجهولة ← other بلا تخمين', c2.placeType === 'other');
    check('provider يبقى دليلًا فقط', c.provider === 'mapbox-searchbox' && c.providerRef === 'x1');

    console.log('\n🧪 ⑨ جدول التحويل النوعي:');
    check('police_station ← police', toInternalPlaceType('mapbox-searchbox', ['police_station']) === 'police');
    check('mosque ← mosque', toInternalPlaceType('mapbox-searchbox', ['mosque']) === 'mosque');
    check('park ← public_facility (لا نوع park داخلي)', toInternalPlaceType('mapbox-searchbox', ['park']) === 'public_facility');
    check('fire_station ← government (دفاع مدني)', toInternalPlaceType('mapbox-searchbox', ['fire_station']) === 'government');
    check('church لا تُصنَّف مسجدًا ← other', toInternalPlaceType('mapbox-searchbox', ['church']) === 'other');
    check('فئة عربية مترجمة «مركز شرطة» ← police', toInternalPlaceType('mapbox-searchbox', ['الحكومة', 'مركز شرطة']) === 'police');
    check('فئة عربية «مدرسة» ← school', toInternalPlaceType('any-provider', ['تعليم', 'مدرسة']) === 'school');
    check('غير معروفة كليًا ← other', toInternalPlaceType('any-provider', ['xyz123']) === 'other');

    console.log('\n🧪 ⑩ discover() بمزود وهمي:');
    const fakeProvider = {
        id: 'fake',
        capabilities: () => ({ nearbySearch: true, categoryFilter: false, maxRadiusM: 300 }),
        findNearbyPlaces: async () => [{ name: 'مدرسة الاختبار', providerCategory: ['school'], ...eastOf(ORIGIN.lat, ORIGIN.lng, 12), providerRef: 'f1' }]
    };
    let r = await discover(fakeProvider, { lat: ORIGIN.lat, lng: ORIGIN.lng, address: null, description: null });
    check('discover: dominant + provider موثق + fetchedAt', r.outcome === 'dominant' && r.provider === 'fake' && !!r.fetchedAt);
    check('discover: لا يعيد Confirmed/Likely إطلاقًا — outcome من الأربعة فقط',
        ['dominant', 'ambiguous', 'conflict', 'no-match'].includes(r.outcome));
    r = await discover(null, { lat: ORIGIN.lat, lng: ORIGIN.lng });
    check('discover بلا مزود ← disabled', r.outcome === 'disabled');
    r = await discover(fakeProvider, { lat: null, lng: null });
    check('discover بلا إحداثية ← no-coords', r.outcome === 'no-coords');
    const errProvider = { id: 'err', capabilities: () => ({ nearbySearch: true, categoryFilter: true, maxRadiusM: 300 }),
        findNearbyPlaces: async () => { const { ProviderError } = require(path.join(ROOT, 'services', 'place-providers', 'provider-interface')); throw new ProviderError('rate-limited', '429', 'err'); } };
    r = await discover(errProvider, { lat: ORIGIN.lat, lng: ORIGIN.lng });
    check('429 ← outcome=rate-limited + errorKind', r.outcome === 'rate-limited' && r.errorKind === 'rate-limited');

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failed) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
})();
