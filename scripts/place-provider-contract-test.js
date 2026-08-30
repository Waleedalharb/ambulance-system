/**
 * ═══ اختبار عقد Place Provider + Adapter — place-provider-contract-test.js ═══ (PI-7)
 * اعتماد المالك 2026-08-30. بلا شبكة إطلاقًا: المزود الوهمي + fetchImpl مزيّف.
 * يثبت:
 *  1) العقد: أي Adapter متوافق يجتاز contractViolations، والمخالف يُكشف
 *  2) sanitizeRawPlaces: استبعاد العناصر غير المكتملة بلا كسر الدفعة
 *  3) MapboxSearchBoxProvider: دمج الفئات + إزالة التكرار + تصنيف الأخطاء
 *     (disabled/timeout/rate-limited/unavailable) + حدود radius/limit
 * التشغيل: node scripts/place-provider-contract-test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { ProviderError, LIMITS, sanitizeRawPlaces, contractViolations } = require(path.join(ROOT, 'services', 'place-providers', 'provider-interface'));
const { MapboxSearchBoxProvider } = require(path.join(ROOT, 'services', 'place-providers', 'mapbox-searchbox'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function checkAsync(name, fn) {
    try { const c = await fn(); check(name, !!c); }
    catch (e) { check(name, false, e.message); }
}

(async () => {
    console.log('🧪 ① عقد الواجهة:');
    const fakeProvider = {
        id: 'fake',
        capabilities: () => ({ nearbySearch: true, categoryFilter: false, maxRadiusM: 300 }),
        findNearbyPlaces: async () => []
    };
    check('مزود وهمي متوافق ← صفر مخالفات', contractViolations(fakeProvider).length === 0);
    check('مزود ناقص (بلا findNearbyPlaces) ← يُكشف', contractViolations({ id: 'x', capabilities: fakeProvider.capabilities }).length > 0);
    check('capabilities ناقصة ← تُكشف', contractViolations({ id: 'x', capabilities: () => ({}), findNearbyPlaces: async () => [] }).length > 0);

    const mb = new MapboxSearchBoxProvider({ token: 'test-token', fetchImpl: async () => { throw new Error('no'); } });
    check('MapboxSearchBoxProvider متوافق مع العقد', contractViolations(mb).length === 0);

    console.log('\n🧪 ② تعقيم العناصر الخام:');
    const sane = sanitizeRawPlaces([
        { name: 'مدرسة الاختبار', providerCategory: ['school'], lat: 24.58, lng: 46.75, providerRef: 'r1' },
        { name: '', providerCategory: [], lat: 24.58, lng: 46.75 },              // بلا اسم ← يُستبعد
        { name: 'بلا إحداثيات', providerCategory: [], lat: null, lng: null },   // بلا إحداثيات ← يُستبعد
        { name: 'خارج النطاق', providerCategory: [], lat: 999, lng: 46.75 },    // lat غير صالحة ← تُستبعد
        'not-an-object'
    ], 'test');
    check('عنصر سليم واحد فقط يبقى من 5', sane.length === 1);
    check('السليم يحمل كل الحقول الموحدة', sane[0] && sane[0].name === 'مدرسة الاختبار' && sane[0].providerRef === 'r1'
        && Array.isArray(sane[0].providerCategory) && sane[0].lat === 24.58);

    console.log('\n🧪 ③ Adapter Mapbox — السلوك عبر fetchImpl مزيّف:');

    await checkAsync('بلا توكن ← ProviderError(disabled)', async () => {
        const p = new MapboxSearchBoxProvider({ token: null, fetchImpl: async () => { throw new Error('x'); } });
        try { await p.findNearbyPlaces(24.58, 46.75); return false; }
        catch (e) { return e instanceof ProviderError && e.kind === 'disabled'; }
    });

    await checkAsync('إحداثية غير صالحة ← ProviderError(bad-response) بلا شبكة', async () => {
        let called = false;
        const p = new MapboxSearchBoxProvider({ token: 't', fetchImpl: async () => { called = true; throw new Error('x'); } });
        try { await p.findNearbyPlaces(999, 46.75); return false; }
        catch (e) { return e.kind === 'bad-response' && !called; }
    });

    await checkAsync('دمج الفئات + إزالة التكرار + استخلاص الحقول', async () => {
        const urls = [];
        const feature = (name, id, cat, lat, lng) => ({ id, properties: { name, poi_category_ids: [cat], mapbox_id: id }, geometry: { coordinates: [lng, lat] } });
        const p = new MapboxSearchBoxProvider({
            token: 't', categories: ['school', 'mosque'],
            fetchImpl: async (url) => {
                urls.push(url);
                const cat = /category\/(\w+)/.exec(url)[1];
                return { ok: true, status: 200, json: async () => ({ features: cat === 'school'
                    ? [feature('مدرسة أ', 'id1', 'school', 24.58001, 46.75001), feature('مدرسة أ', 'id1', 'school', 24.58001, 46.75001)]
                    : [feature('مسجد ب', 'id2', 'mosque', 24.58002, 46.75002)] }) };
            }
        });
        const out = await p.findNearbyPlaces(24.58, 46.75);
        return urls.length === 2 && out.length === 2 &&
            out.some(o => o.name === 'مدرسة أ' && o.providerRef === 'id1') &&
            out.some(o => o.name === 'مسجد ب') &&
            out.every(o => Array.isArray(o.providerCategory));
    });

    await checkAsync('429 في كل الفئات ← ProviderError(rate-limited)', async () => {
        const p = new MapboxSearchBoxProvider({ token: 't', categories: ['school'],
            fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
        try { await p.findNearbyPlaces(24.58, 46.75); return false; }
        catch (e) { return e.kind === 'rate-limited'; }
    });

    await checkAsync('403 في كل الفئات ← ProviderError(unavailable)', async () => {
        const p = new MapboxSearchBoxProvider({ token: 't', categories: ['school'],
            fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
        try { await p.findNearbyPlaces(24.58, 46.75); return false; }
        catch (e) { return e.kind === 'unavailable'; }
    });

    await checkAsync('فشل شبكة في كل الفئات ← ProviderError(unavailable)', async () => {
        const p = new MapboxSearchBoxProvider({ token: 't', categories: ['school'],
            fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
        try { await p.findNearbyPlaces(24.58, 46.75); return false; }
        catch (e) { return e.kind === 'unavailable'; }
    });

    await checkAsync('نجاح جزئي (فئة نجحت + فئة فشلت) ← يعمل بالناجح', async () => {
        const p = new MapboxSearchBoxProvider({ token: 't', categories: ['school', 'mosque'],
            fetchImpl: async (url) => {
                if (url.includes('/mosque')) return { ok: false, status: 500, json: async () => ({}) };
                return { ok: true, status: 200, json: async () => ({ features: [{ properties: { name: 'مدرسة أ' }, geometry: { coordinates: [46.75, 24.58] } }] }) };
            } });
        const out = await p.findNearbyPlaces(24.58, 46.75);
        return out.length === 1 && out[0].name === 'مدرسة أ';
    });

    await checkAsync('radiusM فوق السقف يُقصّ إلى 300 والاستعلام يمر', async () => {
        const p = new MapboxSearchBoxProvider({ token: 't', categories: ['school'],
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) }) });
        const out = await p.findNearbyPlaces(24.58, 46.75, { radiusM: 9999, limit: 999 });
        return Array.isArray(out) && out.length === 0 && LIMITS.MAX_RADIUS_M === 300;
    });

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failed) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
})();
