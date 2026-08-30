/**
 * ═══ اختبار خطاف Discovery + الكاش — place-discovery-hook-test.js ═══ (PI-7)
 * بلا شبكة: مزود وهمي + كاش حقيقي (ذاكرة). يثبت:
 *  ① confirmed ← يُتخطى (لا استعلام)  ② غير confirmed ← يستعلم ويكاش
 *  ③ بلا إحداثية ← يُتخطى  ④ ميزانية مستنفدة ← يُتخطى  ⑤ فشل لا يكسر الطابور
 *  ⑥ التقاسم الخلوي: بلاغان بنفس الموقع ← استعلام واحد  ⑦ rate-limited يفتح القاطع
 * التشغيل: node scripts/place-discovery-hook-test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { makeDiscoveryHook } = require(path.join(ROOT, 'services', 'place-discovery-hook'));
const { PlaceDiscoveryCache } = require(path.join(ROOT, 'services', 'place-discovery-cache'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const INC = { lat: 24.58384, lng: 46.75077, address: null, description: null };
function mkProvider(calls, result) {
    return {
        id: 'fake', calls,
        capabilities: () => ({ nearbySearch: true, categoryFilter: false, maxRadiusM: 300 }),
        findNearbyPlaces: async () => { calls.n++; return result || []; }
    };
}
const logger = { error: () => {}, warn: () => {} };

(async () => {
    console.log('🧪 ①② confirmed يُتخطى / unknown يستعلم ويُكاش:');
    let calls = { n: 0 };
    let cache = new PlaceDiscoveryCache();
    let hook = makeDiscoveryHook({ provider: mkProvider(calls), cache, logger });
    hook.onResolved('T1', { decision: 'confirmed' }, INC);
    hook.onResolved('T2', { decision: 'unknown' }, INC);
    await hook._drain();
    check('confirmed لم يستعلم', calls.n === 1); // T2 فقط
    check('T2 نتيجته no-match مكاشة', cache.get('T2') && cache.get('T2').outcome === 'no-match');
    check('عدادات: enqueued=1 skipped=1', hook._stats().enqueued === 1 && hook._stats().skipped === 1);

    console.log('\n🧪 ③ بلا إحداثية ← تخطٍ:');
    calls = { n: 0 }; cache = new PlaceDiscoveryCache();
    hook = makeDiscoveryHook({ provider: mkProvider(calls), cache, logger });
    hook.onResolved('T3', { decision: 'unknown' }, { lat: null, lng: null });
    await hook._drain();
    check('لا استعلام بلا إحداثية', calls.n === 0 && hook._stats().skipped === 1);

    console.log('\n🧪 ④ ميزانية مستنفدة ← تخطٍ:');
    calls = { n: 0 }; cache = new PlaceDiscoveryCache({ dailyBudget: 1 });
    hook = makeDiscoveryHook({ provider: mkProvider(calls), cache, logger });
    hook.onResolved('T4', { decision: 'unknown' }, INC);
    hook.onResolved('T5', { decision: 'unknown' }, { lat: 24.7, lng: 46.8 }); // موقع مختلف — خلية أخرى
    await hook._drain();
    check('الثاني تجاوز الميزانية ← استعلام واحد فقط', calls.n === 1);

    console.log('\n🧪 ⑤ فشل المزود محتوًى (discover لا ترمي) والطابور يكمل:');
    calls = { n: 0 };
    const failThenOk = {
        id: 'fake', capabilities: () => ({ nearbySearch: true, categoryFilter: true, maxRadiusM: 300 }),
        findNearbyPlaces: async () => { calls.n++; if (calls.n === 1) throw new Error('boom'); return []; }
    };
    cache = new PlaceDiscoveryCache();
    hook = makeDiscoveryHook({ provider: failThenOk, cache, logger });
    hook.onResolved('T6', { decision: 'unknown' }, INC);
    hook.onResolved('T7', { decision: 'unknown' }, { lat: 24.7, lng: 46.8 });
    await hook._drain();
    check('الأول احتواه discover كـprovider-error والثاني اكتمل', calls.n === 2 &&
        cache.get('T6') && cache.get('T6').outcome === 'provider-error' && !!cache.get('T7'));

    console.log('\n🧪 ⑥ التقاسم الخلوي:');
    calls = { n: 0 }; cache = new PlaceDiscoveryCache();
    hook = makeDiscoveryHook({ provider: mkProvider(calls), cache, logger });
    hook.onResolved('T8', { decision: 'unknown' }, INC);
    hook.onResolved('T9', { decision: 'unknown' }, { lat: INC.lat + 0.0001, lng: INC.lng }); // نفس الخلية ~55م
    await hook._drain();
    check('بلاغان بنفس الخلية ← استعلام واحد', calls.n === 1);
    check('كلاهما مكاش', !!cache.get('T8') && !!cache.get('T9'));

    console.log('\n🧪 ⑦ rate-limited يفتح القاطع:');
    calls = { n: 0 };
    const rl = { id: 'fake', capabilities: () => ({ nearbySearch: true, categoryFilter: true, maxRadiusM: 300 }),
        findNearbyPlaces: async () => { calls.n++; const { ProviderError } = require(path.join(ROOT, 'services', 'place-providers', 'provider-interface')); throw new ProviderError('rate-limited', '429', 'fake'); } };
    cache = new PlaceDiscoveryCache({ cooldownMs: 60000 });
    hook = makeDiscoveryHook({ provider: rl, cache, logger });
    hook.onResolved('T10', { decision: 'unknown' }, INC);
    await hook._drain();
    hook.onResolved('T11', { decision: 'unknown' }, { lat: 24.7, lng: 46.8 });
    await hook._drain();
    check('بعد 429: القاطع مفتوح والاستعلام التالي حُجب', calls.n === 1 && cache.stats().circuitOpen === true);

    console.log('\n🧪 ⑧ بلا مزود (توكن غير مضبوط) ← تخطٍ صامت:');
    calls = { n: 0 }; cache = new PlaceDiscoveryCache();
    hook = makeDiscoveryHook({ provider: null, cache, logger });
    hook.onResolved('T12', { decision: 'unknown' }, INC);
    await hook._drain();
    check('لا استعلام ولا خطأ', hook._stats().skipped === 1 && hook._stats().failed === 0);

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failed) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
})();
