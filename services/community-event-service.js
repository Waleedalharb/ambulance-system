// ============================================
// CommunityEventService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// المناسبات: نظام Generic — يوم وطني/تأسيس/رمضان/عيد/مناسبات EMS/القطاع/داخلية.
// تُضاف مناسبة جديدة من الإدارة بلا أي تعديل بنيوي: عنوان/أيقونة/وصف/تواريخ/
// Banner/حالة/ربط اختياري بنشاط. المحتوى يُفلتر، والأفعال تُدقَّق.
// ============================================
'use strict';

const EVENT_STATUS = Object.freeze(['active', 'inactive']);

class CommunityEventService {
    constructor({ db, identity, filter }) {
        if (!db) throw new Error('CommunityEventService: db مطلوب');
        if (!identity) throw new Error('CommunityEventService: identity مطلوب');
        if (!filter) throw new Error('CommunityEventService: filter مطلوب');
        this.db = db;
        this.identity = identity;
        this.filter = filter;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    _shape(e) {
        return {
            id: e.id, title: e.title, icon: e.icon, description: e.description, banner: e.banner,
            startsAt: e.starts_at, endsAt: e.ends_at, status: e.status,
            linkedActivityId: e.linked_activity_id, createdAt: e.created_at
        };
    }

    async _filterOrThrow(fields) {
        for (const [txt, label] of fields) {
            if (txt == null) continue;
            const f = await this.filter.checkContent(txt);
            if (!f.ok) throw this._err(422, label + ' يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
        }
    }

    /** المناسبات الظاهرة للأعضاء: النشطة ضمن نافذتها الزمنية. */
    async listCurrent() {
        const rows = await this.db.Community.listEvents({ currentOnly: true, limit: 50 });
        return rows.map(e => this._shape(e));
    }

    /** كل المناسبات (إدارة). */
    async listAll({ limit = 50, offset = 0 } = {}) {
        const rows = await this.db.Community.listEvents({ limit, offset });
        return rows.map(e => this._shape(e));
    }

    /** إنشاء مناسبة — community.admin عبر المسار. */
    async create(actor, { title, icon, description, banner, startsAt, endsAt, linkedActivityId }) {
        const t = String(title || '').trim();
        if (t.length < 2 || t.length > 120) throw this._err(400, 'عنوان المناسبة مطلوب (2–120 حرفًا)', 'BAD_REQUEST');
        await this._filterOrThrow([[t, 'العنوان'], [description, 'الوصف']]);
        if (linkedActivityId != null) {
            const a = await this.db.Community.getActivityById(linkedActivityId);
            if (!a) throw this._err(404, 'النشاط المرتبط غير موجود', 'ACTIVITY_NOT_FOUND');
        }
        // الإنشاء + التدقيق في معاملة واحدة
        return this.db.Community.atomic(async () => {
            const id = await this.db.Community.createEvent({
                title: t, icon: icon ? String(icon).slice(0, 16) : null,
                description: description ? String(description).slice(0, 1000) : null,
                banner: banner ? String(banner).slice(0, 500) : null,
                startsAt: startsAt || null, endsAt: endsAt || null,
                linkedActivityId: linkedActivityId ?? null, createdBy: actor.name
            });
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'event_create',
                targetType: 'event', targetId: id, detail: 'مناسبة «' + t + '»'
            });
            return { id };
        });
    }

    /** تحديث مناسبة — community.admin عبر المسار. */
    async update(actor, id, { title, icon, description, banner, startsAt, endsAt, status, linkedActivityId }) {
        const e = await this.db.Community.getEventById(id);
        if (!e) throw this._err(404, 'المناسبة غير موجودة', 'EVENT_NOT_FOUND');
        if (status && EVENT_STATUS.indexOf(status) === -1) {
            throw this._err(422, 'حالة غير معروفة (active/inactive)', 'BAD_STATUS');
        }
        await this._filterOrThrow([[title, 'العنوان'], [description, 'الوصف']]);
        if (linkedActivityId != null) {
            const a = await this.db.Community.getActivityById(linkedActivityId);
            if (!a) throw this._err(404, 'النشاط المرتبط غير موجود', 'ACTIVITY_NOT_FOUND');
        }
        // التحديث + التدقيق في معاملة واحدة
        return this.db.Community.atomic(async () => {
            await this.db.Community.updateEvent(id, {
                title: title != null ? String(title).trim() : null,
                icon: icon != null ? String(icon).slice(0, 16) : null,
                description: description != null ? String(description).slice(0, 1000) : null,
                banner: banner != null ? String(banner).slice(0, 500) : null,
                startsAt: startsAt || null, endsAt: endsAt || null,
                status: status || null, linkedActivityId: linkedActivityId ?? null
            });
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'event_update',
                targetType: 'event', targetId: id,
                detail: 'تحديث مناسبة «' + e.title + '»' + (status ? ' ← ' + status : '')
            });
            return { id, updated: true };
        });
    }
}

module.exports = CommunityEventService;
