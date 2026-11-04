/**
 * P1-B — الاستثناءات الإدارية المؤقتة الموثقة.
 * لا إجازات هنا ولا سير اعتماد موازٍ: السند والجهة والمعتمد والتاريخ إلزامية.
 * لا كتابة في shift_roster أو schedule_months ولا إشعارات أو اعتماد/نشر.
 */
'use strict';

const crypto = require('crypto');
const { fail, actor, auditTx } = require('./generation-error.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = new Set(['temporary_assignment', 'temporary_change', 'operational_note']);

function validDate(value) {
    if (!DATE_RE.test(String(value || ''))) return false;
    const date = new Date(String(value) + 'T00:00:00Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requiredText(value, field, label) {
    const text = String(value || '').trim();
    if (!text) fail(422, 'EXCEPTION_FIELD_REQUIRED', `${label} مطلوب (${field})`);
    return text;
}

function optionalId(value) {
    if (value === undefined || value === null || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) fail(422, 'INVALID_EXCEPTION_SCOPE', 'معرّف النطاق غير صالح');
    return id;
}

class ScheduleExceptionService {
    constructor(db) {
        if (!db || !db.tx || !db.tx.immediate) throw new Error('ScheduleExceptionService: db.tx.immediate مطلوب');
        this.db = db;
    }

    async create(input, user) {
        const a = actor(user);
        const employeeId = optionalId(input.employee_id);
        const scopeTeamId = optionalId(input.scope_team_id);
        if ((employeeId === null) === (scopeTeamId === null)) {
            fail(422, 'INVALID_EXCEPTION_SCOPE', 'حدد موظفًا واحدًا أو فريقًا واحدًا فقط');
        }
        const type = String(input.exception_type || '');
        if (!TYPES.has(type)) fail(422, 'INVALID_EXCEPTION_TYPE', 'نوع الاستثناء غير صالح');
        const startDate = String(input.start_date || '');
        const endDate = String(input.end_date || '');
        if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) {
            fail(422, 'INVALID_EXCEPTION_DATES', 'فترة الاستثناء غير صالحة');
        }
        const effectTeamId = optionalId(input.effect_team_id);
        const effectShiftCode = input.effect_shift_code === undefined || input.effect_shift_code === null || input.effect_shift_code === ''
            ? null : String(input.effect_shift_code).trim();
        if (type === 'operational_note' && (effectTeamId !== null || effectShiftCode !== null)) {
            fail(422, 'OPERATIONAL_NOTE_HAS_EFFECT', 'الملاحظة التشغيلية لا تغيّر مناوبة أو فريقًا');
        }
        if (type === 'temporary_assignment' && effectTeamId === null) {
            fail(422, 'EXCEPTION_EFFECT_REQUIRED', 'التكليف المؤقت يتطلب فريق الأثر');
        }
        if (type === 'temporary_change' && effectShiftCode === null) {
            fail(422, 'EXCEPTION_EFFECT_REQUIRED', 'التغيير المؤقت يتطلب رمز المناوبة');
        }
        const reason = requiredText(input.reason, 'reason', 'سبب الاستثناء');
        const approvalSource = requiredText(input.approval_source, 'approval_source', 'مصدر الاعتماد');
        const approvalAuthority = requiredText(input.approval_authority, 'approval_authority', 'الجهة المخولة');
        const approvedBy = requiredText(input.approved_by, 'approved_by', 'المعتمد');
        const approvedAt = requiredText(input.approved_at, 'approved_at', 'تاريخ الاعتماد');
        if (Number.isNaN(Date.parse(approvedAt))) fail(422, 'INVALID_APPROVAL_DATE', 'تاريخ اعتماد الاستثناء غير صالح');
        const documentRef = String(input.document_ref || '').trim() || null;
        const id = crypto.randomUUID();

        this.db.tx.immediate(hdl => {
            if (employeeId !== null && !hdl.prepare('SELECT 1 AS x FROM employees WHERE id = ? AND is_active = 1').get(employeeId)) {
                fail(422, 'INVALID_EMPLOYEE', 'الموظف غير موجود أو غير نشط');
            }
            for (const teamId of [scopeTeamId, effectTeamId].filter(value => value !== null)) {
                if (!hdl.prepare('SELECT 1 AS x FROM teams WHERE id = ? AND is_active = 1').get(teamId)) {
                    fail(422, 'INVALID_TEAM', 'الفريق غير موجود أو غير نشط');
                }
            }
            if (effectShiftCode && !hdl.prepare('SELECT 1 AS x FROM shift_codes WHERE code = ?').get(effectShiftCode)) {
                fail(422, 'INVALID_SHIFT_CODE', 'رمز أثر الاستثناء غير موجود');
            }
            hdl.prepare(`INSERT INTO schedule_exceptions
                (id, employee_id, scope_team_id, exception_type, start_date, end_date,
                 effect_shift_code, effect_team_id, reason, approval_source, approval_authority,
                 approved_by, approved_at, document_ref, status, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
                .run(id, employeeId, scopeTeamId, type, startDate, endDate, effectShiftCode,
                    effectTeamId, reason, approvalSource, approvalAuthority, approvedBy,
                    approvedAt, documentRef, a.id);
            auditTx(hdl, user, 'schedule_exception_created',
                `استثناء ${type} ${id} · ${startDate}..${endDate} · ${employeeId === null ? 'team=' + scopeTeamId : 'employee=' + employeeId} · ${reason}`);
        });
        return this.get(id);
    }

    async get(id) {
        const row = await this.db.get('SELECT * FROM schedule_exceptions WHERE id = ?', [String(id)]);
        if (!row) fail(404, 'EXCEPTION_NOT_FOUND', 'الاستثناء غير موجود');
        return row;
    }

    async list(filters = {}) {
        const where = [];
        const params = [];
        if (filters.status) {
            if (!['active', 'cancelled'].includes(filters.status)) fail(422, 'INVALID_EXCEPTION_STATUS', 'حالة الاستثناء غير صالحة');
            where.push('status = ?'); params.push(filters.status);
        }
        if (filters.employee_id !== undefined && filters.employee_id !== '') {
            const id = optionalId(filters.employee_id);
            where.push('employee_id = ?'); params.push(id);
        }
        if (filters.team_id !== undefined && filters.team_id !== '') {
            const id = optionalId(filters.team_id);
            where.push('(scope_team_id = ? OR effect_team_id = ?)'); params.push(id, id);
        }
        if (filters.date) {
            if (!validDate(String(filters.date))) fail(422, 'INVALID_EXCEPTION_DATES', 'تاريخ الاستعلام غير صالح');
            where.push('start_date <= ? AND end_date >= ?'); params.push(filters.date, filters.date);
        }
        if (filters.month) {
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(filters.month))) fail(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة');
            where.push('start_date <= ? AND end_date >= ?'); params.push(filters.month + '-31', filters.month + '-01');
        }
        const rows = await this.db.all(`SELECT * FROM schedule_exceptions
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY start_date, employee_id, scope_team_id, id`, params);
        return { exceptions: rows };
    }

    async cancel(id, reasonInput, user) {
        const a = actor(user);
        const reason = requiredText(reasonInput, 'cancellation_reason', 'سبب الإلغاء');
        this.db.tx.immediate(hdl => {
            const row = hdl.prepare('SELECT * FROM schedule_exceptions WHERE id = ?').get(String(id));
            if (!row) fail(404, 'EXCEPTION_NOT_FOUND', 'الاستثناء غير موجود');
            if (row.status === 'cancelled') fail(409, 'EXCEPTION_ALREADY_CANCELLED', 'الاستثناء ملغى مسبقًا');
            hdl.prepare(`UPDATE schedule_exceptions SET status = 'cancelled', cancelled_by = ?,
                cancelled_at = datetime('now'), cancellation_reason = ? WHERE id = ?`).run(a.id, reason, row.id);
            auditTx(hdl, user, 'schedule_exception_cancelled', `إلغاء الاستثناء ${row.id} · ${reason}`);
        });
        return this.get(id);
    }
}

module.exports = { ScheduleExceptionService };
