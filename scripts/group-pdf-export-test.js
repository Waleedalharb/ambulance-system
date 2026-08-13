/**
 * Group PDF Export Test — تفويض «تصدير الجداول حسب فئة رمز القوة (A/B/C/D)»
 * ═══════════════════════════════════════════════════════════════════════════
 * يثبت:
 *   ①-⑤ بنّاء نقي (بلا HTTP) — نمط multi-month-test ⑦: فلترة الفئة، أسماء
 *         الفرق الحقيقية، ترتيب الأقسام، ملخص الساعات/المناوبات/D-N من محرك
 *         المقاييس، الاستبعاد الموثق (O15/XX/بلا symbol)، الأقسام الفارغة.
 *   ⑥    نموذج القاعدة المؤقتة: كل مشمولي group=A فئتهم A وبلا-symbol مستبعدون.
 *   ⑦-⑧ الاختبار الذهبي: سلوك center بعد التعديل = نسخة git HEAD حرفيًا —
 *         مقارنة JSON العميق لناتج buildSchedulePdfData + مقارنة نص PDF بعد
 *         إخفاء طابع التوليد (المقارنة البايتية مستحيلة لاختلاف CreationDate).
 *   ⑨-⑫ HTTP على خادم معزول (المنفذ 3086) — نمط test-pdf-ssot.
 *
 * العزل: قاعدة temp عبر SQLite Backup API (better-sqlite3 .backup) من
 * data/ambulance.db (أو database.db) — لا نسخ خام لأن خوادم المالك قد تحمل
 * الملف. الخادم المعزول على 3086 فقط ويُوقَف ويُتحقق من تحرره.
 *
 * التشغيل (من جذر المشروع):  node scripts/group-pdf-export-test.js
 */

const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const PORT = 3086;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const results = [];
let TOKEN = null;
let serverProc = null;
let TMP_DIR = null;
let serverLog = '';

const pdfService = require(path.join(ROOT, 'services', 'schedule-pdf-service.js'));

function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ─── بيئة معزولة: Backup API + users.json ───
async function prepareIsolatedEnv() {
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'group-pdf-'));
    const srcDb = fs.existsSync(path.join(ROOT, 'data', 'ambulance.db'))
        ? path.join(ROOT, 'data', 'ambulance.db')
        : path.join(ROOT, 'database.db');
    const tmpDb = path.join(TMP_DIR, 'test.db');
    const src = new Database(srcDb, { readonly: true, fileMustExist: true });
    await src.backup(tmpDb);            // SQLite Backup API — آمن مع قاعدة يحملها خادم المالك
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    const schedJson = path.join(ROOT, 'data', 'schedule-employees.json');
    if (fs.existsSync(schedJson)) fs.copyFileSync(schedJson, path.join(TMP_DIR, 'schedule-employees.json'));
    return tmpDb;
}

function startServer(dbPath) {
    serverProc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, DB_PATH: dbPath, DATA_DIR: TMP_DIR, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProc.stdout.on('data', c => { serverLog += c.toString(); });
    serverProc.stderr.on('data', c => { serverLog += c.toString(); });
    serverProc.on('exit', code => {
        if (code !== null && code !== 0) {
            console.error('— خرج الخادم المعزول مبكرًا (code ' + code + '):\n' + serverLog.slice(-1500));
        }
    });
}

async function login() {
    const res = await fetch(BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '4252', password: '4252' })
    });
    const data = await res.json();
    return data.accessToken;
}

async function waitForServer(timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const tok = await login();
            if (tok) return tok;
        } catch (_) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 800));
    }
    throw new Error('انتهت مهلة انتظار الخادم المعزول');
}

async function fetchPdfRaw(query) {
    const res = await fetch(BASE + '/api/schedule/pdf?' + query, {
        headers: { 'Authorization': 'Bearer ' + TOKEN }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, disposition: res.headers.get('content-disposition') || '' };
}

function extractText(pdfPath) {
    const py = [
        'import sys',
        'from pypdf import PdfReader',
        'r = PdfReader(sys.argv[1])',
        'print("\\n".join((p.extract_text() or "") for p in r.pages))'
    ].join('\n');
    const out = spawnSync('python', ['-c', py, pdfPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (out.status !== 0) throw new Error('فشل استخراج نص PDF: ' + (out.stderr || '').slice(-400));
    return out.stdout || '';
}

/** إخفاء طابع التوليد للمقارنة الذهبية: وقت HH:MM(:SS) وتاريخ ISO اليوم —
 *  لا يوجد نمط «:» آخر في محتوى الجدول (أرقام الأيام والأكواد بلا نقطتين). */
function maskTimestamp(text) {
    return String(text)
        .replace(/\d{4}-\d{2}-\d{2}/g, '')
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '');
}

// ─── نسخة طبق الأصل من readScheduleEmployeesFromDB (مع symbol) على better-sqlite3 ───
function readReplica(dbPath, month) {
    const db = new Database(dbPath, { readonly: true });
    const teams = db.prepare('SELECT id, name FROM teams').all();
    const teamsMap = {};
    teams.forEach(t => { teamsMap[t.id] = t.name; });
    const assignments = db.prepare('SELECT employee_id, team_id FROM team_assignments ORDER BY id DESC').all();
    const empTeamMap = {};
    assignments.forEach(a => { if (!empTeamMap[a.employee_id]) empTeamMap[a.employee_id] = teamsMap[a.team_id] || ''; });
    const empRows = db.prepare('SELECT * FROM employees').all();
    const empMap = {};
    empRows.forEach(e => {
        if (e.is_active === 0) return;
        const code = String(e.employee_code || e.id);
        empMap[e.id] = { id: code, employeeNumber: code, name: e.name || '', jobTitle: e.job_title || '', team: empTeamMap[e.id] || '', symbol: e.symbol || '', schedule: [] };
    });
    let rows;
    if (month) {
        const y = parseInt(month.split('-')[0], 10), m = parseInt(month.split('-')[1], 10);
        rows = db.prepare(`SELECT sr.employee_id, sr.shift_date, sr.shift_code, t.name AS team_name
            FROM shift_roster sr LEFT JOIN teams t ON t.id = sr.team_id
            WHERE sr.month = ? AND sr.year = ? ORDER BY sr.shift_date`).all(m, y);
    } else {
        rows = db.prepare(`SELECT sr.employee_id, sr.shift_date, sr.shift_code, t.name AS team_name
            FROM shift_roster sr LEFT JOIN teams t ON t.id = sr.team_id ORDER BY sr.shift_date`).all();
    }
    rows.forEach(r => {
        const emp = empMap[r.employee_id];
        if (!emp) return;
        const c = r.shift_code;
        let status = 'دوام';
        if (c === 'V' || c === 'VC' || c === 'E' || c === 'EV' || c === 'S') status = 'إجازة';
        else if (c === 'WO') status = 'راحة';
        else if (c === 'C') status = 'تدريب';
        else if (c === 'ME' || c === 'F' || (c && c.indexOf('CP') === 0)) status = 'تكميل';
        emp.schedule.push({ date: r.shift_date, shiftCode: c, location: r.team_name || emp.team || '', status });
    });
    db.close();
    return Object.values(empMap);
}

function latestMonth(dbPath) {
    const db = new Database(dbPath, { readonly: true });
    const r = db.prepare('SELECT year, month FROM shift_roster ORDER BY year DESC, month DESC LIMIT 1').get();
    db.close();
    return r.year + '-' + String(r.month).padStart(2, '0');
}

// موظف اختباري نقي
function mkEmp(symbol, jobTitle, cells, month) {
    month = month || '2026-08';
    return {
        id: 'emp-' + (symbol || 'none') + '-' + Math.random().toString(36).slice(2, 7),
        employeeNumber: '9' + Math.floor(Math.random() * 1000),
        name: 'موظف ' + (symbol || 'بلا رمز'), jobTitle: jobTitle || '', team: '', symbol: symbol || '',
        schedule: cells.map((c, i) => ({ date: month + '-' + String(i + 1).padStart(2, '0'), shiftCode: c, location: '', status: 'دوام' }))
    };
}

// ═══ ①-⑤ الاختبارات النقية ═══
async function pureTests() {
    const M = '2026-08';
    const emps = [
        mkEmp('A1', '', ['D12', 'N12', 'E', 'EV'], M),
        mkEmp('B2', '', ['D12'], M),
        mkEmp('RRA1', '', ['N12'], M),
        mkEmp('O12A12', '', ['N12'], M),
        mkEmp('A0', '', ['D12'], M),
        mkEmp('C00', '', ['D12'], M),
        mkEmp('XX', '', ['D12'], M),
        mkEmp('O15', '', ['N12'], M),
        mkEmp('', '', ['D12'], M)
    ];
    const data = pdfService.buildSchedulePdfData(emps, { group: 'A', month: M, codesByCode: new Map() });

    const symsIn = data.employees.map(e => e.name.replace('موظف ', '')).sort();
    const onlyA = JSON.stringify(symsIn) === JSON.stringify(['A0', 'A1', 'O12A12', 'RRA1']);
    const secOrder = data.sections.map(s => s.key);
    const orderOk = JSON.stringify(secOrder) === JSON.stringify(['leadership', 'center', 'rapid', 'overlap']);
    const teamNames = data.sections.map(s => s.teams.map(t => t.name).join(',')).join(' / ');
    const namesOk = teamNames.indexOf('جنوب 1 — A') !== -1 && teamNames.indexOf('سريع 1 — A') !== -1
        && teamNames.indexOf('القيادة الميدانية — A') !== -1;
    record('① بنّاء نقي: group=A يحوي فئة A فقط بالأسماء الحقيقية والأقسام مرتبة',
        onlyA && orderOk && namesOk,
        'دخل=[' + symsIn.join(',') + '] أقسام=[' + secOrder.join('←') + '] فرق: ' + teamNames);

    const a1 = data.employees.find(e => e.name === 'موظف A1');
    const sm = a1 && a1.summary;
    record('② ملخص موظف (D12+N12+E+EV): 32 ساعة · مناوبات 2 · D:1 N:1 — EV غير محسوبة',
        !!sm && sm.hours === 32 && sm.work === 2 && sm.day === 1 && sm.night === 1,
        sm ? JSON.stringify(sm) : 'بلا ملخص');

    const rra = data.employees.find(e => e.name === 'موظف RRA1');
    const ova = data.employees.find(e => e.name === 'موظف O12A12');
    const rraSec = rra && rra.sectionKey === 'rapid' && rra.teamLabel === 'سريع 1 — A';
    const ovaSec = ova && ova.sectionKey === 'overlap' && ova.teamLabel.indexOf('طاقم O12A') !== -1 && /— A$/.test(ova.teamLabel);
    record('③ RRA1 ⇒ فئة A بقسم سريع واسم حقيقي · O12A12 ⇒ فئة A باسم الطاقم',
        !!rra && !!ova && rraSec && ovaSec,
        (rra ? rra.teamLabel : '?') + ' · ' + (ova ? ova.teamLabel : '?'));

    record('④ الاستبعاد الموثق: O15 (أوفرلاب بلا حرف) وXX وبدون symbol خارج كل فئة',
        pdfService.resolveGroupCategory('O15', '') === null
        && pdfService.resolveGroupCategory('XX', '') === null
        && pdfService.resolveGroupCategory('', '') === null
        && !data.employees.some(e => /O15|XX|بلا رمز/.test(e.name)),
        'O15/XX/فارغ ⇒ null ⇒ مستبعد (الأقل كلفة — لا قسم خاص)');

    // ⑤ أقسام فارغة: فئة فيها مراكز فقط (بلا قيادة/عمليات/سريع/أوفرلاب/إدارات)
    const sparse = pdfService.buildSchedulePdfData(
        [mkEmp('B1', '', ['D12'], M), mkEmp('B3', '', ['N12'], M)],
        { group: 'B', month: M, codesByCode: new Map() });
    let sparseOk = false, sparseSize = 0;
    try {
        const buf = await pdfService.generateSchedulePdf(sparse);
        sparseOk = buf.slice(0, 5).toString() === '%PDF-' && buf.length > 10000;
        sparseSize = buf.length;
    } catch (e) { sparseOk = false; }
    record('⑤ الأقسام الفارغة (بلا قيادة/عمليات/سريع/أوفرلاب/إدارات) لا تكسر التوليد',
        sparseOk && sparse.sections.length === 1 && sparse.sections[0].key === 'center',
        'أقسام=' + sparse.sections.length + ' حجم=' + sparseSize);
}

// ═══ ⑥ نموذج القاعدة المؤقتة ═══
function dbModelTests(dbPath, month) {
    const emps = readReplica(dbPath, month);
    const withSchedule = emps.filter(e => e.schedule.length);
    const data = pdfService.buildSchedulePdfData(emps, { group: 'A', month, codesByCode: new Map() });
    // التحقق: كل موظف داخل فئته A عبر رمزه الأصلي من القاعدة
    const db = new Database(dbPath, { readonly: true });
    const symByCode = {};
    db.prepare('SELECT employee_code, symbol FROM employees WHERE COALESCE(is_active,1) != 0').all()
        .forEach(r => { symByCode[String(r.employee_code)] = r.symbol || ''; });
    db.close();
    const includedOk = data.employees.every(e => pdfService.resolveGroupCategory(symByCode[e.code] || '', '') === 'A');
    const noSymbolExcluded = Object.keys(symByCode)
        .filter(code => !symByCode[code])
        .every(code => !data.employees.some(e => e.code === code));
    const noSymbolCount = Object.keys(symByCode).filter(c => !symByCode[c]).length;
    record('⑥ قاعدة temp: كل مشمولي group=A فئته A فعلًا + نشطون بلا symbol مستبعدون',
        data.employees.length > 0 && includedOk && noSymbolExcluded,
        'كادر_الفئة=' + data.employees.length + '/' + withSchedule.length + ' بلا_symbol=' + noSymbolCount
        + ' أقسام=' + data.sections.map(s => s.label).join('،'));
    // شاهدان للفحص HTTP: موظف من فئة A وموظف من فئة B فقط (باسميهما الحقيقيين)
    const empA = data.employees[0] || null;
    const dataB = pdfService.buildSchedulePdfData(emps, { group: 'B', month, codesByCode: new Map() });
    const codesA = new Set(data.employees.map(e => e.code));
    const empBonly = dataB.employees.find(e => !codesA.has(e.code)) || null;
    return { emps, month, empAName: empA ? empA.name : '', empBName: empBonly ? empBonly.name : '' };
}

// ═══ ⑦-⑧ الاختبار الذهبي: سلوك center = نسخة HEAD حرفيًا ═══
async function goldenTests(dbPath, emps, month) {
    // مركز حقيقي من البيانات: أكثر location تكرارًا في شهر الفحص
    const locCount = {};
    emps.forEach(e => e.schedule.forEach(s => { if (s.location) locCount[s.location] = (locCount[s.location] || 0) + 1; }));
    const center = Object.keys(locCount).sort((a, b) => locCount[b] - locCount[a])[0];

    // الأساس: نسخة الخدمة من git HEAD (الملف غير معدّل في شجرة العمل — HEAD = قبل التعديل حرفيًا)
    const baselineSrc = execSync('git show HEAD:services/schedule-pdf-service.js', { cwd: ROOT, encoding: 'utf8' });
    const baselinePath = path.join(ROOT, 'services', '.__golden-baseline.js');
    fs.writeFileSync(baselinePath, baselineSrc);
    let baseline;
    try {
        baseline = require(baselinePath);
    } finally {
        try { fs.unlinkSync(baselinePath); } catch (_) { /* ignore */ }
    }

    const oldData = baseline.buildSchedulePdfData(emps, { center, month });
    const newData = pdfService.buildSchedulePdfData(emps, { center, month });
    const jsonSame = JSON.stringify(oldData) === JSON.stringify(newData);
    record('⑦ الذهبي (بنية): buildSchedulePdfData بـcenter بلا group مطابق لنسخة HEAD حقلًا بحقل',
        jsonSame, 'مركز_الفحص=' + center + ' موظفون=' + newData.employees.length + ' — المقارنة: JSON.stringify للناتجين');

    const oldPdf = await baseline.generateSchedulePdf(oldData);
    const newPdf = await pdfService.generateSchedulePdf(newData);
    const oldPath = path.join(TMP_DIR, 'golden-old.pdf'), newPath = path.join(TMP_DIR, 'golden-new.pdf');
    fs.writeFileSync(oldPath, oldPdf);
    fs.writeFileSync(newPath, newPdf);
    const oldText = maskTimestamp(extractText(oldPath));
    const newText = maskTimestamp(extractText(newPath));
    record('⑧ الذهبي (محتوى): PDF المركز بعد التعديل = السابق نصيًا (بعد إخفاء طابع التوليد)',
        oldText === newText && newPdf.slice(0, 5).toString() === '%PDF-',
        'حجم=' + oldPdf.length + '/' + newPdf.length + ' نص=' + oldText.length + '/' + newText.length + ' محرف'
        + ' — البايتات تختلف بطبيعتها (CreationDate) فالمرجع النص الكامل');
    return center;
}

// ═══ ⑨-⑫ HTTP ═══
async function httpTests(month, empAName, empBName) {
    const g = await fetchPdfRaw('group=A&month=' + month);
    const isPdf = g.buf.slice(0, 5).toString() === '%PDF-';
    let namesOk = false, extractNote = '';
    if (g.status === 200 && isPdf) {
        const p = path.join(TMP_DIR, 'group-a.pdf');
        fs.writeFileSync(p, g.buf);
        const text = extractText(p);
        // إثبات سلوكي بالأسماء الحقيقية (العربية تُستخرج بثبات): موظف فئة A
        // حاضر وموظف فئة B غائب — أي أن الملف يذكر قوى A الحقيقية فقط.
        // (ملخصات D/N مرسومة بنفس أنبوب tr() المثبت للأسماء، وصحتها الرقمية
        // مثبتة نقيًا في ② — استخراج pypdf يُسقط بعض الدفقات الرقمية الصغيرة
        // من هذا الخط المضمَّن فلا تصلح مرجعًا للتحقق.)
        const aIn = empAName && text.indexOf(empAName) !== -1;
        const bOut = empBName && text.indexOf(empBName) === -1;
        namesOk = !!(aIn && bOut);
        extractNote = 'A_حاضر=' + !!aIn + ' B_غائب=' + !!bOut;
    }
    record('⑨ HTTP: ?group=A ⇒ 200 PDF يذكر قوى A الحقيقية (موظف A حاضر وموظف B غائب)',
        g.status === 200 && isPdf && g.buf.length > 20000 && namesOk
        && decodeURIComponent(g.disposition).indexOf('فئة') !== -1,
        'status=' + g.status + ' حجم=' + g.buf.length + ' ' + extractNote);

    const empty = await fetchPdfRaw('group=A&month=1999-01');
    record('⑩ HTTP: فئة بلا قوى في الفترة (1999-01) ⇒ 404', empty.status === 404, 'status=' + empty.status);

    const bad = await fetchPdfRaw('group=Z&month=' + month);
    record('⑪ HTTP: فئة غير صالحة (Z) ⇒ 400', bad.status === 400, 'status=' + bad.status);

    const c = await fetchPdfRaw('center=' + encodeURIComponent('جنوب 7') + '&month=' + month);
    record('⑫ HTTP: فرع center القديم (?center=جنوب 7) يعمل كما كان ⇒ 200 PDF',
        c.status === 200 && c.buf.slice(0, 5).toString() === '%PDF-', 'status=' + c.status + ' حجم=' + c.buf.length);
}

async function verifyPortFree() {
    await new Promise(r => setTimeout(r, 1200));
    const out = spawnSync('cmd', ['/c', 'netstat -ano | findstr :' + PORT + ' | findstr LISTENING'], { encoding: 'utf8' });
    const free = !(out.stdout || '').trim();
    record('تحرر المنفذ ' + PORT + ' بعد الإيقاف (netstat)', free, free ? 'لا مستمع' : (out.stdout || '').trim().split('\n')[0]);
}

async function main() {
    console.log('═══════════════════════════════════════════════');
    console.log(' تصدير الجداول حسب فئة رمز القوة (المنفذ ' + PORT + ')');
    console.log('═══════════════════════════════════════════════\n');

    await pureTests();

    const dbPath = await prepareIsolatedEnv();
    const month = latestMonth(dbPath);
    console.log('— شهر الفحص من القاعدة المؤقتة: ' + month + '\n');

    const { emps, empAName, empBName } = dbModelTests(dbPath, month);
    await goldenTests(dbPath, emps, month);

    startServer(dbPath);
    TOKEN = await waitForServer();
    await httpTests(month, empAName, empBName);

    try { if (serverProc) serverProc.kill(); } catch (_) { /* ignore */ }
    serverProc = null;
    await verifyPortFree();

    const passed = results.filter(r => r.ok).length;
    console.log('\n═══════════════════════════════════════════════');
    console.log(` النتيجة: ${passed}/${results.length} ${passed === results.length ? '— نجاح كامل ✅' : '— يوجد فشل ❌'}`);
    console.log('═══════════════════════════════════════════════');

    cleanup();
    process.exit(passed === results.length ? 0 : 1);
}

function cleanup() {
    try { if (serverProc) serverProc.kill(); } catch (_) { /* ignore */ }
    try { if (TMP_DIR) fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });

main().catch(err => {
    console.error('❌ فشل تشغيل الاختبار:', err.message);
    cleanup();
    process.exit(1);
});
