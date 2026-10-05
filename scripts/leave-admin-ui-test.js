// A-4.4 S2: اختبار صفحة «مراجعة الإجازات» للمخوَّلين — بيئة معزولة بالكامل (نسخة VACUUM مؤقتة).
// يغطي: (أ) فحوص ستاتيكية — وجود الصفحة/الرابط/البوابة Fail-Closed وسلبيات النطاق
// (لا employee_id إدخالًا، لا vacations/controlModal، لا shift_roster، EventSource واحد) ·
// (ب) حيًا بنفس نداءات الواجهة: بوابة leave.review (مخوَّل/غير مخوَّل/star) · القائمة
// والفلتر السيرفي · اعتماد يرد conflicts · LEAVE_PROCESSED · رفض/إلغاء بلا سبب =400 وبه
// =ينجح · أحداث التدقيق ونطاقها · expired pending يبقى pending · SSE submitted +
// notification_created · (ج) عدم المساس: بصمة shift_roster وبصمة vacations.json ثابتتان.
// لا يلمس data/ الحقيقية إطلاقًا. نفس هارنس leave-ui-smoke-test (Content-Length والمستمع).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3097;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-a44s2-'));
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

// مستمع SSE يحل وعدًا عند أول حدث يطابق الشرط (أو timeout) — يُزال عند المطابقة فقط.
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

function rosterFingerprint() {
    const rows = dbAll('SELECT * FROM shift_roster ORDER BY id');
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
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

function plusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function main() {
    console.log('═══ A-4.4 S2 LEAVE ADMIN UI TEST — بيئة معزولة ═══');

    // ═══ 1) فحوص ستاتيكية على ملفات الواجهة (بلا خادم) ═══
    console.log('\n── فحوص ستاتيكية: الصفحة والرابط والبوابة ──');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'leave-admin.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'leave-admin.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

    check('leave-admin.html: موجودة + RTL + هوية المنصة', html.includes('dir="rtl"') && html.includes('/css/platform-identity.css'));
    check('leave-admin.html: تحمّل core-auth + leave-admin.js?v=1 (نسخة كاش مثبتة)',
        html.includes('js/core/core-auth.js') && html.includes('js/leave-admin.js?v=1'));
    const iGrp = idx.indexOf('id="sbAdminGroup"'), iBtn = idx.indexOf('id="sbLeaveReview"'), iNext = idx.indexOf('الإعدادات والأدوات');
    check('index.html: رابط «مراجعة الإجازات» داخل sbAdminGroup (موضعيًا)',
        iGrp !== -1 && iBtn > iGrp && iBtn < iNext && idx.includes("navigateToPage('leave-admin.html?v=1')"));
    check("index.html: إظهار الرابط مشروط بـ star || leave.review داخل gateAdminSidebarLinks",
        idx.includes("show('sbLeaveReview', star || perms.indexOf('leave.review') !== -1);"));
    check('leave-admin.js: البوابة على /api/auth/me + leave.review + permissions_star',
        js.includes("'/api/auth/me'") && js.includes("'leave.review'") && js.includes('permissions_star'));
    check('leave-admin.js: Fail-Closed — لا جلب قبل اجتياز البوابة (if (!allowed) return)',
        js.includes('if (!allowed) return;') && js.includes('غير مصرّح'));
    check('سلبي: لا input/select باسم أو معرّف employee_id في الواجهة إطلاقًا',
        !/name=["']employee_id["']/.test(js) && !/id=["']employee_id["']/.test(js) &&
        !/name=["']employee_id["']/.test(html) && !/id=["']employee_id["']/.test(html));
    check('سلبي: لا vacations ولا /api/vacations في الصفحة إطلاقًا',
        !/vacations/i.test(js) && !/vacations/i.test(html));
    check('سلبي: لا controlModal ولا loadVacations',
        !js.includes('controlModal') && !js.includes('loadVacations') && !html.includes('controlModal'));
    check('سلبي: لا ذكر لـ shift_roster إطلاقًا (الجدول المنشور لا يُلمس من هذا المسار)',
        !/shift_roster/.test(js) && !/shift_roster/.test(html));
    check('leave-admin.js: نداءات عقد A-4.3 فقط (/approve + /events + /conflicts + /api/sse)',
        js.includes("'/api/leave-requests'") && js.includes("/approve'") && js.includes("/events'") &&
        js.includes('/api/leave-requests/conflicts?employee_id=') && js.includes("'/api/sse?token='"));
    check('leave-admin.js: شارة «منتهي — بانتظار المراجعة» لـ expired pending',
        js.includes('منتهي — بانتظار المراجعة'));
    check('leave-admin.js: EventSource واحد فقط (لا اتصالات مكررة)',
        (js.match(/new EventSource/g) || []).length === 1);
    check('leave-admin.js: LEAVE_PROCESSED/LEAVE_RACE ⇒ رسالة السيرفر + إعادة جلب',
        js.includes('LEAVE_PROCESSED') && js.includes('LEAVE_RACE') && js.includes('handleDecisionError'));
    check('leave-admin.js: الرفض/الإلغاء لا يُرسلان بسبب فارغ (تحقق عميل قبل الحسم السيرفي)',
        js.includes('سبب الرفض إلزامي') && js.includes('سبب الإلغاء إلزامي'));

    // ═══ 2) التهيئة المعزولة + Fixture + إقلاع الخادم ═══
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (u.username === 'DEMO101' || u.username === 'DEMO102') u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));

    const Database2 = require('better-sqlite3');
    {
        const tmp = new Database2(TMP_DB);
        const demo1Id = users.find(u => u.username === 'DEMO101').id;
        // منح فردي لـ leave.review داخل النسخة المؤقتة فقط (نمط بذر ops.my_portal في
        // اختبار S1) — DEMO101 = مخوَّل بالمراجعة، DEMO102 = موظف بلا أية منحة.
        tmp.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by, created_at) VALUES (?, 'leave.review', 1, 'a44s2-test', datetime('now'))")
            .run(demo1Id);
        tmp.close();
    }

    // vacations.json: ملف Legacy إنتاجي فقط (/data على Render) — غير موجود في بيئة
    // التطوير أصلًا. الفحص يثبت أن S2 لا ينشئه ولا يمسه: غائب⇐يبقى غائبًا، موجود⇐بصمته ثابتة.
    const vacPath = path.join(ROOT, 'data', 'vacations.json');
    const vacBefore = fs.existsSync(vacPath)
        ? crypto.createHash('sha256').update(fs.readFileSync(vacPath)).digest('hex')
        : null;
    const rosterFpBefore = rosterFingerprint();

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');

    // Fixture بعد الإقلاع عمدًا: قاعدة التطوير الخام تسبق أعمدة A-4.3 (created_by ورفاقها)
    // والإقلاع يشغّل هجرات db.js التي تضيفها — الإدراج قبلها = SQLITE_ERROR.
    // طلب pending منتهٍ (ماضٍ) يُدرج مباشرة لأن R3 تمنع إنشاءه عبر API؛ يثبت أن
    // expired pending يبقى pending في القائمة وقرار المراجع هو الحاسم.
    let EXPIRED_ID = null;
    {
        const tmp = new Database2(TMP_DB);
        const emp1 = tmp.prepare("SELECT id FROM employees WHERE employee_code = 'DEMO101'").get();
        const r = tmp.prepare("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason, created_by) VALUES (?, '2026-09-01', '2026-09-02', 'إجازة', 'pending', 'Fixture اختبار S2', 'a44s2-test')").run(emp1.id);
        EXPIRED_ID = Number(r.lastInsertRowid);
        tmp.prepare("INSERT INTO leave_status_events (request_id, from_status, to_status, actor_user_id, actor_role, reason) VALUES (?, NULL, 'pending', 'a44s2-test', 'test', 'Fixture اختبار S2')").run(EXPIRED_ID);
        tmp.close();
    }
    const admin = await login('4252', '4252');          // star
    const demo1 = await login('DEMO101', 'test123');    // مخوَّل (منحة leave.review)
    const demo2 = await login('DEMO102', 'test123');    // بلا منحة
    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;

    // ═══ 3) البوابة الحية: هوية وصلاحيات الأدوار الثلاثة ═══
    console.log('\n── البوابة: مخوَّل / غير مخوَّل / star ──');
    const me1 = await api('GET', '/api/auth/me', null, demo1);
    check('auth/me للمخوَّل: permissions تتضمن leave.review بلا star',
        me1.ok && me1.data.permissions.indexOf('leave.review') !== -1 && me1.data.permissions_star === false);
    const me2 = await api('GET', '/api/auth/me', null, demo2);
    check('auth/me لغير المخوَّل: بلا leave.review وبلا star',
        me2.ok && me2.data.permissions.indexOf('leave.review') === -1 && me2.data.permissions_star === false);
    const meA = await api('GET', '/api/auth/me', null, admin);
    check('auth/me للمدير: permissions_star = true (يتجاوز البوابة حسب السياسة)',
        meA.ok && meA.data.permissions_star === true);

    console.log('\n── غير المخوَّل: حسم سيرفي 403 على مسارات المراجعة ──');
    const c403 = await api('GET', `/api/leave-requests/conflicts?employee_id=${EMP2}&from=${plusDays(40)}&to=${plusDays(41)}`, null, demo2);
    check('GET /conflicts لغير المخوَّل = 403 (authorizePerm)', c403.status === 403);
    const a403 = await api('POST', '/api/leave-requests/1/approve', { status: 'approved' }, demo2);
    check('POST /:id/approve لغير المخوَّل = 403 (وليس 400/404)', a403.status === 403);
    const listMine = await api('GET', '/api/leave-requests', null, demo2);
    check('GET القائمة لغير المخوَّل: نجاح لكن بنطاق طلباته فقط (M3 سيرفي)',
        listMine.ok && listMine.data.requests.every(r => r.employee_id === EMP2));

    // ═══ 4) التدفق الحي: تقديم ← SSE ← قائمة المخوَّل ═══
    console.log('\n── تقديم ← بث لحظي ← ظهور في قائمة المخوَّل ──');
    const sse = listenSSE(demo1);
    await new Promise(r => setTimeout(r, 800));
    const broadcastP = sse.waitFor(m => m.type === 'leave_request_submitted', 7000);
    const notifP = sse.waitFor(m => m.type === 'notification_created' && m.notification && /إجاز/.test((m.notification.title || '') + ' ' + (m.notification.message || '')), 7000);
    const D1 = plusDays(40), D1E = plusDays(41);
    const s1 = await api('POST', '/api/leave-requests',
        { employee_id: EMP2, start_date: D1, end_date: D1E, type: 'إجازة', reason: 'اختبار S2' }, demo2);
    check('تقديم الموظف نجح (200 + id + warnings[])', s1.ok && s1.data.success && !!s1.data.id && Array.isArray(s1.data.warnings), JSON.stringify(s1.data));
    const gotBroadcast = await broadcastP;
    check('SSE: leave_request_submitted يصل المخوَّل لحظيًا (تحديث القائمة بلا Refresh)', !!gotBroadcast, 'لم يصل خلال 7 ثوانٍ');
    const gotNotif = await notifP;
    check('SSE: notification_created «طلب إجازة جديد» يصل حامل leave.review فردي المنحة', !!gotNotif, 'لم يصل خلال 7 ثوانٍ');
    sse.close();

    const listAll = await api('GET', '/api/leave-requests', null, demo1);
    const row1 = listAll.ok && listAll.data.requests.find(r => r.id === s1.data.id);
    check('قائمة المخوَّل: الطلب الجديد ظاهر pending مع employee_name/employee_code من الـJOIN',
        !!row1 && row1.status === 'pending' && !!row1.employee_name && !!row1.employee_code);
    const listPend = await api('GET', '/api/leave-requests?status=pending', null, demo1);
    check('فلتر ?status=pending سيرفي: كل الصفوف pending وتتضمن الطلب الجديد',
        listPend.ok && listPend.data.requests.length > 0 && listPend.data.requests.every(r => r.status === 'pending') && listPend.data.requests.some(r => r.id === s1.data.id));
    const expiredRow = listAll.data.requests.find(r => r.id === EXPIRED_ID);
    check('expired pending: fixture المنتهي ظاهر في القائمة ويبقى pending (وليس denied/cancelled)',
        !!expiredRow && expiredRow.status === 'pending' && expiredRow.end_date < plusDays(0));

    // ═══ 5) القرارات: اعتماد (conflicts) ← معالَج ← إلغاء بسبب ═══
    console.log('\n── اعتماد ← LEAVE_PROCESSED ← إلغاء معتمدة ──');
    const ap = await api('POST', `/api/leave-requests/${s1.data.id}/approve`, { status: 'approved' }, demo1);
    check('اعتماد المخوَّل (منحة فردية، بلا star) نجح + الرد يحمل conflicts[]',
        ap.ok && ap.data.success === true && Array.isArray(ap.data.conflicts), JSON.stringify(ap.data));
    const apAgain = await api('POST', `/api/leave-requests/${s1.data.id}/approve`, { status: 'approved' }, demo1);
    check('إعادة اعتماد طلب معالَج = 400 LEAVE_PROCESSED (الأولوية لحالة السيرفر)',
        apAgain.status === 400 && apAgain.data && apAgain.data.code === 'LEAVE_PROCESSED', JSON.stringify(apAgain.data));
    const delNoReason = await api('DELETE', `/api/leave-requests/${s1.data.id}`, null, demo1);
    check('إلغاء معتمدة بلا سبب = 400 LEAVE_CANCEL_REASON_REQUIRED',
        delNoReason.status === 400 && delNoReason.data && delNoReason.data.code === 'LEAVE_CANCEL_REASON_REQUIRED');
    const delReason = await api('DELETE', `/api/leave-requests/${s1.data.id}`, { reason: 'ظرف تشغيلي طارئ — اختبار S2' }, demo1);
    check('إلغاء معتمدة بسبب إلزامي ينجح (semantic cancel — لا حذف فيزيائي)', delReason.ok && delReason.data.success === true);
    const afterCancel = await api('GET', '/api/leave-requests', null, demo1);
    const cancelledRow = afterCancel.data.requests.find(r => r.id === s1.data.id);
    check('بعد الإلغاء: cancelled + cancel_reason محفوظان في القائمة (M1)',
        !!cancelledRow && cancelledRow.status === 'cancelled' && cancelledRow.cancel_reason === 'ظرف تشغيلي طارئ — اختبار S2');

    console.log('\n── سجل التدقيق ونطاقه ──');
    const ev = await api('GET', `/api/leave-requests/${s1.data.id}/events`, null, demo1);
    check('events للمخوَّل: 3 أحداث مرتبة (تقديم ← اعتماد ← إلغاء)',
        ev.ok && ev.data.events.length === 3 && ev.data.events[0].from_status === null &&
        ev.data.events[1].to_status === 'approved' && ev.data.events[2].to_status === 'cancelled', JSON.stringify(ev.data && ev.data.events));
    const evOwner = await api('GET', `/api/leave-requests/${s1.data.id}/events`, null, demo2);
    check('events للمالك (صاحب الطلب) مسموحة', evOwner.ok && evOwner.data.events.length === 3);
    const s3 = await api('POST', '/api/leave-requests',
        { employee_id: EMP1, start_date: plusDays(50), end_date: plusDays(50), type: 'مرضية' }, admin);
    check('تقديم بالنيابة من star لموظف آخر نجح (لاختبار النطاق)', s3.ok && !!s3.data.id);
    const evForeign = await api('GET', `/api/leave-requests/${s3.data.id}/events`, null, demo2);
    check('events لطلب موظف آخر من غير مخوَّل = 403 LEAVE_SCOPE',
        evForeign.status === 403 && evForeign.data && evForeign.data.code === 'LEAVE_SCOPE');

    // ═══ 6) الرفض: سبب إلزامي ═══
    console.log('\n── رفض بلا سبب = 400 ← رفض بسبب = ينجح ──');
    const s2 = await api('POST', '/api/leave-requests',
        { employee_id: EMP2, start_date: plusDays(45), end_date: plusDays(46), type: 'استثنائية' }, demo2);
    check('تقديم ثانٍ لمسار الرفض نجح', s2.ok && !!s2.data.id);
    const denyNoReason = await api('POST', `/api/leave-requests/${s2.data.id}/approve`, { status: 'denied' }, demo1);
    check('رفض بلا سبب = 400 LEAVE_DENIAL_REASON_REQUIRED',
        denyNoReason.status === 400 && denyNoReason.data && denyNoReason.data.code === 'LEAVE_DENIAL_REASON_REQUIRED');
    const denyOk = await api('POST', `/api/leave-requests/${s2.data.id}/approve`, { status: 'denied', denial_reason: 'ذروة تشغيلية — اختبار S2' }, demo1);
    check('رفض بسبب إلزامي ينجح', denyOk.ok && denyOk.data.success === true);
    const afterDeny = await api('GET', '/api/leave-requests', null, demo1);
    const deniedRow = afterDeny.data.requests.find(r => r.id === s2.data.id);
    check('بعد الرفض: denied + denial_reason محفوظان ويظهران في قائمة المخوَّل',
        !!deniedRow && deniedRow.status === 'denied' && deniedRow.denial_reason === 'ذروة تشغيلية — اختبار S2');

    // ═══ 7) عدم المساس: الجدول المنشور + vacations.json ═══
    console.log('\n── عدم المساس ──');
    check('بصمة shift_roster بعد كل العمليات = قبلها (صفر كتابة من مسار الإجازات — D7)',
        rosterFingerprint() === rosterFpBefore);
    const vacAfter = fs.existsSync(vacPath)
        ? crypto.createHash('sha256').update(fs.readFileSync(vacPath)).digest('hex')
        : null;
    check('vacations.json لم يُمس ولم يُنشأ (غائب⇐غائب / موجود⇐بصمة ثابتة)', vacAfter === vacBefore);

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
    console.log('✅ LEAVE ADMIN UI TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
