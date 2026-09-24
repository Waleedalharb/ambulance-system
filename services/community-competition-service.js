// ============================================
// CommunityCompetitionService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// المنافسات: بنية عامة لمنافسات الفرق/المراكز/الأفراد + ترتيب ونتائج وشارات.
//
// ⛔ لا Gambling بحكم التصميم: لا يوجد في الجداول ولا الـAPI أي عمود مال أو
// رهان أو رسوم دخول أو جائزة نقدية (Paid Entry). النتائج نقاط وترتيب وملاحظات
// معنوية فقط، والجوائز شارات (community_badges) لا قيمة نقدية لها.
//
// participant_label نص حر (اسم فريق/مركز) — لا FK لجداول teams/centers
// التشغيلية (عزل قاعدة البيانات). مشاركة الأفراد بانضمام ذاتي؛ الفرق/المراكز
// تُدار تسمياتها من الإدارة.
// ============================================
'use strict';

const COMP_STATUS = Object.freeze(['draft', 'open', 'ongoing', 'completed', 'cancelled', 'disabled']);
const COMP_SCOPE = Object.freeze(['teams', 'centers', 'individuals']);

class CommunityCompetitionService {
    constructor({ db, identity, core, filter }) {
        if (!db) throw new Error('CommunityCompetitionService: db مطلوب');
        if (!identity) throw new Error('CommunityCompetitionService: identity مطلوب');
        if (!core) throw new Error('CommunityCompetitionService: core (CommunityService) مطلوب');
        if (!filter) throw new Error('CommunityCompetitionService: filter مطلوب');
        this.db = db;
        this.identity = identity;
        this.core = core;
        this.filter = filter;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    _shape(c, extra) {
        return Object.assign({
            id: c.id, name: c.name, description: c.description, scope: c.scope,
            activityId: c.activity_id, status: c.status, rules: c.rules,
            startsAt: c.starts_at, endsAt: c.ends_at, createdAt: c.created_at
        }, extra || {});
    }

    async _filterOrThrow(fields) {
        for (const [txt, label] of fields) {
            if (txt == null) continue;
            const f = await this.filter.checkContent(txt);
            if (!f.ok) throw this._err(422, label + ' يحتوي محتوى مخالفًا للسياسة', 'FILTER_REJECTED');
        }
    }

    async list(actor, { status, limit = 20, offset = 0 } = {}) {
        const rows = await this.db.Community.listCompetitions({ status, limit, offset });
        return rows.map(c => this._shape(c));
    }

    async get(actor, id) {
        const c = await this.db.Community.getCompetitionById(id);
        if (!c || c.status === 'disabled') throw this._err(404, 'المنافسة غير موجودة', 'COMPETITION_NOT_FOUND');
        return this._shape(c, {
            participants: await this.db.Community.listCompetitionParticipants(c.id)
        });
    }

    /** إنشاء منافسة — community.admin عبر المسار. */
    async create(actor, { name, description, scope, activityId, rules, startsAt, endsAt }) {
        const n = String(name || '').trim();
        if (n.length < 2 || n.length > 120) throw this._err(400, 'اسم المنافسة مطلوب (2–120 حرفًا)', 'BAD_REQUEST');
        if (scope && COMP_SCOPE.indexOf(scope) === -1) {
            throw this._err(422, 'نطاق غير معروف (' + COMP_SCOPE.join('/') + ')', 'BAD_SCOPE');
        }
        await this._filterOrThrow([[n, 'الاسم'], [description, 'الوصف'], [rules, 'القواعد']]);
        if (activityId != null) {
            const a = await this.db.Community.getActivityById(activityId);
            if (!a) throw this._err(404, 'النشاط المرتبط غير موجود', 'ACTIVITY_NOT_FOUND');
        }
        const id = await this.db.Community.createCompetition({
            name: n, description: description ? String(description).slice(0, 1000) : null,
            scope: scope || 'teams', activityId: activityId ?? null,
            rules: rules ? String(rules).slice(0, 2000) : null,
            startsAt: startsAt || null, endsAt: endsAt || null, createdBy: actor.name
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'competition_create',
            targetType: 'competition', targetId: id, detail: 'منافسة «' + n + '» (' + (scope || 'teams') + ')'
        });
        return { id };
    }

    /** تحديث منافسة (بما فيه الحالة) — community.admin عبر المسار. */
    async update(actor, id, { name, description, scope, status, rules, startsAt, endsAt, activityId }) {
        const c = await this.db.Community.getCompetitionById(id);
        if (!c) throw this._err(404, 'المنافسة غير موجودة', 'COMPETITION_NOT_FOUND');
        if (status && COMP_STATUS.indexOf(status) === -1) {
            throw this._err(422, 'حالة غير معروفة (' + COMP_STATUS.join('/') + ')', 'BAD_STATUS');
        }
        if (scope && COMP_SCOPE.indexOf(scope) === -1) {
            throw this._err(422, 'نطاق غير معروف (' + COMP_SCOPE.join('/') + ')', 'BAD_SCOPE');
        }
        await this._filterOrThrow([[name, 'الاسم'], [description, 'الوصف'], [rules, 'القواعد']]);
        await this.db.Community.updateCompetition(id, {
            name: name != null ? String(name).trim() : null,
            description: description != null ? String(description).slice(0, 1000) : null,
            scope: scope || null, status: status || null,
            rules: rules != null ? String(rules).slice(0, 2000) : null,
            startsAt: startsAt || null, endsAt: endsAt || null, activityId: activityId ?? null
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'competition_update',
            targetType: 'competition', targetId: id,
            detail: 'تحديث منافسة «' + c.name + '»' + (status ? ' ← ' + status : '')
        });
        return { id, updated: true };
    }

    /**
     * انضمام ذاتي لمنافسة أفراد — community.tournament عبر المسار + الحارس
     * الموحد (البوابة التشغيلية). الفرق/المراكز تُضاف من الإدارة فقط.
     */
    async join(actor, id) {
        const c = await this.db.Community.getCompetitionById(id);
        if (!c || c.status === 'disabled') throw this._err(404, 'المنافسة غير موجودة', 'COMPETITION_NOT_FOUND');
        if (c.scope !== 'individuals') {
            throw this._err(422, 'الانضمام الذاتي لمنافسات الأفراد فقط — الفرق/المراكز تُدار من الإدارة', 'BAD_SCOPE');
        }
        if (['open', 'ongoing'].indexOf(c.status) === -1) {
            throw this._err(409, 'المنافسة لا تقبل مشاركين حاليًا (' + c.status + ')', 'COMPETITION_CLOSED');
        }
        const guard = await this.core.participationGuard(actor);
        if (!guard.allow) throw this._err(403, 'غير مؤهل للمشاركة حاليًا', guard.reason);
        const me = await this.identity.resolveByUser(actor);
        await this.db.Community.addCompetitionParticipant({
            competitionId: c.id, label: me ? me.display_name : actor.name, userId: actor.id
        });
        return { joined: true };
    }

    /** إضافة/إزالة مشارك (تسمية فريق/مركز/فرد) — community.admin عبر المسار. */
    async addParticipant(actor, id, { label, userId }) {
        const c = await this.db.Community.getCompetitionById(id);
        if (!c) throw this._err(404, 'المنافسة غير موجودة', 'COMPETITION_NOT_FOUND');
        const l = String(label || '').trim();
        if (l.length < 2 || l.length > 80) throw this._err(400, 'تسمية المشارك مطلوبة (2–80 حرفًا)', 'BAD_REQUEST');
        await this._filterOrThrow([[l, 'تسمية المشارك']]);
        if (userId != null) {
            const target = await this.identity.resolveByUserId(userId);
            if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        }
        await this.db.Community.addCompetitionParticipant({ competitionId: c.id, label: l, userId: userId ?? null });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'competition_participant_add',
            targetType: 'competition', targetId: id, detail: 'إضافة «' + l + '» لمنافسة «' + c.name + '»'
        });
        return { added: true };
    }

    async removeParticipant(actor, participantId) {
        const p = await this.db.Community.getCompetitionParticipant(participantId);
        if (!p) throw this._err(404, 'المشارك غير موجود', 'PARTICIPANT_NOT_FOUND');
        const r = await this.db.Community.removeCompetitionParticipant(participantId);
        if (!r || r.changes !== 1) throw this._err(404, 'المشارك غير موجود', 'PARTICIPANT_NOT_FOUND');
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'competition_participant_remove',
            targetType: 'competition', targetId: p.competition_id, detail: 'إزالة «' + p.participant_label + '»'
        });
        return { removed: true };
    }

    /** تسجيل نقاط/ترتيب/نتيجة — community.admin عبر المسار، ويُدقَّق دائمًا. */
    async updateResult(actor, participantId, { score, rank, resultNote }) {
        const p = await this.db.Community.getCompetitionParticipant(participantId);
        if (!p) throw this._err(404, 'المشارك غير موجود', 'PARTICIPANT_NOT_FOUND');
        if (score != null) {
            const s = parseInt(score, 10);
            if (!Number.isInteger(s) || s < 0 || s > 100000) throw this._err(422, 'نقاط غير صالحة', 'BAD_SCORE');
            score = s;
        }
        if (rank != null) {
            const r2 = parseInt(rank, 10);
            if (!Number.isInteger(r2) || r2 < 1 || r2 > 1000) throw this._err(422, 'ترتيب غير صالح', 'BAD_RANK');
            rank = r2;
        }
        if (resultNote != null) await this._filterOrThrow([[resultNote, 'ملاحظة النتيجة']]);
        await this.db.Community.updateCompetitionParticipant(participantId, {
            score: score ?? null, rank: rank ?? null,
            resultNote: resultNote != null ? String(resultNote).slice(0, 300) : null
        });
        await this.db.Community.audit({
            actorId: actor.id, actorName: actor.name, action: 'competition_result',
            targetType: 'competition', targetId: p.competition_id,
            detail: 'نتيجة «' + p.participant_label + '»' +
                (score != null ? ' نقاط=' + score : '') + (rank != null ? ' ترتيب=' + rank : '')
        });
        return { updated: true };
    }
}

CommunityCompetitionService.COMP_STATUS = COMP_STATUS;
CommunityCompetitionService.COMP_SCOPE = COMP_SCOPE;
module.exports = CommunityCompetitionService;
