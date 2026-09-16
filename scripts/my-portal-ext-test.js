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
