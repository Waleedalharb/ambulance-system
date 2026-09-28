/**
 * ═══ map-data-integrity-test.js — إثبات سلامة بيانات الخريطة ═══
 * (اعتماد المالك 2026-08-28 — «نقل العين فقط» · أُعيد تعريف D1 باعتماد P3 في 2026-09-21)
 *
 *  D1 (P3): تأكيدات معمارية — لا بصمة جداول ثابتة لأنها لم تعد موجودة:
 *     ① /api/ops/centers هو مصدر إحداثيات الخريطة في app.js
 *     ② لا جدول إحداثيات ثابت بديل في app.js/smart-map.js
 *     ③ لا نسخة ثابتة بديلة لـ teamCenterMap / centersData في app.js ولا
 *       report-entry.html ولا server.js
 *     ④ التهجئة المنحرفة («منفوحه»/«الشفا») غائبة من كل أسطح الويب
 *  D2 incident_registry: عدد البلاغات + عدد الموقَّعة + بصمة كل (رقم،lat,lng)
 *  D3 positioning_events: العدد + بصمة الحمولات
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

const ROOT = path.join(__dirname, '..');
const MAIN_REPO = path.join('C:\\', 'projects', 'Ambulance Dispatch');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// الـworktree كود فقط — القاعدة وnode_modules في المستودع الرئيسي
function resolveModule(name) {
    const local = path.join(ROOT, 'node_modules', name);
    return fs.existsSync(local) ? local : path.join(MAIN_REPO, 'node_modules', name);
}
function resolveDb() {
    const local = path.join(ROOT, 'data', 'ambulance.db');
    return fs.existsSync(local) ? local : path.join(MAIN_REPO, 'data', 'ambulance.db');
}

/** D1 (P3): تأكيدات معمارية على مصادر الويب — كل بند {name, ok, detail}. */
function architectureChecks() {
    const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const smartMap = fs.readFileSync(path.join(ROOT, 'public', 'js', 'smart-map.js'), 'utf8');
    const reportEntry = fs.readFileSync(path.join(ROOT, 'public', 'report-entry.html'), 'utf8');
    const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const checks = [];
    const A = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

    A('D1① app.js يجلب /api/ops/centers (مصدر SSOT)', appJs.includes("'/api/ops/centers'") || appJs.includes('"/api/ops/centers"'));
    A('D1② لا إحداثيات مراكز ثابتة في app.js', !/operationalCenters\s*=\s*\{[^}]*24\.\d/.test(appJs));
    A('D1③ لا إحداثيات ثابتة في smart-map.js (عدا viewport الافتتاحي للرياض في setView)',
        !/24\.\d{3,}/.test(smartMap.replace(/\.setView\(\[[^\]]*\][^)]*\)/g, '')));
    A('D1④ لا teamCenterMap ثابت في app.js', !/teamCenterMap\s*=\s*\{[^}]*["']جنوب/.test(appJs));
    A('D1⑤ لا centersData ثابت في report-entry.html', !/centersData\s*=\s*\{[^}]*["']جنوب/.test(reportEntry));
    A('D1⑥ لا centersData ثابت في app.js (fallback قديم)', !/centersData\s*=\s*\{[^}]*["']جنوب/.test(appJs));
    A('D1⑦ لا centersData ثابت في server.js', !/centersData\s*=\s*\{[^}]*["']جنوب/.test(serverJs));
    A('D1⑧ التهجئة المنحرفة غائبة (منفوحه/الشفا)', !/["']منفوحه["']|["']الشفا["']/.test(appJs + smartMap + reportEntry + serverJs));
    A('D1⑨ راية حالة المرجع موصولة في smart-map.js', smartMap.includes('smapRefBanner') && smartMap.includes('refreshCentersRef'));
    return checks;
}

function fingerprint() {
    const d1 = architectureChecks();

    const Database = require(resolveModule('better-sqlite3'));
    const db = new Database(resolveDb(), { readonly: true });
    const incTotal = db.prepare('SELECT COUNT(*) c FROM incident_registry').get().c;
    const incRows = db.prepare("SELECT number, lat, lng FROM incident_registry WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY number").all();
    const posRows = db.prepare('SELECT id, payload FROM positioning_events ORDER BY id').all();
    let hospCount = 0;
    try { hospCount = db.prepare('SELECT COUNT(*) c FROM hospitals').get().c; } catch (_) { }
    db.close();

    const locJson = JSON.parse(fs.readFileSync(path.join(MAIN_REPO, 'data', 'map-locations.json'), 'utf8'));

    return {
        capturedAt: new Date().toISOString(),
        architecture: d1,
        incidents: { total: incTotal, positioned: incRows.length, coordsHash: sha(JSON.stringify(incRows)) },
        positioningEvents: { count: posRows.length, payloadHash: sha(posRows.map(r => r.id + '|' + (r.payload || '')).join('\n')) },
        hospitals: { count: hospCount },
        mapLocations: { count: locJson.length, hash: sha(JSON.stringify(locJson)) }
    };
}

function runD1(checks) {
    let p = 0, f = 0;
    for (const c of checks) {
        if (c.ok) { p++; console.log('  ✅ ' + c.name); }
        else { f++; console.log('  ❌ ' + c.name + (c.detail ? ' — ' + c.detail : '')); }
    }
    return { p, f };
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
    const r = runD1(fp.architecture);
    console.log('  البلاغات: ' + fp.incidents.total + ' (موقَّعة ' + fp.incidents.positioned + ')'
        + ' · التمركزات: ' + fp.positioningEvents.count + ' · المستشفيات: ' + fp.hospitals.count
        + ' · map-locations: ' + fp.mapLocations.count);
    process.exit(r.f ? 1 : 0);
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
const d1r = runD1(after.architecture); // D1 تأكيدات مطلقة — تُعاد في كل تحقق
passed += d1r.p; failed += d1r.f;
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
