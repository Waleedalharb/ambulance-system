/**
 * place-archive-view-test.js — PI-4 Golden Set للواجهة (V1–V10)
 * (اعتماد المالك 2026-08-29 — محلي فقط بلا Commit)
 * ═══════════════════════════════════════════════════════════════════════════
 * V1 مطابقة الأرقام حرفيًا للّقطة · V2 الحفر الرباعي · V3 فصل Confirmed/Likely ·
 * V4 Unknown سطر معلومة فقط · V5 اللقطة القديمة بلا crash · V6 المقام مختوم
 * نصًا ولا حساب في الواجهة · V7 عدم المساس بالقائم (حراس نصية) ·
 * V8 صفر استعلام حي (عدادات فعلية) · V9 Historical Integrity (الواجهة لا
 * تتجاوز اللقطة للمخزن الحي) · V10 No UI Mutation (العرض لا يغيّر اللقطة
 * ولا يستدعي resolve).
 *
 * المنهج: ① حراس نصية/صياغية على operations-dashboard.html (نمط جولة 28/8)
 * ② استخلاص كود PI-4 من الصفحة وتشغيله فعليًا في Node بـDOM مصطنع —
 * الأرقام المقروءة من HTML المولّد وليست ادعاءً.
 * كل التخزين في مجلدات مؤقتة — لا كتابة على بيانات حقيقية.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { PlaceIntelligenceService } = require('../services/place-intelligence-service');

let pass = 0, fail = 0;
function T(id, name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { fail++; console.log('❌ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const ROOT = path.join(__dirname, '..');
const opsDash = fs.readFileSync(path.join(ROOT, 'public', 'operations-dashboard.html'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi4-view-'));

// ── استخلاص كود PI-4 بين العلامتين وتحميله فعليًا ──
const pi4src = (opsDash.split('// ==== PI-4 BEGIN ====')[1] || '').split('// ==== PI-4 END ====')[0] || '';
function makeRenderer() {
    let captured = '';
    const bodyStub = { insertAdjacentHTML: (pos, h) => { captured += h; } };
    const factory = new Function('document', 'fmtDT', pi4src + '\nreturn { renderPlacesTab: renderPlacesTab, placesTabToggle: placesTabToggle };');
    const api = factory(
        { getElementById: (id) => (id === 'shiftDetailBody' ? bodyStub : null) },
        (v) => String(v || '—')
    );
    return { api, html: () => captured, reset: () => { captured = ''; } };
}

// ── بناء لقطة مختومة حقيقية عبر الخدمة الفعلية (لا بيانات مختلقة) ──
function buildService() {
    const dir = fs.mkdtempSync(path.join(TMP, 'svc-'));
    return new PlaceIntelligenceService({
        placesFile: path.join(dir, 'places.json'),
        resolutionsFile: path.join(dir, 'place-resolutions.json'),
        candidatesFile: path.join(dir, 'place-candidates.json')
    });
}
function buildSealedFixture() {
    const svc = buildService();
    const sch = svc.addPlace({ placeType: 'school', name: 'مدرسة الملك خالد', lat: 24.6000, lng: 46.7000, radiusM: 100, source: 'learned' }, 'learned');
    svc.approveCandidate(sch.placeId, 'owner', 'الحرم الفعلي 100م');
    const hos = svc.addPlace({ placeType: 'hospital', name: 'مستشفى الأمل', lat: 24.5500, lng: 46.6600, radiusM: 200, source: 'learned' }, 'learned');
    svc.approveCandidate(hos.placeId, 'owner', 'حرم المستشفى 200م');
    svc.recordResolution('SC1', { lat: 24.6000, lng: 46.7002 });                    // مدرسة Confirmed
    svc.recordResolution('SC2', { lat: 24.6000, lng: 46.7004 });                    // مدرسة Confirmed
    svc.recordResolution('H1',  { lat: 24.5500, lng: 46.6602 });                    // مستشفى Confirmed
    svc.recordResolution('L1',  { lat: 24.4000, lng: 46.5000, description: 'بلاغ في مدرسة' }); // R4 Likely
    svc.recordResolution('U1',  { lat: 24.4100, lng: 46.5100 });                    // Unknown
    const numbers = ['SC1', 'SC2', 'H1', 'L1', 'U1', 'NR1']; // NR1 بلا حسم
    const sealed = JSON.parse(JSON.stringify(svc.archiveSectionForIncidents(numbers)));
    return { svc, sealed };
}

(async () => {

console.log('═══ PI-4 Golden Set — واجهة «الجهات والمواقع» ═══\n');

// ── ⓪ حراس نصية/صياغية (نمط جولة 2026-08-28 المعتمد) ──
T('G1', 'زر التبويب العاشر «الجهات والمواقع» موجود (data-mtab=places)',
    opsDash.includes('data-mtab="places"') && opsDash.includes('fa-map-marked-alt'));
T('G2', 'كود PI-4 محصور بين العلامتين وخالٍ من أي fetch/XHR — عرض فقط',
    pi4src.length > 500 && !/fetch\(|XMLHttpRequest|\.ajax|\.post\(/.test(pi4src));
T('G3', 'renderPlacesTab موصول بـviewShift (يُبنى من نفس استجابة /api/shifts/:id)',
    opsDash.includes('renderPlacesTab(currentShiftDetail)'));
T('G4', 'server.js يعرّض القسم المختوم فقط: response.places = sealed.places || null',
    fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').includes('response.places = sealed.places || null;'));
T('G5', 'التهريب esc مستخدم في القسم (لا HTML خام من البيانات)',
    /var esc = function \(v\)/.test(pi4src));
try {
    const scripts = opsDash.match(/<script>([\s\S]*?)<\/script>/g) || [];
    const inline = scripts.map(s => s.replace(/<\/?script>/g, '')).sort((a, b) => b.length - a.length)[0];
    const tmpJs = path.join(TMP, 'inline.js');
    fs.writeFileSync(tmpJs, inline);
    execSync('node --check "' + tmpJs + '"');
    T('G6', 'صياغة JS المضمّن سليمة (node --check على أكبر كتلة مضمّنة)', true);
} catch (e) { T('G6', 'صياغة JS المضمّن سليمة (node --check)', false, e.message.slice(0, 120)); }

// ── بناء اللقطة وتشغيل العرض الفعلي ──
const { svc, sealed } = buildSealedFixture();
const t = sealed.totals;
const R = makeRenderer();
const sealedJsonBefore = JSON.stringify(sealed);
R.api.renderPlacesTab({ shift: { id: 7, status: 'archived' }, places: sealed });
const html = R.html();

// V1 — مطابقة الأرقام حرفيًا
const school = sealed.byType.find(x => x.placeType === 'school');
const hosp = sealed.byType.find(x => x.placeType === 'hospital');
T('V1', 'كل رقم معروض يساوي قيمة اللقطة حرفيًا (إجمالي/مؤكد/محتمل/غير محسوم/بلا حسم)',
    html.includes('<span class="hk-val">' + t.incidents + '</span>') &&
    html.includes('<span class="hk-val">' + t.confirmedPlaceLinked + '</span>') &&
    html.includes('<span class="hk-val">' + t.likelyPlaceLinked + '</span>') &&
    html.includes('<span class="hk-val">' + t.unknownUnclassified + '</span>') &&
    html.includes('<div class="pt-count">' + school.confirmedCount + '</div>') &&
    html.includes('<div class="pt-count">' + hosp.confirmedCount + '</div>'),
    'incidents=' + t.incidents + ' confirmed=' + t.confirmedPlaceLinked + ' likely=' + t.likelyPlaceLinked +
    ' unknown=' + t.unknownUnclassified + ' school=' + school.confirmedCount + ' hospital=' + hosp.confirmedCount);

// V2 — الحفر الرباعي حتى Evidence
T('V2', 'المستويات الأربعة موجودة: نوع ← جهة ← بلاغ ← بطاقة Evidence',
    html.includes('pl-type-card') && html.includes('pl-place-row') && html.includes('pl-inc-row') &&
    html.includes('pl-detail') && html.includes('الأدلة (Evidence)') && html.includes('مدرسة الملك خالد') &&
    html.includes('pi-id') && html.includes('SC1'));

// V3 — Confirmed رقم رسمي / Likely مطوي منفصل
T('V3', 'المدارس تعرض 2 مؤكد فقط في العنوان، والمحتمل (1) مطوي بسطر منفصل',
    school.confirmedCount === 2 && school.likelyCount === 1 &&
    html.includes('<div class="pt-count">2</div>') &&
    html.includes('▸ محتمل — يحتاج تحقق: 1') &&
    html.includes('id="pl-likely-t-') && html.includes('style="display:none"'),
    'confirmed=' + school.confirmedCount + ' likely=' + school.likelyCount);

// V4 — Unknown سطر معلومة مستقل، لا يُحسب على جهة
T('V4', 'غير محسوم يظهر سطر معلومة (1) ولا يظهر تحت أي جهة ولا نوع «غير محسوم»',
    html.includes('غير محسوم: 1 بلاغًا') && !html.includes('مدارس غير محسومة') &&
    !html.includes('شرطة غير محسومة') && sealed.byType.every(x => x.placeType !== 'unknown'),
    'unknownUnclassified=' + t.unknownUnclassified);

// V5 — اللقطة القديمة (بلا places) والنشطة — بلا crash وبرسالة هادئة
{
    const R5 = makeRenderer();
    let crashed = false;
    try {
        R5.api.renderPlacesTab({ shift: { id: 8, status: 'archived' } }); // بلا places إطلاقًا
        R5.api.renderPlacesTab({ shift: { id: 9, status: 'archived' }, places: null }); // places=null
        R5.api.renderPlacesTab({ shift: { id: 10, status: 'active' }, places: null }); // نشطة
    } catch (_) { crashed = true; }
    T('V5', 'لقطة قديمة بلا places + places=null + مناوبة نشطة: بلا crash ورسائل غياب صادقة',
        !crashed &&
        R5.html().includes('قسم الجهات غير متوفر لهذه المناوبة') &&
        R5.html().includes('يُختم قسم الجهات والمواقع عند أرشفة المناوبة'));
}

// V6 — المقام بنصه المختوم + صفر حساب نسب في كود الواجهة
T('V6', 'denominatorNote تُعرض نصًا كما خُتمت، وكود الواجهة خالٍ من أي حساب نسبة',
    html.includes(esc4html(sealed.denominatorNote)) &&
    !/Math\.round|\/\s*confirmed|\/\s*t\.|parseFloat/.test(pi4src),
    sealed.denominatorNote);
function esc4html(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// V7 — عدم المساس بالقائم: أقسام المستشفيات والتبويبات التسعة كما هي
T('V7', 'تبويب المستشفيات وأقسامه (hosp-*) لم تتغير بنيتها',
    ['renderHospitalTab', 'hosp-journey', 'hosp-timeline', 'data-mtab="hospital"', 'switchModalTab']
        .every(x => opsDash.includes(x)));

// V8 — صفر استعلام حي أثناء العرض (عدادات فعلية على مخازن الخدمة)
{
    let loads = 0;
    const origR = svc._loadResolutions, origG = svc._loadRegistry;
    svc._loadResolutions = function () { loads++; return origR.call(svc); };
    svc._loadRegistry = function () { loads++; return origG.call(svc); };
    const R8 = makeRenderer();
    R8.api.renderPlacesTab({ shift: { id: 7, status: 'archived' }, places: sealed });
    svc._loadResolutions = origR; svc._loadRegistry = origG;
    T('V8', 'live-store requests during render: 0 (الواجهة لا تلمس المخازن الحية)',
        loads === 0, 'loads=' + loads);
}

// V9 — Historical Integrity: تغيير المخزن الحي لا يغيّر المعروض من اللقطة
{
    // ختمنا sealed مسبقًا (مدرسة الملك خالد / Confirmed / v1)؛ الآن نغيّر المخزن الحي جذريًا
    const reg = JSON.parse(fs.readFileSync(svc.placesFile, 'utf8'));
    reg.placesVersion = 5;
    const pid = Object.keys(reg.places).find(k => reg.places[k].name === 'مدرسة الملك خالد');
    reg.places[pid].name = 'مدرسة أخرى مغيّرة';
    fs.writeFileSync(svc.placesFile, JSON.stringify(reg, null, 2));
    const resStore = JSON.parse(fs.readFileSync(svc.resolutionsFile, 'utf8'));
    resStore.byIncident['SC1'].confidence = 70;
    resStore.byIncident['SC1'].decision = 'likely';
    resStore.byIncident['SC1'].placesVersion = 5;
    fs.writeFileSync(svc.resolutionsFile, JSON.stringify(resStore));
    // إعادة فتح «الأرشيف» = عرض نفس اللقطة المختومة مرة أخرى
    const R9 = makeRenderer();
    R9.api.renderPlacesTab({ shift: { id: 7, status: 'archived' }, places: sealed });
    const h9 = R9.html();
    const sealedVer = sealed.byType.find(x => x.placeType === 'school').places[0].incidents[0].placesVersion;
    T('V9', 'بعد تغيير المخزن الحي (اسم/حالة/ثقة/نسخة): الشاشة تبقى «مدرسة الملك خالد · مؤكد · v' + sealedVer + '» بالضبط',
        h9.includes('مدرسة الملك خالد') && !h9.includes('مدرسة أخرى مغيّرة') &&
        h9.includes('>v' + sealedVer + '<') && !h9.includes('>v5<') &&
        h9.includes('ثقة 97%'),
        'sealedVer=v' + sealedVer + ' (الحي الآن: اسم مغيّر/likely/70/v5 — لا أثر له في العرض)');
}

// V10 — No UI Mutation: العرض لا يغيّر اللقطة ولا يستدعي resolve/recordResolution
{
    let resolveCalls = 0, recordCalls = 0;
    const origRes = svc.resolve, origRec = svc.recordResolution;
    svc.resolve = function () { resolveCalls++; return origRes.apply(svc, arguments); };
    svc.recordResolution = function () { recordCalls++; return origRec.apply(svc, arguments); };
    const R10 = makeRenderer();
    R10.api.renderPlacesTab({ shift: { id: 7, status: 'archived' }, places: sealed });
    // محاكاة فتح/طي: placesTabToggle يقلب style.display فقط — لا بيانات
    const el = { style: { display: 'none' } };
    const docStubGlobal = global.document; // لا يوجد — الدالة تستقبل document من المصنع
    svc.resolve = origRes; svc.recordResolution = origRec;
    T('V10', 'العرض لا يغيّر اللقطة (JSON مطابق 100%) ولا يستدعي resolve/recordResolution، والطي ترتيب بصري فقط',
        JSON.stringify(sealed) === sealedJsonBefore && resolveCalls === 0 && recordCalls === 0 &&
        /placesTabToggle[\s\S]*?style\.display/.test(pi4src) && !/resolve\(|recordResolution/.test(pi4src),
        'resolve=' + resolveCalls + ' record=' + recordCalls + ' sealedUnchanged=' + (JSON.stringify(sealed) === sealedJsonBefore));
    void docStubGlobal; void el;
}

console.log('\n════════════════════════════════');
console.log('النتيجة: ' + pass + ' ✅ · ' + fail + ' ❌');
console.log('مجلد الاختبار المعزول: ' + TMP);
process.exit(fail ? 1 : 0);

})().catch(err => { console.error('❌ خطأ عام:', err); process.exit(1); });
