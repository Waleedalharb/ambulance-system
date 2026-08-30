/**
 * place-discovery-orchestrator.js — منطق قرار Discovery (PI-7)
 * اعتماد المالك 2026-08-30: الإحداثية هي الأساس؛ نص البلاغ عامل مساعد فقط.
 * decide() دالة صِرفة (بلا شبكة/ذاكرة) — المدخلات PlaceCandidate[] والبلاغ،
 * والمخرجة واحدة من: dominant / ambiguous / conflict / no-match.
 * ═══════════════════════════════════════════════════════════════════════════
 * الخطوط الحمراء: لا Confirmed من الخارج · لا كتابة في places.json ·
 * لا ارتباط باسم المزود (provider يُوثَّق كدليل فقط).
 */
'use strict';
const { haversineMeters } = require('./duplicate-detection');       // إعادة استخدام — ممنوع نسخة
const { phraseInText } = require('./place-intelligence-service');   // نفس مطابقة المحرك
const { toInternalPlaceType } = require('./place-type-map');
const { ProviderError, isValidLatLng } = require('./place-providers/provider-interface');

const NEAR_CAP_M = 150;        // حد حماية أولي قابل للضبط (اعتماد المالك §8.1)
const DOMINANT_MAX_M = 50;     // الأقرب ضمن 50م…
const DOMINANCE_RATIO = 2;     // …والثاني ≥ ضعف مسافته ← اقتراح وحيد واضح
const MAX_SUGGESTIONS = 3;

/**
 * بناء PlaceCandidate الموحّد من عنصر مزود خام + إحداثية البلاغ.
 * distanceM محلية دائمًا — لا تُقرأ من المزود.
 */
function toPlaceCandidate(raw, providerId, incidentLat, incidentLng, incidentTexts) {
    const distanceM = Math.round(haversineMeters(incidentLat, incidentLng, raw.lat, raw.lng));
    const name = raw.name;
    const matchedText = ['address', 'description'].some(f =>
        incidentTexts && incidentTexts[f] && phraseInText(name, incidentTexts[f]));
    return {
        name,
        placeType: toInternalPlaceType(providerId, raw.providerCategory),
        providerCategory: raw.providerCategory,
        lat: raw.lat, lng: raw.lng,
        distanceM,
        provider: providerId,           // دليل تدقيق فقط — لا منطق عليه
        providerRef: raw.providerRef || null,
        matchedText
    };
}

/**
 * قرار صِرف على المرشحين (§3.3 من المواصفة).
 * @param {PlaceCandidate[]} candidates  غير مفلترة — البوابة هنا
 * @returns {{ outcome, suggestions[], reason }}
 */
function decide(candidates) {
    const near = (candidates || [])
        .filter(c => c.distanceM <= NEAR_CAP_M)          // ① بوابة القرب — إلزامية
        .sort((a, b) => a.distanceM - b.distanceM);

    if (!near.length)
        return { outcome: 'no-match', suggestions: [], reason: 'لا معلم ضمن ' + NEAR_CAP_M + 'م' };

    const first = near[0], second = near[1] || null;

    // ③ تضارب: توافق نصي يشير لمرشح ليس الأقرب إحداثيًا — يوثَّق ولا يُسوّى صامتًا
    const textHit = near.find(c => c.matchedText);
    if (textHit && textHit !== first)
        return { outcome: 'conflict', suggestions: dedupe([first, textHit]).slice(0, MAX_SUGGESTIONS),
            reason: 'تضارب: الأقرب إحداثيًا «' + first.name + '» (' + first.distanceM + 'م) ≠ المطابق نصيًا «' + textHit.name + '» (' + textHit.distanceM + 'م)' };

    // ② هيمنة: أقرب ≤50م و(لا ثاني أو الثاني ≥ الضعف)
    if (first.distanceM <= DOMINANT_MAX_M && (!second || second.distanceM >= DOMINANCE_RATIO * Math.max(first.distanceM, 1)))
        return { outcome: 'dominant', suggestions: [first],
            reason: 'معلم وحيد مهيمن: «' + first.name + '» على ' + first.distanceM + 'م' };

    // ④ غموض
    return { outcome: 'ambiguous', suggestions: near.slice(0, MAX_SUGGESTIONS),
        reason: 'أكثر من معلم قريب بلا هيمنة واضحة (' + near.length + ' ضمن ' + NEAR_CAP_M + 'م)' };
}

function dedupe(list) {
    const seen = new Set(); const out = [];
    for (const c of list) { const k = c.providerRef || c.name + c.distanceM; if (!seen.has(k)) { seen.add(k); out.push(c); } }
    return out;
}

/**
 * الاستعلام الفعلي عبر المزود ثم القرار — I/O محصور هنا، decide() تبقى صِرفة.
 * @param {object} provider  PlaceProvider (أي Adapter محقق للعقد)
 * @param {object} incident  { lat, lng, address, description }
 * @returns {Promise<{outcome, suggestions, provider, fetchedAt, reason}>}
 */
async function discover(provider, incident) {
    const fetchedAt = new Date().toISOString();
    if (!provider) return { outcome: 'disabled', suggestions: [], provider: null, fetchedAt, reason: 'مزود البحث غير مفعّل' };
    if (!incident || !isValidLatLng(incident.lat, incident.lng))
        return { outcome: 'no-coords', suggestions: [], provider: provider.id, fetchedAt, reason: 'لا إحداثية صالحة' };

    let raw;
    try {
        raw = await provider.findNearbyPlaces(incident.lat, incident.lng, { radiusM: NEAR_CAP_M });
    } catch (e) {
        if (e instanceof ProviderError)
            return { outcome: e.kind === 'rate-limited' ? 'rate-limited' : (e.kind === 'disabled' ? 'disabled' : 'provider-error'),
                suggestions: [], provider: provider.id, fetchedAt, reason: e.message, errorKind: e.kind };
        return { outcome: 'provider-error', suggestions: [], provider: provider.id, fetchedAt, reason: String(e && e.message || e) };
    }

    const texts = { address: incident.address, description: incident.description };
    const candidates = raw.map(r => toPlaceCandidate(r, provider.id, incident.lat, incident.lng, texts));
    const d = decide(candidates);
    return { ...d, provider: provider.id, fetchedAt };
}

module.exports = { discover, decide, toPlaceCandidate, NEAR_CAP_M, DOMINANT_MAX_M, DOMINANCE_RATIO, MAX_SUGGESTIONS };
