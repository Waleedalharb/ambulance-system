/**
 * P2 — مراجعة واعتماد ونشر منطقي وتصحيح مسودات التوليد.
 *
 * - النشر هنا انتقال حالة للإصدار فقط؛ لا كتابة في shift_roster/schedule_months.
 * - الاعتماد مربوط بالنسخة وبصمة المحتوى وآخر مراجعة ناجحة للمدخلات الحالية.
 * - التغطية تُعاد قراءتها من FSS وإثباتاتها؛ لا قيم أو افتراضات بديلة لـD4-C.
 * - كل مراجعة append-only، والمعتمد/المنشور لا يُعدّل؛ التصحيح إصدار جديد.
 */
'use strict';

const crypto = require('crypto');
const {
    ContinuityService, canonicalStringify, contentHash
} = require('./continuity-service.js');
const { ScheduleGenerationService } = require('./generation-service.js');
const { key } = require('./generation-coverage-service.js');
const { getEngineSetting } = require('./config.js');
const { fail, actor, auditTx } = require('./generation-error.js');

const HASH_RE = /^[a-f0-9]{64}$/;
const INPUT_KEYS = [
    'reference', 'active_employees', 'memberships', 'leaves', 'exceptions',
    'unable_attend', 'e4_config', 'coverage_policy'
];
const GENERATED_KINDS = ['generated_draft', 'correction'];

function parseJson(text, fallback = null) {
    try { return JSON.parse(text); } catch (_) { return fallback; }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function serializeVersion(row) {
    return { ...row, content: parseJson(row.content_json, null), content_json: undefined };
}
function assertHash(value) {
    if (!HASH_RE.test(String(value || ''))) fail(422, 'CONTENT_HASH_REQUIRED', 'بصمة SHA-256 مطلوبة');
}
function referenceDescriptor(reference) {
    if (!reference || !reference.current_snapshot) return null;
    return {
        version_id: reference.id,
        content_hash: reference.content_hash,
        snapshot_id: reference.current_snapshot.id,
        snapshot_status: reference.current_snapshot.status,
        entries: reference.current_snapshot.entries.map(entry => ({
            employee_id: entry.employee_id, status: entry.status, pattern_code: entry.pattern_code,
            next_phase_index: entry.next_phase_index, next_shift_code: entry.next_shift_code,
            team_id: entry.team_id, assignment_status: entry.assignment_status,
            effective_date: entry.effective_date, state_version: entry.state_version,
            resolution_source: entry.resolution_source, reason: entry.reason || null
        }))
    };
}
function reviewFromRow(row) {
    if (!row) return null;
    const coverageState = parseJson(row.coverage_json, { coverage: [], unresolved_teams: [] });
    return {
        ...row,
        ready: row.ready === 1,
        blockers: parseJson(row.blockers_json, []),
        coverage: coverageState.coverage || [],
        unresolved_teams: coverageState.unresolved_teams || [],
        shortages: parseJson(row.shortages_json, []),
        conflicts: parseJson(row.conflicts_json, []),
        e4: parseJson(row.e4_json, []),
        warnings: parseJson(row.warnings_json, []),
        input_snapshot: parseJson(row.input_snapshot_json, {}),
        blockers_json: undefined, coverage_json: undefined, shortages_json: undefined,
        conflicts_json: undefined, e4_json: undefined, warnings_json: undefined,
        input_snapshot_json: undefined
    };
}

class ScheduleLifecycleService {
    constructor(db, permissionServiceOrFactory) {
        if (!db || !db.tx || !db.tx.immediate) throw new Error('ScheduleLifecycleService: db.tx.immediate مطلوب');
        this.db = db;
        this.continuity = new ContinuityService(db);
        this.generation = new ScheduleGenerationService(db, permissionServiceOrFactory || { hasPermission: async () => false });
    }

    async _load(id) {
        const version = await this.db.get('SELECT * FROM schedule_versions WHERE id = ?', [String(id)]);
        if (!version) fail(404, 'VERSION_NOT_FOUND', 'إصدار الجدول غير موجود');
        if (!GENERATED_KINDS.includes(version.version_kind)) {
            fail(409, 'VERSION_KIND_NOT_GENERATED', 'دورة P2 مخصصة للمسودات المولدة والتصحيحات فقط');
        }
        const run = await this.db.get('SELECT * FROM schedule_generation_runs WHERE schedule_version_id = ?', [version.id]);
        if (!run) fail(409, 'GENERATION_RUN_REQUIRED', 'لا يوجد تشغيل توليد مرتبط بالإصدار');
        const [entries, diffs] = await Promise.all([
            this.db.all('SELECT * FROM schedule_generation_entries WHERE run_id = ? ORDER BY shift_date, employee_id', [run.id]),
            this.db.all('SELECT * FROM schedule_generation_diffs WHERE run_id = ? ORDER BY shift_date, employee_id', [run.id])
        ]);
        return {
            version, run, entries, diffs,
            content: parseJson(version.content_json, null),
            input: parseJson(run.input_json, {}),
            summary: parseJson(run.summary_json, {})
        };
    }

    async _currentReference(targetMonth) {
        try {
            const result = await this.continuity.getReference(targetMonth);
            if (!result.usable || !result.reference) {
                return { reference: null, error: { type: 'reference_unavailable', reason: result.reason || 'NO_APPROVED_REFERENCE' } };
            }
            return { reference: result.reference, error: null };
        } catch (error) {
            if (error && error.name === 'ContinuityError') {
                return { reference: null, error: { type: 'reference_unavailable', reason: error.code } };
            }
            throw error;
        }
    }

    async _currentInput(state, cells) {
        const { run, input } = state;
        const month = run.target_month;
        const currentReference = await this._currentReference(month);
        const membershipIds = (input.memberships || []).map(row => Number(row.employee_id));
        const membershipRows = await this.generation._memberships(membershipIds);
        const [activeEmployees, leaves, exceptions, unableAttend, minRest, maxNights, coverageContext] = await Promise.all([
            this.db.all('SELECT id, employee_code, name, pattern_code, is_active FROM employees WHERE is_active = 1 ORDER BY id'),
            this.db.all(`SELECT id, employee_id, start_date, end_date, type, status, reason, approved_by, approved_at
                FROM leave_requests WHERE status IN ('approved','pending') AND start_date <= ? AND end_date >= ?
                ORDER BY employee_id, id`, [month + '-31', month + '-01']),
            this.db.all(`SELECT * FROM schedule_exceptions WHERE status = 'active' AND start_date <= ? AND end_date >= ?
                ORDER BY employee_id, scope_team_id, start_date, id`, [month + '-31', month + '-01']),
            this.db.all(`SELECT id, employee_id, off_date, reason, status, reviewed_by, reviewed_at
                FROM unable_attend_requests WHERE off_date >= ? AND off_date <= ?
                ORDER BY employee_id, off_date, id`, [month + '-01', month + '-31']),
            getEngineSetting('schedule_engine.min_rest_hours'),
            getEngineSetting('schedule_engine.max_consecutive_nights'),
            this.generation.coverage.createContext(month, cells)
        ]);
        const memberships = [...new Set(membershipRows.map(row => Number(row.employee_id)))].map(employeeId => ({
            employee_id: employeeId,
            assignments: membershipRows.filter(row => Number(row.employee_id) === employeeId).map(row => ({
                id: row.id, team_id: row.team_id, assigned_date: row.assigned_date,
                end_date: row.end_date, is_primary: row.is_primary
            }))
        }));
        const current = {
            ...input,
            reference: referenceDescriptor(currentReference.reference),
            active_employees: activeEmployees.map(row => ({ id: row.id, pattern_code: row.pattern_code || null })),
            memberships, leaves, exceptions, unable_attend: unableAttend,
            e4_config: { min_rest_hours: minRest, max_consecutive_nights: maxNights },
            coverage_policy: coverageContext.policy
        };
        return { current, currentReference, coverageContext, membershipRows, exceptions };
    }

    async _evaluate(id) {
        const state = await this._load(id);
        const { version, run, entries, content, input, summary } = state;
        const integrity = [];
        const computedContentHash = contentHash({ schema: 'p1-a-content-v1', content, gap_reviews: [], continuity: [] });
        if (!content || computedContentHash !== version.content_hash || run.output_hash !== version.content_hash) {
            integrity.push({
                type: 'content_integrity', reason: 'CONTENT_HASH_MISMATCH',
                stored_content_hash: version.content_hash, computed_content_hash: computedContentHash,
                run_output_hash: run.output_hash
            });
        }
        if (run.target_month !== version.month || run.reference_version_id !== version.reference_version_id ||
            run.reference_content_hash !== version.reference_content_hash) {
            integrity.push({ type: 'version_run_mismatch', reason: 'اختلاف الشهر أو المرجع بين الإصدار والتشغيل' });
        }
        const contentCells = [];
        for (const employee of (content && content.employees) || []) {
            for (const day of employee.days || []) contentCells.push({ ...day, employee_id: Number(employee.employee_id) });
        }
        const entryShape = rows => rows.map(row => ({
            employee_id: Number(row.employee_id), date: row.date || row.shift_date,
            team_id: row.team_id === null ? null : Number(row.team_id), shift_code: row.shift_code
        })).sort((a, b) => a.date.localeCompare(b.date) || a.employee_id - b.employee_id);
        if (canonicalStringify(entryShape(entries)) !== canonicalStringify(entryShape(contentCells))) {
            integrity.push({ type: 'entry_content_mismatch', reason: 'خلايا التشغيل لا تطابق محتوى الإصدار' });
        }

        const cells = new Map(entries.map(row => [key(row.employee_id, row.shift_date), {
            employee_id: Number(row.employee_id), shift_date: row.shift_date, team_id: row.team_id,
            shift_code: row.shift_code, source: row.source, reason: row.reason,
            leave_id: row.leave_id, exception_id: row.exception_id, affected: row.affected
        }]));
        const currentState = await this._currentInput(state, cells);
        const { current, currentReference, coverageContext, membershipRows, exceptions } = currentState;
        const currentInputHash = contentHash(current);
        const differences = INPUT_KEYS.filter(field => canonicalStringify(input[field]) !== canonicalStringify(current[field]));
        const conflicts = [...integrity];
        if (differences.length) {
            conflicts.push({
                type: 'stale_inputs', reason: 'STALE_GENERATION_INPUTS', fields: differences,
                original_input_hash: run.input_hash, current_input_hash: currentInputHash,
                message: 'تغيرت مدخلات مؤثرة؛ أعد التوليد أو أنشئ تصحيحًا ثم راجع النسخة الجديدة'
            });
        }
        if (currentReference.error) conflicts.push(currentReference.error);
        if (currentReference.reference && input.reference &&
            (currentReference.reference.id !== input.reference.version_id ||
             currentReference.reference.content_hash !== input.reference.content_hash ||
             currentReference.reference.current_snapshot.id !== input.reference.snapshot_id)) {
            conflicts.push({
                type: 'stale_reference', reason: 'STALE_REFERENCE',
                expected: { version_id: input.reference.version_id, content_hash: input.reference.content_hash, snapshot_id: input.reference.snapshot_id },
                actual: { version_id: currentReference.reference.id, content_hash: currentReference.reference.content_hash, snapshot_id: currentReference.reference.current_snapshot.id }
            });
        }
        for (const blocker of summary.blockers || []) {
            if (!['e4_violation', 'coverage_unresolved', 'coverage_shortage'].includes(blocker.type)) {
                conflicts.push({ ...blocker, source: 'persisted_generation_summary' });
            }
        }

        const referenceRow = await this.db.get('SELECT content_json FROM schedule_versions WHERE id = ?', [run.reference_version_id]);
        const referenceContent = referenceRow ? parseJson(referenceRow.content_json, {}) : {};
        coverageContext.referenceDays = new Map();
        for (const employee of referenceContent.employees || []) {
            for (const day of employee.days || []) {
                if (day.shift_code) coverageContext.referenceDays.set(key(employee.employee_id, day.date), day.shift_code);
            }
        }
        const codeMap = coverageContext.codeMap;
        const e4 = await this.generation._validateCells(this.db, cells, membershipRows, exceptions, coverageContext, codeMap);
        // التغطية الحالية لا تحتسب مناوبة محفوظة أصبح عليها إجازة معتمدة
        // بعد التوليد. نستخدم نسخة ذاكرية فقط؛ خلايا الإصدار وبصمته لا تتغير.
        const coverageCells = new Map([...cells.entries()].map(([cellKey, cell]) => [cellKey, { ...cell }]));
        for (const cell of coverageCells.values()) {
            const onApprovedLeave = current.leaves.some(row => Number(row.employee_id) === Number(cell.employee_id) &&
                row.status === 'approved' && row.start_date <= cell.shift_date && row.end_date >= cell.shift_date);
            if (onApprovedLeave) cell.shift_code = 'V';
        }
        coverageContext.cells = coverageCells;
        const coverageResult = await this.generation.coverage.evaluateAll(coverageContext);
        const unresolvedBlockers = coverageResult.unresolved_teams.map(team => ({
            type: 'coverage_unresolved', team_id: team.team_id, team_name: team.team_name,
            reason: team.reason, dates: team.dates
        }));
        const shortageBlockers = coverageResult.shortages.map(shortage => ({ type: 'coverage_shortage', ...shortage }));
        const warnings = [];
        for (const cell of cells.values()) {
            for (const check of (cell.validation && cell.validation.checks) || []) {
                if (check.status === 'warn') warnings.push({
                    type: 'e4_warning', employee_id: cell.employee_id, date: cell.shift_date, check
                });
            }
        }
        for (const rejection of summary.candidate_rejections || []) {
            warnings.push({ type: 'm5_candidate_rejected', ...rejection });
        }
        const blockers = [...conflicts, ...e4, ...unresolvedBlockers, ...shortageBlockers];
        return {
            schema: 'p2-lifecycle-review-v1', version_id: version.id, run_id: run.id,
            content_hash: version.content_hash, input_hash: run.input_hash,
            current_input_hash: currentInputHash,
            coverage_policy_version: coverageContext.coveragePolicyVersion,
            ready: blockers.length === 0,
            blockers, coverage: coverageResult.coverage,
            unresolved_teams: coverageResult.unresolved_teams,
            shortages: coverageResult.shortages, conflicts, e4, warnings,
            input_snapshot: {
                original_input_hash: run.input_hash, current_input_hash: currentInputHash,
                differences,
                current_reference: referenceDescriptor(currentReference.reference) ? {
                    version_id: currentReference.reference.id,
                    content_hash: currentReference.reference.content_hash,
                    snapshot_id: currentReference.reference.current_snapshot.id
                } : null,
                e4_config: current.e4_config,
                coverage_default_hash: coverageContext.defaultHash,
                coverage_overrides_hash: coverageContext.overridesHash,
                coverage_policy_version: coverageContext.coveragePolicyVersion
            },
            publication_scope: 'logical_version_status_only_no_roster_write'
        };
    }

    async review(id, user) {
        const a = actor(user);
        const state = await this._load(id);
        if (!['draft', 'ready_for_review'].includes(state.version.status)) {
            fail(409, 'VERSION_IMMUTABLE', 'الإصدار المعتمد أو المنشور لا يُراجع أو يُعدّل؛ أنشئ تصحيحًا جديدًا');
        }
        const evaluation = await this._evaluate(id);
        const reviewId = crypto.randomUUID();
        this.db.tx.immediate(hdl => {
            const current = hdl.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(state.version.id);
            if (!current || current.content_hash !== state.version.content_hash ||
                !['draft', 'ready_for_review'].includes(current.status)) {
                fail(409, 'STALE_VERSION', 'تغير الإصدار أثناء المراجعة؛ أعد المحاولة على النسخة الحالية');
            }
            hdl.prepare(`INSERT INTO schedule_lifecycle_reviews
                (id, version_id, run_id, content_hash, input_hash, current_input_hash,
                 coverage_policy_version, ready, blockers_json, coverage_json, shortages_json,
                 conflicts_json, e4_json, warnings_json, input_snapshot_json, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(reviewId, current.id, state.run.id, evaluation.content_hash, evaluation.input_hash,
                    evaluation.current_input_hash, evaluation.coverage_policy_version, evaluation.ready ? 1 : 0,
                    canonicalStringify(evaluation.blockers),
                    canonicalStringify({ coverage: evaluation.coverage, unresolved_teams: evaluation.unresolved_teams }),
                    canonicalStringify(evaluation.shortages), canonicalStringify(evaluation.conflicts),
                    canonicalStringify(evaluation.e4), canonicalStringify(evaluation.warnings),
                    canonicalStringify(evaluation.input_snapshot), a.id);
            hdl.prepare(`UPDATE schedule_versions SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`)
                .run(evaluation.ready ? 'ready_for_review' : 'draft', a.id, current.id);
            auditTx(hdl, user, 'schedule_draft_reviewed',
                `مراجعة P2 ${current.id} · review=${reviewId} · ready=${evaluation.ready} · blockers=${evaluation.blockers.length} · content=${evaluation.content_hash} · input=${evaluation.current_input_hash}`);
        });
        return this.getLifecycle(id);
    }

    async _latestReview(versionId) {
        return this.db.get(`SELECT * FROM schedule_lifecycle_reviews WHERE version_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`, [versionId]);
    }

    async approve(id, expectedHash, user) {
        assertHash(expectedHash);
        const a = actor(user);
        const state = await this._load(id);
        if (state.version.status !== 'ready_for_review') fail(409, 'VERSION_NOT_READY', 'الإصدار ليس جاهزًا للاعتماد');
        if (state.version.content_hash !== expectedHash) fail(409, 'CONTENT_HASH_MISMATCH', 'بصمة الإصدار لا تطابق النسخة التي تمت مراجعتها');
        const evaluation = await this._evaluate(id);
        if (!evaluation.ready) fail(409, 'UNRESOLVED_BLOCKERS', 'توجد موانع حالية تمنع الاعتماد؛ راجع تفاصيل المراجعة');
        const latest = await this._latestReview(id);
        if (!latest) fail(409, 'REVIEW_REQUIRED', 'المراجعة الموثقة مطلوبة قبل الاعتماد');
        if (!latest.ready || latest.content_hash !== expectedHash || latest.current_input_hash !== evaluation.current_input_hash) {
            fail(409, 'REVIEW_STALE', 'آخر مراجعة ليست ناجحة أو لا تطابق المحتوى والمدخلات الحالية');
        }
        this.db.tx.immediate(hdl => {
            const current = hdl.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(id);
            const currentReview = hdl.prepare(`SELECT * FROM schedule_lifecycle_reviews WHERE version_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(id);
            if (!current || current.status !== 'ready_for_review' || current.content_hash !== expectedHash) {
                fail(409, 'STALE_VERSION', 'تغيرت حالة الإصدار أو بصمته قبل الاعتماد');
            }
            if (!currentReview || currentReview.id !== latest.id || !currentReview.ready) {
                fail(409, 'REVIEW_STALE', 'تغيرت المراجعة الأخيرة قبل الاعتماد');
            }
            hdl.prepare(`UPDATE schedule_versions SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?`)
                .run(a.id, id);
            auditTx(hdl, user, 'schedule_draft_approved',
                `اعتماد P2 ${id} · review=${latest.id} · content=${expectedHash} · input=${evaluation.current_input_hash}`);
        });
        return this.getLifecycle(id);
    }

    async publish(id, expectedHash, user) {
        assertHash(expectedHash);
        const a = actor(user);
        const state = await this._load(id);
        if (state.version.status !== 'approved') fail(409, 'VERSION_NOT_APPROVED', 'الاعتماد المستقل مطلوب قبل النشر');
        if (state.version.content_hash !== expectedHash) fail(409, 'CONTENT_HASH_MISMATCH', 'بصمة الإصدار لا تطابق النسخة المعتمدة');
        const evaluation = await this._evaluate(id);
        if (!evaluation.ready) fail(409, 'UNRESOLVED_BLOCKERS', 'توجد موانع حالية، بما فيها تغطية غير محسومة، تمنع النشر');
        const newer = await this.db.get(`SELECT id, version_number FROM schedule_versions
            WHERE month = ? AND status = 'published' AND id <> ? AND version_number > ?
            ORDER BY version_number DESC LIMIT 1`, [state.version.month, id, state.version.version_number]);
        if (newer) fail(409, 'STALE_PUBLICATION_LINEAGE', 'يوجد إصدار منشور أحدث لهذا الشهر؛ لا يجوز نشر نسخة أقدم');
        this.db.tx.immediate(hdl => {
            const current = hdl.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(id);
            if (!current || current.status !== 'approved' || current.content_hash !== expectedHash) {
                fail(409, 'STALE_VERSION', 'تغيرت حالة الإصدار أو بصمته قبل النشر');
            }
            const currentNewer = hdl.prepare(`SELECT id FROM schedule_versions
                WHERE month = ? AND status = 'published' AND id <> ? AND version_number > ? LIMIT 1`)
                .get(current.month, id, current.version_number);
            if (currentNewer) fail(409, 'STALE_PUBLICATION_LINEAGE', 'ظهر إصدار منشور أحدث قبل إتمام النشر');
            hdl.prepare(`UPDATE schedule_versions SET status = 'published', published_by = ?, published_at = datetime('now') WHERE id = ?`)
                .run(a.id, id);
            auditTx(hdl, user, 'schedule_draft_published',
                `نشر منطقي P2 ${id} · content=${expectedHash} · input=${evaluation.current_input_hash} · لا كتابة في shift_roster/schedule_months`);
        });
        return this.getLifecycle(id);
    }

    async createCorrection(id, reason, user) {
        const a = actor(user);
        const correctionReason = String(reason || '').trim();
        if (correctionReason.length < 3) fail(422, 'CORRECTION_REASON_REQUIRED', 'سبب التصحيح الموثق مطلوب');
        const state = await this._load(id);
        if (!['approved', 'published'].includes(state.version.status)) {
            fail(409, 'CORRECTION_SOURCE_NOT_LOCKED', 'التصحيح ينشأ من إصدار معتمد أو منشور فقط');
        }
        const versionId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        const content = clone(state.content);
        content.base_run_id = state.run.id;
        content.correction = {
            version_id: versionId, parent_version_id: state.version.id,
            parent_run_id: state.run.id, parent_content_hash: state.version.content_hash,
            reason: correctionReason
        };
        const outputHash = contentHash({ schema: 'p1-a-content-v1', content, gap_reviews: [], continuity: [] });
        const input = {
            ...clone(state.input),
            correction: {
                parent_version_id: state.version.id, parent_run_id: state.run.id,
                parent_content_hash: state.version.content_hash, reason: correctionReason
            }
        };
        const inputHash = contentHash(input);
        const summary = {
            ...clone(state.summary), schema: 'p2-correction-summary-v1',
            mode: 'minimal_diff', base_run_id: state.run.id, status: 'draft',
            ready_for_review: false, diff_count: 0, affected_cell_count: 0,
            blockers: [], blocker_count: 0,
            correction: content.correction,
            publication: 'تصحيح جديد غير معتمد؛ الأصل ثابت ولا توجد كتابة في shift_roster أو schedule_months.'
        };
        this.db.tx.immediate(hdl => {
            const original = hdl.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(id);
            if (!original || !['approved', 'published'].includes(original.status) || original.content_hash !== state.version.content_hash) {
                fail(409, 'STALE_VERSION', 'تغير الإصدار الأصلي قبل إنشاء التصحيح');
            }
            const versionNumber = (hdl.prepare('SELECT COALESCE(MAX(version_number), 0) AS n FROM schedule_versions WHERE month = ?').get(original.month).n || 0) + 1;
            hdl.prepare(`INSERT INTO schedule_versions
                (id, month, version_number, parent_version_id, reference_version_id, reference_content_hash,
                 version_kind, status, source_type, source_note, content_json, content_hash,
                 coverage_policy_version, created_by)
                VALUES (?, ?, ?, ?, ?, ?, 'correction', 'draft', 'published_correction', ?, ?, ?, ?, ?)`)
                .run(versionId, original.month, versionNumber, original.id, original.reference_version_id,
                    original.reference_content_hash, correctionReason, canonicalStringify(content), outputHash,
                    original.coverage_policy_version, a.id);
            hdl.prepare(`INSERT INTO schedule_generation_runs
                (id, schedule_version_id, target_month, reference_version_id, reference_content_hash,
                 reference_snapshot_id, base_run_id, mode, status, input_json, input_hash,
                 output_hash, coverage_policy_version, summary_json, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'minimal_diff', 'draft', ?, ?, ?, ?, ?, ?)`)
                .run(runId, versionId, original.month, state.run.reference_version_id,
                    state.run.reference_content_hash, state.run.reference_snapshot_id, state.run.id,
                    canonicalStringify(input), inputHash, outputHash, original.coverage_policy_version,
                    canonicalStringify(summary), a.id);
            const insertEntry = hdl.prepare(`INSERT INTO schedule_generation_entries
                (id, run_id, employee_id, shift_date, team_id, shift_code, source, reason,
                 leave_id, exception_id, affected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const entry of state.entries) {
                insertEntry.run(crypto.randomUUID(), runId, entry.employee_id, entry.shift_date,
                    entry.team_id, entry.shift_code, entry.source, entry.reason,
                    entry.leave_id || null, entry.exception_id || null, 0);
            }
            auditTx(hdl, user, 'schedule_correction_created',
                `إنشاء تصحيح ${versionId} من ${id} · run=${runId} · parent=${state.run.id} · content=${outputHash} · السبب: ${correctionReason}`);
        });
        return this.getLifecycle(versionId);
    }

    async getLifecycle(id) {
        const state = await this._load(id);
        const rows = await this.db.all(`SELECT * FROM schedule_lifecycle_reviews WHERE version_id = ?
            ORDER BY created_at DESC, rowid DESC`, [state.version.id]);
        const reviews = rows.map(reviewFromRow);
        return {
            version: serializeVersion(state.version),
            run: {
                ...state.run, input: state.input, summary: state.summary,
                input_json: undefined, summary_json: undefined,
                entries: state.entries, diffs: state.diffs
            },
            reviews, latest_review: reviews[0] || null,
            publication_scope: 'logical_version_status_only_no_roster_write'
        };
    }
}

module.exports = { ScheduleLifecycleService };
