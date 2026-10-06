// ═══ E-5 (FSS): اختبار محرك الاقتراحات — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية.
// يغطي قائمة المالك المعتمدة (Design Revision 2):
// اكتشاف الفجوات · مثال M5 الرباعي حرفيًا [A,B,D,C] + request_age=null (J3) ·
// J2 (code ASC حتمي + ثباته عبر تشغيلتين + shift_code_candidates كاملة) ·
// استبعادات E-4 موثقة في candidates_summary · J5 (رفض⇒عرض التالي+Audit ·
// مرشح أُسند roster⇒candidate_invalidated والانتقال · سدّ الفجوة يدويًا⇒
// gap_resolved · نهاية القائمة⇒queue_exhausted) · M7 الثلاثي (LIVE_OFFER_SAME_DAY
// + الفهرس الجزئي يرفض INSERT مباشر + declined يعيد الأهلية عبر تشغيلة جديدة) ·
// إعادة التوليد بلا تكرار (existing_live_offer) · accepted⇒لا roster+إشعار
// schedule.proposals.manage (J4) · M13 (نشر⇒توقف بصفر كتابة + بصمة + respond
// ⇒409 MONTH_PUBLISHED والحالة تبقى offered + GET قراءة فقط) · Audit ذرّي ·
// بصمة shift_roster ثابتة · لا Permissions جديدة · 192 محفوظ.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e5-'));
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
let server = null;

function api(method, url, body, token) {
    return new Promise((resolve, reject) => {
        const u = new URL(BASE + url);
        const data = body ? JSON.stringify(body) : null;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {});
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(buf); } catch (e) {}
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
function dbAll(sql, params) {
    const Database = require('better-sqlite3');
    const d = new Database(TMP_DB, { readonly: true });
    const rows = d.prepare(sql).all(...(params || []));
    d.close();
    return rows;
}
function dbRun(sql, params) {
    const Database = require('better-sqlite3');
    const d = new Database(TMP_DB);
    d.prepare(sql).run(...(params || []));
    d.close();
}
// حذف وقائي متسامح — جداول مراحل E الحديثة قد لا توجد بعد في النسخة الخام
// (تُنشأ عند إقلاع الخادم)؛ غيابها يعني أصلًا «لا شيء يُنظَّف».
function dbRunSafe(sql, params) {
    try { dbRun(sql, params); } catch (e) { if (!/no such table/i.test(e.message)) throw e; }
}
function fp(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function riyadhOffset(n) {
    const p = TimeRiyadh.riyadhParts(new Date());
    const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + n));
    return d.toISOString().slice(0, 10);
}
function nextMonth(month) {
    const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function daysOfMonth(month) {
    const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out = [];
    for (let d = 1; d <= n; d++) out.push(`${month}-${String(d).padStart(2, '0')}`);
    return out;
}
function isFriSat(dateStr) {
    const wd = new Date(dateStr + 'T00:00:00Z').getUTCDay();
    return wd === 5 || wd === 6;
}
function startServer() {
    return new Promise((resolve, reject) => {
        const env = Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' });
        server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        server.stdout.on('data', d => log += d);
        server.stderr.on('data', d => log += d);
        let attempts = 0;
        const tick = () => {
            http.get(BASE + '/health', (res) => {
                if (res.statusCode === 200) { res.resume(); return resolve(); }
                res.resume(); retry();
            }).on('error', retry);
        };
        const retry = () => {
            if (++attempts > 80) { console.error('server never ready. Log tail:\n' + log.slice(-3000)); return reject(new Error('boot failed')); }
            setTimeout(tick, 500);
        };
        tick();
    });
}
function stopServer() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.once('exit', () => { server = null; resolve(); });
        server.kill();
        setTimeout(resolve, 5000);
    });
}
async function login(username, password) {
    const r = await api('POST', '/api/auth/login', { username, password });
    if (!r.data || !r.data.accessToken) throw new Error('login failed: ' + username + ' — ' + JSON.stringify(r.data));
    return r.data.accessToken;
}
function insertRoster(empId, teamId, date, code) {
    dbRun('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)',
        [empId, teamId, date, code, Number(date.slice(5, 7)), Number(date.slice(0, 4))]);
}

async function main() {
    console.log('═══ E-5 PROPOSAL ENGINE TEST — بيئة معزولة ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (['DEMO101', 'DEMO102', 'DEMO103'].includes(u.username)) u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    const demoProto = users.find(u => u.username === 'DEMO101');
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e5-test')", [demoProto.id]);

    // ── الشخصيات: A=DEMO101 (له دخول) · B/D/C مرشحون (id(D)<id(C)) · S1..S8 طاقم تغطية ══
    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const A = EMP1;
    const rest = dbAll('SELECT id FROM employees WHERE is_active = 1 AND id NOT IN (?, ?, ?) ORDER BY id LIMIT 11', [EMP1, EMP2, EMP3]).map(r => r.id);
    const [B, D, C, S1, S2, S3, S4, S5, S6, S7, S8] = rest;
    if (!(B && D && C && S8)) throw new Error('موظفون نشطون غير كافين للسيناريو');
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;

    // ── الأشهر والتواريخ ══
    const MONTH = riyadhOffset(60).slice(0, 7);
    const MONTH2 = nextMonth(MONTH);
    const G1 = MONTH + '-20'; // فجوة day
    const G2 = MONTH + '-23'; // فجوة night
    const G3 = MONTH + '-26'; // فجوة night
    const G4 = MONTH2 + '-10'; // فجوة night (شهر النشر)

    // تواريخ غير العطل (جمعة/سبت) في الأيام 1..14 — دائمًا 10 بالضبط
    const pool = [];
    for (let d = 1; d <= 14; d++) {
        const dt = `${MONTH}-${String(d).padStart(2, '0')}`;
        if (!isFriSat(dt)) pool.push(dt);
    }
    check('ت0: بركة تواريخ غير العطل = 10 (ثابت رياضي للأيام 1..14)', pool.length === 10, 'pool=' + pool.length);

    // ── تنظيف مسرح الشهرين (نسخة مؤقتة) ══
    dbRun('DELETE FROM team_assignments WHERE team_id = ?', [TEAM]);
    for (const m of [MONTH, MONTH2]) {
        dbRun('DELETE FROM shift_roster WHERE shift_date LIKE ?', [m + '-%']);
        dbRunSafe('DELETE FROM unable_attend_requests WHERE month = ?', [m]);
        dbRunSafe('DELETE FROM employee_preferences WHERE month = ?', [m]);
        dbRun('DELETE FROM leave_requests WHERE start_date <= ? AND end_date >= ?', [m + '-31', m + '-01']);
    }
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.coverage_default', ?)", [JSON.stringify({ day: 2, night: 2, total: 8 })]);
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.coverage_team_overrides', '{}')", []);

    // عضويات حية للمرشحين الأربعة فقط (SSOT)
    for (const id of [A, B, D, C]) {
        dbRun("INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, '2026-01-01', NULL, 1, 'flex-e5-test')", [id, TEAM]);
    }

    // ── طاقم التغطية: الشهر كامل مغطى (5 يومي + 3 ليلي) عدا أيام الفجوات ══
    for (const date of daysOfMonth(MONTH)) {
        if (date !== G1) for (const s of [S1, S2, S3, S4, S5]) insertRoster(s, TEAM, date, 'D12');
        else insertRoster(S1, TEAM, date, 'D12'); // G1: day=1 ⇒ فجوة day
        if (date === G2 || date === G3) insertRoster(S6, TEAM, date, 'N12'); // night=1 ⇒ فجوة night
        else for (const s of [S6, S7, S8]) insertRoster(s, TEAM, date, 'N12');
    }
    // شهر النشر: كامل مغطى عدا G4 (night=1) + B/C/D لديهم D12 في G4 (مستبعدون roster)
    for (const date of daysOfMonth(MONTH2)) {
        for (const s of [S1, S2, S3, S4, S5]) insertRoster(s, TEAM, date, 'D12');
        if (date === G4) insertRoster(S6, TEAM, date, 'N12');
        else for (const s of [S6, S7, S8]) insertRoster(s, TEAM, date, 'N12');
    }
    for (const id of [B, D, C]) insertRoster(id, TEAM, G4, 'D12');

    // ── صفوف المرشحين لمقاييس M5 (كلها في الأيام 1..14 — بعيدة عن الفجوات) ══
    // A: صف D12 واحد (عبء 0) · B: 9 ليالٍ + D12 (عبء 9) · C/D: 6 ليالٍ + D12 (عبء 6)
    insertRoster(A, TEAM, pool[0], 'D12');
    for (let i = 1; i <= 9; i++) insertRoster(B, TEAM, pool[i], 'N12');
    insertRoster(B, TEAM, pool[0], 'D12');
    for (let i = 0; i <= 5; i++) { insertRoster(C, TEAM, pool[i], 'N12'); insertRoster(D, TEAM, pool[i], 'N12'); }
    insertRoster(C, TEAM, pool[6], 'D12');
    insertRoster(D, TEAM, pool[7], 'D12');

    const shiftCodesCountBefore = dbAll('SELECT COUNT(*) c FROM shift_codes')[0].c;
    await startServer();
    console.log('— الخادم يعمل على :' + PORT + ' —');
    // ── تفضيلات M5 (بعد الإقلاع — employee_preferences يُنشأ عند init):
    // A=1/3 (33%) · B/C/D=2/3 (67%) — الزميل EMP3 بلا صفوف (غير محقق دائمًا) ══
    const insPref = 'INSERT INTO employee_preferences (employee_id, month, pref_type, pref_value, created_by) VALUES (?, ?, ?, ?, ?)';
    dbRun(insPref, [A, MONTH, 'shift', 'D12', 1]);          // محقق (صف pool[0])
    dbRun(insPref, [A, MONTH, 'day_off', pool[0], 1]);      // غير محقق (لديه مناوبة)
    dbRun(insPref, [A, MONTH, 'colleague', String(EMP3), 1]); // غير محقق
    for (const [id, d12Date] of [[B, pool[0]], [C, pool[6]], [D, pool[7]]]) {
        dbRun(insPref, [id, MONTH, 'shift', 'D12', 1]);          // محقق
        dbRun(insPref, [id, MONTH, 'day_off', MONTH + '-25', 1]); // محقق (لا صف)
        dbRun(insPref, [id, MONTH, 'colleague', String(EMP3), 1]); // غير محقق
    }
    dbRun('DELETE FROM schedule_proposals', []);
    dbRun('DELETE FROM schedule_proposal_runs', []);
    dbRun('DELETE FROM schedule_months', []);
    dbRun("DELETE FROM audit_log WHERE action LIKE 'schedule_proposal%'", []);

    const demo1 = await login('DEMO101', 'test123');
    const demo2 = await login('DEMO102', 'test123');
    const admin = await login('4252', '4252');

    console.log('\n── الوصول والصلاحيات ──');
    check('أ1: توليد بلا توكن ⇒ 401', (await api('POST', '/api/schedule/proposals/generate', { month: MONTH, team_id: TEAM }, null)).status === 401);
    check('أ2: توليد بلا schedule.proposals.manage ⇒ 403', (await api('POST', '/api/schedule/proposals/generate', { month: MONTH, team_id: TEAM }, demo1)).status === 403);
    check('أ3: قائمة الإدارة بلا الصلاحية ⇒ 403', (await api('GET', `/api/schedule/proposals?month=${MONTH}&team_id=${TEAM}`, null, demo1)).status === 403);
    check('أ4: عروضي بلا ops.my_portal ⇒ 403', (await api('GET', '/api/my/proposals', null, demo2)).status === 403);

    console.log('\n── التحققات ──');
    check('ب1: شهر بصيغة خاطئة ⇒ 422 INVALID_MONTH',
        (await api('POST', '/api/schedule/proposals/generate', { month: '12-2026', team_id: TEAM }, admin)).status === 422);
    check('ب2: فريق غير موجود ⇒ 404 TEAM_NOT_FOUND', (await api('POST', '/api/schedule/proposals/generate', { month: MONTH, team_id: 999999 }, admin)).status === 404);
    check('ب3: قائمة بلا team_id ⇒ 422 INVALID_TEAM', (await api('GET', `/api/schedule/proposals?month=${MONTH}`, null, admin)).status === 422);

    console.log('\n── التوليد الأول: اكتشاف + M5 + J2 ──');
    const gen1 = await api('POST', '/api/schedule/proposals/generate', { month: MONTH, team_id: TEAM }, admin);
    check('ج1: التوليد نجح واكتشف 3 فجوات بالضبط (G1 day + G2/G3 night)', gen1.status === 200 && gen1.data.gaps === 3, JSON.stringify(gen1.data).slice(0, 200));
    check('ج2: 3 عروض — كلها لـ A (أقل نسبة تحقق 33%)', gen1.data.offers.length === 3 && gen1.data.offers.every(o => Number(o.employee_id) === Number(A)), JSON.stringify(gen1.data.offers));
    const run1 = await api('GET', '/api/schedule/proposals/runs/' + gen1.data.run_id, null, admin);
    check('ج3: سجل التشغيلة قابل للجلب مع gap_summary محفوظة كاملة', run1.status === 200 && run1.data.run.gap_summary.length === 3);
    const gapG1 = run1.data.run.gap_summary.find(g => g.date === G1);
    const gapG2 = run1.data.run.gap_summary.find(g => g.date === G2);
    check('ج4: J2 — فجوة day: shift_code_candidates كاملة والمختار D10 (code ASC) + selection_rule',
        gapG1 && gapG1.shift_code_selected === 'D10' && gapG1.shift_code_candidates[0] === 'D10' &&
        gapG1.shift_code_candidates.length >= 10 && gapG1.selection_rule === 'first_by_code_asc_in_period',
        JSON.stringify(gapG1 && gapG1.shift_code_candidates));
    check('ج5: J2 — فجوة night: المختار LN10 (code ASC)', gapG2 && gapG2.shift_code_selected === 'LN10');
    const q1 = gapG1.ranked_queue.map(q => Number(q.employee_id));
    check('ج6: مثال M5 الرباعي حرفيًا — الترتيب [A, B, D, C]',
        q1.length === 4 && q1[0] === Number(A) && q1[1] === Number(B) && q1[2] === Number(D) && q1[3] === Number(C), JSON.stringify(q1));
    const m5A = gapG1.ranked_queue[0].m5, m5B = gapG1.ranked_queue[1].m5;
    check('ج7: M5① — نسبة A = 1/3 وB = 2/3 (ميزان التفضيلات من roster الفعلي)',
        Math.abs(m5A.pref_ratio - 1 / 3) < 0.001 && Math.abs(m5B.pref_ratio - 2 / 3) < 0.001,
        `A=${m5A.pref_ratio} B=${m5B.pref_ratio}`);
    check('ج8: M5② — عبء B = 9 ليالٍ وC/D = 6 (الليلة = M4) وبُعد العطلات متعادل 0 للجميع في v1 (قرار المالك — لا قاعدة مخترعة)',
        m5B.burden_nights === 9 && gapG1.ranked_queue[2].m5.burden_nights === 6 && gapG1.ranked_queue[3].m5.burden_nights === 6 &&
        gapG1.ranked_queue.every(q => q.m5.burden_holidays === 0));
    check('ج9: M5③ — request_age = null للجميع (J3: لا يحسم ولا تاريخ بديل)',
        gapG1.ranked_queue.every(q => q.m5.request_age === null));
    check('ج10: M5④ — كسر تعادل العبء بين D/C بـ employee_id ASC (id(D) < id(C))', Number(D) < Number(C));

    console.log('\n── إعادة التوليد: لا تكرار ──');
    const genIdem = await api('POST', '/api/schedule/proposals/generate', { month: MONTH, team_id: TEAM }, admin);
    check('د1: إعادة التوليد ⇒ صفر عروض جديدة (existing_live_offer لكل فجوة)', genIdem.status === 200 && genIdem.data.offers.length === 0);
    check('د2: العروض القائمة بقيت 3 — صفر تكرار', dbAll('SELECT COUNT(*) c FROM schedule_proposals').length === 1 &&
        dbAll('SELECT COUNT(*) c FROM schedule_proposals')[0].c === 3);

    console.log('\n── M7: الحارس البنيوي (الفهرس الجزئي) ──');
    let indexBlocked = false;
    try {
        dbRun(`INSERT INTO schedule_proposals (run_id, month, team_id, employee_id, date, shift_code, period, status)
               VALUES (?, ?, ?, ?, ?, 'D10', 'day', 'offered')`, [gen1.data.run_id, MONTH, TEAM, A, G1]);
    } catch (e) { indexBlocked = /UNIQUE/i.test(e.message); }
    check('ه1: INSERT مباشر لعرض حيٍّ ثانٍ لنفس (موظف، يوم) ⇒ رفض UNIQUE (uq_proposals_live_emp_date)', indexBlocked);

    console.log('\n── عروضي (الموظف) ──');
    const mine = await api('GET', '/api/my/proposals?month=' + MONTH, null, demo1);
    check('و1: A يرى عروضه الثلاثة مع ranking_explanation مفسِّرة', mine.status === 200 && mine.data.proposals.length === 3 &&
        mine.data.proposals.every(p => p.ranking_explanation && p.ranking_explanation.dim1_pref_balance));
    const pG1 = mine.data.proposals.find(p => p.date === G1);
    const pG2 = mine.data.proposals.find(p => p.date === G2);
    const pG3 = mine.data.proposals.find(p => p.date === G3);
    check('و2: عروض A بحالة offered على التواريخ الثلاثة', !!(pG1 && pG2 && pG3) && [pG1, pG2, pG3].every(p => p.status === 'offered'));

    console.log('\n── J5: الرفض ⇒ التسلسل للتالي ──');
    const dec1 = await api('POST', `/api/my/proposals/${pG1.id}/respond`, { decision: 'decline' }, demo1);
    check('ز1: رفض A لعرض G1 ⇒ declined + عرض تالٍ لـ B (offer_next)',
        dec1.status === 200 && dec1.data.status === 'declined' && dec1.data.outcome === 'offer_next' && dec1.data.next_proposal_id, JSON.stringify(dec1.data));
    const bG1 = dbAll('SELECT * FROM schedule_proposals WHERE id = ?', [dec1.data.next_proposal_id])[0];
    check('ز2: العرض التالي لـ B برتبة M5 #2 وحالة offered', bG1 && Number(bG1.employee_id) === Number(B) && bG1.rank_position === 2 && bG1.status === 'offered');
    check('ز3: الموظف لا يستطيع الرد على عرض غيره ⇒ 403 NOT_PROPOSAL_OWNER',
        (await api('POST', `/api/my/proposals/${bG1.id}/respond`, { decision: 'accept' }, demo1)).status === 403);

    console.log('\n── J5-②: سدّ الفجوة يدويًا ⇒ gap_resolved ──');
    insertRoster(S2, TEAM, G1, 'D12'); // إعادة S2: day=2 ⇒ الفجوة انسدت خارج E-5
    const wd1 = await api('POST', `/api/schedule/proposals/${bG1.id}/withdraw`, {}, admin);
    check('ح1: سحب عرض B بعد انسداد الفجوة ⇒ gap_resolved بلا عرض تالٍ',
        wd1.status === 200 && wd1.data.outcome === 'gap_resolved' && !wd1.data.next_proposal_id, JSON.stringify(wd1.data));
    const run1After = await api('GET', '/api/schedule/proposals/runs/' + gen1.data.run_id, null, admin);
    const gapG1After = run1After.data.run.gap_summary.find(g => g.date === G1);
    check('ح2: gap_summary لـ G1 تحولت queue_state=resolved وموثقة', gapG1After.queue_state === 'resolved' &&
        (gapG1After.notes || []).some(n => n.includes('gap_resolved')));

    console.log('\n── J5-④: مرشح أُسند roster ⇒ candidate_invalidated والانتقال ──');
    const dec3 = await api('POST', `/api/my/proposals/${pG3.id}/respond`, { decision: 'decline' }, demo1);
    check('ط1: رفض A لعرض G3 ⇒ عرض تالٍ لـ B', dec3.status === 200 && dec3.data.outcome === 'offer_next' && dec3.data.next_proposal_id);
    const bG3 = dbAll('SELECT * FROM schedule_proposals WHERE id = ?', [dec3.data.next_proposal_id])[0];
    insertRoster(D, TEAM, G3, 'D12'); // D أُسند يدويًا على G3 (لا يؤثر في فجوة night)
    const wd2 = await api('POST', `/api/schedule/proposals/${bG3.id}/withdraw`, {}, admin);
    check('ط2: سحب عرض B من G3 ⇒ تخطّي D (roster جديد) والعرض لـ C',
        wd2.status === 200 && wd2.data.outcome === 'offer_next' && wd2.data.next_proposal_id, JSON.stringify(wd2.data));
    const cG3 = dbAll('SELECT * FROM schedule_proposals WHERE id = ?', [wd2.data.next_proposal_id])[0];
    check('ط3: العرض الجديد لـ C برتبة M5 #4', cG3 && Number(cG3.employee_id) === Number(C) && cG3.rank_position === 4);
    const run1After2 = await api('GET', '/api/schedule/proposals/runs/' + gen1.data.run_id, null, admin);
    const gapG3After = run1After2.data.run.gap_summary.find(g => g.date === G3);
    const dEntry = gapG3After.ranked_queue.find(q => Number(q.employee_id) === Number(D));
    check('ط4: D موثق candidate_invalidated بسبب MULTIPLE_SHIFTS_SAME_DAY في ranked_queue',
        dEntry && String(dEntry.invalidated || '').includes('MULTIPLE_SHIFTS_SAME_DAY'), JSON.stringify(dEntry));

    console.log('\n── J5-⑥: نهاية القائمة ⇒ queue_exhausted ──');
    const wd3 = await api('POST', `/api/schedule/proposals/${cG3.id}/withdraw`, {}, admin);
    check('ي1: سحب عرض C ⇒ queue_exhausted (A مرفوض · B مسحوب · D مُبطل · C مسحوب)',
        wd3.status === 200 && wd3.data.outcome === 'queue_exhausted');
    const run1After3 = await api('GET', '/api/schedule/proposals/runs/' + gen1.data.run_id, null, admin);
    check('ي2: gap_summary لـ G3 تحولت queue_state=exhausted',
        run1After3.data.run.gap_summary.find(g => g.date === G3).queue_state === 'exhausted');

    console.log('\n── J4: القبول ⇒ لا تطبيق آلي ──');
    const acc = await api('POST', `/api/my/proposals/${pG2.id}/respond`, { decision: 'accept' }, demo1);
    check('ك1: قبول A لعرض G2 ⇒ accepted', acc.status === 200 && acc.data.status === 'accepted');
    check('ك2: صفر كتابة roster عند القبول — لا صف لـ A في G2', dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [A, G2])[0].c === 0);
    check('ك3: إشعار تشغيلي لحاملي schedule.proposals.manage (التطبيق عبر F-1 خارج E-5)',
        dbAll("SELECT COUNT(*) c FROM notifications WHERE title LIKE '%عرض تكميلي مقبول%'")[0].c >= 1);
    check('ك4: إعادة الرد على عرض مقبول ⇒ 409 PROPOSAL_NOT_RESPONDABLE',
        (await api('POST', `/api/my/proposals/${pG2.id}/respond`, { decision: 'decline' }, demo1)).status === 409);

    // بصمة roster بعد آخر تعديل Fixture يدوي — كل ما بعدها يجب ألا يكتب شيئًا
    const rosterFp = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));

    console.log('\n── تشغيلة جديدة: declined يعيد الأهلية + ثبات J2 + توثيق الاستبعاد ──');
    const gen3 = await api('POST', '/api/schedule/proposals/generate', { month: MONTH, team_id: TEAM }, admin);
    check('ل1: تشغيلة جديدة ⇒ فجوتان مكتشفتان (G3 معروضة + G2 متخطاة existing_live_offer) وعرض واحد — G1 انسدت',
        gen3.status === 200 && gen3.data.gaps === 2 && gen3.data.offers.length === 1, JSON.stringify(gen3.data).slice(0, 200));
    check('ل2: A مرفوض سابقًا لكنه قابل للترشيح في تشغيلة جديدة (declined ليست حية)', Number(gen3.data.offers[0].employee_id) === Number(A) && gen3.data.offers[0].date === G3);
    // قرار المالك (مراجعة E-5): لا إحياء — الصف القديم يبقى declined تاريخيًا والعرض الجديد صف مستقل
    const aG3Rows = dbAll('SELECT id, status, run_id FROM schedule_proposals WHERE employee_id = ? AND date = ? ORDER BY id', [A, G3]);
    check('ل2ب: declined يبقى declined نهائيًا — Proposal #1 مرفوض تاريخيًا وProposal #2 مستقل offered (لا إحياء)',
        aG3Rows.length === 2 && aG3Rows[0].status === 'declined' && aG3Rows[1].status === 'offered' &&
        Number(aG3Rows[1].id) === Number(gen3.data.offers[0].proposal_id) &&
        Number(aG3Rows[0].run_id) !== Number(aG3Rows[1].run_id),
        JSON.stringify(aG3Rows));
    const run3 = await api('GET', '/api/schedule/proposals/runs/' + gen3.data.run_id, null, admin);
    const run3Gap = run3.data.run.gap_summary[0];
    check('ل3: ثبات J2 عبر تشغيلتين — نفس الفجوة تختار LN10 مجددًا', run3Gap.shift_code_selected === 'LN10');
    check('ل4: استبعاد D موثق في candidates_summary (HAS_ROSTER)',
        (run3.data.run.candidates_summary || []).some(x => Number(x.employee_id) === Number(D) && x.reasons.includes('HAS_ROSTER')));

    console.log('\n── M13: النشر ⇒ توقف فوري بصفر كتابة ──');
    const gen4 = await api('POST', '/api/schedule/proposals/generate', { month: MONTH2, team_id: TEAM }, admin);
    check('م1: توليد شهر النشر قبل نشره ⇒ عرض واحد لـ A على G4 (B/C/D مستبعدون roster)',
        gen4.status === 200 && gen4.data.offers.length === 1 && Number(gen4.data.offers[0].employee_id) === Number(A));
    const pG4 = dbAll('SELECT * FROM schedule_proposals WHERE month = ? AND date = ?', [MONTH2, G4])[0];
    dbRun("INSERT INTO schedule_months (month, status, published_by, published_at) VALUES (?, 'published', 1, datetime('now'))", [MONTH2]);
    const fpProps = fp(dbAll('SELECT * FROM schedule_proposals ORDER BY id'));
    const fpRuns = fp(dbAll('SELECT * FROM schedule_proposal_runs ORDER BY id'));
    const genPub = await api('POST', '/api/schedule/proposals/generate', { month: MONTH2, team_id: TEAM }, admin);
    check('م2: توليد على شهر منشور ⇒ 409 MONTH_PUBLISHED', genPub.status === 409 && genPub.data.code === 'MONTH_PUBLISHED', JSON.stringify(genPub.data));
    const respPub = await api('POST', `/api/my/proposals/${pG4.id}/respond`, { decision: 'accept' }, demo1);
    check('م3: respond على عرض شهر منشور ⇒ 409 MONTH_PUBLISHED', respPub.status === 409 && respPub.data.code === 'MONTH_PUBLISHED');
    check('م4: حالة العرض بقيت offered — النشر لا يغيّر الحالات (صفر كتابة)',
        dbAll('SELECT status FROM schedule_proposals WHERE id = ?', [pG4.id])[0].status === 'offered');
    const wdPub = await api('POST', `/api/schedule/proposals/${pG4.id}/withdraw`, {}, admin);
    check('م5: withdraw على شهر منشور ⇒ 409 MONTH_PUBLISHED', wdPub.status === 409 && wdPub.data.code === 'MONTH_PUBLISHED');
    check('م6: بصمة schedule_proposals ثابتة عبر محاولات النشر الثلاث', fp(dbAll('SELECT * FROM schedule_proposals ORDER BY id')) === fpProps);
    check('م7: بصمة schedule_proposal_runs ثابتة', fp(dbAll('SELECT * FROM schedule_proposal_runs ORDER BY id')) === fpRuns);
    check('م8: GET على شهر منشور يبقى قراءة فقط متاحة',
        (await api('GET', `/api/schedule/proposals?month=${MONTH2}&team_id=${TEAM}`, null, admin)).status === 200);

    console.log('\n── التدقيق والنزاهة ──');
    const audits = (a) => dbAll('SELECT COUNT(*) c FROM audit_log WHERE action = ?', [a])[0].c;
    check('ن1: Audit — 4 تشغيلات (أولى + إعادة + جديدة + شهر النشر) والمحاولات المنشورة بلا قيد', audits('schedule_proposal_run') === 4, 'n=' + audits('schedule_proposal_run'));
    check('ن2: Audit — 5 عروض (3 أولى + 1 جديدة + 1 شهر النشر)', audits('schedule_proposal_offer') === 5, 'n=' + audits('schedule_proposal_offer'));
    check('ن3: Audit — 3 عروض تالية (B/G1 · B/G3 · C/G3)', audits('schedule_proposal_next_offered') === 3, 'n=' + audits('schedule_proposal_next_offered'));
    check('ن4: Audit — 3 ردود (رفض G1 · رفض G3 · قبول G2)', audits('schedule_proposal_respond') === 3);
    check('ن5: Audit — 3 سحوبات (B/G1 · B/G3 · C/G3)', audits('schedule_proposal_withdraw') === 3);
    check('ن6: Audit — gap_resolved واحد + queue_exhausted واحد', audits('schedule_proposal_gap_resolved') === 1 && audits('schedule_proposal_queue_exhausted') === 1);
    check('ن7: بصمة shift_roster ثابتة — E-5 لا يكتب في الجدول إطلاقًا (SSOT مصان)', fp(dbAll('SELECT * FROM shift_roster ORDER BY id')) === rosterFp);
    check('ن8: monthly_required_hours محفوظ (192)', JSON.parse(dbAll("SELECT value FROM app_settings WHERE key = 'monthly_required_hours'")[0].value) === 192);
    // ن9: التحقق من مصدر الحقيقة — config/permissions.js لم يتغير عن HEAD (لا صلاحيات جديدة في E-5)
    const { execSync } = require('child_process');
    const permsNow = fs.readFileSync(path.join(ROOT, 'config', 'permissions.js'), 'utf8');
    const permsHead = execSync('git show HEAD:config/permissions.js', { cwd: ROOT, encoding: 'utf8' });
    const keysNow = (permsNow.match(/'[a-z_.]+':/g) || []).sort();
    const keysHead = (permsHead.match(/'[a-z_.]+':/g) || []).sort();
    check('ن9: config/permissions.js مطابق لـ HEAD — صفر صلاحيات جديدة (E-5)',
        JSON.stringify(keysNow) === JSON.stringify(keysHead));
    check('ن10: الفهرس الجزئي uq_proposals_live_emp_date موجود بنيويًا',
        dbAll("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='uq_proposals_live_emp_date'")[0].c === 1);
    check('ن11: shift_codes لم تُمس (عدد ثابت)', dbAll('SELECT COUNT(*) c FROM shift_codes')[0].c === shiftCodesCountBefore);
    check('ن12: الإشعارات الشخصية للعروض وصلت A (≥4 — dedupe يدمج المتطابق)',
        dbAll("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND title LIKE '%عرض مناوبة تكميلية%'", [String(demoProto.id)])[0].c >= 4);

    await stopServer();
    console.log('');
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
    process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
});
