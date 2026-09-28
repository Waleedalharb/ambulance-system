/**
 * ═══ اختبار ترجيح الموقع الحي على الخريطة (اعتماد المالك 2026-09-22) ═══
 * يحمّل public/js/smart-map.js الفعلي (لا نسخة منطق مكررة) عبر خطاف _test
 * ويتحقق من قواعد الاعتماد:
 *  - fresh: الموقع الحي يتغلب على تموضع المركز.
 *  - stale: يبقى آخر موقع معروف مع حالة stale (شارة كهرمانية في الواجهة).
 *  - unavailable: العودة لتموضع المركز/السلوك الحالي.
 *  - لا موقع حي / إحداثيات غير رقمية: التموضع الحلقي يستمر.
 *  - موقع فرقة لا يؤثر على فرقة أخرى.
 *
 * التشغيل: node scripts/map-live-location-test.js
 */
'use strict';
const path = require('path');

// بيئة المتصفح الدنيا — smart-map.js لا يلمس DOM عند التحميل (فقط window.MapAdapter/L)
global.window = {};
global.operationalCenters = { 'الخالدية': [24.7136, 46.6753] };
global.teamCenterMap = { 'جنوب 1': 'الخالدية', 'جنوب 2': 'الخالدية' };

require(path.join(__dirname, '..', 'public', 'js', 'smart-map.js'));
const T = global.window.SmartMap && global.window.SmartMap._test;
if (!T) { console.error('❌ خطاف _test غير موجود'); process.exit(1); }

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
const C = global.operationalCenters['الخالدية'];
const eq = (a, b) => Math.abs(a - b) < 1e-9;

// 1) بلا موقع حي — التموضع الحلقي/المركز يستمر
T.setLive({});
let p = T.pos('جنوب 1', 'الخالدية');
check('1) بلا موقع حي ← موقع المركز (السلوك الحالي)', p && eq(p[0], C[0]) && eq(p[1], C[1]), JSON.stringify(p));

// 2) fresh — الموقع الحي يتغلب على المركز
T.setLive({ 'جنوب 1': { latitude: 24.65, longitude: 46.71, status: 'fresh', ageSeconds: 30 } });
p = T.pos('جنوب 1', 'الخالدية');
check('2) fresh ← الموقع الحي يتغلب على موقع المركز', p && eq(p[0], 24.65) && eq(p[1], 46.71), JSON.stringify(p));
const lv2 = T.live('جنوب 1');
check('3) fresh ← الحالة المعادة fresh (نقطة خضراء)', lv2 && lv2.status === 'fresh');

// 4) stale — يبقى آخر موقع معروف + حالة stale
T.setLive({ 'جنوب 1': { latitude: 24.66, longitude: 46.72, status: 'stale', ageSeconds: 300 } });
p = T.pos('جنوب 1', 'الخالدية');
check('4) stale ← آخر موقع معروف يبقى (لا رجوع للمركز)', p && eq(p[0], 24.66) && eq(p[1], 46.72), JSON.stringify(p));
const lv4 = T.live('جنوب 1');
check('5) stale ← الحالة المعادة stale (نقطة كهرمانية + عمر)', lv4 && lv4.status === 'stale' && lv4.ageSeconds === 300);

// 5) unavailable — العودة لتموضع المركز
T.setLive({ 'جنوب 1': { latitude: 24.60, longitude: 46.70, status: 'unavailable', ageSeconds: 1200 } });
p = T.pos('جنوب 1', 'الخالدية');
check('6) unavailable ← العودة لموقع المركز', p && eq(p[0], C[0]) && eq(p[1], C[1]), JSON.stringify(p));
check('7) unavailable ← livePosFor=null (لا نقطة حية)', T.live('جنوب 1') === null);

// 6) إحداثيات غير رقمية — تُرفض ويستمر المركز
T.setLive({ 'جنوب 1': { latitude: '24.65', longitude: null, status: 'fresh' } });
p = T.pos('جنوب 1', 'الخالدية');
check('8) إحداثيات غير رقمية ← تُرفض ويستمر المركز', p && eq(p[0], C[0]) && eq(p[1], C[1]));

// 7) العزل بين الفرق — موقع جنوب 2 لا يحرك جنوب 1
T.setLive({ 'جنوب 2': { latitude: 24.50, longitude: 46.60, status: 'fresh' } });
p = T.pos('جنوب 1', 'الخالدية');
check('9) موقع جنوب 2 الحي لا يؤثر على جنوب 1', p && eq(p[0], C[0]) && eq(p[1], C[1]));
const p2 = T.pos('جنوب 2', 'الخالدية');
check('10) جنوب 2 نفسها ← موقعها الحي', p2 && eq(p2[0], 24.50) && eq(p2[1], 46.60));

console.log('');
console.log('════════════════ ترجيح الموقع الحي للخريطة: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
process.exit(failed ? 1 : 0);
