/**
 * اختبارات مرحلة الأوفرلاب 1 — الأكواد التشغيلية الملحقة (O12-09/RRA1-16…)
 * ═══════════════════════════════════════════════════════════════════════
 * نفس نمط العزل في multi-month-test.js / hours-metrics-test.js حرفيًا:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (يُضبط قبل require db.js).
 *   - القاموس يُقيَّم في sandbox (vm) مع حقن OperationalCodes — تُختبر النسخة
 *     المنشورة لا نسخة مكررة، ويُختبر السقوط الآمن بلا محلل.
 *   - مقتطف اشتقاق safeCode يُستخرج من smart-schedule.html الفعلي (regex)
 *     ويُقيَّم في vm — لا نسخة مكررة من المنطق.
 *
 * النهج الموثّق لاختبار ⑤ (فلتر شاشة التكميل):
 *   الفلتر مضمّن داخل مسار GET /api/shift-completion/:shiftId/:teamName في
 *   server.js (ليس وحدة منفصلة قابلة للطلب)، لذلك يُختبر عبر HTTP ضد خادم
 *   معزول يُقلع كعملية فرعية على منفذ عشوائي وبنفس قاعدة %TEMP% المؤقتة
 *   (JWT_SECRET ثابت للاختبار — التوكن يُوقَّع محليًا، وdb.Users.getByUserId
 *   غير موجود أصلًا فيتخطى authenticate فحص المستخدم). يُقتَل الخادم في
 *   finally مهما كانت النتيجة، وتُحذف القاعدة المؤقتة.
 *
 * التشغيل: node scripts/overlap-codes-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** تقييم القاموس الفعلي داخل sandbox مع/بلا محلل مشترك. */
function loadDictionaryWithParser(withParser) {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'core', 'shift-type-dictionary.js'), 'utf8');
    const sandbox = {};
    if (withParser) {
        sandbox.OperationalCodes = require(path.join(ROOT, 'public', 'js', 'core', 'operational-codes.js'));
    }
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    if (!sandbox.ShiftTypeDictionary) throw new Error('فشل تقييم shift-type-dictionary.js في sandbox');
    return sandbox.ShiftTypeDictionary;
}

/** انتظار جاهزية الخادم المعزول عبر /health (مستثنى من المصادقة ومحدد المعدل). */
async function waitForServer(base, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(base + '/health');
            if (res.status === 200) return true;
        } catch (_) { /* لم يقلع بعد */ }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

async function main() {
    console.log('\n═══ اختبارات مرحلة الأوفرلاب 1 — الأكواد التشغيلية الملحقة ═══\n');

    const OC = require(path.join(ROOT, 'public', 'js', 'core', 'operational-codes.js'));

    // ─── ① المحلل: صيغ صالحة (مدد 12 ساعة + عبور منتصف الليل) وباطلة ⇒ null ───
    const p = c => OC.parseOperationalCode(c);
    const t1valid =
        JSON.stringify(p('O12-09')) === JSON.stringify({ kind: 'overlap', durationH: 12, start: '09:00', end: '21:00' }) &&
        JSON.stringify(p('O12-12')) === JSON.stringify({ kind: 'overlap', durationH: 12, start: '12:00', end: '00:00' }) &&
        JSON.stringify(p('O12-14')) === JSON.stringify({ kind: 'overlap', durationH: 12, start: '14:00', end: '02:00' }) &&
        // الصيغة الجديدة الموقعة: حرف D/N صريح (explicitShift) — D-04⇒صباحية 04:00 · N-16⇒ليلية 16:00
        JSON.stringify(p('RRA1-D-04')) === JSON.stringify({ kind: 'rapid', series: 'A', rapidNo: 1, shift: 'D', explicitShift: true, durationH: 12, start: '04:00', end: '16:00' }) &&
        JSON.stringify(p('RRA1-N-16')) === JSON.stringify({ kind: 'rapid', series: 'A', rapidNo: 1, shift: 'N', explicitShift: true, durationH: 12, start: '16:00', end: '04:00' }) &&
        // الصيغة القديمة تبقى: shift:null · legacy:true — نفس البداية والنهاية
        JSON.stringify(p('RRA1-04')) === JSON.stringify({ kind: 'rapid', series: 'A', rapidNo: 1, shift: null, legacy: true, durationH: 12, start: '04:00', end: '16:00' }) &&
        JSON.stringify(p('RRA1-16')) === JSON.stringify({ kind: 'rapid', series: 'A', rapidNo: 1, shift: null, legacy: true, durationH: 12, start: '16:00', end: '04:00' });
    const t1invalid = ['O12', 'O12-9', 'O12-25', 'RRA-12', 'RRA1-X-04', 'RRA1-D-24', 'D12', 'ABC', '', null, undefined]
        .every(c => p(c) === null);
    record('① المحلل: O12-09/12/14 + RRA1-D-04/N-16 (D/N صريحة) + RRA1-04/16 (legacy) · الباطلة وRRA1-X-04 ⇒ null',
        t1valid && t1invalid, `صالحة=${t1valid} باطلة=${t1invalid}`);

    // ─── ② resolveOperationalStart: اللاحقة > وقت الصف > حد النظام القديم ───
    const rs = OC.resolveOperationalStart;
    const t2 = rs('O12-12', { time_start: '07:30' }, 'صباحية') === '12:00' &&   // اللاحقة تغلب وقت الصف
        rs('D12', { time_start: '07:30' }, 'ليلية') === '07:30' &&              // وقت الصف يغلب الحد القديم
        rs('N12', null, 'ليلية') === '17:00' &&                                 // حد ليلي
        rs('D12', null, 'صباحية') === '05:00' &&                                // حد صباحي
        rs('RRA1-04', null, 'صباحية') === '04:00' &&                            // اللاحقة وحدها تكفي (قديم)
        rs('RRA1-D-04', null, 'صباحية') === '04:00';                            // اللاحقة وحدها تكفي (جديد)
    record('② resolveOperationalStart: لاحقة الكود ← time_start الصف ← حد 05:00/17:00', t2);

    // ── قاعدة معزولة مؤقتة (Windows: %TEMP% = C:\Users\...\AppData\Local\Temp) ──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-codes-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const db = require(path.join(ROOT, 'db.js'));
    let serverChild = null;
    try {
        await db.init(false); // مخطط كامل + ترحيلات + بذر — init يستدعي runMigrations دائمًا

        // ─── ③ البذر + الترحيل: الأكواد السبعة بأوقاتها الحرفية · محاكاة قاعدة قديمة · idempotent ───
        const EXPECTED = [
            ['O12-09', '09:00', '21:00'], ['O12-12', '12:00', '00:00'], ['O12-14', '14:00', '02:00'],
            ['RRA1-D-04', '04:00', '16:00'], ['RRA1-N-16', '16:00', '04:00'],
            ['RRA1-04', '04:00', '16:00'], ['RRA1-16', '16:00', '04:00']
        ];
        const ALL7 = "'O12-09','O12-12','O12-14','RRA1-D-04','RRA1-N-16','RRA1-04','RRA1-16'";
        const rowsNow = await db.all(
            `SELECT code, time_start, time_end, color, status FROM shift_codes WHERE code IN (${ALL7})`);
        const t3seed = EXPECTED.every(([code, s, e]) =>
            rowsNow.some(r => r.code === code && r.time_start === s && r.time_end === e && r.status === 'دوام'));
        // محاكاة قاعدة قديمة: حذف السبعة ثم إعادة init ⇒ الترحيل يعيد إدراجها (الجديدة + القديمة)
        await db.run(`DELETE FROM shift_codes WHERE code IN (${ALL7})`);
        await db.closeDb();
        await db.init(false);
        const rowsAfter = await db.all(
            `SELECT code, time_start, time_end FROM shift_codes WHERE code IN (${ALL7})`);
        const t3migrated = EXPECTED.every(([code, s, e]) =>
            rowsAfter.some(r => r.code === code && r.time_start === s && r.time_end === e));
        // idempotent: إعادة ثالثة = لا-op (يبقى صف واحد لكل كود)
        await db.closeDb();
        await db.init(false);
        const dupCount = await db.get(
            `SELECT COUNT(*) AS n FROM (SELECT code FROM shift_codes WHERE code IN (${ALL7}) GROUP BY code HAVING COUNT(*) > 1)`);
        const total = await db.get(
            `SELECT COUNT(*) AS n FROM shift_codes WHERE code IN (${ALL7})`);
        record('③ البذر والترحيل: 7 أكواد بأوقات حرفية (الجديدة + القديمة) · قاعدة قديمة تُستكمل · idempotent بلا تكرار',
            t3seed && t3migrated && total.n === 7 && dupCount.n === 0,
            `بذر=${t3seed} ترحيل=${t3migrated} إجمالي=${total.n} مكرر=${dupCount.n}`);

        // ─── ④ القاموس: أسبقية المحلل (vm + حقن) · D/N صريحة تغلب الساعة · القديم على اشتقاق الساعة · السقوط بلا محلل ───
        const STD = loadDictionaryWithParser(true);
        const cOv = STD.classifyDayCode('O12-12');
        const cND04 = STD.classifyDayCode('RRA1-D-04');
        const cNN16 = STD.classifyDayCode('RRA1-N-16');
        const cRr04 = STD.classifyDayCode('RRA1-04');
        const cRr16 = STD.classifyDayCode('RRA1-16');
        const cD12 = STD.classifyDayCode('D12');
        const t4with =
            cOv.group === 'overlap' && cOv.filterCat === 'أوفرلاب' && cOv.shift === 'صباحية' &&   // 12:00 ∈ [05,17)
            cND04.group === 'overlap' && cND04.filterCat === 'أوفرلاب' && cND04.shift === 'صباحية' && // حرف D ⇒ صباحية رغم 04:00
            cNN16.group === 'overlap' && cNN16.filterCat === 'أوفرلاب' && cNN16.shift === 'ليلية' &&  // حرف N ⇒ ليلية رغم 16:00
            cRr04.group === 'overlap' && cRr04.shift === 'ليلية' &&                              // قديم: 04:00 ⇒ ليلية (اشتقاق الساعة)
            cRr16.group === 'overlap' && cRr16.shift === 'صباحية' &&                             // قديم: 16:00 ∈ [05,17) ⇒ صباحية
            cD12.group === 'morning' && cD12.shift === 'صباحية';                                 // قديم بلا تغيير
        // بلا محلل: السلوك الحالي كما هو (مكتب — سقوط غير المعروف) وبلا أي رمي
        const STDnone = loadDictionaryWithParser(false);
        let t4fallback = false;
        try {
            const c = STDnone.classifyDayCode('O12-12');
            t4fallback = c && c.group === 'office';
        } catch (_) { t4fallback = false; }
        record('④ القاموس: RRA1-D-04⇒صباحية رغم 04:00 · RRA1-N-16⇒ليلية رغم 16:00 · القديم على الساعة · D12 ثابت · بلا محلل⇒سقوط آمن',
            t4with && t4fallback, `مع=${t4with} سقوط=${t4fallback}`);

        // ─── ⑤ فلتر شاشة التكميل عبر خادم معزول (النهج موثّق في ترويسة الملف) ───
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });
        // الكتابة عبر الكاتب الرسمي فقط: 5 أكواد في «جنوب 3» ليوم المناوبة
        await sync.syncFromSchedule([
            { employeeNumber: '901', name: 'أوفرلاب اختبار', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-15', shiftCode: 'O12-12' }] },
            { employeeNumber: '902', name: 'سريع اختبار جديد', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-15', shiftCode: 'RRA1-N-16' }] },
            { employeeNumber: '905', name: 'سريع اختبار قديم', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-15', shiftCode: 'RRA1-04' }] },
            { employeeNumber: '903', name: 'ليلي اختبار (ضابطة)', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-15', shiftCode: 'N12' }] },
            { employeeNumber: '904', name: 'خردة اختبار (ضابطة)', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-15', shiftCode: 'Q9' }] }
        ]);
        const shiftIns = await db.run(
            `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time)
             VALUES ('مناوبة اختبار أوفرلاب', '2026-08-15', '17:00', 'ليلية', 'السبت', '2026-08-15T14:00:00.000Z')`);
        const shiftId = shiftIns.id;
        await db.closeDb(); // الخادم يفتح القاعدة نفسها — إغلاق مقبض الاختبار أولًا

        const TEST_SECRET = 'overlap-codes-test-secret';
        const port = 20000 + Math.floor(Math.random() * 20000);
        const base = `http://127.0.0.1:${port}`;
        serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
            cwd: ROOT,
            env: { ...process.env, DB_PATH: tmpDb, PORT: String(port), JWT_SECRET: TEST_SECRET, NODE_ENV: 'development' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let serverLog = '';
        serverChild.stdout.on('data', d => { serverLog += d.toString(); });
        serverChild.stderr.on('data', d => { serverLog += d.toString(); });

        let t5 = false, t5detail = '';
        const up = await waitForServer(base, 60000);
        if (!up) {
            t5detail = 'الخادم المعزول لم يقلع خلال 60 ثانية';
        } else {
            const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
            const token = jwt.sign({ id: 1, username: 'overlap-test', name: 'اختبار', role: 'admin' }, TEST_SECRET, { expiresIn: '5m' });
            // انتظار اكتمال init داخل الخادم (الجداول تُفحص عند كل طلب)
            const url = `${base}/api/shift-completion/${shiftId}/${encodeURIComponent('جنوب 3')}`;
            let data = null;
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
                data = await res.json().catch(() => null);
                if (data && data.source !== 'legacy') break; // الجداول جاهزة
                await new Promise(r => setTimeout(r, 500));
            }
            const codes = (data && data.paramedics ? data.paramedics : []).map(x => x.shift_code);
            const t5accept = codes.includes('O12-12') && codes.includes('RRA1-N-16') && codes.includes('RRA1-04');
            const t5legacy = codes.includes('N12') && !codes.includes('Q9');
            t5 = t5accept && t5legacy;
            t5detail = `الأكواد المقبولة=[${codes.join(', ')}] قبول=${t5accept} ضابطة=${t5legacy}`;
        }
        record('⑤ فلتر التكميل (خادم معزول): O12-12/RRA1-N-16/RRA1-04 مقبولة · N12 ثابت · Q9 يبقى مصفّى',
            t5, t5detail);
        if (serverChild) { try { serverChild.kill(); } catch (_) {} serverChild = null; }

        // ─── ⑥ عائلة CSS: مقتطف safeCode من HTML الفعلي (تثبيت بالتعليق العربي + vm) ───
        const html = fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8');
        // التثبيت بالتعليق العربي الفريد يضمن التقاط كتلة buildClassicGridHtml تحديدًا
        // (يوجد اشتقاق safeCode آخر أقدم في الملف لا يخص هذا الاختبار)
        const anchor = html.indexOf('// الأكواد التشغيلية الملحقة تُلوَّن');
        const snipStart = anchor === -1 ? -1 : html.lastIndexOf('var safeCode = String(shiftCode)', anchor);
        const snipEndMark = "safeCode = 'RRA';";
        const snipEnd = anchor === -1 ? -1 : html.indexOf(snipEndMark, anchor);
        const snippet = (snipStart !== -1 && snipEnd !== -1) ? html.slice(snipStart, snipEnd + snipEndMark.length) : null;
        let t6 = false, t6detail = '';
        if (!snippet) {
            t6detail = 'مقتطف اشتقاق safeCode غير موجود في smart-schedule.html';
        } else {
            const sandbox = {};
            vm.createContext(sandbox);
            vm.runInContext(`this.derive = function (shiftCode) {\n${snippet}\nreturn 'classic-shift-' + safeCode;\n};`, sandbox);
            const d = sandbox.derive;
            const t6map = d('O12-12') === 'classic-shift-O12' &&
                d('O12-14') === 'classic-shift-O12' &&
                d('RRA1-16') === 'classic-shift-RRA' &&
                d('RRA1-04') === 'classic-shift-RRA' &&
                d('RRA1-D-04') === 'classic-shift-RRA' &&
                d('RRA1-N-16') === 'classic-shift-RRA' &&
                d('D12') === 'classic-shift-D12';
            const t6css = html.includes('.classic-shift-RRA') && html.includes('.classic-shift-O12');
            const t6script = html.indexOf('js/core/operational-codes.js') !== -1 &&
                html.indexOf('js/core/operational-codes.js') < html.indexOf('js/core/shift-type-dictionary.js');
            t6 = t6map && t6css && t6script;
            t6detail = `O12-12⇒${d('O12-12')} RRA1-D-04⇒${d('RRA1-D-04')} RRA1-N-16⇒${d('RRA1-N-16')} D12⇒${d('D12')} css=${t6css} وسم_قبل_القاموس=${t6script}`;
        }
        record('⑥ عائلة CSS: O12-*⇒classic-shift-O12 · RRA* (جديدة وقديمة)⇒classic-shift-RRA · D12 ثابت · قاعدة RRA + الوسم قبل القاموس',
            t6, t6detail);

    } catch (err) {
        record('خطأ غير متوقع أثناء الاختبارات', false, err.message);
        console.error(err);
    } finally {
        if (serverChild) { try { serverChild.kill(); } catch (_) {} }
        try { await db.closeDb(); } catch (_) {}
        // مهلة قصيرة حتى يتحرر مقبض WAL على ويندوز قبل الحذف
        await new Promise(r => setTimeout(r, 500));
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    // ─── الملخص ───
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ الملخص: ${results.length - failed.length}/${results.length} ناجح ═══`);
    if (failed.length) {
        failed.forEach(f => console.log(`   ❌ ${f.name}`));
        process.exit(1);
    }
    console.log('✅ جميع اختبارات مرحلة الأوفرلاب 1 ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
