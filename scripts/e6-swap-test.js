// ═══ E-6 (FSS): اختبار التبديل بالتراضي (M9) — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية.
// يغطي قرارات المالك المعتمدة (M9 + K1–K6، وK2 معدّلًا):
// تقديم باشتقاق خادمي للصفين (K1) · قبول⇒تطبيق ذرّي >48س مع تبديل فعلي للصفين
// + قيدا shift_audit_log بنوع swap ومراجعة consent-swap مشتركة · نفس التاريخ
// صباح↔ليل ينجح (K2) مع تجاهل COVERAGE_BELOW_MINIMUM البنيوي فقط · <48س ⇒
// تصعيد pending_review بلا رفض (K4) · الإعداد من app_settings يغيّر السلوك ·
// فشل E-4 (راحة) ⇒ تصعيد بأسباب وليس رفضًا · approve يطبّق / approve مع فشل
// E-4 ⇒ 409 ويبقى معلقًا (M9: لا كسر ولو بقرار مسؤول) · reject بلا كتابة ·
// decline يغلق · إلغاء المبادر من الحالتين (K5) · سباق roster ⇒ 409 + إلغاء
// ذرّي بصفر كتابة جزئية · شهر منشور لا يمنع M9 · عضوية مفقودة ⇒ 422 ·
// الفهرسان الجزئيان · بصمات roster في مسارات عدم التطبيق · نزاهة (192 ·
// permissions=HEAD · shift_codes ثابتة) · Auth 401/403.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e6-'));
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
// حذف وقائي متسامح — جداول مراحل E الحديثة قد لا توجد في النسخة الخام قبل الإقلاع
function dbRunSafe(sql, params) {
    try { dbRun(sql, params); } catch (e) { if (!/no such table/i.test(e.message)) throw e; }
}
function fp(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function riyadhOffset(n) {
    const p = TimeRiyadh.riyadhParts(new Date());
    const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + n));
    return d.toISOString().slice(0, 10);
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
const audits = (a) => dbAll('SELECT COUNT(*) c FROM audit_log WHERE action = ?', [a])[0].c;

async function main() {
    console.log('═══ E-6 CONSENSUAL SWAP TEST (M9) — بيئة معزولة ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (['DEMO101', 'DEMO102', 'DEMO103'].includes(u.username)) u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    const demo101 = users.find(u => u.username === 'DEMO101');
    const demo102 = users.find(u => u.username === 'DEMO102');
    // ops.my_portal لـ DEMO101/DEMO102 فقط — DEMO103 يبقى بلا بوابة لاختبار 403
    for (const u of [demo101, demo102]) {
        dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e6-test')", [u.id]);
    }

    // ── الشخصيات: A=DEMO101 (مبادر) · B=DEMO102 (هدف) · C=DEMO103 (فريق آخر) ══
    const A = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const B = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const C = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;
    const TEAM2 = dbAll('SELECT id FROM teams WHERE id != ? ORDER BY id LIMIT 1', [TEAM])[0].id;
    const staff = dbAll('SELECT id FROM employees WHERE is_active = 1 AND id NOT IN (?, ?, ?) ORDER BY id LIMIT 7', [A, B, C]).map(r => r.id);
    const [S1, S3, S4, S5, S6, S7] = [staff[0], staff[2], staff[3], staff[4], staff[5], staff[6]];
    if (!(S1 && S7)) throw new Error('موظفون نشطون غير كافين للسيناريو');

    // ── التواريخ (إزاحات من اليوم — الرياض) ══
    const D = (n) => riyadhOffset(n);
    const TODAY = D(0);
    const RANGE_END = D(30);
    const MONTH = D(15).slice(0, 7);

    // ── تنظيف مسرح النطاق (نسخة مؤقتة) ══
    dbRun('DELETE FROM team_assignments WHERE team_id = ?', [TEAM]);
    dbRun('DELETE FROM shift_roster WHERE team_id = ? AND shift_date BETWEEN ? AND ?', [TEAM, TODAY, RANGE_END]);
    dbRun('DELETE FROM shift_roster WHERE employee_id IN (?, ?, ?) AND shift_date BETWEEN ? AND ?', [A, B, C, TODAY, RANGE_END]);
    dbRunSafe('DELETE FROM unable_attend_requests WHERE employee_id IN (?, ?, ?) AND off_date BETWEEN ? AND ?', [A, B, C, TODAY, RANGE_END]);
    dbRun('DELETE FROM leave_requests WHERE employee_id IN (?, ?, ?) AND start_date <= ? AND end_date >= ?', [A, B, C, RANGE_END, TODAY]);
    dbRunSafe("DELETE FROM audit_log WHERE action LIKE 'shift_swap%'");
    dbRunSafe("DELETE FROM schedule_revisions WHERE source = 'consent-swap'");
    dbRunSafe("DELETE FROM shift_audit_log WHERE reason LIKE 'تبديل بالتراضي%'");
    dbRunSafe('DELETE FROM schedule_months WHERE month = ?', [MONTH]);
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.coverage_default', ?)", [JSON.stringify({ day: 2, night: 2, total: 8 })]);
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.coverage_team_overrides', '{}')", []);
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.swap_auto_window_hours', '48')", []);

    // عضويات حية (SSOT): A/B في جنوب 1 · C في فريق آخر (لاختبار K3)
    for (const [id, team] of [[A, TEAM], [B, TEAM], [C, TEAM2]]) {
        dbRun("INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, '2026-01-01', NULL, 1, 'flex-e6-test')", [id, team]);
    }

    // ── صفوف المسرح الأساسية (D12=05:00–17:00 · N12=17:00–05:00) ══
    // A: D12+1 · D12+4 · D12+7 · D12+10 — B: N12+2 · N12+5 · N12+7 · N12+9
    insertRoster(A, TEAM, D(1), 'D12');
    insertRoster(A, TEAM, D(4), 'D12');
    insertRoster(A, TEAM, D(7), 'D12');
    insertRoster(A, TEAM, D(10), 'D12');
    insertRoster(B, TEAM, D(2), 'N12');
    insertRoster(B, TEAM, D(5), 'N12');
    insertRoster(B, TEAM, D(7), 'N12');
    insertRoster(B, TEAM, D(9), 'N12');
    // تغطية +7 لسيناريو K2: day = A+S1 = 2 (عند الحد الأدنى بالضبط) · night = B+S3..S7 = 6 · total = 8
    insertRoster(S1, TEAM, D(7), 'D12');
    for (const s of [S3, S4, S5, S6, S7]) insertRoster(s, TEAM, D(7), 'N12');
    // C في فريق آخر (K3)
    insertRoster(C, TEAM2, D(20), 'D12');

    const shiftCodesCountBefore = dbAll('SELECT COUNT(*) c FROM shift_codes')[0].c;
    await startServer();
    console.log('— الخادم يعمل على :' + PORT + ' —');

    const tokA = await login('DEMO101', 'test123');
    const tokB = await login('DEMO102', 'test123');
    const tokC = await login('DEMO103', 'test123');
    const admin = await login('4252', '4252');

    console.log('\n── الوصول والصلاحيات ──');
    check('أ1: تقديم بلا توكن ⇒ 401', (await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(4), target_shift_date: D(5) }, null)).status === 401);
    check('أ2: تقديم بلا ops.my_portal (DEMO103) ⇒ 403', (await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(4), target_shift_date: D(5) }, tokC)).status === 403);
    check('أ3: قائمة المراجعة بلا schedule.requests.review ⇒ 403', (await api('GET', '/api/schedule/shift-swaps', null, tokA)).status === 403);
    check('أ4: قرار مراجعة بلا الصلاحية ⇒ 403', (await api('POST', '/api/schedule/shift-swaps/1/review', { decision: 'approve' }, tokA)).status === 403);
    check('أ5: قائمة المراجعة للمسؤول تعمل', (await api('GET', '/api/schedule/shift-swaps?status=pending_review', null, admin)).status === 200);

    console.log('\n── تحققات التقديم ──');
    check('ب1: تاريخ ماضٍ ⇒ 422 PAST_DATE', (await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(-1), target_shift_date: D(5) }, tokA)).status === 422);
    const self = await api('POST', '/api/my/shift-swaps', { target_employee_id: A, my_shift_date: D(4), target_shift_date: D(4) }, tokA);
    check('ب2: تبديل مع النفس ⇒ 422 SWAP_SELF', self.status === 422 && self.data.code === 'SWAP_SELF');
    const noRow = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(4), target_shift_date: D(25) }, tokA);
    check('ب3: مناوبة غير موجودة للهدف ⇒ 404 SWAP_ROSTER_NOT_FOUND', noRow.status === 404 && noRow.data.code === 'SWAP_ROSTER_NOT_FOUND');
    const diffTeam = await api('POST', '/api/my/shift-swaps', { target_employee_id: C, my_shift_date: D(4), target_shift_date: D(20) }, tokA);
    check('ب4: فريق مختلف ⇒ 422 SWAP_DIFFERENT_TEAMS (K3)', diffTeam.status === 422 && diffTeam.data.code === 'SWAP_DIFFERENT_TEAMS');
    const badDate = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: '10-2026-04', target_shift_date: D(5) }, tokA);
    check('ب5: صيغة تاريخ خاطئة ⇒ 422 INVALID_DATE', badDate.status === 422 && badDate.data.code === 'INVALID_DATE');

    console.log('\n── ت1: قبول خارج النافذة + فحوصات ناجحة ⇒ تطبيق ذرّي فوري (K1/K4) ──');
    const t1 = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(4), target_shift_date: D(5) }, tokA);
    check('ت1: التقديم نجح ⇒ pending_consent مع اشتقاق خادمي للرمزين',
        t1.status === 200 && t1.data.status === 'pending_consent' && t1.data.id);
    const t1Row = dbAll('SELECT * FROM shift_swap_requests WHERE id = ?', [t1.data.id])[0];
    check('ت2: اللقطات محفوظة — D12 للمبادر وN12 للهدف والفريق والشهر مشتقة خادميًا',
        t1Row.initiator_shift_code === 'D12' && t1Row.target_shift_code === 'N12' && Number(t1Row.team_id) === Number(TEAM) && t1Row.month === D(4).slice(0, 7));
    check('ت3: إشعار شخصي للهدف بطلب التبديل',
        dbAll("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND title LIKE '%طلب تبديل مناوبة%'", [String(demo102.id)])[0].c >= 1);
    // الطرف الخطأ لا يستطيع الرد
    check('ت4: المبادر لا يستطيع الرد على طلبه كهدف ⇒ 403 NOT_SWAP_PARTY',
        (await api('POST', `/api/my/shift-swaps/${t1.data.id}/consent`, { decision: 'accept' }, tokA)).status === 403);
    const t1c = await api('POST', `/api/my/shift-swaps/${t1.data.id}/consent`, { decision: 'accept' }, tokB);
    check('ت5: قبول B (>48س + E-4 سليم للاتجاهين) ⇒ auto_applied',
        t1c.status === 200 && t1c.data.status === 'auto_applied', JSON.stringify(t1c.data));
    const rowA4 = dbAll('SELECT * FROM shift_roster WHERE shift_date = ? AND shift_code = ? AND team_id = ?', [D(4), 'D12', TEAM]);
    const rowB5 = dbAll('SELECT * FROM shift_roster WHERE shift_date = ? AND shift_code = ? AND team_id = ?', [D(5), 'N12', TEAM]);
    check('ت6: التبديل الفعلي — صف +4/D12 أصبح لـ B وصف +5/N12 أصبح لـ A',
        rowA4.length === 1 && Number(rowA4[0].employee_id) === Number(B) && rowB5.length === 1 && Number(rowB5[0].employee_id) === Number(A));
    const t1Audits = dbAll("SELECT * FROM shift_audit_log WHERE reason LIKE 'تبديل بالتراضي%' ORDER BY id");
    check('ت7: قيدا shift_audit_log بنوع swap ومراجعة مشتركة (نمط F-1)',
        t1Audits.length === 2 && t1Audits.every(x => x.change_type === 'swap') && t1Audits[0].revision_id && Number(t1Audits[0].revision_id) === Number(t1Audits[1].revision_id));
    const t1Rev = dbAll("SELECT * FROM schedule_revisions WHERE source = 'consent-swap' ORDER BY id");
    check('ت8: مراجعة consent-swap واحدة تربط القيدين مع stats التبديل',
        t1Rev.length === 1 && JSON.parse(t1Rev[0].stats_json).swap_request_id === t1.data.id && JSON.parse(t1Rev[0].stats_json).auto === true);
    check('ت9: إشعار اطلاعي للمراجعين بالتطبيق التلقائي (M9)',
        dbAll("SELECT COUNT(*) c FROM notifications WHERE title LIKE '%طُبّق تلقائيًا%'")[0].c >= 1);
    check('ت10: إعادة الرد على طلب مطبَّق ⇒ 409 SWAP_ALREADY_PROCESSED',
        (await api('POST', `/api/my/shift-swaps/${t1.data.id}/consent`, { decision: 'accept' }, tokB)).status === 409);

    console.log('\n── ت11: نفس التاريخ صباح↔ليل ينجح (K2 المعدّل) مع تجاهل التغطية البنيوية ──');
    const t2 = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(7), target_shift_date: D(7) }, tokA);
    check('ت11: تقديم نفس-التاريخ مقبول ⇒ pending_consent', t2.status === 200 && t2.data.status === 'pending_consent');
    const t2c = await api('POST', `/api/my/shift-swaps/${t2.data.id}/consent`, { decision: 'accept' }, tokB);
    check('ت12: نفس التاريخ (A:D12 ↔ B:N12 يوم +7) ⇒ auto_applied رغم day عند الحد الأدنى (COVERAGE_BELOW_MINIMUM بنيوية مُتجاهلة وحدها)',
        t2c.status === 200 && t2c.data.status === 'auto_applied', JSON.stringify(t2c.data));
    const a7 = dbAll('SELECT shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [A, D(7)]);
    const b7 = dbAll('SELECT shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [B, D(7)]);
    check('ت13: بعد التبديل كلٌّ بمناوبة واحدة في اليوم — A:N12 وB:D12 (M7 محفوظة)',
        a7.length === 1 && a7[0].shift_code === 'N12' && b7.length === 1 && b7[0].shift_code === 'D12');

    console.log('\n── ت14: داخل نافذة 48س ⇒ تصعيد (K4) ثم اعتماد المسؤول يطبّق ──');
    const t3 = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(1), target_shift_date: D(2) }, tokA);
    const t3c = await api('POST', `/api/my/shift-swaps/${t3.data.id}/consent`, { decision: 'accept' }, tokB);
    check('ت14: قبول داخل النافذة (D12 غدًا 05:00) ⇒ pending_review وليس تطبيقًا',
        t3c.status === 200 && t3c.data.status === 'pending_review', JSON.stringify(t3c.data));
    const esc3 = JSON.parse(t3c.data.escalation_reason || '{}');
    check('ت15: escalation_reason قابل للتفسير — window=true والاتجاهان سليمان',
        esc3.window === true && esc3.dir_initiator.valid === true && esc3.dir_target.valid === true, t3c.data.escalation_reason);
    check('ت16: roster لم يتغير عند التصعيد — A ما زال D12+1',
        dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ? AND shift_code = ?', [A, D(1), 'D12'])[0].c === 1);
    check('ت17: قائمة المراجعة تعرض الطلب المُصعَّد مع الأسماء',
        (await api('GET', '/api/schedule/shift-swaps?status=pending_review', null, admin)).data.requests.some(r => Number(r.id) === Number(t3.data.id) && r.initiator_name && r.target_name));
    const t3a = await api('POST', `/api/schedule/shift-swaps/${t3.data.id}/review`, { decision: 'approve', note: 'موافقة تشغيلية' }, admin);
    check('ت18: اعتماد المسؤول ⇒ applied (النافذة لا تمنع المسؤول — K4)', t3a.status === 200 && t3a.data.status === 'applied');
    check('ت19: التبديل طُبّق — A أصبح N12+2 وB أصبح D12+1',
        dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ? AND shift_code = ?', [A, D(2), 'N12'])[0].c === 1 &&
        dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ? AND shift_code = ?', [B, D(1), 'D12'])[0].c === 1);
    check('ت20: reviewed_by/at والملاحظة محفوظة',
        (() => { const r = dbAll('SELECT * FROM shift_swap_requests WHERE id = ?', [t3.data.id])[0]; return r.reviewed_by && r.reviewed_at && r.review_note === 'موافقة تشغيلية'; })());

    console.log('\n── ت21: فشل E-4 (راحة) ⇒ تصعيد بأسباب · approve ⇒ 409 · reject بلا كتابة ──');
    const t4 = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(10), target_shift_date: D(9) }, tokA);
    const t4c = await api('POST', `/api/my/shift-swaps/${t4.data.id}/consent`, { decision: 'accept' }, tokB);
    check('ت21: N12+9 ملاصقة لـ D12+10 (راحة 0س — تحفظ موثق) ⇒ pending_review وليس رفضًا',
        t4c.status === 200 && t4c.data.status === 'pending_review', JSON.stringify(t4c.data));
    const esc4 = JSON.parse(t4c.data.escalation_reason || '{}');
    check('ت22: الاتجاهان فاشلان بأسباب راحة موثقة والنافذة خارج الحسبان',
        esc4.window === false && esc4.dir_initiator.valid === false && esc4.dir_target.valid === false &&
        esc4.dir_initiator.reasons.length > 0 && esc4.dir_target.reasons.length > 0, t4c.data.escalation_reason);
    const queue = await api('GET', '/api/schedule/shift-swaps?status=pending_review', null, admin);
    check('ت23: قائمة المراجعة تعرض هذا الطلب وحده (السابق اعتُمد/أُلغي)',
        queue.data.requests.length === 1 && Number(queue.data.requests[0].id) === Number(t4.data.id), JSON.stringify(queue.data.requests.map(r => r.id)));
    const t4a = await api('POST', `/api/schedule/shift-swaps/${t4.data.id}/review`, { decision: 'approve' }, admin);
    check('ت24: اعتماد رغم فشل E-4 ⇒ 409 SWAP_VALIDATION_FAILED (M9: لا كسر ولو بقرار مسؤول)',
        t4a.status === 409 && t4a.data.code === 'SWAP_VALIDATION_FAILED', JSON.stringify(t4a.data));
    check('ت25: الطلب يبقى pending_review بعد الـ409',
        dbAll('SELECT status FROM shift_swap_requests WHERE id = ?', [t4.data.id])[0].status === 'pending_review');
    const fpBeforeReject = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));
    const t4r = await api('POST', `/api/schedule/shift-swaps/${t4.data.id}/review`, { decision: 'reject', note: 'تعارض راحة' }, admin);
    check('ت26: الرفض ⇒ rejected بصفر كتابة على roster (بصمة ثابتة)',
        t4r.status === 200 && t4r.data.status === 'rejected' && fp(dbAll('SELECT * FROM shift_roster ORDER BY id')) === fpBeforeReject);
    check('ت27: إشعار شخصي بالرفض للطرفين',
        dbAll("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND title LIKE '%رُفض طلب التبديل%'", [String(demo101.id)])[0].c >= 1 &&
        dbAll("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND title LIKE '%رُفض طلب التبديل%'", [String(demo102.id)])[0].c >= 1);

    console.log('\n── ت28: النافذة من app_settings (config-driven) ثم إلغاء من pending_review (K5) ──');
    insertRoster(A, TEAM, D(6), 'D12');
    insertRoster(B, TEAM, D(8), 'N12');
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.swap_auto_window_hours', '200')", []);
    const t5 = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(6), target_shift_date: D(8) }, tokA);
    const t5c = await api('POST', `/api/my/shift-swaps/${t5.data.id}/consent`, { decision: 'accept' }, tokB);
    check('ت28: بنافذة 200س، تبديل بعد 6 أيام يصعّد — الإعداد يُحترم ولا Hard-code',
        t5c.status === 200 && t5c.data.status === 'pending_review' && JSON.parse(t5c.data.escalation_reason).window === true, JSON.stringify(t5c.data));
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.swap_auto_window_hours', '48')", []);
    const t5x = await api('POST', `/api/my/shift-swaps/${t5.data.id}/cancel`, {}, tokA);
    check('ت29: إلغاء المبادر من pending_review ⇒ cancelled (K5)', t5x.status === 200 && t5x.data.status === 'cancelled');
    check('ت30: الإلغاء بلا حذف فعلي — السجل باقٍ بحالة cancelled',
        dbAll('SELECT status FROM shift_swap_requests WHERE id = ?', [t5.data.id])[0].status === 'cancelled');

    console.log('\n── ت31: سباق roster خارجي ⇒ 409 + إلغاء ذرّي بصفر كتابة جزئية ──');
    insertRoster(A, TEAM, D(3), 'D12');
    insertRoster(B, TEAM, D(3), 'N12');
    const t6 = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(3), target_shift_date: D(3) }, tokA);
    check('ت31: التقديم على +3 نجح', t6.status === 200 && t6.data.status === 'pending_consent');
    dbRun("UPDATE shift_roster SET shift_code = 'D10' WHERE employee_id = ? AND shift_date = ?", [A, D(3)]); // سباق خارجي
    const fpBeforeRace = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));
    const t6c = await api('POST', `/api/my/shift-swaps/${t6.data.id}/consent`, { decision: 'accept' }, tokB);
    check('ت32: تغيّرت اللقطة ⇒ 409 SWAP_ROSTER_CHANGED', t6c.status === 409 && t6c.data.code === 'SWAP_ROSTER_CHANGED', JSON.stringify(t6c.data));
    check('ت33: الطلب أُلغي ذرّيًا (roster_changed_at_consent) وبصمة roster ثابتة — صفر كتابة جزئية',
        dbAll("SELECT status, escalation_reason FROM shift_swap_requests WHERE id = ?", [t6.data.id])[0].status === 'cancelled' &&
        dbAll("SELECT escalation_reason FROM shift_swap_requests WHERE id = ?", [t6.data.id])[0].escalation_reason === 'roster_changed_at_consent' &&
        fp(dbAll('SELECT * FROM shift_roster ORDER BY id')) === fpBeforeRace);

    console.log('\n── ت34: الشهر المنشور لا يمنع M9 ──');
    insertRoster(A, TEAM, D(15), 'D12');
    insertRoster(B, TEAM, D(16), 'N12');
    dbRun("INSERT INTO schedule_months (month, status, published_by, published_at) VALUES (?, 'published', 1, datetime('now'))", [MONTH]);
    const t7 = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(15), target_shift_date: D(16) }, tokA);
    const t7c = await api('POST', `/api/my/shift-swaps/${t7.data.id}/consent`, { decision: 'accept' }, tokB);
    check('ت34: شهر منشور ⇒ التقديم والقبول والتطبيق التلقائي كلها تعمل (M9 مستقل عن M13)',
        t7.status === 200 && t7c.status === 200 && t7c.data.status === 'auto_applied', JSON.stringify(t7c.data));
    check('ت35: التبديل طُبّق فعليًا رغم النشر — B على D12+15 وA على N12+16',
        dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ? AND shift_code = ?', [B, D(15), 'D12'])[0].c === 1 &&
        dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ? AND shift_code = ?', [A, D(16), 'N12'])[0].c === 1);

    console.log('\n── ت36: الازدحام + الإلغاء من pending_consent + الرفض من الطرف الثاني ──');
    insertRoster(A, TEAM, D(18), 'D12');
    insertRoster(B, TEAM, D(19), 'N12');
    insertRoster(B, TEAM, D(20), 'N12');
    const t9a = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(18), target_shift_date: D(19) }, tokA);
    check('ت36: التقديم الأول نجح', t9a.status === 200 && t9a.data.status === 'pending_consent');
    const busy = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(18), target_shift_date: D(20) }, tokA);
    check('ت37: طلب ثانٍ على صفٍّ مشغول ⇒ 409 SWAP_ROW_BUSY', busy.status === 409 && busy.data.code === 'SWAP_ROW_BUSY');
    // الفهرس الجزئي حارس بنيوي: INSERT مباشر لطلب حيٍّ ثانٍ لنفس (مبادر، تاريخ)
    let indexBlocked = false;
    try {
        dbRun(`INSERT INTO shift_swap_requests (initiator_employee_id, target_employee_id, initiator_date, initiator_shift_code,
               target_date, target_shift_code, team_id, month, status, created_by)
               VALUES (?, ?, ?, 'D12', ?, 'N12', ?, ?, 'pending_consent', 1)`, [A, B, D(18), D(20), TEAM, MONTH]);
    } catch (e) { indexBlocked = /UNIQUE/i.test(e.message); }
    check('ت38: INSERT مباشر لطلب حيٍّ ثانٍ على نفس (مبادر، تاريخ) ⇒ رفض UNIQUE (uq_swap_live_initiator)', indexBlocked);
    const t9b = await api('POST', `/api/my/shift-swaps/${t9a.data.id}/cancel`, {}, tokA);
    check('ت39: إلغاء المبادر من pending_consent ⇒ cancelled (K5)', t9b.status === 200 && t9b.data.status === 'cancelled');
    const t9c = await api('POST', '/api/my/shift-swaps', { target_employee_id: B, my_shift_date: D(18), target_shift_date: D(19) }, tokA);
    check('ت40: إعادة التقديم بعد الإلغاء تعمل (الصف تحرر)', t9c.status === 200 && t9c.data.status === 'pending_consent');
    const fpBeforeDecline = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));
    const t9d = await api('POST', `/api/my/shift-swaps/${t9c.data.id}/consent`, { decision: 'decline' }, tokB);
    check('ت41: رفض الطرف الثاني ⇒ declined_by_peer — إغلاق نهائي بلا تصعيد وبصفر كتابة roster',
        t9d.status === 200 && t9d.data.status === 'declined_by_peer' && fp(dbAll('SELECT * FROM shift_roster ORDER BY id')) === fpBeforeDecline);
    check('ت42: إشعار المبادر برفض الطرف الثاني',
        dbAll("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND title LIKE '%رُفض طلب التبديل%'", [String(demo101.id)])[0].c >= 1);
    check('ت43: إعادة الرد على طلب مغلق ⇒ 409', (await api('POST', `/api/my/shift-swaps/${t9c.data.id}/consent`, { decision: 'accept' }, tokB)).status === 409);
    const mine = await api('GET', '/api/my/shift-swaps', null, tokA);
    check('ت44: GET /api/my/shift-swaps يعرض كل طلباتي (9) مع أسماء الطرفين والفريق',
        mine.status === 200 && mine.data.requests.length === 9 && mine.data.requests.every(r => r.initiator_name && r.target_name && r.team_name),
        'n=' + (mine.data.requests || []).length);

    console.log('\n── التدقيق والنزاهة ──');
    check('ن1: Audit — 9 تقديمات', audits('shift_swap_submit') === 9, 'n=' + audits('shift_swap_submit'));
    check('ن2: Audit — 4 تطبيقات (ت1·K2·اعتماد ت3·المنشور)', audits('shift_swap_apply') === 4, 'n=' + audits('shift_swap_apply'));
    check('ن3: Audit — 3 تصعيدات (نافذة ت3 · راحة ت4 · نافذة 200س)', audits('shift_swap_escalate') === 3, 'n=' + audits('shift_swap_escalate'));
    check('ن4: Audit — رفض مسؤول واحد + إلغاءان + إلغاء سباق واحد + رفض طرف ثانٍ واحد',
        audits('shift_swap_review') === 1 && audits('shift_swap_cancel') === 2 && audits('shift_swap_stale_cancel') === 1 && audits('shift_swap_consent') === 1);
    check('ن5: shift_audit_log — 8 قيود swap (4 تطبيقات × 2) كلها بمراجعة مشتركة لكل تبديل',
        dbAll("SELECT COUNT(*) c FROM shift_audit_log WHERE reason LIKE 'تبديل بالتراضي%' AND change_type = 'swap'")[0].c === 8);
    check('ن6: schedule_revisions — 4 مراجعات consent-swap',
        dbAll("SELECT COUNT(*) c FROM schedule_revisions WHERE source = 'consent-swap'")[0].c === 4);
    check('ن7: الفهرسان الجزئيان موجودان بنيويًا',
        dbAll("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name IN ('uq_swap_live_initiator','uq_swap_live_target')")[0].c === 2);
    check('ن8: monthly_required_hours محفوظ (192)',
        JSON.parse(dbAll("SELECT value FROM app_settings WHERE key = 'monthly_required_hours'")[0].value) === 192);
    const { execSync } = require('child_process');
    const permsNow = fs.readFileSync(path.join(ROOT, 'config', 'permissions.js'), 'utf8');
    const permsHead = execSync('git show HEAD:config/permissions.js', { cwd: ROOT, encoding: 'utf8' });
    check('ن9: config/permissions.js مطابق لـ HEAD — صفر صلاحيات جديدة (E-6)',
        JSON.stringify((permsNow.match(/'[a-z_.]+':/g) || []).sort()) === JSON.stringify((permsHead.match(/'[a-z_.]+':/g) || []).sort()));
    check('ن10: shift_codes لم تُمس (عدد ثابت)', dbAll('SELECT COUNT(*) c FROM shift_codes')[0].c === shiftCodesCountBefore);
    check('ن11: لا طلبات بقيت عالقة بحالة غير نهائية غير مفسَّرة — الكل إما مطبق أو مغلق',
        dbAll("SELECT COUNT(*) c FROM shift_swap_requests WHERE status = 'pending_consent'")[0].c === 0 &&
        dbAll("SELECT COUNT(*) c FROM shift_swap_requests WHERE status = 'pending_review'")[0].c === 0);

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
