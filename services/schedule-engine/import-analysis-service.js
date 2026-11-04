/**
 * محلل بنية الجداول ودلالاتها: لا يغيّر القاموس ولا يفترض راحة أو دورة تشغيلية.
 * كل استخراج يحمل مصدره وسببه، وكل غموض يبقى مهمة مراجعة بشرية.
 */
'use strict';

const crypto = require('crypto');
const XLSX = require('xlsx');
const { clean } = require('./import-format-service');
const { canonicalStringify, contentHash, daysOfMonth } = require('./continuity-service');

const MONTHS = {
    'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'ابريل': 4, 'مايو': 5, 'يونيو': 6,
    'يوليو': 7, 'أغسطس': 8, 'اغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};
const HEADER = {
    employee: ['الموظف', 'اسم الموظف', 'الاسم', 'اسم المسعف', 'employee', 'employee name', 'name', 'paramedic'],
    employeeCode: ['الرقم الوظيفي', 'رقم الموظف', 'الكود الوظيفي', 'كود الموظف', 'الرقم', 'employee id', 'employee number', 'code', 'id'],
    date: ['التاريخ', 'تاريخ المناوبة', 'اليوم', 'date', 'shift date', 'day'],
    shift: ['المناوبة', 'الوردية', 'رمز المناوبة', 'الرمز', 'shift', 'shift code', 'duty'],
    team: ['الفريق', 'المركز', 'الموقع', 'الوحدة', 'team', 'center', 'location', 'unit'],
    hours: ['الساعات', 'ساعات العمل', 'عدد الساعات', 'الإجمالي', 'hours', 'total hours', 'total'],
    start: ['بداية المناوبة', 'من', 'وقت البداية', 'start', 'start time'],
    end: ['نهاية المناوبة', 'إلى', 'وقت النهاية', 'end', 'end time'],
    notes: ['ملاحظات', 'ملاحظة', 'الحواشي', 'notes', 'note', 'comments']
};
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
function asciiDigits(value) { return String(value || '').replace(/[٠-٩۰-۹]/g, ch => ARABIC_DIGITS[ch] || ch); }
function normalizeText(value) {
    return clean(value).toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeCode(value) { return asciiDigits(clean(value)).toUpperCase().replace(/[ـ\s]+/g, ''); }
function headerKind(value) {
    const normalized = normalizeText(value);
    if (!normalized) return null;
    for (const [kind, synonyms] of Object.entries(HEADER)) {
        if (synonyms.some(synonym => normalizeText(synonym) === normalized)) return kind;
    }
    return null;
}
function validIsoDate(year, month, day) {
    if (!year || !month || !day) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}
function parseDate(value, contextMonth, rawValue) {
    if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) return rawValue.toISOString().slice(0, 10);
    if (typeof rawValue === 'number' && rawValue > 20000 && rawValue < 80000) {
        const parsed = XLSX.SSF.parse_date_code(rawValue);
        if (parsed) return validIsoDate(parsed.y, parsed.m, parsed.d);
    }
    const text = asciiDigits(clean(value)).replace(/\s+/g, ' ');
    if (!text) return null;
    let match = text.match(/(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (match) return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    match = text.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2})/);
    if (match) return validIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
    match = text.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2})(?!\d)/);
    if (match) return validIsoDate(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
    match = text.match(/(\d{1,2})\s+([^\s]+)\s+(20\d{2})/);
    if (match && MONTHS[normalizeText(match[2])]) return validIsoDate(Number(match[3]), MONTHS[normalizeText(match[2])], Number(match[1]));
    if (contextMonth) {
        match = text.match(/^(?:اليوم\s+)?(\d{1,2})$/);
        if (match) return validIsoDate(Number(contextMonth.slice(0, 4)), Number(contextMonth.slice(5, 7)), Number(match[1]));
        match = text.match(/^(\d{1,2})[-\/.](\d{1,2})$/);
        if (match && Number(match[2]) === Number(contextMonth.slice(5, 7))) {
            return validIsoDate(Number(contextMonth.slice(0, 4)), Number(match[2]), Number(match[1]));
        }
    }
    return null;
}
function detectMonth(sheets) {
    for (const sheet of sheets) {
        for (let r = 0; r < Math.min(12, sheet.rows.length); r++) {
            for (let c = 0; c < sheet.rows[r].length; c++) {
                const raw = sheet.cells && sheet.cells[`${r}:${c}`] && sheet.cells[`${r}:${c}`].raw;
                const text = asciiDigits(clean(sheet.rows[r][c]));
                const fullDate = parseDate(text, null, raw);
                if (fullDate) return fullDate.slice(0, 7);
                let match = text.match(/(20\d{2})[-\/.](\d{1,2})(?![\d\/.-])/);
                if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return `${match[1]}-${match[2].padStart(2, '0')}`;
                match = text.match(/(\d{1,2})[-\/.](20\d{2})(?![\d\/.-])/);
                if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) return `${match[2]}-${match[1].padStart(2, '0')}`;
                for (const [name, number] of Object.entries(MONTHS)) {
                    if (normalizeText(text).includes(normalizeText(name))) {
                        const year = text.match(/20\d{2}/);
                        if (year) return `${year[0]}-${String(number).padStart(2, '0')}`;
                    }
                }
            }
        }
    }
    return null;
}
function nonEmpty(row) { return row.some(cell => clean(cell)); }
function trimBlock(rows) {
    const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
    return rows.map(row => Array.from({ length: width }, (_, i) => clean(row[i])));
}
function splitBlocks(sheet) {
    const rows = trimBlock(sheet.rows);
    const rowSegments = []; let current = [], rowOffset = 0;
    rows.forEach((row, index) => {
        if (nonEmpty(row)) {
            if (!current.length) rowOffset = index;
            current.push(row);
        } else if (current.length) { rowSegments.push({ rows: current, rowOffset }); current = []; }
    });
    if (current.length) rowSegments.push({ rows: current, rowOffset });
    const blocks = [];
    rowSegments.forEach((segment, segmentIndex) => {
        const width = segment.rows.reduce((n, row) => Math.max(n, row.length), 0);
        const blankColumns = [];
        for (let c = 0; c < width; c++) if (segment.rows.every(row => !clean(row[c]))) blankColumns.push(c);
        const boundaries = [...new Set([0, ...blankColumns.flatMap(c => [c, c + 1]), width])].sort((a, b) => a - b);
        for (let i = 0; i < boundaries.length - 1; i++) {
            const start = boundaries[i], end = boundaries[i + 1];
            if (end <= start) continue;
            const matrix = segment.rows.map(row => row.slice(start, end));
            if (matrix.some(nonEmpty)) blocks.push({ id: `${sheet.name}:${segmentIndex + 1}:${start + 1}`, sheet: sheet.name,
                rows: trimBlock(matrix), columnOffset: start, rowOffset: segment.rowOffset });
        }
    });
    return blocks;
}
function levenshtein(a, b) {
    const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0]; previous[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const saved = previous[j];
            previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = saved;
        }
    }
    return previous[b.length];
}
function similarity(a, b) { return a && b ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 0; }
function employeeExtractor(code, name) { return { employeeCode: code || null, employeeName: name || null, teamName: null, shiftCode: null }; }
function buildReferenceIndexes(reference) {
    const byCode = new Map(), byName = new Map();
    for (const employee of reference.employees) {
        byCode.set(asciiDigits(clean(employee.employee_code)), employee);
        const key = normalizeText(employee.name); if (!byName.has(key)) byName.set(key, []); byName.get(key).push(employee);
    }
    const shiftByCode = new Map(), shiftByName = new Map();
    for (const shift of reference.shiftCodes) {
        shiftByCode.set(normalizeCode(shift.code), shift);
        const key = normalizeText(shift.name); if (key && !shiftByName.has(key)) shiftByName.set(key, shift);
    }
    const teamByName = new Map();
    for (const team of reference.teams) teamByName.set(normalizeText(team.name), team);
    return { byCode, byName, shiftByCode, shiftByName, teamByName };
}
function matchEmployee(code, name, reference, indexes) {
    const normalizedCode = asciiDigits(clean(code));
    if (normalizedCode && indexes.byCode.has(normalizedCode)) return { employee: indexes.byCode.get(normalizedCode), status: 'resolved', reason: 'مطابقة الرقم الوظيفي حرفيًا', candidates: [] };
    const normalizedName = normalizeText(name);
    const exact = indexes.byName.get(normalizedName) || [];
    if (exact.length === 1) return { employee: exact[0], status: 'resolved', reason: code ? 'الاسم مطابق حرفيًا؛ الرقم المكتوب لم يطابق السجل' : 'مطابقة الاسم المطبع حرفيًا', candidates: exact };
    if (exact.length > 1) return { employee: null, status: 'needs_review', reason: 'الاسم مكرر في سجل الموظفين', candidates: exact };
    const scored = reference.employees.map(employee => ({ employee, score: similarity(normalizedName, normalizeText(employee.name)) }))
        .filter(row => row.score >= 0.84).sort((a, b) => b.score - a.score).slice(0, 5);
    if (scored.length && scored[0].score >= 0.9 && (!scored[1] || scored[0].score - scored[1].score >= 0.07)) {
        return { employee: scored[0].employee, status: 'needs_review', reason: `مطابقة اسم تقريبية ${Math.round(scored[0].score * 100)}%؛ لا تُقبل إلا بمراجعة`, candidates: scored.map(row => row.employee) };
    }
    return { employee: null, status: 'needs_review', reason: 'تعذر إسناد الاسم/الرقم لموظف واحد', candidates: scored.map(row => row.employee) };
}
function matchShift(raw, indexes) {
    const code = normalizeCode(raw);
    if (!code) return { shift: null, status: 'empty', reason: 'خلية فارغة؛ لم تُفسر كراحة' };
    if (indexes.shiftByCode.has(code)) return { shift: indexes.shiftByCode.get(code), status: 'resolved', reason: 'الرمز موجود في قاموس المناوبات المعتمد' };
    const byName = indexes.shiftByName.get(normalizeText(raw));
    if (byName) return { shift: byName, status: 'resolved', reason: 'الاسم مطابق لمعنى رمز معتمد في القاموس' };
    return { shift: null, status: 'needs_review', reason: 'رمز أو معنى غير موجود في القاموس؛ لم يُخترع له تفسير' };
}
function matchTeam(raw, indexes) {
    const team = indexes.teamByName.get(normalizeText(raw));
    if (team) return { team, status: 'resolved', reason: 'اسم الفريق/المركز مطابق للسجل' };
    return { team: null, status: 'needs_review', reason: 'الفريق/المركز غير مطابق لسجل الفرق' };
}
function originalCoordinate(block, r, c) {
    return block.transposed
        ? { r: c + (block.rowOffset || 0), c: r + (block.columnOffset || 0) }
        : { r: r + (block.rowOffset || 0), c: c + (block.columnOffset || 0) };
}
function sourceOf(sheet, block, r, c, extra = {}) {
    const original = originalCoordinate(block, r, c);
    return { sheet: sheet.name, block: block.id, row: original.r + 1, column: original.c + 1, ...extra };
}
function rawCellAt(sheet, block, r, c) {
    if (!sheet.cells) return null;
    const original = originalCoordinate(block, r, c);
    return sheet.cells[`${original.r}:${original.c}`] || null;
}
function parseLong(block, sheet, headerRow, mapping, context, addAssignment) {
    for (let r = headerRow + 1; r < block.rows.length; r++) {
        const row = block.rows[r]; if (!nonEmpty(row)) continue;
        const employee = mapping.employee !== undefined ? row[mapping.employee] : '';
        const code = mapping.employeeCode !== undefined ? row[mapping.employeeCode] : '';
        const date = mapping.date !== undefined ? row[mapping.date] : '';
        const shift = mapping.shift !== undefined ? row[mapping.shift] : '';
        if (!nonEmpty([employee, code, date, shift])) continue;
        const source = sourceOf(sheet, block, r, mapping.shift !== undefined ? mapping.shift : 0);
        const rawCell = rawCellAt(sheet, block, r, mapping.shift !== undefined ? mapping.shift : 0);
        const rawDate = mapping.date !== undefined ? rawCellAt(sheet, block, r, mapping.date) : null;
        addAssignment({
            employeeCode: code, employeeName: employee, date, rawDate: rawDate && rawDate.raw,
            teamName: mapping.team !== undefined ? row[mapping.team] : null,
            shiftCode: shift,
            hours: mapping.hours !== undefined ? row[mapping.hours] : null,
            start: mapping.start !== undefined ? row[mapping.start] : null,
            end: mapping.end !== undefined ? row[mapping.end] : null,
            notes: mapping.notes !== undefined ? row[mapping.notes] : null,
            source, rawCell, orientation: 'long'
        });
    }
    return { orientation: 'long', headerRow: headerRow + 1, mapping };
}
function findLongHeader(block) {
    for (let r = 0; r < Math.min(10, block.rows.length); r++) {
        const mapping = {};
        block.rows[r].forEach((cell, c) => { const kind = headerKind(cell); if (kind && mapping[kind] === undefined) mapping[kind] = c; });
        if (mapping.date !== undefined && mapping.shift !== undefined && (mapping.employee !== undefined || mapping.employeeCode !== undefined)) return { headerRow: r, mapping };
    }
    return null;
}
function findWideHeader(block, month, sheet) {
    let best = null;
    for (let r = 0; r < Math.min(12, block.rows.length); r++) {
        const row = block.rows[r]; const dates = [];
        row.forEach((cell, c) => {
            const rawCell = rawCellAt(sheet, block, r, c);
            const date = parseDate(cell, month, rawCell && rawCell.raw);
            if (date) dates.push({ c, date });
        });
        // القالب العرضي يحتاج محور تاريخ واضحًا؛ خلية تاريخ منفردة في كل صف
        // قد تكون قالبًا معكوسًا، وتُفحص بعد transposition بدل ابتلاعها كجدول عريض.
        if (dates.length < 2) continue;
        const employeeCodeColumn = row.findIndex(cell => headerKind(cell) === 'employeeCode');
        let employeeColumn = row.findIndex(cell => headerKind(cell) === 'employee');
        if (employeeColumn < 0) employeeColumn = employeeCodeColumn;
        if (employeeColumn < 0) employeeColumn = row.findIndex((cell, c) => !dates.some(d => d.c === c) && normalizeText(cell) && !headerKind(cell));
        if (employeeColumn < 0) employeeColumn = 0;
        const score = dates.length + (headerKind(row[employeeColumn]) ? 2 : 0);
        if (!best || score > best.score) best = { headerRow: r, employeeColumn, employeeCodeColumn, dates, score };
    }
    return best;
}
function transposeBlock(block) {
    const rows = block.rows[0].map((_, c) => block.rows.map(row => clean(row[c])));
    return { ...block, id: block.id + ':transposed', rows, transposed: true };
}
function parseWide(block, sheet, header, context, addAssignment) {
    const { headerRow, employeeColumn, employeeCodeColumn, dates } = header;
    const dateColumns = new Set(dates.map(item => item.c));
    const totalColumns = [];
    block.rows[headerRow].forEach((cell, c) => { if (['hours', 'notes', 'team'].includes(headerKind(cell))) totalColumns.push({ c, kind: headerKind(cell) }); });
    for (let r = headerRow + 1; r < block.rows.length; r++) {
        const row = block.rows[r]; if (!nonEmpty(row)) continue;
        const identity = clean(row[employeeColumn]);
        if (!identity || ['الإجمالي', 'المجموع', 'total'].includes(normalizeText(identity))) continue;
        const embedded = identity.match(/^\s*([0-9٠-٩۰-۹]+)\s*[-–:|]?\s*(.*)$/);
        let employeeCode = employeeCodeColumn >= 0 && employeeCodeColumn !== employeeColumn ? clean(row[employeeCodeColumn]) : (embedded && embedded[2] ? embedded[1] : null);
        let employeeName = embedded && embedded[2] ? embedded[2] : identity;
        if (employeeCodeColumn >= 0 && employeeCodeColumn === employeeColumn) {
            employeeCode = identity;
            employeeName = '';
        } else if (!embedded || !embedded[2]) {
            if (/^[0-9٠-٩۰-۹]+$/.test(identity)) { employeeCode = employeeCode || identity; employeeName = ''; }
        }
        for (const { c, date } of dates) {
            const source = sourceOf(sheet, block, r, c);
            const rawCell = rawCellAt(sheet, block, r, c);
            const extras = {};
            for (const extra of totalColumns) extras[extra.kind] = row[extra.c];
            addAssignment({ employeeCode, employeeName, date, rawDate: date, shiftCode: row[c], teamName: extras.team || null,
                hours: extras.hours || null, notes: extras.notes || null, source, rawCell, orientation: block.transposed ? 'transposed' : 'wide' });
        }
    }
    return { orientation: block.transposed ? 'transposed' : 'wide', headerRow: headerRow + 1, employeeColumn, employeeCodeColumn, dateColumns: [...dateColumns] };
}
function shiftHours(shift) {
    if (!shift || !shift.time_start || !shift.time_end) return null;
    const parse = value => { const m = String(value).match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const start = parse(shift.time_start), end = parse(shift.time_end); if (start === null || end === null) return null;
    let duration = end - start; if (duration <= 0) duration += 1440; return duration / 60;
}
function analyzeDocument(parsed, reference, options = {}) {
    if (!parsed || !Array.isArray(parsed.sheets)) throw new Error('parsed.sheets مطلوب');
    const indexes = buildReferenceIndexes(reference);
    const detectedMonth = detectMonth(parsed.sheets);
    const month = options.month || detectedMonth || null;
    const assignments = [], issues = [], structures = [], warnings = [...(parsed.warnings || [])];
    let issueCounter = 0, assignmentCounter = 0;
    const addIssue = (type, severity, message, source, extra = {}) => {
        const issue = { id: `ISS-${++issueCounter}`, type, severity, message, source: source || null, status: 'pending', ...extra };
        issues.push(issue); return issue;
    };
    if (options.month && detectedMonth && options.month !== detectedMonth) {
        addIssue('MONTH_MISMATCH', 'blocker', `الشهر المحدد ${options.month} يختلف عن شهر الملف المكتشف ${detectedMonth}`, null, { currentValue: detectedMonth, expectedValue: options.month });
    }
    if (!month) addIssue('MONTH_UNRESOLVED', 'blocker', 'لم يُكتشف شهر/سنة الجدول؛ حددهما بشريًا قبل الاستيراد', null);
    const addAssignment = input => {
        const id = `ASM-${++assignmentCounter}`;
        const employeeMatch = matchEmployee(input.employeeCode, input.employeeName, reference, indexes);
        const date = parseDate(input.date, month, input.rawDate);
        const shiftMatch = matchShift(input.shiftCode, indexes);
        const teamMatch = input.teamName ? matchTeam(input.teamName, indexes) : { team: null, status: 'empty', reason: 'لا يوجد فريق في المصدر' };
        const rawShift = clean(input.shiftCode);
        const assignment = {
            id, employee_id: employeeMatch.employee ? Number(employeeMatch.employee.id) : null,
            employee_code: employeeMatch.employee ? employeeMatch.employee.employee_code : asciiDigits(clean(input.employeeCode)) || null,
            employee_name: employeeMatch.employee ? employeeMatch.employee.name : clean(input.employeeName),
            pattern_code: employeeMatch.employee ? employeeMatch.employee.pattern_code || null : null,
            raw_employee_name: clean(input.employeeName), raw_employee_code: clean(input.employeeCode),
            date, raw_date: clean(input.date), shift_code: shiftMatch.shift ? shiftMatch.shift.code : null, raw_shift: rawShift,
            team_id: teamMatch.team ? Number(teamMatch.team.id) : null, raw_team: clean(input.teamName),
            reported_hours: input.hours === null || input.hours === undefined || input.hours === '' ? null : Number(asciiDigits(input.hours)),
            start_time: clean(input.start), end_time: clean(input.end), notes: clean(input.notes),
            status: employeeMatch.status === 'needs_review' || shiftMatch.status === 'needs_review' || teamMatch.status === 'needs_review' || !date ? 'needs_review' : (shiftMatch.status === 'empty' ? 'empty' : 'resolved'),
            evidence: {
                source: input.source, orientation: input.orientation,
                employee: employeeMatch.reason, date: date ? 'تاريخ مكتشف من الخلية وسياق الشهر' : 'تعذر تفسير التاريخ',
                shift: shiftMatch.reason, team: teamMatch.reason,
                cell: input.rawCell ? { display: input.rawCell.display, numberFormat: input.rawCell.numberFormat, style: input.rawCell.style, comments: input.rawCell.comments } : null
            }
        };
        assignments.push(assignment);
        if (employeeMatch.status === 'needs_review') addIssue('EMPLOYEE_UNRESOLVED', 'blocker', `${employeeMatch.reason}: ${clean(input.employeeName) || clean(input.employeeCode)}`, input.source,
            { assignmentId: id, currentValue: employeeMatch.employee ? employeeMatch.employee.id : null,
                candidates: employeeMatch.candidates.map(employee => ({ id: employee.id, employee_code: employee.employee_code, name: employee.name })) });
        if (!date) addIssue('DATE_UNRESOLVED', 'blocker', `تعذر تفسير التاريخ: ${clean(input.date) || 'فارغ'}`, input.source, { assignmentId: id, currentValue: clean(input.date) });
        if (month && date && !date.startsWith(month + '-')) addIssue('DATE_OUTSIDE_MONTH', 'blocker', `التاريخ ${date} خارج شهر الملف ${month}`, input.source, { assignmentId: id, currentValue: date });
        if (shiftMatch.status === 'needs_review') addIssue('UNKNOWN_SHIFT_CODE', 'blocker', `${shiftMatch.reason}: ${rawShift}`, input.source, { assignmentId: id, currentValue: rawShift });
        if (teamMatch.status === 'needs_review') addIssue('TEAM_UNRESOLVED', 'blocker', `${teamMatch.reason}: ${clean(input.teamName)}`, input.source, { assignmentId: id, currentValue: clean(input.teamName) });
        if (employeeMatch.employee && employeeMatch.employee.is_active === 0) addIssue('EMPLOYEE_INACTIVE', 'warning', `الموظف ${employeeMatch.employee.name} غير نشط في السجل`, input.source, { assignmentId: id });
        const expectedHours = shiftHours(shiftMatch.shift);
        if (expectedHours !== null && assignment.reported_hours !== null && Number.isFinite(assignment.reported_hours) && Math.abs(expectedHours - assignment.reported_hours) > 0.25) {
            addIssue('HOURS_MISMATCH', 'warning', `ساعات المصدر ${assignment.reported_hours} لا تطابق مدة الرمز ${expectedHours}`, input.source, { assignmentId: id, currentValue: assignment.reported_hours, expectedValue: expectedHours });
        }
    };
    const mappingHints = new Map((options.mappings || []).map(item => [item.block_id, item]));
    for (const sheet of parsed.sheets) {
        const blocks = splitBlocks(sheet); let recognizedInSheet = 0;
        for (const block of blocks) {
            const hint = mappingHints.get(block.id);
            if (hint) {
                try {
                    let structure;
                    if (hint.orientation === 'long') {
                        structure = parseLong(block, sheet, Number(hint.header_row) - 1, hint.mapping || {}, { month }, addAssignment);
                    } else if (['wide', 'transposed'].includes(hint.orientation)) {
                        const target = hint.orientation === 'transposed' ? transposeBlock(block) : block;
                        const header = {
                            headerRow: Number(hint.header_row) - 1,
                            employeeColumn: Number(hint.employee_column),
                            employeeCodeColumn: hint.employee_code_column === null || hint.employee_code_column === undefined ? -1 : Number(hint.employee_code_column),
                            dates: (hint.dates || []).map(item => ({ c: Number(item.column), date: parseDate(item.date, month, item.date) }))
                        };
                        if (!header.dates.length || header.dates.some(item => item.c < 0 || !item.date)) throw new Error('خريطة التواريخ غير صالحة');
                        structure = parseWide(target, sheet, header, { month }, addAssignment);
                    } else throw new Error('اتجاه الخريطة غير صالح');
                    structures.push({ sheet: sheet.name, block: block.id, ...structure, source: 'human_mapping', explanation: 'طُبقت خريطة بنية وثقها المستخدم؛ بقيت مطابقة البيانات والمراجعة إلزامية' });
                    recognizedInSheet++; continue;
                } catch (error) {
                    addIssue('MAPPING_INVALID', 'blocker', `تعذر تطبيق خريطة القالب: ${error.message}`, { sheet: sheet.name, block: block.id });
                    continue;
                }
            }
            const long = findLongHeader(block);
            if (long) {
                const structure = parseLong(block, sheet, long.headerRow, long.mapping, { month }, addAssignment);
                structures.push({ sheet: sheet.name, block: block.id, ...structure }); recognizedInSheet++; continue;
            }
            let wide = findWideHeader(block, month, sheet);
            if (wide) {
                const structure = parseWide(block, sheet, wide, { month }, addAssignment);
                structures.push({ sheet: sheet.name, block: block.id, ...structure }); recognizedInSheet++; continue;
            }
            const transposed = transposeBlock(block); wide = findWideHeader(transposed, month, sheet);
            if (wide) {
                const structure = parseWide(transposed, sheet, wide, { month }, addAssignment);
                structures.push({ sheet: sheet.name, block: block.id, ...structure }); recognizedInSheet++; continue;
            }
            const meaningful = block.rows.flat().filter(cell => normalizeCode(cell)).length;
            if (meaningful >= 3) {
                addIssue('STRUCTURE_UNRESOLVED', 'blocker', 'تعذر تحديد علاقة الموظفين بالتواريخ والمناوبات في هذا الجزء', { sheet: sheet.name, block: block.id });
            }
        }
        if (!recognizedInSheet && sheet.rows.some(nonEmpty) && !blocks.length) addIssue('EMPTY_SHEET', 'warning', 'الورقة فارغة أو غير قابلة للقراءة', { sheet: sheet.name });
    }
    const duplicateGroups = new Map();
    for (const assignment of assignments) {
        if (!assignment.employee_id || !assignment.date || assignment.status === 'empty') continue;
        const key = `${assignment.employee_id}|${assignment.date}`;
        if (!duplicateGroups.has(key)) duplicateGroups.set(key, []); duplicateGroups.get(key).push(assignment);
    }
    for (const group of duplicateGroups.values()) {
        if (group.length < 2) continue;
        const distinct = new Set(group.map(item => `${item.shift_code}|${item.raw_shift}|${item.team_id}`));
        for (const item of group) {
            addIssue(distinct.size > 1 ? 'DUPLICATE_CONFLICT' : 'DUPLICATE_IDENTICAL', distinct.size > 1 ? 'blocker' : 'warning',
                distinct.size > 1 ? 'تعارض مناوبات لنفس الموظف والتاريخ' : 'تكرار متطابق لنفس الموظف والتاريخ', item.evidence.source,
                { assignmentId: item.id, currentValue: item.raw_shift });
        }
    }
    const employeeIds = new Set(assignments.map(item => item.employee_id).filter(Boolean));
    const signature = contentHash(structures.map(item => ({ orientation: item.orientation, mapping: item.mapping || null, employeeColumn: item.employeeColumn === undefined ? null : item.employeeColumn })));
    const previousTemplate = (reference.templates || []).find(template => template.signature === signature) || null;
    const template = { signature, matched: !!previousTemplate, status: previousTemplate ? 'matched_review_required' : 'new', structures,
        note: previousTemplate ? 'القالب يطابق قالبًا سابقًا؛ تبقى البيانات والمراجعات إلزامية' : 'قالب جديد؛ سيُحفظ بعد نجاح المراجعة فقط' };
    const referenceDiff = [];
    const previousByKey = new Map((reference.previousAssignments || []).map(item => [`${item.employee_id}|${item.shift_date || item.date}`, item]));
    const currentKeys = new Set();
    for (const item of assignments) {
        if (!item.employee_id || !item.date || !item.shift_code || item.status !== 'resolved') continue;
        const key = `${item.employee_id}|${item.date}`; currentKeys.add(key);
        const before = previousByKey.get(key);
        if (!before) referenceDiff.push({ change: 'added', employee_id: item.employee_id, date: item.date, before: null, after: item.shift_code });
        else if ((before.shift_code || before.after_shift_code) !== item.shift_code) referenceDiff.push({ change: 'changed', employee_id: item.employee_id, date: item.date, before: before.shift_code || before.after_shift_code, after: item.shift_code });
    }
    for (const [key, before] of previousByKey) if (!currentKeys.has(key)) {
        referenceDiff.push({ change: 'not_present_in_source', employee_id: before.employee_id, date: before.shift_date || before.date, before: before.shift_code || before.after_shift_code, after: null,
            note: 'غياب الصف عن المصدر ليس حذفًا أو راحة تلقائية' });
    }
    const counts = {
        sheets: parsed.sheets.length, tables: structures.length, assignments: assignments.length,
        employees: employeeIds.size, resolved: assignments.filter(item => item.status === 'resolved').length,
        empty: assignments.filter(item => item.status === 'empty').length,
        unknownCodes: issues.filter(item => item.type === 'UNKNOWN_SHIFT_CODE').length,
        blockers: issues.filter(item => item.severity === 'blocker' && item.status === 'pending').length,
        warnings: issues.filter(item => item.severity === 'warning' && item.status === 'pending').length,
        referenceChanges: referenceDiff.length
    };
    const original = parsed.sheets.map(sheet => ({
        name: sheet.name, rows: sheet.rows, merges: sheet.merges || [], notes: sheet.notes || [],
        extraction: sheet.extraction || 'native', ocrConfidence: sheet.ocrConfidence === undefined ? null : sheet.ocrConfidence,
        styledCells: Object.values(sheet.cells || {}).filter(cell => cell.style || (cell.comments && cell.comments.length)).length
    }));
    return {
        schema: 'schedule-import-analysis-v1', month, detectedMonth, template, structures, original,
        assignments, issues, referenceDiff, warnings, counts,
        explanations: [
            'المطابقة الحتمية بالرقم الوظيفي أو الرمز المعتمد تُقبل آليًا؛ المطابقة التقريبية تتطلب مراجعة.',
            'الخلية الفارغة تبقى فارغة ولا تتحول إلى راحة.',
            'القوالب السابقة تساعد في التعرف على البنية فقط ولا تعتمد رموزًا أو بيانات جديدة.',
            'الاختلاف عن المرجع السابق عرض للمراجعة وليس كتابة أو حذفًا في المصدر الرسمي.'
        ],
        analysisHash: contentHash({ month, template, assignments, issues: issues.map(({ id, type, severity, message, source, assignmentId, currentValue }) => ({ id, type, severity, message, source, assignmentId, currentValue })) })
    };
}
function buildVersionContent(analysis, batchId) {
    const month = analysis.month;
    const byEmployee = new Map();
    for (const item of analysis.assignments) {
        if (!item.employee_id || item.status === 'excluded') continue;
        if (!byEmployee.has(item.employee_id)) byEmployee.set(item.employee_id, []);
        byEmployee.get(item.employee_id).push(item);
    }
    const employees = [...byEmployee.entries()].map(([employeeId, items]) => {
        const first = items[0]; const byDate = new Map(items.filter(item => item.date).map(item => [item.date, item]));
        return {
            employee_id: employeeId, employee_code: first.employee_code, name: first.employee_name, pattern_code: first.pattern_code || null,
            days: daysOfMonth(month).map(date => {
                const item = byDate.get(date);
                return { date, shift_code: item ? item.shift_code : null, roster_ids: [], team_ids: item && item.team_id ? [item.team_id] : [], issues: item ? [`smart_import:${item.id}`] : ['smart_import_blank'] };
            })
        };
    });
    return { schema_version: 1, month, source: { type: 'smart_import', batch_id: batchId, analysis_hash: analysis.analysisHash, row_count: analysis.assignments.length }, employees };
}
function canonicalAnalysis(value) { return canonicalStringify(value); }

module.exports = { analyzeDocument, buildVersionContent, parseDate, detectMonth, normalizeText, normalizeCode, splitBlocks, canonicalAnalysis };
