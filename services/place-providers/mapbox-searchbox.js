/**
 * mapbox-searchbox.js — Adapter مزود Mapbox Search Box (PI-7 — Adapter أولي قابل للاستبدال)
 * اعتماد المالك 2026-08-30: مصدر بيانات خلف العقد فقط — لا يملك قرارًا ولا يُخزَّن
 * ناتجه الخام دائمًا (كاش مؤقت في طبقة أعلى). التوكن من MAPBOX_SEARCH_TOKEN
 * (مستقل عن توكن الرسم) — غيابه = ProviderError('disabled') صامت آمن.
 *
 * لماذا Category Search وليس Tilequery/Reverse؟ (مثبت 2026-08-30):
 *  - Geocoding v6 reverse: POI مُزالة (422 types=poi) — عناوين فقط.
 *  - Tilequery على streets-v8: صفر POI في جنوب الرياض رغم وجود المعلم في Search Box.
 *  - Category Search (Foursquare-backed): أعاد مدارس/شرطة/مساجد/حدائق/حكومية حقيقية.
 * القيود: لا يعيد «لا نتائج» (أقرب نتيجة لنقطة نائية كانت 14.4كم) ← بوابة
 *  NEAR_CAP في الـOrchestrator إلزامية، وهي خارج هذا الملف.
 */
'use strict';
const { ProviderError, LIMITS, isValidLatLng, sanitizeRawPlaces } = require('./provider-interface');
const { MAPBOX_DEFAULT_CATEGORIES, INTERNAL_TO_MAPBOX } = require('../place-type-map');

const API = 'https://api.mapbox.com/search/searchbox/v1/category/';

class MapboxSearchBoxProvider {
    /**
     * @param {object} opts { token, fetchImpl?, categories?, country?, language? }
     *  fetchImpl للاختبار (بلا شبكة في CI). categories قابلة للضبط — الافتراضي
     *  يغطي قاموس أنواع المالك.
     */
    constructor(opts = {}) {
        this.id = 'mapbox-searchbox';
        this.token = opts.token || process.env.MAPBOX_SEARCH_TOKEN || null;
        this._fetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
        this.categories = Array.isArray(opts.categories) && opts.categories.length
            ? opts.categories : MAPBOX_DEFAULT_CATEGORIES;
        this.country = opts.country || 'sa';
        this.language = opts.language || 'ar';
    }

    capabilities() {
        return { nearbySearch: true, categoryFilter: true, maxRadiusM: LIMITS.MAX_RADIUS_M };
    }

    /**
     * العقد: findNearbyPlaces(lat, lng, { radiusM, limit, types, signal })
     * Mapbox لا يدعم «كل المعالم القريبة» بطلب واحد — نستعلم مجموعة الفئات
     * المعتمدة بالتوازي ثم ندمج ونزيل التكرار. المسافة لا تُحسب هنا (محلية في
     * الـOrchestrator عبر haversineMeters — لا تُؤخذ من المزود).
     */
    async findNearbyPlaces(lat, lng, opts = {}) {
        if (!this.token) throw new ProviderError('disabled', 'MAPBOX_SEARCH_TOKEN غير مضبوط', this.id);
        if (!this._fetch) throw new ProviderError('unavailable', 'fetch غير متاح', this.id);
        if (!isValidLatLng(lat, lng)) throw new ProviderError('bad-response', 'إحداثية غير صالحة', this.id);

        const radiusM = Math.min(Math.max(1, opts.radiusM || LIMITS.DEFAULT_RADIUS_M), LIMITS.MAX_RADIUS_M);
        const limit = Math.min(Math.max(1, opts.limit || LIMITS.DEFAULT_LIMIT), LIMITS.MAX_LIMIT);
        const cats = (Array.isArray(opts.types) && opts.types.length)
            ? [...new Set(opts.types.flatMap(t => INTERNAL_TO_MAPBOX[t] || []))]
            : this.categories;
        if (!cats.length) return [];

        const perCat = Math.max(2, Math.ceil(limit / 2));
        const settled = await Promise.allSettled(cats.map(cat => this._queryCategory(cat, lat, lng, perCat, opts.signal)));

        const merged = [];
        const seen = new Set();
        let firstError = null;
        for (const s of settled) {
            if (s.status === 'rejected') { firstError = firstError || s.reason; continue; }
            for (const p of s.value) {
                const key = (p.providerRef || '') + '|' + p.name + '|' + p.lat.toFixed(5) + '|' + p.lng.toFixed(5);
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(p);
            }
        }
        // كل الفئات فشلت = فشل مزود؛ بعضها نجح = نعمل بما لدينا (تحت بوابة NEAR_CAP)
        if (!merged.length && firstError) throw firstError;
        return sanitizeRawPlaces(merged, this.id);
    }

    async _queryCategory(cat, lat, lng, limit, outerSignal) {
        const url = API + encodeURIComponent(cat) +
            '?access_token=' + encodeURIComponent(this.token) +
            '&proximity=' + lng + ',' + lat +
            '&language=' + this.language + '&country=' + this.country +
            '&limit=' + limit;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), LIMITS.TIMEOUT_MS);
        const onOuterAbort = () => ctrl.abort();
        if (outerSignal) {
            if (outerSignal.aborted) { clearTimeout(timer); throw new ProviderError('timeout', 'aborted', this.id); }
            outerSignal.addEventListener('abort', onOuterAbort, { once: true });
        }
        let res;
        try {
            res = await this._fetch(url, { signal: ctrl.signal });
        } catch (e) {
            if (ctrl.signal.aborted || (e && e.name === 'AbortError'))
                throw new ProviderError('timeout', 'مهلة ' + LIMITS.TIMEOUT_MS + 'ms (' + cat + ')', this.id);
            throw new ProviderError('unavailable', 'شبكة: ' + e.message, this.id);
        } finally {
            clearTimeout(timer);
            if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
        }
        if (res.status === 429) throw new ProviderError('rate-limited', 'HTTP 429 (' + cat + ')', this.id);
        if (res.status === 401 || res.status === 403)
            throw new ProviderError('unavailable', 'HTTP ' + res.status + ' — التوكن مرفوض (' + cat + ')', this.id);
        if (!res.ok) throw new ProviderError('unavailable', 'HTTP ' + res.status + ' (' + cat + ')', this.id);

        let json;
        try { json = await res.json(); }
        catch (e) { throw new ProviderError('bad-response', 'JSON غير صالح (' + cat + ')', this.id); }

        return (json && Array.isArray(json.features) ? json.features : []).map(f => ({
            name: f && f.properties && f.properties.name,
            // الأولوية للـids القياسية، ثم الفئات المترجمة — كلاهما يُحفظ خامًا للتدقيق
            providerCategory: [
                ...((f.properties && (f.properties.poi_category_ids || f.properties.canonical_category_ids)) || []),
                ...((f.properties && f.properties.poi_category) || [])
            ],
            lat: f && f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
            lng: f && f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null,
            providerRef: f && f.properties && (f.properties.mapbox_id || f.id) || null
        }));
    }
}

module.exports = { MapboxSearchBoxProvider };
