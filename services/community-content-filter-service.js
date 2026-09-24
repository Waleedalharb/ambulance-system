// ============================================
// CommunityContentFilterService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// فلترة المحتوى الذي ينشئه المستخدمون (UGC — Apple Guideline 1.2).
// تُستدعى خادميًا قبل حفظ أي نص من المستخدم: منشورات، ملاحظة الحضور، عناوين
// الأنشطة وأوصافها، أسماء المنافسات، ومحتوى المناسبات.
//
// المصدران للكلمات (يُدمجان):
//   1) قائمة مدمجة دنيا (مطبقة دائمًا — لا يمكن للإدارة إفراغها).
//   2) قائمة الإدارة: community_settings['banned_words'] (JSON array) — توسيع فقط.
//
// التطبيع قبل المطابقة: توحيد الألف/الياء/التاء المربوطة، إزالة التشكيل
// والتطويل، وإزالة الرموز — حتى لا يُلتف على الفلتر بزخرفة الحروف.
//
// القرار: checkContent(text) → { ok, matched[] } — والخدمة المستدعية تقرر:
// المنشورات ← flagged تدخل قائمة الإشراف (لا تُنشر)؛ بقية الحقول ← رفض 422.
// ============================================
'use strict';

// قائمة دنيا مدمجة — جذور كلمات مخلة (قابلة للتوسيع من الإدارة، غير قابلة للإفراغ)
const BUILTIN_WORDS = Object.freeze([
    'قذر', 'حقير', 'غبي', 'احمق', 'مجنون', 'كلب', 'حمار', 'وسخ', 'لعين',
    'تبا', 'اللعنة', 'ياخي', 'عاهر', 'زاني', 'كافر', 'ارهابي',
    'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'whore', 'nigger', 'faggot'
]);

class CommunityContentFilterService {
    constructor({ db }) {
        if (!db) throw new Error('CommunityContentFilterService: db مطلوب');
        this.db = db;
    }

    /** تطبيع النص لمنع الالتفاف على الفلتر بزخرفة الحروف. */
    _normalize(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[ً-ْٰ]/g, '')   // التشكيل
            .replace(/ـ/g, '')                                  // التطويل
            .replace(/[أإآٱ]/g, 'ا')
            .replace(/[ىئ]/g, 'ي')
            .replace(/[ؤ]/g, 'و')
            .replace(/ة/g, 'ه')
            .replace(/[^؀-ۿa-z0-9\s]/gi, ' ') // الرموز والإيموجي ← مسافة
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** الكلمات الفعّالة: المدمجة + قائمة الإدارة (اتجاه التوسيع فقط). */
    async _effectiveWords() {
        let custom = [];
        try {
            const v = await this.db.Community.getSetting('banned_words');
            if (v) { const a = JSON.parse(v); if (Array.isArray(a)) custom = a; }
        } catch (_) { /* قائمة إدارة تالفة ← المدمجة وحدها (fail-safe) */ }
        const all = BUILTIN_WORDS.concat(custom)
            .map(w => this._normalize(w)).filter(w => w.length >= 2);
        return Array.from(new Set(all));
    }

    /**
     * فحص نص. يُعيد { ok, matched } — matched بلا الكلمة نفسها في الاستجابات
     * العامة (الخدمات تعرض «مخالف للسياسة» فقط، والتفصيل يبقى في flag_reason الداخلي).
     * مطابقة على مستوى الكلمة المفردة بعد التطبيع، ومطابقة تضمين للعبارات متعددة الكلمات.
     * تُولَّد صيغ إضافية للكلمات بتجريد أدوات التعريف/العطف العربية (ال/وال/فال/
     * بال/كال/لل) حتى لا يُلتف على الفلتر بصيغة «الـ» التعريف.
     */
    async checkContent(text) {
        const normalized = this._normalize(text);
        if (!normalized) return { ok: true, matched: [] };
        const tokens = new Set();
        for (const t of normalized.split(' ')) {
            tokens.add(t);
            const dp = t.replace(/^(وال|فال|بال|كال|لل|ال)/, '');
            if (dp.length >= 2 && dp !== t) tokens.add(dp);
        }
        const words = await this._effectiveWords();
        const matched = [];
        for (const w of words) {
            if (w.indexOf(' ') !== -1) {
                if (normalized.indexOf(w) !== -1) matched.push(w);
            } else if (tokens.has(w)) {
                matched.push(w);
            }
        }
        return { ok: matched.length === 0, matched };
    }

    /** تحديث قائمة الإدارة (توسيع فقط — المدمجة لا تُمس) + تدقيق. */
    async setCustomWords(words, actor) {
        const list = Array.isArray(words)
            ? words.filter(w => typeof w === 'string' && w.trim()).map(w => w.trim()).slice(0, 500)
            : [];
        await this.db.Community.setSetting('banned_words', JSON.stringify(list), actor && actor.name);
        await this.db.Community.audit({
            actorId: actor && actor.id, actorName: actor && actor.name,
            action: 'content_filter_update', targetType: 'settings', targetId: 'banned_words',
            detail: 'تحديث قائمة فلترة المحتوى (' + list.length + ' كلمة إدارية)'
        });
        return { count: list.length };
    }

    async getCustomWords() {
        try {
            const v = await this.db.Community.getSetting('banned_words');
            const a = v ? JSON.parse(v) : [];
            return Array.isArray(a) ? a : [];
        } catch (_) { return []; }
    }
}

module.exports = CommunityContentFilterService;
