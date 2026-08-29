/**
 * place-intelligence-historical-run.js — تشغيل PI-1 على البيانات التاريخية
 * (اعتماد المالك 2026-08-29 — قراءة وتحليل فقط، بلا أي كتابة على القاعدة)
 * ═══════════════════════════════════════════════════════════════════════════
 *  ① يفتح data/ambulance.db للقراءة فقط ويحسم كل بلاغ بإحداثيات.
 *  ② يخرج التوزيع: X مرشحًا / Y Confirmed / Z Likely / N Unknown + أمثلة أدلة.
 *  ③ يكتشف مرشحين (candidate) من تجميع مكاني للبلاغات غير المحسومة:
 *     خلية ~150م فيها ≥3 بلاغات + دليل نوع نصي متكرر → candidate بملف منفصل
 *     data/place-candidates.json — لا يدخل السجل ولا يصبح active أبدًا.
 *  النتائج لا تُخزَّن في المخزن الحي — تحليل معزول بملف مؤقت.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { PlaceIntelligenceService } = require('../services/place-intelligence-service');

const ROOT = path.join(__dirname, '..');
const db = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });

const rows = db.prepare(`
    SELECT number, address, district, description, lat, lng, cad_created_at
    FROM incident_registry
    WHERE lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY cad_created_at DESC
`).all();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi1-hist-'));
const svc = new PlaceIntelligenceService({
    placesFile: path.join(ROOT, 'data', 'places.json'),     // السجل الحقيقي (قراءة)
    resolutionsFile: path.join(TMP, 'resolutions.json'),    // نتائج التحليل — مؤقتة
    candidatesFile: path.join(TMP, 'candidates.json')
});

const tally = { confirmed: 0, likely: 0, unknown: 0, byRule: {}, byType: {} };
const examples = { confirmed: [], likely: [], unknown: [] };
const resolved = [];

for (const r of rows) {
    const res = svc.resolve(r);
    res.eventId = r.number;
    resolved.push({ inc: r, res });
    tally[res.decision]++;
    tally.byRule[res.rule] = (tally.byRule[res.rule] || 0) + 1;
    if (res.placeType) tally.byType[res.placeType] = (tally.byType[res.placeType] || 0) + 1;
    const bucket = examples[res.decision];
    if (bucket.length < 3) {
        bucket.push({
            eventId: r.number, rule: res.rule, confidence: res.confidence,
            placeType: res.placeType, placeName: res.placeName,
            evidence: res.evidence.map(e => e.text)
        });
    }
}

// ─── اكتشاف المرشحين: تجميع مكاني للبلاغات غير المحسومة (Unknown/R4 فقط) ───
const CELL = 0.00135; // ≈150م عرضًا عند خط عرض الرياض
const clusters = {};
for (const { inc, res } of resolved) {
    if (res.decision === 'confirmed') continue; // المحسوم لا يولّد مرشحًا
    const key = Math.round(inc.lat / CELL) + ':' + Math.round(inc.lng / CELL);
    (clusters[key] = clusters[key] || []).push({ inc, res });
}

const candSvc = new PlaceIntelligenceService({
    placesFile: path.join(TMP, 'unused-places.json'),
    resolutionsFile: path.join(TMP, 'unused-res.json'),
    candidatesFile: path.join(ROOT, 'data', 'place-candidates.json') // ملف المرشحين الحقيقي (منفصل عن السجل)
});
// لا نكرر مرشحًا موجودًا لنفس الخلية
const existingCells = new Set(candSvc.listCandidates().map(c => c.cellKey));

let newCandidates = 0;
const candidateSummary = [];
for (const [cellKey, items] of Object.entries(clusters)) {
    if (items.length < 3) continue; // عتبة التكرار: 3 بلاغات فأكثر
    // دليل نوع نصي متكرر؟ (R4 placeType يتكرر في ≥ نصف البلاغات)
    const types = {};
    for (const it of items) if (it.res.placeType) types[it.res.placeType] = (types[it.res.placeType] || 0) + 1;
    const top = Object.entries(types).sort((a, b) => b[1] - a[1])[0];
    const clat = items.reduce((s, i) => s + i.inc.lat, 0) / items.length;
    const clng = items.reduce((s, i) => s + i.inc.lng, 0) / items.length;
    const summary = {
        cellKey, incidents: items.length,
        placeTypeGuess: top && top[1] >= Math.ceil(items.length / 2) ? top[0] : null,
        lat: +clat.toFixed(6), lng: +clng.toFixed(6),
        sampleIncidents: items.slice(0, 5).map(i => i.inc.number),
        districts: [...new Set(items.map(i => i.inc.district).filter(Boolean))]
    };
    candidateSummary.push(summary);
    if (!existingCells.has(cellKey)) {
        candSvc.addCandidate({
            cellKey, lat: summary.lat, lng: summary.lng,
            placeTypeGuess: summary.placeTypeGuess,
            incidentCount: items.length,
            sampleIncidents: summary.sampleIncidents,
            districts: summary.districts,
            note: 'تجميع مكاني: ' + items.length + ' بلاغًا غير محسوم في خلية ~150م — بانتظار مراجعة بشرية'
        }, 'learned');
        newCandidates++;
    }
}

console.log('═══ نتائج التشغيل التاريخي PI-1 ═══\n');
console.log('البلاغات المحللة (بإحداثيات): ' + rows.length);
console.log('Confirmed: ' + tally.confirmed + ' · Likely: ' + tally.likely + ' · Unknown: ' + tally.unknown);
console.log('حسب القاعدة: ' + JSON.stringify(tally.byRule));
console.log('حسب النوع: ' + JSON.stringify(tally.byType));
console.log('\nمجموعات مرشحة (≥3 بلاغات/خلية): ' + candidateSummary.length + ' · مرشحون جدد أُضيفوا: ' + newCandidates + ' · إجمالي المرشحين المتراكم: ' + candSvc.listCandidates().length);

console.log('\n── أمثلة Confirmed ──');
for (const e of examples.confirmed) console.log(JSON.stringify(e, null, 1));
console.log('\n── أمثلة Likely ──');
for (const e of examples.likely) console.log(JSON.stringify(e, null, 1));
console.log('\n── أمثلة Unknown ──');
for (const e of examples.unknown) console.log(JSON.stringify(e, null, 1));
console.log('\n── ملخص المرشحين ──');
for (const c of candidateSummary) console.log(JSON.stringify(c));

// ملف نتائج التحليل الكامل (للتقرير)
fs.writeFileSync(path.join(TMP, 'historical-results.json'), JSON.stringify({ tally, examples, candidateSummary }, null, 2));
console.log('\nنتائج كاملة: ' + path.join(TMP, 'historical-results.json'));
