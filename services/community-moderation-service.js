// ============================================
// CommunityModerationService — EMS Community C1 (اعتماد المالك الكتابي 2026-09-24)
// ============================================
// أساس الإشراف: Block / Report / Queue / Action / Audit.
//
// Block: من طرف واحد وأثره متبادل عمليًا — يمنع الرؤية والتفاعل والدعوات
// والاقتراحات والإشعارات الاجتماعية بين الطرفين (تُفرض عند كل مسار تفاعل C2+
// عبر isBlockedEitherWay). فوري، بلا إشعار للمحظور، ولا يفكّه إلا الحاظر.
//
// Report Workflow: مستخدم → community_reports(pending) → قائمة المشرف →
// إجراء → تدقيق. الإجراءات: none · warn · freeze · restrict · dismiss.
// hide/remove محجوزان للمحتوى (C2) — مرفوضان في C1 بلا كيانات محتوى.
// العتبة التلقائية (إخفاء عند تعدد البلاغات) تُفعَّل مع جداول المحتوى في C2 —
// لا محتوى في C1. الحذف النهائي قرار مشرف بشري دائمًا ولا يكون تلقائيًا أبدًا.
//
// الذرّية: كل عملية كاتبة (block/unblock/report/handleReport/liftRestriction)
// محمية بمعاملة قاعدة بيانات حقيقية (BEGIN/COMMIT/ROLLBACK — نمط
// permission-service نفسه): فشل أي خطوة (التحديث/التقييد/التدقيق) يُرجع
// العملية كاملة، فلا توجد حالة «report resolved بدون restriction أو بدون
// audit». كل إجراء يُسجَّل: من اتخذه · متى · السبب · الهدف · الإجراء.
// ============================================
'use strict';

const ACTIONS = Object.freeze(['none', 'warn', 'freeze', 'restrict', 'dismiss']);
const TARGET_TYPES = Object.freeze(['user', 'post', 'activity', 'majlis']);

class CommunityModerationService {
    constructor({ db, identity }) {
        if (!db) throw new Error('CommunityModerationService: db مطلوب');
        if (!identity) throw new Error('CommunityModerationService: identity مطلوب');
        this.db = db;
        this.identity = identity;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    /** تنفيذ عملية كاتبة داخل معاملة واحدة — الكل أو لا شيء. */
    async _atomic(fn) {
        this.db.beginTransaction();
        try {
            const out = await fn();
            this.db.commitTransaction();
            return out;
        } catch (e) {
            try { this.db.rollbackTransaction(); } catch (_) { }
            throw e;
        }
    }

    // ── Block ──
    async block(actor, targetUserId) {
        const tid = String(targetUserId || '');
        if (!tid) throw this._err(400, 'userId مطلوب', 'BAD_REQUEST');
        if (String(actor.id) === tid) throw this._err(422, 'لا يمكن حظر نفسك', 'SELF_BLOCK');
        const target = await this.identity.resolveByUserId(tid);
        if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        return this._atomic(async () => {
            await this.db.Community.addBlock(actor.id, tid);
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'block_create',
                targetType: 'user', targetId: tid, detail: 'حظر مستخدم (أثر متبادل عمليًا)'
            });
            return { blocked: true };
        });
    }

    async unblock(actor, targetUserId) {
        const tid = String(targetUserId || '');
        if (!tid) throw this._err(400, 'userId مطلوب', 'BAD_REQUEST');
        return this._atomic(async () => {
            await this.db.Community.removeBlock(actor.id, tid);
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'block_remove',
                targetType: 'user', targetId: tid, detail: 'فك حظر مستخدم'
            });
            return { blocked: false };
        });
    }

    async myBlocks(actor) {
        const rows = await this.db.Community.getBlocksBy(actor.id);
        const ids = rows.map(r => r.blocked_user_id);
        const identities = await this.identity.resolveMany(ids);
        return rows.map(r => ({
            userId: r.blocked_user_id,
            since: r.created_at,
            user: identities[String(r.blocked_user_id)] || null
        }));
    }

    /** فحص الحظر المتبادل الأثر — يُستدعى من كل مسار تفاعل (C2+). */
    async isBlockedEitherWay(a, b) {
        return this.db.Community.isBlockedEitherWay(a, b);
    }

    // ── Report ──
    async report(actor, { targetType, targetId, reason }) {
        if (TARGET_TYPES.indexOf(targetType) === -1) {
            throw this._err(422, 'نوع هدف غير معروف', 'BAD_TARGET_TYPE');
        }
        // C1: لا كيانات محتوى بعد — post/activity/majlis تُقبل مع C2/C3
        if (targetType !== 'user') {
            throw this._err(422, 'لا يوجد محتوى من هذا النوع في المرحلة الحالية', 'TARGET_NOT_AVAILABLE');
        }
        const tid = String(targetId || '');
        if (!tid) throw this._err(400, 'targetId مطلوب', 'BAD_REQUEST');
        if (String(actor.id) === tid) throw this._err(422, 'لا يمكن الإبلاغ عن نفسك', 'SELF_REPORT');
        const text = String(reason || '').trim();
        if (!text || text.length < 3) throw this._err(400, 'سبب الإبلاغ مطلوب', 'BAD_REQUEST');
        if (text.length > 500) throw this._err(400, 'سبب الإبلاغ طويل (الحد 500 حرف)', 'BAD_REQUEST');
        const target = await this.identity.resolveByUserId(tid);
        if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        return this._atomic(async () => {
            const id = await this.db.Community.createReport({
                reporterUserId: actor.id, reporterName: actor.name,
                targetType, targetId: tid, reason: text
            });
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'report_create',
                targetType, targetId: tid, detail: 'بلاغ جديد #' + id
            });
            return { id, status: 'pending' };
        });
    }

    async queue(status) {
        return this.db.Community.listReports(status || 'pending');
    }

    /**
     * معالجة بلاغ — العملية كلها (resolve + restriction + audit) داخل معاملة
     * واحدة: فشل أي خطوة يُرجعها جميعًا، فلا توجد حالة جزئية بلا تدقيق.
     */
    async handleReport(actor, reportId, { action, note }) {
        if (ACTIONS.indexOf(action) === -1) {
            throw this._err(422, 'إجراء غير معروف — المتاح: ' + ACTIONS.join(' / '), 'BAD_ACTION');
        }
        const report = await this.db.Community.getReportById(reportId);
        if (!report) throw this._err(404, 'البلاغ غير موجود', 'REPORT_NOT_FOUND');
        if (report.status !== 'pending') throw this._err(409, 'البلاغ عولج مسبقًا', 'ALREADY_HANDLED');

        return this._atomic(async () => {
            // حسم السباق داخل المعاملة: UPDATE الشرطي (WHERE status='pending') هو
            // نقطة القرار الوحيدة — طلب متزامن ثانٍ يجد الصف مُعالجًا فيعدّل 0 صف
            // ← ALREADY_HANDLED وROLLBACK، فلا restriction ولا audit مزدوجان أبدًا.
            const resolved = action === 'dismiss'
                ? await this.db.Community.resolveReport(reportId, {
                    status: 'dismissed', actionTaken: 'dismiss', handledById: actor.id, handledByName: actor.name
                })
                : await this.db.Community.resolveReport(reportId, {
                    status: 'resolved', actionTaken: action, handledById: actor.id, handledByName: actor.name
                });
            if (!resolved || resolved.changes !== 1) {
                throw this._err(409, 'البلاغ عولج مسبقًا', 'ALREADY_HANDLED');
            }
            if (action === 'freeze' || action === 'restrict') {
                await this.db.Community.addRestriction({
                    userId: report.target_id,
                    kind: action === 'freeze' ? 'participation_freeze' : 'participation_restrict',
                    scope: 'community',
                    reason: (note || '') || ('بلاغ #' + reportId),
                    createdBy: actor.name
                });
            }
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'report_handle',
                targetType: report.target_type, targetId: report.target_id,
                detail: 'بلاغ #' + reportId + ' ← ' + action + (note ? ' · ' + String(note).slice(0, 200) : '')
            });
            return { id: reportId, action, status: action === 'dismiss' ? 'dismissed' : 'resolved' };
        });
    }

    /** رفع تقييد (فك تجميد) — قرار مشرف ويُدقَّق داخل نفس المعاملة. */
    async liftRestriction(actor, restrictionId) {
        return this._atomic(async () => {
            await this.db.Community.liftRestriction(restrictionId, actor.name);
            await this.db.Community.audit({
                actorId: actor.id, actorName: actor.name, action: 'restriction_lift',
                targetType: 'restriction', targetId: restrictionId, detail: 'فك تقييد مشاركة #' + restrictionId
            });
            return { lifted: true };
        });
    }

    async auditTrail(limit, offset) {
        return this.db.Community.listAudit(limit, offset);
    }
}

CommunityModerationService.ACTIONS = ACTIONS;
CommunityModerationService.TARGET_TYPES = TARGET_TYPES;
module.exports = CommunityModerationService;
