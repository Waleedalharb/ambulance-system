// ============================================
// CommunityRoomService — EMS Community D1 (اعتماد المالك الكتابي 2026-09-24)
// ============================================
// الغرف: «تجمع حي داخل المجتمع». نوعان فقط في D1:
//   council — غرفة مجلس واحدة دائمة تُنشأ كسولًا عند أول فتح من عضو
//             (الفهرس الفريد الجزئي idx_community_rooms_council_one يحسم
//             سباق الإنشاء بنيويًا — لا غرفتين لمجلس واحد أبدًا).
//   private — ينشئها مستخدم ويضيف إليها من يريد، يغلقها منشئها فقط.
// غرف الطاولة والبطولة مراحل لاحقة (D3/D5) — لا تُبنى الآن.
//
// الوصول: غرفة المجلس لأعضائه فقط (نمط NOT_A_MEMBER نفسه)، والخاصة لأعضائها
// فقط. الإنشاء/الإضافة مشاركة اجتماعية ← حارس المشاركة الموحد للإنشاء، وفحص
// الحظر المتبادل الأثر عند إضافة الأعضاء. كل الكتابات mutation+audit ذرّية.
// ============================================
'use strict';

class CommunityRoomService {
    constructor({ db, identity, core, filter, moderation }) {
        if (!db) throw new Error('CommunityRoomService: db مطلوب');
        if (!identity) throw new Error('CommunityRoomService: identity مطلوب');
        if (!core) throw new Error('CommunityRoomService: core (CommunityService) مطلوب');
        if (!filter) throw new Error('CommunityRoomService: filter مطلوب');
        if (!moderation) throw new Error('CommunityRoomService: moderation مطلوب');
        this.db = db;
        this.identity = identity;
        this.core = core;
        this.filter = filter;
        this.moderation = moderation;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    /**
     * حارس الوصول الموحد للغرفة — يُستخدم من خدمة الدردشة أيضًا:
     * الغرفة موجودة ونشطة + (غرفة مجلس ← عضوية المجلس | غرفة خاصة ← عضوية الغرفة).
     */
    async requireAccess(actor, roomId) {
        const room = await this.db.Community.getRoomById(roomId);
        if (!room) throw this._err(404, 'الغرفة غير موجودة', 'ROOM_NOT_FOUND');
        if (room.kind === 'council') {
            const council = await this.db.Community.getCouncilById(room.council_id);
            if (!council || council.status !== 'active') throw this._err(404, 'الغرفة غير موجودة', 'ROOM_NOT_FOUND');
            const member = await this.db.Community.getCouncilMember(room.council_id, actor.id);
            if (!member) throw this._err(403, 'الغرفة لأعضاء المجلس — انضم للمجلس أولًا', 'NOT_A_MEMBER');
            return { room, member: { role: member.role }, council };
        }
        const member = await this.db.Community.getRoomMember(room.id, actor.id);
        if (!member) throw this._err(403, 'هذه غرفة خاصة — الوصول لأعضائها فقط', 'NOT_A_MEMBER');
        return { room, member };
    }

    /** غرفة المجلس — كسولة الإنشاء، عضوية المجلس شرط، وسباق الإنشاء محسوم بالفهرس. */
    async ensureCouncilRoom(actor, councilId) {
        const council = await this.db.Community.getCouncilById(councilId);
        if (!council || council.status !== 'active') throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        const member = await this.db.Community.getCouncilMember(council.id, actor.id);
        if (!member) throw this._err(403, 'الغرفة لأعضاء المجلس — انضم للمجلس أولًا', 'NOT_A_MEMBER');
        let room = await this.db.Community.getCouncilRoom(council.id);
        if (room) return { room, council, created: false };
        try {
            const id = await this.db.Community.createRoom({
                kind: 'council', councilId: council.id, name: 'غرفة ' + council.name, createdBy: actor.id
            });
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'room_auto_create',
                targetType: 'room', targetId: id, detail: 'غرفة مجلس «' + council.name + '» أُنشئت عند أول فتح'
            });
            room = await this.db.Community.getRoomById(id);
            return { room, council, created: true };
        } catch (e) {
            // سباق الإنشاء: الفهرس الفريد الجزئي رفض النسخة الثانية ← نقرأ الفائزة
            if (e && /UNIQUE constraint failed/i.test(String(e.message || ''))) {
                room = await this.db.Community.getCouncilRoom(council.id);
                if (room) return { room, council, created: false };
            }
            throw e;
        }
    }

    /** إنشاء غرفة خاصة — مشاركة اجتماعية ← الحارس الموحد. المنشئ owner تلقائيًا. */
    async createPrivate(actor, { name }) {
        const guard = await this.core.participationGuard(actor);
        if (!guard.allow) throw this._err(403, 'غير مؤهل للمشاركة حاليًا', guard.reason);
        const title = String(name || '').trim();
        if (title.length < 2 || title.length > 60) {
            throw this._err(400, 'اسم الغرفة مطلوب (2–60 حرفًا)', 'BAD_REQUEST');
        }
        const f = await this.filter.checkContent(title);
        if (!f.ok) throw this._err(422, 'اسم الغرفة يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
        // الإنشاء + مقعد المنشئ + التدقيق في معاملة واحدة
        return this.db.Community.atomic(async () => {
            const id = await this.db.Community.createRoom({ kind: 'private', name: title, createdBy: actor.id });
            await this.db.Community.addRoomMember(id, actor.id, 'owner');
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'room_create',
                targetType: 'room', targetId: id, detail: 'أنشأ غرفة خاصة «' + title + '»'
            });
            return { id, name: title, kind: 'private' };
        });
    }

    /** غرفي: غرف مجالسي القائمة + غرفي الخاصة النشطة بعضويتي في كل منها. */
    async listMine(actor) {
        const myCouncils = await this.db.Community.listMyCouncils(actor.id);
        const councilRooms = [];
        for (const c of myCouncils) {
            if (c.status !== 'active') continue;
            const room = await this.db.Community.getCouncilRoom(c.id);
            if (room && room.status === 'active') {
                councilRooms.push({
                    id: room.id, kind: 'council', name: room.name,
                    councilId: c.id, councilName: c.name, councilIcon: c.icon,
                    createdAt: room.created_at
                });
            }
        }
        const privates = await this.db.Community.listMyPrivateRooms(actor.id);
        return {
            councilRooms,
            privateRooms: privates.map(r => ({
                id: r.id, kind: 'private', name: r.name, myRole: r.my_role,
                mine: String(r.created_by) === String(actor.id), createdAt: r.created_at
            }))
        };
    }

    /** تفاصيل غرفة + أعضاؤها (وصول محروس) — الهوية عبر Projection فقط. */
    async getRoom(actor, roomId) {
        const { room, council } = await this.requireAccess(actor, roomId);
        const out = {
            id: room.id, kind: room.kind, name: room.name, status: room.status,
            createdAt: room.created_at, mine: String(room.created_by) === String(actor.id)
        };
        if (room.kind === 'council') {
            out.councilId = room.council_id;
            out.councilName = council ? council.name : null;
            out.membersCount = await this.db.Community.countCouncilMembers(room.council_id);
        } else {
            const members = await this.db.Community.listRoomMembers(room.id);
            const identities = await this.identity.resolveMany(members.map(m => m.user_id));
            out.members = members.map(m => ({
                userId: m.user_id, role: m.role,
                user: identities[String(m.user_id)] || null
            }));
            out.membersCount = members.length;
            out.myRole = (await this.db.Community.getRoomMember(room.id, actor.id)).role;
        }
        return out;
    }

    /** إضافة عضو لغرفة خاصة — المنشئ فقط، ولا تجاوز للحظر بين الطرفين. */
    async addMember(actor, roomId, targetUserId) {
        const room = await this.db.Community.getRoomById(roomId);
        if (!room || room.kind !== 'private') throw this._err(404, 'الغرفة غير موجودة', 'ROOM_NOT_FOUND');
        if (room.status !== 'active') throw this._err(409, 'الغرفة مغلقة', 'ROOM_CLOSED');
        if (String(room.created_by) !== String(actor.id)) {
            throw this._err(403, 'إضافة الأعضاء لمنشئ الغرفة فقط', 'NOT_ROOM_OWNER');
        }
        const tid = String(targetUserId || '');
        if (!tid) throw this._err(400, 'userId مطلوب', 'BAD_REQUEST');
        const target = await this.identity.resolveByUserId(tid);
        if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        if (await this.moderation.isBlockedEitherWay(actor.id, tid)) {
            throw this._err(403, 'لا يمكن إضافة هذا المستخدم', 'BLOCKED_INTERACTION');
        }
        const existing = await this.db.Community.getRoomMember(room.id, tid);
        if (existing) return { added: true, already: true };
        return this.db.Community.atomic(async () => {
            await this.db.Community.addRoomMember(room.id, tid, 'member');
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'room_member_add',
                targetType: 'room', targetId: room.id,
                detail: 'أضاف عضوًا إلى غرفة «' + room.name + '»'
            });
            return { added: true };
        });
    }

    /** إزالة عضو من غرفة خاصة — المنشئ فقط (المنشئ نفسه لا يُزال: يغلق الغرفة). */
    async removeMember(actor, roomId, targetUserId) {
        const room = await this.db.Community.getRoomById(roomId);
        if (!room || room.kind !== 'private') throw this._err(404, 'الغرفة غير موجودة', 'ROOM_NOT_FOUND');
        if (String(room.created_by) !== String(actor.id)) {
            throw this._err(403, 'إزالة الأعضاء لمنشئ الغرفة فقط', 'NOT_ROOM_OWNER');
        }
        const tid = String(targetUserId || '');
        if (String(actor.id) === tid) throw this._err(422, 'المنشئ يغلق الغرفة بدل إزالة نفسه', 'OWNER_CANNOT_LEAVE');
        const member = await this.db.Community.getRoomMember(room.id, tid);
        if (!member) throw this._err(404, 'العضو غير موجود في الغرفة', 'MEMBER_NOT_FOUND');
        return this.db.Community.atomic(async () => {
            await this.db.Community.removeRoomMember(room.id, tid);
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'room_member_remove',
                targetType: 'room', targetId: room.id,
                detail: 'أزال عضوًا من غرفة «' + room.name + '»'
            });
            return { removed: true };
        });
    }

    /** مغادرة ذاتية لغرفة خاصة — المنشئ لا يغادر (يغلق). لا تدقيق: انسحاب شخصي. */
    async leave(actor, roomId) {
        const room = await this.db.Community.getRoomById(roomId);
        if (!room || room.kind !== 'private') throw this._err(404, 'الغرفة غير موجودة', 'ROOM_NOT_FOUND');
        if (String(room.created_by) === String(actor.id)) {
            throw this._err(422, 'المنشئ يغلق الغرفة بدل مغادرتها', 'OWNER_CANNOT_LEAVE');
        }
        const member = await this.db.Community.getRoomMember(room.id, actor.id);
        if (!member) throw this._err(404, 'لست عضوًا في هذه الغرفة', 'NOT_A_MEMBER');
        await this.db.Community.removeRoomMember(room.id, actor.id);
        return { left: true };
    }

    /** إغلاق غرفة خاصة — المنشئ فقط. UPDATE المشروط يحسم السباق (changes=1). */
    async close(actor, roomId) {
        const room = await this.db.Community.getRoomById(roomId);
        if (!room || room.kind !== 'private') throw this._err(404, 'الغرفة غير موجودة', 'ROOM_NOT_FOUND');
        if (String(room.created_by) !== String(actor.id)) {
            throw this._err(403, 'إغلاق الغرفة لمنشئها فقط', 'NOT_ROOM_OWNER');
        }
        return this.db.Community.atomic(async () => {
            const r = await this.db.Community.closeRoom(room.id, actor.name);
            if (!r || r.changes !== 1) throw this._err(409, 'الغرفة مغلقة مسبقًا', 'ROOM_CLOSED');
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'room_close',
                targetType: 'room', targetId: room.id, detail: 'أغلق غرفة «' + room.name + '»'
            });
            return { closed: true };
        });
    }
}

module.exports = CommunityRoomService;
