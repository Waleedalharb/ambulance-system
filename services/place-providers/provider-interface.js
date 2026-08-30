/**
 * provider-interface.js — عقد Place Provider الموحّد (PI-7)
 * اعتماد المالك 2026-08-30: الحد الفاصل بين Place Identity وأي مزود.
 * الطبقات العليا لا ترى إلا هذا العقد وPlaceCandidate — ممنوع تسريب رد خام
 * أو كائن HTTP أو اسم مزود إلى منطق القرار.
 */
'use strict';

/** أخطاء مصنّفة موحدة — المصنّف يكفي للقرار، الرسالة للتدقيق */
class ProviderError extends Error {
    constructor(kind, message, provider) {
        super(message);
        this.name = 'ProviderError';
        this.kind = kind;         // 'timeout' | 'rate-limited' | 'unavailable' | 'bad-response' | 'disabled'
        this.provider = provider || 'unknown';
    }
}

const LIMITS = {
    DEFAULT_RADIUS_M: 150,        // NEAR_CAP — حد حماية أولي قابل للضبط (اعتماد المالك)
    MAX_RADIUS_M: 300,            // سقف صارم — يُرفض أعلى منه
    DEFAULT_LIMIT: 5,
    MAX_LIMIT: 10,
    TIMEOUT_MS: 1500              // مهلة إلزامية — المزود لا يملك إبطاء المنصة
};

function isValidLatLng(lat, lng) {
    return typeof lat === 'number' && isFinite(lat) && typeof lng === 'number' && isFinite(lng) &&
        lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * تحقق صرامة من عنصر خام أعاده Adapter قبل صعوده:
 * RawProviderPlace = { name, providerCategory[], lat, lng, providerRef|null }
 * العنصر غير المكتمل يُستبعد (لا يكسر الدفعة) — ويُعاد عدد المستبعد للتدقيق.
 */
function sanitizeRawPlaces(list, providerId) {
    const out = [];
    let dropped = 0;
    for (const p of (Array.isArray(list) ? list : [])) {
        if (!p || typeof p.name !== 'string' || !p.name.trim()) { dropped++; continue; }
        if (!isValidLatLng(p.lat, p.lng)) { dropped++; continue; }
        out.push({
            name: p.name.trim().slice(0, 120),
            providerCategory: Array.isArray(p.providerCategory) ? p.providerCategory.map(String).slice(0, 8) : [],
            lat: p.lat, lng: p.lng,
            providerRef: p.providerRef != null ? String(p.providerRef).slice(0, 120) : null
        });
    }
    if (dropped) console.warn('[PlaceProvider:' + providerId + '] استُبعد ' + dropped + ' عنصرًا غير مكتمل');
    return out;
}

/**
 * فحص التوافق مع العقد — يستخدمه اختبار العقد على أي Adapter حالي أو مستقبلي.
 * @returns {string[]} قائمة مخالفات (فارغة = متوافق)
 */
function contractViolations(provider) {
    const v = [];
    if (!provider || typeof provider !== 'object') return ['provider ليس كائنًا'];
    if (typeof provider.id !== 'string' || !provider.id) v.push('id مفقود');
    if (typeof provider.capabilities !== 'function') v.push('capabilities() مفقودة');
    else {
        const c = provider.capabilities();
        if (!c || typeof c.nearbySearch !== 'boolean') v.push('capabilities().nearbySearch boolean مطلوب');
        if (!c || typeof c.categoryFilter !== 'boolean') v.push('capabilities().categoryFilter boolean مطلوب');
        if (!c || typeof c.maxRadiusM !== 'number' || c.maxRadiusM <= 0) v.push('capabilities().maxRadiusM موجب مطلوب');
    }
    if (typeof provider.findNearbyPlaces !== 'function') v.push('findNearbyPlaces() مفقودة');
    return v;
}

module.exports = { ProviderError, LIMITS, isValidLatLng, sanitizeRawPlaces, contractViolations };
