/**
 * place-discovery-test.js — PI-2 Golden Test Set (11 حالة) + دورة المراجعة
 * (اعتماد المالك 2026-08-29 — محلي فقط بلا Commit)
 * الحواجز الثلاثة المعتمدة مختبَرة صراحة: ① الـ500م اكتشاف فقط ·
 * ② التجمع الخالص placeTypeGuess=null · ③ proposedRadiusM لا يصبح radiusM آليًا.
 * كل التخزين في مجلد مؤقت معزول — لا كتابة على بيانات حقيقية.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaceIntelligenceService } = require('../services/place-intelligence-service');
const D = require('./place-discovery');
const R = require('./places-review');

let pass = 0, fail = 0;
function T(id, name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { fail++; console.log('❌ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi2-test-'));
function mkService() {
    const dir = fs.mkdtempSync(path.join(TMP, 'svc-'));
    return new PlaceIntelligenceService({
        placesFile: path.join(dir, 'places.json'),
        resolutionsFile: path.join(dir, 'place-resolutions.json'),
        candidatesFile: path.join(dir, 'place-candidates.json')
    });
}
const inc = (number, over) => Object.assign({ number, address: null, district: null, description: null, lat: null, lng: null, cad_created_at: '2026-08-20T10:00:00Z' }, over);

console.log('═══ PI-2 Golden Test Set ═══\n');

// ① استخراج اسم مركب يقف عند كلمة إيقاف
{
    const hits = D.extractPlaceNames('حالة إغماء في مدرسة النور الابتدائية بحي الشفا، الرياض');
    T('P1', 'استخراج «مدرسة النور الابتدائية» والوقوف عند «بحي»',
        hits.length === 1 && hits[0].placeType === 'school' && hits[0].nameGuess === 'مدرسه النور الابتدائيه',
        JSON.stringify(hits));
}

// ② التطبيع يوحّد الاسم (مدرسه/مدرسة، همزات)
{
    const svc = mkService();
    const { candidates } = D.discover([
        inc('N1', { address: 'بلاغ عند مدرسة النور', lat: 24.6100, lng: 46.7100 }),
        inc('N2', { address: 'حالة في مدرسه النور', lat: 24.6101, lng: 46.7101 })
    ], svc);
    T('P2', '«مدرسة النور» + «مدرسه النور» = مرشح واحد',
        candidates.length === 1 && candidates[0].incidentCount === 2,
        'candidates=' + candidates.length);
}

// ③ فخ substring: خطأ إملائي لا يطابق كلمة النوع (حدود الكلمة)
{
    T('P3', '«المستشفي» لا يطابق «مستشفى» (حدود الكلمة)',
        D.extractPlaceNames('الحالة في المستشفي الكبير').length === 0);
}

// ④ نفس الاسم × 3 بلاغات ضمن 100م ← مرشح واحد
{
    const svc = mkService();
    const { candidates } = D.discover([
        inc('C1', { address: 'مدرسة الفجر', lat: 24.6000, lng: 46.7000 }),
        inc('C2', { address: 'مدرسة الفجر', lat: 24.6003, lng: 46.7002 }),
        inc('C3', { address: 'مدرسة الفجر', lat: 24.6002, lng: 46.7004 })
    ], svc);
    T('P4', 'نفس الاسم ضمن 100م × 3 ← مرشح واحد', candidates.length === 1 && candidates[0].incidentCount === 3,
        'count=' + (candidates[0] || {}).incidentCount);
}

// ⑤ نفس الاسم على بعد 5كم ← مرشحان منفصلان (حاجز ① — لا دمج بالقوة)
{
    const svc = mkService();
    const { candidates } = D.discover([
        inc('F1', { address: 'مسجد الفرقان', lat: 24.6000, lng: 46.7000 }),
        inc('F2', { address: 'مسجد الفرقان', lat: 24.6001, lng: 46.7001 }),
        inc('F3', { address: 'مسجد الفرقان', lat: 24.5600, lng: 46.6500 }),
        inc('F4', { address: 'مسجد الفرقان', lat: 24.5601, lng: 46.6501 })
    ], svc);
    T('P5', 'نفس الاسم على بعد ~5.7كم ← مرشحان (الـ500م اكتشاف فقط، لا دليل وحدة)',
        candidates.length === 2 && candidates.every(c => c.incidentCount === 2),
        'candidates=' + candidates.length);
}

// ⑥ تجمع مكاني خالص ≥3 بلا اسم ← placeTypeGuess=null دائمًا (حاجز ②)
{
    const svc = mkService();
    const { candidates } = D.discover([
        inc('G1', { lat: 24.5000, lng: 46.6000 }),
        inc('G2', { lat: 24.5001, lng: 46.6001 }),
        inc('G3', { lat: 24.5002, lng: 46.6000 }),
        inc('G4', { lat: 24.5001, lng: 46.6002 })
    ], svc);
    T('P6', 'تجمع خالص × 4 بلا اسم ← مرشح placeTypeGuess=null (لا يخترع مدرسة)',
        candidates.length === 1 && candidates[0].placeTypeGuess === null && candidates[0].nameGuess === null,
        JSON.stringify(candidates[0] && { t: candidates[0].placeTypeGuess, n: candidates[0].nameGuess }));
}

// ⑦ apply يرفض اعتمادًا بلا radiusJustification (حاجز ③)
{
    const svc = mkService();
    const cId = svc.addCandidate({ nameGuess: 'مدرسة الاختبار', placeTypeGuess: 'school', lat: 24.6, lng: 46.7, incidentCount: 3, proposedRadiusM: 78, spreadM: 48 }, 'learned');
    const rep = R.apply(svc, writeApprovals([{ candidateId: cId, approved: true, radiusM: 78, reviewer: 'owner' }]));
    T('P7', 'اعتماد بلا radiusJustification ← مرفوض', rep.results[0].applied === false && /radiusJustification/.test(rep.results[0].why),
        rep.results[0].why);
    const reg = svc.listPlaces();
    T('P7b', 'والسجل لم يدخله شيء', reg.length === 0);
}

// ⑧ apply يعتمد مرشحًا مكتملًا ← active + placesVersion يرتفع + evidence موثقة
{
    const svc = mkService();
    const v0 = svc._loadRegistry().placesVersion;
    const cId = svc.addCandidate({ nameGuess: 'مدرسة الاختبار', placeTypeGuess: 'school', lat: 24.6, lng: 46.7, incidentCount: 3, proposedRadiusM: 78, spreadM: 48 }, 'learned');
    const rep = R.apply(svc, writeApprovals([{
        candidateId: cId, approved: true, name: 'مدرسة الاختبار المعتمدة', placeType: 'school',
        lat: 24.6, lng: 46.7, radiusM: 62, radiusJustification: 'حدود سور المدرسة الفعلية', reviewer: 'owner'
    }]));
    const r0 = rep.results[0];
    const place = svc.listPlaces({ status: 'active' })[0];
    const justInEvidence = place && place.evidence.some(e => /حدود سور المدرسة/.test(e.note));
    T('P8', 'اعتماد مكتمل ← active + placesVersion+1 + المبرر في evidence',
        r0.applied && r0.outcome === 'adopted' && r0.radiusM === 62 && r0.placesVersion === v0 + 1 && justInEvidence,
        'radiusM=' + r0.radiusM + ' v=' + r0.placesVersion);
    T('P8b', 'حاجز ③: radiusM=62 قرارًا بشريًا وليس المقترح 78 — لم يُنسخ آليًا',
        place && place.radiusM === 62 && place.radiusM !== 78);
}

// ⑨ المرشح المرفوض لا يدخل السجل ويُوسم rejected
{
    const svc = mkService();
    const cId = svc.addCandidate({ nameGuess: 'مول وهمي', placeTypeGuess: 'mall', lat: 24.5, lng: 46.6, incidentCount: 2 }, 'learned');
    const rep = R.apply(svc, writeApprovals([{ candidateId: cId, approved: false, reviewer: 'owner', reason: 'ليس جهة — تقاطع طرق' }]));
    const cand = svc.listCandidates().find(c => c.id === cId);
    T('P9', 'المرفوض يُوسم rejected ولا يدخل السجل نهائيًا',
        rep.results[0].applied && rep.results[0].outcome === 'rejected' && cand.status === 'rejected' && svc.listPlaces().length === 0);
}

// ⑩ لا يتحول أي مرشح إلى active بدون apply
{
    const svc = mkService();
    const { candidates } = D.discover([
        inc('X1', { address: 'مدرسة السلام', lat: 24.61, lng: 46.71 }),
        inc('X2', { address: 'مدرسة السلام', lat: 24.6101, lng: 46.7101 })
    ], svc);
    D.persistCandidates(svc, candidates);
    const resolved = svc.resolve({ lat: 24.61, lng: 46.71 });
    T('P10', 'الاكتشاف لا يفعّل شيئًا: candidate محفوظ لكن المطابقة R5',
        svc.listCandidates().length === 1 && svc.listPlaces().length === 0 && resolved.rule === 'R5',
        'rule=' + resolved.rule + ' places=' + svc.listPlaces().length);
}

// ⑪ بعد الاعتماد بـ radiusM=62: داخل النطاق ← R1 Confirmed · خارجه بـ20م ← لا Confirmed
{
    const svc = mkService();
    const cId = svc.addCandidate({ nameGuess: 'مدرسة الحدود', placeTypeGuess: 'school', lat: 24.6000, lng: 46.7000, incidentCount: 3 }, 'learned');
    R.apply(svc, writeApprovals([{
        candidateId: cId, approved: true, name: 'مدرسة الحدود', placeType: 'school',
        lat: 24.6000, lng: 46.7000, radiusM: 62, radiusJustification: 'الحرم الفعلي 62م', reviewer: 'owner'
    }]));
    // 50م داخل النطاق (0.00054° lng ≈ 54م → داخل 62م) — نستخدم 0.0004° ≈ 43م
    const inside = svc.resolve({ lat: 24.6000, lng: 46.7004 });
    // خارج النطاق بـ~20م: 0.00075° ≈ 82م > 62م
    const outside = svc.resolve({ lat: 24.6000, lng: 46.70075 });
    T('P11', 'داخل radiusM المعتمد ← R1 Confirmed · خارجه بـ20م ← لا Confirmed',
        inside.rule === 'R1' && inside.decision === 'confirmed' && outside.rule !== 'R1' && outside.decision !== 'confirmed',
        'inside=' + inside.rule + '/' + inside.confidence + ' · outside=' + outside.rule + '/' + outside.decision);
}

function writeApprovals(decisions) {
    const f = path.join(TMP, 'approvals-' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(f, JSON.stringify({ decisions }));
    return f;
}

console.log('\n════════════════════════════════');
console.log('النتيجة: ' + pass + ' ✅ · ' + fail + ' ❌');
console.log('مجلد الاختبار المعزول: ' + TMP);
process.exit(fail ? 1 : 0);
