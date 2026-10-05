// F-1 (الجدول المرن): اختبار تطبيق اعتماد طلب تغيير المناوبة على shift_roster.
// بيئة معزولة بالكامل (نسخة VACUUM مؤقتة + users.json مؤقت) — لا يلمس data/ الحقيقية.
// يغطي: التطبيق edit/add · القيمة القديمة الفعلية · منع الاعتماد المزدوج (409)
// · الرمز غير الصالح (409 + pending) · الموظف غير النشط (409 + pending)
// · denied/cancelled بلا كتابة · الصلاحية requests.review · التدقيق (revision+audit)
// · عزل بقية الأيام وteam_assignments وpattern_code · إشعار notification_log · SSE.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3096;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-f1-'));
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

function listenSSE(token) {
    const listeners = [];
    const req = http.get(BASE + '/api/sse?token=' + encodeURIComponent(token), (res) => {
        let buf = '';
        res.on('data', (chunk) => {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
                const line = frame.split('\n').find(l => l.startsWith('data:'));
                if (!line) continue;
                let msg = null;
                try { msg = JSON.parse(line.slice(5).trim()); } catch (e) {}
                if (msg) listeners.slice().forEach(fn => fn(msg));
            }
        });
    });
    req.on('error', () => {});
    return {
        waitFor(pred, ms) {
            return new Promise((resolve) => {
                const fn = (msg) => { if (pred(msg)) { cleanup(); resolve(msg); } };
                const cleanup = () => {
                    clearTimeout(to);
                    const i = listeners.indexOf(fn);
                    if (i >= 0) listeners.splice(i, 1);
                };
                const to = setTimeout(() => { cleanup(); resolve(null); }, ms || 6000);
                listeners.push(fn);
            });
        },
        close() { try { req.destroy(); } catch (e) {} }
    };
}

function dbAll(sql, params) {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB, { readonly: true });
    const rows = db.prepare(sql).all(...(params || []));
    db.close();
    return rows;
}
function dbRun(sql, params) {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    db.prepare(sql).run(...(params || []));
    db.close();
}
function fp(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }

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
function plusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const my = (date) => ({ month: Number(date.slice(5, 7)), year: Number(date.slice(0, 4)) });

async function main() {
    console.log('═══ F-1 SHIFT-CHANGE APPLY TEST — بيئة معزولة ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (u.username === 'DEMO101' || u.username === 'DEMO102') u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));

    // ── تهيئة حتمية: رموز معتمدة + موظفون + تواريخ نظيفة ──
    const codes = dbAll('SELECT code FROM shift_codes ORDER BY code LIMIT 5').map(r => r.code);
    if (codes.length < 2) throw new Error('يحتاج الاختبار رمزين معتمدين على الأقل في shift_codes');
    const C1 = codes[0], C2 = codes[1];
    console.log('رموز الاختبار: ' + C1 + ' / ' + C2);
    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const D_EDIT = plusDays(30), D_ADD = plusDays(60), D_DENY = plusDays(70), D_CANCEL = plusDays(75), D_BADCODE = plusDays(80), D_INACTIVE = plusDays(85);
    // نظّف أي سطر محتمل مسبقًا في النسخة المؤقتة لضمان الحتمية
    for (const [emp, dt] of [[EMP1, D_EDIT], [EMP2, D_ADD], [EMP1, D_DENY], [EMP1, D_CANCEL], [EMP1, D_BADCODE], [EMP3, D_INACTIVE]]) {
        dbRun('DELETE FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [emp, dt]);
    }
    const assignFpBefore = fp(dbAll('SELECT * FROM team_assignments WHERE employee_id IN (?, ?) ORDER BY id', [EMP1, EMP2]));
    const patternBefore = dbAll('SELECT id, pattern_code FROM employees WHERE id IN (?, ?) ORDER BY id', [EMP1, EMP2]);

    await startServer();
    console.log('— الخادم يعمل على :' + PORT + ' —');
    const admin = await login('4252', '4252');
    const demo1 = await login('DEMO101', 'test123');

    // ── 0) الصلاحية: requests.review مطلوبة للمراجعة ──
    console.log('\n── الصلاحيات ──');
    const forbidden = await api('POST', '/api/shift-change-request/999/review', { status: 'approved' }, demo1);
    check('requests.review: موظف بلا الصلاحية يُرفض 403', forbidden.status === 403, 'status=' + forbidden.status);

    // ── 1) مسار EDIT: يوم له سطر قائم ──
    console.log('\n── الاعتماد على يوم له سطر (edit) ──');
    const m1 = my(D_EDIT);
    const mk = await api('POST', '/api/shift-roster', { employee_id: EMP1, shift_date: D_EDIT, shift_code: C1, month: m1.month, year: m1.year }, admin);
    check('تهيئة: إنشاء سطر ' + C1 + ' لليوم المستهدف', mk.ok && mk.data.id, JSON.stringify(mk.data));
    const ROSTER_EDIT = mk.data.id;
    const teamBefore = dbAll('SELECT team_id FROM shift_roster WHERE id = ?', [ROSTER_EDIT])[0].team_id;
    const othersFpBefore = fp(dbAll('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date <> ? ORDER BY id', [EMP1, D_EDIT]));

    const sseAdmin = listenSSE(admin);
    const sub1 = await api('POST', '/api/shift-change-request', { roster_id: ROSTER_EDIT, employee_id: EMP1, shift_date: D_EDIT, proposed_shift_code: C2, old_shift_code: C1, reason: 'ظرف طارئ' }, demo1);
    check('تقديم طلب التغيير ينجح', sub1.ok && sub1.data.id, JSON.stringify(sub1.data));
    const REQ1 = sub1.data.id;

    const waitShiftChange = sseAdmin.waitFor(m => m.type === 'shift_change_request' && String(m.payload && m.payload.request_id) === String(REQ1));
    const waitRosterUpd = sseAdmin.waitFor(m => m.type === 'shift_roster_updated');
    const ap1 = await api('POST', '/api/shift-change-request/' + REQ1 + '/review', { status: 'approved' }, admin);
    check('الاعتماد 200 + applied(edit)', ap1.ok && ap1.data.applied && ap1.data.applied.change_type === 'edit' && ap1.data.applied.shift_code === C2, JSON.stringify(ap1.data));
    const rowAfter = dbAll('SELECT * FROM shift_roster WHERE id = ?', [ROSTER_EDIT])[0];
    check('الجدول: الرمز طُبّق على اليوم المحدد فقط', rowAfter.shift_code === C2);
    check('الجدول: team_id لم يتغير', rowAfter.team_id === teamBefore);
    check('الطلب: status=approved + reviewed_by', (() => { const r = dbAll('SELECT status, reviewed_by FROM shift_change_requests WHERE id = ?', [REQ1])[0]; return r.status === 'approved' && !!r.reviewed_by; })());
    const rev = dbAll("SELECT * FROM schedule_revisions WHERE source = 'change-request' ORDER BY id DESC LIMIT 1")[0];
    check('التدقيق: schedule_revisions(source=change-request) مربوط بالطلب', !!rev && rev.stats_json && JSON.parse(rev.stats_json).request_id === REQ1, rev && rev.stats_json);
    const aud = dbAll('SELECT * FROM shift_audit_log WHERE revision_id = ?', [rev.id]);
    check('التدقيق: shift_audit_log بالقيمة القديمة/الجديدة الفعلية', aud.length === 1 && aud[0].old_shift_code === C1 && aud[0].new_shift_code === C2 && aud[0].change_type === 'edit', JSON.stringify(aud[0] || null));
    const notifLog = dbAll('SELECT * FROM notification_log WHERE revision_id = ?', [rev.id]);
    check('الإشعار: notification_log لصاحب الطلب (بعد COMMIT)', notifLog.length >= 1 && String(notifLog[0].recipient_id) === String(EMP1), 'rows=' + notifLog.length);
    check('SSE: بث shift_change_request', !!(await waitShiftChange));
    check('SSE: بث shift_roster_updated', !!(await waitRosterUpd));
    sseAdmin.close();

    // ── 2) منع الاعتماد المزدوج ──
    console.log('\n── منع الاعتماد المزدوج ──');
    const auditCountBefore = dbAll('SELECT COUNT(*) c FROM shift_audit_log WHERE revision_id = ?', [rev.id])[0].c;
    const ap1b = await api('POST', '/api/shift-change-request/' + REQ1 + '/review', { status: 'approved' }, admin);
    check('الاعتماد الثاني = 409 (SHIFT_CHANGE_ALREADY_PROCESSED)', ap1b.status === 409 && ap1b.data.code === 'SHIFT_CHANGE_ALREADY_PROCESSED', 'status=' + ap1b.status);
    check('الجدول لم يتغير بعد المحاولة الثانية', dbAll('SELECT shift_code FROM shift_roster WHERE id = ?', [ROSTER_EDIT])[0].shift_code === C2);
    check('لا صفوف تدقيق إضافية من المحاولة الثانية', dbAll('SELECT COUNT(*) c FROM shift_audit_log WHERE revision_id = ?', [rev.id])[0].c === auditCountBefore);

    // ── 3) عزل بقية الأيام والتعيينات والنمط ──
    check('بقية أيام الموظف لم تتغير (بصمة)', fp(dbAll('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date <> ? ORDER BY id', [EMP1, D_EDIT])) === othersFpBefore);

    // ── 4) مسار ADD: يوم بلا سطر ──
    console.log('\n── الاعتماد على يوم بلا سطر (add) ──');
    const expectedAssign = dbAll(`SELECT team_id FROM team_assignments
        WHERE employee_id = ? AND (assigned_date IS NULL OR assigned_date <= ?)
          AND (end_date IS NULL OR end_date >= ?) ORDER BY id DESC LIMIT 1`, [EMP2, D_ADD, D_ADD]);
    const expectedTeam = expectedAssign.length ? expectedAssign[0].team_id : null;
    const sub2 = await api('POST', '/api/shift-change-request', { employee_id: EMP2, shift_date: D_ADD, proposed_shift_code: C2, reason: 'تغطية' }, demo1);
    check('تقديم طلب (add) ينجح', sub2.ok && sub2.data.id);
    const ap2 = await api('POST', '/api/shift-change-request/' + sub2.data.id + '/review', { status: 'approved' }, admin);
    check('الاعتماد 200 + applied(add)', ap2.ok && ap2.data.applied && ap2.data.applied.change_type === 'add', JSON.stringify(ap2.data));
    const addRow = dbAll('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP2, D_ADD]);
    check('الجدول: سطر جديد بالرمز المقترح', addRow.length === 1 && addRow[0].shift_code === C2, JSON.stringify(addRow));
    check('الجدول: team_id من التعيين النشط في ذلك التاريخ', (addRow[0].team_id === null ? null : addRow[0].team_id) === expectedTeam, 'got=' + addRow[0].team_id + ' expected=' + expectedTeam);

    // ── 5) رمز لم يعد صالحًا وقت المراجعة ⇒ 409 + pending + بلا كتابة ──
    console.log('\n── الرمز غير الصالح عند الاعتماد ──');
    const revCountBefore = dbAll('SELECT COUNT(*) c FROM schedule_revisions')[0].c;
    const auditTotalBefore = dbAll('SELECT COUNT(*) c FROM shift_audit_log')[0].c;
    const sub3 = await api('POST', '/api/shift-change-request', { employee_id: EMP1, shift_date: D_BADCODE, proposed_shift_code: 'ZZZ_FAKE', reason: 'اختبار رمز' }, demo1);
    const ap3 = await api('POST', '/api/shift-change-request/' + sub3.data.id + '/review', { status: 'approved' }, admin);
    check('رمز غير معتمد = 409 (SHIFT_CHANGE_CODE_INVALID)', ap3.status === 409 && ap3.data.code === 'SHIFT_CHANGE_CODE_INVALID', 'status=' + ap3.status);
    check('الطلب يبقى pending', dbAll('SELECT status FROM shift_change_requests WHERE id = ?', [sub3.data.id])[0].status === 'pending');
    check('لا كتابة على الجدول', dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, D_BADCODE])[0].c === 0);
    check('لا مراجعة ولا تدقيق جزئي (ذرية)', dbAll('SELECT COUNT(*) c FROM schedule_revisions')[0].c === revCountBefore && dbAll('SELECT COUNT(*) c FROM shift_audit_log')[0].c === auditTotalBefore);

    // ── 6) موظف غير نشط ⇒ 409 + pending ──
    console.log('\n── الموظف غير النشط ──');
    dbRun('UPDATE employees SET is_active = 0 WHERE id = ?', [EMP3]);
    const sub4 = await api('POST', '/api/shift-change-request', { employee_id: EMP3, shift_date: D_INACTIVE, proposed_shift_code: C2, reason: 'اختبار' }, demo1);
    const ap4 = await api('POST', '/api/shift-change-request/' + sub4.data.id + '/review', { status: 'approved' }, admin);
    check('موظف غير نشط = 409 (SHIFT_CHANGE_EMPLOYEE_INVALID)', ap4.status === 409 && ap4.data.code === 'SHIFT_CHANGE_EMPLOYEE_INVALID', 'status=' + ap4.status);
    check('الطلب يبقى pending', dbAll('SELECT status FROM shift_change_requests WHERE id = ?', [sub4.data.id])[0].status === 'pending');
    check('لا كتابة على الجدول', dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP3, D_INACTIVE])[0].c === 0);
    dbRun('UPDATE employees SET is_active = 1 WHERE id = ?', [EMP3]);

    // ── 7) denied / cancelled: لا كتابة على الجدول إطلاقًا ──
    console.log('\n── denied / cancelled ──');
    const sub5 = await api('POST', '/api/shift-change-request', { employee_id: EMP1, shift_date: D_DENY, proposed_shift_code: C2, reason: 'اختبار رفض' }, demo1);
    const deny = await api('POST', '/api/shift-change-request/' + sub5.data.id + '/review', { status: 'denied' }, admin);
    check('الرفض ينجح (سلوك قائم)', deny.ok);
    check('الرفض لا يكتب على الجدول', dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, D_DENY])[0].c === 0);
    check('حالة الطلب denied', dbAll('SELECT status FROM shift_change_requests WHERE id = ?', [sub5.data.id])[0].status === 'denied');
    const sub6 = await api('POST', '/api/shift-change-request', { employee_id: EMP1, shift_date: D_CANCEL, proposed_shift_code: C2, reason: 'اختبار إلغاء' }, demo1);
    const cancel = await api('POST', '/api/shift-change-request/' + sub6.data.id + '/review', { status: 'cancelled' }, admin);
    check('الإلغاء ينجح (سلوك قائم)', cancel.ok);
    check('الإلغاء لا يكتب على الجدول', dbAll('SELECT COUNT(*) c FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, D_CANCEL])[0].c === 0);

    // ── 8) عدم المساس: team_assignments و pattern_code ──
    console.log('\n── عدم المساس ──');
    check('team_assignments لم تتغير (بصمة)', fp(dbAll('SELECT * FROM team_assignments WHERE employee_id IN (?, ?) ORDER BY id', [EMP1, EMP2])) === assignFpBefore);
    check('pattern_code لم يتغير', JSON.stringify(dbAll('SELECT id, pattern_code FROM employees WHERE id IN (?, ?) ORDER BY id', [EMP1, EMP2])) === JSON.stringify(patternBefore));

    await stopServer();
    console.log('\n═══ النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل ═══');
    // سطر ملخص بصيغة بوابة النشر (نفس عقد leave-backend-test) — البوابة تقرأه حرفيًا
    console.log((failed === 0 ? '✅' : '❌') + ' نجح: ' + passed + ' | ❌ فشل: ' + failed);
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL:', e); await stopServer(); process.exit(1); });
