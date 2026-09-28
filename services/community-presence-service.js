// ============================================
// CommunityPresenceService — EMS Community (اعتماد المالك 2026-09-24)
// ============================================
// «من موجود؟» — Explicit Social Status فقط. يضبط الموظف حالته بيده:
//   available (متاح للمجلس) · busy (مشغول) · in_activity (في نشاط) · unavailable (غير متاح)
//
// ممنوع معماريًا (ثوابت v3 — لا يوجد أي Toggle يفتحها):
//   ✗ لا GPS ولا إحداثيات في الجدول ولا الـAPI ولا الاستجابة
//   ✗ لا قراءة من team_live_locations أو أي سجل موقع تشغيلي
//   ✗ لا عرض لموقع الموظف ولا استنتاج وجوده من موقعه
//   ✗ لا last_seen ولا استنتاج من نشاط التطبيق/الجلسة
// الحالة تنتهي صلاحيتها عرضيًا بعد 12 ساعة (القديمة ليست «موجودًا» افتراضيًا).
//
// قرار المالك 2026-09-24 (D1): إعلان الحالة الاجتماعية اختيار شخصي بحت —
// لا يمر بالبوابة التشغيلية إطلاقًا (الموظف يحدد حالته بنفسه متى شاء، والمهمة
// التشغيلية لا تمنعه من تغييرها). يبقى على إعلان التوفر فقط: توفر المنظومة
// (إطفاء/تعطيل دور) والتجميد الإشرافي. «مشغول/غير متاح» انسحاب ← متاح دائمًا.
// ============================================
'use strict';

const STATUSES = Object.freeze(['available', 'busy', 'in_activity', 'unavailable']);
// حالات الإعلان الإيجابي تخضع للتعطيل/التجميد الإشرافي فقط؛ حالات الانسحاب حرة دائمًا
const OPT_IN_STATUSES = Object.freeze(['available', 'in_activity']);
const MAX_AGE_HOURS = 12;

class CommunityPresenceService {
    constructor({ db, identity, core, filter }) {
        if (!db) throw new Error('CommunityPresenceService: db مطلوب');
        if (!identity) throw new Error('CommunityPresenceService: identity مطلوب');
        if (!core) throw new Error('CommunityPresenceService: core (CommunityService) مطلوب');
        if (!filter) throw new Error('CommunityPresenceService: filter مطلوب');
        this.db = db;
        this.identity = identity;
        this.core = core;
        this.filter = filter;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    /** ضبط حالتي — اختيار صريح من الموظف نفسه، ولا مصدر آخر للحالة إطلاقًا.
     *  لا بوابة تشغيلية هنا (قرار المالك D1): participationGuard لا يُستدعى أبدًا
     *  من هذا المسار. التعطيل الإداري والتجميد الإشرافي فقط على حالات الإعلان. */
    async setMine(actor, { status, note }) {
        if (STATUSES.indexOf(status) === -1) {
            throw this._err(422, 'حالة غير معروفة (' + STATUSES.join('/') + ')', 'BAD_STATUS');
        }
        // إعلان التوفر/النشاط: إطفاء المنظومة/تعطيل الدور + التجميد الإشرافي فقط
        if (OPT_IN_STATUSES.indexOf(status) !== -1) {
            if (!(await this.core.isAvailableFor(actor))) {
                throw this._err(403, 'منظومة المجتمع غير متاحة حاليًا', 'COMMUNITY_DISABLED');
            }
            const restrictions = await this.db.Community.getActiveRestrictions(actor.id);
            if (restrictions.length > 0) {
                throw this._err(403, 'مشاركتك الاجتماعية مجمّدة حاليًا بقرار إشرافي', 'PARTICIPATION_FROZEN');
            }
        }
        let cleanNote = null;
        if (note != null && String(note).trim()) {
            const n = String(note).trim();
            if (n.length > 120) throw this._err(400, 'الملاحظة طويلة (الحد 120 حرفًا)', 'BAD_REQUEST');
            const f = await this.filter.checkContent(n);
            if (!f.ok) throw this._err(422, 'الملاحظة تحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
            cleanNote = n;
        }
        await this.db.Community.setPresence(actor.id, status, cleanNote);
        return { status, note: cleanNote };
    }

    async mine(actor) {
        const row = await this.db.Community.getPresence(actor.id);
        return row ? { status: row.status, note: row.note, updatedAt: row.updated_at } : null;
    }

    /**
     * قائمة «من موجود؟»: الحالات الصريحة الحديثة فقط (≤ 12 ساعة)، مع استبعاد
     * الحظر متبادل الأثر، وهوية Projection (4 حقول فقط). الاستجابة لا تحمل
     * أي حقل موقع/زمن نشاط/مصدر — status + note + updatedAt فقط.
     */
    async list(actor, { limit = 50, offset = 0 } = {}) {
        const excluded = await this.db.Community.getBlockCounterparts(actor.id);
        const rows = await this.db.Community.listPresence({
            excludeUserIds: excluded, limit, offset, maxAgeHours: MAX_AGE_HOURS
        });
        const identities = await this.identity.resolveMany(rows.map(r => r.user_id));
        return rows.map(r => ({
            userId: r.user_id,
            status: r.status,       // اختيار صريح — ليس استنتاجًا
            note: r.note,
            updatedAt: r.updated_at, // متى ضبطها هو — ليس «آخر ظهور»
            user: identities[String(r.user_id)] || null
        }));
    }
}

CommunityPresenceService.STATUSES = STATUSES;
CommunityPresenceService.MAX_AGE_HOURS = MAX_AGE_HOURS;
module.exports = CommunityPresenceService;
