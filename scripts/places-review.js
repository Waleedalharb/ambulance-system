/**
 * places-review.js — آلية المراجعة البشرية للمرشحين (PI-2، بلا واجهة)
 * اعتماد المالك 2026-08-29 — محلي فقط بلا Commit.
 * ═══════════════════════════════════════════════════════════════════════════
 * الاستخدام:
 *   node scripts/places-review.js list     — طباعة المرشحين جدولًا
 *   node scripts/places-review.js apply    — تطبيق data/place-approvals.json
 *
 * ملف القرارات البشرية data/place-approvals.json:
 *   { "decisions": [
 *     { "candidateId": "cand_...", "approved": true,
 *       "name": "مدرسة النور الابتدائية", "placeType": "school",
 *       "lat": 24.61, "lng": 46.71, "radiusM": 62,
 *       "radiusJustification": "حدود سور المدرسة الفعلية",
 *       "reviewer": "وليد" },
 *     { "candidateId": "cand_...", "approved": false, "reviewer": "وليد",
 *       "reason": "ليس جهة — تقاطع طرق" }
 *   ]}
 *
 * شروط الاعتماد الإلزامية (apply يرفض بدونها):
 *   ① radiusM رقم موجب   ② radiusJustification نص غير فارغ
 * «radiusM تمثيل تشغيلي لنطاق الجهة المعتمد — لا مسافة سماح.»
 * المرفوض يُوسم rejected ولا يدخل السجل نهائيًا. لا مسار آخر ينشئ active.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PlaceIntelligenceService } = require('../services/place-intelligence-service');

const ROOT = path.join(__dirname, '..');
const APPROVALS_FILE = path.join(ROOT, 'data', 'place-approvals.json');

function mkService(over = {}) {
    return new PlaceIntelligenceService(Object.assign({
        placesFile: path.join(ROOT, 'data', 'places.json'),
        resolutionsFile: path.join(ROOT, 'data', 'place-resolutions.json'),
        candidatesFile: path.join(ROOT, 'data', 'place-candidates.json')
    }, over));
}

function list(svc) {
    const cands = svc.listCandidates().filter(c => c.status === 'candidate');
    console.log('═══ المرشحون بانتظار المراجعة (' + cands.length + ') ═══\n');
    for (const c of cands) {
        console.log(c.id + ' | ' + (c.nameGuess || '(بلا اسم)') + ' | ' + (c.placeTypeGuess || 'null') +
            ' | ' + c.incidentCount + ' بلاغًا | spread=' + c.spreadM + 'م | مقترح=' + c.proposedRadiusM + 'م' +
            ' | ' + (c.districts || []).join('، '));
    }
    if (!cands.length) console.log('(لا مرشحين بانتظار المراجعة)');
    return cands;
}

/**
 * تطبيق القرارات البشرية. يعيد تقريرًا تفصيليًا بكل قرار (قُبل/رُفض/فشل ولماذا).
 * لا يكتب شيئًا خارج places.json / place-candidates.json.
 */
function apply(svc, approvalsPath = APPROVALS_FILE) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(approvalsPath, 'utf8')); }
    catch (_) { return { ok: false, reason: 'approvals-file-missing-or-invalid', results: [] }; }
    const decisions = Array.isArray(doc.decisions) ? doc.decisions : [];
    const results = [];

    for (const d of decisions) {
        const cand = svc.listCandidates().find(c => c.id === d.candidateId);
        if (!cand) { results.push({ candidateId: d.candidateId, applied: false, why: 'مرشح غير موجود' }); continue; }
        if (cand.status !== 'candidate') { results.push({ candidateId: d.candidateId, applied: false, why: 'سبقت مراجعته (' + cand.status + ')' }); continue; }

        if (d.approved !== true) {
            svc.setCandidateStatus(d.candidateId, 'rejected', d.reviewer, d.reason || '');
            results.push({ candidateId: d.candidateId, applied: true, outcome: 'rejected', why: d.reason || 'رفض بشري — لا يدخل السجل نهائيًا' });
            continue;
        }

        // ── شروط الاعتماد الإلزامية — «radiusM ليس مسافة سماح» ──
        if (typeof d.radiusM !== 'number' || !isFinite(d.radiusM) || d.radiusM <= 0) {
            results.push({ candidateId: d.candidateId, applied: false, why: 'radiusM غير موجود/غير صالح — الاعتماد مرفوض' }); continue;
        }
        if (!d.radiusJustification || typeof d.radiusJustification !== 'string' || !d.radiusJustification.trim()) {
            results.push({ candidateId: d.candidateId, applied: false, why: 'radiusJustification مفقود — ممنوع الاعتماد بلا مبرر موثق للنطاق' }); continue;
        }

        // اعتماد: إدخال السجل (يُفرض candidate) ثم المسار الحصري approveCandidate
        const add = svc.addPlace({
            placeType: d.placeType || cand.placeTypeGuess || 'other',
            name: d.name || cand.nameGuess || null,
            nameVariants: [d.name || cand.nameGuess].filter(Boolean),
            lat: typeof d.lat === 'number' ? d.lat : cand.lat,
            lng: typeof d.lng === 'number' ? d.lng : cand.lng,
            radiusM: d.radiusM,
            district: (cand.districts || [])[0] || null,
            source: 'manual',
            note: 'اعتماد مرشح مكتشف ' + d.candidateId + ' عبر places-review'
        }, d.reviewer || 'reviewer');
        if (!add.ok) { results.push({ candidateId: d.candidateId, applied: false, why: 'فشل الإدخال: ' + add.reason }); continue; }

        // تنقيح بشري بالقيم النهائية قبل التفعيل (إن وُجدت اختلافات)
        svc.reviseCandidate(add.placeId, {
            name: d.name || cand.nameGuess,
            placeType: d.placeType || cand.placeTypeGuess || 'other',
            lat: typeof d.lat === 'number' ? d.lat : cand.lat,
            lng: typeof d.lng === 'number' ? d.lng : cand.lng,
            radiusM: d.radiusM
        }, d.reviewer);

        const ap = svc.approveCandidate(add.placeId, d.reviewer, d.radiusJustification.trim());
        if (!ap.ok) { results.push({ candidateId: d.candidateId, applied: false, why: 'فشل التفعيل: ' + ap.reason }); continue; }

        svc.setCandidateStatus(d.candidateId, 'adopted', d.reviewer, 'اعتُمد كـ ' + add.placeId + ' · radiusM=' + d.radiusM + ' (' + d.radiusJustification.trim() + ')');
        results.push({
            candidateId: d.candidateId, applied: true, outcome: 'adopted',
            placeId: add.placeId, radiusM: d.radiusM,
            proposedRadiusM: cand.proposedRadiusM, // يُطبع للمقارنة فقط — لم يُنسخ آليًا
            radiusJustification: d.radiusJustification.trim(),
            placesVersion: ap.placesVersion
        });
    }
    return { ok: true, results };
}

function printApplyReport(rep) {
    console.log('═══ تطبيق قرارات المراجعة ═══\n');
    if (!rep.ok) { console.log('❌ ' + rep.reason); return; }
    for (const r of rep.results) {
        if (!r.applied) console.log('❌ ' + r.candidateId + ' — ' + r.why);
        else if (r.outcome === 'rejected') console.log('🚫 ' + r.candidateId + ' — رُفض: ' + r.why);
        else console.log('✅ ' + r.candidateId + ' — اعتُمد ' + r.placeId + ' · radiusM=' + r.radiusM + 'م (المقترح كان ' + r.proposedRadiusM + 'م) · placesVersion=' + r.placesVersion + '\n   المبرر: ' + r.radiusJustification);
    }
}

function main() {
    const cmd = process.argv[2] || 'list';
    const svc = mkService();
    if (cmd === 'list') list(svc);
    else if (cmd === 'apply') printApplyReport(apply(svc));
    else console.log('أمر غير معروف: ' + cmd + ' — استخدم list | apply');
}

if (require.main === module) main();
module.exports = { list, apply, printApplyReport, APPROVALS_FILE };
