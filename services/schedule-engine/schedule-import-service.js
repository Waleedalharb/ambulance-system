/**
 * P6 — دورة الاستيراد الذكي:
 * Upload → Analyze → Map → Validate → Preview → Human Review → Import.
 * الأصل والبصمات والتحليل والقرارات محفوظة؛ الناتج مرجع P1-A imported فقط.
 * لا كتابة في shift_roster/schedule_months/shift_codes ولا اعتماد أو نشر.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { parseByFormat, extensionOf, assertSupported } = require('./import-format-service');
const { analyzeDocument, buildVersionContent, parseDate } = require('./import-analysis-service');
const { canonicalStringify, contentHash, ContinuityService } = require('./continuity-service');

const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ACTIONS = new Set(['set_employee', 'set_shift', 'set_team', 'set_date', 'exclude_assignment', 'accept_warning', 'confirm_review']);

class ScheduleImportError extends Error {
    constructor(status, code, message) {
        super(message); this.name = 'ScheduleImportError'; this.status = status; this.code = code;
    }
}
function fail(status, code, message) { throw new ScheduleImportError(status, code, message); }
function parseJson(text, fallback = null) { try { return JSON.parse(text); } catch (_) { return fallback; } }
function actor(user) {
    if (!user || user.id === undefined || user.id === null) fail(401, 'UNAUTHENTICATED', 'مطلوب تسجيل الدخول');
    return { id: String(user.id), name: String(user.name || user.username || user.id) };
}
function safeName(value) {
    const base = path.win32.basename(String(value || 'schedule-import')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
    return (base || 'schedule-import').slice(-160);
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function assertMonth(month, required = false) {
    if (!month && !required) return null;
    if (!MONTH_RE.test(String(month || ''))) fail(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة — المطلوب YYYY-MM');
    return month;
}
function assertExpectedHash(batch, expected) {
    if (!expected || expected !== batch.analysis_hash) fail(409, 'STALE_ANALYSIS', 'تغيرت بصمة التحليل؛ أعد تحميل المعاينة قبل تنفيذ القرار');
}
function validateSignature(buffer, ext) {
    const starts = signature => buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
    let valid = false;
    if (['xlsx', 'xlsm'].includes(ext)) valid = starts(Buffer.from([0x50, 0x4b]));
    else if (ext === 'xls') valid = starts(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    else if (ext === 'pdf') valid = buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
    else if (ext === 'png') valid = starts(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    else if (['jpg', 'jpeg'].includes(ext)) valid = starts(Buffer.from([0xff, 0xd8, 0xff]));
    else if (ext === 'csv') valid = !buffer.includes(0);
    if (!valid) fail(415, 'FILE_SIGNATURE_MISMATCH', 'محتوى الملف لا يطابق امتداده أو أن الملف تالف');
}
function analysisHash(analysis) {
    return contentHash({
        month: analysis.month, template: analysis.template, assignments: analysis.assignments,
        issues: analysis.issues.map(({ id, type, severity, message, source, assignmentId, currentValue, status, resolution }) =>
            ({ id, type, severity, message, source, assignmentId, currentValue, status, resolution }))
    });
}
function activeIssue(issue) { return issue.status === 'pending'; }
function recount(analysis) {
    analysis.counts = analysis.counts || {};
    analysis.counts.resolved = analysis.assignments.filter(item => item.status === 'resolved').length;
    analysis.counts.empty = analysis.assignments.filter(item => item.status === 'empty').length;
    analysis.counts.unknownCodes = analysis.issues.filter(item => item.type === 'UNKNOWN_SHIFT_CODE' && activeIssue(item)).length;
    analysis.counts.blockers = analysis.issues.filter(item => item.severity === 'blocker' && activeIssue(item)).length;
    analysis.counts.warnings = analysis.issues.filter(item => item.severity === 'warning' && activeIssue(item)).length;
    analysis.analysisHash = analysisHash(analysis);
    return analysis;
}
function refreshDuplicates(analysis) {
    for (const issue of analysis.issues) {
        if (activeIssue(issue) && ['DUPLICATE_CONFLICT', 'DUPLICATE_IDENTICAL'].includes(issue.type)) issue.status = 'superseded';
    }
    const groups = new Map();
    for (const item of analysis.assignments) {
        if (!item.employee_id || !item.date || ['empty', 'excluded'].includes(item.status)) continue;
        const key = `${item.employee_id}|${item.date}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    let serial = analysis.issues.filter(issue => String(issue.id).startsWith('ISS-REVIEW-')).length;
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const distinct = new Set(group.map(item => `${item.shift_code}|${item.raw_shift}|${item.team_id}`));
        for (const item of group) {
            analysis.issues.push({
                id: `ISS-REVIEW-${++serial}`, type: distinct.size > 1 ? 'DUPLICATE_CONFLICT' : 'DUPLICATE_IDENTICAL',
                severity: distinct.size > 1 ? 'blocker' : 'warning',
                message: distinct.size > 1 ? 'تعارض مناوبات لنفس الموظف والتاريخ بعد المراجعة' : 'تكرار متطابق لنفس الموظف والتاريخ بعد المراجعة',
                source: item.evidence.source, assignmentId: item.id, currentValue: item.raw_shift, status: 'pending'
            });
        }
    }
}
function assignmentStatus(item) {
    if (item.status === 'excluded') return 'excluded';
    if (!item.employee_id || !item.date || (item.raw_team && !item.team_id)) return 'needs_review';
    if (!item.shift_code) return item.raw_shift ? 'needs_review' : 'empty';
    return 'resolved';
}
function applyDecision(analysis, review, reference) {
    if (review.action === 'confirm_review') return;
    const issue = analysis.issues.find(row => row.id === review.issue_id);
    if (!issue) fail(404, 'IMPORT_ISSUE_NOT_FOUND', 'قضية المراجعة غير موجودة في التحليل الحالي');
    if (!activeIssue(issue)) fail(409, 'IMPORT_ISSUE_CLOSED', 'قضية المراجعة محسومة أو مستبدلة');
    const item = analysis.assignments.find(row => row.id === issue.assignmentId);
    if (!item) fail(422, 'IMPORT_ASSIGNMENT_REQUIRED', 'هذه القضية تحتاج خريطة قالب وليس قرار خلية');
    if (issue.assignmentId !== review.assignment_id) fail(422, 'IMPORT_REVIEW_TARGET_MISMATCH', 'هدف القرار لا يطابق القضية');
    const value = parseJson(review.value_json, null);
    if (review.action === 'set_employee') {
        if (issue.type !== 'EMPLOYEE_UNRESOLVED') fail(422, 'IMPORT_ACTION_NOT_ALLOWED', 'لا يمكن تغيير الموظف لهذه القضية');
        const employee = reference.employees.find(row => Number(row.id) === Number(value && value.employee_id));
        if (!employee) fail(422, 'EMPLOYEE_NOT_FOUND', 'الموظف المحدد غير موجود في السجل');
        item.employee_id = Number(employee.id); item.employee_code = employee.employee_code; item.employee_name = employee.name;
        item.pattern_code = employee.pattern_code || null;
        item.evidence.employee = `إسناد بشري موثق: ${review.reason}`;
    } else if (review.action === 'set_shift') {
        if (issue.type !== 'UNKNOWN_SHIFT_CODE') fail(422, 'IMPORT_ACTION_NOT_ALLOWED', 'لا يمكن تغيير الرمز لهذه القضية');
        const shift = reference.shiftCodes.find(row => row.code === String(value && value.shift_code || ''));
        if (!shift) fail(422, 'SHIFT_CODE_NOT_FOUND', 'الرمز المحدد غير موجود في القاموس؛ لا يجوز إنشاء معنى جديد هنا');
        item.shift_code = shift.code; item.evidence.shift = `اختيار رمز موجود بشريًا: ${shift.code} — ${review.reason}`;
    } else if (review.action === 'set_team') {
        if (issue.type !== 'TEAM_UNRESOLVED') fail(422, 'IMPORT_ACTION_NOT_ALLOWED', 'لا يمكن تغيير الفريق لهذه القضية');
        const team = reference.teams.find(row => Number(row.id) === Number(value && value.team_id));
        if (!team) fail(422, 'TEAM_NOT_FOUND', 'الفريق المحدد غير موجود في السجل');
        item.team_id = Number(team.id); item.raw_team = team.name; item.evidence.team = `إسناد فريق بشري موثق: ${review.reason}`;
    } else if (review.action === 'set_date') {
        if (!['DATE_UNRESOLVED', 'DATE_OUTSIDE_MONTH'].includes(issue.type)) fail(422, 'IMPORT_ACTION_NOT_ALLOWED', 'لا يمكن تغيير التاريخ لهذه القضية');
        const date = parseDate(value && value.date, analysis.month, value && value.date);
        if (!date || !analysis.month || !date.startsWith(analysis.month + '-')) fail(422, 'IMPORT_DATE_OUTSIDE_MONTH', 'التاريخ يجب أن يكون صالحًا وداخل شهر الملف');
        item.date = date; item.evidence.date = `تصحيح تاريخ بشري موثق: ${review.reason}`;
    } else if (review.action === 'exclude_assignment') {
        item.status = 'excluded'; item.evidence.exclusion = `استبعاد بشري موثق: ${review.reason}`;
        for (const linked of analysis.issues) {
            if (linked.assignmentId === item.id && activeIssue(linked)) {
                linked.status = 'resolved'; linked.resolution = { action: 'exclude_assignment', reason: review.reason, review_id: review.id };
            }
        }
    } else if (review.action === 'accept_warning') {
        if (issue.severity !== 'warning') fail(422, 'IMPORT_BLOCKER_CANNOT_BE_ACCEPTED', 'المانع لا يُقبل بتحذير؛ صححه أو استبعد الخلية');
    } else fail(422, 'IMPORT_ACTION_NOT_ALLOWED', 'نوع قرار المراجعة غير مدعوم');
    if (review.action !== 'exclude_assignment') {
        item.status = assignmentStatus(item);
        issue.status = 'resolved'; issue.resolution = { action: review.action, reason: review.reason, review_id: review.id };
    }
    refreshDuplicates(analysis);
    recount(analysis);
}

class ScheduleImportService {
    constructor(db, options = {}) {
        if (!db || !db.tx || !db.tx.immediate) throw new Error('ScheduleImportService: db.tx.immediate مطلوب');
        this.db = db;
        this.storageDir = options.storageDir || db.STORAGE_PATH || process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
        this.continuity = new ContinuityService(db);
    }
    async reference() {
        const [employees, shiftCodes, teams, templates, previous] = await Promise.all([
            this.db.all('SELECT * FROM employees ORDER BY id'),
            this.db.all('SELECT * FROM shift_codes ORDER BY code'),
            this.db.all('SELECT * FROM teams ORDER BY id'),
            this.db.all('SELECT signature, structure_map_json FROM schedule_import_templates ORDER BY created_at'),
            this.db.all("SELECT content_json FROM schedule_versions WHERE version_kind = 'bootstrap_reference' ORDER BY created_at DESC, version_number DESC LIMIT 1")
        ]);
        const previousAssignments = [];
        if (previous.length) {
            const content = parseJson(previous[0].content_json, {});
            for (const employee of content.employees || []) for (const day of employee.days || []) {
                if (day.shift_code) previousAssignments.push({ employee_id: employee.employee_id, shift_date: day.date, shift_code: day.shift_code });
            }
        }
        return { employees, shiftCodes, teams, previousAssignments,
            templates: templates.map(row => ({ signature: row.signature, structures: parseJson(row.structure_map_json, []) })) };
    }
    async analyze(buffer, originalName, month, mappings = []) {
        const parsed = await parseByFormat(buffer, originalName);
        return recount(analyzeDocument(parsed, await this.reference(), { month: month || null, mappings }));
    }
    async upload({ buffer, originalName, mimeType, month, user }) {
        const a = actor(user); assertMonth(month);
        const ext = assertSupported(originalName);
        if (!Buffer.isBuffer(buffer) || !buffer.length) fail(422, 'EMPTY_IMPORT_FILE', 'الملف فارغ');
        if (buffer.length > MAX_FILE_SIZE) fail(413, 'IMPORT_FILE_TOO_LARGE', 'حجم الملف يتجاوز 20 ميجابايت');
        validateSignature(buffer, ext);
        const analysis = await this.analyze(buffer, originalName, month);
        const id = crypto.randomUUID(), filename = safeName(originalName), fileHash = sha256(buffer);
        const relative = path.join('schedule-imports', id, filename);
        const absolute = path.join(this.storageDir, relative);
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, buffer, { flag: 'wx' });
        try {
            this.db.tx.immediate(hdl => {
                hdl.prepare(`INSERT INTO schedule_import_batches
                    (id, original_name, stored_path, file_sha256, format, mime_type, file_size, month, status,
                     initial_analysis_json, analysis_json, analysis_hash, mapping_json, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'analyzed', ?, ?, ?, '[]', ?)`)
                    .run(id, filename, relative, fileHash, ext, mimeType || null, buffer.length, analysis.month,
                        canonicalStringify(analysis), canonicalStringify(analysis), analysis.analysisHash, a.id);
                hdl.prepare(`INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type)
                    VALUES (NULL, ?, ?, 'schedule_smart_import_uploaded', ?, 'schedule_smart_import')`)
                    .run(a.id, a.name, `رفع ${filename} · ${buffer.length} بايت · SHA-256 ${fileHash} · الدفعة ${id}`);
            });
        } catch (error) {
            await fsp.unlink(absolute).catch(() => {}); await fsp.rmdir(path.dirname(absolute)).catch(() => {});
            throw error;
        }
        return this.get(id);
    }
    _row(id) {
        return this.db.get('SELECT * FROM schedule_import_batches WHERE id = ?', [id]);
    }
    async _requiredRow(id) {
        const row = await this._row(id);
        if (!row) fail(404, 'IMPORT_BATCH_NOT_FOUND', 'دفعة الاستيراد غير موجودة');
        return row;
    }
    async _serialize(row, detailed = true) {
        const base = { ...row, stored_path: undefined, initial_analysis_json: undefined, analysis_json: undefined,
            mapping_json: undefined, original_file_url: `/api/schedule/imports/${encodeURIComponent(row.id)}/file` };
        if (!detailed) return base;
        const reviews = await this.db.all('SELECT * FROM schedule_import_reviews WHERE batch_id = ? ORDER BY created_at, id', [row.id]);
        return { ...base, initial_analysis: parseJson(row.initial_analysis_json, null), analysis: parseJson(row.analysis_json, null),
            mapping: parseJson(row.mapping_json, []), reviews: reviews.map(item => ({ ...item, value: parseJson(item.value_json, null), value_json: undefined })) };
    }
    async list(query = {}) {
        if (query.month) assertMonth(query.month);
        const rows = query.month
            ? await this.db.all('SELECT * FROM schedule_import_batches WHERE month = ? ORDER BY created_at DESC LIMIT 200', [query.month])
            : await this.db.all('SELECT * FROM schedule_import_batches ORDER BY created_at DESC LIMIT 200');
        return { batches: await Promise.all(rows.map(row => this._serialize(row, false))) };
    }
    async get(id) {
        const batch = await this._serialize(await this._requiredRow(id), true);
        const reference = await this.reference();
        return { batch, options: {
            employees: reference.employees.map(row => ({ id: row.id, employee_code: row.employee_code, name: row.name, is_active: row.is_active })),
            shiftCodes: reference.shiftCodes.map(row => ({ code: row.code, name: row.name })),
            teams: reference.teams.map(row => ({ id: row.id, name: row.name, center: row.center, is_active: row.is_active }))
        } };
    }
    async getOriginal(id) {
        const row = await this._requiredRow(id);
        const root = path.resolve(this.storageDir), absolute = path.resolve(this.storageDir, row.stored_path);
        if (!absolute.startsWith(root + path.sep)) fail(422, 'IMPORT_FILE_PATH_INVALID', 'مسار الملف الأصلي غير صالح');
        const buffer = await fsp.readFile(absolute);
        if (sha256(buffer) !== row.file_sha256) fail(409, 'ORIGINAL_FILE_HASH_MISMATCH', 'بصمة الملف الأصلي لا تطابق المحفوظ؛ أوقف الاستيراد');
        return { buffer, filename: row.original_name, mimeType: row.mime_type || 'application/octet-stream', sha256: row.file_sha256 };
    }
    async map(id, input, user) {
        const a = actor(user), row = await this._requiredRow(id); assertExpectedHash(row, input.expected_analysis_hash);
        if (row.status === 'imported') fail(409, 'IMPORT_ALREADY_COMPLETED', 'لا يمكن تغيير خريطة دفعة استُوردت');
        const reviews = await this.db.get('SELECT COUNT(*) AS n FROM schedule_import_reviews WHERE batch_id = ?', [id]);
        if (reviews.n) fail(409, 'IMPORT_REVIEWS_EXIST', 'الخريطة تسبق المراجعة؛ أنشئ دفعة جديدة لتغييرها بعد بدء القرارات');
        const month = assertMonth(input.month || row.month, true);
        const mappings = Array.isArray(input.mappings) ? input.mappings : [];
        if (mappings.length > 100) fail(422, 'TOO_MANY_IMPORT_MAPPINGS', 'عدد خرائط القوالب يتجاوز الحد');
        const original = await this.getOriginal(id);
        const analysis = await this.analyze(original.buffer, row.original_name, month, mappings);
        this.db.tx.immediate(hdl => {
            const current = hdl.prepare('SELECT * FROM schedule_import_batches WHERE id = ?').get(id);
            assertExpectedHash(current, input.expected_analysis_hash);
            hdl.prepare(`UPDATE schedule_import_batches SET month = ?, status = 'mapped', initial_analysis_json = ?,
                analysis_json = ?, analysis_hash = ?, mapping_json = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(analysis.month, canonicalStringify(analysis), canonicalStringify(analysis), analysis.analysisHash,
                    canonicalStringify(mappings), a.id, id);
            hdl.prepare(`INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type)
                VALUES (NULL, ?, ?, 'schedule_smart_import_mapped', ?, 'schedule_smart_import')`)
                .run(a.id, a.name, `تحديث خريطة الدفعة ${id} · ${mappings.length} خريطة بشرية · SHA-256 ${analysis.analysisHash}`);
        });
        return this.get(id);
    }
    async review(id, input, user) {
        const a = actor(user), row = await this._requiredRow(id); assertExpectedHash(row, input.expected_analysis_hash);
        if (row.status === 'imported') fail(409, 'IMPORT_ALREADY_COMPLETED', 'الدفعة مستوردة ولا تقبل قرارات جديدة');
        const action = String(input.action || '');
        if (!ACTIONS.has(action)) fail(422, 'IMPORT_ACTION_NOT_ALLOWED', 'نوع قرار المراجعة غير مدعوم');
        const reason = String(input.reason || '').trim();
        if (reason.length < 3 || reason.length > 1000) fail(422, 'IMPORT_REVIEW_REASON_REQUIRED', 'سبب المراجعة إلزامي بين 3 و1000 حرف');
        const review = { id: crypto.randomUUID(), issue_id: input.issue_id || null, assignment_id: input.assignment_id || null,
            action, value_json: canonicalStringify(input.value === undefined ? null : input.value), reason };
        const reference = await this.reference();
        this.db.tx.immediate(hdl => {
            const current = hdl.prepare('SELECT * FROM schedule_import_batches WHERE id = ?').get(id);
            assertExpectedHash(current, input.expected_analysis_hash);
            const analysis = clone(parseJson(current.analysis_json, null));
            const prior = hdl.prepare('SELECT * FROM schedule_import_reviews WHERE batch_id = ? ORDER BY created_at, id').all(id);
            const initial = clone(parseJson(current.initial_analysis_json, null));
            for (const previous of prior) applyDecision(initial, previous, reference);
            applyDecision(initial, review, reference);
            if (action === 'confirm_review') {
                if (initial.counts.blockers || initial.counts.warnings) fail(409, 'IMPORT_REVIEW_INCOMPLETE', 'لا تكتمل المراجعة قبل حسم جميع الموانع والتحذيرات');
                if (!initial.assignments.some(item => !['excluded'].includes(item.status))) fail(409, 'IMPORT_HAS_NO_ASSIGNMENTS', 'لا توجد عناصر صالحة للاستيراد');
            }
            const nextStatus = action === 'confirm_review' ? 'reviewed' : 'validated';
            hdl.prepare(`INSERT INTO schedule_import_reviews
                (id, batch_id, issue_id, assignment_id, action, value_json, reason, analysis_hash, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(review.id, id, review.issue_id, review.assignment_id, action, review.value_json, reason, current.analysis_hash, a.id);
            hdl.prepare(`UPDATE schedule_import_batches SET status = ?, analysis_json = ?, analysis_hash = ?,
                updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
                .run(nextStatus, canonicalStringify(initial), initial.analysisHash, a.id, id);
            hdl.prepare(`INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type)
                VALUES (NULL, ?, ?, 'schedule_smart_import_reviewed', ?, 'schedule_smart_import')`)
                .run(a.id, a.name, `${action} · الدفعة ${id} · القضية ${review.issue_id || 'تأكيد عام'} · ${reason} · SHA-256 ${initial.analysisHash}`);
        });
        return this.get(id);
    }
    async import(id, expectedAnalysisHash, user) {
        const a = actor(user), row = await this._requiredRow(id); assertExpectedHash(row, expectedAnalysisHash);
        if (row.status === 'imported') fail(409, 'IMPORT_ALREADY_COMPLETED', 'استُوردت الدفعة مسبقًا');
        if (row.status !== 'reviewed') fail(409, 'HUMAN_REVIEW_REQUIRED', 'المراجعة البشرية النهائية إلزامية قبل الاستيراد');
        const original = await this.getOriginal(id);
        const analysis = clone(parseJson(row.analysis_json, null)); recount(analysis);
        if (analysis.analysisHash !== row.analysis_hash) fail(409, 'ANALYSIS_HASH_MISMATCH', 'بصمة نتيجة التحليل غير متسقة');
        if (analysis.counts.blockers || analysis.counts.warnings) fail(409, 'IMPORT_REVIEW_INCOMPLETE', 'ما زالت موانع أو تحذيرات دون حسم');
        const content = buildVersionContent(analysis, id);
        if (!content.employees.length) fail(409, 'IMPORT_HAS_NO_EMPLOYEES', 'لا يوجد موظفون صالحون لإنشاء المرجع');
        const versionId = crypto.randomUUID();
        this.db.tx.immediate(hdl => {
            const current = hdl.prepare('SELECT * FROM schedule_import_batches WHERE id = ?').get(id);
            if (current.status !== 'reviewed') fail(409, 'IMPORT_STATE_CHANGED', 'تغيرت حالة الدفعة قبل الاستيراد');
            assertExpectedHash(current, expectedAnalysisHash);
            const nextVersion = (hdl.prepare('SELECT COALESCE(MAX(version_number), 0) AS n FROM schedule_versions WHERE month = ?').get(content.month).n || 0) + 1;
            hdl.prepare(`INSERT INTO schedule_versions
                (id, month, version_number, version_kind, status, source_type, source_note, content_json, content_hash, created_by)
                VALUES (?, ?, ?, 'bootstrap_reference', 'imported', 'smart_import', ?, ?, '', ?)`)
                .run(versionId, content.month, nextVersion,
                    `${current.original_name} · SHA-256 ${current.file_sha256} · الدفعة ${id}`, canonicalStringify(content), a.id);
            const gapRows = [];
            for (const employee of content.employees) {
                if (!employee.days.some(day => day.shift_code)) continue;
                for (const day of employee.days) if (!day.shift_code) gapRows.push({ id: crypto.randomUUID(), employee_id: employee.employee_id, gap_date: day.date });
            }
            const insertGap = hdl.prepare(`INSERT INTO schedule_gap_reviews (id, version_id, employee_id, gap_date, resolution)
                VALUES (?, ?, ?, ?, 'unresolved')`);
            for (const gap of gapRows) insertGap.run(gap.id, versionId, gap.employee_id, gap.gap_date);
            const versionHash = contentHash({ schema: 'p1-a-content-v1', content,
                gap_reviews: gapRows.map(gap => ({ employee_id: gap.employee_id, gap_date: gap.gap_date, resolution: 'unresolved', reason: null })), continuity: [] });
            hdl.prepare('UPDATE schedule_versions SET content_hash = ? WHERE id = ?').run(versionHash, versionId);
            hdl.prepare(`INSERT OR IGNORE INTO schedule_import_templates
                (id, signature, structure_map_json, source_batch_id, analysis_hash, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(crypto.randomUUID(), analysis.template.signature, canonicalStringify(analysis.structures), id, analysis.analysisHash, a.id);
            hdl.prepare(`UPDATE schedule_import_batches SET status = 'imported', version_id = ?, imported_at = datetime('now'),
                updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(versionId, a.id, id);
            hdl.prepare(`INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type)
                VALUES (NULL, ?, ?, 'schedule_smart_import_completed', ?, 'schedule_smart_import')`)
                .run(a.id, a.name, `إنشاء مرجع imported ${versionId} من الدفعة ${id} · الملف ${original.filename} · بصمة التحليل ${analysis.analysisHash} · بصمة الإصدار ${versionHash}`);
        });
        return { batch: (await this.get(id)).batch, version: await this.continuity.getVersion(versionId) };
    }
}

module.exports = { ScheduleImportService, ScheduleImportError, analysisHash, validateSignature, safeName };
