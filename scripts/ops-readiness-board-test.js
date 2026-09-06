/**
 * ═══ اختبار لوحة استعداد الفرق الإسعافية v4.3 (اعتماد مبدئي 2026-09-06) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3132 — لا تمس بيانات الإنتاج.
 * يغطي: الفرقة بلا جلسة ← «لم تُسجّل» (أهم نقطة) · خريطة 🟢/🟡/🔴 من الجلسة كما هي
 * (بلا استنتاج) · استبعاد فرق العمليات · الملخص يطابق الصفوف · الحراسة 401/403
 * · عدم انحدار مساري الجاهزية القائمين. مستوى API — لا UI.
 *
 * التشغيل: node scripts/ops-readiness-board-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'rdb-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'rdb-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3132;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9486;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_PROFILE = path.join(os.tmpdir(), 'rdb-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'readiness-board-' + STAMP);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
function riyadhTodayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── نسخة معزولة ──
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    const today = riyadhTodayStr();
    const cm = today.slice(0, 7);
    const NOW = '2026-09-06 01:00:00';
    const TEAM_G = 1, TEAM_Y = 20, TEAM_R = 21, TEAM_N = 22, TEAM_OPS = 25;

    // مستخدمان: قارئ عمليات (ops.completion) + مستخدم بوابة فقط (ops.my_portal)
    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-B001', username: 'B001', name: 'قارئ عمليات board', password: hash, role: 'user', isActive: true },
        { id: 'emp-B002', username: 'B002', name: 'بوابة فقط board', password: hash, role: 'user', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
    const eB001 = insEmp.run('B001', 'قارئ عمليات board', 'تحكم عملياتي').lastInsertRowid;
    const eB002 = insEmp.run('B002', 'بوابة فقط board', 'فني اسعاف').lastInsertRowid;
    const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
    insPerm.run('emp-B001', 'ops.completion');
    insPerm.run('emp-B002', 'ops.my_portal');

    // roster اليوم: 4 فرق ميدانية + فرقة عمليات (يجب استبعادها)
    const delR = dbw.prepare('DELETE FROM shift_roster WHERE shift_date = ? AND team_id IN (?, ?, ?, ?, ?)')
        .run(today, TEAM_G, TEAM_Y, TEAM_R, TEAM_N, TEAM_OPS);
    console.log('  🧹 حُذف ' + delR.changes + ' صف roster حقيقي لليوم داخل النسخة المعزولة');
    const insRoster = dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
    insRoster.run(eB002, TEAM_G, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eB002, TEAM_Y, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eB002, TEAM_R, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eB002, TEAM_N, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eB001, TEAM_OPS, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);

    // جلسات اليوم: خضراء مكتملة / صفراء قيد التنفيذ / حمراء مكتملة — والرابعة بلا جلسة إطلاقًا
    const insSes = dbw.prepare(
        `INSERT INTO shift_check_sessions (shift_date, team_id, team_name, vehicle_id, vehicle_name, center, status, created_by, completed_at, schema_version, readiness, readiness_reason, check_mode, readiness_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'test', ?, 2, ?, ?, ?, ?)`);
    insSes.run(today, TEAM_G, 'جنوب 1', 'veh_BG', 'اخت-2001', 'المنصورة', 'completed', NOW, 'green', 'لا ملاحظات مؤثرة ولا نواقص حرجة', 'full', NOW);
    insSes.run(today, TEAM_Y, 'سريع 1', 'veh_BY', 'اخت-2002', 'الدار البيضاء', 'open', null, 'yellow', 'نقص غير حرج', 'partial', NOW);
    insSes.run(today, TEAM_R, 'سريع 2', 'veh_BR', 'اخت-2003', 'الشفاء', 'completed', NOW, 'red', 'الأنوار الأمامية تالفة', 'full', NOW);
    // TEAM_N (سريع 3): لا جلسة — أهم حالة في الاختبار
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — لوحة استعداد الفرق v4.3 | اليوم: ' + today);
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    async function login(u, p) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        const b = await r.json();
        return b.accessToken || null;
    }
    async function apiGet(p, tok) {
        const r = await fetch(BASE + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
        let body = null;
        try { body = await r.json(); } catch (_) { }
        return { status: r.status, body };
    }

    try {
        check('1) إقلاع الخادم المعزول', await waitReady());

        const tokOps = await login('B001', 'test1234');
        const tokPortal = await login('B002', 'test1234');
        check('2) دخول قارئ العمليات ومستخدم البوابة', !!tokOps && !!tokPortal);

        const board = await apiGet('/api/ops/readiness/teams', tokOps);
        check('3) GET /api/ops/readiness/teams ← 200 + تاريخ اليوم', board.status === 200 && board.body && board.body.today === today,
            JSON.stringify(board.body).slice(0, 200));

        const rows = (board.body && board.body.rows) || [];
        const teamIds = rows.map(r => r.teamId);
        check('4) اللوحة تشمل فرق الاختبار الأربع وتستبعد فرقة العمليات 25 (وتشمل فرق اليوم الحقيقية الأخرى)',
            teamIds.includes(TEAM_G) && teamIds.includes(TEAM_Y) && teamIds.includes(TEAM_R) && teamIds.includes(TEAM_N)
            && !teamIds.includes(TEAM_OPS),
            JSON.stringify(teamIds));

        const noSession = rows.find(r => r.teamId === TEAM_N);
        check('5) فرقة بلا جلسة ← readiness=null + checkState=«لم يبدأ» + sessionId=null',
            !!noSession && noSession.readiness === null && noSession.checkState === 'لم يبدأ' && noSession.sessionId === null,
            JSON.stringify(noSession));

        const green = rows.find(r => r.teamId === TEAM_G);
        check('6) الجلسة الخضراء المكتملة ← جاهزة + «مكتمل» + المركبة والمركز من الجلسة',
            !!green && green.readiness === 'green' && green.checkState === 'مكتمل' && green.vehicleName === 'اخت-2001' && green.center === 'المنصورة',
            JSON.stringify(green));

        const yellow = rows.find(r => r.teamId === TEAM_Y);
        check('7) الجلسة الصفراء المفتوحة ← جزئية + «قيد التنفيذ» (لا استنتاج اكتمال)',
            !!yellow && yellow.readiness === 'yellow' && yellow.checkState === 'قيد التنفيذ',
            JSON.stringify(yellow));

        const red = rows.find(r => r.teamId === TEAM_R);
        check('8) الجلسة الحمراء ← غير جاهزة + السبب محفوظ حرفيًا',
            !!red && red.readiness === 'red' && red.readinessReason === 'الأنوار الأمامية تالفة' && !!red.lastUpdate,
            JSON.stringify(red));

        const sum = board.body && board.body.summary;
        const recount = { green: 0, yellow: 0, red: 0, unrecorded: 0 };
        rows.forEach(r => recount[r.readiness || 'unrecorded']++);
        check('9) الملخص يطابق عدّ الصفوف فعليًا + فئات الاختبار الأربع محسوبة',
            !!sum && JSON.stringify(sum) === JSON.stringify(recount)
            && sum.green >= 1 && sum.yellow >= 1 && sum.red >= 1 && sum.unrecorded >= 1,
            JSON.stringify(sum));

        // الترتيب المعتمد: جنوب رقميًا (2 قبل 10 — لا أبجديًا) ثم سريع ثم دعم
        const order = rows.map(r => r.teamName);
        const pos = n => order.indexOf(n);
        check('9ب) الترتيب: جنوب رقميًا (جنوب 2 قبل جنوب 10) ثم التدخل السريع ثم الدعم',
            pos('جنوب 1') !== -1 && pos('جنوب 1') < pos('جنوب 2') && pos('جنوب 2') < pos('جنوب 10')
            && pos('جنوب 10') < pos('سريع 1') && pos('سريع 1') < pos('سريع 2')
            && (pos('الدعم اللوجستي') === -1 || pos('سريع 3') < pos('الدعم اللوجستي')),
            order.join(' · '));

        check('10) مستخدم بوابة فقط (ops.my_portal) ← 403', (await apiGet('/api/ops/readiness/teams', tokPortal)).status === 403);
        check('11) بلا توكن ← 401', (await apiGet('/api/ops/readiness/teams', null)).status === 401);

        // انحدار: مسارا v4.2 القائمان لا يتغيران
        const todayRes = await apiGet('/api/ops/readiness/today', tokOps);
        check('12) انحدار: /api/ops/readiness/today ← 200 بجلساته الثلاث كما كان',
            todayRes.status === 200 && todayRes.body && Array.isArray(todayRes.body.sessions) && todayRes.body.sessions.length === 3,
            JSON.stringify(todayRes.body).slice(0, 150));
        const greenSes = rows.find(r => r.teamId === TEAM_G);
        const detail = await apiGet('/api/ops/readiness/session/' + (greenSes && greenSes.sessionId), tokOps);
        check('13) انحدار: /api/ops/readiness/session/:id ← 200', detail.status === 200 && detail.body && detail.body.success === true);

        // ── v4.3.1: فحوص سكونية للواجهة والتنقّل ──
        const rcHtml = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
        const boardJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'readiness-board.js'), 'utf8');
        const boardHtml = fs.readFileSync(path.join(ROOT, 'public', 'readiness-board.html'), 'utf8');
        check('14) التكميل يركّب البطاقة المختصرة + صفحة التفاصيل موجودة بوضع full ورابط رجوع للتكميل',
            rcHtml.includes('id="readinessBoard"') && rcHtml.includes('/js/readiness-board.js')
            && boardHtml.includes('data-mode="full"') && boardHtml.includes('/radio-completion.html')
            && boardHtml.includes('استعداد الفرق الإسعافية'));
        check('15) لا تبويب جديد ولا كتابة: صِفر _blank في لوحة الاستعداد + fetch وحيد GET بلا POST',
            !boardJs.includes('_blank')
            && (boardJs.match(/fetch\(/g) || []).length === 1 && !boardJs.includes("method: 'POST'") && !boardJs.includes('method:"POST"'));

        // ── v4.3.1: لقطات الواجهة — صفحة التفاصيل + بطاقة التكميل + تنقّل نفس التبويب ──
        const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=1100,900', '--no-first-run', '--disable-gpu',
            '--user-data-dir=' + CHROME_PROFILE, 'about:blank'], { stdio: 'ignore' });
        try {
            let targets = null;
            for (let i = 0; i < 30; i++) { await sleep(500); try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json'); targets = await r.json(); break; } catch (_) { } }
            if (!targets) throw new Error('CDP غير متاح');
            const page = targets.find(t => t.type === 'page');
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
            let msgId = 0; const pendingCdp = new Map();
            ws.onmessage = ev => {
                try {
                    const m = JSON.parse(ev.data);
                    if (m.id && pendingCdp.has(m.id)) { const p = pendingCdp.get(m.id); pendingCdp.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
                } catch (_) { }
            };
            const cdp = (method, params = {}) => new Promise((resolve, reject) => {
                const id = ++msgId; pendingCdp.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method, params }));
                setTimeout(() => { if (pendingCdp.has(id)) { pendingCdp.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
            });
            const evalJs = async (expr) => {
                const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
                if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
                return r.result ? r.result.value : undefined;
            };
            const shot = async (name) => {
                const r = await cdp('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
                console.log('  📸 ' + name + '.png');
            };
            await cdp('Page.enable'); await cdp('Runtime.enable');
            await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('auth_access_token','" + tokOps + "');}catch(e){}" });

            // صفحة التفاصيل: جدول + ملخص + زر تحديث يدوي
            await cdp('Page.navigate', { url: BASE + '/readiness-board.html' });
            await sleep(3500);
            const full = await evalJs(`(() => ({
                title: document.body.textContent.includes('استعداد الفرق الإسعافية'),
                rows: document.querySelectorAll('#readinessBoard .rdb-table tbody tr').length,
                chips: document.querySelectorAll('#readinessBoard .rdb-sum').length,
                refreshBtn: !!document.getElementById('rdbRefresh'),
                back: document.body.textContent.includes('رجوع إلى التكميل')
            }))()`);
            check('16) صفحة التفاصيل: العنوان + جدول الفرق + 4 عدّادات + زر تحديث يدوي + رجوع للتكميل',
                full && full.title && full.rows >= 4 && full.chips === 4 && full.refreshBtn && full.back,
                JSON.stringify(full));
            await shot('board-1-details-page');

            // بطاقة التكميل المختصرة: عدّادات فقط — بلا جدول داخل صفحة التكميل
            await cdp('Page.navigate', { url: BASE + '/radio-completion.html' });
            await sleep(5000);
            const card = await evalJs(`(() => ({
                title: document.body.textContent.includes('استعداد الفرق الآن'),
                hint: document.body.textContent.includes('اضغط لعرض التفاصيل'),
                chips: document.querySelectorAll('#readinessBoard .rdb-sum').length,
                noTable: document.querySelectorAll('#readinessBoard .rdb-table').length === 0
            }))()`);
            check('17) بطاقة التكميل: «استعداد الفرق الآن» + عدّادات + تلميح الضغط — بلا جدول داخل الصفحة',
                card && card.title && card.hint && card.chips === 4 && card.noTable,
                JSON.stringify(card));
            await shot('board-2-completion-card');

            // التنقّل: الضغط على البطاقة ← صفحة التفاصيل في نفس التبويب
            await evalJs(`(function(){ const m = document.querySelector('#readinessBoard .rdb-mini'); if (m) m.click(); return true; })()`);
            await sleep(3000);
            const nav = await evalJs('window.location.pathname');
            check('18) الضغط على البطاقة ينقل لصفحة التفاصيل في نفس التبويب (زر الرجوع يعمل)',
                nav === '/readiness-board.html', String(nav));
            await shot('board-3-same-tab-navigation');
            ws.close();
        } finally {
            chrome.kill();
        }
    } catch (e) {
        check('سير الاختبار بلا استثناء', false, e.message);
    }

    console.log('');
    console.log('════════════════ لوحة استعداد الفرق v4.3: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    server.kill();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    try { fs.unlinkSync(TMP_DB); } catch (_) { }
    process.exit(failed ? 1 : 0);
})();
