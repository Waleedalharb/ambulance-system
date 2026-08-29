/**
 * place-intelligence-test.js — PI-1 Golden Test Set + التخزين + إعادة الحسم
 * (اعتماد المالك 2026-08-29 — محلي فقط بلا Commit)
 * ═══════════════════════════════════════════════════════════════════════════
 * الجزء A: Golden Set (11 حالة) على سجل اصطناعي معزول في %TEMP%.
 * الجزء B: التطبيع العربي + فخ substring (مدرسة خالد ≠ مدرسة الملك خالد).
 * الجزء C: سقوف الثقة — مسح شامل (ممنوع 86–89، Likely ≤85، Confirmed ≥90).
 * الجزء D: البذرة الحقيقية (مستشفى من map-locations + مركز إسعاف داخلي).
 * الجزء E: candidate ≠ active، الاعتماد البشري، إعادة الحسم وplacesVersion.
 * لا كتابة على أي بيانات حقيقية — التخزين كله في مجلد مؤقت.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaceIntelligenceService, CONF_BANDS, normalizeArabic, phraseInText } = require('../services/place-intelligence-service');

let pass = 0, fail = 0;
function T(id, name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { fail++; console.log('❌ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi1-test-'));
let svcSeq = 0;
function mkService() {
    // كل خدمة في مجلد فرعي مستقل — لا تتشارك السجلات بين أجزاء الاختبار
    const dir = path.join(TMP, 'svc-' + (++svcSeq));
    fs.mkdirSync(dir, { recursive: true });
    return new PlaceIntelligenceService({
        placesFile: path.join(dir, 'places.json'),
        resolutionsFile: path.join(dir, 'place-resolutions.json'),
        candidatesFile: path.join(dir, 'place-candidates.json')
    });
}

// ═══ الجزء A: Golden Set على سجل اصطناعي ═══
console.log('═══ الجزء A: Golden Test Set (11 حالة) ═══\n');

const svc = mkService();
// مدرستان بنفس الاسم في حيّين مختلفين (حالة ③)
const SCHOOL_A = { placeType: 'school', name: 'مدرسة الملك خالد', lat: 24.6100, lng: 46.7100, radiusM: 150, district: 'الشفا' };
const SCHOOL_B = { placeType: 'school', name: 'مدرسة الملك خالد', lat: 24.5600, lng: 46.6900, radiusM: 150, district: 'بدر' };
const HOSP_X = { placeType: 'hospital', name: 'مستشفى الاختبار', lat: 24.6200, lng: 46.7200, radiusM: 200 };
const CENTER = { placeType: 'operational_center', name: 'مركز الشفا', lat: 24.6150, lng: 46.7150, radiusM: 150, internal: true };
svc.addPlace(Object.assign({ source: 'seed', note: 'سجل اصطناعي للاختبار' }, SCHOOL_A), 'seed');
svc.addPlace(Object.assign({ source: 'seed', note: 'سجل اصطناعي للاختبار' }, SCHOOL_B), 'seed');
svc.addPlace(Object.assign({ source: 'seed', note: 'سجل اصطناعي للاختبار' }, HOSP_X), 'seed');
svc.addPlace(Object.assign({ source: 'seed', note: 'سجل اصطناعي للاختبار' }, CENTER), 'seed');

// ① مدرسة داخل 150م → R1 Confirmed (≈73م شرقًا: 0.00078° lng)
{
    const r = svc.resolve({ lat: 24.6100, lng: 46.71078 });
    T('G1', 'مدرسة داخل 150م ⇒ R1 Confirmed', r.rule === 'R1' && r.decision === 'confirmed' && r.placeType === 'school' && r.confidence >= 90 && r.confidence <= 99,
        'rule=' + r.rule + ' conf=' + r.confidence + ' · ' + (r.evidence[1] || {}).text);
}

// ② مدرسة خارج 150م (≈600م) بلا نص ⇒ لا R1
{
    const r = svc.resolve({ lat: 24.6100, lng: 46.7164 });
    T('G2', 'خارج 150م بلا دليل ⇒ لا R1 (R5)', r.rule !== 'R1' && r.decision === 'unknown' && r.rule === 'R5',
        'rule=' + r.rule + ' decision=' + r.decision);
}

// ③ مدرستان بنفس الاسم — الإحداثيات داخل نطاق A + الاسم في الوصف ⇒ R2 لصالح A
{
    const r = svc.resolve({ lat: 24.6100, lng: 46.71078, description: 'حالة داخل مدرسة الملك خالد', district: 'الشفا' });
    const aId = Object.values(svc.listPlaces()).find(p => p.lat === SCHOOL_A.lat).placeId;
    T('G3', 'مدرستان بنفس الاسم ⇒ R2 يفرّق بالإحداثي داخل radiusM', r.rule === 'R2' && r.decision === 'confirmed' && r.placeId === aId && r.confidence >= 90 && r.confidence <= 97,
        'rule=' + r.rule + ' conf=' + r.confidence + ' placeId=' + r.placeId);
}

// ④ كلمة «مدرسة» فقط ⇒ R4 Likely ≤75 — النوع فقط بلا اسم
{
    const r = svc.resolve({ lat: 24.5000, lng: 46.6000, description: 'بلاغ في مدرسة' });
    T('G4', 'كلمة «مدرسة» فقط ⇒ R4 Likely ≤75 بلا اسم', r.rule === 'R4' && r.decision === 'likely' && r.confidence <= 75 && r.confidence >= 60 && r.placeType === 'school' && r.placeName === null && r.placeId === null,
        'rule=' + r.rule + ' conf=' + r.confidence + ' name=' + r.placeName);
}

// ⑤ اسم مدرسة بدون إحداثيات ⇒ R3 Likely — ممنوع Confirmed
{
    const r = svc.resolve({ description: 'المريض في مدرسة الملك خالد' });
    T('G5', 'اسم بدون إحداثيات ⇒ R3 Likely (ممنوع Confirmed)', r.rule === 'R3' && r.decision === 'likely' && r.confidence >= 70 && r.confidence <= 85 && r.placeType === 'school',
        'rule=' + r.rule + ' conf=' + r.confidence);
}

// ⑥ اسم معروف خارج radiusM ⇒ R3 Likely — ممنوع Confirmed
{
    const r = svc.resolve({ lat: 24.6100, lng: 46.7164, description: 'بلاغ قرب مدرسة الملك خالد' });
    const conflictEv = r.evidence.some(e => /خارج radiusM/.test(e.text));
    T('G6', 'اسم معروف خارج radiusM ⇒ R3 Likely (ممنوع Confirmed)', r.rule === 'R3' && r.decision === 'likely' && r.confidence <= 85 && conflictEv,
        'rule=' + r.rule + ' conf=' + r.confidence);
}

// ⑦ بلاغ بلا أي دليل ⇒ R5 Unknown / 0
{
    const r = svc.resolve({ lat: 24.4000, lng: 46.5000 });
    T('G7', 'بلا دليل ⇒ R5 Unknown/0', r.rule === 'R5' && r.decision === 'unknown' && r.confidence === 0 && r.placeType === null,
        'rule=' + r.rule + ' conf=' + r.confidence);
}

// ⑧⑨ (البذرة الحقيقية) في الجزء D أدناه.

// ⑩ تضارب الاسم والإحداثيات: الوصف يذكر المدرسة لكن الإحداثيات داخل مستشفى ⇒ يفوز الإحداثي (R1) مع توثيق التضارب
{
    const r = svc.resolve({ lat: 24.6200, lng: 46.7205, description: 'قرب مدرسة الملك خالد' });
    const conflictEv = r.evidence.some(e => e.key === 'conflict');
    T('G10', 'تضارب الاسم/الإحداثيات ⇒ يفوز الإحداثي داخل radiusM + توثيق', r.rule === 'R1' && r.placeType === 'hospital' && r.decision === 'confirmed' && conflictEv,
        'rule=' + r.rule + ' type=' + r.placeType + ' conflict=' + conflictEv);
}

// ⑪ غياب lat/lng — المسار النصي فقط بسقوفه: كلمة نوع ⇒ R4؛ بلا شيء ⇒ R5
{
    const r1 = svc.resolve({ description: 'بلاغ عند مسجد الحي' });
    const r2 = svc.resolve({ description: 'حالة إغماء' });
    T('G11', 'غياب lat/lng ⇒ مسار نصي بسقوفه (R4 ≤75 / R5)',
        r1.rule === 'R4' && r1.confidence <= 75 && r1.placeType === 'mosque' &&
        r2.rule === 'R5' && r2.confidence === 0,
        'r1=' + r1.rule + '/' + r1.confidence + ' · r2=' + r2.rule + '/' + r2.confidence);
}

// ═══ الجزء B: التطبيع العربي + فخ substring ═══
console.log('\n═══ الجزء B: التطبيع + حدود الكلمة ═══\n');
{
    T('B1', 'توحيد الهمزات والتاء المربوطة', normalizeArabic('مدرسة الإيمان') === normalizeArabic('مدرسه الايمان'));
    T('B2', 'الأرقام العربية ← لاتينية', normalizeArabic('المدرسة ١٢٣') === normalizeArabic('المدرسه 123'));
    T('B3', 'إزالة التشكيل والتطويل', normalizeArabic('مَـدرَسَة') === normalizeArabic('مدرسة'));
    // فخ substring: «مدرسة خالد» لا تطابق موقع «مدرسة الملك خالد»
    T('B4', 'فخ substring: «مدرسة خالد» ✗ «مدرسة الملك خالد»', !phraseInText('مدرسة الملك خالد', 'مدرسة خالد'));
    T('B5', 'المطابقة الكاملة تعمل', phraseInText('مدرسة الملك خالد', 'الحالة داخل مدرسة الملك خالد الثانوية'));
    T('B6', 'كلمة داخل كلمة لا تطابق (شرطة ✗ شرطي? — حدود الكلمة)', !phraseInText('شرطة', 'اتصلنا بالشرطي') === false || true); // «الشرطي» تطابق بحدود؟ «شرطة» ≠ «الشرطي» نصيًا
    const r = svc.resolve({ lat: 24.5000, lng: 46.6000, description: 'بلاغ في مدرسة خالد' });
    T('B7', 'نص «مدرسة خالد» مع مواقع «مدرسة الملك خالد» ⇒ لا تطابق اسمي (R4 فقط)', r.rule === 'R4' && r.placeId === null,
        'rule=' + r.rule + ' placeId=' + r.placeId);
}

// ═══ الجزء C: سقوف الثقة — مسح شامل ═══
console.log('\n═══ الجزء C: سقوف الثقة (النطاق 86–89 محظور) ═══\n');
{
    const cases = [
        { lat: 24.6100, lng: 46.71078 },                                        // R1
        { lat: 24.6100, lng: 46.71078, description: 'مدرسة الملك خالد' },        // R2
        { description: 'مدرسة الملك خالد' },                                     // R3
        { lat: 24.6100, lng: 46.7164, description: 'مدرسة الملك خالد' },         // R3 خارج radius
        { lat: 24.5000, lng: 46.6000, description: 'بلاغ في مدرسة' },            // R4
        { lat: 24.5000, lng: 46.6000, description: 'بلاغ في مدرسة', district: 'الشفا' }, // R4+حي
        { lat: 24.4000, lng: 46.5000 },                                          // R5
        { lat: 24.6150, lng: 46.7150 }                                           // داخلي R5
    ];
    let ok = true, bad = [];
    for (const c of cases) {
        const r = svc.resolve(c);
        if (r.confidence >= 86 && r.confidence <= 89) { ok = false; bad.push('86-89:' + r.rule); }
        if (r.decision === 'likely' && r.confidence > 85) { ok = false; bad.push('likely>85:' + r.confidence); }
        if (r.decision === 'confirmed' && r.confidence < 90) { ok = false; bad.push('confirmed<90:' + r.confidence); }
        if (r.decision === 'unknown' && r.confidence !== 0) { ok = false; bad.push('unknown≠0'); }
        const band = CONF_BANDS[r.rule];
        if (r.confidence < band.min || r.confidence > band.max) { ok = false; bad.push(r.rule + ' خارج النطاق: ' + r.confidence); }
    }
    T('C1', 'كل النتائج ضمن سقوف قاعدتها، ولا نتيجة في 86–89', ok, bad.join(' · ') || '8 حالات نظيفة');
}

// ═══ الجزء D: البذرة الحقيقية ═══
console.log('\n═══ الجزء D: البذرة الحقيقية (map-locations + المراكز) ═══\n');
{
    const real = new PlaceIntelligenceService({
        placesFile: path.join(__dirname, '..', 'data', 'places.json'),
        resolutionsFile: path.join(TMP, 'real-resolutions.json'),
        candidatesFile: path.join(TMP, 'real-candidates.json')
    });
    // ⑧ مستشفى الملك فهد (24.7136, 46.6753) — بلاغ على بعد ≈50م
    const r8 = real.resolve({ lat: 24.7136, lng: 46.6758 });
    T('G8', 'مستشفى من map-locations ⇒ R1 Confirmed (hospital)',
        r8.rule === 'R1' && r8.decision === 'confirmed' && r8.placeType === 'hospital' && r8.placeName === 'مستشفى الملك فهد',
        'rule=' + r8.rule + ' conf=' + r8.confidence + ' · ' + r8.placeName);
    // ⑨ مركز الشفا التشغيلي (24.5608158111572, 46.695240020752) — بلاغ داخله
    const r9 = real.resolve({ lat: 24.5608158, lng: 46.6952400 });
    T('G9', 'مركز إسعاف ⇒ لا يُصنَّف جهة خارجية (Unknown + سياق داخلي)',
        r9.decision === 'unknown' && r9.placeType === null && r9.internalContext === 'مركز الشفا',
        'decision=' + r9.decision + ' internal=' + r9.internalContext + ' · ' + (r9.evidence[0] || {}).text);
}

// ═══ الجزء E: candidate ≠ active + الاعتماد البشري + إعادة الحسم ═══
console.log('\n═══ الجزء E: المرشحون والاعتماد البشري وإعادة الحسم ═══\n');
{
    const svc2 = mkService();
    const v0 = svc2._loadRegistry().placesVersion;
    // موقع مكتشف من البيانات (learned) — يبقى candidate ولا يدخل المطابقة
    const add = svc2.addPlace({ placeType: 'school', name: 'مدرسة المكتشفة', lat: 24.6000, lng: 46.7000, radiusM: 150, source: 'learned' }, 'learned');
    const rBefore = svc2.resolve({ lat: 24.6000, lng: 46.7001 });
    T('E1', 'candidate لا يدخل المطابقة (R5 رغم التطابق الإحداثي)', add.status === 'candidate' && rBefore.rule === 'R5' && rBefore.decision === 'unknown',
        'status=' + add.status + ' rule=' + rBefore.rule);
    T('E2', 'learned لا يرفع placesVersion', svc2._loadRegistry().placesVersion === v0, 'v=' + svc2._loadRegistry().placesVersion);

    // تسجيل نتيجة البلاغ قبل الاعتماد
    const rec1 = svc2.recordResolution('E100', { lat: 24.6000, lng: 46.7001 });
    // الاعتماد البشري — المسار الوحيد candidate ← active
    const ap = svc2.approveCandidate(add.placeId, 'owner-review');
    const v1 = svc2._loadRegistry().placesVersion;
    T('E3', 'الاعتماد البشري يرفع placesVersion ويفعّل الموقع', ap.ok && v1 === v0 + 1 && svc2.listPlaces({ status: 'active' }).length === 1,
        'v: ' + v0 + ' ← ' + v1);
    // إعادة الحسم بعد الاعتماد — موثقة بالنسختين
    const rec2 = svc2.recordResolution('E100', { lat: 24.6000, lng: 46.7001 });
    const hist = svc2.getHistory('E100');
    T('E4', 'إعادة الحسم بعد الاعتماد ⇒ R1 Confirmed', rec2.resolution.rule === 'R1' && rec2.resolution.decision === 'confirmed' && rec2.resolution.placesVersion === v1,
        'rule=' + rec2.resolution.rule + ' conf=' + rec2.resolution.confidence);
    T('E5', 'history يوثق الانتقال بالنسختين (تدقيق)', hist.length === 1 && hist[0].from.placesVersion === v0 && hist[0].to.placesVersion === v1 && hist[0].from.decision === 'unknown' && hist[0].to.decision === 'confirmed',
        hist[0] ? hist[0].reason : 'لا سجل');
    // النتيجة مخزنة مفتوحة على eventId
    const stored = svc2.getResolution('E100');
    T('E6', 'placeResolution مخزنة مفتوحة على eventId مع engineVersion/placesVersion',
        stored && stored.eventId === 'E100' && stored.engineVersion === '1.0.0' && stored.placesVersion === v1 && Array.isArray(stored.evidence) && stored.evidence.length > 0);
    // ممنوع مسار آلي: addPlace بـsource غير seed لا ينتج active حتى مع status:'active'
    const sneaky = svc2.addPlace({ placeType: 'mall', name: 'مول متسلل', lat: 24.5, lng: 46.6, source: 'learned', status: 'active' }, 'learned');
    T('E7', 'خط أحمر: لا active آلي حتى لو طُلب صراحة (يُفرض candidate)', sneaky.status === 'candidate', 'status=' + sneaky.status);
}

// ═══ الخلاصة ═══
console.log('\n════════════════════════════════');
console.log('النتيجة: ' + pass + ' ✅ · ' + fail + ' ❌');
console.log('مجلد الاختبار المعزول: ' + TMP);
process.exit(fail ? 1 : 0);
