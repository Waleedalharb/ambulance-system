/**
 * PDF SSOT Test — البند ③: تصدير PDF الجدول يقرأ من قاعدة البيانات فقط
 * ═══════════════════════════════════════════════════════════════════════════
 * الإثبات بنفس منهجية البندين ① و②:
 *   1) «JSON مسموم»: خلية معروفة في schedule-employees.json تُسمَّم إلى رمز
 *      وهمي ZZZ بينما القاعدة تحمل N12 — يجب أن يظهر N12 في PDF ولا يظهر ZZZ.
 *   2) «شهر يوليو»: بياناته موجودة في القاعدة فقط (JSON يحمل أغسطس فقط) —
 *      لو كان المصدر JSON لأعاد المسار 404؛ من القاعدة يعيد 200.
 *   3) مركز وهمي → 404 (سلامة الفلتر).
 *
 * العزل: ينسخ data/ambulance.db وusers.json إلى مجلد مؤقت (قراءة فقط من
 * الإنتاج — لا يمسه)، ويضع JSON المسموم في المجلد المؤقت، ويُشغّل خادمًا
 * معزولًا على PORT 3086 ويوقفه عند الانتهاء.
 *
 * التشغيل (من جذر المشروع):  node scripts/test-pdf-ssot.js
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3086;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const results = [];
let TOKEN = null;
let serverProc = null;
let TMP_DIR = null;

// الخلية المعروفة (من قاعدة الإنتاج): الموظف 1415 — 2026-08-05 — القاعدة: N12
const POISON_EMP_CODE = '1415';
const POISON_DATE = '2026-08-05';
const POISON_CODE = 'ZZZ';
const REAL_CODE = 'N12';
const TEST_CENTER = 'جنوب 7';

function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
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

function prepareIsolatedEnv() {
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ssot-'));
    fs.copyFileSync(path.join(ROOT, 'data', 'ambulance.db'), path.join(TMP_DIR, 'test.db'));
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    // JSON مسموم: نفس ملف الإنتاج لكن خلية الموظف 1415 بتاريخ 2026-08-05 → ZZZ
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'schedule-employees.json'), 'utf8'));
    let poisoned = false;
    src.forEach(e => {
        if (String(e.id) !== POISON_EMP_CODE && String(e.employeeNumber) !== POISON_EMP_CODE) return;
        (e.schedule || []).forEach(s => {
            if (s.date === POISON_DATE) { s.shiftCode = POISON_CODE; s.shift = POISON_CODE; poisoned = true; }
        });
    });
    if (!poisoned) throw new Error('تعذّر تسميم الخلية المعروفة في JSON');
    fs.writeFileSync(path.join(TMP_DIR, 'schedule-employees.json'), JSON.stringify(src, null, 2));
    return path.join(TMP_DIR, 'test.db');
}

function startServer(dbPath) {
    serverProc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, DB_PATH: dbPath, DATA_DIR: TMP_DIR, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    serverProc.stdout.on('data', c => { buf += c.toString(); });
    serverProc.stderr.on('data', c => { buf += c.toString(); });
    serverProc.on('exit', code => {
        if (code !== null && code !== 0) {
            console.error('— خرج الخادم المعزول مبكرًا (code ' + code + '):\n' + buf.slice(-1500));
        }
    });
}

async function fetchPdf(center, month) {
    const res = await fetch(BASE + '/api/schedule/pdf?center=' + encodeURIComponent(center) + '&month=' + month, {
        headers: { 'Authorization': 'Bearer ' + TOKEN }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf };
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

async function main() {
    console.log('═══════════════════════════════════════════════');
    console.log(' PDF SSOT — البند ③ (المنفذ ' + PORT + ')');
    console.log('═══════════════════════════════════════════════\n');

    const dbPath = prepareIsolatedEnv();
    startServer(dbPath);
    TOKEN = await waitForServer();

    // ── ① أغسطس مع JSON مسموم ──
    const aug = await fetchPdf(TEST_CENTER, '2026-08');
    record('أغسطس: المسار يعيد 200', aug.status === 200, 'status=' + aug.status);
    const isPdf = aug.buf.slice(0, 4).toString() === '%PDF';
    record('أغسطس: المخرجات PDF سليمة البنية', isPdf && aug.buf.length > 20000,
        'magic=' + (isPdf ? '%PDF' : '?') + ' size=' + aug.buf.length);

    const augPath = path.join(TMP_DIR, 'aug.pdf');
    fs.writeFileSync(augPath, aug.buf);
    const augText = extractText(augPath);
    const zzzCount = (augText.match(/ZZZ/g) || []).length;
    const n12Count = (augText.match(/N12/g) || []).length;
    record('أغسطس: الرمز المسموم ZZZ غائب تمامًا (المصدر ليس JSON)', zzzCount === 0, 'ZZZ=' + zzzCount);
    record('أغسطس: رمز القاعدة N12 ظاهر', n12Count > 0, 'N12=' + n12Count);

    // ── ② يوليو — موجود في القاعدة فقط ──
    const jul = await fetchPdf(TEST_CENTER, '2026-07');
    record('يوليو (في القاعدة فقط): المسار يعيد 200 — مستحيل من JSON', jul.status === 200,
        'status=' + jul.status + ' size=' + jul.buf.length);

    // ── ③ مركز وهمي ──
    const ghost = await fetchPdf('مركز وهمي لا يوجد', '2026-08');
    record('مركز وهمي: 404 (سلامة فلتر المركز)', ghost.status === 404, 'status=' + ghost.status);

    // ── الملخص ──
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
