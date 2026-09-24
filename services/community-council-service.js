// ============================================
// CommunityCouncilService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// المجالس: نظام Generic — يستوعب مجلس جنوب الرياض/الفرق/القيادات/البلوت/المناسبات
// وأي مجلس مستقبلي بلا إعادة بناء. كل مجلس مستقل: حالة/عضوية/إعدادات/إشراف.
//
// الانضمام مشاركة اجتماعية ← يمر بحارس المشاركة الموحد (تعطيل/تقييد/بوابة تشغيلية).
// تعطيل مجلس (status) قرار إداري مسموح — اتجاه التقييد فقط، ولا يفتح ما تمنعه
// قاعدة التشغيل (تلك ثابتة في البوابة ولا تمر من هنا أصلًا).
// ============================================
'use strict';

const COUNCIL_STATUS = Object.freeze(['active', 'disabled', 'archived']);
const MEMBERSHIP = Object.freeze(['open', 'closed']);
const MEMBER_ROLES = Object.freeze(['member', 'moderator']);

class CommunityCouncilService {
    constructor({ db, identity, core, filter }) {
        if (!db) throw new Error('CommunityCouncilService: db مطلوب');
        if (!identity) throw new Error('CommunityCouncilService: identity مطلوب');
        if (!core) throw new Error('CommunityCouncilService: core (CommunityService) مطلوب');
        if (!filter) throw new Error('CommunityCouncilService: filter مطلوب');
        this.db = db;
        this.identity = identity;
        this.core = core;     // participationGuard + isAvailableFor
        this.filter = filter; // فلترة UGC
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    _validateSlug(slug) {
        const s = String(slug || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(s)) {
            throw this._err(422, 'slug غير صالح (أحرف إنجليزية صغيرة/أرقام/شرطة، 3–50)', 'BAD_SLUG');
        }
        return s;
    }

    /** قائمة المجالس — العضو يرى active فقط؛ الإدارة ترى الكل عبر includeDisabled. */
    async list(actor, { includeDisabled = false } = {}) {
        const councils = await this.db.Community.listCouncils(includeDisabled);
        const mine = await this.db.Community.listMyCouncils(actor.id);
        const myMap = {};
        for (const m of mine) myMap[m.id] = m.my_role;
        const out = [];
        for (const c of councils) {
            out.push({
                id: c.id, slug: c.slug, name: c.name, description: c.description,
                icon: c.icon, status: c.status, membership: c.membership,
                members_count: await this.db.Community.countCouncilMembers(c.id),
                my_role: myMap[c.id] || null,
                joined: !!myMap[c.id],
                created_at: c.created_at
            });
        }
        return out;
    }

    /** مجلس واحد — المعطل يُعامل كغير موجود للأعضاء (لا user enumeration للحالة). */
    async get(actor, id) {
        const c = await this.db.Community.getCouncilById(id);
        if (!c || c.status !== 'active') throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        const member = await this.db.Community.getCouncilMember(c.id, actor.id);
        return {
            id: c.id, slug: c.slug, name: c.name, description: c.description, icon: c.icon,
            status: c.status, membership: c.membership,
            members_count: await this.db.Community.countCouncilMembers(c.id),
            my_role: member ? member.role : null,
            joined: !!member,
            created_at: c.created_at
        };
    }

    /** إنشاء مجلس — community.admin عبر المسار. المحتوى يُفلتر، والفعل يُدقَّق. */
    async create(actor, { slug, name, description, icon, membership }) {
        const s = this._validateSlug(slug);
        const n = String(name || '').trim();
        if (n.length < 2 || n.length > 80) throw this._err(400, 'اسم المجلس مطلوب (2–80 حرفًا)', 'BAD_REQUEST');
        if (membership && MEMBERSHIP.indexOf(membership) === -1) {
            throw this._err(422, 'نوع العضوية غير معروف (open/closed)', 'BAD_MEMBERSHIP');
        }
        for (const [txt, label] of [[n, 'الاسم'], [description, 'الوصف']]) {
            if (txt) {
                const f = await this.filter.checkContent(txt);
                if (!f.ok) throw this._err(422, label + ' يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
            }
        }
        const existing = await this.db.Community.getCouncilBySlug(s);
        if (existing) throw this._err(409, 'يوجد مجلس بهذا المعرف (slug)', 'SLUG_TAKEN');
        const id = await this.db.Community.createCouncil({
            slug: s, name: n, description: description ? String(description).slice(0, 500) : null,
            icon: icon ? String(icon).slice(0, 16) : null, membership: membership || 'open', createdBy: actor.name
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'council_create',
            targetType: 'majlis', targetId: id, detail: 'إنشاء مجلس «' + n + '» (' + s + ')'
        });
        return { id, slug: s };
    }

    /** تحديث مجلس (اسم/وصف/أيقونة/عضوية/حالة) — community.admin عبر المسار. */
    async update(actor, id, { name, description, icon, membership, status }) {
        const c = await this.db.Community.getCouncilById(id);
        if (!c) throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        if (status && COUNCIL_STATUS.indexOf(status) === -1) {
            throw this._err(422, 'حالة غير معروفة (' + COUNCIL_STATUS.join('/') + ')', 'BAD_STATUS');
        }
        if (membership && MEMBERSHIP.indexOf(membership) === -1) {
            throw this._err(422, 'نوع العضوية غير معروف (open/closed)', 'BAD_MEMBERSHIP');
        }
        if (name != null) {
            const n = String(name).trim();
            if (n.length < 2 || n.length > 80) throw this._err(400, 'اسم المجلس (2–80 حرفًا)', 'BAD_REQUEST');
            const f = await this.filter.checkContent(n);
            if (!f.ok) throw this._err(422, 'الاسم يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
        }
        if (description != null) {
            const f = await this.filter.checkContent(description);
            if (!f.ok) throw this._err(422, 'الوصف يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
        }
        await this.db.Community.updateCouncil(id, {
            name: name != null ? String(name).trim() : null,
            description: description != null ? String(description).slice(0, 500) : null,
            icon: icon != null ? String(icon).slice(0, 16) : null,
            membership: membership || null, status: status || null
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'council_update',
            targetType: 'majlis', targetId: id,
            detail: 'تحديث مجلس «' + c.name + '»' + (status ? ' ← الحالة: ' + status : '')
        });
        return { id: c.id, updated: true };
    }

    /**
     * الانضمام لمجلس — مشاركة اجتماعية: حارس المشاركة الموحد أولًا
     * (تعطيل المنظومة/تجميد إشرافي/البوابة التشغيلية الثابتة).
     */
    async join(actor, id) {
        const c = await this.db.Community.getCouncilById(id);
        if (!c || c.status !== 'active') throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        if (c.membership !== 'open') throw this._err(403, 'الانضمام لهذا المجلس بإضافة من الإدارة فقط', 'COUNCIL_CLOSED');
        const guard = await this.core.participationGuard(actor);
        if (!guard.allow) throw this._err(403, 'غير مؤهل للمشاركة حاليًا', guard.reason);
        const existing = await this.db.Community.getCouncilMember(c.id, actor.id);
        if (existing) return { joined: true, already: true };
        await this.db.Community.addCouncilMember(c.id, actor.id, 'member');
        return { joined: true };
    }

    async leave(actor, id) {
        const r = await this.db.Community.removeCouncilMember(id, actor.id);
        if (!r || r.changes !== 1) throw this._err(404, 'لست عضوًا في هذا المجلس', 'NOT_A_MEMBER');
        return { left: true };
    }

    /** إضافة عضو لمجلس مغلق / تغيير دور عضو — community.moderate عبر المسار. */
    async setMember(actor, id, userId, role) {
        const c = await this.db.Community.getCouncilById(id);
        if (!c) throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        if (MEMBER_ROLES.indexOf(role) === -1) {
            throw this._err(422, 'دور عضوية غير معروف (' + MEMBER_ROLES.join('/') + ')', 'BAD_ROLE');
        }
        const target = await this.identity.resolveByUserId(userId);
        if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        await this.db.Community.addCouncilMember(c.id, userId, role);
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'council_member_set',
            targetType: 'majlis', targetId: id,
            detail: 'إضافة/تعديل عضو ' + target.display_name + ' بدور ' + role + ' في «' + c.name + '»'
        });
        return { set: true };
    }

    async removeMember(actor, id, userId) {
        const c = await this.db.Community.getCouncilById(id);
        if (!c) throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        const r = await this.db.Community.removeCouncilMember(id, userId);
        if (!r || r.changes !== 1) throw this._err(404, 'العضو غير موجود في هذا المجلس', 'NOT_A_MEMBER');
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'council_member_remove',
            targetType: 'majlis', targetId: id, detail: 'إزالة عضو ' + userId + ' من «' + c.name + '»'
        });
        return { removed: true };
    }

    /** قائمة الأعضاء بهوية Projection (4 حقول فقط) + Pagination. */
    async members(actor, id, { limit = 100, offset = 0 } = {}) {
        const c = await this.db.Community.getCouncilById(id);
        if (!c || c.status !== 'active') throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        const rows = await this.db.Community.listCouncilMembers(c.id, limit, offset);
        const identities = await this.identity.resolveMany(rows.map(r => r.user_id));
        return rows.map(r => ({
            userId: r.user_id, role: r.role, joinedAt: r.joined_at,
            user: identities[String(r.user_id)] || null
        }));
    }
}

CommunityCouncilService.COUNCIL_STATUS = COUNCIL_STATUS;
CommunityCouncilService.MEMBER_ROLES = MEMBER_ROLES;
module.exports = CommunityCouncilService;
