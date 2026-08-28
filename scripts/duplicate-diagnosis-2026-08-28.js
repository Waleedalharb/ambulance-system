/**
 * تشخيص Duplicate Detection 1.0 على البيانات الحقيقية (نسخة معزولة — قراءة فقط)
 * يعيد إنتاج dupInput كما يبنيه report-service.js حرفيًا ويشغّل المحرك الحالي،
 * ثم يصنّف الأزواج: حالات False Positive محتملة (حي مختلف / مسافة بعيدة /
 * بلا إحداثيات أصلًا). لا كتابة على أي قاعدة — النسخة في %TEMP%.
 */
const path = require('path');
const os = require('os');
const db = new (require('better-sqlite3'))(path.join(os.tmpdir(), 'dup-analysis.db'), { readonly: true });
const Dup = require('../services/duplicate-detection');

function cadTs(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|ص|م)?/i);
    if (!m) return null;
    let h = parseInt(m[4], 10);
    const mer = m[7] || '';
    if (/pm|م/i.test(mer) && h < 12) h += 12;
    if (/am|ص/i.test(mer) && h === 12) h = 0;
    const ts = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), h, parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0).getTime();
    return isNaN(ts) ? null : ts;
}

const rows = db.prepare('SELECT * FROM incident_registry').all();
const input = rows.map(ic => {
    const t1 = cadTs(ic.cad_created_at);
    const t2 = ic.created_at ? new Date(ic.created_at).getTime() : NaN;
    return { number: ic.number, status: ic.status || 'active',
        callerNumber: ic.caller_number || null, description: ic.description || null,
        address: ic.address || null, type: ic.type || null, code: ic.code || null,
        lat: ic.lat != null ? ic.lat : null, lng: ic.lng != null ? ic.lng : null,
        createdTs: t1 !== null ? t1 : (isFinite(t2) ? t2 : null),
        district: ic.district || null };
});

const pairs = Dup.findDuplicates(input);
console.log('بلاغات في السجل:', rows.length, '| أزواج مشتبه بها (المحرك الحالي):', pairs.length);
console.log('');

const byNum = {};
rows.forEach(r => { byNum[r.number] = r; });

pairs.forEach(p => {
    const a = byNum[p.number], b = byNum[p.candidate.number];
    const dist = (p.evidence.find(e => e.key === 'distance') || {}).meters;
    const gap = (p.evidence.find(e => e.key === 'time') || {}).minutes;
    const hasGeoA = a.lat != null && a.lng != null, hasGeoB = b.lat != null && b.lng != null;
    const distM = (hasGeoA && hasGeoB) ? Math.round(Dup.haversineMeters(a.lat, a.lng, b.lat, b.lng)) : null;
    const districtDiff = a.district && b.district && a.district !== b.district;
    const flags = [];
    if (districtDiff) flags.push('⚠️ حي مختلف (' + a.district + ' ≠ ' + b.district + ')');
    if (distM !== null && distM > 1000) flags.push('⚠️ مسافة ' + distM + 'م (> 1كم)');
    if (!hasGeoA || !hasGeoB) flags.push('⚠️ بلا إحداثيات كاملة');
    if (!p.evidence.some(e => e.key === 'caller')) flags.push('بلا دليل جوال');
    console.log(
        (p.level === 'high' ? '🔴' : p.level === 'medium' ? '🟠' : '🟡') + ' ' +
        p.number + ' ↔ ' + p.candidate.number + ' | score=' + p.score + ' | ' +
        'حي: ' + (a.district || '—') + ' / ' + (b.district || '—') + ' | ' +
        'مسافة: ' + (distM !== null ? distM + 'م' : 'غير محسوبة') + ' | ' +
        'فارق: ' + (gap !== undefined ? gap + 'د' : '—') + ' | ' +
        'نوع: ' + (a.code || a.type || '—') + ' / ' + (b.code || b.type || '—'));
    console.log('    أدلة: ' + p.evidence.map(e => e.label).join(' + '));
    if (flags.length) console.log('    ' + flags.join(' | '));
});

// تلخيص إحصائي
const levels = { high: 0, medium: 0, low: 0 };
let crossDistrict = 0, noGeo = 0, noCaller = 0, far = 0;
pairs.forEach(p => {
    levels[p.level]++;
    const a = byNum[p.number], b = byNum[p.candidate.number];
    if (a.district && b.district && a.district !== b.district) crossDistrict++;
    if (a.lat == null || b.lat == null) noGeo++;
    if (!p.evidence.some(e => e.key === 'caller')) noCaller++;
    if (a.lat != null && b.lat != null && Dup.haversineMeters(a.lat, a.lng, b.lat, b.lng) > 1000) far++;
});
console.log('\n═══ التلخيص ═══');
console.log('🔴 high:', levels.high, '| 🟠 medium:', levels.medium, '| 🟡 low:', levels.low);
console.log('أزواج بحيّين مختلفين:', crossDistrict, '| بلا إحداثيات كاملة:', noGeo, '| بلا دليل جوال:', noCaller, '| مسافة > 1كم:', far);
db.close();
