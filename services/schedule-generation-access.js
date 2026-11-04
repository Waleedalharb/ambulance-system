'use strict';

const GENERATE_PERMISSION = 'schedule.generate';

class ScheduleGenerationAccessError extends Error {
    constructor() {
        super('ليس لديك الصلاحية');
        this.name = 'ScheduleGenerationAccessError';
        this.status = 403;
        this.code = 'PERMISSION_DENIED';
        this.permission = GENERATE_PERMISSION;
    }
}

/**
 * الحارس المشترك لتوليد الجدول الشهري وإعادة توليده.
 * يفحص الدور الدقيق أولًا، ثم يحل خدمة الصلاحيات ويفحص المفتاح الفعلي.
 * لا يستدعي خدمة الصلاحيات إطلاقًا لغير admin، ولا ينفذ أي كتابة.
 */
async function assertScheduleGenerationAccess(user, permissionServiceOrFactory) {
    if (!user || user.role !== 'admin') {
        throw new ScheduleGenerationAccessError();
    }

    const permissionService = typeof permissionServiceOrFactory === 'function'
        ? permissionServiceOrFactory()
        : permissionServiceOrFactory;
    if (!permissionService || typeof permissionService.hasPermission !== 'function') {
        throw new Error('ScheduleGenerationAccess: PermissionService غير متاح');
    }

    const allowed = await permissionService.hasPermission(user.id, user.role, GENERATE_PERMISSION);
    if (!allowed) {
        throw new ScheduleGenerationAccessError();
    }
    return true;
}

function authorizeScheduleGeneration(getPermissionService) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });
        }
        try {
            await assertScheduleGenerationAccess(req.user, getPermissionService);
            return next();
        } catch (error) {
            if (error instanceof ScheduleGenerationAccessError) {
                return res.status(error.status).json({
                    error: error.message,
                    code: error.code,
                    permission: error.permission
                });
            }
            console.error('Schedule generation access error:', error.message);
            return res.status(500).json({ error: 'فشل فحص الصلاحية' });
        }
    };
}

module.exports = {
    GENERATE_PERMISSION,
    ScheduleGenerationAccessError,
    assertScheduleGenerationAccess,
    authorizeScheduleGeneration
};
