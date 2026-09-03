/**
 * ═══ اختبار بوابة الموظف التشغيلية v1 (اعتماد المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت معزول + بيانات اختبار مصطنعة
 * (موظف T001/T002/T003) — لا تمس بيانات الإنتاج.
 *
 * الحالات:
 *   1) profile: هوية الموظف من التوكن + تكليف اليوم من roster
 *   2) profile: احتياطي is_primary موسوم primary_fallback (بلا صف roster لليوم)
 *   3) 401 بلا توكن · 403 بلا ops.my_portal · 404 لحساب بلا ملف موظف · 422 شهر غير صالح
 *   4) schedule: ترجمة رسمية للرموز + رمز M بلا فرقة ← «مهمة»/«بدون فريق»
 *   5) coverage: يونيو none · الشهر السابق complete · الحالي حسب القاعدة
 *   6) assignments: فترات تنكسر عند الفجوة وعند يوم بلا فرقة
 *   7) team-incidents: الحصر الكامل (يوم تكليف + نفس الفرقة + استبعاد مسحوبة/ملغاة
 *      + إلغاء تكرار المشاركة + استبعاد ما قبل التكليف + سقوط التاريخ لطابع CAD)
 *   8) حدود الأسبوع السبت→الجمعة ومجموع الشهر = مجموع الأيام
 *   9) الواجهة: الأقسام الأربعة + نص التوضيح الثابت + فتح التفصيل + لقطات
 *  10) الواجهة: يونيو ← تنبيه التغطية · حساب بلا موظف ← حالة صادقة (لقطات)
 *  11) انحدار: /api/auth/me وemployee-schedule المحمي بـschedule.view + Console=صفر
 *
 * التشغيل: node scripts/my-portal-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'myportal-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'myportal-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'myportal-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'my-portal-' + STAMP);
const PORT = 3121;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9481;
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

// ── أدوات تاريخ الرياض (مرجع مستقل للتوقعات — لا يستدعي كود الخدمة) ──
const pad2 = v => String(v).padStart(2, '0');
function riyadhTodayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDaysRef(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function monthOf(s, delta) { const d = new Date(s + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + delta); return d.toISOString().slice(0, 7); }
function monthEndRef(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
function weekBoundsRef(today) {
    const wd = new Date(today + 'T00:00:00Z').getUTCDay();
    const start = addDaysRef(today, -((wd + 1) % 7));
    return { start, end: addDaysRef(start, 6) };
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

    // ── 2) مستخدمون وبيانات مصطنعة ──
    const today = riyadhTodayStr();
    const cm = today.slice(0, 7);                 // الشهر الحالي YYYY-MM
    const pm = monthOf(cm + '-01', -1);           // الشهر السابق
    const jm = monthOf(cm + '-01', -3);           // شهر فجوة بلا صفوف (يونيو نسبيًا)
    const cmEnd = monthEndRef(cm), pmEnd = monthEndRef(pm);
    const week = weekBoundsRef(today);
    const TEAM_A = 1, TEAM_B = 20;                // جنوب 1 / سريع 1
    const TEAM_A_NAME = 'جنوب 1', TEAM_B_NAME = 'سريع 1';

    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-T001', username: 'T001', name: 'موظف اختبار البوابة', password: hash, role: 'user', isActive: true },
        { id: 'emp-T002', username: 'T002', name: 'موظف بلا صلاحية', password: hash, role: 'user', isActive: true },
        { id: 'emp-T003', username: 'T003', name: 'حساب بلا ملف موظف', password: hash, role: 'user', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const empId = dbw.prepare("INSERT INTO employees (employee_code, name, job_title, is_active) VALUES ('T001','موظف اختبار البوابة','فني اسعاف',1)").run().lastInsertRowid;
    dbw.prepare("INSERT INTO employees (employee_code, name, job_title, is_active) VALUES ('T002','موظف بلا صلاحية','فني اسعاف',1)").run();
    dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-T001','ops.my_portal',1,'test')").run();
    dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-T003','ops.my_portal',1,'test')").run();

    // roster: الشهر الحالي — A أيام 1..10، فجوة يوم 11، B من 12..النهاية
    // الشهر السابق — A أيام 1..14، يوم 15 رمز M بلا فرقة، A أيام 16..النهاية
    const insRoster = dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
    const rosterMap = new Map(); // date → teamId|null (مرجع التوقعات المستقل)
    const NOW = '2026-09-04 02:30:00';
    for (let d = 1; d <= 10; d++) { const dt = `${cm}-${pad2(d)}`; insRoster.run(empId, TEAM_A, dt, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW); rosterMap.set(dt, TEAM_A); }
    for (let d = 12; d <= +cmEnd.slice(8); d++) { const dt = `${cm}-${pad2(d)}`; insRoster.run(empId, TEAM_B, dt, 'N12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW); rosterMap.set(dt, TEAM_B); }
    for (let d = 1; d <= 14; d++) { const dt = `${pm}-${pad2(d)}`; insRoster.run(empId, TEAM_A, dt, 'D12', +pm.slice(5), +pm.slice(0, 4), NOW, NOW); rosterMap.set(dt, TEAM_A); }
    { const dt = `${pm}-15`; insRoster.run(empId, null, dt, 'M', +pm.slice(5), +pm.slice(0, 4), NOW, NOW); rosterMap.set(dt, null); }
    for (let d = 16; d <= +pmEnd.slice(8); d++) { const dt = `${pm}-${pad2(d)}`; insRoster.run(empId, TEAM_A, dt, 'D12', +pm.slice(5), +pm.slice(0, 4), NOW, NOW); rosterMap.set(dt, TEAM_A); }

    // بلاغات: shift ← report(unit) ← report_times
    const insShift = dbw.prepare('INSERT INTO shifts (shift_name, shift_date, created_at) VALUES (?,?,?)');
    const insReport = dbw.prepare('INSERT INTO reports (center, unit, count, shift_id, created_at) VALUES (?,?,0,?,?)');
    const insRT = dbw.prepare('INSERT INTO report_times (report_id, timestamp, incident_number, withdrawn, manual_cancelled) VALUES (?,?,?,?,?)');
    let incSeq = 0;
    function addIncident(unit, date, opts = {}) {
        const n = opts.number || ('INC-TST-' + (++incSeq));
        let reportId;
        if (opts.noShift) {
            reportId = insReport.run('اختبار', unit, null, NOW).lastInsertRowid;
        } else {
            const sid = insShift.run('مناوبة اختبار', date, NOW).lastInsertRowid;
            reportId = insReport.run('اختبار', unit, sid, NOW).lastInsertRowid;
        }
        const ts = opts.timestamp || `${date}T09:00:00Z`;
        insRT.run(reportId, ts, n, opts.withdrawn ? 1 : 0, opts.manualCancelled ? 1 : 0);
        return n;
    }

    const teamNameOf = id => (id === TEAM_A ? TEAM_A_NAME : TEAM_B_NAME);
    const N1 = addIncident(TEAM_A_NAME, today);                                  // يُحسب
    const N2 = addIncident(TEAM_A_NAME, today);                                  // يُحسب
    addIncident(TEAM_A_NAME, today, { number: N2 });                             // مشاركة مكررة لنفس البلاغ — لا تضاعف العد
    addIncident(TEAM_A_NAME, today, { withdrawn: true });                        // مسحوبة — مستبعدة
    addIncident(TEAM_A_NAME, today, { manualCancelled: true });                  // ملغاة يدويًا — مستبعدة
    addIncident(TEAM_B_NAME, today);                                             // فرقة أخرى نفس اليوم — مستبعدة
    const NF = addIncident(TEAM_A_NAME, today, { noShift: true, timestamp: `${today}T00:30:00+03:00` }); // سقوط التاريخ لطابع CAD بالرياض — يُحسب
    const NS2 = addIncident(TEAM_A_NAME, `${cm}-02`);                            // الشهر (+الأسبوع إن داخل حدوده)
    const wsTeam = rosterMap.get(week.start);
    const NWS = wsTeam ? addIncident(teamNameOf(wsTeam), week.start) : addIncident(TEAM_A_NAME, week.start); // حد السبت
    const wbTeam = rosterMap.get(addDaysRef(week.start, -1));
    addIncident(wbTeam ? teamNameOf(wbTeam) : TEAM_A_NAME, addDaysRef(week.start, -1)); // قبل الأسبوع — مستبعدة منه
    const NB = addIncident(TEAM_B_NAME, `${cm}-20`);                             // داخل فترة B — تُحسب للشهر وتفصيل B
    addIncident(TEAM_A_NAME, `${jm}-15`);                                        // قبل أي تكليف — مستبعدة
    addIncident('وحدة وهمية', today);                                            // لا تطابق فرقة — unmatchedUnits

    // ── مرجع التوقعات المستقل (من خريطة roster + قواعد العد المعتمدة) ──
    // (يُبنى يدويًا من نفس القواعد لكن بمسار كود مستقل عن الخدمة)
    const expectedMatched = [];
    {
        const seen = new Set();
        const rows = dbw.prepare(`SELECT t.incident_number n, r.unit u, s.shift_date sd, t.timestamp ts
            FROM report_times t JOIN reports r ON r.id=t.report_id LEFT JOIN shifts s ON s.id=r.shift_id
            WHERE t.incident_number LIKE 'INC-TST-%' AND (t.withdrawn IS NULL OR t.withdrawn=0) AND (t.manual_cancelled IS NULL OR t.manual_cancelled=0)`).all();
        for (const r of rows) {
            const tid = r.u === TEAM_A_NAME ? TEAM_A : (r.u === TEAM_B_NAME ? TEAM_B : undefined);
            if (tid === undefined) continue;
            let date = r.sd;
            if (!date) { // تحويل الرياض: +03:00 → نفس اليوم
                const d = new Date(r.ts); date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
            }
            if (rosterMap.get(date) !== tid) continue;
            const key = r.n + '::' + tid;
            if (seen.has(key)) continue;
            seen.add(key);
            expectedMatched.push({ n: r.n, tid, date });
        }
    }
    const expToday = rosterMap.has(today) ? expectedMatched.filter(m => m.date === today).length : null;
    const expWeek = expectedMatched.filter(m => m.date >= week.start && m.date <= week.end).length;
    const expMonth = expectedMatched.filter(m => m.date.startsWith(cm)).length;

    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — بوابة الموظف v1 | اليوم: ' + today + ' | الأسبوع: ' + week.start + '→' + week.end);
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    let chrome = null, ws = null, msgId = 0;
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

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const tok1 = await login('T001', 'test1234');
        const tok2 = await login('T002', 'test1234');
        const tok3 = await login('T003', 'test1234');
        if (!tok1 || !tok2 || !tok3) throw new Error('فشل تسجيل دخول حسابات الاختبار');

        // ── 1) profile ──
        const prof = await apiGet('/api/my/profile', tok1);
        const pOk = prof.status === 200 && prof.body.employee && prof.body.employee.code === 'T001'
            && prof.body.today && prof.body.today.date === today
            && prof.body.today.teamId === (rosterMap.get(today) || null)
            && prof.body.today.assignmentSource === (rosterMap.has(today) ? 'roster' : 'none');
        check('1) profile: الموظف من التوكن + تكليف اليوم من roster (مصدره موسوم)', pOk, JSON.stringify(prof.body).slice(0, 300));

        // ── 2) احتياطي is_primary موسومًا ──
        dbw2: {
            const dbx = new Database(TMP_DB);
            dbx.prepare('DELETE FROM shift_roster WHERE employee_id = ? AND shift_date = ?').run(empId, today);
            dbx.prepare('INSERT INTO team_assignments (employee_id, team_id, assigned_date, is_primary) VALUES (?,?,?,1)').run(empId, TEAM_B, today);
            dbx.close();
        }
        const profFb = await apiGet('/api/my/profile', tok1);
        const fbOk = profFb.status === 200 && profFb.body.today.assignmentSource === 'primary_fallback' && profFb.body.today.teamId === TEAM_B;
        check('2) بلا صف roster لليوم ← احتياطي is_primary موسوم primary_fallback', fbOk, JSON.stringify(profFb.body.today));
        {
            const dbx = new Database(TMP_DB);
            dbx.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
                .run(empId, TEAM_A, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
            dbx.close();
        }

        // ── 3) الصلاحيات والحالات ──
        const r401 = await apiGet('/api/my/profile', null);
        const r403 = await apiGet('/api/my/profile', tok2);
        const r404 = await apiGet('/api/my/profile', tok3);
        const r422 = await apiGet('/api/my/schedule?month=13&year=2026', tok1);
        check('3) 401 بلا توكن · 403 بلا الصلاحية (PERMISSION_DENIED) · 404 NO_EMPLOYEE · 422 شهر غير صالح',
            r401.status === 401 && r403.status === 403 && r403.body.code === 'PERMISSION_DENIED'
            && r404.status === 404 && r404.body.code === 'NO_EMPLOYEE' && r422.status === 422,
            `${r401.status}/${r403.status}/${r404.status}/${r422.status}`);

        // ── 4) ترجمة الرموز الرسمية + M بلا فرقة ──
        const schPrev = await apiGet(`/api/my/schedule?month=${+pm.slice(5)}&year=${+pm.slice(0, 4)}`, tok1);
        const mDay = (schPrev.body.days || []).find(d => d.shiftCode === 'M');
        const d12Day = (schPrev.body.days || []).find(d => d.shiftCode === 'D12');
        check('4) الرموز من السجل الرسمي: D12=«دوام 12 صباحاً» · M=«مهمة» مع «بدون فريق»',
            schPrev.status === 200 && mDay && mDay.shiftName === 'مهمة' && mDay.teamName === 'بدون فريق'
            && d12Day && d12Day.shiftName === 'دوام 12 صباحاً' && d12Day.teamName === TEAM_A_NAME,
            JSON.stringify(mDay));

        // ── 5) coverage ──
        const schGap = await apiGet(`/api/my/schedule?month=${+jm.slice(5)}&year=${+jm.slice(0, 4)}`, tok1);
        const elapsedCm = Math.min(+today.slice(8), +cmEnd.slice(8));
        const coveredCm = [...rosterMap.keys()].filter(d => d.startsWith(cm) && +d.slice(8) <= elapsedCm).length;
        const expCoverageCm = coveredCm >= elapsedCm ? 'complete' : 'partial';
        const schCur = await apiGet(`/api/my/schedule?month=${+cm.slice(5)}&year=${+cm.slice(0, 4)}`, tok1);
        check('5) coverage: فجوة=none · السابق=complete · الحالي=' + expCoverageCm + ' (لا أصفار مموّهة)',
            schGap.body.coverage === 'none' && schPrev.body.coverage === 'complete' && schCur.body.coverage === expCoverageCm,
            `gap=${schGap.body.coverage} prev=${schPrev.body.coverage} cur=${schCur.body.coverage}`);

        // ── 6) الفترات ──
        const asg = await apiGet('/api/my/assignments', tok1);
        const periods = asg.body.periods || [];
        const bPeriod = periods.find(p => p.teamId === TEAM_B && p.from === `${cm}-12`);
        const aMerged = periods.find(p => p.teamId === TEAM_A && p.from === `${pm}-16`);
        const aEarly = periods.find(p => p.teamId === TEAM_A && p.from === `${pm}-01`);
        check('6) الفترات: فجوة يوم 11 تكسر A←B · يوم M بلا فرقة يكسر السابق · والأيام المتصلة تمتد عبر حد الشهر بصحة',
            asg.status === 200
            && bPeriod && bPeriod.to === cmEnd
            && aMerged && aMerged.to === `${cm}-10`          // امتداد 16←نهاية السابق + 1..10 الحالي (أيام متصلة)
            && aEarly && aEarly.to === `${pm}-14`            // M (بلا فرقة) كسر الفترة المبكرة
            && !periods.some(p => p.from === `${cm}-11`),    // يوم الفجوة لا يشكل فترة
            JSON.stringify(periods.map(p => [p.teamId, p.from, p.to])));

        // ── 7+8) العداد ──
        const inc = await apiGet('/api/my/team-incidents', tok1);
        const b = inc.body;
        const byA = (b.byTeam || []).find(x => x.teamId === TEAM_A);
        const byB = (b.byTeam || []).find(x => x.teamId === TEAM_B);
        check('7) العد: يوم التكليف مع الفرقة فقط + استبعاد مسحوبة/ملغاة/مكررة/فرقة أخرى/قبل التكليف + سقوط CAD',
            inc.status === 200 && b.today.count === expToday && b.month.count === expMonth
            && byA && byA.count === expectedMatched.filter(m => m.tid === TEAM_A && m.date.startsWith(cm)).length
            && byB && byB.count === expectedMatched.filter(m => m.tid === TEAM_B && m.date.startsWith(cm)).length
            && b.unmatchedUnits >= 1,
            `today=${b.today && b.today.count} (متوقع ${expToday}) month=${b.month && b.month.count} (متوقع ${expMonth})`);
        const wdStart = new Date(week.start + 'T00:00:00Z').getUTCDay();
        check('8) الأسبوع السبت→الجمعة: start=سبت وend=جمعة والمجموع مطابق',
            b.week.start === week.start && b.week.end === week.end && wdStart === 6 && b.week.count === expWeek,
            JSON.stringify(b.week) + ' متوقع ' + expWeek);
        check('8ب) نص التوضيح الثابت موجود في الرد حرفيًا',
            typeof b.note === 'string' && b.note.includes('لا تمثل بالضرورة البلاغات التي باشرتها شخصيًا'), b.note);

        // ── 7ب) قرار المالك: بلاغ اليوم بلا تكليف roster مؤكد = null — حتى مع وجود is_primary ──
        {
            const dbx = new Database(TMP_DB);
            dbx.prepare('DELETE FROM shift_roster WHERE employee_id = ? AND shift_date = ?').run(empId, today);
            dbx.close(); // is_primary على TEAM_B ما زال موجودًا من اختبار 2
        }
        const incNoAssign = await apiGet('/api/my/team-incidents', tok1);
        const tNA = incNoAssign.body.today || {};
        check('7ب) بلا roster لليوم: today.count=null وreason=no_assignment رغم وجود is_primary وبلاغات فعلية اليوم',
            incNoAssign.status === 200 && tNA.count === null && tNA.reason === 'no_assignment',
            JSON.stringify(tNA));
        {
            const dbx = new Database(TMP_DB);
            dbx.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
                .run(empId, TEAM_A, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
            dbx.close();
        }

        // ── 9+10) الواجهة ──
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
        const injScript = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token','${tok1}');}catch(e){}` });
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4000);

        const ui1 = await evalJs(`(() => ({
            name: document.getElementById('whoLine') ? document.getElementById('whoLine').textContent : '',
            cards: document.querySelectorAll('.card').length,
            hasNote: document.body.textContent.includes('لا تمثل بالضرورة البلاغات التي باشرتها شخصيًا'),
            hasCardTitle: document.body.textContent.includes('بلاغات فرقتي أثناء تكليفي'),
            dayRows: document.querySelectorAll('.day-row').length,
            statNums: [...document.querySelectorAll('.stat .n')].map(e => e.textContent.trim())
        }))()`);
        check('9) الواجهة: الاسم + 4 أقسام + عنوان البطاقة المعتمد + نص التوضيح + صفوف الجدول',
            ui1.name.includes('موظف اختبار البوابة') && ui1.cards >= 4 && ui1.hasCardTitle && ui1.hasNote && ui1.dayRows >= 10,
            JSON.stringify(ui1));
        await shot('ui-1-portal-main');

        await evalJs("document.getElementById('bdToggle').click(); 'ok'");
        await sleep(400);
        const ui2 = await evalJs(`(() => ({
            open: document.getElementById('bdTable').classList.contains('open'),
            rows: document.querySelectorAll('#bdTable tbody tr').length,
            text: document.querySelector('#bdTable tbody tr') ? document.querySelector('#bdTable tbody tr').textContent : ''
        }))()`);
        check('9ب) تفصيل الفرق يفتح ويعرض الفرقتين بفترتيهما', ui2.open && ui2.rows === 2, JSON.stringify(ui2));
        await shot('ui-2-breakdown-open');

        // التنقل إلى شهر الفجوة
        const gapNav = await evalJs(`(async () => {
            const clicks = ${(0 + ((+cm.slice(5)) - (+jm.slice(5)) + 12 * ((+cm.slice(0, 4)) - (+jm.slice(0, 4)))))};
            for (let i = 0; i < clicks; i++) { document.getElementById('mPrev').click(); await new Promise(r => setTimeout(r, 600)); }
            return { clicks, warn: document.querySelector('.coverage-warn') ? document.querySelector('.coverage-warn').textContent : '',
                     rows: document.querySelectorAll('.day-row').length };
        })()`);
        check('10) شهر الفجوة في الواجهة: تنبيه «لا تتوفر بيانات جدول» وصفر صفوف (لا أصفار مموّهة)',
            gapNav.warn.includes('لا تتوفر بيانات جدول') && gapNav.rows === 0, JSON.stringify(gapNav));
        await shot('ui-3-gap-month');

        // حساب بلا ملف موظف — نزيل سكربت الحقن أولًا (كان يعيد كتابة tok1 عند كل تنقل)
        await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: injScript.identifier });
        await evalJs(`localStorage.setItem('auth_access_token','${tok3}'); 'ok'`);
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(3000);
        const ui404 = await evalJs("document.body.textContent.includes('لا يوجد ملف موظف مرتبط')");
        check('10ب) حساب بلا ملف موظف ← حالة صادقة في الواجهة', ui404 === true);
        await shot('ui-4-no-employee');

        // ── 11) انحدار ──
        const me = await apiGet('/api/auth/me', tok1);
        const esched = await apiGet('/api/shift-roster/employee-schedule/74', tok1);
        check('11) انحدار: /api/auth/me يعمل · employee-schedule يبقى محميًا بـschedule.view (403) · Console=صفر',
            me.status === 200 && esched.status === 403 && consoleErrors.length === 0,
            `me=${me.status} esched=${esched.status} console=${consoleErrors.length}`);

        console.log('\n════════════════ نتيجة بوابة الموظف v1: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
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
})().catch(e => { console.error('⚠️ انهيار:', e.message); process.exit(1); });
