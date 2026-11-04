/**
 * P3 — قراءات مركز دورة الجدول. لا منطق توليد أو انتقال حالة هنا.
 * كل التفاصيل مشتقة من خدمات/جداول SQLite؛ لا localStorage ولا قيم افتراضية تشغيلية.
 */
'use strict';

const { ContinuityService } = require('./continuity-service.js');
const { ScheduleGenerationService } = require('./generation-service.js');
const { ScheduleLifecycleService } = require('./lifecycle-service.js');
const { ScheduleExceptionService } = require('./exception-service.js');
const { CoverageApprovalService } = require('./coverage-approval-service.js');
const { fail } = require('./generation-error.js');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const GENERATED = new Set(['generated_draft', 'correction']);
function parseJson(value, fallback) { try { return JSON.parse(value); } catch (_) { return fallback; } }
function assertMonth(month) {
    if (!MONTH_RE.test(String(month || ''))) fail(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة — المطلوب YYYY-MM');
}
function dayShape(employeeId, row) {
    if (!row) return null;
    return {
        employee_id: Number(employeeId), date: row.date || row.shift_date,
        team_id: row.team_id === null || row.team_id === undefined ? null : Number(row.team_id),
        shift_code: row.shift_code
    };
}

class ScheduleWorkspaceService {
    constructor(db) {
        this.db = db;
        this.continuity = new ContinuityService(db);
        this.generation = new ScheduleGenerationService(db, { hasPermission: async () => false });
        this.lifecycle = new ScheduleLifecycleService(db, { hasPermission: async () => false });
        this.exceptions = new ScheduleExceptionService(db);
        this.coverage = new CoverageApprovalService(db);
    }

    async overview(month) {
        assertMonth(month);
        const [reference, versions, runs, coverage, employees, teams, exceptions, patterns, shiftCodes] = await Promise.all([
            this.continuity.getReference(month),
            this.continuity.listVersions({ month, limit: 500 }),
            this.generation.listRuns({ target_month: month, limit: 500 }),
            this.coverage.getMatrix(month),
            this.db.all('SELECT id, employee_code, name, job_title, pattern_code, is_active FROM employees ORDER BY name, id'),
            this.db.all('SELECT id, name, center, is_active FROM teams ORDER BY id'),
            this.exceptions.list({ month }),
            this.db.all('SELECT code, name, cycle_json, is_active FROM shift_patterns ORDER BY code'),
            this.db.ShiftCodes.getAll()
        ]);
        const generated = versions.versions.filter(row => GENERATED.has(row.version_kind));
        const current = generated[0] || null;
        return {
            month, reference, versions: versions.versions, runs: runs.runs,
            current_version: current, latest_run: runs.runs[0] || null,
            coverage, employees, teams, exceptions: exceptions.exceptions,
            patterns: patterns.map(row => ({ ...row, cycle: parseJson(row.cycle_json, null), cycle_json: undefined })),
            shift_codes: shiftCodes,
            publication_scope: 'logical_version_status_only_no_roster_write'
        };
    }

    async employeeDetail(versionId, employeeId) {
        employeeId = Number(employeeId);
        if (!Number.isInteger(employeeId)) fail(422, 'INVALID_EMPLOYEE', 'معرّف الموظف غير صالح');
        const version = await this.continuity.getVersion(versionId);
        const employee = await this.db.get('SELECT id, employee_code, name, job_title, pattern_code, is_active FROM employees WHERE id = ?', [employeeId]);
        if (!employee) fail(404, 'EMPLOYEE_NOT_FOUND', 'الموظف غير موجود');
        const contentEmployee = (version.content.employees || []).find(row => Number(row.employee_id) === employeeId);
        if (!contentEmployee) fail(404, 'EMPLOYEE_NOT_IN_VERSION', 'الموظف غير موجود في هذا الإصدار');
        const [leaves, exceptions, teams, run, gaps] = await Promise.all([
            this.db.all(`SELECT * FROM leave_requests WHERE employee_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date, id`,
                [employeeId, version.month + '-31', version.month + '-01']),
            this.exceptions.list({ employee_id: employeeId, month: version.month }),
            this.db.all('SELECT id, name, center FROM teams ORDER BY id'),
            this.db.get('SELECT id FROM schedule_generation_runs WHERE schedule_version_id = ?', [version.id]),
            this.db.all('SELECT * FROM schedule_gap_reviews WHERE version_id = ? AND employee_id = ? ORDER BY gap_date', [version.id, employeeId])
        ]);
        const continuity = version.current_snapshot
            ? version.current_snapshot.entries.find(row => Number(row.employee_id) === employeeId) || null : null;
        const diffs = run ? await this.db.all('SELECT * FROM schedule_generation_diffs WHERE run_id = ? AND employee_id = ? ORDER BY shift_date', [run.id, employeeId]) : [];
        return {
            version: { id: version.id, month: version.month, version_number: version.version_number, version_kind: version.version_kind, status: version.status, content_hash: version.content_hash },
            employee, days: contentEmployee.days || [], continuity_status: contentEmployee.continuity_status || null,
            continuity, leaves, exceptions: exceptions.exceptions, teams, gaps, diffs
        };
    }

    async compare(baseId, targetId) {
        if (!baseId || !targetId || baseId === targetId) fail(422, 'COMPARISON_VERSIONS_REQUIRED', 'اختر إصدارين مختلفين للمقارنة');
        const [base, target] = await Promise.all([this.continuity.getVersion(baseId), this.continuity.getVersion(targetId)]);
        if (!GENERATED.has(base.version_kind) || !GENERATED.has(target.version_kind)) {
            fail(409, 'COMPARISON_REQUIRES_GENERATED_VERSIONS', 'المقارنة التفصيلية مخصصة للمسودات المولدة والتصحيحات');
        }
        if (base.month !== target.month) fail(409, 'COMPARISON_MONTH_MISMATCH', 'لا تُقارن إصدارات من شهرين مختلفين');
        const flatten = version => {
            const map = new Map();
            for (const employee of version.content.employees || []) {
                for (const day of employee.days || []) map.set(`${employee.employee_id}|${day.date}`, dayShape(employee.employee_id, day));
            }
            return map;
        };
        const before = flatten(base), after = flatten(target);
        const keys = new Set([...before.keys(), ...after.keys()]);
        const run = await this.db.get('SELECT id FROM schedule_generation_runs WHERE schedule_version_id = ?', [target.id]);
        const recordedDiffs = run ? await this.db.all('SELECT * FROM schedule_generation_diffs WHERE run_id = ?', [run.id]) : [];
        const diffMap = new Map(recordedDiffs.map(row => [`${row.employee_id}|${row.shift_date}`, row]));
        const employeeIds = new Set();
        const changed = [];
        for (const key of [...keys].sort()) {
            const b = before.get(key) || null, a = after.get(key) || null;
            if (JSON.stringify(b) === JSON.stringify(a)) continue;
            const [employeeId, date] = key.split('|');
            employeeIds.add(Number(employeeId));
            const recorded = diffMap.get(key);
            changed.push({
                employee_id: Number(employeeId), date, before: b, after: a,
                change_type: !b ? 'added' : !a ? 'removed' : 'changed',
                reason: recorded ? recorded.reason : null,
                reason_source: recorded ? 'schedule_generation_diffs' : 'not_recorded',
                exception_id: recorded ? recorded.exception_id : null
            });
        }
        const employees = employeeIds.size ? await this.db.all(`SELECT id, employee_code, name FROM employees WHERE id IN (${[...employeeIds].map(() => '?').join(',')}) ORDER BY id`, [...employeeIds]) : [];
        return {
            base: { id: base.id, version_number: base.version_number, content_hash: base.content_hash, status: base.status },
            target: { id: target.id, version_number: target.version_number, content_hash: target.content_hash, status: target.status },
            month: base.month, employees, changes: changed, change_count: changed.length,
            note: 'إذا لم يوجد سبب محفوظ في سجل فروقات التوليد يُعرض reason=null بدل استنتاج سبب غير موثق.'
        };
    }

    async audit(filters = {}) {
        const limit = Math.min(Math.max(Number(filters.limit) || 300, 1), 1000);
        const params = [];
        const where = ["(action LIKE 'schedule_%' OR type IN ('schedule_generation','schedule_continuity'))"];
        if (filters.month) {
            assertMonth(filters.month);
            params.push('%' + filters.month + '%', filters.month);
            where.push(`(detail LIKE ? OR EXISTS (
                SELECT 1 FROM schedule_versions sv
                LEFT JOIN schedule_generation_runs sgr ON sgr.schedule_version_id = sv.id
                WHERE sv.month = ? AND (
                    audit_log.detail LIKE '%' || sv.id || '%' OR
                    (sgr.id IS NOT NULL AND audit_log.detail LIKE '%' || sgr.id || '%')
                )
            ))`);
        }
        const rows = await this.db.all(`SELECT id, user_id, user_name, action, detail, type, created_at
            FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, limit]);
        return { audit: rows, limit, filters: { month: filters.month || null } };
    }
}

module.exports = { ScheduleWorkspaceService };
