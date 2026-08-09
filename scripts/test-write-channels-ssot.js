/**
 * Write Channels SSOT Test — البند ④: قناة الكتابة الواحدة + حماية الاستيراد + Clear All
 * ═══════════════════════════════════════════════════════════════════════════
 * يثبت على قاعدة معزولة طازجة (PORT 3087):
 *   1) تعديل الخلية اليدوي يعمل ويثبت في القاعدة.
 *   2) /api/shift-roster/import (المسار القديم) أصبح مفوَّضًا للكاتب الرسمي:
 *      - يكتب للقاعدة فقط (لا مصدر ثانٍ).
 *      - 409 عند تعارض تعيين يدوي (source='manual') بلا تأكيد — ولا كتابة إطلاقًا.
 *      - confirmOverwriteManual=true يستبدل موثَّقًا (manualOverwritten).
 *      - لا يمسح رقم جوال مخزنًا عند غياب عمود الجوال.
 *   3) clear-all: يمسح roster + يحيّد ملف JSON (لا بعث للبيانات الممسوحة)
 *      + يوثّق في Audit + الجدول يعيد الفتح فارغًا دون رجوع القديم.
 *   4) إعادة الاستيراد بعد المسح تعمل (القناة حيّة من الطرف للطرف).
 *
 * التشغيل (من جذر المشروع):  node scripts/test-write-channels-ssot.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3087;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const results = [];
let TOKEN = null;
let serverProc = null;
let TMP_DIR = null;

function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, p, body) {
    const opts = { method, headers: {} };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + p, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-json */ }
    return { status: res.status, data };
}

async function waitForServer(timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const res = await fetch(BASE + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: '4252', password: '4252' })
            });
            if (res.status === 200) {
                const data = await res.json();
                if (data && data.accessToken) return data.accessToken;
            }
        } catch (_) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 800));
    }
    throw new Error('انتهت مهلة انتظار الخادم المعزول');
}

function startServer() {
    TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'write-channels-'));
    const dbPath = path.join(TMP_DIR, 'test.db');
    serverProc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, DB_PATH: dbPath, DATA_DIR: TMP_DIR, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    serverProc.stdout.on('data', c => { buf += c.toString(); });
    serverProc.stderr.on('data', c => { buf += c.toString(); });
    serverProc._log = () => buf;
}

function stopServer() {
    return new Promise(resolve => {
        if (!serverProc) return resolve();
        serverProc.once('exit', () => resolve());
        try { serverProc.kill(); } catch (_) { resolve(); }
        setTimeout(resolve, 5000);
    });
}

async function main() {
    console.log('\n═══ Write Channels SSOT Test @ ' + BASE + ' (قاعدة معزولة طازجة) ═══\n');
    startServer();
    TOKEN = await waitForServer();
    record('إقلاع الخادم المعزول + تسجيل الدخول admin', !!TOKEN);

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const mm = String(month).padStart(2, '0');
    const dayStr = (d) => `${year}-${mm}-${String(d).padStart(2, '0')}`;

    // ─── تجهيز ───
    const teams = ((await api('GET', '/api/teams')).data || {}).teams || [];
    const team1 = teams.find(t => t.name === 'جنوب 1');
    const team2 = teams.find(t => t.name === 'جنوب 2');
    if (!team1 || !team2) throw new Error('الفرق المزروعة غير موجودة');

    const mkEmp = async (code, name, phone) => {
        const r = await api('POST', '/api/employees', { employee_code: code, name, phone: phone || null, job_title: 'مسعف' });
        if (!r.data || !r.data.id) throw new Error('فشل إنشاء موظف ' + code);
        return r.data.id;
    };
    const w1 = await mkEmp('W001', 'قناة أحمد', '0500000001');
    const w2 = await mkEmp('W002', 'قناة بدر', null);
    for (let d = 1; d <= 10; d++) {
        await api('POST', '/api/shift-roster', {
            employee_id: w1, team_id: team1.id,
            shift_date: dayStr(d), shift_code: 'D12', month, year
        });
    }
    // تعيين يدوي (source='manual'): W002 ← جنوب 2
    const tr = await api('POST', '/api/employees/W002/transfer', { teamId: team2.id, scope: 'from-date', date: dayStr(1) });
    record('تجهيز: موظفان + roster W001 (10 أيام D12) + تعيين يدوي W002←جنوب 2',
        tr.status === 200, 'transfer=' + tr.status);

    // ═══ 1) تعديل خلية يدوي — يثبت في القاعدة ═══
    const cell = await api('PUT', '/api/shift-roster/cell', { employeeCode: 'W001', date: dayStr(5), shiftCode: 'N12' });
    const rosterAfterCell = ((await api('GET', '/api/shift-roster')).data || {}).roster || [];
    const cellRow = rosterAfterCell.find(r => r.employee_id === w1 && r.shift_date === dayStr(5));
    record('تعديل خلية W001 يوم 5: D12←N12 يثبت في القاعدة',
        cell.status === 200 && cellRow && cellRow.shift_code === 'N12',
        'put=' + cell.status + ' stored=' + (cellRow && cellRow.shift_code));

    // ═══ 2) المسار القديم مفوَّض للكاتب الرسمي + حماية الجوال ═══
    const rosterW1 = [];
    for (let d = 1; d <= 10; d++) {
        rosterW1.push({ employee_code: 'W001', team_name: 'جنوب 1', shift_date: dayStr(d), shift_code: 'D12' });
    }
    const impPhone = await api('POST', '/api/shift-roster/import', {
        employees: [
            { employee_code: 'W001', name: 'قناة أحمد', phone: '', job_title: 'مسعف', team_name: 'جنوب 1' },
            { employee_code: 'W002', name: 'قناة بدر', phone: null, job_title: 'مسعف', team_name: 'جنوب 2' }
        ],
        roster: rosterW1, month, year
    });
    const w1After = (((await api('GET', '/api/employees')).data || {}).employees || []).find(e => e.employee_code === 'W001');
    record('المسار القديم يكتب عبر الكاتب الرسمي (200 + rosterCount)',
        impPhone.status === 200 && impPhone.data && impPhone.data.rosterCount === 10,
        'status=' + impPhone.status + ' rosterCount=' + (impPhone.data && impPhone.data.rosterCount));
    record('الجوال المخزّن لا يُمسح بعمود فارغ في الاستيراد',
        w1After && w1After.phone === '0500000001',
        'phone=' + (w1After && w1After.phone));
    const cellRow2 = (((await api('GET', '/api/shift-roster')).data || {}).roster || [])
        .find(r => r.employee_id === w1 && r.shift_date === dayStr(5));
    // دلالة الكاتب الواحد: الاستيراد يعيد بناء الفترة كاملة — يغلب على خلايا
    // roster (نفس سلوك القناة الرسمية حرفيًا). الحماية اليدوية تخص تعيينات
    // الفرق source='manual' (مختبرة في الخطوة 3) وليس رموز الخلايا.
    record('سلوك إعادة البناء مطابق للقناة الرسمية (الاستيراد يغلب على خلية roster)',
        cellRow2 && cellRow2.shift_code === 'D12',
        'stored=' + (cellRow2 && cellRow2.shift_code));

    // ═══ 3) حماية التعارض اليدوي: 409 بلا كتابة ═══
    // الحمولة تضم الكادر كاملًا كما يرسله العميل الحقيقي (الكاتب الموحد يعطّل
    // من ليس في الاستيراد — نفس دلالة القناة الرسمية)
    const impConflict = await api('POST', '/api/shift-roster/import', {
        employees: [
            { employee_code: 'W001', name: 'قناة أحمد', job_title: 'مسعف', team_name: 'جنوب 1' },
            { employee_code: 'W002', name: 'قناة بدر', job_title: 'مسعف', team_name: 'جنوب 1' }
        ],
        roster: rosterW1.concat([{ employee_code: 'W002', team_name: 'جنوب 1', shift_date: dayStr(3), shift_code: 'D12' }]),
        month, year
    });
    const conf0 = impConflict.data && Array.isArray(impConflict.data.conflicts) && impConflict.data.conflicts[0];
    record('استيراد متعارض مع تعيين يدوي → 409 + conflicts',
        impConflict.status === 409 && conf0 && conf0.manualTeam === 'جنوب 2' && conf0.importTeam === 'جنوب 1',
        'status=' + impConflict.status + ' manual=' + (conf0 && conf0.manualTeam) + ' import=' + (conf0 && conf0.importTeam));
    const assignAfter409 = (((await api('GET', '/api/team-assignments/employee/' + w2)).data || {}).assignments) || [];
    const openAfter409 = assignAfter409.find(a => !a.end_date);
    record('409 لم يكتب شيئًا: التعيين اليدوي باقٍ على جنوب 2',
        openAfter409 && openAfter409.team_id === team2.id && openAfter409.source === 'manual',
        'team=' + (openAfter409 && openAfter409.team_id) + ' source=' + (openAfter409 && openAfter409.source));

    // ═══ 4) تأكيد صريح → استبدال موثَّق ═══
    const impOverwrite = await api('POST', '/api/shift-roster/import', {
        employees: [
            { employee_code: 'W001', name: 'قناة أحمد', job_title: 'مسعف', team_name: 'جنوب 1' },
            { employee_code: 'W002', name: 'قناة بدر', job_title: 'مسعف', team_name: 'جنوب 1' }
        ],
        roster: rosterW1.concat([{ employee_code: 'W002', team_name: 'جنوب 1', shift_date: dayStr(3), shift_code: 'D12' }]),
        month, year, confirmOverwriteManual: true
    });
    const overwritten = impOverwrite.data && impOverwrite.data.rosterSync && impOverwrite.data.rosterSync.manualOverwritten;
    record('confirmOverwriteManual → 200 + manualOverwritten=1',
        impOverwrite.status === 200 && overwritten === 1,
        'status=' + impOverwrite.status + ' overwritten=' + overwritten);

    // ═══ 5) clear-all: مسح + تحييد JSON + توثيق ═══
    // أعد بذر roster حتى يكون للمسح معنى (خطوة 3/4 أعادت بناء شهر واحد فقط لـ W002)
    const before = (((await api('GET', '/api/shift-roster')).data || {}).roster || []).length;
    const clr = await api('POST', '/api/shift-roster/clear-all');
    const afterApi = ((await api('GET', '/api/shift-roster')).data || {}).roster || [];
    record('clear-all: القاعدة تُمسح بالكامل',
        clr.status === 200 && before > 0 && afterApi.length === 0,
        'before=' + before + ' after=' + afterApi.length);

    const jsonPath = path.join(TMP_DIR, 'schedule-employees.json');
    let jsonOk = false;
    try {
        const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        jsonOk = Array.isArray(j) && j.length === 0;
    } catch (_) { jsonOk = false; }
    record('clear-all: ملف JSON محيَّد ([]) — لا بعث للبيانات الممسوحة', jsonOk, jsonPath);

    const jsonGet = await api('GET', '/api/schedule/employees');
    record('GET /api/schedule/employees بعد المسح يعيد [] (لا مصدر بديل)',
        jsonGet.status === 200 && jsonGet.data && Array.isArray(jsonGet.data.employees) && jsonGet.data.employees.length === 0);

    const audit = await api('GET', '/api/audit-log?limit=20');
    const entries = (audit.data && (audit.data.entries || audit.data.logs || audit.data.auditLog)) || [];
    const hasClearAudit = entries.some(e => (e.action || '').includes('roster_clear_all'));
    record('clear-all موثَّق في سجل التدقيق العام (roster_clear_all)', hasClearAudit,
        'entries=' + entries.length);

    // ═══ 6) إعادة فتح الجدول + إعادة الاستيراد بعد المسح ═══
    const empsAfter = ((await api('GET', '/api/employees')).data || {}).employees || [];
    const activeAfter = empsAfter.filter(e => e.is_active !== 0);
    record('إعادة فتح الجدول: الموظفون باقون وroster فارغ (دلالة المسح محفوظة)',
        activeAfter.length >= 2 && afterApi.length === 0,
        'active=' + activeAfter.length);

    const impAgain = await api('POST', '/api/shift-roster/import', {
        employees: [{ employee_code: 'W001', name: 'قناة أحمد', job_title: 'مسعف', team_name: 'جنوب 1' }],
        roster: rosterW1, month, year
    });
    const rosterFinal = ((await api('GET', '/api/shift-roster')).data || {}).roster || [];
    record('إعادة الاستيراد بعد المسح تعمل (القناة حيّة من الطرف للطرف)',
        impAgain.status === 200 && rosterFinal.length === 10,
        'status=' + impAgain.status + ' roster=' + rosterFinal.length);

    // ─── الملخص ───
    const passed = results.filter(r => r.ok).length;
    console.log('\n═══ النتيجة: ' + passed + '/' + results.length + (passed === results.length ? ' — نجاح كامل ✅' : ' — يوجد فشل ❌') + ' ═══');
    await stopServer();
    try { if (TMP_DIR) fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    process.exit(passed === results.length ? 0 : 1);
}

process.on('SIGINT', async () => { await stopServer(); process.exit(130); });

main().catch(async err => {
    console.error('❌ فشل تشغيل الاختبار:', err.message);
    if (serverProc && serverProc._log) console.error(serverProc._log().slice(-1200));
    await stopServer();
    process.exit(1);
});
