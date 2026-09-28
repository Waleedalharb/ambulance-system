// ============================================
// CommunityChatService — EMS Community D1 (اعتماد المالك الكتابي 2026-09-24)
// ============================================
// دردشة المجالس والغرف — جماعية فقط، داخل غرفة، وليست Inbox ولا رسائل خاصة
// 1:1 إطلاقًا (قرار D1). «جزء من التجمع» — خفيفة بلا عدادات ولا إشعارات.
//
// سلسلة الحماية عند الإرسال (خادمية كلها):
//   1) حارس المشاركة الموحد (تعطيل/تجميد إشرافي/البوابة التشغيلية الثابتة)
//   2) وصول الغرفة (عضوية مجلس أو عضوية غرفة خاصة) + الغرفة نشطة
//   3) فلترة المحتوى: مخالفة ← status='flagged' لا تظهر في القوائم حتى يحسمها
//      مشرف بشري (نفس نمط المنشورات — لا نشر ثم حذف لاحقًا).
// القراءة: visible فقط + استبعاد الحظر متبادل الأثر + استعلام تزايدي بـsince_id
// (الرسائل الجديدة فقط — لا تحميل للتاريخ كاملًا مع كل طلب).
// الحذف النهائي removed قرار مشرف بشري دائمًا — لا حذف تلقائي أبدًا.
// ============================================
'use strict';

class CommunityChatService {
    constructor({ db, identity, core, filter, rooms }) {
        if (!db) throw new Error('CommunityChatService: db مطلوب');
        if (!identity) throw new Error('CommunityChatService: identity مطلوب');
        if (!core) throw new Error('CommunityChatService: core (CommunityService) مطلوب');
        if (!filter) throw new Error('CommunityChatService: filter مطلوب');
        if (!rooms) throw new Error('CommunityChatService: rooms (CommunityRoomService) مطلوب');
        this.db = db;
        this.identity = identity;
        this.core = core;
        this.filter = filter;
        this.rooms = rooms;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    /** إرسال رسالة — community.post عبر المسار + الحارس هنا + عضوية الغرفة. */
    async send(actor, roomId, { content }) {
        const guard = await this.core.participationGuard(actor);
        if (!guard.allow) throw this._err(403, 'غير مؤهل للمشاركة حاليًا', guard.reason);
        const { room } = await this.rooms.requireAccess(actor, roomId);
        if (room.status !== 'active') throw this._err(409, 'الغرفة مغلقة', 'ROOM_CLOSED');
        const text = String(content || '').trim();
        if (text.length < 1 || text.length > 1000) {
            throw this._err(400, 'الرسالة مطلوبة (1–1000 حرف)', 'BAD_REQUEST');
        }
        const me = await this.identity.resolveByUser(actor);
        const f = await this.filter.checkContent(text);
        // مخالفة الفلتر ← flagged (قائمة الإشراف، لا تظهر للأعضاء) + تدقيق داخلي
        const status = f.ok ? 'visible' : 'flagged';
        const flagReason = f.ok ? null : 'content_filter';
        // الإرسال (+ تدقيق الإيقاف عند المخالفة) في معاملة واحدة
        return this.db.Community.atomic(async () => {
            const id = await this.db.Community.addChatMessage({
                roomId: room.id, authorUserId: actor.id,
                authorName: me ? me.display_name : actor.name, content: text, status, flagReason
            });
            if (!f.ok) {
                await this.db.Community.audit({
                    actorId: actor.id, actorName: actor.name, action: 'chat_flagged',
                    targetType: 'chat_message', targetId: id,
                    detail: 'رسالة أوقفها فلتر المحتوى في غرفة «' + room.name + '» — بانتظار مراجعة مشرف'
                });
            }
            return {
                id, status,
                flagged: !f.ok,
                message: f.ok ? null : 'أوقفت الرسالة للمراجعة وفق سياسة المحتوى ولن تظهر حتى تُعتمد'
            };
        });
    }

    /**
     * قراءة رسائل غرفة — وصول محروس. sinceId=0: آخر limit رسالة؛ sinceId>0:
     * الجديد فقط (id > sinceId). الظاهر فقط + استبعاد الحظر متبادل الأثر.
     * الاستجابة: status/content/الهوية الرباعية فقط — لا حقل موقع/مصدر إطلاقًا.
     */
    async list(actor, roomId, { sinceId = 0, limit = 50 } = {}) {
        const { room } = await this.rooms.requireAccess(actor, roomId);
        const excluded = await this.db.Community.getBlockCounterparts(actor.id);
        const rows = await this.db.Community.listChatMessages(room.id, {
            sinceId: Math.max(0, parseInt(sinceId, 10) || 0),
            limit: Math.min(Math.max(1, parseInt(limit, 10) || 50), 100),
            excludeUserIds: excluded
        });
        return {
            roomStatus: room.status,
            messages: rows.map(m => ({
                id: m.id, content: m.content, createdAt: m.created_at,
                author: { userId: m.author_user_id, displayName: m.author_name },
                mine: String(m.author_user_id) === String(actor.id)
            })),
            // سعر المزامنة التالي — أعلى id وصل العميل (وليس أعلى id في القاعدة)
            lastId: rows.length ? rows[rows.length - 1].id : (parseInt(sinceId, 10) || 0)
        };
    }

    /** إشراف مباشر على رسالة (community.moderate عبر المسار): visible/hidden/removed. */
    async moderateSetStatus(actor, messageId, status, note) {
        const ALLOWED = ['visible', 'hidden', 'removed'];
        if (ALLOWED.indexOf(status) === -1) {
            throw this._err(422, 'حالة غير معروفة (' + ALLOWED.join('/') + ')', 'BAD_STATUS');
        }
        const msg = await this.db.Community.getChatMessageById(messageId);
        if (!msg) throw this._err(404, 'الرسالة غير موجودة', 'MESSAGE_NOT_FOUND');
        // تغيير الحالة + التدقيق في معاملة واحدة
        return this.db.Community.atomic(async () => {
            await this.db.Community.setChatMessageStatus(messageId, status, actor.name);
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'chat_moderate',
                targetType: 'chat_message', targetId: messageId,
                detail: 'رسالة #' + messageId + ' ← ' + status + (note ? ' · ' + String(note).slice(0, 200) : '')
            });
            return { id: messageId, status };
        });
    }

    /** قائمة الإشراف للرسائل الموقوفة (flagged بالفلتر / hidden بعتبة البلاغات). */
    async listModeration(actor, { status, limit = 50, offset = 0 } = {}) {
        const st = status === 'hidden' ? 'hidden' : 'flagged';
        return this.db.Community.listChatModeration(st, limit, offset);
    }
}

module.exports = CommunityChatService;
