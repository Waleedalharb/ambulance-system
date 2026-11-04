'use strict';

class ScheduleGenerationError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ScheduleGenerationError';
        this.status = status;
        this.code = code;
    }
}

function fail(status, code, message) {
    throw new ScheduleGenerationError(status, code, message);
}

function actor(user) {
    if (!user || user.id === undefined || user.id === null) {
        fail(401, 'UNAUTHENTICATED', 'مطلوب تسجيل الدخول');
    }
    return { id: String(user.id), name: String(user.name || user.username || user.id) };
}

function auditTx(hdl, user, action, detail) {
    const a = actor(user);
    hdl.prepare(`INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type)
                 VALUES (NULL, ?, ?, ?, ?, 'schedule_generation')`)
        .run(a.id, a.name, action, detail);
}

module.exports = { ScheduleGenerationError, fail, actor, auditTx };
