// ============================================
// CommunityService — EMS Community C1 (اعتماد المالك الكتابي 2026-09-24)
// ============================================
// نواة المجتمع في C1: مفاتيح التعطيل + حارس المشاركة الموحد.
//
// مفاتيح التعطيل (اتجاه التقييد فقط — لا تفتح ما تمنعه قاعدة التشغيل):
//   enabled         : '1' | '0' — إطفاء المنظومة كاملة (الافتراضي '1')
//   disabled_roles  : JSON array — أدوار يُمنع أصحابها من المجتمع
// (مستويات التعطيل 2–4: مجلس/نشاط/نوع نشاط — تُضاف مع C2/C3 عند وجود كياناتها)
//
// حارس المشاركة participationGuard(user) — الترتيب إلزامي:
//   1) المنظومة متاحة للمستخدم (enabled + الدور غير معطّل)
//   2) لا تقييد نشط (تجميد مشاركة بقرار مشرف)
// كل طبقة لا تستطيع إلا التضييق على التي قبلها.
//
// ⚠️ قرار المالك النهائي (2026-09-25): أُلغيت البوابة التشغيلية عن المشاركة
// الاجتماعية/الترفيهية بالكامل. حالة المناوبة/التكليف/الجاهزية لا تؤثر على
// أهلية Community/Baloot إطلاقًا، ولا تُقرأ بيانات التكليف أو
// team_live_locations لغرض منع المشاركة. الأهلية = صلاحية community.*
// + المنظومة مفعّلة + لا تجميد إشرافي.
// ============================================
'use strict';

class CommunityService {
    constructor({ db }) {
        if (!db) throw new Error('CommunityService: db مطلوب');
        this.db = db;
    }

    async isEnabled() {
        const v = await this.db.Community.getSetting('enabled');
        return v === null ? true : v === '1'; // الافتراضي مفعّلة — العضوية أصلًا بمنح فردية
    }

    async getDisabledRoles() {
        const v = await this.db.Community.getSetting('disabled_roles');
        if (!v) return [];
        try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; }
    }

    /** هل المنظومة متاحة لهذا المستخدم (مستوى 1 + مستوى 5)؟ */
    async isAvailableFor(user) {
        if (!(await this.isEnabled())) return false;
        const disabled = await this.getDisabledRoles();
        return !(user && user.role && disabled.indexOf(user.role) !== -1);
    }

    /** تعطيل/تفعيل المنظومة — admin فقط عبر المسار، ويُدقَّق هنا. */
    async setEnabled(enabled, actor) {
        // الحفظ + التدقيق في معاملة واحدة
        return this.db.Community.atomic(async () => {
            await this.db.Community.setSetting('enabled', enabled ? '1' : '0', actor && actor.name);
            await this.db.Community.audit({
                actorId: actor && actor.id, actorName: actor && actor.name,
                action: enabled ? 'community_enable' : 'community_disable',
                targetType: 'settings', targetId: 'enabled',
                detail: enabled ? 'تفعيل منظومة المجتمع' : 'إطفاء منظومة المجتمع بالكامل'
            });
            return { enabled: !!enabled };
        });
    }

    /** تعطيل أدوار محددة (تقييد فقط) — admin فقط عبر المسار. */
    async setDisabledRoles(roles, actor) {
        const list = Array.isArray(roles) ? roles.filter(r => typeof r === 'string' && r) : [];
        // الحفظ + التدقيق في معاملة واحدة
        return this.db.Community.atomic(async () => {
            await this.db.Community.setSetting('disabled_roles', JSON.stringify(list), actor && actor.name);
            await this.db.Community.audit({
                actorId: actor && actor.id, actorName: actor && actor.name,
                action: 'community_disable_roles',
                targetType: 'settings', targetId: 'disabled_roles',
                detail: 'الأدوار المعطّلة من المجتمع: ' + (list.join(', ') || '(لا شيء)')
            });
            return { disabledRoles: list };
        });
    }

    async getSettings() {
        return { enabled: await this.isEnabled(), disabledRoles: await this.getDisabledRoles() };
    }

    /**
     * حارس المشاركة الموحد — يرفض بسبب عام واحد. لا يتحايل عليه أي مسار مشاركة
     * (C2+). إجراءات السلامة (بلاغ/حظر) لا تمر هنا — تبقى متاحة دائمًا.
     * (قرار 2026-09-25: لا بوابة تشغيلية هنا — المناوبة لا تمنع المشاركة.)
     * @returns {Promise<{allow:boolean, reason:string|null}>}
     */
    async participationGuard(user) {
        if (!(await this.isAvailableFor(user))) {
            return { allow: false, reason: 'COMMUNITY_DISABLED' };
        }
        const restrictions = await this.db.Community.getActiveRestrictions(user.id);
        if (restrictions.length > 0) {
            return { allow: false, reason: 'PARTICIPATION_FROZEN' };
        }
        return { allow: true, reason: null };
    }
}

module.exports = CommunityService;
