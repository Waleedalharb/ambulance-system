/**
 * places-seed.js — بذرة سجل المواقع الموحد (PI-1، اعتماد المالك 2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 * يبني data/places.json من مصدرين موجودين أصلًا (لا ينشئ بيانات جديدة):
 *  ① data/map-locations.json  — الـ12 مستشفى الحالية (placeType: hospital)
 *     ⚠️ للتطابق المكاني فقط — مصدر hospitalName ورحلات المستشفيات يبقى
 *     مخزن Hospital Monitor 1B حصريًا (لا مصدر حقيقة ثانٍ).
 *  ② operationalCenters من public/js/app.js — مراكز تشغيلية داخلية
 *     (internal: true — بلاغ عندها لا يُصنَّف جهة خارجية).
 *
 * radiusM: 200م للمستشفيات (حرم واسع)، 150م للمراكز (الافتراضي المعتمد).
 * nameVariants: الاسم كما ورد فقط — لا توسعة مخمنة للأسماء (Precision First).
 *
 * idempotent: يعيد بناء البذرة فقط؛ لا يمس مواقع manual/learned معتمدة لاحقًا
 * (يحتفظ بأي موقع source≠seed كما هو ويرفع placesVersion عند أي تغيير).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MAP_LOCATIONS = path.join(ROOT, 'data', 'map-locations.json');
const APP_JS = path.join(ROOT, 'public', 'js', 'app.js');
const OUT = path.join(ROOT, 'data', 'places.json');

// نفس أسلوب map-data-integrity-test.js لاستخراج الثوابت من app.js
function extractObject(src, varName) {
    const start = src.indexOf('var ' + varName + ' = {');
    if (start < 0) throw new Error('لم يُعثر على ' + varName + ' في app.js');
    const open = src.indexOf('{', start);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('نهاية ' + varName + ' غير موجودة');
    return vm.runInNewContext('(' + src.slice(open, end + 1) + ')', Object.create(null));
}

const pid = (name, lat, lng) => 'plc_' + crypto.createHash('sha1')
    .update(name + '|' + lat + '|' + lng).digest('hex').slice(0, 10);

function buildSeed() {
    const now = new Date().toISOString();
    const places = {};

    // ① المستشفيات الـ12 — بذرة للتطابق المكاني فقط
    const hospitals = JSON.parse(fs.readFileSync(MAP_LOCATIONS, 'utf8'));
    for (const h of hospitals) {
        const id = pid(h.name, h.lat, h.lng);
        places[id] = {
            placeId: id,
            placeType: 'hospital',
            subtype: h.type || null,          // عام/متخصص/مجمع/طوارئ — كما وردت
            name: h.name,
            nameVariants: [h.name],            // الاسم كما ورد فقط — لا توسعة مخمنة
            lat: h.lat, lng: h.lng,
            radiusM: 200,                      // حرم مستشفى أوسع من الافتراضي
            district: null,
            internal: false,
            source: 'seed', status: 'active',
            evidence: [{ at: now, by: 'seed', note: 'بذرة من data/map-locations.json — للتطابق المكاني فقط؛ hospitalName يبقى من مخزن 1B حصريًا' }],
            createdAt: now, updatedAt: now, createdBy: 'seed'
        };
    }

    // ② المراكز التشغيلية — داخلية، لا تُصنَّف جهات خارجية
    const appJs = fs.readFileSync(APP_JS, 'utf8');
    const centers = extractObject(appJs, 'operationalCenters');
    for (const name of Object.keys(centers)) {
        const [lat, lng] = centers[name];
        const id = pid(name, lat, lng);
        places[id] = {
            placeId: id,
            placeType: 'operational_center',
            subtype: null,
            name: 'مركز ' + name,
            nameVariants: [name, 'مركز ' + name],
            lat, lng,
            radiusM: 150,
            district: null,
            internal: true,                    // بلاغ داخله = سياق داخلي، لا جهة خارجية
            source: 'seed', status: 'active',
            evidence: [{ at: now, by: 'seed', note: 'بذرة من operationalCenters في public/js/app.js — موقع تشغيلي داخلي' }],
            createdAt: now, updatedAt: now, createdBy: 'seed'
        };
    }
    return places;
}

function main() {
    const seedPlaces = buildSeed();
    let existing = { placesVersion: 0, places: {} };
    let fileExisted = true;
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { fileExisted = false; }

    // reconcile وليس rebuild (اعتماد المالك 2026-08-29 — Seed Safety):
    // seed يضيف البذريات الغائبة فقط. أي موقع موجود — بذريًا كان أو بشريًا —
    // لا يُمس إطلاقًا: radiusM/status/evidence/name/nameVariants/district
    // وأي ضبط بشري لاحق محفوظ؛ seed لا يملك صلاحية overwrite إطلاقًا.
    // ملاحظة مقصودة: تصحيح إحداثيات مستشفى بذري قائم من map-locations.json
    // لا ينتشر تلقائيًا — يمر عبر مراجعة بشرية (نفس بوابة اعتماد radiusM).
    const merged = Object.assign({}, existing.places);
    let added = 0;
    for (const [id, p] of Object.entries(seedPlaces)) {
        if (!merged[id]) { merged[id] = p; added++; }
    }

    // idempotent صارم: بلا إضافات = بلا كتابة وبلا رفع نسخة — byte-identical
    if (added === 0 && fileExisted) {
        console.log('✅ places.json — بلا تغيير (placesVersion=' + (existing.placesVersion || 0) +
            ' · إجمالي=' + Object.keys(merged).length + ') — idempotent');
        return;
    }

    const out = {
        placesVersion: (existing.placesVersion || 0) + 1, // ترتفع فقط عند تغيير فعلي
        places: merged
    };
    const tmp = OUT + '.tmp';
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, OUT);

    const hospitalsCount = Object.values(merged).filter(p => p.placeType === 'hospital' && p.source === 'seed').length;
    const centersCount = Object.values(merged).filter(p => p.internal).length;
    console.log('✅ places.json — placesVersion=' + out.placesVersion +
        ' · مستشفيات بذرية=' + hospitalsCount + ' · مراكز داخلية=' + centersCount +
        ' · أُضيف=' + added + ' · إجمالي=' + Object.keys(merged).length);
}

main();
