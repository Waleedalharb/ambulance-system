/**
 * ═══ اختبار بوابة الموظف التشغيلية v2 (اعتماد المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت معزول 3122 + بيانات مصطنعة — لا تمس الإنتاج.
 * ملاحظة مركبات: النسخة المحلية تحمل أحداث تعيين حقيقية مفتوحة؛ يُغلقها الاختبار
 * أولًا (assignment_end لكل تعيين مفتوح) ثم يبني سيناريوهاته بتوقيتات لاحقة ثابتة.
 *
 * الحالات:
 *   1) sections: مسعف ميداني ← incidents/vehicle/inventory=true وcanOpen=false
 *   2) sections: موظف عمليات (team_type='عمليات') ← الثلاثة false
 *   3) sections: بلا تكليف اليوم ← الثلاثة false
 *   4) sections: assets.inventory ← canOpen=true
 *   5) حُرّاس المسارات الجديدة: 401/403
 *   6) vehicle: تعيين مفتوح يظهر، المنتهي بـassignment_end لا يظهر، وفرقة أخرى لا تظهر
 *   7) vehicle: بعد إنهاء التعيين ← vehicles=[] وreason=no_current_vehicle
 *   8) inventory: ملخص الأصول بالحالات + آخر جلسة
 *   9) inventory: فريق عمليات بلا أصول ← hasData=false
 *  10) لا منح تلقائي: assets.inventory في user_permissions للحساب المقصود فقط
 *  11) الهبوط: مسعف بالمنحة ← البوابة · admin بلا منحة ← المنصة · admin+منحة ← البوابة
 *  12) sticky: «بوابة-فقط» يُعاد توجيهه من المنصة · admin+منحة لا يُلزم بعد الدخول
 *  13) الواجهة: بطاقتا مركبتي (بالمركبة الحالية) والجرد + الرابط مخفي (لقطة)
 *  14) الواجهة: بعد إنهاء التعيين ← رسالة «لا توجد مركبة مسندة حاليًا» (لقطة)
 *  15) الواجهة: admin+منحة ← رابط المنصة ظاهر + زر «فتح الجرد» (لقطة)
 *  16) انحدار v1: المسارات الأربعة 200 + Console=صفر في صفحات البوابة
 *
 * التشغيل: node scripts/my-portal-v2-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'myportalv2-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'myportalv2-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'myportalv2-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'my-portal-v2-' + STAMP);
const PORT = 3122;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9482;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
const pad2 = v => String(v).padStart(2, '0');
function riyadhTodayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── 1) نسخة معزولة ──
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    // ── 2) مستخدمون وموظفون مصطنعون ──
    const today = riyadhTodayStr();
    const cm = today.slice(0, 7);
    const TEAM_A = 1, TEAM_A_NAME = 'جنوب 1';        // team_type='جنوب' (ميدانية)
    const TEAM_OPS = 25, TEAM_OPS_NAME = 'التحكم العملياتي'; // team_type='عمليات'
    const NOW = '2026-09-04 02:30:00';

    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-T001', username: 'T001', name: 'مسعف ميداني تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-T010', username: 'T010', name: 'موظف عمليات تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-T011', username: 'T011', name: 'موظف جرد تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-T012', username: 'T012', name: 'موظف قيادة تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-T020', username: 'T020', name: 'بلا تكليف تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-TNOG', username: 'TNOG', name: 'بلا منحة تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'adm-ADM1', username: 'ADM1', name: 'مدير بلا منحة', password: hash, role: 'admin', isActive: true },
        { id: 'adm-ADM2', username: 'ADM2', name: 'مدير بمنحة البوابة', password: hash, role: 'admin', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
    const eT001 = insEmp.run('T001', 'مسعف ميداني تجريبي', 'فني اسعاف').lastInsertRowid;
    const eT010 = insEmp.run('T010', 'موظف عمليات تجريبي', 'تحكم عملياتي').lastInsertRowid;
    const eT011 = insEmp.run('T011', 'موظف جرد تجريبي', 'فني اسعاف').lastInsertRowid;
    const eT012 = insEmp.run('T012', 'موظف قيادة تجريبي', 'كبير مسعفين').lastInsertRowid;
    insEmp.run('T020', 'بلا تكليف تجريبي', 'فني اسعاف');
    const eADM2 = insEmp.run('ADM2', 'مدير بمنحة البوابة', 'مدير').lastInsertRowid;

    const insPerm = dbw.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?,?,1,?)');
    insPerm.run('emp-T001', 'ops.my_portal', 'test');
    insPerm.run('emp-T010', 'ops.my_portal', 'test');
    insPerm.run('emp-T011', 'ops.my_portal', 'test');
    insPerm.run('emp-T011', 'assets.inventory', 'test'); // الحساب المقصود الوحيد بهذه الصلاحية
    insPerm.run('emp-T012', 'ops.my_portal', 'test');
    insPerm.run('emp-T020', 'ops.my_portal', 'test');
    insPerm.run('adm-ADM2', 'ops.my_portal', 'test');

    // roster لليوم: T001/T011/ADM2 ← جنوب 1 (ميدانية) · T010 ← التحكم العملياتي · T020 بلا صف
    const insRoster = dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const id of [eT001, eT011, eADM2]) insRoster.run(id, TEAM_A, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eT010, TEAM_OPS, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eT012, 24, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW); // القيادة الميدانية (team_type='قيادة')

    // ── أحداث مركبات نظيفة: أغلق كل تعيين حقيقي مفتوح أولًا (الإغلاق دلالي — الأقدم أولًا) ──
    const insEv = dbw.prepare(`INSERT INTO operational_events
        (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center, event_type, status, reason, payload, note, actor_id, actor_name, created_at)
        VALUES (NULL, NULL, NULL, 'vehicle', ?, ?, ?, 'المنصورة', ?, NULL, NULL, NULL, NULL, 'test', 'اختبار', ?)`);
    {
        const evs = dbw.prepare("SELECT id, entity_id, event_type FROM operational_events WHERE domain = 'vehicle' ORDER BY created_at ASC, id ASC").all();
        const openByVeh = new Map(); // entity → عدد التعيينات المفتوحة بعد الطي
        for (const e of evs) {
            if (e.event_type === 'assignment') openByVeh.set(e.entity_id, (openByVeh.get(e.entity_id) || 0) + 1);
            else if (e.event_type === 'assignment_end') {
                const n = openByVeh.get(e.entity_id) || 0;
                if (n > 0) openByVeh.set(e.entity_id, n - 1);
            }
        }
        let t = 0;
        for (const [vehId, n] of openByVeh) {
            for (let i = 0; i < n; i++) {
                insEv.run(vehId, 'إنهاء اختباري', null, 'assignment_end', '2026-09-03T23:00:' + pad2(t % 60) + '.000Z');
                t++;
            }
        }
        console.log('  🧹 أُغلق ' + t + ' تعيينًا حقيقيًا مفتوحًا في النسخة المعزولة');
    }
    // سيناريو الاختبار (بتوقيتات لاحقة ثابتة):
    // veh_000001 معيّنة لجنوب 1 (مفتوحة) · veh_000002 كانت لجنوب 1 ثم أُنهيت · veh_000003 لسريع 1
    insEv.run('veh_000001', 'جنوب 1', String(TEAM_A), 'assignment', '2026-09-04T06:00:00.000Z');
    insEv.run('veh_000002', 'جنوب 2', String(TEAM_A), 'assignment', '2026-09-04T06:05:00.000Z');
    insEv.run('veh_000002', 'جنوب 2', String(TEAM_A), 'assignment_end', '2026-09-04T06:06:00.000Z');
    insEv.run('veh_000003', 'جنوب 3', '20', 'assignment', '2026-09-04T06:10:00.000Z');
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — بوابة الموظف v2 | اليوم: ' + today);
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    let chrome = null, ws = null, msgId = 0, injectId = null;
    const pending = new Map();
    const consoleErrors = [];
    function cdp(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
        });
    }
    async function evalJs(expr) {
        const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result ? r.result.value : undefined;
    }
    async function shot(name) {
        const r = await cdp('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
        console.log('  📸 ' + name + '.png');
    }
    async function login(u, p) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        const b = await r.json();
        return b.accessToken || null;
    }
    async function apiGet(path_, tok) {
        const r = await fetch(BASE + path_, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    async function setTokenInjection(tok) {
        if (injectId) { await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectId }); injectId = null; }
        if (tok) {
            const r = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token','${tok}');}catch(e){}` });
            injectId = r.identifier;
        }
    }
    // تسجيل دخول عبر نموذج المنصة الحقيقي (يقود مسار doLogin الفعلي)
    async function formLogin(u, p) {
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3500);
        await evalJs(`localStorage.clear(); 'ok'`); // على صفحة المنصة — localStorage متاح (about:blank يرفض)
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(3500);
        await evalJs(`(() => {
            document.getElementById('loginUsername').value = '${u}';
            document.getElementById('loginPassword').value = '${p}';
            document.getElementById('loginBtn').click();
            return 'clicked';
        })()`);
        await sleep(5000); // login + me/permissions + قرار الهبوط
        return evalJs('location.pathname');
    }

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const tokF = await login('T001', 'test1234');   // ميداني + منحة
        const tokO = await login('T010', 'test1234');   // عمليات + منحة
        const tokI = await login('T011', 'test1234');   // جرد + منحة + assets.inventory
        const tokN = await login('T020', 'test1234');   // بلا تكليف + منحة
        const tokL = await login('T012', 'test1234');   // قيادة + منحة
        const tokG = await login('TNOG', 'test1234');   // بلا منحة
        const tokA1 = await login('ADM1', 'test1234');  // admin بلا منحة
        const tokA2 = await login('ADM2', 'test1234');  // admin + منحة + ملف موظف
        if (!tokF || !tokO || !tokI || !tokN || !tokL || !tokG || !tokA1 || !tokA2) throw new Error('فشل تسجيل دخول حسابات الاختبار');

        // ── 1) sections: ميداني ──
        const secF = await apiGet('/api/my/sections', tokF);
        const sF = secF.body.sections || {};
        check('1) sections ميداني: incidents/vehicle/inventory=true وinventoryCanOpen=false',
            secF.status === 200 && sF.profile === true && sF.schedule === true && sF.assignments === true
            && sF.incidents === true && sF.vehicle === true && sF.inventory === true && sF.inventoryCanOpen === false,
            JSON.stringify(sF));

        // ── 2) sections: عمليات ──
        const secO = await apiGet('/api/my/sections', tokO);
        const sO = secO.body.sections || {};
        check('2) sections عمليات (team_type=عمليات): incidents/vehicle/inventory=false',
            secO.status === 200 && sO.incidents === false && sO.vehicle === false && sO.inventory === false,
            JSON.stringify(sO));

        // ── 2ب) sections: قيادة — ليست ميدانية (قرار المالك: قائمة جنوب/دعم/سريع فقط) ──
        const secL = await apiGet('/api/my/sections', tokL);
        const sL = secL.body.sections || {};
        check('2ب) sections قيادة (team_type=قيادة): incidents/vehicle=false رغم وجود تكليف اليوم',
            secL.status === 200 && sL.incidents === false && sL.vehicle === false,
            JSON.stringify(sL));

        // ── 3) sections: بلا تكليف اليوم ──
        const secN = await apiGet('/api/my/sections', tokN);
        const sN = secN.body.sections || {};
        check('3) sections بلا تكليف: الثلاثة false والأساسيات true',
            secN.status === 200 && sN.profile === true && sN.incidents === false && sN.vehicle === false && sN.inventory === false,
            JSON.stringify(sN));

        // ── 4) sections: صلاحية الجرد ──
        const secI = await apiGet('/api/my/sections', tokI);
        const sI = secI.body.sections || {};
        check('4) sections موظف الجرد: inventory=true وinventoryCanOpen=true',
            secI.status === 200 && sI.inventory === true && sI.inventoryCanOpen === true, JSON.stringify(sI));

        // ── 5) الحُرّاس ──
        const g401 = await apiGet('/api/my/sections', null);
        const g403 = await apiGet('/api/my/sections', tokG);
        const v403 = await apiGet('/api/my/vehicle', tokG);
        const i403 = await apiGet('/api/my/inventory', tokG);
        check('5) الحُرّاس: 401 بلا توكن · 403 بلا ops.my_portal للمسارات الثلاثة',
            g401.status === 401 && g403.status === 403 && v403.status === 403 && i403.status === 403,
            `${g401.status}/${g403.status}/${v403.status}/${i403.status}`);

        // ── 6) vehicle: التعيين المفتوح فقط ──
        const veh1 = await apiGet('/api/my/vehicle', tokF);
        const vIds = (veh1.body.vehicles || []).map(v => v.vehicleId).sort();
        check('6) vehicle: المفتوحة لفرقتي فقط (veh_000001) — المنتهية وفرقة أخرى مستبعدتان',
            veh1.status === 200 && veh1.body.available === true && vIds.length === 1 && vIds[0] === 'veh_000001'
            && veh1.body.team && veh1.body.team.teamName === TEAM_A_NAME && veh1.body.reason === null,
            JSON.stringify({ vIds, reason: veh1.body.reason }));

        // ── 8) inventory: الملخص والجلسة ──
        const inv1 = await apiGet('/api/my/inventory', tokF);
        const a1 = inv1.body.assets || {};
        check('8) inventory: جنوب 1 ← total=17 (سليم 15/مفقود 1/مسترجَع 1) + آخر جلسة approved',
            inv1.status === 200 && inv1.body.hasData === true && a1.total === 17
            && a1.byStatus && a1.byStatus.working === 15 && a1.byStatus.missing === 1 && a1.byStatus.recalled === 1
            && inv1.body.lastSession && inv1.body.lastSession.status === 'approved',
            JSON.stringify({ total: a1.total, byStatus: a1.byStatus, s: inv1.body.lastSession && inv1.body.lastSession.status }));

        // ── 9) inventory: فريق عمليات بلا أصول ──
        const invO = await apiGet('/api/my/inventory', tokO);
        check('9) inventory عمليات: بلا أصول ← total=0 وhasData=false',
            invO.status === 200 && invO.body.assets && invO.body.assets.total === 0 && invO.body.hasData === false,
            JSON.stringify(invO.body.assets));

        // ── 10) لا منح تلقائي ──
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            const holders = dbx.prepare("SELECT user_id FROM user_permissions WHERE permission_key = 'assets.inventory' AND granted = 1").all().map(r => r.user_id);
            dbx.close();
            check('10) assets.inventory: الحساب المقصود (emp-T011) فقط — لا منح تلقائي',
                holders.length === 1 && holders[0] === 'emp-T011', JSON.stringify(holders));
        }

        // ── الواجهة (CDP) ──
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=430,930', '--no-first-run', '--disable-gpu',
            '--user-data-dir=' + CHROME_PROFILE, 'about:blank'], { stdio: 'ignore' });
        let targets = null;
        for (let i = 0; i < 30; i++) { await sleep(500); try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json'); targets = await r.json(); break; } catch (_) { } }
        if (!targets) throw new Error('CDP غير متاح');
        const page = targets.find(t => t.type === 'page');
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = ev => {
            try {
                const m = JSON.parse(ev.data);
                if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
                else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
                else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value).join(' ').slice(0, 200));
            } catch (_) { }
        };
        await cdp('Page.enable'); await cdp('Runtime.enable');

        // ── 11) الهبوط عبر نموذج الدخول الفعلي ──
        const landF = await formLogin('T001', 'test1234');
        const landA1 = await formLogin('ADM1', 'test1234');
        const landA2 = await formLogin('ADM2', 'test1234');
        check('11) الهبوط: مسعف بالمنحة ← بوابة · admin بلا منحة ← منصة · admin+منحة ← بوابة',
            landF === '/my-ems.html' && landA1 !== '/my-ems.html' && landA2 === '/my-ems.html',
            `T001=${landF} ADM1=${landA1} ADM2=${landA2}`);

        // ── 12) sticky: بوابة-فقط يُعاد توجيهه · admin+منحة لا يُلزم ──
        await setTokenInjection(tokF);
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(4500);
        const stickyF = await evalJs('location.pathname');
        await setTokenInjection(tokA2);
        await cdp('Page.navigate', { url: BASE + '/' });
        await sleep(4500);
        const stickyA2 = await evalJs('location.pathname');
        check('12) sticky: «بوابة-فقط» يُعاد للبوابة من المنصة · admin+منحة يبقى في المنصة بعد الدخول',
            stickyF === '/my-ems.html' && stickyA2 !== '/my-ems.html', `T001=${stickyF} ADM2=${stickyA2}`);

        // ── 13) واجهة المسعف: القسمان الجديدان (والمركبة ما زالت معيّنة) + الرابط مخفي ──
        consoleErrors.length = 0; // قياس Console لصفحات البوابة فقط
        await setTokenInjection(tokF);
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4000);
        const uiF = await evalJs(`(() => ({
            cards: document.querySelectorAll('.card').length,
            hasVehicleCard: document.body.textContent.includes('مركبتي'),
            vehItems: [...document.querySelectorAll('.veh-item .v-name')].map(e => e.textContent.trim()),
            hasInvCard: document.body.textContent.includes('الجرد — عهد فرقتي'),
            invChips: [...document.querySelectorAll('.chip')].map(e => e.textContent.trim()).join(' | '),
            openBtn: !!document.querySelector('.inv-open-btn'),
            homeHidden: document.getElementById('homeLink').style.display === 'none'
        }))()`);
        check('13) واجهة المسعف: بطاقتا مركبتي/الجرد + المركبة الحالية ظاهرة + رقائق الحالات + بلا زر فتح + الرابط مخفي',
            uiF.hasVehicleCard && uiF.vehItems.length === 1 && uiF.vehItems[0].includes('جنوب 1')
            && uiF.hasInvCard && !uiF.openBtn && uiF.homeHidden
            && uiF.invChips.includes('سليم') && uiF.invChips.includes('معتمدة'),
            JSON.stringify(uiF));
        await shot('v2-1-medic-sections');

        // ── 7+14) بعد إنهاء التعيين: API فارغ + رسالة صادقة في الواجهة ──
        {
            const dbx = new Database(TMP_DB);
            dbx.prepare(`INSERT INTO operational_events
                (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center, event_type, status, reason, payload, note, actor_id, actor_name, created_at)
                VALUES (NULL, NULL, NULL, 'vehicle', 'veh_000001', 'جنوب 1', '1', 'المنصورة', 'assignment_end', NULL, NULL, NULL, NULL, 'test', 'اختبار', '2026-09-04T08:00:00.000Z')`)
                .run();
            dbx.close();
        }
        const veh2 = await apiGet('/api/my/vehicle', tokF);
        check('7) vehicle: بعد assignment_end ← vehicles=[] وreason=no_current_vehicle (لا مركبة قديمة)',
            veh2.status === 200 && Array.isArray(veh2.body.vehicles) && veh2.body.vehicles.length === 0 && veh2.body.reason === 'no_current_vehicle',
            JSON.stringify({ n: (veh2.body.vehicles || []).length, reason: veh2.body.reason }));

        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4000);
        const uiEnded = await evalJs(`(() => ({
            vehMsg: document.body.textContent.includes('لا توجد مركبة مسندة حاليًا'),
            vehItems: document.querySelectorAll('.veh-item').length
        }))()`);
        check('14) الواجهة بعد الإنهاء: «لا توجد مركبة مسندة حاليًا لفرقتك» وصفر عناصر مركبة',
            uiEnded.vehMsg === true && uiEnded.vehItems === 0, JSON.stringify(uiEnded));
        await shot('v2-2-no-current-vehicle');

        // ── 15) واجهة admin+منحة: رابط المنصة ظاهر + زر فتح الجرد ──
        await setTokenInjection(tokA2);
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4000);
        const uiA2 = await evalJs(`(() => ({
            who: document.getElementById('whoLine') ? document.getElementById('whoLine').textContent : '',
            homeVisible: document.getElementById('homeLink').style.display !== 'none',
            openBtn: !!document.querySelector('.inv-open-btn'),
            openHref: document.querySelector('.inv-open-btn') ? document.querySelector('.inv-open-btn').getAttribute('href') : ''
        }))()`);
        check('15) واجهة admin+منحة: ملفه يظهر + رابط المنصة ظاهر + زر «فتح الجرد» ← /assets-inventory.html',
            uiA2.who.includes('مدير بمنحة البوابة') && uiA2.homeVisible && uiA2.openBtn && uiA2.openHref === '/assets-inventory.html',
            JSON.stringify(uiA2));
        await shot('v2-3-admin-with-grant');

        // ── 16) انحدار v1 + Console ──
        const rp = await apiGet('/api/my/profile', tokF);
        const rs = await apiGet(`/api/my/schedule?month=${+cm.slice(5)}&year=${+cm.slice(0, 4)}`, tokF);
        const ra = await apiGet('/api/my/assignments', tokF);
        const ri = await apiGet('/api/my/team-incidents', tokF);
        check('16) انحدار v1: المسارات الأربعة 200 + Console=صفر في صفحات البوابة',
            rp.status === 200 && rs.status === 200 && ra.status === 200 && ri.status === 200 && consoleErrors.length === 0,
            `${rp.status}/${rs.status}/${ra.status}/${ri.status} console=${consoleErrors.length} ${consoleErrors[0] || ''}`);

        console.log('\n════════════════ نتيجة بوابة الموظف v2: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
        console.log('اللقطات: ' + OUT_DIR);
    } finally {
        try { if (chrome) chrome.kill(); } catch (_) { }
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})();
