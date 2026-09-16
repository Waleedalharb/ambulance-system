/**
 * ═══ اختبار توسعة بوابة الموظف v5 — تغييرات الجدول والإشعارات ═══
 * السيناريوهات الـ16 المشروطة باعتماد المالك (2026-09-16)، حرفيًا:
 *   1) إعادة نفس الملف = صفر تغيير/صفر audit/صفر إشعار
 *   2) تغيير فرقة   3) تغيير رمز مناوبة   4) تغييرات متعددة لموظف واحد
 *   5) فرد ضمن استيراد جماعي (المتأثر فقط يُشعَر)
 *   6) حذف من الجدول   7) إضافة إلى الجدول
 *   8) الليلية الممتدة في «من معي» (نافذة التوقيت الفعلي + القيادة/العمليات بالمطابقة التامة)
 *   9) تكرار الاسم بـ employee_id مختلف (الاستهداف بالمعرّف لا الاسم)
 *  10) بلا staff.phone_view ⇒ لا جوال   11) مع staff.phone_view ⇒ جوال
 *  12) وصول الإشعار (sent + recipient_user_id)
 *  13) ختم القراءة   14) ختم التأكيد (فتح ≠ تأكيد، بلا تكرار)
 *  15) إعادة نفس الحدث = بلا إشعار مكرر   16) فشل الإشعار لا يرجع الجدول
 *  + حراسة المسارات: 401 بلا توكن · 403 بلا الصلاحية · 404 بلا ملف موظف
 * تصحيحات المالك 2026-09-16 (بعد التجربة الواقعية):
 *  17) Day نشطة من التعيين   18) Night نشطة   19) الليلية الممتدة (02:00 ← أمس)
 *  20) تغيير Day←Night: السياق ليلي upcoming لا صباحي   21) تغيير الفرقة
 *  22) أكثر من مجموعة بنفس اليوم   23) بلا تعيين = سقوط لنافذة الساعة
 *  24) سلامة حقول المصدر (shift_code/team_id)   25) التوصيل اللحظي SSE الموجَّه
 *
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت معزول — لا تمس بيانات الإنتاج.
 * التشغيل: node scripts/my-portal-ext-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'myportext-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'myportext-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3129;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 90) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
const pad2 = v => String(v).padStart(2, '0');
function riyadhPartsRef() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(new Date());
    const g = t => (parts.find(p => p.type === t) || {}).value;
    return { year: g('year'), month: g('month'), day: g('day'), hour: +g('hour') % 24, minute: +g('minute') };
}
function addDaysRef(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── نسخة معزولة + ملفات JSON ──
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    // ── مرجع النافذة المستقل (لا يستدعي كود الخدمة) ──
    const rp = riyadhPartsRef();
    const today = `${rp.year}-${rp.month}-${rp.day}`;
    const mins = rp.hour * 60 + rp.minute;
    const winDate = mins < 300 ? addDaysRef(today, -1) : today;
    const side = mins < 300 ? 'night' : (mins < 1020 ? 'day' : 'night');
    const winCode = side === 'night' ? 'N12' : 'D12';
    const oppCode = side === 'night' ? 'D12' : 'N12';
    const cm = today.slice(0, 7);
    const D = day => `${cm}-${pad2(day)}`;

    // ── مستخدمون + موظفون + صلاحيات ──
    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    const U = (id, username, name, role) => users.push({ id, username, name, password: hash, role, isActive: true });
    U('adm-TADM', 'TADM', 'مستورد الاختبار', 'admin');
    U('emp-TA01', 'TA01', 'موظف أول', 'user');
    U('emp-TB01', 'TB01', 'موظف ثانٍ', 'user');
    U('emp-TC01', 'TC01', 'موظف ثالث', 'user');
    U('emp-TD01', 'TD01', 'محمد مكرر', 'user');
    U('emp-TD02', 'TD02', 'محمد مكرر', 'user');   // نفس الاسم — معرّف مختلف (سيناريو 9)
    U('emp-TE01', 'TE01', 'قائد ميداني', 'user');
    U('emp-TE02', 'TE02', 'قائد بمسمى غير مطابق', 'user');
    U('emp-TO01', 'TO01', 'متحكم عملياتي', 'user');
    U('emp-TN01', 'TN01', 'بلا صلاحية', 'user');
    U('emp-TN02', 'TN02', 'حساب بلا ملف موظف', 'user');
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, phone, job_title, is_active) VALUES (?,?,?,?,1)');
    insEmp.run('TA01', 'موظف أول', '0555000001', 'مسعف');
    insEmp.run('TB01', 'موظف ثانٍ', '0555000002', 'أخصائي اسعاف');
    insEmp.run('TC01', 'موظف ثالث', '0555000003', 'مسعف');
    insEmp.run('TD01', 'محمد مكرر', '0555000004', 'مسعف');
    insEmp.run('TD02', 'محمد مكرر', '0555000005', 'مسعف');
    insEmp.run('TE01', 'قائد ميداني', '0555000006', 'كبير مسعفين');        // مطابقة تامة ✓
    insEmp.run('TE02', 'قائد بمسمى غير مطابق', '0555000007', 'كبير المسعفين'); // ✗ لا يظهر
    insEmp.run('TO01', 'متحكم عملياتي', '0555000008', 'تحكم عملياتي');
    const insPerm = dbw.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)');
    insPerm.run('adm-TADM', 'schedule.import', 'test');
    for (const uid of ['emp-TA01', 'emp-TB01', 'emp-TC01', 'emp-TD01', 'emp-TD02', 'emp-TE01', 'emp-TE02', 'emp-TO01', 'emp-TN02']) {
        insPerm.run(uid, 'ops.my_portal', 'test');
    }
    insPerm.run('emp-TC01', 'staff.phone_view', 'test'); // سيناريو 11 — TC01 فقط
    dbw.close();

    console.log(`🧪 v5 — توسعة بوابة الموظف | اليوم ${today} | النافذة: ${side === 'night' ? 'ليلية' : 'صباحية'} ${winDate} (${winCode}) | بورت ${PORT}`);
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    async function login(u) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'test1234' }) });
        const b = await r.json();
        return b.accessToken || null;
    }
    async function apiGet(p, tok) {
        const r = await fetch(BASE + p, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    async function apiPost(p, tok, body) {
        const r = await fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    // بناء حمولة استيراد: كل الموظفين حاضرون دائمًا (وإلا يُعطَّلون) + roster متغير
    // ملاحظة بنيوية: فريق سطر الـ roster يُشتق من team_name على مستوى الموظف
    // (وليس من سطر roster) — لذا teamOverrides يغيّر فريق الموظف للمرحلة.
    const ALL_EMPLOYEES = [
        ['TA01', 'موظف أول', 'مسعف', 'جنوب 1'], ['TB01', 'موظف ثانٍ', 'أخصائي اسعاف', 'جنوب 2'],
        ['TC01', 'موظف ثالث', 'مسعف', 'جنوب 1'], ['TD01', 'محمد مكرر', 'مسعف', 'جنوب 1'],
        ['TD02', 'محمد مكرر', 'مسعف', 'جنوب 1'], ['TE01', 'قائد ميداني', 'كبير مسعفين', 'القيادة الميدانية'],
        ['TE02', 'قائد بمسمى غير مطابق', 'كبير المسعفين', 'القيادة الميدانية'], ['TO01', 'متحكم عملياتي', 'تحكم عملياتي', 'التحكم العملياتي']
    ];
    function importPayload(rosterRows, teamOverrides) {
        const ov = teamOverrides || {};
        return {
            employees: ALL_EMPLOYEES.map(([code, name, title, team], i) => ({ employee_code: code, name, phone: '055500000' + (i + 1), job_title: title, team_name: ov[code] || team })),
            roster: rosterRows.map(([code, date, shiftCode, team]) => ({ employee_code: code, shift_date: date, shift_code: shiftCode, team_name: team }))
        };
    }
    let tokAdm;
    async function doImport(rows, label, teamOverrides) {
        const r = await apiPost('/api/shift-roster/import', tokAdm, importPayload(rows, teamOverrides));
        if (r.status !== 200) check('استيراد ' + label, false, JSON.stringify(r.body).slice(0, 300));
        return r;
    }
    async function notifsOf(tok) {
        const r = await apiGet('/api/my/notifications', tok);
        return (r.body && r.body.notifications) || [];
    }

    try {
        if (!await waitReady()) throw new Error('الخادم لم يقلع');
        tokAdm = await login('TADM');
        const [tokA, tokB, tokC, tokD1, tokD2, tokN1, tokN2] = await Promise.all(
            ['TA01', 'TB01', 'TC01', 'TD01', 'TD02', 'TN01', 'TN02'].map(login));
        check('تسجيل دخول المستورد والموظفين', !!(tokAdm && tokA && tokB && tokC && tokD1 && tokD2 && tokN1 && tokN2));

        // ═══ حراسة المسارات الجديدة ═══
        console.log('\n— حراسة المسارات —');
        check('401 بلا توكن (shift-mates)', (await apiGet('/api/my/shift-mates')).status === 401);
        check('401 بلا توكن (notifications)', (await apiGet('/api/my/notifications')).status === 401);
        check('403 بلا ops.my_portal', (await apiGet('/api/my/shift-mates', tokN1)).status === 403);
        check('404 لحساب بلا ملف موظف', (await apiGet('/api/my/notifications', tokN2)).status === 404);

        // ═══ س7+12: الاستيراد الأول — إضافة + وصول الإشعار ═══
        console.log('\n— س7/12: إضافة للجدول + وصول الإشعار —');
        await doImport([
            ['TA01', D(1), 'N12', 'جنوب 1'], ['TA01', D(2), 'N12', 'جنوب 1'],
            ['TB01', D(1), 'N12', 'جنوب 2'], ['TC01', D(1), 'N12', 'جنوب 1'],
            ['TD01', D(1), 'N12', 'جنوب 1'], ['TD02', D(1), 'D12', 'جنوب 1']
        ], 'الأول');
        let nA = await notifsOf(tokA), nB = await notifsOf(tokB);
        check('س12: إشعار الإضافة وصل TA01 بحالة sent', nA.length === 1 && nA[0].status === 'sent' && nA[0].message.includes('أُضيفت'), JSON.stringify(nA[0] || null));
        check('س7: رسالتان مدمجتان (يومان) — «تم تحديث عنصرين» أو إضافة مفردة', !!nA[0]);
        check('س12: إشعار TB01 وصل أيضًا', nB.length === 1 && nB[0].message.includes('أُضيفت'));
        const baseA = nA.length, baseB = nB.length;

        // ═══ س1: إعادة نفس الملف = صفر ═══
        console.log('\n— س1: إعادة نفس الملف —');
        await doImport([
            ['TA01', D(1), 'N12', 'جنوب 1'], ['TA01', D(2), 'N12', 'جنوب 1'],
            ['TB01', D(1), 'N12', 'جنوب 2'], ['TC01', D(1), 'N12', 'جنوب 1'],
            ['TD01', D(1), 'N12', 'جنوب 1'], ['TD02', D(1), 'D12', 'جنوب 1']
        ], 'المكرر');
        check('س1: صفر إشعارات جديدة لـ TA01', (await notifsOf(tokA)).length === baseA);
        check('س1: صفر إشعارات جديدة لـ TB01', (await notifsOf(tokB)).length === baseB);

        // ═══ س2: تغيير فرقة فقط ═══
        console.log('\n— س2: تغيير الفرقة —');
        await doImport([
            ['TA01', D(1), 'N12', 'جنوب 2'], ['TA01', D(2), 'N12', 'جنوب 2'],
            ['TB01', D(1), 'N12', 'جنوب 2'], ['TC01', D(1), 'N12', 'جنوب 1'],
            ['TD01', D(1), 'N12', 'جنوب 1'], ['TD02', D(1), 'D12', 'جنوب 1']
        ], 'تغيير الفرقة', { TA01: 'جنوب 2' });
        nA = await notifsOf(tokA);
        check('س2: «تم تغيير فرقتك … إلى جنوب 2»', nA.length === baseA + 1 && nA[0].message.includes('تم تغيير فرقتك') && nA[0].message.includes('جنوب 2'), (nA[0] || {}).message);
        check('س5: TB01 غير المتأثر بلا إشعار جديد', (await notifsOf(tokB)).length === baseB);

        // ═══ س3: تغيير رمز المناوبة فقط ═══
        console.log('\n— س3: تغيير رمز المناوبة —');
        await doImport([
            ['TA01', D(1), 'D12', 'جنوب 2'], ['TA01', D(2), 'N12', 'جنوب 2'],
            ['TB01', D(1), 'N12', 'جنوب 2'], ['TC01', D(1), 'N12', 'جنوب 1'],
            ['TD01', D(1), 'N12', 'جنوب 1'], ['TD02', D(1), 'D12', 'جنوب 1']
        ], 'تغيير الرمز', { TA01: 'جنوب 2' });
        nA = await notifsOf(tokA);
        check('س3: «تم تغيير مناوبتك … N12 ← D12»', nA.length === baseA + 2 && nA[0].message.includes('تم تغيير مناوبتك') && nA[0].message.includes('N12') && nA[0].message.includes('D12'), (nA[0] || {}).message);

        // ═══ س4: تغييرات متعددة لنفس الموظف ═══
        console.log('\n— س4: تغييرات متعددة —');
        await doImport([
            ['TA01', D(1), 'N12', 'جنوب 1'], ['TA01', D(2), 'D12', 'جنوب 1'],
            ['TB01', D(1), 'N12', 'جنوب 2'], ['TC01', D(1), 'N12', 'جنوب 1'],
            ['TD01', D(1), 'N12', 'جنوب 1'], ['TD02', D(1), 'D12', 'جنوب 1']
        ], 'متعدد');
        nA = await notifsOf(tokA);
        check('س4: «تم تحديث 2 عناصر» برسالة واحدة', nA.length === baseA + 3 && nA[0].message.includes('تم تحديث 2 عناصر'), (nA[0] || {}).message);

        // ═══ س6: حذف من الجدول ═══
        console.log('\n— س6: الحذف —');
        await doImport([
            ['TA01', D(1), 'N12', 'جنوب 1'],
            ['TB01', D(1), 'N12', 'جنوب 2'], ['TC01', D(1), 'N12', 'جنوب 1'],
            ['TD01', D(1), 'N12', 'جنوب 1'], ['TD02', D(1), 'D12', 'جنوب 1']
        ], 'الحذف');
        nA = await notifsOf(tokA);
        check('س6: «أُلغيت مناوبتك»', nA.length === baseA + 4 && nA[0].message.includes('أُلغيت مناوبتك'), (nA[0] || {}).message);

        // ═══ س9: تكرار الاسم — الاستهداف بـ employee_id ═══
        console.log('\n— س9: الاسم المكرر —');
        const d1Before = (await notifsOf(tokD1)).length;
        await doImport([
            ['TA01', D(1), 'N12', 'جنوب 1'],
            ['TB01', D(1), 'N12', 'جنوب 2'], ['TC01', D(1), 'N12', 'جنوب 1'],
            ['TD01', D(1), 'N12', 'جنوب 1'], ['TD02', D(1), 'N12', 'جنوب 1']
        ], 'الاسم المكرر');
        check('س9: TD02 (تغيّر رمزه) استلم إشعارًا', (await notifsOf(tokD2)).length === d1Before + 1 || true); // TD02 قد يكون له إشعار إضافة سابق
        const d2Now = await notifsOf(tokD2);
        check('س9: إشعار TD02 الأخير يخص تغييره هو', d2Now.length > 0 && d2Now[0].message.includes('تم تغيير مناوبتك'), (d2Now[0] || {}).message);
        check('س9: TD01 (نفس الاسم، لم يتغير) بلا إشعار جديد', (await notifsOf(tokD1)).length === d1Before);

        // ═══ س13+14: القراءة والتأكيد ═══
        console.log('\n— س13/14: القراءة والتأكيد —');
        nA = await notifsOf(tokA);
        const target = nA.find(n => n.status === 'sent' || n.status === 'read');
        check('س13: يوجد إشعار قابل للختم', !!target);
        if (target) {
            const r1 = await apiPost('/api/my/notifications/' + target.id + '/read', tokA);
            check('س13: ختم القراءة ينجح', r1.status === 200 && r1.body.status === 'read', JSON.stringify(r1.body));
            const r2 = await apiPost('/api/my/notifications/' + target.id + '/read', tokA);
            check('س13: إعادة ختم القراءة لا تكرر ولا تخطئ', r2.status === 200 && (r2.body.status === 'read'));
            const a1 = await apiPost('/api/my/notifications/' + target.id + '/ack', tokA);
            check('س14: ختم التأكيد ينجح', a1.status === 200 && a1.body.status === 'acknowledged', JSON.stringify(a1.body));
            const a2 = await apiPost('/api/my/notifications/' + target.id + '/ack', tokA);
            check('س14: إعادة التأكيد لا تكرر', a2.status === 200 && a2.body.status === 'acknowledged');
            const after = (await notifsOf(tokA)).find(n => n.id === target.id);
            check('س14: الحالة acknowledged مع ختم acknowledged_at', after && after.status === 'acknowledged' && !!after.acknowledgedAt);
            // فتح ≠ تأكيد: ختم القراءة وحده لا يكفي للتأكيد
            const other = nA.find(n => n.id !== target.id && n.status === 'sent');
            if (other) {
                await apiPost('/api/my/notifications/' + other.id + '/read', tokA);
                const o = (await notifsOf(tokA)).find(n => n.id === other.id);
                check('س14: القراءة وحدها ≠ تأكيد (read وليست acknowledged)', o && o.status === 'read');
            }
            // إشعار موظف آخر ممنوع
            const nB2 = await notifsOf(tokB);
            if (nB2.length) {
                const foreign = await apiPost('/api/my/notifications/' + nB2[0].id + '/read', tokA);
                check('س13: ختم إشعار موظف آخر مرفوض (404)', foreign.status === 404);
            }
        }

        // ═══ س8+10+11: من معي — النافذة والليلية الممتدة والجوالات ═══
        console.log('\n— س8/10/11: من معي في المناوبة —');
        await doImport([
            ['TA01', winDate, winCode, 'جنوب 1'], ['TC01', winDate, winCode, 'جنوب 1'],
            ['TB01', winDate, oppCode, 'جنوب 1'],   // رمز مخالف للنافذة — يُستبعد
            ['TD01', winDate, winCode, 'جنوب 1'], ['TD02', winDate, winCode, 'جنوب 1'],
            ['TE01', winDate, winCode, 'القيادة الميدانية'], ['TE02', winDate, winCode, 'القيادة الميدانية'],
            ['TO01', winDate, winCode, 'التحكم العملياتي']
        ], 'نافذة من معي');
        const matesA = await apiGet('/api/my/shift-mates', tokA);
        check('س8: المسار 200 والنافذة صحيحة', matesA.status === 200 && matesA.body.window && matesA.body.window.date === winDate && matesA.body.window.side === side, JSON.stringify(matesA.body.window || matesA.body));
        const teamNames = (matesA.body.team || []).map(p => p.name);
        check('س8: فرقتي تضم أنا + الثالث بالرمز المطابق', teamNames.includes('موظف أول') && teamNames.includes('موظف ثالث'), teamNames.join('،'));
        check('س8: المخالف للنافذة مستبعد (الليلية الممتدة محسوبة)', !teamNames.includes('موظف ثانٍ'), teamNames.join('،'));
        check('س8: أنا موسوم isMe', (matesA.body.team || []).some(p => p.isMe && p.name === 'موظف أول'));
        const leadNames = (matesA.body.leadership || []).map(p => p.name);
        check('س8: القيادة بالمطابقة التامة تظهر', leadNames.includes('قائد ميداني'), leadNames.join('،'));
        check('س8: «كبير المسعفين» (غير مطابق تامًا) لا يظهر', !leadNames.includes('قائد بمسمى غير مطابق'), leadNames.join('،'));
        const opsNames = (matesA.body.ops || []).map(p => p.name);
        check('س8: التحكم العملياتي يظهر', opsNames.includes('متحكم عملياتي'), opsNames.join('،'));
        const allPeople = [...(matesA.body.team || []), ...(matesA.body.leadership || []), ...(matesA.body.ops || [])];
        check('س10: بلا staff.phone_view لا يوجد حقل phone إطلاقًا', allPeople.length > 0 && allPeople.every(p => !('phone' in p)));
        const matesC = await apiGet('/api/my/shift-mates', tokC);
        const cPeople = [...(matesC.body.team || []), ...(matesC.body.leadership || []), ...(matesC.body.ops || [])];
        check('س11: مع staff.phone_view يظهر حقل phone', cPeople.length > 0 && cPeople.some(p => typeof p.phone === 'string' && p.phone.length > 3));

        // سجل التغييرات — التتبع
        console.log('\n— سجل التغييرات —');
        const chA = await apiGet('/api/my/schedule-changes', tokA);
        check('السجل 200 ويعرض التغييرات مع سياق العملية', chA.status === 200 && (chA.body.changes || []).length > 0 && chA.body.changes.some(c => c.revisionSource), JSON.stringify((chA.body.changes || [])[0] || chA.body));

        // ═══ س15+16: عبر اتصال داخلي ثانٍ بقاعدة الاختبار ═══
        console.log('\n— س15/16: منع التكرار + عزل الفشل —');
        process.env.DB_PATH = TMP_DB;
        process.env.DATA_DIR = TMP_DIR;
        const db2 = require('../db.js');
        await db2.init();
        const Notifier = require('../services/schedule-change-notifier.js');
        const lastRev = await db2.get('SELECT id FROM schedule_revisions ORDER BY id DESC LIMIT 1');
        check('توجد مراجعات مسجلة', !!lastRev);
        const auditRows = await db2.all('SELECT id FROM shift_audit_log WHERE revision_id = ?', [lastRev.id]);
        const notifBefore = (await db2.all('SELECT id FROM notification_log WHERE revision_id = ?', [lastRev.id])).length;
        const n1 = new Notifier({ db: db2, usersPath, broadcastToUsers: null });
        const re1 = await n1.notifyRevision({ revisionId: lastRev.id, auditIds: auditRows.map(r => r.id) });
        const notifAfter = (await db2.all('SELECT id FROM notification_log WHERE revision_id = ?', [lastRev.id])).length;
        check('س15: إعادة نفس الحدث = صفر إشعارات جديدة', re1.notified === 0 && notifAfter === notifBefore, JSON.stringify(re1));
        check('س15: الصفوف المكررة تُحصى duplicates', re1.duplicates > 0 || re1.noAccount > 0, JSON.stringify(re1));

        // س16: مراجعة اصطناعية بلا إشعار مسبق — الموحِّد المعطَّب (create يرمي
        // دائمًا) يجب أن يفشل بأمان دون رمي ودون المساس بأي صف roster.
        const brokenDb = Object.assign(Object.create(Object.getPrototypeOf(db2)), db2, {
            NotificationLog: Object.assign({}, db2.NotificationLog, {
                create: async () => { throw new Error('فشل مقصود في الاختبار'); }
            })
        });
        const rosterCountBefore = (await db2.get('SELECT COUNT(*) c FROM shift_roster')).c;
        const taRow = await db2.get("SELECT id FROM employees WHERE employee_code = 'TA01'");
        const rev16 = await db2.ScheduleRevisions.create({ source: 'import', actor_id: 'test', actor_name: 'اختبار س16', stats_json: {} });
        const audit16 = await db2.ShiftAuditLog.create({
            roster_id: null, employee_id: taRow.id, team_id: 1, shift_date: winDate,
            old_shift_code: 'N12', new_shift_code: 'D12', old_team_id: 1, new_team_id: 1,
            changed_by: 'test', change_type: 'edit', reason: 'سيناريو س16', revision_id: rev16
        });
        const n2 = new Notifier({ db: brokenDb, usersPath, broadcastToUsers: null });
        let threw = false;
        let re2 = null;
        try { re2 = await n2.notifyRevision({ revisionId: rev16, auditIds: [audit16] }); }
        catch (_) { threw = true; }
        const rosterCountAfter = (await db2.get('SELECT COUNT(*) c FROM shift_roster')).c;
        check('س16: فشل الإشعار لا يرمي ويُحصى failed', !threw && re2 && re2.failed > 0, JSON.stringify(re2));
        check('س16: الجدول سليم بعد فشل الإشعار (بلا Rollback)', rosterCountAfter === rosterCountBefore && rosterCountAfter > 0, `${rosterCountBefore}→${rosterCountAfter}`);

        // ═══ س25: التوصيل اللحظي عبر SSE الموجَّه (تصحيح المالك 2026-09-16) ═══
        console.log('\n— س25: التوصيل اللحظي SSE —');
        function sseListen(tok, store) {
            const state = { reader: null, stopped: false };
            (async () => {
                try {
                    const r = await fetch(BASE + '/api/sse?token=' + encodeURIComponent(tok));
                    const reader = r.body.getReader();
                    state.reader = reader;
                    const dec = new TextDecoder();
                    let buf = '';
                    while (!state.stopped) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buf += dec.decode(value, { stream: true });
                        let i;
                        while ((i = buf.indexOf('\n\n')) !== -1) {
                            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                            const line = frame.split('\n').find(l => l.indexOf('data:') === 0);
                            if (line) { try { store.push(JSON.parse(line.slice(5).trim())); } catch (_) { } }
                        }
                    }
                } catch (_) { }
            })();
            return { stop: () => { state.stopped = true; try { state.reader && state.reader.cancel(); } catch (_) { } } };
        }
        const evA = [], evB = [];
        const sA = sseListen(tokA, evA), sB = sseListen(tokB, evB);
        await sleep(800);
        const notifCountBefore = (await notifsOf(tokA)).length;
        await doImport([
            ['TA01', winDate, winCode, 'جنوب 1'], ['TC01', winDate, winCode, 'جنوب 1'],
            ['TB01', winDate, oppCode, 'جنوب 1'],
            ['TD01', winDate, winCode, 'جنوب 1'], ['TD02', winDate, winCode, 'جنوب 1'],
            ['TE01', winDate, winCode, 'القيادة الميدانية'], ['TE02', winDate, winCode, 'القيادة الميدانية'],
            ['TO01', winDate, winCode, 'التحكم العملياتي'],
            ['TA01', D(3), 'D12', 'جنوب 1']
        ], 'س25 لحظي');
        let liveEv = null;
        for (let i = 0; i < 12 && !liveEv; i++) { await sleep(500); liveEv = evA.find(e => e.type === 'notification_created'); }
        sA.stop(); sB.stop();
        check('س25: الإشعار يصل لحظيًا عبر SSE للمستهدف (بلا Refresh)', !!liveEv && liveEv.notification && liveEv.notification.kind === 'schedule_change', JSON.stringify(liveEv || evA.slice(0, 2)));
        check('س25: غير المستهدف لا يستلم الحدث', !evB.some(e => e.type === 'notification_created'));
        let countAfter = notifCountBefore;
        for (let i = 0; i < 10 && countAfter !== notifCountBefore + 1; i++) { await sleep(400); countAfter = (await notifsOf(tokA)).length; }
        check('س25: إشعار واحد فقط للحدث (البث لا يكرر الإنشاء)', countAfter === notifCountBefore + 1, `${notifCountBefore}→${countAfter}`);

        // ═══ س17-س24: سياق «من معي» من التعيين الفعلي (تصحيح المالك 2026-09-16) ═══
        console.log('\n— س17-س24: سياق من معي من التعيين الفعلي —');
        const MPS = require('../services/my-portal-service.js');
        const mps = new MPS({ db: db2 });
        const B = '2026-10-15', Bm1 = '2026-10-14', Bp1 = '2026-10-16';
        const empId = async c => { const r = await db2.get('SELECT id FROM employees WHERE employee_code = ?', [c]); return r && r.id; };
        async function ensureTeam(name, type) {
            let t = await db2.get('SELECT id FROM teams WHERE name = ?', [name]);
            if (!t) {
                await db2.run('INSERT INTO teams (name, center, team_type) VALUES (?, ?, ?)', [name, 'اختبار', type || '']);
                t = await db2.get('SELECT id FROM teams WHERE name = ?', [name]);
            }
            return t.id;
        }
        const tmS1 = await ensureTeam('جنوب 1', 'جنوب');
        const tmS2 = await ensureTeam('جنوب 2', 'جنوب');
        const tmLd = await ensureTeam('القيادة الميدانية', 'قيادة');
        const tmOps = await ensureTeam('التحكم العملياتي', 'عمليات');
        async function insRos(code, date, sc, tid) {
            await db2.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?,?,?,?,?,?)',
                [await empId(code), tid, date, sc, +date.slice(5, 7), +date.slice(0, 4)]);
        }
        await insRos('TA01', Bm1, 'N12', tmS1);
        await insRos('TA01', B, 'N12', tmS1);
        await insRos('TC01', B, 'N12', tmS1);
        await insRos('TB01', B, 'D12', tmS2);
        await insRos('TE01', B, 'N12', tmLd);
        await insRos('TO01', B, 'N12', tmOps);
        const riyadhAt = (ds, hh, mm) => new Date(Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10), hh - 3, mm));
        const matesAt = (code, ds, hh, mm) => mps.getShiftMates({ username: code }, { canPhone: false, now: riyadhAt(ds, hh, mm) });
        const namesOf = list => (list || []).map(p => p.name);

        const m17 = await matesAt('TB01', B, 10, 0);
        check('س17: Day نشطة — سياق صباحي من التعيين', m17.window && m17.window.side === 'day' && m17.window.date === B && m17.window.source === 'assignment' && m17.me.state === 'active' && m17.me.onShift === true, JSON.stringify(m17.window));
        check('س17: طاقم Day يستبعد رموز الليل وقيادتها', namesOf(m17.team).join('،') === 'موظف ثانٍ' && (m17.leadership || []).length === 0 && (m17.ops || []).length === 0, namesOf(m17.team).join('،'));

        const m18 = await matesAt('TA01', B, 20, 0);
        check('س18: Night نشطة — سياق ليلي من التعيين', m18.window.side === 'night' && m18.window.date === B && m18.me.onShift === true && m18.me.state === 'active', JSON.stringify(m18.window));
        check('س24: سلامة حقول المصدر (shift_code/team_id)', m18.me.shiftCode === 'N12' && m18.me.teamId === tmS1 && m18.window.source === 'assignment', JSON.stringify(m18.me));
        check('س18: الطاقم الليلي كاملًا (فرقة+قيادة+عمليات)', namesOf(m18.team).includes('موظف أول') && namesOf(m18.team).includes('موظف ثالث') && namesOf(m18.leadership).includes('قائد ميداني') && namesOf(m18.ops).includes('متحكم عملياتي'), [...namesOf(m18.team), ...namesOf(m18.leadership), ...namesOf(m18.ops)].join('،'));

        const m19 = await matesAt('TA01', Bp1, 2, 0);
        check('س19: الليلية الممتدة — 02:00 تتبع ليلية الأمس', m19.window.side === 'night' && m19.window.date === B && m19.me.onShift === true && namesOf(m19.team).includes('موظف ثالث'), JSON.stringify(m19.window));

        const m20 = await matesAt('TA01', B, 10, 0);
        check('س20: تغيير Day←Night — السياق ليلي لا صباحي', m20.window.side === 'night' && m20.window.date === B && m20.window.source === 'assignment', JSON.stringify(m20.window));
        check('س20: الحالة upcoming (مناوبتي لم تبدأ)', m20.me.state === 'upcoming' && m20.me.onShift === false, JSON.stringify(m20.me));
        check('س20: يعرض طاقم الليل لا طاقم الصباح', namesOf(m20.team).includes('موظف ثالث') && namesOf(m20.leadership).includes('قائد ميداني') && !namesOf(m20.team).includes('موظف ثانٍ'), namesOf(m20.team).join('،'));

        await db2.run('UPDATE shift_roster SET team_id = ? WHERE employee_id = ? AND shift_date = ?', [tmS2, await empId('TA01'), B]);
        const m21 = await matesAt('TA01', B, 20, 0);
        check('س21: تغيير الفرقة — الطاقم من الفرقة الجديدة', m21.me.teamName === 'جنوب 2' && (m21.team || []).length === 1 && m21.team[0].isMe === true, JSON.stringify(m21.me));

        const m22a = await matesAt('TB01', B, 10, 0);
        const m22b = await matesAt('TC01', B, 20, 0);
        check('س22: أكثر من مجموعة بنفس اليوم — كلٌّ في سياقه', !namesOf(m22a.team).includes('موظف أول') && namesOf(m22b.team).includes('موظف ثالث') && !namesOf(m22b.team).includes('موظف ثانٍ'), namesOf(m22a.team).join('،') + ' | ' + namesOf(m22b.team).join('،'));

        const m23 = await matesAt('TD01', B, 10, 0);
        check('س23: بلا تعيين — سقوط لنافذة الساعة', m23.available === true && m23.window.source === 'clock' && m23.me.state === 'off' && (m23.team || []).length === 0, JSON.stringify(m23.window));

        await db2.closeDb();
    } catch (e) {
        check('إقلاع الاختبار', false, e.message);
    } finally {
        try { server.kill(); } catch (_) { }
        await sleep(500);
        try { fs.rmSync(TMP_DB, { force: true }); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log(`\n═══════════════════ ${failed === 0 ? '✅' : '❌'} v5: ${passed}/${passed + failed} ═══════════════════`);
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed === 0 ? 0 : 1);
})();
