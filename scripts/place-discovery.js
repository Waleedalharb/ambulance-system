/**
 * place-discovery.js — اكتشاف مرشحي المواقع من البلاغات التاريخية (PI-2)
 * اعتماد المالك 2026-08-29 — قراءة فقط على القاعدة، محلي فقط بلا Commit.
 * ═══════════════════════════════════════════════════════════════════════════
 * الحواجز الثلاثة المعتمدة من المالك (مثبتة هنا حرفيًا):
 *  ① الـ500م نطاق اكتشاف/Clustering فقط — ليس دليل وحدة الموقع. الناتج
 *    «Candidate Cluster مبدئي» لا «مكان قطعًا»؛ ولا دمج بالقوة لمنشآت
 *    متباعدة تحمل نفس الاسم.
 *  ② التجمع المكاني الخالص بلا اسم: placeTypeGuess=null دائمًا — لا يخترع
 *    «مدرسة» مهما كان عدد البلاغات.
 *  ③ proposedRadiusM اقتراح تحليلي فقط (spreadM+30م، حد 50–300م) — ممنوع
 *    نسخه إلى radiusM أو استخدامه لاعتماد Active؛ القيمة النهائية من قرار
 *    بشري موثق بـ radiusJustification عبر places-review.js فقط.
 *
 * المخرجات: data/place-candidates.json فقط — ممنوع الكتابة في places.json.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { PlaceIntelligenceService, TYPE_KEYWORDS, normalizeArabic } = require('../services/place-intelligence-service');
const { haversineMeters } = require('../services/duplicate-detection');

const ROOT = path.join(__dirname, '..');
const NAME_CLUSTER_M = 500;   // نطاق اكتشاف فقط — حاجز ①
const GEO_CELL = 0.00135;     // خلية ≈150م
const GEO_MIN = 3;            // عتبة التجمع المكاني الخالص
const NAME_MIN = 2;           // عتبة تجمع الاسم

// كلمات إيقاف تُنهي التقاط الاسم (علامات مكانية/إدارية لا تدخل في الاسم)
const STOP_WORDS = new Set(['بحي', 'حي', 'طريق', 'شارع', 'مخرج', 'تقاطع', 'امام', 'خلف',
    'بجانب', 'قرب', 'عند', 'مقابل', 'داخل', 'بالقرب', 'الرياض', 'السعوديه', 'جده', 'الدمام',
    'المنطقه', 'منطقه', 'رمز', 'الرمز', 'مبنى', 'رقم']);

/**
 * استخراج «اسم جهة» من نص حر: كلمة نوع + حتى كلمتين تاليتين (اسم مركب حتى 3)،
 * يقف عند أول كلمة إيقاف. بلا اسم بعد كلمة النوع ← لا استخراج (لا اختراع).
 * @returns [{placeType, nameGuess(normalized), raw}]
 */
function extractPlaceNames(text) {
    const norm = normalizeArabic(text);
    if (!norm) return [];
    const out = [];
    for (const group of TYPE_KEYWORDS) {
        for (const w of group.words) {
            const wn = normalizeArabic(w);
            const re = new RegExp('(?:^|[^\\p{L}\\p{N}])(' + wn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                '(?:\\s+[\\p{L}\\p{N}]+){0,2})', 'gu');
            let m;
            while ((m = re.exec(norm)) !== null) {
                const tokens = m[1].split(' ');
                const kept = [];
                for (const t of tokens) {
                    if (kept.length > 0 && STOP_WORDS.has(t)) break; // الاسم انتهى
                    kept.push(t);
                }
                if (kept.length < 2) continue; // كلمة النوع وحدها ≠ اسم جهة
                const nameGuess = kept.join(' ');
                if (!out.some(x => x.nameGuess === nameGuess)) {
                    out.push({ placeType: group.placeType, nameGuess });
                }
            }
        }
    }
    return out;
}

/** تجميع اتحادي (union-find) بسيط للنقاط المتقاربة ضمن thresholdM */
function clusterByProximity(items, thresholdM) {
    const parent = items.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const union = (a, b) => { parent[find(a)] = find(b); };
    for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++) {
            const a = items[i], b = items[j];
            if (a.lat === null || b.lat === null) continue;
            if (haversineMeters(a.lat, a.lng, b.lat, b.lng) <= thresholdM) union(i, j);
        }
    const groups = {};
    items.forEach((it, i) => { const r = find(i); (groups[r] = groups[r] || []).push(it); });
    return Object.values(groups);
}

/**
 * اكتشاف المرشحين من قائمة بلاغات.
 * @param incidents [{number,address,district,description,lat,lng,cad_created_at}]
 * @param svc PlaceIntelligenceService (لاستبعاد المحسومين Confirmed)
 * @returns {candidates[], stats}
 */
function discover(incidents, svc) {
    // استبعاد المحسومين مؤكدًا بمواقع active — الاكتشاف لما لم يُحسم
    const unresolved = incidents.map(inc => ({ inc, res: svc.resolve(inc) }))
        .filter(x => x.res.decision !== 'confirmed');

    // ── المسار أ: تجمعات الاسم (اسم مستخرج + تقارب 500م اكتشافي فقط) ──
    const byName = {};
    for (const { inc } of unresolved) {
        const text = [inc.address, inc.description].filter(Boolean).join('\n');
        for (const hit of extractPlaceNames(text)) {
            const key = hit.placeType + '|' + hit.nameGuess;
            (byName[key] = byName[key] || []).push(Object.assign({ _name: hit.nameGuess, _type: hit.placeType }, inc));
        }
    }
    const nameCandidates = [];
    const namedIds = new Set(); // كل بلاغ دخل تجمعًا اسميًا — يُستبعد من التجمع الخالص (لا ازدواج)
    for (const items of Object.values(byName)) {
        // نفس الاسم على بعد كيلومترات ← مرشحان منفصلان (لا دمج بالقوة — حاجز ①)
        for (const cluster of clusterByProximity(items, NAME_CLUSTER_M)) {
            if (cluster.length < NAME_MIN) continue;
            cluster.forEach(i => namedIds.add(i.number));
            nameCandidates.push(buildCandidate(cluster, cluster[0]._name, cluster[0]._type, 'name'));
        }
    }

    // ── المسار ب: تجمع مكاني خالص بلا اسم — placeTypeGuess=null دائمًا (حاجز ②) ──
    const cells = {};
    for (const { inc } of unresolved) {
        if (inc.lat === null || inc.lng === null) continue;
        if (namedIds.has(inc.number)) continue; // له تجمع اسمي أصلًا — لا مرشح مزدوج
        const key = Math.round(inc.lat / GEO_CELL) + ':' + Math.round(inc.lng / GEO_CELL);
        (cells[key] = cells[key] || []).push(inc);
    }
    const geoCandidates = [];
    for (const items of Object.values(cells)) {
        if (items.length < GEO_MIN) continue;
        geoCandidates.push(buildCandidate(items, null, null, 'geo'));
    }

    return { candidates: nameCandidates.concat(geoCandidates), unresolvedCount: unresolved.length };
}

function buildCandidate(items, nameGuess, placeTypeGuess, via) {
    const withCoords = items.filter(i => i.lat !== null && i.lng !== null);
    const clat = withCoords.length ? withCoords.reduce((s, i) => s + i.lat, 0) / withCoords.length : null;
    const clng = withCoords.length ? withCoords.reduce((s, i) => s + i.lng, 0) / withCoords.length : null;
    let spreadM = 0;
    if (clat !== null) for (const i of withCoords) {
        spreadM = Math.max(spreadM, haversineMeters(clat, clng, i.lat, i.lng));
    }
    // حاجز ③: اقتراح تحليلي فقط — لا يصبح radiusM إلا بقرار بشري موثق
    const proposedRadiusM = withCoords.length
        ? Math.max(50, Math.min(300, Math.round(spreadM + 30))) : null;
    const times = items.map(i => i.cad_created_at).filter(Boolean).sort();
    return {
        nameGuess, placeTypeGuess, via,
        lat: clat !== null ? +clat.toFixed(6) : null,
        lng: clng !== null ? +clng.toFixed(6) : null,
        spreadM: Math.round(spreadM),
        proposedRadiusM,
        incidentCount: items.length,
        sampleIncidents: items.slice(0, 5).map(i => i.number),
        districts: [...new Set(items.map(i => i.district).filter(Boolean))],
        firstSeen: times[0] || null, lastSeen: times[times.length - 1] || null,
        evidence: [via === 'name'
            ? 'تجمع اسمي اكتشافي: «' + nameGuess + '» تكرر في ' + items.length + ' بلاغًا ضمن نطاق اكتشاف ' + NAME_CLUSTER_M + 'م — نطاق الاكتشاف ليس دليل وحدة الموقع'
            : 'تجمع مكاني خالص: ' + items.length + ' بلاغًا في خلية ~150م بلا اسم جهة — placeTypeGuess=null (لا استنتاج نوع من التكرار)',
            'proposedRadiusM=' + proposedRadiusM + 'م اقتراح تحليلي فقط (spread ' + Math.round(spreadM) + 'م + 30م) — القيمة المعتمدة من قرار بشري موثق فقط']
    };
}

/** حفظ المرشحين في data/place-candidates.json مع إلغاء التكرار — لا يمس places.json */
function persistCandidates(svc, candidates) {
    const existing = svc.listCandidates();
    const keys = new Set(existing.map(c => (c.nameGuess || c.cellKey || '') + '|' + (c.placeTypeGuess || '')));
    let added = 0;
    for (const c of candidates) {
        const key = (c.nameGuess || (c.lat + ',' + c.lng)) + '|' + (c.placeTypeGuess || '');
        if (keys.has(key)) continue;
        keys.add(key);
        svc.addCandidate(c, 'learned');
        added++;
    }
    return added;
}

function main() {
    const db = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    const rows = db.prepare(`SELECT number, address, district, description, lat, lng, cad_created_at
        FROM incident_registry ORDER BY cad_created_at DESC`).all();

    const svc = new PlaceIntelligenceService({
        placesFile: path.join(ROOT, 'data', 'places.json'),          // قراءة فقط
        resolutionsFile: path.join(os.tmpdir(), 'pi2-discovery-res.json'),
        candidatesFile: path.join(ROOT, 'data', 'place-candidates.json')
    });

    const { candidates, unresolvedCount } = discover(rows, svc);
    const added = persistCandidates(svc, candidates);

    console.log('═══ اكتشاف المرشحين PI-2 (قراءة فقط) ═══\n');
    console.log('البلاغات: ' + rows.length + ' · غير المحسومة: ' + unresolvedCount);
    console.log('مرشحون مكتشفون هذه الجولة: ' + candidates.length + ' · جدد أُضيفوا: ' + added + ' · إجمالي متراكم: ' + svc.listCandidates().length);
    const byType = {};
    for (const c of candidates) byType[c.placeTypeGuess || 'null'] = (byType[c.placeTypeGuess || 'null'] || 0) + 1;
    console.log('حسب النوع المقترح: ' + JSON.stringify(byType));
    for (const c of candidates) {
        console.log('\n· ' + (c.nameGuess || '(بلا اسم)') + ' [' + (c.placeTypeGuess || 'null') + '] — ' + c.incidentCount + ' بلاغًا · spread=' + c.spreadM + 'م · مقترح=' + c.proposedRadiusM + 'م');
        console.log('  أحياء: ' + (c.districts.join('، ') || '—') + ' · عينات: ' + c.sampleIncidents.join(', '));
        c.evidence.forEach(e => console.log('  دليل: ' + e));
    }
}

if (require.main === module) main();
module.exports = { extractPlaceNames, clusterByProximity, discover, buildCandidate, persistCandidates, NAME_CLUSTER_M, GEO_CELL, GEO_MIN, NAME_MIN, STOP_WORDS };
