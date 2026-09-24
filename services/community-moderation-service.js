// ============================================
// CommunityModerationService — EMS Community Full Foundation (اعتماد المالك 2026-09-24)
// ============================================
// الإشراف الكامل: Block / Report / Queue / Action / Audit — للمستخدمين والمحتوى.
//
// Block: من طرف واحد وأثره متبادل عمليًا — يمنع الرؤية والتفاعل والانضمام
// للأنشطة واستعراض الملفات بين الطرفين (تُفرض عبر isBlockedEitherWay و
// getBlockCounterparts في كل مسار تفاعل). فوري، بلا إشعار للمحظور، ولا يفكّه
// إلا الحاظر.
//
// Report Workflow: مستخدم → community_reports(pending) → قائمة المشرف →
// إجراء → تدقيق. الأهداف: user · post · activity · majlis (مع التحقق من وجود
// الهدف — لا بلاغات على أشباح). بلاغ pending واحد لكل (مبلِّغ، هدف) — منع
// الإغراق. الإجراءات: none · warn · freeze · restrict · dismiss لكل الأهداف،
// وhide/remove للمنشورات فقط. العتبة التلقائية: تعدد البلاغات على منشور ←
// إخفاء مؤقت (hidden) بانتظار مشرف بشري — الحذف النهائي قرار بشري دائمًا
// ولا يكون تلقائيًا أبدًا. إجراءات المستخدم (warn/freeze/restrict) تطال
// المسؤول عن الهدف: المستخدم نفسه، مؤلف المنشور، أو منشئ النشاط.
//
// الذرّية: كل عملية كاتبة محمية بمعاملة حقيقية (BEGIN/COMMIT/ROLLBACK):
// فشل أي خطوة (التحديث/التقييد/إخفاء المحتوى/التدقيق) يُرجع العملية كاملة،
// فلا توجد حالة «report resolved بدون restriction أو بدون audit».
// ============================================
'use strict';

const ACTIONS = Object.freeze(['none', 'warn', 'freeze', 'restrict', 'dismiss', 'hide', 'remove']);
const CONTENT_ACTIONS = Object.freeze(['hide', 'remove']); // لمنشورات المجالس فقط
const TARGET_TYPES = Object.freeze(['user', 'post', 'activity', 'majlis']);
const DEFAULT_AUTO_HIDE_THRESHOLD = 3;

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

    /** عتبة الإخفاء التلقائي للمنشورات — إدارية (اتجاه التشدد فقط: 2–20)، افتراضي 3. */
    async _autoHideThreshold() {
        const v = await this.db.Community.getSetting('auto_hide_threshold');
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 2 || n > 20) return DEFAULT_AUTO_HIDE_THRESHOLD;
        return n;
    }

    /** المستخدم المسؤول عن الهدف (تطاله warn/freeze/restrict) — null للمجالس. */
    async _resolveTargetUser(report) {
        if (report.target_type === 'user') return report.target_id;
        if (report.target_type === 'post') {
            const post = await this.db.Community.getPostById(report.target_id);
            return post ? post.author_user_id : null;
        }
        if (report.target_type === 'activity') {
            const a = await this.db.Community.getActivityById(report.target_id);
            return a ? a.created_by : null;
        }
        return null; // majlis — كيان بلا مستخدم مسؤول مباشر
    }

    // ── Report ──
    async report(actor, { targetType, targetId, reason }) {
        if (TARGET_TYPES.indexOf(targetType) === -1) {
            throw this._err(422, 'نوع هدف غير معروف', 'BAD_TARGET_TYPE');
        }
        const tid = String(targetId || '');
        if (!tid) throw this._err(400, 'targetId مطلوب', 'BAD_REQUEST');
        const text = String(reason || '').trim();
        if (!text || text.length < 3) throw this._err(400, 'سبب الإبلاغ مطلوب', 'BAD_REQUEST');
        if (text.length > 500) throw this._err(400, 'سبب الإبلاغ طويل (الحد 500 حرف)', 'BAD_REQUEST');
        // التحقق من وجود الهدف حسب نوعه — لا بلاغات على أشباح ولا user enumeration
        if (targetType === 'user') {
            if (String(actor.id) === tid) throw this._err(422, 'لا يمكن الإبلاغ عن نفسك', 'SELF_REPORT');
            const target = await this.identity.resolveByUserId(tid);
            if (!target) throw this._err(404, 'المستخدم غير موجود', 'USER_NOT_FOUND');
        } else if (targetType === 'post') {
            const post = await this.db.Community.getPostById(tid);
            if (!post || post.status === 'removed') throw this._err(404, 'المنشور غير موجود', 'POST_NOT_FOUND');
            if (String(post.author_user_id) === String(actor.id)) {
                throw this._err(422, 'لا يمكن الإبلاغ عن محتواك', 'SELF_REPORT');
            }
        } else if (targetType === 'activity') {
            const a = await this.db.Community.getActivityById(tid);
            if (!a || a.status === 'disabled') throw this._err(404, 'النشاط غير موجود', 'ACTIVITY_NOT_FOUND');
        } else if (targetType === 'majlis') {
            const c = await this.db.Community.getCouncilById(tid);
            if (!c) throw this._err(404, 'المجلس غير موجود', 'COUNCIL_NOT_FOUND');
        }
        // منع إغراق البلاغات: بلاغ pending واحد لكل (مبلِّغ، هدف)
        const dup = await this.db.Community.getPendingReportByReporter(actor.id, targetType, tid);
        if (dup) throw this._err(409, 'لديك بلاغ قائم على هذا الهدف بانتظار المعالجة', 'DUPLICATE_REPORT');
        return this._atomic(async () => {
            const id = await this.db.Community.createReport({
                reporterUserId: actor.id, reporterName: actor.name,
                targetType, targetId: tid, reason: text
            });
            // العتبة التلقائية: تعدد البلاغات على منشور ← إخفاء مؤقت بانتظار قرار
            // مشرف بشري (hidden وليس removed — الحذف لا يكون تلقائيًا أبدًا)
            if (targetType === 'post') {
                const threshold = await this._autoHideThreshold();
                const pending = await this.db.Community.countPendingForTarget('post', tid);
                if (pending >= threshold) {
                    await this.db.Community.setPostStatus(tid, 'hidden', 'auto:' + threshold + '-reports');
                    await this.db.Community.audit({
                        actorId: null, actorName: 'system', action: 'post_auto_hide',
                        targetType: 'post', targetId: tid,
                        detail: 'إخفاء تلقائي مؤقت عند بلوغ ' + pending + ' بلاغًا — بانتظار قرار مشرف بشري'
                    });
                }
            }
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
     * معالجة بلاغ — العملية كلها (resolve + restriction/إخفاء المحتوى + audit)
     * داخل معاملة واحدة: فشل أي خطوة يُرجعها جميعًا، فلا توجد حالة جزئية بلا تدقيق.
     * hide/remove لمنشورات المجالس فقط؛ warn/freeze/restrict تطال المسؤول عن
     * الهدف (المستخدم/المؤلف/المنشئ) — وترفض للمجالس (لا مستخدم مسؤول).
     */
    async handleReport(actor, reportId, { action, note }) {
        if (ACTIONS.indexOf(action) === -1) {
            throw this._err(422, 'إجراء غير معروف — المتاح: ' + ACTIONS.join(' / '), 'BAD_ACTION');
        }
        const report = await this.db.Community.getReportById(reportId);
        if (!report) throw this._err(404, 'البلاغ غير موجود', 'REPORT_NOT_FOUND');
        if (report.status !== 'pending') throw this._err(409, 'البلاغ عولج مسبقًا', 'ALREADY_HANDLED');
        const isContentAction = CONTENT_ACTIONS.indexOf(action) !== -1;
        if (isContentAction && report.target_type !== 'post') {
            throw this._err(422, 'إجراءات hide/remove لمنشورات المجالس فقط', 'BAD_ACTION');
        }
        const targetUserId = await this._resolveTargetUser(report);
        if (['warn', 'freeze', 'restrict'].indexOf(action) !== -1 && !targetUserId) {
            throw this._err(422, 'لا يوجد مستخدم مسؤول عن هذا الهدف لإجراء ' + action, 'BAD_ACTION');
        }

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
                    userId: targetUserId,
                    kind: action === 'freeze' ? 'participation_freeze' : 'participation_restrict',
                    scope: 'community',
                    reason: (note || '') || ('بلاغ #' + reportId),
                    createdBy: actor.name
                });
            }
            if (isContentAction) {
                await this.db.Community.setPostStatus(
                    report.target_id, action === 'hide' ? 'hidden' : 'removed', actor.name);
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
CommunityModerationService.CONTENT_ACTIONS = CONTENT_ACTIONS;
CommunityModerationService.TARGET_TYPES = TARGET_TYPES;
module.exports = CommunityModerationService;
