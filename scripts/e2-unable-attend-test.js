// ═══ E-2 (FSS): اختبار طلبات عدم التمكّن — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية.
// يغطي: M1 (حد 4 = مسار طبيعي لا رفض، الخامس+ استثناء إجباري) · M2 (فحص تغطية
// لحظي عبر مهايئ M4: نظيف⇒auto_approved · تعارض⇒تصعيد لا رفض · غياب roster⇒
// auto_approved) · د1 (إلغاء المالك للحالات الثلاث — المستقبل فقط) · د2 (لا
// إجراء آلي للماضي) · المراجعة بقفل شرطي 409 · Audit ذرّي · صفر كتابة roster.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3098;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e2-'));
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

async function main() {
    console.log('═══ E-2 UNABLE-ATTEND TEST — بيئة معزولة ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (['DEMO101', 'DEMO102', 'DEMO103'].includes(u.username)) u.password = hash; });
    const demoProto = users.find(u => u.username === 'DEMO101');
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e2-test')", [demoProto.id]);
    const demo2User = users.find(u => u.username === 'DEMO102');
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e2-test')", [demo2User.id]);

    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    // كادر ليلي إضافي لسيناريو التغطية (قاعدة M4 تفحص night أيضًا)
    const EMP_NIGHT = dbAll('SELECT id FROM employees WHERE is_active = 1 AND id NOT IN (?, ?, ?) ORDER BY id LIMIT 1', [EMP1, EMP2, EMP3])[0].id;
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;

    // تواريخ السيناريوهات (بتوقيت الرياض)
    const D_AUTO = riyadhOffset(10);   // تغطية سليمة ⇒ auto_approved
    const D_BREAK = riyadhOffset(11);  // كسر تغطية ⇒ pending_review
    const D_NOROSTER = riyadhOffset(14); // لا roster ⇒ auto_approved (M2: ليس ضمانًا)
    const D_REVIVE = riyadhOffset(15); // إلغاء ثم إعادة تقديم (إحياء السجل)
    const D_PAST = riyadhOffset(-1);

    // Team Override محدود للاختبار عبر إعدادات E-0 (M4: نفس القواعد، قيم مختلفة للفريق)
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.coverage_team_overrides', ?)",
        [JSON.stringify({ [String(TEAM)]: { day: 1, night: 1, total: 2 } })]);

    // سيناريو D_AUTO: الفريق = DEMO101(day) + 2(day) + 1(night) → بعد الخروج day=2,night=1,total=3 ⇒ سليم (day≥1,night≥1,total≥2)
    dbRun('DELETE FROM shift_roster WHERE shift_date IN (?, ?)', [D_AUTO, D_BREAK]);
    insertRoster(EMP1, TEAM, D_AUTO, 'D12');
    insertRoster(EMP2, TEAM, D_AUTO, 'D12');
    insertRoster(EMP3, TEAM, D_AUTO, 'D12');
    insertRoster(EMP_NIGHT, TEAM, D_AUTO, 'N12');
    // سيناريو D_BREAK: الفريق = DEMO101(day) + 1(day) → بعد الخروج night=0<1 وtotal=1<2 ⇒ يكسر
    insertRoster(EMP1, TEAM, D_BREAK, 'D12');
    insertRoster(EMP2, TEAM, D_BREAK, 'D12');

    const rosterFpBefore = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));
    await startServer();
    console.log('— الخادم يعمل على :' + PORT + ' —');
    dbRun('DELETE FROM unable_attend_requests', []);
    dbRun("DELETE FROM audit_log WHERE action LIKE 'unable_attend%'", []);
    const demo1 = await login('DEMO101', 'test123');
    const demo2 = await login('DEMO102', 'test123');
    const admin = await login('4252', '4252');

    console.log('\n── الوصول والصلاحيات ──');
    check('أ1: بلا توكن ⇒ 401', (await api('GET', '/api/my/unable-attend', null, null)).status === 401);
    const noPermDemo3 = await login('DEMO103', 'test123');
    check('أ2: بلا ops.my_portal ⇒ 403', (await api('GET', '/api/my/unable-attend', null, noPermDemo3)).status === 403);
    check('أ3: قائمة المراجعة بلا schedule.requests.review ⇒ 403', (await api('GET', '/api/schedule/unable-attend', null, demo1)).status === 403);
    check('أ4: قرار مراجعة بلا schedule.requests.review ⇒ 403', (await api('POST', '/api/schedule/unable-attend/1/review', { decision: 'approve' }, demo1)).status === 403);

    console.log('\n── التحققات ──');
    const badDate = await api('POST', '/api/my/unable-attend', { off_date: '06-10-2026' }, demo1);
    check('ب1: صيغة خاطئة ⇒ 422 INVALID_OFF_DATE', badDate.status === 422 && badDate.data.code === 'INVALID_OFF_DATE');
    const pastDate = await api('POST', '/api/my/unable-attend', { off_date: D_PAST }, demo1);
    check('ب2: تاريخ ماضٍ ⇒ 422 PAST_DATE (د2: المنع عند الإنشاء)', pastDate.status === 422 && pastDate.data.code === 'PAST_DATE');

    console.log('\n── M2: فحص التغطية اللحظي ──');
    const auto = await api('POST', '/api/my/unable-attend', { off_date: D_AUTO, reason: 'موعد' }, demo1);
    check('ج1: تغطية سليمة ⇒ auto_approved فورًا', auto.status === 200 && auto.data.status === 'auto_approved', JSON.stringify(auto.data));
    const noRoster = await api('POST', '/api/my/unable-attend', { off_date: D_NOROSTER }, demo1);
    check('ج2: غياب roster لليوم ⇒ auto_approved (إعادة التحقق عند التوليد لاحقًا — M2)', noRoster.status === 200 && noRoster.data.status === 'auto_approved');
    const esc = await api('POST', '/api/my/unable-attend', { off_date: D_BREAK, reason: 'ظرف' }, demo1);
    check('ج3: كسر تغطية ⇒ pending_review (تصعيد، **ليس رفضًا**)', esc.status === 200 && esc.data.status === 'pending_review', JSON.stringify(esc.data));
    check('ج4: المصعَّد ليس مرفوضًا — status ≠ rejected', esc.data.status !== 'rejected');
    const dup = await api('POST', '/api/my/unable-attend', { off_date: D_AUTO }, demo1);
    check('ج5: نفس اليوم مرة أخرى ⇒ 422 DUPLICATE_UNABLE_DATE', dup.status === 422 && dup.data.code === 'DUPLICATE_UNABLE_DATE');
    const escNotify = dbAll("SELECT * FROM notifications WHERE title LIKE '%عدم تمكّن%يحتاج مراجعة%'");
    check('ج6: التصعيد أشعر حاملي schedule.requests.review (بعد COMMIT)', escNotify.length >= 1, 'rows=' + escNotify.length);

    console.log('\n── M1: حد الأيام = مسار طبيعي لا رفض ──');
    // D_AUTO وD_NOROSTER حيّان (2) + D_BREAK معلّق (3) — نضيف الرابع ثم الخامس
    const fourth = await api('POST', '/api/my/unable-attend', { off_date: riyadhOffset(16) }, demo1);
    check('د1: الطلب الرابع ⇒ auto_approved (ما زال ضمن حد 4)', fourth.status === 200 && fourth.data.status === 'auto_approved' && fourth.data.is_exception === 0);
    const fifth = await api('POST', '/api/my/unable-attend', { off_date: riyadhOffset(17) }, demo1);
    check('د2: الطلب الخامس ⇒ pending_review + is_exception=1 (إجباريًا — M1)', fifth.status === 200 && fifth.data.status === 'pending_review' && fifth.data.is_exception === 1, JSON.stringify(fifth.data));
    check('د3: الخامس لم يُرفض — التجاوز ليس رفضًا آليًا', fifth.data.status !== 'rejected');
    const mine = await api('GET', '/api/my/unable-attend?month=' + D_AUTO.slice(0, 7), null, demo1);
    check('د4: طلباتي تعرض max_days=4 وlive_count=5', mine.status === 200 && mine.data.max_days === 4 && mine.data.live_count === 5, JSON.stringify({ max: mine.data.max_days, live: mine.data.live_count }));

    console.log('\n── المراجعة (schedule.requests.review) ──');
    const queue = await api('GET', '/api/schedule/unable-attend', null, admin);
    const escRow = queue.data.requests.find(r => r.off_date === D_BREAK);
    check('ه1: القائمة تعرض المصعَّدين مُثرين (اسم/كود/فريق)', queue.status === 200 && escRow && escRow.employee_name && escRow.employee_code === 'DEMO101' && queue.data.requests.length === 2);
    const badDecision = await api('POST', '/api/schedule/unable-attend/' + esc.data.id + '/review', { decision: 'maybe' }, admin);
    check('ه2: قرار غير صالح ⇒ 422 INVALID_REVIEW_DECISION', badDecision.status === 422 && badDecision.data.code === 'INVALID_REVIEW_DECISION');
    const approve = await api('POST', '/api/schedule/unable-attend/' + esc.data.id + '/review', { decision: 'approve', note: 'تغطية مؤمنة' }, admin);
    check('ه3: اعتماد المصعَّد ⇒ approved', approve.status === 200 && approve.data.status === 'approved');
    const approveAgain = await api('POST', '/api/schedule/unable-attend/' + esc.data.id + '/review', { decision: 'approve' }, admin);
    check('ه4: إعادة مراجعة معالَج ⇒ 409 UNABLE_ALREADY_PROCESSED (قفل شرطي)', approveAgain.status === 409 && approveAgain.data.code === 'UNABLE_ALREADY_PROCESSED');
    const reject5 = await api('POST', '/api/schedule/unable-attend/' + fifth.data.id + '/review', { decision: 'reject' }, admin);
    check('ه5: رفض الخامس (بلا ملاحظة — د3 اختيارية) ⇒ rejected', reject5.status === 200 && reject5.data.status === 'rejected');
    const ownerNotif = dbAll("SELECT * FROM notifications WHERE user_id = ? AND title LIKE '%عدم التمكّن%' ORDER BY id DESC LIMIT 2", [String(demoProto.id)]);
    check('ه6: صاحب الطلب أُشعر بنتيجتي المراجعة (اعتماد+رفض)', ownerNotif.length === 2, 'rows=' + ownerNotif.length);

    console.log('\n── د1: إلغاء المالك ──');
    const cancelApproved = await api('POST', '/api/my/unable-attend/' + esc.data.id + '/cancel', {}, demo1);
    check('و1: إلغاء approved (مستقبل) ⇒ cancelled', cancelApproved.status === 200 && cancelApproved.data.status === 'cancelled');
    const keptReview = dbAll('SELECT status, reviewed_by, reviewed_at FROM unable_attend_requests WHERE id = ?', [esc.data.id])[0];
    check('و2: أثر الموافقة محفوظ بعد الإلغاء (reviewed_by/at لم تُمس)', keptReview.status === 'cancelled' && keptReview.reviewed_by != null && keptReview.reviewed_at != null);
    const cancelAgain = await api('POST', '/api/my/unable-attend/' + esc.data.id + '/cancel', {}, demo1);
    check('و3: إلغاء ملغى ⇒ 409 UNABLE_ALREADY_PROCESSED', cancelAgain.status === 409 && cancelAgain.data.code === 'UNABLE_ALREADY_PROCESSED');
    const notOwner = await api('POST', '/api/my/unable-attend/' + auto.data.id + '/cancel', {}, demo2);
    check('و4: إلغاء طلب غيرك ⇒ 403 NOT_REQUEST_OWNER', notOwner.status === 403 && notOwner.data.code === 'NOT_REQUEST_OWNER');
    // طلب ماضٍ (مُدرج مباشرة لمحاكاة د2: لا إجراء آلي عليه)
    dbRun("INSERT INTO unable_attend_requests (employee_id, month, off_date, status, created_by) VALUES (?, ?, ?, 'approved', ?)", [EMP1, D_PAST.slice(0, 7), D_PAST, String(demoProto.id)]);
    const pastReq = dbAll('SELECT id FROM unable_attend_requests WHERE off_date = ?', [D_PAST])[0];
    const cancelPast = await api('POST', '/api/my/unable-attend/' + pastReq.id + '/cancel', {}, demo1);
    check('و5: إلغاء طلب دخل تاريخه الماضي ⇒ 409 UNABLE_DATE_PAST', cancelPast.status === 409 && cancelPast.data.code === 'UNABLE_DATE_PAST');
    const pastStill = dbAll('SELECT status FROM unable_attend_requests WHERE id = ?', [pastReq.id])[0];
    check('و6: د2: السجل الماضي بقي كما هو — لا Auto-cancel آلي', pastStill.status === 'approved');

    console.log('\n── الإحياء (UNIQUE employee+off_date) ──');
    const cancelAuto = await api('POST', '/api/my/unable-attend/' + auto.data.id + '/cancel', {}, demo1);
    check('ز1: إلغاء auto_approved ⇒ cancelled', cancelAuto.status === 200);
    const revive = await api('POST', '/api/my/unable-attend', { off_date: D_AUTO }, demo1);
    check('ز2: إعادة التقديم لنفس اليوم بعد الإلغاء ⇒ نجاح بإحياء السجل نفسه (لا صف مكرر)',
        revive.status === 200 && Number(revive.data.id) === Number(auto.data.id), 'id=' + revive.data.id + ' vs ' + auto.data.id);
    const reviveRows = dbAll('SELECT * FROM unable_attend_requests WHERE employee_id = ? AND off_date = ?', [EMP1, D_AUTO]);
    check('ز3: صف واحد فقط لذلك اليوم (UNIQUE مصان)', reviveRows.length === 1);

    console.log('\n── التدقيق والعزل ──');
    const submitAudits = dbAll("SELECT * FROM audit_log WHERE action = 'unable_attend_submit'");
    // التقديمات الناجحة فعليًا: auto, noRoster, esc, fourth, fifth, revive = 6 (كل 422 فاشل بلا قيد)
    check('ح1: بالضبط 6 قيود Audit = التقديمات الناجحة فقط (ذرّية التدقيق مع الكتابة)', submitAudits.length === 6 && submitAudits.every(a => a.detail.includes('DEMO101')), 'audits=' + submitAudits.length);
    const reviewAudits = dbAll("SELECT * FROM audit_log WHERE action = 'unable_attend_review'");
    check('ح2: قيدا مراجعة (اعتماد+رفض) بفاعل مشتق خادميًا', reviewAudits.length === 2 && reviewAudits.every(a => a.user_name), 'audits=' + reviewAudits.length);
    const rosterFpAfter = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));
    check('ح3: بصمة shift_roster ثابتة — E-2 لا يكتب في الجدول إطلاقًا', rosterFpBefore === rosterFpAfter);
    const emp2Rows = dbAll('SELECT * FROM unable_attend_requests WHERE employee_id = ?', [EMP2]);
    check('ح4: عزل الموظفين — لا طلبات لـ DEMO102 من عمليات DEMO101', emp2Rows.length === 0);
    const mrh = dbAll("SELECT value FROM app_settings WHERE key = 'monthly_required_hours'");
    check('ح5: monthly_required_hours محفوظ (192)', mrh.length === 1 && JSON.parse(mrh[0].value) === 192);
    check('ح6: عدم التمكّن مستقل — صفر تفاعل مع leave_requests', dbAll("SELECT COUNT(*) c FROM leave_requests WHERE employee_id = ? AND type LIKE '%عدم%'", [EMP1])[0].c === 0);

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
