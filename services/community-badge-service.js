// ============================================
// CommunityBadgeService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// الشارات والإنجازات: Framework عام قابل للتوسع — صانع المجالس/روح الفريق/
// منظم البطولة/محترف البلوت/بطل التحديات، وأي شارة مستقبلية تُدار بلا كود.
// المنح في هذه المرحلة يدوي (مشرف/إدارة) مع سياق موثّق؛ محرك المنح التلقائي
// (Participation/Activity results) مرحلة مستقبلية — البنية جاهزة له.
// الشارات معنوية صِرفة: لا جوائز مالية ولا قيمة نقدية بحكم التصميم.
// ============================================
'use strict';

class CommunityBadgeService {
    constructor({ db, identity, filter, moderation }) {
        if (!db) throw new Error('CommunityBadgeService: db مطلوب');
        if (!identity) throw new Error('CommunityBadgeService: identity مطلوب');
        if (!filter) throw new Error('CommunityBadgeService: filter مطلوب');
        if (!moderation) throw new Error('CommunityBadgeService: moderation مطلوب');
        this.db = db;
        this.identity = identity;
        this.filter = filter;
        this.moderation = moderation;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    async list() {
        return this.db.Community.listBadges(true);
    }

    /** إنشاء تعريف شارة — community.admin عبر المسار. */
    async create(actor, { key, name, description, icon }) {
        const k = String(key || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_]{1,48}[a-z0-9]$/.test(k)) {
            throw this._err(422, 'key غير صالح (أحرف إنجليزية صغيرة/أرقام/شرطة سفلية)', 'BAD_KEY');
        }
        const n = String(name || '').trim();
        if (n.length < 2 || n.length > 60) throw this._err(400, 'اسم الشارة مطلوب (2–60 حرفًا)', 'BAD_REQUEST');
        for (const [txt, label] of [[n, 'الاسم'], [description, 'الوصف']]) {
            if (txt) {
                const f = await this.filter.checkContent(txt);
                if (!f.ok) throw this._err(422, label + ' يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
            }
        }
        const id = await this.db.Community.createBadge({
            key: k, name: n, description: description ? String(description).slice(0, 300) : null,
            icon: icon ? String(icon).slice(0, 16) : null
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'badge_create',
            targetType: 'badge', targetId: id, detail: 'شارة جديدة «' + n + '» (' + k + ')'
        });
        return { id, key: k };
    }

    /** شارات مستخدم — الحظر متبادل الأثر يمنع استعراض ملف من حظرك/حظرته. */
    async forUser(actor, userId) {
        const target = await this.identity.resolveByUserId(userId);
        if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        if (String(actor.id) !== String(userId)) {
            const blocked = await this.moderation.isBlockedEitherWay(actor.id, userId);
            if (blocked) throw this._err(403, 'لا يمكن عرض هذا الملف', 'BLOCKED_INTERACTION');
        }
        return {
            user: target,
            badges: await this.db.Community.listUserBadges(userId)
        };
    }

    /** منح شارة — community.moderate عبر المسار. idempotent بنفس السياق. */
    async award(actor, badgeId, { userId, context }) {
        const badge = await this.db.Community.getBadgeById(badgeId);
        if (!badge || !badge.enabled) throw this._err(404, 'الشارة غير موجودة', 'BADGE_NOT_FOUND');
        const target = await this.identity.resolveByUserId(userId);
        if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        const ctx = String(context || '').trim().slice(0, 200);
        const id = await this.db.Community.awardBadge({
            userId, badgeId: badge.id, context: ctx, awardedBy: actor.name
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'badge_award',
            targetType: 'user', targetId: userId,
            detail: 'منح شارة «' + badge.name + '» لـ' + target.display_name + (ctx ? ' — ' + ctx : '')
        });
        return { awarded: true, id };
    }

    /** سحب شارة — community.moderate عبر المسار. */
    async revoke(actor, userBadgeId) {
        const row = await this.db.Community.getUserBadgeById(userBadgeId);
        if (!row) throw this._err(404, 'المنحة غير موجودة', 'AWARD_NOT_FOUND');
        const badge = await this.db.Community.getBadgeById(row.badge_id);
        const r = await this.db.Community.revokeUserBadge(userBadgeId);
        if (!r || r.changes !== 1) throw this._err(404, 'المنحة غير موجودة', 'AWARD_NOT_FOUND');
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'badge_revoke',
            targetType: 'user', targetId: row.user_id,
            detail: 'سحب شارة «' + (badge ? badge.name : row.badge_id) + '» (منحة #' + userBadgeId + ')'
        });
        return { revoked: true };
    }
}

module.exports = CommunityBadgeService;
