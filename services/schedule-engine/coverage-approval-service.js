/**
 * P3 — إدارة مصفوفة إثباتات التغطية الرسمية.
 *
 * المدخل مصفوفة كاملة للفرق النشطة: required/not_applicable/unresolved.
 * unresolved لا يُنشئ إثباتًا ولا قيمة. required يتطلب day/night صريحين،
 * ويُخزّن total مشتقًا للعرض فقط. لا revoke/clear ولا منح صلاحيات ولا
 * كتابة في shift_roster أو schedule_months. التحديث والإثباتات والتدقيق ذرّيون.
 */
'use strict';

const crypto = require('crypto');
const { fail, actor, auditTx } = require('./generation-error.js');
const { contentHash, daysOfMonth } = require('./continuity-service.js');
const { GenerationCoverageService, DEFAULT_KEY, OVERRIDES_KEY } = require('./generation-coverage-service.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const APPLICABILITY = new Set(['required', 'not_applicable', 'unresolved']);

function text(value, field, label) {
    const result = String(value || '').trim();
    if (!result) fail(422, 'COVERAGE_EVIDENCE_REQUIRED', `${label} مطلوب (${field})`);
    if (result.length > 1000) fail(422, 'COVERAGE_EVIDENCE_TOO_LONG', `${label} أطول من الحد المسموح`);
    return result;
}
function validDate(value) {
    if (!DATE_RE.test(String(value || ''))) return false;
    const parsed = new Date(String(value) + 'T00:00:00Z');
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function settingValue(row, fallback) {
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch (_) { return null; }
}
function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function assertHash(value, code) {
    if (!/^[a-f0-9]{64}$/.test(String(value || ''))) fail(422, code, 'بصمة الحالة الحالية للإعدادات مطلوبة قبل الحفظ');
}
function target(row) {
    const day = Number(row.day), night = Number(row.night);
    if (!Number.isInteger(day) || day < 0 || !Number.isInteger(night) || night < 0) {
        fail(422, 'COVERAGE_VALUES_UNRESOLVED', `الفريق ${row.team_id}: يوم/ليل يجب أن يكونا عددين صحيحين غير سالبين`);
    }
    return { day, night };
}

class CoverageApprovalService {
    constructor(db) {
        if (!db || !db.tx || !db.tx.immediate) throw new Error('CoverageApprovalService: db.tx.immediate مطلوب');
        this.db = db;
        this.coverage = new GenerationCoverageService(db);
    }

    async getMatrix(month = '2000-01') {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) fail(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة');
        const [teams, defaultValue, overrides, approvals, context] = await Promise.all([
            this.db.all('SELECT id, name, center, is_active FROM teams ORDER BY id'),
            this.db.AppSettings.get(DEFAULT_KEY),
            this.db.AppSettings.get(OVERRIDES_KEY),
            this.db.all('SELECT * FROM schedule_coverage_approvals ORDER BY team_id, effective_from, approved_at, id'),
            this.coverage.createContext(month, new Map())
        ]);
        const dates = daysOfMonth(month);
        const matrix = teams.map(team => {
            const resolutions = dates.map(date => this.coverage.resolution(context, team.id, date));
            const unresolved = resolutions.find(row => row.applicability === 'unresolved');
            const first = resolutions[0];
            const raw = plainObject(overrides) && plainObject(overrides[String(team.id)]) ? overrides[String(team.id)] : null;
            const rowApprovals = approvals.filter(row => Number(row.team_id) === Number(team.id));
            return {
                team_id: team.id, team_name: team.name, center: team.center, is_active: team.is_active,
                applicability: unresolved ? 'unresolved' : first.applicability,
                unresolved_reason: unresolved ? unresolved.reason : null,
                unresolved_dates: unresolved ? dates.filter((_, index) => resolutions[index].applicability === 'unresolved') : [],
                rule: raw && Number.isInteger(raw.day) && Number.isInteger(raw.night)
                    ? { day: raw.day, night: raw.night, total: raw.day + raw.night } : null,
                effective_from: first.approvals.length ? first.approvals[first.approvals.length - 1].effective_from : null,
                effective_to: first.approvals.length ? first.approvals[first.approvals.length - 1].effective_to : null,
                approval_count: rowApprovals.length,
                evidence: first.approvals.length ? first.approvals[first.approvals.length - 1] : null
            };
        });
        return {
            month, teams: matrix,
            coverage_default: defaultValue,
            coverage_team_overrides: overrides,
            coverage_default_hash: contentHash(defaultValue),
            coverage_overrides_hash: contentHash(overrides),
            coverage_policy_version: context.coveragePolicyVersion,
            summary: {
                active_teams: teams.filter(row => row.is_active === 1).length,
                required: matrix.filter(row => row.is_active === 1 && row.applicability === 'required').length,
                not_applicable: matrix.filter(row => row.is_active === 1 && row.applicability === 'not_applicable').length,
                unresolved: matrix.filter(row => row.is_active === 1 && row.applicability === 'unresolved').length
            },
            notice: 'القيم والإثباتات الظاهرة هي المسجلة فعلًا فقط؛ unresolved يمنع الجاهزية ولا يُستبدل بأي قيمة تاريخية أو افتراضية.'
        };
    }

    async saveMatrix(input, user) {
        const a = actor(user);
        if (!Array.isArray(input.rows)) fail(422, 'COVERAGE_MATRIX_REQUIRED', 'مصفوفة كاملة لكل الفرق النشطة مطلوبة');
        if (input.official_confirmation !== true) {
            fail(422, 'OFFICIAL_COVERAGE_CONFIRMATION_REQUIRED', 'يلزم تأكيد صريح بأن القيم والسند رسميان ومعتمدان');
        }
        const source = text(input.source, 'source', 'مصدر الاعتماد الرسمي');
        const authority = text(input.approval_authority, 'approval_authority', 'الجهة المخولة');
        const approvedBy = text(input.approved_by, 'approved_by', 'المعتمد');
        const approvedAt = String(input.approved_at || '').trim();
        if (!approvedAt || Number.isNaN(Date.parse(approvedAt))) fail(422, 'INVALID_COVERAGE_APPROVAL_DATE', 'تاريخ الاعتماد الرسمي غير صالح');
        const effectiveFrom = String(input.effective_from || '');
        const effectiveTo = input.effective_to === null || input.effective_to === undefined || input.effective_to === '' ? null : String(input.effective_to);
        if (!validDate(effectiveFrom) || (effectiveTo !== null && (!validDate(effectiveTo) || effectiveTo < effectiveFrom))) {
            fail(422, 'INVALID_COVERAGE_EFFECTIVE_PERIOD', 'فترة سريان إثبات التغطية غير صالحة');
        }
        assertHash(input.expected_default_hash, 'COVERAGE_DEFAULT_HASH_REQUIRED');
        assertHash(input.expected_overrides_hash, 'COVERAGE_OVERRIDES_HASH_REQUIRED');

        this.db.tx.immediate(hdl => {
            const teams = hdl.prepare('SELECT id, name, is_active FROM teams WHERE is_active = 1 ORDER BY id').all();
            const activeIds = new Set(teams.map(row => Number(row.id)));
            const seen = new Set();
            for (const row of input.rows) {
                const id = Number(row.team_id);
                if (!Number.isInteger(id) || !activeIds.has(id) || seen.has(id)) {
                    fail(422, 'COVERAGE_MATRIX_TEAM_MISMATCH', 'المصفوفة تتضمن فريقًا غير نشط أو مكررًا أو غير معروف');
                }
                seen.add(id);
                if (!APPLICABILITY.has(row.applicability)) fail(422, 'INVALID_COVERAGE_APPLICABILITY', `حالة التغطية غير صالحة للفريق ${id}`);
                if (row.applicability === 'required') target(row);
            }
            if (seen.size !== activeIds.size || teams.some(row => !seen.has(Number(row.id)))) {
                fail(422, 'COVERAGE_MATRIX_INCOMPLETE', 'يجب إرسال قرار صريح لكل فريق نشط؛ الفرق الناقصة تبقى unresolved');
            }

            const oldDefaultRow = hdl.prepare('SELECT value FROM app_settings WHERE key = ?').get(DEFAULT_KEY);
            const oldOverridesRow = hdl.prepare('SELECT value FROM app_settings WHERE key = ?').get(OVERRIDES_KEY);
            const defaultValue = settingValue(oldDefaultRow, null);
            const oldOverrides = settingValue(oldOverridesRow, null);
            if (contentHash(defaultValue) !== input.expected_default_hash || contentHash(oldOverrides) !== input.expected_overrides_hash) {
                fail(409, 'STALE_COVERAGE_SETTINGS', 'تغيرت إعدادات التغطية بعد فتح المصفوفة؛ أعد تحميلها وراجع الإثباتات قبل الحفظ');
            }
            if (!plainObject(oldOverrides)) fail(409, 'INVALID_COVERAGE_SETTINGS', 'إعدادات التجاوزات الحالية غير صالحة؛ لا يُستبدل خللها تلقائيًا');

            const nextOverrides = { ...oldOverrides };
            const proofs = [];
            for (const row of input.rows) {
                const id = Number(row.team_id);
                if (row.applicability === 'required') {
                    nextOverrides[String(id)] = target(row);
                    proofs.push({ team_id: id, applicability: 'required' });
                } else {
                    delete nextOverrides[String(id)];
                    if (row.applicability === 'not_applicable') proofs.push({ team_id: id, applicability: 'not_applicable' });
                }
            }
            const defaultHash = contentHash(defaultValue);
            const overridesHash = contentHash(nextOverrides);
            hdl.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
                .run(OVERRIDES_KEY, JSON.stringify(nextOverrides));
            const insert = hdl.prepare(`INSERT INTO schedule_coverage_approvals
                (id, team_id, applicability, coverage_default_hash, coverage_overrides_hash,
                 source, approval_authority, approved_by, approved_at, effective_from, effective_to,
                 status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`);
            for (const proof of proofs) {
                insert.run(crypto.randomUUID(), proof.team_id, proof.applicability, defaultHash, overridesHash,
                    source, authority, approvedBy, approvedAt, effectiveFrom, effectiveTo, a.id);
            }
            auditTx(hdl, user, 'schedule_coverage_matrix_recorded',
                `مصفوفة تغطية رسمية · فرق نشطة=${teams.length} · إثباتات=${proofs.length} · unresolved=${teams.length - proofs.length} · من ${effectiveFrom} إلى ${effectiveTo || 'مفتوح'} · default=${defaultHash} · overrides=${overridesHash} · المصدر: ${source}`);
        });
        return this.getMatrix(effectiveFrom.slice(0, 7));
    }
}

module.exports = { CoverageApprovalService };
