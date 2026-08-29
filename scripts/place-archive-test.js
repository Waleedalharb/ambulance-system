/**
 * place-archive-test.js — PI-3 Golden Test Set (حواجز المالك A–H + ربط server)
 * (اعتماد المالك 2026-08-29 — محلي فقط بلا Commit)
 * ═══════════════════════════════════════════════════════════════════════════
 * A تزامن بلا lost update · B حدث واحد بثلاث حالات يُحسب مرة ·
 * C ختم ثم اعتماد ثم ثبات القديمة · D Confirmed/Likely منفصلان ·
 * E Unknown لا يظهر تحت جهة · F denominator موثق · G canonical ثابت ·
 * H archive لا يستدعي resolve() · + اختبارات طابور الربط (تخزين/عزل فشل).
 * كل التخزين في مجلدات مؤقتة — لا كتابة على بيانات حقيقية.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { PlaceIntelligenceService, PLACE_TYPES } = require('../services/place-intelligence-service');
const { makeResolutionHook } = require('../services/place-resolution-hook');
const { ShiftArchiveSnapshot } = require('../shift-archive-engine');

let pass = 0, fail = 0;
function T(id, name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { fail++; console.log('❌ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi3-test-'));
function mkService() {
    const dir = fs.mkdtempSync(path.join(TMP, 'svc-'));
    return new PlaceIntelligenceService({
        placesFile: path.join(dir, 'places.json'),
        resolutionsFile: path.join(dir, 'place-resolutions.json'),
        candidatesFile: path.join(dir, 'place-candidates.json')
    });
}
// جهة معتمدة بشريًا جاهزة (مدرسة عند 24.6,46.7 بنطاق 100م)
function seedApprovedSchool(svc) {
    const add = svc.addPlace({ placeType: 'school', name: 'مدرسة الأرشيف', lat: 24.6000, lng: 46.7000, radiusM: 100, source: 'learned' }, 'learned');
    svc.approveCandidate(add.placeId, 'owner', 'الحرم الفعلي 100م');
    return add.placeId;
}

(async () => {

console.log('═══ PI-3 Golden Test Set ═══\n');

// ── ربط الطابور: التخزين + عزل الفشل ──
{
    const svc = mkService();
    seedApprovedSchool(svc);
    const hook = makeResolutionHook(svc);
    hook.enqueue('H100', { lat: 24.6000, lng: 46.7002 }); // داخل النطاق
    await hook._drain();
    const r = svc.getResolution('H100');
    T('Q1', 'الطابور يخزّن placeResolution (R1 Confirmed داخل النطاق)',
        r && r.rule === 'R1' && r.decision === 'confirmed', r && r.rule + '/' + r.decision + '/' + r.confidence);
}
{
    const svc = mkService();
    svc.recordResolution = () => { throw new Error('فشل مصطنع'); }; // محرك ينهار
    const hook = makeResolutionHook(svc, { error: () => {} });      // إسكات السجل
    hook.enqueue('F100', { lat: 24.6, lng: 46.7 });
    hook.enqueue('F101', { lat: 24.6, lng: 46.7 });
    await hook._drain();
    const st = hook._stats();
    T('Q2', 'فشل المحرك لا يكسر الطابور — البلاغان حُاولا وفُشلا بأمان', st.enqueued === 2 && st.failed === 2,
        JSON.stringify(st));
}

// ── A: تزامن 50 بلاغًا — بلا lost update ──
{
    const svc = mkService();
    const hook = makeResolutionHook(svc);
    const jobs = [];
    for (let i = 0; i < 50; i++) jobs.push(Promise.resolve().then(() => hook.enqueue('C' + i, { lat: 24.5, lng: 46.6 })));
    await Promise.all(jobs);
    await hook._drain();
    const stored = Object.keys(svc._loadResolutions().byIncident).length;
    T('A', '50 بلاغًا متزامنًا ← 50 نتيجة مخزنة (لا lost update)', stored === 50, 'stored=' + stored);
}

// ── B: نفس eventId بثلاث حالات ← يُحسب مرة واحدة بالحالة النهائية ──
{
    const svc = mkService();
    // v1: Unknown (بعيد عن أي جهة)
    svc.recordResolution('B100', { lat: 24.4000, lng: 46.5000 });
    // اعتماد مدرسة قرب الموقع الجديد
    const add = svc.addPlace({ placeType: 'school', name: 'مدرسة B', lat: 24.6100, lng: 46.7100, radiusM: 150, source: 'learned' }, 'learned');
    svc.approveCandidate(add.placeId, 'owner', 'حدود فعلية');
    // v2: R4 Likely (كلمة نوع فقط في نص بعيد)
    svc.recordResolution('B100', { lat: 24.4000, lng: 46.5000, description: 'بلاغ في مدرسة' });
    // v3: Confirmed (دخل نطاقها بعد تحديث العنوان/الإحداثيات)
    svc.recordResolution('B100', { lat: 24.6100, lng: 46.7103 });
    const hist = svc.getHistory('B100');
    const section = svc.archiveSectionForIncidents(['B100']);
    const schoolType = section.byType.find(t => t.placeType === 'school');
    T('B', 'Unknown ← Likely ← Confirmed: يُحسب بلاغًا واحدًا بالحالة النهائية',
        hist.length === 2 && section.totals.confirmedPlaceLinked === 1 && schoolType && schoolType.confirmedCount === 1,
        'history=' + hist.length + ' confirmed=' + section.totals.confirmedPlaceLinked);
    T('B2', 'حاجز ②: v1/v2 لا تختفي — history يوثق الانتقالين بالنسخ',
        hist[0].from.decision === 'unknown' && hist[1].to.decision === 'confirmed' && hist[1].to.placesVersion > hist[0].from.placesVersion,
        hist.map(h => h.from.decision + '←' + h.to.decision).join(' | '));
}

// ── C: ثبات اللقطة المختومة (ختم ← اعتماد لاحق ← القديمة لا تتغير) ──
{
    const svc = mkService();
    svc.recordResolution('S100', { lat: 24.6100, lng: 46.7100 }); // Unknown (لا جهة بعد)
    const sealedOld = svc.archiveSectionForIncidents(['S100']);   // «لقطة المناوبة القديمة»
    const sealedOldJson = JSON.stringify(sealedOld);
    // لاحقًا: اعتماد بشري لجهة عند موقع البلاغ نفسه + إعادة حسم
    const addC = svc.addPlace({ placeType: 'school', name: 'مدرسة C', lat: 24.6100, lng: 46.7100, radiusM: 100, source: 'learned' }, 'learned');
    svc.approveCandidate(addC.placeId, 'owner', 'الحرم الفعلي 100م');
    svc.recordResolution('S100', { lat: 24.6100, lng: 46.7100 });
    const after = svc.getResolution('S100');
    const sealedNew = svc.archiveSectionForIncidents(['S100']);   // «لقطة مناوبة جديدة»
    T('C', 'حاجز ③: اللقطة القديمة ثابتة (Unknown) والجديدة وحدها ترى Confirmed',
        JSON.stringify(sealedOld) === sealedOldJson &&
        sealedOld.totals.confirmedPlaceLinked === 0 &&
        after.decision === 'confirmed' &&
        sealedNew.totals.confirmedPlaceLinked === 1,
        'old=' + sealedOld.totals.confirmedPlaceLinked + ' new=' + sealedNew.totals.confirmedPlaceLinked);
}

// ── D + E: Confirmed/Likely منفصلان · Unknown لا يظهر تحت جهة ──
{
    const svc = mkService();
    seedApprovedSchool(svc);
    svc.recordResolution('D1', { lat: 24.6000, lng: 46.7002 });                          // Confirmed
    svc.recordResolution('D2', { lat: 24.4000, lng: 46.5000, description: 'بلاغ في مدرسة' }); // R4 Likely
    svc.recordResolution('D3', { lat: 24.4100, lng: 46.5100 });                          // Unknown
    const section = svc.archiveSectionForIncidents(['D1', 'D2', 'D3']);
    const school = section.byType.find(t => t.placeType === 'school');
    T('D', 'Confirmed=1 وLikely=1 لنفس النوع — منفصلان تمامًا',
        school && school.confirmedCount === 1 && school.likelyCount === 1 && section.totals.confirmedPlaceLinked === 1 && section.totals.likelyPlaceLinked === 1);
    T('E', 'Unknown لا يظهر تحت أي جهة — سطر معلومة فقط',
        section.totals.unknownUnclassified === 1 && section.byType.every(t => t.placeType !== 'unknown'));
}

// ── F: النسبة بمقام موثق ──
{
    const svc = mkService();
    seedApprovedSchool(svc); // school ×1
    const addH = svc.addPlace({ placeType: 'hospital', name: 'مستشفى الأرشيف', lat: 24.5500, lng: 46.6600, radiusM: 200, source: 'learned' }, 'learned');
    svc.approveCandidate(addH.placeId, 'owner', 'حرم المستشفى');
    svc.recordResolution('P1', { lat: 24.6000, lng: 46.7002 });  // school
    svc.recordResolution('P2', { lat: 24.5500, lng: 46.6602 });  // hospital
    svc.recordResolution('P3', { lat: 24.5500, lng: 46.6604 });  // hospital
    const section = svc.archiveSectionForIncidents(['P1', 'P2', 'P3']);
    const hosp = section.byType.find(t => t.placeType === 'hospital');
    T('F', 'النسبة بمقام صريح: hospital=66.7% من 3 مؤكدة موثق',
        hosp && hosp.percentOfConfirmed === 66.7 && /3/.test(section.denominatorNote),
        section.denominatorNote);
}

// ── G: placeType canonical فقط ──
{
    const svc = mkService();
    seedApprovedSchool(svc);
    svc.recordResolution('G1', { lat: 24.6000, lng: 46.7002 });
    svc.recordResolution('G2', { lat: 24.4, lng: 46.5, description: 'بلاغ قرب مسجد' });
    const section = svc.archiveSectionForIncidents(['G1', 'G2']);
    T('G', 'كل الأنواع في القسم من القائمة canonical — لا نوع حر',
        section.byType.every(t => PLACE_TYPES.includes(t.placeType)),
        section.byType.map(t => t.placeType).join(', '));
}

// ── H: الأرشيف لا يستدعي resolve إطلاقًا ──
{
    const svc = mkService();
    seedApprovedSchool(svc);
    svc.recordResolution('H1', { lat: 24.6000, lng: 46.7002 });
    const origResolve = svc.resolve;
    svc.resolve = () => { throw new Error('ممنوع resolve من الأرشيف'); };
    let section = null, threw = false;
    try { section = svc.archiveSectionForIncidents(['H1']); } catch (_) { threw = true; }
    svc.resolve = origResolve;
    T('H', 'حاجز ⑧: بناء القسم نجح وresolve مكسورة — قراءة مخازن فقط',
        !threw && section && section.totals.confirmedPlaceLinked === 1);
}

// ── حقن محرك الأرشيف: _getPlaces بنمط hospitalMonitor ──
{
    const svc = mkService();
    seedApprovedSchool(svc);
    svc.recordResolution('W1', { lat: 24.6000, lng: 46.7002 });
    const snap = new ShiftArchiveSnapshot({ all: async () => [{ number: 'W1' }] }, TMP);
    snap.placeIntel = svc;
    const section = await snap._getPlaces(7);
    T('W', '_getPlaces تقرأ أرقام بلاغات المناوبة وتبني القسم',
        section && section.totals.incidents === 1 && section.totals.confirmedPlaceLinked === 1);
    const snap2 = new ShiftArchiveSnapshot({ all: async () => [] }, TMP);
    const empty = await snap2._getPlaces(7); // بلا حقن
    T('W2', 'بدون حقن placeIntel ← القسم null بصدق (لا اختراع)', empty === null);
}

console.log('\n════════════════════════════════');
console.log('النتيجة: ' + pass + ' ✅ · ' + fail + ' ❌');
console.log('مجلد الاختبار المعزول: ' + TMP);
process.exit(fail ? 1 : 0);

})().catch(err => { console.error('❌ خطأ عام:', err); process.exit(1); });
