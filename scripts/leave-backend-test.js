// A-4.3: اختبار باكند الإجازات الشامل — بيئة معزولة بالكامل (نسخة VACUUM مؤقتة).
// يغطي: R1 (تقديم + اعتماد حاسم + تحذيرات) · R2 · R3 · R7 · R8/D7 · R9 · R10
// · M1 (لا حذف فيزيائي) · M2 (PUT المالك) · M3 (نطاق الرؤية) · M4 (tx ذرية)
// · صلاحية leave.review · سجل التدقيق · إشعارات بنمط A-1 (DB + SSE حي)
// · توافق السجلات القديمة. لا يلمس data/ الحقيقية إطلاقًا.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3095;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// ─── بنية التشغيل: مجلد مؤقت + خادم حقيقي على منفذ ───
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-a43-'));
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const BASE = `http://localhost:${PORT}`;
let server = null;

function api(method, url, body, token) {
    return new Promise((resolve, reject) => {
        const u = new URL(BASE + url);
        const data = body ? JSON.stringify(body) : null;
        // Content-Length صريح — chunked DELETE يُرفض من طبقة ما قبل Express (400 فارغ)
        const headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {});
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers
        }, (res) => {
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

// مستمع SSE يحل وعدًا عند أول حدث يطابق الشرط (أو timeout).
// المستمع يُزال عند المطابقة فقط — الأحداث الأخرى (connected/broadcasts العامة)
// تمر دون أن تسقطه (إصلاح: splice الكلي كان يُسقط المستمع عند أول حدث غير مطابق).
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

// YYYY-MM-DD بعد n يومًا من اليوم (تواريخ مستقبلية دائمًا — R3)
function plusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ═══ التهيئة ═══
async function main() {
    console.log('═══ A-4.3 LEAVE BACKEND TEST — بيئة معزولة ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    // users.json: نسخة + زرع كلمة مرور معروفة لمستخدمي DEMO (نسخة الاختبار فقط)
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (u.username === 'DEMO101' || u.username === 'DEMO102') u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));

    await startServer();
    console.log('— الخادم يعمل على :' + PORT + ' —');

    const admin = await login('4252', '4252');
    const demo1 = await login('DEMO101', 'test123');
    const demo2 = await login('DEMO102', 'test123');

    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const DEMO1_UID = users.find(u => u.username === 'DEMO101').id;
    const rowsBefore = dbAll('SELECT COUNT(*) c FROM leave_requests')[0].c;

    // ═══ 1) التقديم الصحيح + التدقيق + created_by ═══
    console.log('\n── التقديم والتحققات الأساسية ──');
    const D1 = plusDays(10), D1E = plusDays(12);
    const s1 = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: D1, end_date: D1E, type: 'إجازة', reason: 'ظرف عائلي' }, admin);
    check('تقديم صحيح: 200 + id + بلا تحذيرات', s1.ok && s1.data.success && s1.data.id && Array.isArray(s1.data.warnings) && s1.data.warnings.length === 0, JSON.stringify(s1.data));
    const R1 = s1.data.id;
    const ev1 = await api('GET', '/api/leave-requests/' + R1 + '/events', null, admin);
    check('حدث التدقيق ∅→pending مسجل', ev1.ok && ev1.data.events.length === 1 && ev1.data.events[0].from_status === null && ev1.data.events[0].to_status === 'pending');
    const row1 = dbAll('SELECT * FROM leave_requests WHERE id = ?', [R1])[0];
    check('created_by مضبوط على المقدّم', String(row1.created_by) === 'emp-4252', 'created_by=' + row1.created_by);

    // ═══ 2) R3: التواريخ ═══
    const badOrder = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: plusDays(20), end_date: plusDays(15), type: 'إجازة' }, admin);
    check('R3: start>end مرفوض 400', badOrder.status === 400);
    const past = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: plusDays(-3), end_date: plusDays(1), type: 'مرضية' }, admin);
    check('R3: ماضٍ مرفوض (LEAVE_PAST_DATE)', past.status === 400 && past.data.code === 'LEAVE_PAST_DATE');
    const tooLong = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: plusDays(30), end_date: plusDays(130), type: 'إجازة' }, admin);
    check('R9: >90 يوم مرفوض (LEAVE_TOO_LONG)', tooLong.status === 400 && tooLong.data.code === 'LEAVE_TOO_LONG');
    const badType = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: plusDays(30), end_date: plusDays(31), type: 'طارئة' }, admin);
    check('نوع خارج قيد المخطط مرفوض 400 (LEAVE_TYPE_INVALID)', badType.status === 400 && badType.data.code === 'LEAVE_TYPE_INVALID');

    // ═══ 3) R2: تداخل الموظف نفسه ═══
    const overlap = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: plusDays(11), end_date: plusDays(14), type: 'إجازة' }, admin);
    check('R2: تداخل pending لنفس الموظف مرفوض (LEAVE_OVERLAP)', overlap.status === 400 && overlap.data.code === 'LEAVE_OVERLAP');

    // ═══ 4) R1 عند التقديم: يوم مكتمل بمعتمدَين يرفض + تحذير pending ═══
    console.log('\n── R1 حدّ الموظفين/اليوم ──');
    const DX = plusDays(40);
    // املأ اليوم DX بمعتمدين (موظفان آخران)
    const x1 = await api('POST', '/api/leave-requests', { employee_id: EMP2, start_date: DX, end_date: DX, type: 'إجازة' }, admin);
    const x2 = await api('POST', '/api/leave-requests', { employee_id: EMP3, start_date: DX, end_date: DX, type: 'إجازة' }, admin);
    await api('POST', '/api/leave-requests/' + x1.data.id + '/approve', { status: 'approved' }, admin);
    await api('POST', '/api/leave-requests/' + x2.data.id + '/approve', { status: 'approved' }, admin);
    const fullDay = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: DX, end_date: DX, type: 'إجازة' }, admin);
    check('R1-تقديم: يوم مكتمل بمعتمدَين يرفض (LEAVE_DAY_FULL)', fullDay.status === 400 && fullDay.data.code === 'LEAVE_DAY_FULL' && fullDay.data.date === DX);
    // تحذير غير حاجب: pending آخر على يوم فيه معتمد واحد
    const DY = plusDays(50);
    const y1 = await api('POST', '/api/leave-requests', { employee_id: EMP2, start_date: DY, end_date: DY, type: 'إجازة' }, admin);
    const y2 = await api('POST', '/api/leave-requests', { employee_id: EMP3, start_date: DY, end_date: DY, type: 'إجازة' }, admin);
    check('R1-تقديم: pending متداخلة تُقبل مع تحذير', y2.ok && Array.isArray(y2.data.warnings) && y2.data.warnings.some(w => w.date === DY), JSON.stringify(y2.data));

    // ═══ 5) R1 الحاسم عند الاعتماد: الثالث يُمنع ويبقى pending ═══
    const y3 = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: DY, end_date: DY, type: 'إجازة' }, admin);
    const a1 = await api('POST', '/api/leave-requests/' + y1.data.id + '/approve', { status: 'approved' }, admin);
    const a2 = await api('POST', '/api/leave-requests/' + y2.data.id + '/approve', { status: 'approved' }, admin);
    const a3 = await api('POST', '/api/leave-requests/' + y3.data.id + '/approve', { status: 'approved' }, admin);
    check('R1-اعتماد: الأول والثاني ينجحان', a1.ok && a2.ok);
    check('R1-اعتماد حاسم: الثالث يُمنع (LEAVE_DAY_FULL)', a3.status === 400 && a3.data.code === 'LEAVE_DAY_FULL');
    const y3row = dbAll('SELECT status, approved_by FROM leave_requests WHERE id = ?', [y3.data.id])[0];
    check('الطلب الممنوع يبقى pending بلا approved_by (rollback كامل)', y3row.status === 'pending' && y3row.approved_by === null);
    const y3events = dbAll('SELECT COUNT(*) c FROM leave_status_events WHERE request_id = ?', [y3.data.id])[0].c;
    check('لا حدث اعتماد جزئي للطلب الممنوع (ذرية المعاملة)', y3events === 1, 'events=' + y3events);

    // ═══ 6) اعتماد طلب معالج مسبقًا + سباق الاعتماد المزدوج ═══
    const dupApprove = await api('POST', '/api/leave-requests/' + y1.data.id + '/approve', { status: 'approved' }, admin);
    check('اعتماد طلب معتمد مسبقًا = 400 (LEAVE_PROCESSED)', dupApprove.status === 400 && dupApprove.data.code === 'LEAVE_PROCESSED');

    // ═══ 7) R10: الرفض يتطلب سببًا ═══
    const denyNoReason = await api('POST', '/api/leave-requests/' + y3.data.id + '/approve', { status: 'denied' }, admin);
    check('R10: رفض بلا سبب = 400 (LEAVE_DENIAL_REASON_REQUIRED)', denyNoReason.status === 400 && denyNoReason.data.code === 'LEAVE_DENIAL_REASON_REQUIRED');
    const denyOk = await api('POST', '/api/leave-requests/' + y3.data.id + '/approve', { status: 'denied', denial_reason: 'ضغط عمل تشغيلي' }, admin);
    check('R10: رفض بسبب ينجح', denyOk.ok);
    const deniedRow = dbAll('SELECT status, denial_reason FROM leave_requests WHERE id = ?', [y3.data.id])[0];
    check('denial_reason محفوظ', deniedRow.status === 'denied' && deniedRow.denial_reason === 'ضغط عمل تشغيلي');

    // ═══ 8) M3: نطاق الرؤية ═══
    console.log('\n── M3 نطاق الرؤية + الصلاحيات ──');
    const mineList = await api('GET', '/api/leave-requests', null, demo1);
    check('الموظف يرى طلباته فقط', mineList.ok && mineList.data.requests.length > 0 && mineList.data.requests.every(r => r.employee_id === EMP1));
    const foreign = await api('GET', '/api/leave-requests?employee_id=' + EMP2, null, demo1);
    check('employee_id أجنبية = 403', foreign.status === 403);
    const allList = await api('GET', '/api/leave-requests', null, admin);
    check('المخوَّل يرى الكل', allList.ok && allList.data.requests.length >= 7);
    const statusFilter = await api('GET', '/api/leave-requests?status=pending', null, admin);
    check('فلتر status يعمل للمخوَّل', statusFilter.ok && statusFilter.data.requests.every(r => r.status === 'pending'));

    // ═══ 9) صلاحية leave.review على الاعتماد ═══
    const z1 = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: plusDays(60), end_date: plusDays(61), type: 'إجازة' }, admin);
    const noPerm = await api('POST', '/api/leave-requests/' + z1.data.id + '/approve', { status: 'approved' }, demo1);
    check('اعتماد بلا leave.review = 403 (PERMISSION_DENIED)', noPerm.status === 403 && noPerm.data.code === 'PERMISSION_DENIED');

    // ═══ 10) M2: تعديل المالك ═══
    console.log('\n── M2 تعديل المالك + M1 الإلغاء الناعم ──');
    const editNotOwner = await api('PUT', '/api/leave-requests/' + z1.data.id, { start_date: plusDays(62), end_date: plusDays(63), type: 'إجازة' }, demo2);
    check('PUT من غير المالك = 403 (LEAVE_NOT_OWNER)', editNotOwner.status === 403 && editNotOwner.data.code === 'LEAVE_NOT_OWNER');
    const editOk = await api('PUT', '/api/leave-requests/' + z1.data.id, { start_date: plusDays(62), end_date: plusDays(63), type: 'استثنائية', reason: 'معدَّل' }, demo1);
    check('PUT المالك (pending، قبل البداية) ينجح', editOk.ok);
    const z1row = dbAll('SELECT * FROM leave_requests WHERE id = ?', [z1.data.id])[0];
    check('قيم التعديل محفوظة + updated_at', z1row.start_date === plusDays(62) && z1row.end_date === plusDays(63) && z1row.type === 'استثنائية' && z1row.updated_at !== null);
    const z1events = dbAll('SELECT * FROM leave_status_events WHERE request_id = ? ORDER BY id', [z1.data.id]);
    check('حدث تدقيق التعديل pending→pending مسجل', z1events.length === 2 && z1events[1].from_status === 'pending' && z1events[1].to_status === 'pending');
    const editOverlap = await api('PUT', '/api/leave-requests/' + z1.data.id, { start_date: D1, end_date: D1E, type: 'إجازة' }, demo1);
    check('PUT يعيد تطبيق R2 (تداخل مع طلبه الآخر) = 400', editOverlap.status === 400 && editOverlap.data.code === 'LEAVE_OVERLAP');

    // ═══ 11) M1: الإلغاء الناعم ═══
    const cancelNotOwner = await api('DELETE', '/api/leave-requests/' + z1.data.id, null, demo2);
    check('إلغاء pending من غير المالك = 403', cancelNotOwner.status === 403 && cancelNotOwner.data.code === 'LEAVE_NOT_OWNER');
    const cancelOwn = await api('DELETE', '/api/leave-requests/' + z1.data.id, null, demo1);
    check('إلغاء المالك لطلبه pending ينجح', cancelOwn.ok);
    const z1cancelled = dbAll('SELECT * FROM leave_requests WHERE id = ?', [z1.data.id])[0];
    check('M1: الإلغاء ناعم (cancelled + cancelled_by + cancelled_at)', z1cancelled.status === 'cancelled' && String(z1cancelled.cancelled_by) === DEMO1_UID && z1cancelled.cancelled_at !== null);

    // إلغاء المعتمدة: المالك بلا صلاحية يُمنع، والمخوَّل يحتاج سببًا (R7)
    const ownerCancelApproved = await api('DELETE', '/api/leave-requests/' + y1.data.id, null, demo2);
    check('إلغاء معتمدة بلا leave.review = 403 (LEAVE_REVIEW_REQUIRED)', ownerCancelApproved.status === 403 && ownerCancelApproved.data.code === 'LEAVE_REVIEW_REQUIRED');
    const noReasonCancel = await api('DELETE', '/api/leave-requests/' + y1.data.id, null, admin);
    check('R7: إلغاء معتمدة بلا سبب = 400 (LEAVE_CANCEL_REASON_REQUIRED)', noReasonCancel.status === 400 && noReasonCancel.data.code === 'LEAVE_CANCEL_REASON_REQUIRED');
    const reviewerCancel = await api('DELETE', '/api/leave-requests/' + y1.data.id, { reason: 'احتياج تشغيلي طارئ' }, admin);
    check('R7: إلغاء المخوَّل بسبب ينجح', reviewerCancel.ok);
    const y1cancelled = dbAll('SELECT * FROM leave_requests WHERE id = ?', [y1.data.id])[0];
    check('حقول إلغاء المعتمدة محفوظة', y1cancelled.status === 'cancelled' && y1cancelled.cancel_reason === 'احتياج تشغيلي طارئ' && String(y1cancelled.cancelled_by) === 'emp-4252');
    const y1events = dbAll('SELECT * FROM leave_status_events WHERE request_id = ? ORDER BY id', [y1.data.id]);
    check('تدقيق المعتمدة الملغاة: ∅→pending→approved→cancelled', y1events.length === 3 && y1events.map(e => e.to_status).join(',') === 'pending,approved,cancelled');

    // ═══ 12) M1: لا حذف فيزيائي — الصفوف تتراكم فقط ═══
    const rowsAfter = dbAll('SELECT COUNT(*) c FROM leave_requests')[0].c;
    const created = 1 /*s1*/ + 2 /*x*/ + 3 /*y*/ + 1 /*z1*/;
    check('لا حذف فيزيائي: كل الطلبات المنشأة موجودة', rowsAfter === rowsBefore + created, 'before=' + rowsBefore + ' after=' + rowsAfter + ' expected+=' + created);

    // ═══ 13) R8/D7: تعارضات المناوبة للعرض فقط ═══
    console.log('\n── R8 تعارضات المناوبة + D7 ──');
    const DW = plusDays(70);
    const teamRow = dbAll("SELECT id FROM teams WHERE center IS NOT NULL LIMIT 1")[0] || dbAll('SELECT id FROM teams LIMIT 1')[0];
    dbRun('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)',
        [EMP1, teamRow.id, DW, 'D', Number(DW.slice(5, 7)), Number(DW.slice(0, 4))]);
    const rosterBefore = dbAll('SELECT COUNT(*) c FROM shift_roster')[0].c;
    const w1 = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: DW, end_date: DW, type: 'إجازة' }, admin);
    const wApprove = await api('POST', '/api/leave-requests/' + w1.data.id + '/approve', { status: 'approved' }, admin);
    check('R8: الاعتماد ينجح ويحمل conflicts', wApprove.ok && Array.isArray(wApprove.data.conflicts) && wApprove.data.conflicts.length === 1);
    check('R8: التعارض يحمل التاريخ والرمز والفريق', wApprove.ok && wApprove.data.conflicts[0].date === DW && wApprove.data.conflicts[0].code === 'D' && !!wApprove.data.conflicts[0].team);
    const rosterAfter = dbAll('SELECT COUNT(*) c FROM shift_roster')[0].c;
    check('D7: shift_roster لم يُكتب من مسار الإجازات', rosterAfter === rosterBefore);
    const confEndpoint = await api('GET', '/api/leave-requests/conflicts?employee_id=' + EMP1 + '&from=' + DW + '&to=' + DW, null, admin);
    check('R8: endpoint التعارضات للمخوَّل يعمل', confEndpoint.ok && confEndpoint.data.conflicts.length === 1);
    const confNoPerm = await api('GET', '/api/leave-requests/conflicts?employee_id=' + EMP1 + '&from=' + DW + '&to=' + DW, null, demo1);
    check('R8: endpoint التعارضات بلا صلاحية = 403', confNoPerm.status === 403);

    // ═══ 14) سجل التدقيق: المالك يرى سجله، الأجنبي لا ═══
    const evOwn = await api('GET', '/api/leave-requests/' + R1 + '/events', null, demo1);
    check('المالك يرى سجل طلبه', evOwn.ok && evOwn.data.events.length >= 1);
    const evForeign = await api('GET', '/api/leave-requests/' + y2.data.id + '/events', null, demo1);
    check('سجل طلب أجنبي = 403', evForeign.status === 403);

    // ═══ 15) إشعارات بنمط A-1: DB + SSE حي ═══
    console.log('\n── إشعارات A-1 (DB + SSE حي) ──');
    const adminSSE = listenSSE(admin);
    await new Promise(r => setTimeout(r, 800)); // انتظار اكتمال اتصال SSE
    const notifPromise = adminSSE.waitFor(m => m.type === 'notification_created', 7000);
    const DV = plusDays(80);
    const v1 = await api('POST', '/api/leave-requests', { employee_id: EMP1, start_date: DV, end_date: DV, type: 'إجازة' }, admin);
    check('تقديم للاختبار الإشعاري نجح', v1.ok);
    const sseMsg = await notifPromise;
    check('SSE: notification_created يصل للمخوَّل لحظيًا (A-1)', !!sseMsg, 'لم يصل حدث خلال 7 ثوانٍ');
    const adminNotif = dbAll("SELECT * FROM notifications WHERE user_id = 'emp-4252' AND title = 'طلب إجازة جديد' ORDER BY id DESC LIMIT 1");
    check('Inbox: صف إشعار التقديم للمخوَّل محفوظ', adminNotif.length === 1);
    adminSSE.close();

    // إشعار شخصي للمالك عند الاعتماد — SSE بقناة الموظف
    const demoSSE = listenSSE(demo1);
    await new Promise(r => setTimeout(r, 800));
    const ownerPromise = demoSSE.waitFor(m => m.type === 'notification_created', 7000);
    const vApprove = await api('POST', '/api/leave-requests/' + v1.data.id + '/approve', { status: 'approved' }, admin);
    check('اعتماد للاختبار الإشعاري نجح', vApprove.ok);
    const ownerSse = await ownerPromise;
    check('SSE: إشعار الاعتماد يصل للمالك لحظيًا', !!ownerSse, 'لم يصل حدث خلال 7 ثوانٍ');
    const ownerNotif = dbAll('SELECT * FROM notifications WHERE user_id = ? AND title LIKE ? ORDER BY id DESC LIMIT 1', [DEMO1_UID, '%الموافقة على طلب الإجازة%']);
    check('Inbox: إشعار الاعتماد الشخصي محفوظ للمالك', ownerNotif.length === 1);
    // إشعار إلغاء المعتمدة للمالك
    await api('DELETE', '/api/leave-requests/' + v1.data.id, { reason: 'اختبار' }, admin);
    const cancelNotif = dbAll('SELECT * FROM notifications WHERE user_id = ? AND title LIKE ? ORDER BY id DESC LIMIT 1', [DEMO1_UID, '%إلغاء إجازتك%']);
    check('Inbox: إشعار إلغاء المعتمدة يصل للمالك بالسبب', cancelNotif.length === 1 && cancelNotif[0].message.includes('اختبار'));
    demoSSE.close();

    // ═══ 16) توافق السجلات القديمة (بلا الأعمدة الجديدة) ═══
    console.log('\n── التوافق مع السجلات القديمة ──');
    dbRun("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason) VALUES (?, ?, ?, 'إجازة', 'pending', 'قديم')",
        [EMP2, plusDays(90), plusDays(91)]);
    const legacyId = dbAll("SELECT id FROM leave_requests WHERE reason = 'قديم' ORDER BY id DESC LIMIT 1")[0].id;
    const legacyList = await api('GET', '/api/leave-requests?status=pending', null, admin);
    check('سجل قديم بلا أعمدة جديدة يظهر في القوائم', legacyList.ok && legacyList.data.requests.some(r => r.id === legacyId));
    const legacyApprove = await api('POST', '/api/leave-requests/' + legacyId + '/approve', { status: 'approved' }, admin);
    check('اعتماد سجل قديم يعمل ويُدقَّق', legacyApprove.ok && dbAll('SELECT COUNT(*) c FROM leave_status_events WHERE request_id = ?', [legacyId])[0].c === 1);

    // ═══ الخلاصة ═══
    await stopServer();
    console.log('\n═══════════════════════════════════');
    // تنسيق الملخص الموحد لاختبارات الدفعات — بوابة ما قبل النشر تقرأه حرفيًا
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failed > 0) {
        console.log('الفاشلة:');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('✅ LEAVE BACKEND: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
