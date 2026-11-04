/**
 * P1-A — المرجع المعتمد ولقطات الاستمرارية والتهيئة الأولى.
 *
 * - مصدر الاستيراد الوحيد shift_roster؛ لا كتابة في المصدر أو schedule_months.
 * - لا توليد ولا نشر ولا أهداف تغطية هنا.
 * - الفراغ لا يصبح راحة إلا بقرار rest_confirmed موثق.
 * - لا يُشتق طور إلا من shift_patterns.cycle_json صريح ومطابقة حتمية واحدة.
 * - كل كتابة وتدقيقها في tx.immediate واحدة، والمعتمد غير قابل للتعديل.
 */
'use strict';

const crypto = require('crypto');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GAP_RESOLUTIONS = new Set(['rest_confirmed', 'missing_data', 'out_of_scope', 'other_approved']);
const ENTRY_STATUSES = new Set(['resolved', 'no_reference', 'unresolved', 'excluded']);

class ContinuityError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ContinuityError';
        this.status = status;
        this.code = code;
    }
}

function fail(status, code, message) {
    throw new ContinuityError(status, code, message);
}

function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

function contentHash(value) {
    return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function assertMonth(month, field = 'month') {
    if (typeof month !== 'string' || !MONTH_RE.test(month)) {
        fail(422, 'INVALID_MONTH', `صيغة ${field} غير صالحة — المطلوب YYYY-MM`);
    }
    return month;
}

function daysOfMonth(month) {
    assertMonth(month);
    const year = Number(month.slice(0, 4));
    const mon = Number(month.slice(5, 7));
    const count = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

function nextMonth(month) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function previousMonth(month) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function monthsBetweenExclusive(earlier, later) {
    const out = [];
    let cursor = nextMonth(earlier);
    while (cursor < later) {
        out.push(cursor);
        cursor = nextMonth(cursor);
    }
    return out;
}

function parseJson(text, fallback = null) {
    try { return JSON.parse(text); } catch (_) { return fallback; }
}

function actor(user) {
    if (!user || user.id === undefined || user.id === null) fail(401, 'UNAUTHENTICATED', 'مطلوب تسجيل الدخول');
    return { id: String(user.id), name: String(user.name || user.username || user.id) };
}

function auditTx(hdl, user, action, detail) {
    const a = actor(user);
    hdl.prepare(`INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type)
                 VALUES (NULL, ?, ?, ?, ?, 'schedule_continuity')`)
        .run(a.id, a.name, action, detail);
}

function getVersionTx(hdl, id) {
    const row = hdl.prepare('SELECT * FROM schedule_versions WHERE id = ?').get(String(id));
    if (!row) fail(404, 'VERSION_NOT_FOUND', 'إصدار الجدول غير موجود');
    return row;
}

function assertEditable(version) {
    // P1-B: مسارات P1-A تهيّئ المرجع فقط. المسودة المولدة تُقرأ عبر runs ولا
    // تدخل اشتقاق/اعتماد المرجع؛ دورة اعتمادها ونشرها مرحلة مستقلة (P2).
    if (version.version_kind !== 'bootstrap_reference') {
        fail(409, 'VERSION_KIND_NOT_REFERENCE', 'هذا الإجراء مخصص لإصدارات المرجع فقط؛ المسودة المولدة لا تدخل مسار اعتماد P1-A');
    }
    if (!['imported', 'draft', 'ready_for_review'].includes(version.status)) {
        fail(409, 'VERSION_IMMUTABLE', 'لا يمكن تعديل إصدار معتمد أو منشور');
    }
}

function parseCycleRow(row) {
    if (!row || !row.is_active || !row.cycle_json) return null;
    const cycle = parseJson(row.cycle_json);
    if (!Array.isArray(cycle) || cycle.length === 0) return null;
    if (cycle.some(code => typeof code !== 'string' || !code.trim())) return null;
    return cycle.map(code => code.trim());
}

function cycleMapTx(hdl) {
    const rows = hdl.prepare('SELECT * FROM shift_patterns ORDER BY code').all();
    const map = new Map();
    for (const row of rows) map.set(row.code, { row, cycle: parseCycleRow(row) });
    return map;
}

function shiftCodeMapTx(hdl) {
    return new Map(hdl.prepare('SELECT * FROM shift_codes ORDER BY code').all().map(row => [row.code, row]));
}

function currentSnapshotTx(hdl, versionId) {
    return hdl.prepare('SELECT * FROM schedule_continuity_snapshots WHERE version_id = ? AND is_current = 1')
        .get(versionId) || null;
}

function snapshotEntriesTx(hdl, snapshotId) {
    if (!snapshotId) return [];
    return hdl.prepare('SELECT * FROM schedule_continuity_entries WHERE snapshot_id = ? ORDER BY employee_id')
        .all(snapshotId);
}

function gapReviewsTx(hdl, versionId) {
    return hdl.prepare(`SELECT * FROM schedule_gap_reviews WHERE version_id = ?
                        ORDER BY employee_id, gap_date`).all(versionId);
}

function hashMaterial(version, gaps, entries) {
    return {
        schema: 'p1-a-content-v1',
        content: parseJson(version.content_json, {}),
        gap_reviews: gaps.map(g => ({
            employee_id: g.employee_id,
            gap_date: g.gap_date,
            resolution: g.resolution,
            reason: g.reason || null
        })),
        continuity: entries.map(e => ({
            employee_id: e.employee_id,
            status: e.status,
            pattern_code: e.pattern_code,
            next_phase_index: e.next_phase_index,
            next_shift_code: e.next_shift_code,
            team_id: e.team_id,
            assignment_status: e.assignment_status,
            effective_date: e.effective_date,
            state_version: e.state_version,
            resolution_source: e.resolution_source,
            reason: e.reason || null
        }))
    };
}

function fullHashTx(hdl, version) {
    const snapshot = currentSnapshotTx(hdl, version.id);
    return contentHash(hashMaterial(version, gapReviewsTx(hdl, version.id), snapshotEntriesTx(hdl, snapshot && snapshot.id)));
}

function sourceHashTx(hdl, version) {
    return contentHash(hashMaterial(version, gapReviewsTx(hdl, version.id), []));
}

function blockersFor(gaps, entries) {
    const blockers = [];
    const byEmployee = new Map(entries.map(entry => [entry.employee_id, entry]));
    for (const gap of gaps) {
        const entry = byEmployee.get(gap.employee_id);
        if (entry && entry.status === 'excluded') continue;
        if (gap.resolution === 'unresolved') {
            blockers.push({ type: 'gap_unresolved', employee_id: gap.employee_id, date: gap.gap_date });
        } else if (['missing_data', 'out_of_scope', 'other_approved'].includes(gap.resolution)) {
            const manuallyResolved = entry && entry.status === 'resolved' && entry.resolution_source === 'manual_reviewed';
            if (!manuallyResolved) {
                blockers.push({ type: 'gap_requires_manual_continuity', employee_id: gap.employee_id, date: gap.gap_date, resolution: gap.resolution });
            }
        }
    }
    for (const entry of entries) {
        if (['no_reference', 'unresolved'].includes(entry.status)) {
            blockers.push({ type: 'continuity_' + entry.status, employee_id: entry.employee_id, reason: entry.reason || null });
        }
        if (entry.status === 'resolved' && entry.assignment_status === 'unresolved') {
            blockers.push({ type: 'team_assignment_unresolved', employee_id: entry.employee_id, reason: entry.reason || null });
        }
    }
    return blockers;
}

function summarize(content, gaps, entries) {
    const counts = { resolved: 0, no_reference: 0, unresolved: 0, excluded: 0 };
    for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
    const teams = {};
    for (const entry of entries) {
        if (entry.status === 'resolved' && entry.assignment_status === 'resolved' && entry.team_id) {
            teams[entry.team_id] = (teams[entry.team_id] || 0) + 1;
        }
    }
    const blockers = blockersFor(gaps, entries);
    const warnings = [];
    const unassigned = entries.filter(e => e.status === 'resolved' && e.assignment_status === 'unresolved').map(e => e.employee_id);
    if (unassigned.length) warnings.push({ type: 'team_assignment_review_required', employee_ids: unassigned });
    return {
        month: content.month,
        employee_count: content.employees.length,
        counts,
        resolved_team_counts: teams,
        unresolved_gap_count: gaps.filter(g => g.resolution === 'unresolved').length,
        blocker_count: blockers.length,
        blockers,
        warnings,
        coverage_note: 'لا توجد أهداف تغطية أو استنتاج احتياج في P1-A؛ أعداد الفرق وصفية فقط.'
    };
}

function serializeVersion(row) {
    return {
        ...row,
        content: parseJson(row.content_json, null),
        content_json: undefined
    };
}

class ContinuityService {
    constructor(db) {
        if (!db || !db.tx || !db.tx.immediate) throw new Error('ContinuityService: db.tx.immediate مطلوب');
        this.db = db;
    }

    async importRoster({ month, sourceNote, user }) {
        assertMonth(month);
        const a = actor(user);
        const id = crypto.randomUUID();
        this.db.tx.immediate(hdl => {
            const employees = hdl.prepare(`SELECT * FROM employees WHERE is_active = 1 ORDER BY id`).all();
            const roster = hdl.prepare(`SELECT * FROM shift_roster
                                      WHERE shift_date >= ? AND shift_date <= ?
                                      ORDER BY employee_id, shift_date, id`).all(`${month}-01`, `${month}-31`);
            const rosterByEmployee = new Map();
            let inactiveRows = 0;
            const activeIds = new Set(employees.map(e => e.id));
            for (const row of roster) {
                if (!activeIds.has(row.employee_id)) { inactiveRows++; continue; }
                if (!rosterByEmployee.has(row.employee_id)) rosterByEmployee.set(row.employee_id, []);
                rosterByEmployee.get(row.employee_id).push(row);
            }
            const content = {
                schema_version: 1,
                month,
                source: { type: 'shift_roster', row_count: roster.length, inactive_employee_rows: inactiveRows },
                employees: employees.map(employee => {
                    const rows = rosterByEmployee.get(employee.id) || [];
                    const byDate = new Map();
                    for (const row of rows) {
                        if (!byDate.has(row.shift_date)) byDate.set(row.shift_date, []);
                        byDate.get(row.shift_date).push(row);
                    }
                    return {
                        employee_id: employee.id,
                        employee_code: employee.employee_code,
                        name: employee.name,
                        pattern_code: employee.pattern_code || null,
                        days: daysOfMonth(month).map(date => {
                            const dayRows = byDate.get(date) || [];
                            const issues = [];
                            if (dayRows.length > 1) issues.push('duplicate_roster_rows');
                            return {
                                date,
                                shift_code: dayRows.length ? dayRows[dayRows.length - 1].shift_code : null,
                                roster_ids: dayRows.map(r => r.id),
                                team_ids: [...new Set(dayRows.map(r => r.team_id).filter(v => v !== null))],
                                issues
                            };
                        })
                    };
                })
            };
            const nextVersion = (hdl.prepare('SELECT COALESCE(MAX(version_number), 0) AS n FROM schedule_versions WHERE month = ?').get(month).n || 0) + 1;
            hdl.prepare(`INSERT INTO schedule_versions
                (id, month, version_number, version_kind, status, source_type, source_note, content_json, content_hash, created_by)
                VALUES (?, ?, ?, 'bootstrap_reference', 'imported', 'shift_roster', ?, ?, '', ?)`)
                .run(id, month, nextVersion, sourceNote || null, canonicalStringify(content), a.id);
            const inserted = getVersionTx(hdl, id);
            const insertGap = hdl.prepare(`INSERT INTO schedule_gap_reviews
                (id, version_id, employee_id, gap_date, resolution) VALUES (?, ?, ?, ?, 'unresolved')`);
            for (const employee of content.employees) {
                const hasReference = employee.days.some(day => day.roster_ids.length > 0);
                if (!hasReference) continue;
                for (const day of employee.days) {
                    if (day.roster_ids.length === 0) insertGap.run(crypto.randomUUID(), id, employee.employee_id, day.date);
                }
            }
            const initialHash = fullHashTx(hdl, inserted);
            hdl.prepare('UPDATE schedule_versions SET content_hash = ? WHERE id = ?').run(initialHash, id);
            auditTx(hdl, user, 'schedule_reference_imported',
                `استيراد مرجع ${month} #${nextVersion} من shift_roster · ${roster.length} صف · ${content.employees.length} موظف · SHA-256 ${initialHash}`);
        });
        return this.getVersion(id);
    }

    async openDraft(id, user) {
        this.db.tx.immediate(hdl => {
            const version = getVersionTx(hdl, id);
            if (version.status !== 'imported') fail(409, 'INVALID_VERSION_STATE', 'فتح المسودة متاح من الحالة المستوردة فقط');
            hdl.prepare("UPDATE schedule_versions SET status = 'draft' WHERE id = ?").run(version.id);
            auditTx(hdl, user, 'schedule_reference_draft_opened', `فتح مسودة الإصدار ${version.id} لشهر ${version.version_number}/${version.month}`);
        });
        return this.getVersion(id);
    }

    async reviewGaps(id, reviews, user) {
        if (!Array.isArray(reviews) || reviews.length === 0) fail(422, 'REVIEWS_REQUIRED', 'قائمة مراجعات الفراغات مطلوبة');
        if (reviews.length > 1000) fail(422, 'TOO_MANY_REVIEWS', 'الحد الأقصى 1000 مراجعة في العملية');
        const a = actor(user);
        this.db.tx.immediate(hdl => {
            const version = getVersionTx(hdl, id);
            assertEditable(version);
            if (version.status === 'imported') fail(409, 'DRAFT_REQUIRED', 'افتح المسودة قبل مراجعة الفراغات');
            const update = hdl.prepare(`UPDATE schedule_gap_reviews
                SET resolution = ?, reason = ?, reviewed_by = ?, reviewed_at = datetime('now')
                WHERE id = ? AND version_id = ?`);
            for (const input of reviews) {
                const employeeId = Number(input.employee_id);
                if (!Number.isInteger(employeeId) || !DATE_RE.test(String(input.gap_date || ''))) {
                    fail(422, 'INVALID_GAP_REVIEW', 'بيانات مراجعة الفراغ غير صالحة');
                }
                if (!GAP_RESOLUTIONS.has(input.resolution)) fail(422, 'INVALID_GAP_RESOLUTION', 'دلالة الفراغ غير صالحة');
                const reason = String(input.reason || '').trim();
                if (['missing_data', 'out_of_scope', 'other_approved'].includes(input.resolution) && !reason) {
                    fail(422, 'GAP_REASON_REQUIRED', 'هذه الدلالة تتطلب سببًا موثقًا');
                }
                const gap = hdl.prepare('SELECT * FROM schedule_gap_reviews WHERE version_id = ? AND employee_id = ? AND gap_date = ?')
                    .get(version.id, employeeId, input.gap_date);
                if (!gap) fail(404, 'GAP_NOT_FOUND', `الفراغ ${input.gap_date} للموظف ${employeeId} غير موجود`);
                update.run(input.resolution, reason || null, a.id, gap.id, version.id);
            }
            hdl.prepare("UPDATE schedule_versions SET reviewed_by = ?, reviewed_at = datetime('now'), status = 'draft' WHERE id = ?")
                .run(a.id, version.id);
            const after = getVersionTx(hdl, id);
            hdl.prepare('UPDATE schedule_versions SET content_hash = ? WHERE id = ?').run(fullHashTx(hdl, after), id);
            auditTx(hdl, user, 'schedule_gaps_reviewed', `مراجعة ${reviews.length} فراغًا في الإصدار ${id}`);
        });
        return this.getVersion(id);
    }

    _deriveEmployee(employee, gapByDate, patterns, codes, month) {
        const rawDays = employee.days;
        const hasReferenceDays = rawDays.some(day => day.roster_ids.length ||
            (day.issues || []).some(issue => String(issue).startsWith('smart_import:')));
        if (!hasReferenceDays) {
            return {
                employee_id: employee.employee_id, status: 'no_reference', pattern_code: null,
                next_phase_index: null, next_shift_code: null, team_id: null,
                assignment_status: 'not_applicable', effective_date: null, state_version: 1,
                resolution_source: 'derived', reason: 'لا توجد أي صفوف مرجعية للموظف في هذا الشهر؛ يلزم إسناد بشري.'
            };
        }
        const pattern = patterns.get(employee.pattern_code);
        if (!pattern || !pattern.cycle) {
            return {
                employee_id: employee.employee_id, status: 'unresolved', pattern_code: employee.pattern_code || null,
                next_phase_index: null, next_shift_code: null, team_id: null, assignment_status: 'unresolved',
                effective_date: null, state_version: 1, resolution_source: 'derived',
                reason: 'لا توجد دورة صريحة وصالحة في shift_patterns.cycle_json؛ لا يُفترض نمط أو طور.'
            };
        }
        const cycle = pattern.cycle;
        for (const code of cycle) {
            if (!codes.has(code)) {
                return {
                    employee_id: employee.employee_id, status: 'unresolved', pattern_code: employee.pattern_code,
                    next_phase_index: null, next_shift_code: null, team_id: null, assignment_status: 'unresolved',
                    effective_date: null, state_version: 1, resolution_source: 'derived', reason: `رمز الدورة ${code} غير موجود في shift_codes.`
                };
            }
        }
        for (const day of rawDays) {
            if (day.issues.length) {
                return {
                    employee_id: employee.employee_id, status: 'unresolved', pattern_code: employee.pattern_code,
                    next_phase_index: null, next_shift_code: null, team_id: null, assignment_status: 'unresolved',
                    effective_date: null, state_version: 1, resolution_source: 'derived', reason: `صفوف مكررة في ${day.date}؛ يلزم حسم المصدر بشريًا.`
                };
            }
            if (day.shift_code && !codes.has(day.shift_code)) {
                return {
                    employee_id: employee.employee_id, status: 'unresolved', pattern_code: employee.pattern_code,
                    next_phase_index: null, next_shift_code: null, team_id: null, assignment_status: 'unresolved',
                    effective_date: null, state_version: 1, resolution_source: 'derived', reason: `رمز غير معروف ${day.shift_code} في ${day.date}.`
                };
            }
            const gap = gapByDate.get(day.date);
            if (!day.shift_code && (!gap || gap.resolution === 'unresolved')) {
                return {
                    employee_id: employee.employee_id, status: 'unresolved', pattern_code: employee.pattern_code,
                    next_phase_index: null, next_shift_code: null, team_id: null, assignment_status: 'unresolved',
                    effective_date: null, state_version: 1, resolution_source: 'derived', reason: `فراغ غير محسوم في ${day.date}.`
                };
            }
            if (gap && ['missing_data', 'out_of_scope', 'other_approved'].includes(gap.resolution)) {
                return {
                    employee_id: employee.employee_id, status: 'unresolved', pattern_code: employee.pattern_code,
                    next_phase_index: null, next_shift_code: null, team_id: null, assignment_status: 'unresolved',
                    effective_date: null, state_version: 1, resolution_source: 'derived', reason: `الفراغ ${day.date} (${gap.resolution}) يتطلب إسناد استمرارية بشريًا.`
                };
            }
        }
        const candidates = new Set();
        for (let start = 0; start < cycle.length; start++) {
            let matches = true;
            for (let index = 0; index < rawDays.length; index++) {
                const day = rawDays[index];
                const gap = gapByDate.get(day.date);
                let actual = day.shift_code;
                if (!actual && gap && gap.resolution === 'rest_confirmed') actual = 'WO';
                if (!actual) { matches = false; break; }
                const actualCode = codes.get(actual);
                if (actualCode && actualCode.status === 'إجازة') continue; // wildcard مع استمرار مرور اليوم
                if (actual !== cycle[(start + index) % cycle.length]) { matches = false; break; }
            }
            if (matches) candidates.add((start + rawDays.length) % cycle.length);
        }
        const teamIds = [...new Set(rawDays.flatMap(day => day.team_ids))];
        const teamId = teamIds.length === 1 ? teamIds[0] : null;
        const assignmentStatus = teamIds.length === 1 ? 'resolved' : 'unresolved';
        if (candidates.size !== 1) {
            return {
                employee_id: employee.employee_id, status: 'unresolved', pattern_code: employee.pattern_code,
                next_phase_index: null, next_shift_code: null, team_id: teamId, assignment_status: assignmentStatus,
                effective_date: null, state_version: 1, resolution_source: 'derived',
                reason: candidates.size === 0 ? 'الرموز الفعلية لا تطابق الدورة الصريحة.' : 'أكثر من طور محتمل يطابق المرجع؛ لا يُختار طور تخمينيًا.'
            };
        }
        const nextPhase = [...candidates][0];
        return {
            employee_id: employee.employee_id, status: 'resolved', pattern_code: employee.pattern_code,
            next_phase_index: nextPhase, next_shift_code: cycle[nextPhase], team_id: teamId,
            assignment_status: assignmentStatus, effective_date: `${nextMonth(month)}-01`, state_version: 1,
            resolution_source: 'derived', reason: teamIds.length > 1 ? 'حُسم الطور، ويلزم حسم الفريق يدويًا لتعدد الفرق في المرجع.' : null
        };
    }

    async derive(id, user) {
        const a = actor(user);
        let snapshotId;
        this.db.tx.immediate(hdl => {
            const version = getVersionTx(hdl, id);
            assertEditable(version);
            if (version.status === 'imported') fail(409, 'DRAFT_REQUIRED', 'افتح المسودة قبل اشتقاق الاستمرارية');
            const content = parseJson(version.content_json);
            const gaps = gapReviewsTx(hdl, version.id);
            const gapsByEmployee = new Map();
            for (const gap of gaps) {
                if (!gapsByEmployee.has(gap.employee_id)) gapsByEmployee.set(gap.employee_id, new Map());
                gapsByEmployee.get(gap.employee_id).set(gap.gap_date, gap);
            }
            const patterns = cycleMapTx(hdl);
            const codes = shiftCodeMapTx(hdl);
            const entries = content.employees.map(employee => this._deriveEmployee(
                employee, gapsByEmployee.get(employee.employee_id) || new Map(), patterns, codes, content.month));
            for (const entry of entries) {
                if (!ENTRY_STATUSES.has(entry.status)) fail(500, 'DERIVATION_ERROR', 'حالة استمرارية غير صالحة');
            }
            const old = currentSnapshotTx(hdl, version.id);
            if (old) hdl.prepare('UPDATE schedule_continuity_snapshots SET is_current = 0 WHERE id = ?').run(old.id);
            const number = (hdl.prepare('SELECT COALESCE(MAX(snapshot_number), 0) AS n FROM schedule_continuity_snapshots WHERE version_id = ?').get(version.id).n || 0) + 1;
            snapshotId = crypto.randomUUID();
            const sourceHash = sourceHashTx(hdl, version);
            const summary = summarize(content, gaps, entries);
            hdl.prepare(`INSERT INTO schedule_continuity_snapshots
                (id, version_id, snapshot_number, is_current, status, source_content_hash, summary_json, created_by)
                VALUES (?, ?, ?, 1, 'draft', ?, ?, ?)`)
                .run(snapshotId, version.id, number, sourceHash, canonicalStringify(summary), a.id);
            const insert = hdl.prepare(`INSERT INTO schedule_continuity_entries
                (id, snapshot_id, employee_id, status, pattern_code, next_phase_index, next_shift_code, team_id,
                 assignment_status, effective_date, state_version, resolution_source, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const e of entries) {
                insert.run(crypto.randomUUID(), snapshotId, e.employee_id, e.status, e.pattern_code, e.next_phase_index,
                    e.next_shift_code, e.team_id, e.assignment_status, e.effective_date, e.state_version, e.resolution_source, e.reason);
            }
            const nextStatus = summary.blocker_count === 0 ? 'ready_for_review' : 'draft';
            hdl.prepare('UPDATE schedule_versions SET status = ?, content_hash = ? WHERE id = ?')
                .run(nextStatus, fullHashTx(hdl, version), version.id);
            auditTx(hdl, user, 'schedule_continuity_derived',
                `لقطة استمرارية #${number} للإصدار ${id} · resolved=${summary.counts.resolved} · blockers=${summary.blocker_count}`);
        });
        return this.getVersion(id);
    }

    async assignContinuity(id, employeeId, input, user) {
        employeeId = Number(employeeId);
        if (!Number.isInteger(employeeId)) fail(422, 'INVALID_EMPLOYEE', 'معرّف الموظف غير صالح');
        const a = actor(user);
        this.db.tx.immediate(hdl => {
            const version = getVersionTx(hdl, id);
            assertEditable(version);
            if (version.status === 'imported') fail(409, 'DRAFT_REQUIRED', 'افتح المسودة قبل الإسناد');
            const content = parseJson(version.content_json);
            if (!content.employees.some(e => e.employee_id === employeeId)) fail(404, 'EMPLOYEE_NOT_IN_VERSION', 'الموظف غير موجود في هذا الإصدار');
            const snapshot = currentSnapshotTx(hdl, version.id);
            if (!snapshot) fail(409, 'SNAPSHOT_REQUIRED', 'اشتقق لقطة الاستمرارية أولًا');
            if (snapshot.source_content_hash !== sourceHashTx(hdl, version)) {
                fail(409, 'STALE_SNAPSHOT', 'اللقطة مبنية على مرجع قديم؛ أعد الاشتقاق قبل الإسناد');
            }
            const existing = hdl.prepare('SELECT * FROM schedule_continuity_entries WHERE snapshot_id = ? AND employee_id = ?')
                .get(snapshot.id, employeeId);
            if (!existing) fail(404, 'CONTINUITY_ENTRY_NOT_FOUND', 'مدخل الاستمرارية غير موجود');
            const reason = String(input.reason || '').trim();
            if (!reason) fail(422, 'REASON_REQUIRED', 'السبب الإداري مطلوب للتوثيق');
            let values;
            if (input.status === 'excluded') {
                values = {
                    status: 'excluded', pattern_code: null, next_phase_index: null, next_shift_code: null,
                    team_id: null, assignment_status: 'not_applicable', effective_date: null,
                    resolution_source: 'exclusion', reason
                };
            } else if (input.status === 'resolved') {
                const pattern = cycleMapTx(hdl).get(input.pattern_code);
                if (!pattern || !pattern.cycle) fail(422, 'INVALID_PATTERN', 'النمط غير موجود أو لا يملك دورة صريحة صالحة');
                const cycle = pattern.cycle;
                const codes = shiftCodeMapTx(hdl);
                if (cycle.some(code => !codes.has(code))) fail(422, 'INVALID_PATTERN_CODES', 'الدورة تتضمن رمزًا غير معروف');
                const phase = Number(input.next_phase_index);
                if (!Number.isInteger(phase) || phase < 0 || phase >= cycle.length) fail(422, 'INVALID_PHASE', 'طور الاستمرارية خارج حدود الدورة');
                const expectedDate = `${nextMonth(version.month)}-01`;
                if (input.effective_date !== expectedDate) fail(422, 'INVALID_EFFECTIVE_DATE', `تاريخ السريان يجب أن يكون ${expectedDate}`);
                const nextCode = cycle[phase];
                if (input.next_shift_code !== undefined && input.next_shift_code !== nextCode) fail(422, 'PHASE_CODE_MISMATCH', 'رمز المناوبة لا يطابق الطور المحدد');
                let teamId = null;
                let assignmentStatus = 'not_applicable';
                if (input.team_id !== undefined && input.team_id !== null && input.team_id !== '') {
                    teamId = Number(input.team_id);
                    if (!Number.isInteger(teamId) || !hdl.prepare('SELECT 1 AS x FROM teams WHERE id = ?').get(teamId)) {
                        fail(422, 'INVALID_TEAM', 'الفريق المحدد غير موجود');
                    }
                    assignmentStatus = 'resolved';
                }
                values = {
                    status: 'resolved', pattern_code: input.pattern_code, next_phase_index: phase,
                    next_shift_code: nextCode, team_id: teamId, assignment_status: assignmentStatus,
                    effective_date: expectedDate, resolution_source: 'manual_reviewed', reason
                };
            } else {
                fail(422, 'INVALID_CONTINUITY_STATUS', 'الإسناد اليدوي يقبل resolved أو excluded فقط');
            }
            hdl.prepare(`UPDATE schedule_continuity_entries SET
                status = ?, pattern_code = ?, next_phase_index = ?, next_shift_code = ?, team_id = ?,
                assignment_status = ?, effective_date = ?, state_version = state_version + 1,
                resolution_source = ?, reason = ? WHERE id = ?`)
                .run(values.status, values.pattern_code, values.next_phase_index, values.next_shift_code, values.team_id,
                    values.assignment_status, values.effective_date, values.resolution_source, values.reason, existing.id);
            const gaps = gapReviewsTx(hdl, version.id);
            const entries = snapshotEntriesTx(hdl, snapshot.id);
            const summary = summarize(content, gaps, entries);
            hdl.prepare('UPDATE schedule_continuity_snapshots SET summary_json = ? WHERE id = ?')
                .run(canonicalStringify(summary), snapshot.id);
            const nextStatus = summary.blocker_count === 0 ? 'ready_for_review' : 'draft';
            hdl.prepare('UPDATE schedule_versions SET status = ?, content_hash = ? WHERE id = ?')
                .run(nextStatus, fullHashTx(hdl, version), version.id);
            auditTx(hdl, user, 'schedule_continuity_manually_assigned',
                `إسناد استمرارية الموظف ${employeeId} في الإصدار ${id}: ${values.status} · ${reason}`);
        });
        return this.getVersion(id);
    }

    async approve(id, expectedHash, user) {
        const a = actor(user);
        this.db.tx.immediate(hdl => {
            const version = getVersionTx(hdl, id);
            assertEditable(version);
            if (version.status !== 'ready_for_review') fail(409, 'VERSION_NOT_READY', 'الإصدار ليس جاهزًا للاعتماد');
            if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ''))) fail(422, 'CONTENT_HASH_REQUIRED', 'بصمة SHA-256 مطلوبة للاعتماد');
            if (version.content_hash !== expectedHash) fail(409, 'CONTENT_HASH_MISMATCH', 'تغيرت بصمة الإصدار؛ راجع النسخة الحالية قبل الاعتماد');
            if (fullHashTx(hdl, version) !== expectedHash) fail(409, 'CONTENT_HASH_MISMATCH', 'البصمة المحسوبة لا تطابق محتوى الإصدار');
            const snapshot = currentSnapshotTx(hdl, version.id);
            if (!snapshot) fail(409, 'SNAPSHOT_REQUIRED', 'لا توجد لقطة استمرارية حالية');
            if (snapshot.source_content_hash !== sourceHashTx(hdl, version)) fail(409, 'STALE_SNAPSHOT', 'اللقطة مبنية على مرجع قديم؛ أعد الاشتقاق');
            const content = parseJson(version.content_json);
            const summary = summarize(content, gapReviewsTx(hdl, version.id), snapshotEntriesTx(hdl, snapshot.id));
            if (summary.blocker_count) fail(409, 'UNRESOLVED_BLOCKERS', 'توجد فراغات أو استمرارية غير محسومة تمنع الاعتماد');
            hdl.prepare("UPDATE schedule_continuity_snapshots SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?")
                .run(a.id, snapshot.id);
            hdl.prepare("UPDATE schedule_versions SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?")
                .run(a.id, version.id);
            auditTx(hdl, user, 'schedule_reference_approved', `اعتماد الإصدار ${id} لشهر ${version.month} · اللقطة #${snapshot.snapshot_number} · SHA-256 ${expectedHash}`);
        });
        return this.getVersion(id);
    }

    async getVersion(id) {
        const row = await this.db.get('SELECT * FROM schedule_versions WHERE id = ?', [String(id)]);
        if (!row) fail(404, 'VERSION_NOT_FOUND', 'إصدار الجدول غير موجود');
        const gaps = await this.db.all('SELECT * FROM schedule_gap_reviews WHERE version_id = ? ORDER BY employee_id, gap_date', [row.id]);
        const snapshots = await this.db.all('SELECT * FROM schedule_continuity_snapshots WHERE version_id = ? ORDER BY snapshot_number', [row.id]);
        const current = snapshots.find(s => s.is_current === 1) || null;
        const entries = current ? await this.db.all('SELECT * FROM schedule_continuity_entries WHERE snapshot_id = ? ORDER BY employee_id', [current.id]) : [];
        const content = parseJson(row.content_json, {});
        const summary = summarize(content, gaps, entries);
        return {
            ...serializeVersion(row),
            gap_reviews: gaps,
            snapshots: snapshots.map(s => ({ ...s, summary: parseJson(s.summary_json, {}), summary_json: undefined })),
            current_snapshot: current ? { ...current, summary: parseJson(current.summary_json, {}), summary_json: undefined, entries } : null,
            readiness: { ready: row.status === 'ready_for_review' || row.status === 'approved' || row.status === 'published', blockers: summary.blockers, warnings: summary.warnings }
        };
    }

    async listVersions({ month, status, limit = 100 } = {}) {
        if (month) assertMonth(month);
        if (status && !['imported', 'draft', 'ready_for_review', 'approved', 'published'].includes(status)) {
            fail(422, 'INVALID_VERSION_STATUS', 'حالة الإصدار غير صالحة');
        }
        limit = Math.min(Math.max(Number(limit) || 100, 1), 500);
        const where = [];
        const params = [];
        if (month) { where.push('month = ?'); params.push(month); }
        if (status) { where.push('status = ?'); params.push(status); }
        const rows = await this.db.all(`SELECT id, month, version_number, version_kind, status, source_type,
            parent_version_id, content_hash, reference_version_id, reference_content_hash, created_by, created_at,
            approved_by, approved_at, published_by, published_at FROM schedule_versions
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY month DESC, version_number DESC LIMIT ?`, [...params, limit]);
        return { versions: rows };
    }

    async getReference(targetMonth) {
        assertMonth(targetMonth, 'target_month');
        const requiredMonth = previousMonth(targetMonth);
        const exact = await this.db.get(`SELECT id FROM schedule_versions WHERE month = ?
            AND version_kind = 'bootstrap_reference' AND status IN ('approved','published')
            ORDER BY version_number DESC LIMIT 1`, [requiredMonth]);
        if (exact) {
            return { target_month: targetMonth, required_month: requiredMonth, usable: true, reason: null, missing_months: [], reference: await this.getVersion(exact.id) };
        }
        const older = await this.db.get(`SELECT month FROM schedule_versions WHERE month < ?
            AND version_kind = 'bootstrap_reference' AND status IN ('approved','published')
            ORDER BY month DESC, version_number DESC LIMIT 1`, [targetMonth]);
        const missing = older ? monthsBetweenExclusive(older.month, targetMonth) : [requiredMonth];
        return {
            target_month: targetMonth,
            required_month: requiredMonth,
            usable: false,
            reason: older ? 'REFERENCE_MONTH_GAP' : 'NO_APPROVED_REFERENCE',
            missing_months: missing,
            reference: null
        };
    }
}

module.exports = {
    ContinuityService,
    ContinuityError,
    canonicalStringify,
    contentHash,
    daysOfMonth,
    nextMonth,
    previousMonth,
    monthsBetweenExclusive,
    parseCycleRow,
    blockersFor
};
