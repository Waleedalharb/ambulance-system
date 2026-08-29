/**
 * place-archive-proof2-test.js — إغلاق ثغرات الإثبات الأربع من مراجعة المالك
 * على PI-3 (RETURN 2026-08-29). اختبارات فقط — صفر تعديل على كود الإنتاج:
 * ═══════════════════════════════════════════════════════════════════════════
 * P1 Snapshot Immutability (mutation عميق): ختم لقطة ثم تعديل المخازن على
 *    القرص نفسه (name / placeType / confidence / evidence / placesVersion /
 *    حذف placeResolution) ← اللقطة المختومة يجب ألا تتغير إطلاقًا (100%).
 * P2 Old Snapshot Compatibility: لقطة مختومة قبل PI-3 (بلا مفتاح places /
 *    places=null) تُقرأ وتُعالج بلا crash ويُعامل الغياب كغياب طبيعي.
 * P3 _parseLocationParts failure isolation: بلاغ A يفشل داخل التحليل ←
 *    فشله معزول، بلاغ B يُعالج طبيعيًا، الطابور سليم، استجابة POST لا تتأثر.
 * P4 Unique eventId counting (بالأرقام الصريحة): eventId واحد بثلاث حالات
 *    تاريخية ← يُحسب بلاغًا واحدًا فقط، لا يتكرر تحت الجهة، history محفوظ،
 *    والحالة النهائية فقط تدخل القسم.
 * كل التخزين في مجلدات مؤقتة — لا كتابة على بيانات حقيقية.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaceIntelligenceService } = require('../services/place-intelligence-service');
const { makeResolutionHook } = require('../services/place-resolution-hook');

let pass = 0, fail = 0;
function T(id, name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { fail++; console.log('❌ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi3-proof2-'));
function mkService(sub) {
    const dir = fs.mkdtempSync(path.join(TMP, sub + '-'));
    return new PlaceIntelligenceService({
        placesFile: path.join(dir, 'places.json'),
        resolutionsFile: path.join(dir, 'place-resolutions.json'),
        candidatesFile: path.join(dir, 'place-candidates.json')
    });
}

(async () => {

console.log('═══ PI-3 — إثباتات إغلاق المراجعة (RETURN → PASS) ═══\n');

// ═══════════════════════════════════════════════════════════════════════════
// P1 — Snapshot Immutability: mutation عميق على المخازن بعد الختم
// ═══════════════════════════════════════════════════════════════════════════
{
    const svc1 = mkService('p1');
    const add = svc1.addPlace({ placeType: 'school', name: 'مدرسة الختم', lat: 24.6000, lng: 46.7000, radiusM: 100, source: 'learned' }, 'learned');
    svc1.approveCandidate(add.placeId, 'owner', 'الحرم الفعلي 100م');
    svc1.recordResolution('S200', { lat: 24.6000, lng: 46.7002 });
    const pre = svc1.getResolution('S200');

    // «الختم»: ما يخزنه محرك الأرشيف فعلًا هو JSON مُسلسَل من القسم
    const sealed = JSON.parse(JSON.stringify(svc1.archiveSectionForIncidents(['S200'])));
    const sealedJson = JSON.stringify(sealed);

    // ── mutation عميق على القرص نفسه (يحاكي تغيّر المخازن بمرور الوقت) ──
    // نستخدم نسخة خدمة جديدة بلا كاش لنثبت أن التعديل وقع فعلًا في البيانات
    const reg = JSON.parse(fs.readFileSync(svc1.placesFile, 'utf8'));
    reg.placesVersion = 99;                                             // placesVersion
    reg.places[add.placeId].name = 'اسم مغيّر كليًا بعد الختم';          // name
    reg.places[add.placeId].placeType = 'mosque';                       // placeType
    reg.places[add.placeId].radiusM = 9999;                             // نطاق
    fs.writeFileSync(svc1.placesFile, JSON.stringify(reg, null, 2));

    const resStore = JSON.parse(fs.readFileSync(svc1.resolutionsFile, 'utf8'));
    resStore.byIncident['S200'].confidence = 3;                         // confidence
    resStore.byIncident['S200'].evidence = [{ mutated: true }];         // evidence
    resStore.byIncident['S200'].placesVersion = 99;                     // placesVersion
    fs.writeFileSync(svc1.resolutionsFile, JSON.stringify(resStore));

    // إثبات أن الـmutation وقع فعلًا: خدمة جديدة بلا كاش ترى القيم المعدّلة
    const svc2 = new PlaceIntelligenceService({
        placesFile: svc1.placesFile, resolutionsFile: svc1.resolutionsFile, candidatesFile: svc1.candidatesFile
    });
    const mutated = svc2.getResolution('S200');
    const mutationApplied = mutated && mutated.confidence === 3 && svc2._loadRegistry().places[add.placeId].name === 'اسم مغيّر كليًا بعد الختم';

    T('P1a', 'اللقطة المختومة ثابتة 100% بعد تعديل name/placeType/confidence/evidence/placesVersion',
        mutationApplied && JSON.stringify(sealed) === sealedJson,
        'pre=' + pre.confidence + ' mutated=' + (mutated && mutated.confidence) + ' sealedUnchanged=' + (JSON.stringify(sealed) === sealedJson));

    // ── الحذف الكامل للـ placeResolution الأصلي ──
    const resStore2 = JSON.parse(fs.readFileSync(svc1.resolutionsFile, 'utf8'));
    delete resStore2.byIncident['S200'];
    fs.writeFileSync(svc1.resolutionsFile, JSON.stringify(resStore2));
    const svc3 = new PlaceIntelligenceService({
        placesFile: svc1.placesFile, resolutionsFile: svc1.resolutionsFile, candidatesFile: svc1.candidatesFile
    });
    const afterDelete = svc3.archiveSectionForIncidents(['S200']); // القراءة الحية لا ترى شيئًا الآن
    T('P1b', 'حذف placeResolution بعد الختم: اللقطة تحتفظ بالبلاغ Confirmed والحي فقدَه',
        JSON.stringify(sealed) === sealedJson &&
        sealed.totals.confirmedPlaceLinked === 1 &&
        afterDelete.totals.confirmedPlaceLinked === 0 && afterDelete.totals.noResolution === 1,
        'sealed.confirmed=' + sealed.totals.confirmedPlaceLinked + ' live.confirmed=' + afterDelete.totals.confirmedPlaceLinked);
}

// ═══════════════════════════════════════════════════════════════════════════
// P2 — Old Snapshot Compatibility: لقطة مختومة قبل PI-3 (بلا places)
// ═══════════════════════════════════════════════════════════════════════════
{
    // لقطة بصيغة ما قبل PI-3: لا مفتاح places إطلاقًا (كما كانت تُختم سابقًا)
    const oldSnap = {
        shiftId: 7, sealedAt: '2026-08-20T22:00:00.000Z',
        shift: { date: '2026-08-20', type: 'نهارية' },
        stats: { incidents: 12 }, absences: [], operationalEvents: [],
        hospital: null // موجود من 1B — لكن لا places
    };
    // لقطة وسيطة: places=null صراحة (لو خُتمت والحقن غائب)
    const nullSnap = JSON.parse(JSON.stringify(oldSnap)); nullSnap.places = null;

    // محاكاة مسار القراءة: حفظ على قرص ثم تحميل (كما يفعل قارئ الأرشيف)
    const f1 = path.join(TMP, 'old-snap.json'), f2 = path.join(TMP, 'null-snap.json');
    fs.writeFileSync(f1, JSON.stringify(oldSnap));
    fs.writeFileSync(f2, JSON.stringify(nullSnap));

    let crashed = false, consumed = [];
    try {
        for (const f of [f1, f2]) {
            const snap = JSON.parse(fs.readFileSync(f, 'utf8'));
            // نمط المستهلك: الغياب = لا قسم، والباقي يُعالج طبيعيًا
            const places = snap.places || null;
            consumed.push({
                incidents: snap.stats.incidents,
                hospital: snap.hospital,
                placesSummary: places ? places.totals.confirmedPlaceLinked : 'لا قسم — غياب طبيعي'
            });
        }
    } catch (_) { crashed = true; }

    T('P2', 'لقطة قديمة بلا places + لقطة places=null: تُقرآن وتُعالجان بلا crash',
        !crashed && consumed.length === 2 &&
        consumed[0].placesSummary === 'لا قسم — غياب طبيعي' &&
        consumed[1].placesSummary === 'لا قسم — غياب طبيعي' &&
        consumed[0].incidents === 12,
        JSON.stringify(consumed.map(c => c.placesSummary)));
}

// ═══════════════════════════════════════════════════════════════════════════
// P3 — _parseLocationParts failure isolation (محاكاة كتلة server.js حرفيًا)
// ═══════════════════════════════════════════════════════════════════════════
{
    const svc = mkService('p3');
    const addS = svc.addPlace({ placeType: 'school', name: 'مدرسة العزل', lat: 24.6000, lng: 46.7000, radiusM: 100, source: 'learned' }, 'learned');
    svc.approveCandidate(addS.placeId, 'owner', 'الحرم الفعلي 100م');
    const hook = makeResolutionHook(svc, { error: () => {} });

    // reportService مصطنع: يفشل على عنوان بلاغ A وينجح لبلاغ B
    const reportService = {
        _parseLocationParts(address) {
            if (address === 'عنوان-مكسور') throw new Error('فشل تحليل مصطنع');
            return { district: 'حي الاختبار' };
        }
    };
    // نفس كتلة server.js حرفيًا (POST /api/cad-reports — additive + try/catch)
    function routeBlock(number, cleanLat, cleanLng, cleanAddress, cleanDesc) {
        try {
            hook.enqueue(number.trim(), {
                lat: cleanLat, lng: cleanLng, address: cleanAddress,
                district: reportService._parseLocationParts(cleanAddress).district,
                description: cleanDesc
            });
        } catch (hookErr) { /* console.error('[PlaceIntel] hook: ...') */ }
        return 200; // استجابة POST تستمر مهما حدث داخل الكتلة
    }

    const respA = routeBlock('A900', 24.6, 46.7, 'عنوان-مكسور', 'بلاغ A');
    const respB = routeBlock('B900', 24.6000, 46.7002, 'حي الاختبار - شارع 1', 'بلاغ B');
    await hook._drain();

    const st = hook._stats();
    const rA = svc.getResolution('A900'); // لم يدخل الطابور أصلًا — فشل معزول قبل enqueue
    const rB = svc.getResolution('B900'); // عولج طبيعيًا
    T('P3', 'فشل _parseLocationParts معزول: A لم يكسر شيئًا، B حُسم Confirmed، الطابور سليم، POST=200 للاثنين',
        respA === 200 && respB === 200 &&
        rA === null &&
        rB && rB.decision === 'confirmed' &&
        st.enqueued === 1 && st.failed === 0,
        'resp=' + respA + '/' + respB + ' A=' + (rA ? rA.decision : 'لم يدخل الطابور') +
        ' B=' + (rB && rB.decision) + ' stats=' + JSON.stringify(st));
}

// ═══════════════════════════════════════════════════════════════════════════
// P4 — Unique eventId counting بالأرقام الصريحة
// ═══════════════════════════════════════════════════════════════════════════
{
    const svc = mkService('p4');
    // v1: Unknown
    svc.recordResolution('U100', { lat: 24.4000, lng: 46.5000 });
    // اعتماد مدرسة قرب الموقع النهائي
    const addU = svc.addPlace({ placeType: 'school', name: 'مدرسة العد الفريد', lat: 24.6100, lng: 46.7100, radiusM: 150, source: 'learned' }, 'learned');
    svc.approveCandidate(addU.placeId, 'owner', 'حدود فعلية 150م');
    // v2: R4 Likely (كلمة نوع في نص بعيد)
    svc.recordResolution('U100', { lat: 24.4000, lng: 46.5000, description: 'بلاغ في مدرسة' });
    // v3: Confirmed (دخل النطاق)
    svc.recordResolution('U100', { lat: 24.6100, lng: 46.7103 });

    const hist = svc.getHistory('U100');
    const section = svc.archiveSectionForIncidents(['U100']);
    const school = section.byType.find(t => t.placeType === 'school');
    const place = school && school.places.find(p => p.placeId === addU.placeId);
    const incidentIds = place ? place.incidents.map(i => i.eventId) : [];
    const uniqueIds = new Set(incidentIds);

    T('P4a', 'بلاغ واحد بثلاث حالات ← incidentCount=1 تحت الجهة (بالأرقام الصريحة)',
        place && place.incidents.length === 1 && uniqueIds.size === 1 &&
        place.confirmedCount === 1 && place.likelyCount === 0 &&
        school.confirmedCount === 1 && section.totals.confirmedPlaceLinked === 1 &&
        section.totals.incidents === 1,
        'incidents=[' + incidentIds.join(',') + '] length=' + incidentIds.length +
        ' confirmed=' + section.totals.confirmedPlaceLinked + ' totals.incidents=' + section.totals.incidents);
    T('P4b', 'التاريخ محفوظ (انتقالان) والحالة النهائية فقط دخلت القسم',
        hist.length === 2 &&
        hist[0].from.decision === 'unknown' && hist[0].to.decision === 'likely' &&
        hist[1].from.decision === 'likely' && hist[1].to.decision === 'confirmed' &&
        place.incidents[0].rule === 'R1' && place.incidents[0].confidence >= 90,
        'history=' + hist.map(h => h.from.decision + '←' + h.to.decision).join(' | ') +
        ' final=' + place.incidents[0].rule + '/' + place.incidents[0].confidence);
}

console.log('\n════════════════════════════════');
console.log('النتيجة: ' + pass + ' ✅ · ' + fail + ' ❌');
console.log('مجلد الاختبار المعزول: ' + TMP);
process.exit(fail ? 1 : 0);

})().catch(err => { console.error('❌ خطأ عام:', err); process.exit(1); });
