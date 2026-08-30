/**
 * place-discovery-cache.js — كاش ذاكرة مؤقت + عدادات استخدام (PI-7)
 * الالتزام الترخيصي (اعتماد المالك 2026-08-30): لا تخزين دائم لنتائج المزود
 * الخام — هذا كاش ذاكرة TTL فقط؛ يموت بإعادة تشغيل العملية. ما يُخزَّن دائمًا
 * هو قرار بشري عبر بوابة PI-2 (خارج هذا الملف).
 * ═══════════════════════════════════════════════════════════════════════════
 * يشمل: كاش TTL · ميزانية يومية (تُصفَّر منتصف الليل المحلي) · circuit breaker
 * يفتح عند rate-limited ويغلق بعد مهلة. كلها ذاكرة عملية — لا ملفات.
 */
'use strict';

const DEFAULTS = {
    TTL_MS: 10 * 60 * 1000,        // 10 دقائق
    DAILY_BUDGET: 1500,            // ~45k/شهر — داخل شريحة Mapbox المجانية بهامش
    CIRCUIT_COOLDOWN_MS: 10 * 60 * 1000,
    MAX_ENTRIES: 5000
};

class PlaceDiscoveryCache {
    constructor(opts = {}) {
        this.ttlMs = opts.ttlMs || DEFAULTS.TTL_MS;
        this.dailyBudget = opts.dailyBudget || DEFAULTS.DAILY_BUDGET;
        this.cooldownMs = opts.cooldownMs || DEFAULTS.CIRCUIT_COOLDOWN_MS;
        this.maxEntries = opts.maxEntries || DEFAULTS.MAX_ENTRIES;
        this._byIncident = new Map();     // number → { value, expiresAt }
        this._usedToday = 0;
        this._day = this._today();
        this._circuitOpenUntil = 0;
        this._counters = { lookups: 0, providerCalls: 0, cacheHits: 0, blocked: 0, errors: 0 };
    }

    _today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }    _rollDay() {
        const t = this._today();
        if (t !== this._day) { this._day = t; this._usedToday = 0; }
    }

    /** هل يُسمح باستعلام مزود الآن؟ (ميزانية + قاطع) */
    allowProviderCall() {
        this._rollDay();
        if (Date.now() < this._circuitOpenUntil) { this._counters.blocked++; return false; }
        if (this._usedToday >= this.dailyBudget) { this._counters.blocked++; return false; }
        return true;
    }

    noteProviderCall() { this._rollDay(); this._usedToday++; this._counters.providerCalls++; }
    noteRateLimited() {
        this._circuitOpenUntil = Date.now() + this.cooldownMs;
        this._counters.errors++;
        console.warn('[PlaceDiscovery] circuit breaker مفتوح ' + (this.cooldownMs / 60000) + ' دقيقة (rate-limited)');
    }
    noteError() { this._counters.errors++; }

    get(number) {
        const e = this._byIncident.get(String(number));
        if (!e) return null;
        if (Date.now() > e.expiresAt) { this._byIncident.delete(String(number)); return null; }
        this._counters.cacheHits++;
        return e.value;
    }

    /** خلية إحداثية ~55م — بلاغات متكررة بنفس الموقع تتقاسم استعلامًا واحدًا */
    static cellKey(lat, lng) {
        return (Math.round(lat / 0.0005) * 0.0005).toFixed(4) + ',' + (Math.round(lng / 0.0005) * 0.0005).toFixed(4);
    }
    getCell(lat, lng) { return this.get('cell:' + PlaceDiscoveryCache.cellKey(lat, lng)); }
    setCell(lat, lng, value) { this.set('cell:' + PlaceDiscoveryCache.cellKey(lat, lng), value); }

    set(number, value) {
        if (this._byIncident.size >= this.maxEntries) {
            const now = Date.now();
            for (const [k, e] of this._byIncident) if (now > e.expiresAt) this._byIncident.delete(k);
            if (this._byIncident.size >= this.maxEntries)
                this._byIncident.delete(this._byIncident.keys().next().value); // إخلاء الأقدم
        }
        this._counters.lookups++;
        this._byIncident.set(String(number), { value, expiresAt: Date.now() + this.ttlMs });
    }

    stats() {
        this._rollDay();
        return { ...this._counters, usedToday: this._usedToday, dailyBudget: this.dailyBudget,
            cachedEntries: this._byIncident.size,
            circuitOpen: Date.now() < this._circuitOpenUntil };
    }
}

module.exports = { PlaceDiscoveryCache, DEFAULTS };
