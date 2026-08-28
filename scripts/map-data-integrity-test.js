/**
 * ═══ map-data-integrity-test.js — إثبات سلامة بيانات الخريطة قبل/بعد MapAdapter ═══
 * (اعتماد المالك 2026-08-28 — «نقل العين فقط، بلا لمس عقل المنصة»)
 *
 * يلتقط بصمة حاسمة لكل بيانات الخريطة التشغيلية من مصادرها الحالية:
 *  D1 operationalCenters + teamCenterMap + unitLocations (من app.js — ثوابت معتمدة)
 *  D2 incident_registry: عدد البلاغات + عدد الموقَّعة + بصمة كل (رقم،lat,lng)
 *  D3 positioning_events: العدد + بصمة الحمولات (إحداثيات التمركزات التاريخية)
 *  D4 hospitals: العدد · D5 data/map-locations.json: العدد + البصمة
 *
 * الاستخدام:
 *  node scripts/map-data-integrity-test.js --snapshot <ملف.json>   ← لقطة «قبل»
 *  node scripts/map-data-integrity-test.js --verify   <ملف.json>   ← مقارنة «بعد» (خروج 1 عند أي اختلاف)
 * لا يكتب أي شيء في المشروع أو قاعدة البيانات — قراءة فقط.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

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

function fingerprint() {
    const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const centers = extractObject(appJs, 'operationalCenters');
    const teamMap = extractObject(appJs, 'teamCenterMap');
    const centerKeys = Object.keys(centers).sort();
    const teamKeys = Object.keys(teamMap).sort();

    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    const incTotal = db.prepare('SELECT COUNT(*) c FROM incident_registry').get().c;
    const incRows = db.prepare("SELECT number, lat, lng FROM incident_registry WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY number").all();
    const posRows = db.prepare('SELECT id, payload FROM positioning_events ORDER BY id').all();
    let hospCount = 0;
    try { hospCount = db.prepare('SELECT COUNT(*) c FROM hospitals').get().c; } catch (_) { }
    db.close();

    const locJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'map-locations.json'), 'utf8'));

    return {
        capturedAt: new Date().toISOString(),
        centers: { count: centerKeys.length, hash: sha(JSON.stringify(centers)), entries: centerKeys.map(k => k + '=' + centers[k].join(',')) },
        teamCenterMap: { count: teamKeys.length, hash: sha(JSON.stringify(teamMap)), entries: teamKeys.map(k => k + '→' + teamMap[k]) },
        incidents: { total: incTotal, positioned: incRows.length, coordsHash: sha(JSON.stringify(incRows)) },
        positioningEvents: { count: posRows.length, payloadHash: sha(posRows.map(r => r.id + '|' + (r.payload || '')).join('\n')) },
        hospitals: { count: hospCount },
        mapLocations: { count: locJson.length, hash: sha(JSON.stringify(locJson)) }
    };
}

const mode = process.argv[2], file = process.argv[3];
if ((mode !== '--snapshot' && mode !== '--verify') || !file) {
    console.log('الاستخدام: --snapshot <ملف> | --verify <ملف>');
    process.exit(2);
}

if (mode === '--snapshot') {
    const fp = fingerprint();
    fs.writeFileSync(file, JSON.stringify(fp, null, 2), 'utf8');
    console.log('📸 لقطة «قبل» حُفظت في ' + file);
    console.log('  المراكز: ' + fp.centers.count + ' · روابط الفرق: ' + fp.teamCenterMap.count
        + ' · البلاغات: ' + fp.incidents.total + ' (موقَّعة ' + fp.incidents.positioned + ')'
        + ' · التمركزات: ' + fp.positioningEvents.count + ' · المستشفيات: ' + fp.hospitals.count
        + ' · map-locations: ' + fp.mapLocations.count);
    process.exit(0);
}

// --verify
const before = JSON.parse(fs.readFileSync(file, 'utf8'));
const after = fingerprint();
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
console.log('— مقارنة «قبل» (' + before.capturedAt + ') مع «بعد» (' + after.capturedAt + ') —');
check('D1① عدد المراكز مطابق', before.centers.count === after.centers.count, before.centers.count + '≠' + after.centers.count);
check('D1② إحداثيات المراكز مطابقة (بصمة)', before.centers.hash === after.centers.hash);
check('D1③ أسماء المراكز وقيمها حرفيًا', JSON.stringify(before.centers.entries) === JSON.stringify(after.centers.entries));
check('D1④ عدد روابط الفرق بالمراكز مطابق', before.teamCenterMap.count === after.teamCenterMap.count, before.teamCenterMap.count + '≠' + after.teamCenterMap.count);
check('D1⑤ روابط الفرق بالمراكز لم تتغير (بصمة)', before.teamCenterMap.hash === after.teamCenterMap.hash);
check('D1⑥ كل ربط فرقة←مركز حرفيًا', JSON.stringify(before.teamCenterMap.entries) === JSON.stringify(after.teamCenterMap.entries));
check('D2① إجمالي البلاغات مطابق', before.incidents.total === after.incidents.total, before.incidents.total + '≠' + after.incidents.total);
check('D2② عدد البلاغات الموقَّعة مطابق', before.incidents.positioned === after.incidents.positioned, before.incidents.positioned + '≠' + after.incidents.positioned);
check('D2③ إحداثيات كل بلاغ لم تتغير (بصمة)', before.incidents.coordsHash === after.incidents.coordsHash);
check('D3① عدد أحداث التمركز مطابق', before.positioningEvents.count === after.positioningEvents.count, before.positioningEvents.count + '≠' + after.positioningEvents.count);
check('D3② حمولات التمركزات التاريخية لم تتغير (بصمة)', before.positioningEvents.payloadHash === after.positioningEvents.payloadHash);
check('D4 عدد المستشفيات مطابق', before.hospitals.count === after.hospitals.count, before.hospitals.count + '≠' + after.hospitals.count);
check('D5① عدد مواقع map-locations مطابق', before.mapLocations.count === after.mapLocations.count, before.mapLocations.count + '≠' + after.mapLocations.count);
check('D5② محتوى map-locations.json لم يتغير (بصمة)', before.mapLocations.hash === after.mapLocations.hash);
console.log('\n════════════════════════════════');
console.log('سلامة البيانات: ' + passed + ' ناجح / ' + failed + ' فاشل');
if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
process.exit(failed ? 1 : 0);
