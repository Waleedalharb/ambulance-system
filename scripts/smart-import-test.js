/**
 * P6 — اختبار فعلي معزول للاستيراد الذكي والصيغ والقوالب ودورة المراجعة.
 * كل الملفات والقاعدة والحسابات اصطناعية داخل test-output؛ لا بيانات إنتاج.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const { createCanvas } = require('@napi-rs/canvas');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output', 'smart-import-' + Date.now());
const TMP_DB = path.join(OUT, 'ambulance.db');
const TMP_DATA = path.join(OUT, 'data');
const PORT = 3119, BASE = `http://127.0.0.1:${PORT}`;
process.env.DB_PATH = TMP_DB; process.env.DATA_DIR = TMP_DATA; process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p6-isolated-smart-import-test-secret';
let passed = 0, failed = 0, raw = null, server = null, serverLog = '';
const failures = [], evidence = { fixtures: {}, formats: {}, api: {}, hashes: {} };
function check(name, condition, extra) { if (condition) { passed++; console.log('  ✅ ' + name); } else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); } }
function must(name, condition, extra) { check(name, condition, extra); if (!condition) throw new Error('شرط أساسي: ' + name + (extra ? ' — ' + extra : '')); }
function hashRows(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function snapshot() { return {
    roster: hashRows(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()),
    months: hashRows(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()),
    shiftCodes: hashRows(raw.prepare('SELECT * FROM shift_codes ORDER BY id').all()),
    users: hashRows(raw.prepare('SELECT * FROM users ORDER BY id').all()),
    permissions: hashRows(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all())
}; }
function sheetLong(code = 'D12', date = '2026-11-01') {
    return XLSX.utils.aoa_to_sheet([
        ['Employee Number', 'Shift Date', 'Duty', 'Team', 'Total Hours'],
        ['P6-E1', date, code, evidence.teamName, 12]
    ]);
}
function workbookMulti() {
    const wb = XLSX.utils.book_new();
    const wide = XLSX.utils.aoa_to_sheet([
        ['November 2026', '', '', '', ''],
        ['ID', 'Employee', new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 2)), 'Team'],
        ['P6-E1', 'Employee One', 'D12', 'N12', evidence.teamName],
        ['P6-E2', 'Employee Two', 'D12', '', evidence.teamName]
    ]);
    wide['!merges'] = [XLSX.utils.decode_range('A1:E1')];
    wide.C3.c = [{ a: 'اختبار', t: 'تعليق على رمز معتمد' }];
    wide.C3.s = { fgColor: { rgb: 'FFFF00' }, font: { bold: true } };
    wide.C3.z = '@'; wide.D3.z = '@'; wide.C2.z = 'yyyy-mm-dd'; wide.D2.z = 'yyyy-mm-dd';
    XLSX.utils.book_append_sheet(wb, wide, 'Wide');
    XLSX.utils.book_append_sheet(wb, sheetLong('D12', '2026-11-03'), 'Alt Long');
    const transposed = XLSX.utils.aoa_to_sheet([
        ['Employee Number', 'P6-E1', 'P6-E2'],
        ['2026-11-04', 'D12', 'N12'],
        ['2026-11-05', 'N12', 'D12']
    ]);
    XLSX.utils.book_append_sheet(wb, transposed, 'Transposed');
    return wb;
}
function workbookBuffer(type) { return XLSX.write(workbookMulti(), { type: 'buffer', bookType: type, cellStyles: true, cellDates: true }); }
function tableImage() {
    const canvas = createCanvas(1400, 420), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1400, 420); ctx.fillStyle = '#000';
    ctx.font = 'bold 36px sans-serif'; ctx.fillText('November 2026', 50, 60);
    ctx.font = 'bold 32px sans-serif'; ctx.fillText('ID', 55, 155); ctx.fillText('Date', 330, 155); ctx.fillText('Shift', 800, 155);
    ctx.font = '32px sans-serif'; ctx.fillText('P6-E1', 55, 270); ctx.fillText('2026-11-01', 330, 270); ctx.fillText('D12', 800, 270);
    ctx.lineWidth = 3; ctx.strokeRect(25, 90, 1100, 250); ctx.beginPath(); ctx.moveTo(25, 195); ctx.lineTo(1125, 195); ctx.stroke();
    return canvas.toBuffer('image/png');
}
function pdfBuffer(image = null) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 }), chunks = [];
        doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
        if (image) doc.image(image, 20, 20, { fit: [780, 500] });
        else {
            doc.font('Helvetica-Bold').fontSize(22).text('November 2026', 40, 40);
            doc.fontSize(18).text('ID', 45, 120).text('Date', 230, 120).text('Shift', 520, 120);
            doc.font('Helvetica').text('P6-E1', 45, 185).text('2026-11-01', 230, 185).text('D12', 520, 185);
        }
        doc.end();
    });
}
async function api(p, { method = 'GET', token, body, form } = {}) {
    const headers = {}; if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const response = await fetch(BASE + p, { method, headers, body: payload });
    let data = null; try { data = await response.json(); } catch (_) {}
    return { status: response.status, data };
}
function uploadForm(filename, buffer, month = '') {
    const form = new FormData(); form.append('file', new Blob([buffer]), filename); if (month) form.append('month', month); return form;
}
async function waitReady() { for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + '/health')).ok) return true; } catch (_) {} await new Promise(r => setTimeout(r, 250)); } return false; }
async function stopServer() {
    if (!server || server.killed) return; const child = server; server = null;
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
}
(async () => {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    console.log('مجلد الأدلة: ' + OUT);
    const db = require('../db.js');
    const { ScheduleImportService } = require('../services/schedule-engine/schedule-import-service.js');
    const { closeOcrWorker } = require('../services/schedule-engine/import-format-service.js');
    const { ContinuityService } = require('../services/schedule-engine/continuity-service.js');
    try {
        await db.init(false);
        const team = (await db.all('SELECT * FROM teams ORDER BY id'))[0]; evidence.teamName = team.name;
        const employees = {};
        for (let i = 1; i <= 2; i++) employees[`P6-E${i}`] = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES (?, ?, 'A')", [`P6-E${i}`, `Employee ${i === 1 ? 'One' : 'Two'}`])).id;
        await db.run("UPDATE shift_patterns SET cycle_json = ?, is_active = 1 WHERE code = 'A'", [JSON.stringify(['D12', 'D12', 'N12', 'N12', 'WO', 'WO', 'WO', 'WO'])]);
        const users = [
            { id: 'p6-admin', role: 'admin', name: 'أدمن P6' },
            { id: 'p6-importer', role: 'director', name: 'مستورد P6' },
            { id: 'p6-viewer', role: 'director', name: 'قارئ P6' },
            { id: 'p6-denied', role: 'user', name: 'بلا صلاحية P6' }
        ];
        for (const user of users) {
            await db.run('INSERT INTO users (user_id, username, password, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)', [user.id, user.id, 'not-used', user.name, user.role]);
            const grants = user.id === 'p6-importer' ? ['schedule.view', 'schedule.import'] : user.id === 'p6-viewer' ? ['schedule.view'] : [];
            for (const key of grants) await db.run('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)', [user.id, key, 'مجس P6 اصطناعي']);
        }
        fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users.map(user => ({ ...user, username: user.id, password: 'not-used', isActive: true })), null, 2));
        raw = new (require('better-sqlite3'))(TMP_DB);
        const baseline = snapshot(); evidence.hashes.baseline = baseline;
        const service = new ScheduleImportService(db, { storageDir: TMP_DATA }), actor = { id: 'p6-admin', role: 'admin', name: 'أدمن P6' };

        console.log('\n📊 Excel: الأوراق والقوالب والتنسيقات:');
        for (const [ext, type] of [['xlsx', 'xlsx'], ['xls', 'biff8'], ['xlsm', 'xlsm']]) {
            const buffer = workbookBuffer(type), filename = `multi.${ext}`; fs.writeFileSync(path.join(OUT, filename), buffer);
            const result = await service.upload({ buffer, originalName: filename, mimeType: 'application/octet-stream', user: actor });
            const analysis = result.batch.analysis;
            must(`${ext}: ثلاث أوراق وثلاث بنى`, analysis.original.length === 3 && analysis.structures.length === 3, JSON.stringify(analysis.counts));
            check(`${ext}: طولي وعرضي ومعكوس`, ['long', 'wide', 'transposed'].every(kind => analysis.structures.some(row => row.orientation === kind)));
            check(`${ext}: تسعة عناصر وموظفان وبلا موانع`, analysis.assignments.length === 9 && analysis.counts.employees === 2 && analysis.counts.blockers === 0, JSON.stringify(analysis.issues));
            check(`${ext}: الفراغ يبقى empty وليس راحة`, analysis.assignments.some(item => item.status === 'empty' && !item.shift_code));
            check(`${ext}: الشهر مكتشف`, analysis.month === '2026-11');
            evidence.formats[ext] = { counts: analysis.counts, orientations: analysis.structures.map(row => row.orientation) };
            if (ext === 'xlsx') {
                check('XLSX: الدمج والتعليقات والتنسيق محفوظة', analysis.original[0].merges.length === 1 && analysis.original[0].notes.length === 1 && analysis.original[0].styledCells > 0);
                const transposed = analysis.assignments.find(item => item.evidence.orientation === 'transposed' && item.raw_employee_code === 'P6-E1' && item.date === '2026-11-04');
                check('المعكوس: إحداثيات الدليل تشير للأصل', transposed && transposed.evidence.source.row === 2 && transposed.evidence.source.column === 2, JSON.stringify(transposed && transposed.evidence.source));
            }
        }

        console.log('\n📄 CSV وPDF والصور:');
        const csv = Buffer.from('Employee Number,Shift Date,Duty,Total Hours\nP6-E1,2026-11-01,D12,12\n', 'utf8');
        fs.writeFileSync(path.join(OUT, 'long.csv'), csv);
        let result = await service.upload({ buffer: csv, originalName: 'long.csv', mimeType: 'text/csv', user: actor });
        must('CSV: عناوين مختلفة ومطابقة موظف', result.batch.analysis.assignments.length === 1 && result.batch.analysis.assignments[0].employee_id === employees['P6-E1'] && result.batch.analysis.counts.blockers === 0, JSON.stringify(result.batch.analysis.issues));
        evidence.formats.csv = result.batch.analysis.counts;
        const textPdf = await pdfBuffer(); fs.writeFileSync(path.join(OUT, 'text.pdf'), textPdf);
        result = await service.upload({ buffer: textPdf, originalName: 'text.pdf', mimeType: 'application/pdf', user: actor });
        must('PDF النصي: قراءة الموظف والتاريخ والرمز', result.batch.analysis.assignments.length === 1 && result.batch.analysis.assignments[0].employee_id === employees['P6-E1'] && result.batch.analysis.assignments[0].shift_code === 'D12', JSON.stringify(result.batch.analysis));
        check('PDF النصي: لا OCR عند كفاية النص', result.batch.analysis.original[0].extraction === 'native');
        evidence.formats.pdf_text = result.batch.analysis.counts;
        const png = tableImage(); fs.writeFileSync(path.join(OUT, 'table.png'), png);
        const scannedPdf = await pdfBuffer(png); fs.writeFileSync(path.join(OUT, 'scanned.pdf'), scannedPdf);
        result = await service.upload({ buffer: scannedPdf, originalName: 'scanned.pdf', mimeType: 'application/pdf', user: actor });
        must('PDF الممسوح: OCR يستخرج الجدول', result.batch.analysis.assignments.some(item => item.employee_id === employees['P6-E1'] && item.shift_code === 'D12'), JSON.stringify(result.batch.analysis));
        check('PDF الممسوح: وضع OCR وثقته محفوظان', result.batch.analysis.original[0].extraction === 'ocr' && result.batch.analysis.original[0].ocrConfidence !== null);
        evidence.formats.pdf_scanned = { counts: result.batch.analysis.counts, confidence: result.batch.analysis.original[0].ocrConfidence };
        result = await service.upload({ buffer: png, originalName: 'table.png', mimeType: 'image/png', user: actor });
        must('PNG: OCR يستخرج الجدول', result.batch.analysis.assignments.some(item => item.employee_id === employees['P6-E1'] && item.shift_code === 'D12'), JSON.stringify(result.batch.analysis));
        evidence.formats.png = { counts: result.batch.analysis.counts, confidence: result.batch.analysis.original[0].ocrConfidence };
        const { createCanvas: canvasFactory, loadImage } = require('@napi-rs/canvas');
        // JPEG حقيقي من الصورة نفسها بعد اكتمال فك ترميزها، لا إعادة تسمية لامتداد PNG.
        const jpegCanvas = canvasFactory(1400, 420), jpegContext = jpegCanvas.getContext('2d');
        const image = await loadImage(png); jpegContext.drawImage(image, 0, 0);
        const jpeg = jpegCanvas.toBuffer('image/jpeg'); fs.writeFileSync(path.join(OUT, 'table.jpg'), jpeg);
        result = await service.upload({ buffer: jpeg, originalName: 'table.jpg', mimeType: 'image/jpeg', user: actor });
        must('JPG: OCR يستخرج الجدول', result.batch.analysis.assignments.some(item => item.employee_id === employees['P6-E1'] && item.shift_code === 'D12'), JSON.stringify(result.batch.analysis));
        evidence.formats.jpg = { counts: result.batch.analysis.counts, confidence: result.batch.analysis.original[0].ocrConfidence };
        result = await service.upload({ buffer: jpeg, originalName: 'table.jpeg', mimeType: 'image/jpeg', user: actor });
        must('JPEG: الامتداد مدعوم وOCR يستخرج الجدول', result.batch.analysis.assignments.some(item => item.employee_id === employees['P6-E1'] && item.shift_code === 'D12'), JSON.stringify(result.batch.analysis));
        evidence.formats.jpeg = { counts: result.batch.analysis.counts, confidence: result.batch.analysis.original[0].ocrConfidence };

        console.log('\n🧭 الخريطة البشرية والتعارضات والرموز المجهولة:');
        const manual = Buffer.from('P6-E1,2026-11-07,D12\n', 'utf8'); fs.writeFileSync(path.join(OUT, 'manual.csv'), manual);
        result = await service.upload({ buffer: manual, originalName: 'manual.csv', mimeType: 'text/csv', user: actor });
        must('بلا عناوين: بنية غير محسومة', result.batch.analysis.issues.some(issue => issue.type === 'STRUCTURE_UNRESOLVED' && issue.status === 'pending'));
        const blockId = result.batch.analysis.issues.find(issue => issue.type === 'STRUCTURE_UNRESOLVED').source.block;
        result = await service.map(result.batch.id, { month: '2026-11', mappings: [{ block_id: blockId, orientation: 'long', header_row: 0, mapping: { employeeCode: 0, date: 1, shift: 2 } }], expected_analysis_hash: result.batch.analysis_hash }, actor);
        must('الخريطة البشرية تحل البنية دون رمز جديد', result.batch.analysis.counts.blockers === 0 && result.batch.analysis.assignments.length === 1 && result.batch.analysis.assignments[0].shift_code === 'D12', JSON.stringify(result.batch.analysis.issues));
        const conflictWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(conflictWb, sheetLong('D12', '2026-11-08'), 'One'); XLSX.utils.book_append_sheet(conflictWb, sheetLong('N12', '2026-11-08'), 'Two');
        const conflict = XLSX.write(conflictWb, { type: 'buffer', bookType: 'xlsx' }); fs.writeFileSync(path.join(OUT, 'conflict.xlsx'), conflict);
        result = await service.upload({ buffer: conflict, originalName: 'conflict.xlsx', mimeType: 'application/octet-stream', user: actor });
        must('التعارض لنفس الموظف والتاريخ مانع', result.batch.analysis.issues.filter(issue => issue.type === 'DUPLICATE_CONFLICT' && issue.status === 'pending').length === 2);
        await closeOcrWorker(); await db.closeDb();

        console.log('\n🔐 API والمراجعة والاستيراد الآمن:');
        server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
        must('الخادم المعزول يعمل', await waitReady(), serverLog.slice(-4000));
        const jwt = require('jsonwebtoken'), tokens = Object.fromEntries(users.map(user => [user.id, jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET)]));
        const unknownWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(unknownWb, XLSX.utils.aoa_to_sheet([['ID', 'Date', 'Shift'], ['P6-E1', '2026-11-10', 'NEWX'], ['P6-E1', '2026-11-11', '']]), 'Unknown');
        const unknown = XLSX.write(unknownWb, { type: 'buffer', bookType: 'xlsx' }); fs.writeFileSync(path.join(OUT, 'unknown.xlsx'), unknown);
        let response = await api('/api/schedule/imports', { method: 'POST', form: uploadForm('unknown.xlsx', unknown) });
        check('الرفع بلا توكن 401', response.status === 401);
        response = await api('/api/schedule/imports', { method: 'POST', token: tokens['p6-denied'], form: uploadForm('unknown.xlsx', unknown) });
        check('الرفع بلا schedule.import 403', response.status === 403);
        response = await api('/api/schedule/imports', { method: 'POST', token: tokens['p6-importer'], form: uploadForm('unknown.xlsx', unknown) });
        must('الرفع المصرح 201', response.status === 201, JSON.stringify(response));
        let batch = response.data.batch; evidence.api.batchId = batch.id;
        check('الرمز الجديد مانع ولا يُفسر تلقائيًا', batch.analysis.issues.some(issue => issue.type === 'UNKNOWN_SHIFT_CODE' && issue.currentValue === 'NEWX'));
        response = await api(`/api/schedule/imports/${batch.id}`, { token: tokens['p6-denied'] });
        check('القراءة بلا schedule.view 403', response.status === 403);
        response = await api(`/api/schedule/imports/${batch.id}/import`, { method: 'POST', token: tokens['p6-importer'], body: { expected_analysis_hash: batch.analysis_hash } });
        check('الاستيراد قبل المراجعة ممنوع', response.status === 409 && response.data.code === 'HUMAN_REVIEW_REQUIRED');
        const issue = batch.analysis.issues.find(row => row.type === 'UNKNOWN_SHIFT_CODE' && row.status === 'pending');
        response = await api(`/api/schedule/imports/${batch.id}/review`, { method: 'POST', token: tokens['p6-importer'], body: { action: 'set_shift', issue_id: issue.id, assignment_id: issue.assignmentId, value: { shift_code: 'INVENTED' }, reason: 'محاولة رمز غير موجود', expected_analysis_hash: batch.analysis_hash } });
        check('لا يمكن اختراع رمز أثناء المراجعة', response.status === 422 && response.data.code === 'SHIFT_CODE_NOT_FOUND');
        response = await api(`/api/schedule/imports/${batch.id}/review`, { method: 'POST', token: tokens['p6-importer'], body: { action: 'set_shift', issue_id: issue.id, assignment_id: issue.assignmentId, value: { shift_code: 'D12' }, reason: 'اعتماد الرمز الموجود بعد مراجعة المصدر', expected_analysis_hash: batch.analysis_hash } });
        must('تصحيح الرمز بقرار موثق', response.status === 200 && response.data.batch.status === 'validated', JSON.stringify(response));
        const oldHash = batch.analysis_hash; batch = response.data.batch;
        response = await api(`/api/schedule/imports/${batch.id}/review`, { method: 'POST', token: tokens['p6-importer'], body: { action: 'confirm_review', reason: 'مراجعة ببصمة قديمة', expected_analysis_hash: oldHash } });
        check('البصمة القديمة تمنع القرار', response.status === 409 && response.data.code === 'STALE_ANALYSIS');
        response = await api(`/api/schedule/imports/${batch.id}/review`, { method: 'POST', token: tokens['p6-importer'], body: { action: 'confirm_review', reason: 'راجعت الأصل والموظف والرمز والفراغ', expected_analysis_hash: batch.analysis_hash } });
        must('تأكيد المراجعة النهائية', response.status === 200 && response.data.batch.status === 'reviewed', JSON.stringify(response)); batch = response.data.batch;
        response = await api(`/api/schedule/imports/${batch.id}/import`, { method: 'POST', token: tokens['p6-importer'], body: { expected_analysis_hash: batch.analysis_hash } });
        must('إنشاء مرجع imported فقط', response.status === 201 && response.data.version.status === 'imported' && response.data.version.source_type === 'smart_import', JSON.stringify(response));
        const version = response.data.version; batch = response.data.batch; evidence.api.versionId = version.id;
        check('لا اعتماد أو نشر تلقائي', !version.approved_at && !version.published_at);
        check('الأصل خارج public وبصمته مطابقة', batch.original_file_url.includes('/file') && raw.prepare('SELECT stored_path, file_sha256 FROM schedule_import_batches WHERE id = ?').get(batch.id).stored_path.includes('schedule-imports'));
        const fileResponse = await fetch(`${BASE}/api/schedule/imports/${batch.id}/file`, { headers: { Authorization: 'Bearer ' + tokens['p6-viewer'] } });
        const originalBuffer = Buffer.from(await fileResponse.arrayBuffer());
        check('تنزيل الأصل بالمصادقة وSHA-256 صحيح', fileResponse.status === 200 && crypto.createHash('sha256').update(originalBuffer).digest('hex') === raw.prepare('SELECT file_sha256 FROM schedule_import_batches WHERE id = ?').get(batch.id).file_sha256);
        check('القالب الناجح محفوظ', raw.prepare('SELECT COUNT(*) AS n FROM schedule_import_templates WHERE source_batch_id = ?').get(batch.id).n === 1);
        const reviewRow = raw.prepare('SELECT * FROM schedule_import_reviews WHERE batch_id = ? ORDER BY created_at LIMIT 1').get(batch.id);
        let immutable = false; try { raw.prepare('UPDATE schedule_import_reviews SET reason = ? WHERE id = ?').run('تعديل ممنوع', reviewRow.id); } catch (error) { immutable = /immutable/i.test(error.message); }
        check('قرار المراجعة غير قابل للتعديل', immutable);
        immutable = false; try { raw.prepare('DELETE FROM schedule_import_reviews WHERE id = ?').run(reviewRow.id); } catch (error) { immutable = /immutable/i.test(error.message); }
        check('قرار المراجعة غير قابل للحذف', immutable);
        immutable = false; try { raw.prepare('UPDATE schedule_import_batches SET original_name = ? WHERE id = ?').run('changed.xlsx', batch.id); } catch (error) { immutable = /immutable/i.test(error.message); }
        check('مصدر الدفعة غير قابل للتعديل', immutable);
        immutable = false; try { raw.prepare('DELETE FROM schedule_import_batches WHERE id = ?').run(batch.id); } catch (error) { immutable = /retained/i.test(error.message); }
        check('الدفعة وسجلها غير قابلين للحذف', immutable);
        const templateRow = raw.prepare('SELECT id FROM schedule_import_templates WHERE source_batch_id = ?').get(batch.id);
        immutable = false; try { raw.prepare('UPDATE schedule_import_templates SET signature = ? WHERE id = ?').run('changed-signature', templateRow.id); } catch (error) { immutable = /immutable/i.test(error.message); }
        check('القالب المحفوظ غير قابل للتعديل', immutable);
        immutable = false; try { raw.prepare('DELETE FROM schedule_import_templates WHERE id = ?').run(templateRow.id); } catch (error) { immutable = /immutable/i.test(error.message); }
        check('القالب المحفوظ غير قابل للحذف', immutable);
        const gaps = raw.prepare('SELECT COUNT(*) AS n FROM schedule_gap_reviews WHERE version_id = ?').get(version.id).n;
        check('الفراغات تبقى مراجعات unresolved', gaps > 0 && raw.prepare("SELECT COUNT(*) AS n FROM schedule_gap_reviews WHERE version_id = ? AND resolution = 'unresolved'").get(version.id).n === gaps);
        response = await api('/api/schedule/imports', { method: 'POST', token: tokens['p6-importer'], form: uploadForm('unknown.xlsx', unknown) });
        const second = response.data;
        check('القالب الناجح يُطابق بنيويًا فقط ويبقى الرمز مانعًا', second.batch.analysis.template.matched && second.batch.analysis.issues.some(row => row.type === 'UNKNOWN_SHIFT_CODE' && row.status === 'pending'));
        response = await api(`/api/schedule/versions/${version.id}/open-draft`, { method: 'POST', token: tokens['p6-admin'], body: {} });
        must('فتح مرجع الاستيراد كمسودة P1-A', response.status === 200, JSON.stringify(response));
        response = await api(`/api/schedule/versions/${version.id}/continuity/derive`, { method: 'POST', token: tokens['p6-admin'], body: {} });
        const derived = response.data.version;
        const entry = derived && derived.current_snapshot && derived.current_snapshot.entries.find(row => Number(row.employee_id) === employees['P6-E1']);
        check('مرجع الاستيراد يدخل استمرارية P1-A وليس no_reference', entry && entry.status !== 'no_reference', JSON.stringify(entry));
        check('حارس التوليد لم يُستدع ولا مسودة مولدة', raw.prepare("SELECT COUNT(*) AS n FROM schedule_versions WHERE version_kind = 'generated_draft'").get().n === 0);
        const after = snapshot(); evidence.hashes.after = after;
        for (const key of Object.keys(baseline)) check(`لم يتغير ${key}`, baseline[key] === after[key]);
        check('قاعدة الاختبار سليمة', raw.prepare('PRAGMA quick_check').get().quick_check === 'ok');
        evidence.api.finalBatchStatus = batch.status;
        evidence.fixtures.directory = OUT;
        evidence.counts = { passed, failed };
        fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(evidence, null, 2));
        console.log(`\nالنتيجة: ${passed} ✅ / ${failed} ❌`);
        if (failed) process.exitCode = 1;
    } finally {
        await stopServer();
        try { await closeOcrWorker(); } catch (_) {}
        try { await db.closeDb(); } catch (_) {}
        if (raw) { try { raw.close(); } catch (_) {} }
        fs.writeFileSync(path.join(OUT, 'server.log'), serverLog);
        if (!fs.existsSync(path.join(OUT, 'summary.json'))) fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ ...evidence, counts: { passed, failed }, failures }, null, 2));
    }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
