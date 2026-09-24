// ============================================
// CommunityPostService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// منشورات المجالس — بلا تعليقات إطلاقًا (قرار معماري v3: لا جدول ولا API ولا UI).
//
// سلسلة الحماية عند النشر (كلها خادمية — إخفاء الزر ليس حماية):
//   1) حارس المشاركة الموحد (تعطيل/تجميد إشرافي/البوابة التشغيلية الثابتة)
//   2) المجلس موجود ونشط + العضوية (النشر للأعضاء فقط)
//   3) فلترة المحتوى: مخالفة ← status='flagged' تدخل قائمة الإشراف ولا تظهر
//      في القوائم حتى يحسمها مشرف بشري (لا نشر ثم حذف لاحقًا).
// القوائم: active فقط + استبعاد الحظر متبادل الأثر + Pagination إلزامي.
// الحذف النهائي قرار مشرف بشري دائمًا (removed) — لا حذف تلقائي أبدًا.
// ============================================
'use strict';

class CommunityPostService {
    constructor({ db, identity, core, filter }) {
        if (!db) throw new Error('CommunityPostService: db مطلوب');
        if (!identity) throw new Error('CommunityPostService: identity مطلوب');
        if (!core) throw new Error('CommunityPostService: core (CommunityService) مطلوب');
        if (!filter) throw new Error('CommunityPostService: filter مطلوب');
        this.db = db;
        this.identity = identity;
        this.core = core;
        this.filter = filter;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    /** مجلس نشط + عضوية فعلية، وإلا رمية موحدة. */
    async _requireActiveMembership(actor, councilId) {
        const c = await this.db.Community.getCouncilById(councilId);
        if (!c || c.status !== 'active') throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        const member = await this.db.Community.getCouncilMember(c.id, actor.id);
        if (!member) throw this._err(403, 'النشر والاطلاع للأعضاء — انضم للمجلس أولًا', 'NOT_A_MEMBER');
        return { council: c, member };
    }

    /** نشر منشور — community.post عبر المسار + الحارس هنا. */
    async create(actor, councilId, { content }) {
        const guard = await this.core.participationGuard(actor);
        if (!guard.allow) throw this._err(403, 'غير مؤهل للمشاركة حاليًا', guard.reason);
        const { council } = await this._requireActiveMembership(actor, councilId);
        const text = String(content || '').trim();
        if (text.length < 1 || text.length > 2000) {
            throw this._err(400, 'المنشور مطلوب (1–2000 حرف)', 'BAD_REQUEST');
        }
        const me = await this.identity.resolveByUser(actor);
        const f = await this.filter.checkContent(text);
        // مخالفة الفلتر ← flagged (قائمة الإشراف، لا تظهر للأعضاء) + تدقيق داخلي
        const status = f.ok ? 'active' : 'flagged';
        const flagReason = f.ok ? null : 'content_filter';
        const id = await this.db.Community.createPost({
            councilId: council.id, authorUserId: actor.id,
            authorName: me ? me.display_name : actor.name, content: text, status, flagReason
        });
        if (!f.ok) {
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'post_flagged',
                targetType: 'post', targetId: id,
                detail: 'منشور أوقفه فلتر المحتوى في «' + council.name + '» — بانتظار مراجعة مشرف'
            });
        }
        return {
            id, status,
            flagged: !f.ok,
            message: f.ok ? null : 'أوقف المنشور للمراجعة وفق سياسة المحتوى ولن يظهر حتى يُعتمد'
        };
    }

    /** قائمة منشورات مجلس: active فقط + استبعاد الحظر المتبادل + Pagination. */
    async list(actor, councilId, { limit = 20, offset = 0 } = {}) {
        const { council } = await this._requireActiveMembership(actor, councilId);
        const excluded = await this.db.Community.getBlockCounterparts(actor.id);
        const rows = await this.db.Community.listCouncilPosts(council.id, { limit, offset, excludeUserIds: excluded });
        return rows.map(p => ({
            id: p.id, content: p.content, createdAt: p.created_at,
            author: { userId: p.author_user_id, displayName: p.author_name },
            mine: String(p.author_user_id) === String(actor.id)
        }));
    }

    /** حذف المؤلف لمنشوره — WHERE المزدوج في قاعدة البيانات يمنع IDOR بنيويًا. */
    async removeOwn(actor, postId) {
        const post = await this.db.Community.getPostById(postId);
        if (!post) throw this._err(404, 'المنشور غير موجود', 'POST_NOT_FOUND');
        const r = await this.db.Community.deleteOwnPost(postId, actor.id);
        if (!r || r.changes !== 1) throw this._err(403, 'لا يمكن حذف منشور غيرك', 'NOT_AUTHOR');
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'post_delete_own',
            targetType: 'post', targetId: postId, detail: 'مؤلف حذف منشوره'
        });
        return { deleted: true };
    }

    /** إشراف مباشر على المحتوى (community.moderate عبر المسار): active/hidden/removed. */
    async moderateSetStatus(actor, postId, status, note) {
        const ALLOWED = ['active', 'hidden', 'removed'];
        if (ALLOWED.indexOf(status) === -1) {
            throw this._err(422, 'حالة غير معروفة (' + ALLOWED.join('/') + ')', 'BAD_STATUS');
        }
        const post = await this.db.Community.getPostById(postId);
        if (!post) throw this._err(404, 'المنشور غير موجود', 'POST_NOT_FOUND');
        await this.db.Community.setPostStatus(postId, status, actor.name);
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'post_moderate',
            targetType: 'post', targetId: postId,
            detail: 'منشور #' + postId + ' ← ' + status + (note ? ' · ' + String(note).slice(0, 200) : '')
        });
        return { id: postId, status };
    }

    /** قائمة الإشراف للمحتوى الموقوف (flagged بالفلتر / hidden بعتبة البلاغات). */
    async listModeration(actor, { status, limit = 50, offset = 0 } = {}) {
        const st = status === 'hidden' ? 'hidden' : 'flagged';
        const rows = await this.db.all(
            `SELECT p.*, c.name AS council_name FROM community_posts p
             JOIN community_councils c ON c.id = p.council_id
             WHERE p.status = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
            [st, limit, offset]);
        return rows;
    }
}

module.exports = CommunityPostService;
