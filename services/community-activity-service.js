// ============================================
// CommunityActivityService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// Framework عام للأنشطة: Community → Activities → Activity Types
// (بلوت/قهوة/كرة قدم/بادل/عشاء/تجمع/تحدٍ/فعالية — وأي نوع مستقبلي بلا تعديل بنيوي).
// محرك البلوت اللحظي مرحلة مستقلة لاحقة — لا WebSocket/SSE هنا إطلاقًا.
//
// الفعالية الواقعية: عنوان + موعد + مكان نصي يكتبه المنظم (location_text نص حر —
// ليس تتبعًا ولا إحداثيات ولا يُقرأ من أي مصدر تشغيلي) + مشاركون وحالة مشاركة.
//
// الأهلية خادمية: الإنشاء والانضمام يمران بحارس المشاركة الموحد (البوابة
// التشغيلية الثابتة) — لا يُعتمد على قول العميل «أنا غير مشغول».
// الحظر متبادل الأثر: من حظره المنشئ (أو حظر المنشئَ) لا ينضم لنشاطه.
// ============================================
'use strict';

const ACTIVITY_STATUS = Object.freeze(['open', 'ongoing', 'completed', 'cancelled', 'disabled']);
const COMPETITIVE_STATUS = Object.freeze(['open', 'ongoing']); // الانضمام لهذه فقط

class CommunityActivityService {
    constructor({ db, identity, core, filter, moderation }) {
        if (!db) throw new Error('CommunityActivityService: db مطلوب');
        if (!identity) throw new Error('CommunityActivityService: identity مطلوب');
        if (!core) throw new Error('CommunityActivityService: core (CommunityService) مطلوب');
        if (!filter) throw new Error('CommunityActivityService: filter مطلوب');
        if (!moderation) throw new Error('CommunityActivityService: moderation مطلوب');
        this.db = db;
        this.identity = identity;
        this.core = core;
        this.filter = filter;
        this.moderation = moderation; // isBlockedEitherWay
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    async _filterOrThrow(fields) {
        for (const [txt, label] of fields) {
            if (txt == null) continue;
            const f = await this.filter.checkContent(txt);
            if (!f.ok) throw this._err(422, label + ' يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
        }
    }

    _shape(a, extra) {
        return Object.assign({
            id: a.id, typeId: a.type_id, typeKey: a.type_key, typeName: a.type_name, typeIcon: a.type_icon,
            councilId: a.council_id, title: a.title, description: a.description,
            locationText: a.location_text, // نص منظم فقط — ليس موقعًا تشغيليًا
            startsAt: a.starts_at, endsAt: a.ends_at, maxParticipants: a.max_participants,
            status: a.status, createdBy: a.created_by, createdByName: a.created_by_name,
            createdAt: a.created_at
        }, extra || {});
    }

    // ── أنواع الأنشطة ──
    async listTypes() {
        return this.db.Community.listActivityTypes(true);
    }

    /** إنشاء/تحديث نوع — community.admin عبر المسار. */
    async createType(actor, { key, name, description, icon }) {
        const k = String(key || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(k)) {
            throw this._err(422, 'key غير صالح (أحرف إنجليزية صغيرة/أرقام/شرطة)', 'BAD_KEY');
        }
        const n = String(name || '').trim();
        if (n.length < 2 || n.length > 60) throw this._err(400, 'اسم النوع مطلوب (2–60 حرفًا)', 'BAD_REQUEST');
        await this._filterOrThrow([[n, 'اسم النوع'], [description, 'الوصف']]);
        const existing = await this.db.Community.getActivityTypeByKey(k);
        if (existing) throw this._err(409, 'يوجد نوع نشاط بهذا المعرف', 'KEY_TAKEN');
        const id = await this.db.Community.createActivityType({
            key: k, name: n, description: description ? String(description).slice(0, 300) : null,
            icon: icon ? String(icon).slice(0, 16) : null
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'activity_type_create',
            targetType: 'activity_type', targetId: id, detail: 'نوع نشاط جديد «' + n + '» (' + k + ')'
        });
        return { id, key: k };
    }

    async updateType(actor, id, { name, description, icon, enabled }) {
        const t = await this.db.Community.getActivityTypeById(id);
        if (!t) throw this._err(404, 'نوع النشاط غير موجود', 'TYPE_NOT_FOUND');
        if (name != null) await this._filterOrThrow([[name, 'اسم النوع']]);
        if (description != null) await this._filterOrThrow([[description, 'الوصف']]);
        await this.db.Community.updateActivityType(id, {
            name: name != null ? String(name).trim() : null,
            description: description != null ? String(description).slice(0, 300) : null,
            icon: icon != null ? String(icon).slice(0, 16) : null,
            enabled: typeof enabled === 'boolean' ? enabled : null
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'activity_type_update',
            targetType: 'activity_type', targetId: id,
            detail: 'تحديث نوع «' + t.name + '»' + (typeof enabled === 'boolean' ? (enabled ? ' ← تفعيل' : ' ← تعطيل') : '')
        });
        return { id, updated: true };
    }

    // ── الأنشطة ──
    /** إنشاء نشاط — community.create_activity عبر المسار + الحارس هنا. المنشئ ينضم تلقائيًا. */
    async create(actor, { typeId, councilId, title, description, locationText, startsAt, endsAt, maxParticipants }) {
        const guard = await this.core.participationGuard(actor);
        if (!guard.allow) throw this._err(403, 'غير مؤهل للمشاركة حاليًا', guard.reason);
        const type = await this.db.Community.getActivityTypeById(typeId);
        if (!type || !type.enabled) throw this._err(404, 'نوع النشاط غير موجود', 'TYPE_NOT_FOUND');
        let council = null;
        if (councilId != null) {
            council = await this.db.Community.getCouncilById(councilId);
            if (!council || council.status !== 'active') throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        }
        const t = String(title || '').trim();
        if (t.length < 2 || t.length > 120) throw this._err(400, 'عنوان النشاط مطلوب (2–120 حرفًا)', 'BAD_REQUEST');
        if (maxParticipants != null) {
            const mp = parseInt(maxParticipants, 10);
            if (!Number.isInteger(mp) || mp < 2 || mp > 500) {
                throw this._err(422, 'الحد الأقصى للمشاركين (2–500)', 'BAD_CAPACITY');
            }
            maxParticipants = mp;
        }
        // المكان نص حر من المنظم — يُفلتر مثل أي UGC، ولا يُقبل أي تنسيق إحداثيات
        await this._filterOrThrow([[t, 'العنوان'], [description, 'الوصف'], [locationText, 'المكان']]);
        const me = await this.identity.resolveByUser(actor);
        const id = await this.db.Community.createActivity({
            typeId: type.id, councilId: council ? council.id : null, title: t,
            description: description ? String(description).slice(0, 1000) : null,
            locationText: locationText ? String(locationText).slice(0, 200) : null,
            startsAt: startsAt || null, endsAt: endsAt || null,
            maxParticipants: maxParticipants ?? null,
            createdBy: actor.id, createdByName: me ? me.display_name : actor.name
        });
        await this.db.Community.joinActivity(id, actor.id); // المنشئ مشارك أول
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'activity_create',
            targetType: 'activity', targetId: id, detail: 'نشاط «' + t + '» (' + type.name + ')'
        });
        return { id, status: 'open' };
    }

    async get(actor, id) {
        const a = await this.db.Community.getActivityById(id);
        if (!a || a.status === 'disabled') throw this._err(404, 'النشاط غير موجود', 'ACTIVITY_NOT_FOUND');
        const me = await this.db.Community.getActivityParticipant(a.id, actor.id);
        return this._shape(a, {
            participants_count: await this.db.Community.countActivityParticipants(a.id),
            my_status: me ? me.status : null
        });
    }

    async list(actor, { status, councilId, limit = 20, offset = 0 } = {}) {
        const rows = await this.db.Community.listActivities({ status, councilId, limit, offset });
        return rows.map(a => this._shape(a, { participants_count: a.participants_count }));
    }

    /** تعديل/إلغاء نشاط — المنشئ فقط (الإشراف على أنشطة الغير عبر مسار moderate منفصل). */
    async updateOwn(actor, id, fields) {
        const a = await this.db.Community.getActivityById(id);
        if (!a || a.status === 'disabled') throw this._err(404, 'النشاط غير موجود', 'ACTIVITY_NOT_FOUND');
        if (String(a.created_by) !== String(actor.id)) {
            throw this._err(403, 'تعديل النشاط لمنشئه فقط', 'NOT_CREATOR');
        }
        if (fields.status && ACTIVITY_STATUS.indexOf(fields.status) === -1) {
            throw this._err(422, 'حالة غير معروفة (' + ACTIVITY_STATUS.join('/') + ')', 'BAD_STATUS');
        }
        if (fields.status === 'disabled') throw this._err(422, 'تعطيل النشاط قرار إشرافي', 'BAD_STATUS');
        if (fields.maxParticipants != null) {
            const mp = parseInt(fields.maxParticipants, 10);
            if (!Number.isInteger(mp) || mp < 2 || mp > 500) throw this._err(422, 'الحد الأقصى (2–500)', 'BAD_CAPACITY');
            fields.maxParticipants = mp;
        }
        await this._filterOrThrow([[fields.title, 'العنوان'], [fields.description, 'الوصف'], [fields.locationText, 'المكان']]);
        await this.db.Community.updateActivity(id, {
            title: fields.title != null ? String(fields.title).trim() : null,
            description: fields.description != null ? String(fields.description).slice(0, 1000) : null,
            locationText: fields.locationText != null ? String(fields.locationText).slice(0, 200) : null,
            startsAt: fields.startsAt || null, endsAt: fields.endsAt || null,
            maxParticipants: fields.maxParticipants ?? null, status: fields.status || null
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'activity_update',
            targetType: 'activity', targetId: id, detail: 'تحديث نشاط «' + a.title + '»' + (fields.status ? ' ← ' + fields.status : '')
        });
        return { id, updated: true };
    }

    /**
     * الانضمام لنشاط — community.join_activity عبر المسار.
     * الأهلية: الحارس الموحد + النشاط مفتوح + السعة + لا حظر متبادل الأثر مع المنشئ.
     */
    async join(actor, id) {
        const a = await this.db.Community.getActivityById(id);
        if (!a || a.status === 'disabled') throw this._err(404, 'النشاط غير موجود', 'ACTIVITY_NOT_FOUND');
        const guard = await this.core.participationGuard(actor);
        if (!guard.allow) throw this._err(403, 'غير مؤهل للمشاركة حاليًا', guard.reason);
        if (COMPETITIVE_STATUS.indexOf(a.status) === -1) {
            throw this._err(409, 'النشاط لم يعد يقبل المشاركين (' + a.status + ')', 'ACTIVITY_CLOSED');
        }
        const blocked = await this.moderation.isBlockedEitherWay(actor.id, a.created_by);
        if (blocked) throw this._err(403, 'لا يمكن الانضمام لهذا النشاط', 'BLOCKED_INTERACTION');
        const existing = await this.db.Community.getActivityParticipant(a.id, actor.id);
        if (existing && existing.status === 'joined') return { joined: true, already: true };
        if (a.max_participants != null) {
            const count = await this.db.Community.countActivityParticipants(a.id);
            if (count >= a.max_participants) throw this._err(409, 'اكتمل عدد المشاركين', 'ACTIVITY_FULL');
        }
        await this.db.Community.joinActivity(a.id, actor.id);
        return { joined: true };
    }

    async leave(actor, id) {
        const a = await this.db.Community.getActivityById(id);
        if (!a) throw this._err(404, 'النشاط غير موجود', 'ACTIVITY_NOT_FOUND');
        const r = await this.db.Community.leaveActivity(a.id, actor.id);
        if (!r || r.changes !== 1) throw this._err(404, 'لست مشاركًا في هذا النشاط', 'NOT_JOINED');
        return { left: true };
    }

    /** قائمة المشاركين: Projection + استبعاد الحظر المتبادل + Pagination. */
    async participants(actor, id, { limit = 100, offset = 0 } = {}) {
        const a = await this.db.Community.getActivityById(id);
        if (!a || a.status === 'disabled') throw this._err(404, 'النشاط غير موجود', 'ACTIVITY_NOT_FOUND');
        const excluded = new Set(await this.db.Community.getBlockCounterparts(actor.id));
        const rows = (await this.db.Community.listActivityParticipants(a.id, { status: 'joined', limit, offset }))
            .filter(r => !excluded.has(String(r.user_id)));
        const identities = await this.identity.resolveMany(rows.map(r => r.user_id));
        return rows.map(r => ({
            userId: r.user_id, joinedAt: r.joined_at,
            user: identities[String(r.user_id)] || null
        }));
    }

    /** تعطيل نشاط إشرافيًا (community.moderate عبر المسار) — لا حذف للأنشطة. */
    async moderateSetStatus(actor, id, status, note) {
        if (['disabled', 'cancelled'].indexOf(status) === -1) {
            throw this._err(422, 'الحالة الإشرافية المتاحة: disabled / cancelled', 'BAD_STATUS');
        }
        const a = await this.db.Community.getActivityById(id);
        if (!a) throw this._err(404, 'النشاط غير موجود', 'ACTIVITY_NOT_FOUND');
        await this.db.Community.updateActivity(id, { status });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'activity_moderate',
            targetType: 'activity', targetId: id,
            detail: 'نشاط «' + a.title + '» ← ' + status + (note ? ' · ' + String(note).slice(0, 200) : '')
        });
        return { id, status };
    }
}

CommunityActivityService.ACTIVITY_STATUS = ACTIVITY_STATUS;
module.exports = CommunityActivityService;
