// ═══ E-8 (FSS): اختبار محرك مرونة الموظف — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية.
// يغطي: (أ) فحوص ستاتيكية — المخطط (لا replacement_employee_id، الفهارس
// الجزئية الثلاثة)، Fail-Closed للمفتاحين المعلقين TBD، كتابة shift_roster
// محصورة في _applyInTx، المسارات السبعة بصلاحياتها القائمة (لا Permission
// جديد)، نقاء الخدمة (لا إشعارات/SSE داخلها)، استقلال قاعدة الـ8 ساعات عن
// M9/48h · (ب) حيًا: FLEX_CONFIG_MISSING قبل زرع الإعدادين، حراس التقديم
// (422 بلا صف ولا استهلاك عداد)، قاعدة الـ8 ساعات، المسار الآلي L2 (التغطية
// تصمد)، سباق التقديم المتزامن (نجاح واحد + 409)، مسار التغطية المتدرج
// (عرض ← رفض ← قبول ← تطبيق ذري + صف بديل)، التقادم (invalidated ← سحب ←
// إلغاء)، الاستنفاد ← تصعيد ← رفض/اعتماد المسؤول، العدّاد الشهري (إثبات
// استبعاد cancelled/rejected + بلوغ الحد)، حارس التبديل القائم (E-6)، حارس
// عدم التمكّن المحسوم (E-2)، الملكية/التفويض، دخان E-1/E-2/E-6، سلامة
// roster النهائية (لا تكرار، النقل مطابق للبديل)، Audit + الإشعارات
// (المستلم الصحيح بلا تكرار).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3105;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e8-'));
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
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json, text: buf });
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
    d.pragma('busy_timeout = 8000');
    d.prepare(sql).run(...(params || []));
    d.close();
}
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

async function main() {
    console.log('═══ E-8 FLEX TEST — محرك مرونة الموظف — بيئة معزولة ═══');

    // ═══ 1) فحوص ستاتيكية (بلا خادم) ═══
    console.log('\n── فحوص ستاتيكية: المخطط والإعدادات ──');
    const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    const flexSrc = fs.readFileSync(path.join(ROOT, 'services', 'schedule-engine', 'flex-service.js'), 'utf8');
    const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const { ENGINE_DEFAULTS } = require(path.join(ROOT, 'services', 'schedule-engine', 'config.js'));

    const frBlock = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS flex_requests'), dbSrc.indexOf('CREATE TABLE IF NOT EXISTS flex_offers'));
    check('db.js: جدول flex_requests بلا replacement_employee_id (مراجعة ① — التغطية كلها في flex_offers)',
        frBlock.includes('roster_id INTEGER NOT NULL') && !frBlock.includes('replacement_employee_id') &&
        frBlock.includes("'escalated'") && frBlock.includes("'applied'") && frBlock.includes("'replacement_search'"));
    const foBlock = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS flex_offers'), dbSrc.indexOf('idx_flex_req_emp_month'));
    check('db.js: جدول flex_offers بالطبقات الأربع + حالة invalidated',
        ['same_team', 'same_center', 'south_1_10', 'rapid', 'invalidated', 'withdrawn'].every(s => foBlock.includes(s)));
    check('db.js: الفهارس الجزئية الثلاثة (uq_flex_live_roster / uq_flex_offer_live / uq_flex_offer_live_emp_date)',
        dbSrc.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_flex_live_roster') &&
        dbSrc.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_flex_offer_live ON flex_offers(flex_request_id)') &&
        dbSrc.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_flex_offer_live_emp_date ON flex_offers(employee_id, cover_date)'));
    check('config.js: المفتاحان المعتمدان فقط في DEFAULTS (8 ساعات / 3 بدائل)',
        ENGINE_DEFAULTS['schedule_engine.flex_notice_hours'] === 8 && ENGINE_DEFAULTS['schedule_engine.flex_max_makeup_options'] === 3);
    check('config.js: المفتاحان المعلّقان TBD ليسا في DEFAULTS عمدًا (لا رقم صامت)',
        !('schedule_engine.max_flex_moves_per_month' in ENGINE_DEFAULTS) &&
        !('schedule_engine.flex_makeup_search_days' in ENGINE_DEFAULTS));
    check('flex-service.js: المفتاحان TBD يُقرآن من app_settings مباشرة + FLEX_CONFIG_MISSING (Fail-Closed)',
        flexSrc.includes("AppSettings.get('schedule_engine.max_flex_moves_per_month')") &&
        flexSrc.includes("AppSettings.get('schedule_engine.flex_makeup_search_days')") &&
        flexSrc.includes('FLEX_CONFIG_MISSING'));

    console.log('\n── فحوص ستاتيكية: حدود الخدمة ──');
    const applyStart = flexSrc.indexOf('_applyInTx(hdl, req');
    const applyEnd = flexSrc.indexOf('// ═══ ④ البحث المتدرج');
    const applyBlock = flexSrc.slice(applyStart, applyEnd);
    const insRoster = (flexSrc.match(/INSERT INTO shift_roster/g) || []).length;
    const updRoster = (flexSrc.match(/UPDATE shift_roster/g) || []).length;
    check('flex-service.js: كتابة shift_roster محصورة في _applyInTx (INSERT واحد + UPDATE واحد فقط)',
        insRoster === 1 && updRoster === 1 && applyStart > 0 && applyEnd > applyStart &&
        applyBlock.includes('INSERT INTO shift_roster') && applyBlock.includes('UPDATE shift_roster'));
    check('flex-service.js: قاعدة الـ8 ساعات مستقلة — لا تقرأ إعداد نافذة M9 إطلاقًا',
        flexSrc.includes('flex_notice_hours') && !flexSrc.includes('swap_auto_window_hours') &&
        !flexSrc.includes('schedule_engine.swap'));
    check('flex-service.js: نمط جنوب 1–10 بالاسم (13–19 مستبعدة بنيويًا) + تدخل سريع بالاسم القائم',
        flexSrc.includes('^جنوب ([1-9]|10)$') && flexSrc.includes('تدخل سريع'));
    check('flex-service.js: فحص المرشحين شخصي صِرف (teamId: null) — العبور استثناء E-8 موثق',
        flexSrc.includes('teamId: null') && flexSrc.includes('استثناء M11'));
    check('flex-service.js: نقاء الخدمة — لا إشعارات ولا SSE ولا HTTP (تُطلق من server.js بعد COMMIT)',
        !flexSrc.includes('notifyPersonal') && !flexSrc.includes('notifyOperational') &&
        !flexSrc.includes('EventSource') && !flexSrc.includes('express'));
    const reqs = Array.from(flexSrc.matchAll(/require\('([^']+)'\)/g)).map(m => m[1]);
    check('flex-service.js: الاستيرادات = E-0/E-4 فقط (config/validation/coverage/ranking + TimeRiyadh)',
        reqs.every(r => ['../../public/js/time-riyadh.js', './config.js', './validation-service.js', './coverage-service.js', './ranking-service.js'].includes(r)),
        JSON.stringify(reqs));

    console.log('\n── فحوص ستاتيكية: المسارات والصلاحيات ──');
    const flexRoutes = srvSrc.slice(srvSrc.indexOf("app.post('/api/my/flex-requests'"), srvSrc.indexOf("app.get('/api/permissions/catalog'"));
    check('server.js: المسارات السبعة موجودة (5 بوابة + 2 مسؤول)',
        ["app.post('/api/my/flex-requests'", "app.get('/api/my/flex-requests'", "app.post('/api/my/flex-requests/:id/cancel'",
         "app.get('/api/my/flex-offers'", "app.post('/api/my/flex-offers/:id/respond'",
         "app.get('/api/schedule/flex-requests'", "app.post('/api/schedule/flex-requests/:id/review'"].every(s => flexRoutes.includes(s)));
    check('server.js: صلاحيات قائمة فقط — ops.my_portal ×5 + schedule.requests.review ×2 (لا Permission جديد)',
        (flexRoutes.match(/authorizePerm\('ops\.my_portal'\)/g) || []).length === 5 &&
        (flexRoutes.match(/authorizePerm\('schedule\.requests\.review'\)/g) || []).length === 2);
    check('سلبي: لا مفتاح صلاحية جديد يحوي flex في server.js إطلاقًا',
        !srvSrc.match(/'(ops|schedule)\.[a-z_.]*flex[a-z_.]*'/i));
    check('server.js: الإشعارات بعد COMMIT + permKey للتصعيد = schedule.requests.review',
        flexRoutes.includes("eventKey: 'flex.escalated'") && flexRoutes.includes("permKey: 'schedule.requests.review'") &&
        flexRoutes.includes('notifyPersonal'));

    // ═══ 2) التهيئة المعزولة + إقلاع الخادم ═══
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (['DEMO101', 'DEMO102', 'DEMO103'].includes(u.username)) u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    for (const un of ['DEMO101', 'DEMO102', 'DEMO103']) {
        const u = users.find(x => x.username === un);
        dbRun('DELETE FROM user_permissions WHERE user_id = ? AND permission_key = ?', [u.id, 'ops.my_portal']);
        dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e8-test')", [u.id]);
    }
    const U1 = String(users.find(u => u.username === 'DEMO101').id);
    const U2 = String(users.find(u => u.username === 'DEMO102').id);
    const U3 = String(users.find(u => u.username === 'DEMO103').id);
    const UADMIN = String(users.find(u => u.username === '4252').id);

    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;
    const empUser = { [EMP1]: U1, [EMP2]: U2, [EMP3]: U3 };

    // مجمع مرشحين حتمي: تعطيل كل الموظفين عدا الثلاثة + عضويات حية في فريق 1
    dbRun("UPDATE employees SET is_active = 0 WHERE employee_code NOT IN ('DEMO101','DEMO102','DEMO103')");
    dbRun('DELETE FROM team_assignments WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    const insTA = 'INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, ?, ?, ?, ?)';
    for (const e of [EMP1, EMP2, EMP3]) dbRun(insTA, [e, TEAM, '2026-01-01', null, 1, 'flex-e8-test']);

    const FILLERS = dbAll('SELECT id FROM employees WHERE is_active = 0 ORDER BY id LIMIT 14').map(r => r.id);
    const insR = 'INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)';
    function clearEmps(date, emps) {
        dbRun(`DELETE FROM shift_roster WHERE employee_id IN (${emps.map(() => '?').join(',')}) AND shift_date = ?`, [...emps, date]);
    }
    /** بذر تغطية فريق 1 في يوم: حذف كل صفوف الفريق ثم EMP1 (اختياري) + حشوات day/night. */
    function seedCoverage(date, opts) {
        opts = opts || {};
        dbRun('DELETE FROM shift_roster WHERE team_id = ? AND shift_date = ?', [TEAM, date]);
        clearEmps(date, [EMP1, EMP2, EMP3]);
        const m = Number(date.slice(5, 7)), y = Number(date.slice(0, 4));
        if (opts.emp1) dbRun(insR, [EMP1, TEAM, date, opts.emp1, m, y]);
        let fi = 0;
        for (let i = 0; i < (opts.day || 0); i++) dbRun(insR, [FILLERS[fi++], TEAM, date, 'D12', m, y]);
        for (let i = 0; i < (opts.night || 0); i++) dbRun(insR, [FILLERS[fi++], TEAM, date, 'N12', m, y]);
    }

    // تواريخ الاختبار (متباعدة — راحة 12س بين أي D12 وآخر)
    const T = {
        c1: riyadhOffset(8), c2: riyadhOffset(9),     // المسار الآلي L2
        r1: riyadhOffset(20), r2: riyadhOffset(21),  // سباق التقديم
        b1: riyadhOffset(16), m1: riyadhOffset(18),  // مسار التغطية المتدرج
        b2: riyadhOffset(24),                        // التقادم ثم الإلغاء
        b3: riyadhOffset(26), m3: riyadhOffset(28),  // استنفاد ← رفض مسؤول
        b4: riyadhOffset(28), m4: riyadhOffset(30),  // استنفاد ← اعتماد مسؤول
        l1: riyadhOffset(6), l2: riyadhOffset(7),    // إثبات استبعاد cancelled/rejected من العدّاد
        l3: riyadhOffset(4), l4: riyadhOffset(5),    // بلوغ الحد الشهري
        s1: riyadhOffset(14), s2: riyadhOffset(13), s3: riyadhOffset(15), // حارس التبديل
        u1: riyadhOffset(11), u2: riyadhOffset(10)   // حارس عدم التمكّن
    };

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');
    // نظافة سياقية بعد الإقلاع (جداول E-6/E-2 تُنشأ بالـMigration — قد لا تكون في ملف الإنتاج)
    dbRun('DELETE FROM shift_swap_requests WHERE initiator_employee_id IN (?, ?, ?) OR target_employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3, EMP1, EMP2, EMP3]);
    dbRun('DELETE FROM unable_attend_requests WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    var demo1 = await login('DEMO101', 'test123');
    var demo2 = await login('DEMO102', 'test123');
    var demo3 = await login('DEMO103', 'test123');
    const admin = await login('4252', '4252');

    // ═══ 3) حيًا: إثبات الـMigration + Fail-Closed قبل زرع الإعدادين ═══
    console.log('\n── حيًا: Migration + Fail-Closed ──');
    const flexObjects = dbAll("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE '%flex%'").map(r => r.name);
    check('Migration: الجدولان + الفهارس الثلاثة أُنشئت عند الإقلاع على نسخة طازجة',
        ['flex_requests', 'flex_offers', 'uq_flex_live_roster', 'uq_flex_offer_live', 'uq_flex_offer_live_emp_date'].every(n => flexObjects.includes(n)),
        JSON.stringify(flexObjects));
    check('المفتاحان TBD غير موجودين في app_settings (نسخة الإنتاج طازجة)',
        dbAll("SELECT COUNT(*) n FROM app_settings WHERE key LIKE '%flex_moves%' OR key LIKE '%makeup_search%'")[0].n === 0);
    seedCoverage(T.c1, { emp1: 'D12', day: 5, night: 4 });
    const closed = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [T.c2] }, demo1);
    check('غياب الإعدادين ⇒ 503 FLEX_CONFIG_MISSING (Fail-Closed — ليس unlimited)',
        closed.status === 503 && closed.data && closed.data.code === 'FLEX_CONFIG_MISSING', JSON.stringify(closed.data));
    check('FLEX_CONFIG_MISSING لم يُنشئ أي صف',
        dbAll('SELECT COUNT(*) n FROM flex_requests')[0].n === 0);

    // زرع الإعدادين (قيم اختبار — قرار الرقم النهائي ما زال TBD عند المالك)
    dbRun("INSERT INTO app_settings (key, value) VALUES ('schedule_engine.max_flex_moves_per_month', '10')");
    dbRun("INSERT INTO app_settings (key, value) VALUES ('schedule_engine.flex_makeup_search_days', '14')");

    // ═══ 4) حيًا: حراس التقديم — 422 بلا صف ولا استهلاك عداد ═══
    console.log('\n── حيًا: حراس التقديم ──');
    const badDate = await api('POST', '/api/my/flex-requests', { orig_shift_date: '2026-13-99', makeup_options: [T.c2] }, demo1);
    check('تاريخ غير صالح = 422 FLEX_INVALID_DATE', badDate.status === 422 && badDate.data.code === 'FLEX_INVALID_DATE');
    const noOpts = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [] }, demo1);
    check('بلا أيام بديلة = 422 FLEX_MAKEUP_OPTIONS', noOpts.status === 422 && noOpts.data.code === 'FLEX_MAKEUP_OPTIONS');
    const fourOpts = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [T.c2, riyadhOffset(22), riyadhOffset(23), riyadhOffset(25)] }, demo1);
    check('أربعة بدائل (>3) = 422 FLEX_MAKEUP_OPTIONS', fourOpts.status === 422 && fourOpts.data.code === 'FLEX_MAKEUP_OPTIONS');
    const dupOpts = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [T.c2, T.c2] }, demo1);
    check('بدائل مكررة = 422 FLEX_MAKEUP_OPTIONS', dupOpts.status === 422 && dupOpts.data.code === 'FLEX_MAKEUP_OPTIONS');
    const sameAsOrig = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [T.c1] }, demo1);
    check('البديل = الأصل = 422 FLEX_MAKEUP_OPTIONS', sameAsOrig.status === 422 && sameAsOrig.data.code === 'FLEX_MAKEUP_OPTIONS');
    const pastOrig = await api('POST', '/api/my/flex-requests', { orig_shift_date: riyadhOffset(-1), makeup_options: [T.c2] }, demo1);
    check('مناوبة في الماضي = 422 FLEX_PAST_DATE', pastOrig.status === 422 && pastOrig.data.code === 'FLEX_PAST_DATE');
    const pastOpt = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [riyadhOffset(-1)] }, demo1);
    check('بديل في الماضي = 422 FLEX_MAKEUP_PAST', pastOpt.status === 422 && pastOpt.data.code === 'FLEX_MAKEUP_PAST');
    const outRange = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [riyadhOffset(25)] }, demo1);
    check('بديل خارج مدى البحث (±14) = 422 FLEX_MAKEUP_OUT_OF_RANGE',
        outRange.status === 422 && outRange.data.code === 'FLEX_MAKEUP_OUT_OF_RANGE', JSON.stringify(outRange.data));
    clearEmps(riyadhOffset(3), [EMP1]);
    const noRoster = await api('POST', '/api/my/flex-requests', { orig_shift_date: riyadhOffset(3), makeup_options: [T.l4] }, demo1);
    check('لا مناوبة في التاريخ = 404 FLEX_ROSTER_NOT_FOUND', noRoster.status === 404 && noRoster.data.code === 'FLEX_ROSTER_NOT_FOUND');
    // قاعدة الـ8 ساعات: مناوبة D12 اليوم (05:00) — داخل النافذة قطعًا في أي وقت تشغيل
    seedCoverage(riyadhOffset(0), { emp1: 'D12' });
    const notice = await api('POST', '/api/my/flex-requests', { orig_shift_date: riyadhOffset(0), makeup_options: [riyadhOffset(1)] }, demo1);
    check('داخل نافذة الـ8 ساعات = 422 FLEX_NOTICE_WINDOW', notice.status === 422 && notice.data.code === 'FLEX_NOTICE_WINDOW', JSON.stringify(notice.data));
    check('كل الرفض أعلاه لم يُنشئ أي صف (العداد لم يُستهلك — قرار §4-أ)',
        dbAll('SELECT COUNT(*) n FROM flex_requests')[0].n === 0);

    // ═══ 5) حيًا: المسار الآلي L2 — التغطية تصمد ⇒ تطبيق فوري ═══
    console.log('\n── حيًا: L2 آلي (التغطية تصمد) ──');
    const auto = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [T.c2] }, demo1);
    check('L2: التقديم = 200 applied فوري (coverage=holds + revision_id)',
        auto.status === 200 && auto.data && auto.data.status === 'applied' && auto.data.coverage === 'holds' &&
        auto.data.makeup_date === T.c2 && !!auto.data.revision_id, JSON.stringify(auto.data));
    const autoRow = dbAll('SELECT * FROM flex_requests WHERE id = ?', [auto.data.id])[0];
    check('L2: الصف applied بـ coverage_state=holds + applied_at + makeup_date',
        autoRow.status === 'applied' && autoRow.coverage_state === 'holds' && !!autoRow.applied_at && autoRow.makeup_date === T.c2);
    const movedRow = dbAll('SELECT * FROM shift_roster WHERE id = ?', [autoRow.roster_id])[0];
    check('L2: صف roster نُقل إلى اليوم البديل (التاريخ + الشهر/السنة محدثان)',
        movedRow.shift_date === T.c2 && movedRow.month === Number(T.c2.slice(5, 7)) && movedRow.year === Number(T.c2.slice(0, 4)) &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.c1])[0].n === 0);
    check('L2: shift_audit_log (edit) + schedule_revisions (flex-move) بنفس revision_id',
        dbAll("SELECT COUNT(*) n FROM shift_audit_log WHERE roster_id = ? AND change_type = 'edit' AND revision_id = ?", [autoRow.roster_id, auto.data.revision_id])[0].n === 1 &&
        dbAll("SELECT COUNT(*) n FROM schedule_revisions WHERE id = ? AND source = 'flex-move'", [auto.data.revision_id])[0].n === 1);
    check('L2: بلا عروض تغطية إطلاقًا (لم تنكسر التغطية)',
        dbAll('SELECT COUNT(*) n FROM flex_offers WHERE flex_request_id = ?', [auto.data.id])[0].n === 0);
    check('L2: إشعار شخصي واحد لصاحب الطلب بالنقل (لا تكرار)',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'نُقلت مناوبتك بطلب المرونة'])[0].n === 1);

    // ═══ 6) حيًا: سباق التقديم المتزامن — نجاح واحد + 409 ═══
    console.log('\n── حيًا: سباق متزامن على نفس المناوبة ──');
    seedCoverage(T.r1, { emp1: 'D12', day: 5, night: 4 });
    const race = await Promise.all([
        api('POST', '/api/my/flex-requests', { orig_shift_date: T.r1, makeup_options: [T.r2] }, demo1),
        api('POST', '/api/my/flex-requests', { orig_shift_date: T.r1, makeup_options: [T.r2] }, demo1)
    ]);
    const raceOk = race.filter(r => r.status === 200 && r.data && r.data.status === 'applied');
    // الخاسر يفشل بأمان في كل الحالات الزمنية: 409 (فحص المكرر أو حارس uq_flex_live_roster)
    // إن سبق الفحصَ النقلَ، أو 404 FLEX_ROSTER_NOT_FOUND إن وصل بعد نقل المناوبة — كلاهما Fail-Safe
    const raceSafe = race.filter(r => r.status === 409 && r.data && r.data.code === 'FLEX_DUPLICATE_REQUEST'
        || r.status === 404 && r.data && r.data.code === 'FLEX_ROSTER_NOT_FOUND');
    check('السباق: نجاح واحد applied + الخاسر يفشل بأمان (409 مكرر/حارس UNIQUE أو 404 بعد النقل) — لا تطبيق مزدوج ممكن',
        raceOk.length === 1 && raceSafe.length === 1, JSON.stringify(race.map(r => [r.status, r.data && r.data.code])));
    const raceRow = dbAll('SELECT * FROM flex_requests WHERE orig_shift_date = ? AND employee_id = ?', [T.r1, EMP1]);
    check('السباق: صف flex واحد فقط + roster نُقل مرة واحدة (لا تطبيق مزدوج)',
        raceRow.length === 1 && raceRow[0].status === 'applied' &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.r2])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.r1])[0].n === 0);

    // ═══ 7) حيًا: مسار التغطية — بحث متدرج ← رفض ← قبول ← تطبيق ذري ═══
    console.log('\n── حيًا: التغطية تسقط ← البحث المتدرج ──');
    seedCoverage(T.b1, { emp1: 'D12' }); // EMP1 وحده — إزالته تكسر التغطية
    const cov = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.b1, makeup_options: [T.m1] }, demo1);
    check('التغطية: التقديم = 200 offer_pending (coverage=broken + عرض same_team)',
        cov.status === 200 && cov.data && cov.data.status === 'offer_pending' && cov.data.coverage === 'broken' &&
        cov.data.offer && cov.data.offer.tier === 'same_team' && cov.data.offer.cover_date === T.b1, JSON.stringify(cov.data));
    const covReq = dbAll('SELECT * FROM flex_requests WHERE id = ?', [cov.data.id])[0];
    check('التغطية: الطلب offer_pending بـ coverage_state=broken + makeup_date محفوظ',
        covReq.status === 'offer_pending' && covReq.coverage_state === 'broken' && covReq.makeup_date === T.m1);
    const dupSub = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.b1, makeup_options: [T.m1] }, demo1);
    check('التغطية: تقديم مكرر على نفس المناوبة = 409 FLEX_DUPLICATE_REQUEST',
        dupSub.status === 409 && dupSub.data.code === 'FLEX_DUPLICATE_REQUEST');
    const X = Number(cov.data.offer.employee_id);
    const Y = X === EMP2 ? EMP3 : EMP2;
    const tokX = X === EMP2 ? demo2 : demo3;
    const tokY = Y === EMP2 ? demo2 : demo3;
    check('التغطية: العرض لزميل نشط بنفس الفريق (ليس صاحب الطلب)', X === EMP2 || X === EMP3);
    const wrongResp = await api('POST', '/api/my/flex-offers/' + cov.data.offer.id + '/respond', { action: 'accept' }, tokY);
    check('التغطية: رد من غير صاحب العرض = 403 FLEX_FORBIDDEN',
        wrongResp.status === 403 && wrongResp.data.code === 'FLEX_FORBIDDEN', JSON.stringify(wrongResp.data));
    const decline = await api('POST', '/api/my/flex-offers/' + cov.data.offer.id + '/respond', { action: 'decline' }, tokX);
    check('التغطية: رفض المرشح الأول = 200 offer_pending + عرض تالٍ للمرشح الآخر (تسلسل)',
        decline.status === 200 && decline.data && decline.data.status === 'offer_pending' &&
        decline.data.next_offer && Number(decline.data.next_offer.employee_id) === Y, JSON.stringify(decline.data));
    const offersMid = dbAll('SELECT * FROM flex_offers WHERE flex_request_id = ? ORDER BY rank_position', [cov.data.id]);
    check('التغطية: التاريخ محفوظ — العرض الأول declined والثاني offered (rank 1/2)',
        offersMid.length === 2 && offersMid[0].status === 'declined' && offersMid[1].status === 'offered' &&
        offersMid[0].rank_position === 1 && offersMid[1].rank_position === 2);
    const accept = await api('POST', '/api/my/flex-offers/' + decline.data.next_offer.id + '/respond', { action: 'accept' }, tokY);
    check('التغطية: قبول المرشح الثاني = 200 applied + revision_id (تطبيق ذري)',
        accept.status === 200 && accept.data && accept.data.status === 'applied' && !!accept.data.revision_id, JSON.stringify(accept.data));
    check('التغطية: مناوبة صاحب الطلب نُقلت للبديل + صف تغطية جديد للقابل بفريق الأصل (استثناء M11 الموثق)',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.m1])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.b1])[0].n === 0 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ? AND team_id = ? AND shift_code = ?', [Y, T.b1, TEAM, 'D12'])[0].n === 1);
    check('التغطية: shift_audit_log edit+add بنفس revision_id (نمط F-1)',
        dbAll("SELECT COUNT(*) n FROM shift_audit_log WHERE revision_id = ? AND change_type = 'edit'", [accept.data.revision_id])[0].n === 1 &&
        dbAll("SELECT COUNT(*) n FROM shift_audit_log WHERE revision_id = ? AND change_type = 'add'", [accept.data.revision_id])[0].n === 1);
    check('التغطية: إشعار القبول لصاحب الطلب + إشعارا العرض للمرشحين (لا تكرار)',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'قُبل عرض التغطية — نُقلت مناوبتك'])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [empUser[X], 'عرض تغطية مناوبة'])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [empUser[Y], 'عرض تغطية مناوبة'])[0].n === 1);

    // ═══ 8) حيًا: التقادم — إعادة التحقق اللحظية تستبعد العرض ثم إلغاء الموظف ═══
    console.log('\n── حيًا: staleness ← invalidated ← إلغاء ──');
    seedCoverage(T.b2, { emp1: 'D12' });
    const st = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.b2, makeup_options: [riyadhOffset(23)] }, demo1);
    check('staleness: التقديم = 200 offer_pending', st.status === 200 && st.data && st.data.status === 'offer_pending', JSON.stringify(st.data));
    const X2 = Number(st.data.offer.employee_id);
    const Y2 = X2 === EMP2 ? EMP3 : EMP2;
    const tokX2 = X2 === EMP2 ? demo2 : demo3;
    // تغيّر الواقع بعد العرض: أصبح للمرشح مناوبة في يوم التغطية
    dbRun(insR, [X2, TEAM, T.b2, 'D12', Number(T.b2.slice(5, 7)), Number(T.b2.slice(0, 4))]);
    const staleAccept = await api('POST', '/api/my/flex-offers/' + st.data.offer.id + '/respond', { action: 'accept' }, tokX2);
    check('staleness: قبول بعد تقادم الواقع = invalidated + التقدم للمرشح التالي (إعادة E-4 لحظية)',
        staleAccept.status === 200 && staleAccept.data && staleAccept.data.invalidated === true &&
        staleAccept.data.status === 'offer_pending' && staleAccept.data.next_offer &&
        Number(staleAccept.data.next_offer.employee_id) === Y2, JSON.stringify(staleAccept.data));
    const staleOffers = dbAll('SELECT * FROM flex_offers WHERE flex_request_id = ? ORDER BY rank_position', [st.data.id]);
    check('staleness: العرض الأول invalidated والثاني offered',
        staleOffers.length === 2 && staleOffers[0].status === 'invalidated' && staleOffers[1].status === 'offered');
    const cancel = await api('POST', '/api/my/flex-requests/' + st.data.id + '/cancel', {}, demo1);
    check('الإلغاء: الموظف يلغي طلبه = 200 cancelled + سحب العرض الحي (K5-like)',
        cancel.status === 200 && cancel.data && cancel.data.status === 'cancelled' &&
        cancel.data.withdrawn_offer && Number(cancel.data.withdrawn_offer.employee_id) === Y2, JSON.stringify(cancel.data));
    check('الإلغاء: العرض المسحوب withdrawn + roster لم يتغير (EMP1 ما زال على مناوبته)',
        dbAll("SELECT COUNT(*) n FROM flex_offers WHERE flex_request_id = ? AND status = 'withdrawn'", [st.data.id])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.b2])[0].n === 1);
    check('الإلغاء: إشعار سحب العرض وصل للمرشح المسحوب عرضه',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [empUser[Y2], 'سُحب عرض التغطية'])[0].n === 1);

    // ═══ 9) حيًا: الاستنفاد ← تصعيد ← رفض المسؤول ═══
    console.log('\n── حيًا: queue_exhausted ← escalated ← reject ──');
    seedCoverage(T.b3, { emp1: 'D12' });
    // المرشحان الوحيدان مشغولان بنفس اليوم — E-4 يستبعدهما في كل الطبقات
    dbRun(insR, [EMP2, TEAM, T.b3, 'D12', Number(T.b3.slice(5, 7)), Number(T.b3.slice(0, 4))]);
    dbRun(insR, [EMP3, TEAM, T.b3, 'D12', Number(T.b3.slice(5, 7)), Number(T.b3.slice(0, 4))]);
    const esc = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.b3, makeup_options: [T.m3] }, demo1);
    check('الاستنفاد: التقديم = 200 escalated بسبب queue_exhausted (لا Auto-Apply)',
        esc.status === 200 && esc.data && esc.data.status === 'escalated' && esc.data.escalation_reason === 'queue_exhausted', JSON.stringify(esc.data));
    const adminList = await api('GET', '/api/schedule/flex-requests', null, admin);
    const escItem = adminList.data && (adminList.data.requests || []).find(r => Number(r.id) === Number(esc.data.id));
    check('الاستنفاد: قائمة المسؤول (افتراضي escalated) تعرض الطلب مع مصفوفة عروضه',
        adminList.status === 200 && !!escItem && Array.isArray(escItem.offers) && escItem.employee_name !== undefined);
    check('الاستنفاد: إشعار تشغيلي لحامل schedule.requests.review (admin) بالتصعيد',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [UADMIN, 'طلب مرونة يحتاج مراجعة'])[0].n === 1);
    const rej = await api('POST', '/api/schedule/flex-requests/' + esc.data.id + '/review', { action: 'reject', note: 'غير مناسب تشغيليًا' }, admin);
    check('رفض المسؤول = 200 rejected + review_note محفوظة',
        rej.status === 200 && rej.data && rej.data.status === 'rejected' &&
        dbAll('SELECT review_note FROM flex_requests WHERE id = ?', [esc.data.id])[0].review_note === 'غير مناسب تشغيليًا');
    check('رفض المسؤول: إشعار صاحب الطلب بالرفض + roster لم يتغير',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'رُفض طلب المرونة'])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.b3])[0].n === 1);
    const rejAgain = await api('POST', '/api/schedule/flex-requests/' + esc.data.id + '/review', { action: 'reject' }, admin);
    check('مراجعة طلب غير مصعَّد = 409 FLEX_NOT_ESCALATED',
        rejAgain.status === 409 && rejAgain.data.code === 'FLEX_NOT_ESCALATED');

    // ═══ 10) حيًا: الاستنفاد ← اعتماد المسؤول ← تطبيق ذري ═══
    console.log('\n── حيًا: escalated ← approve (⑩ قرار مسؤول فقط) ──');
    seedCoverage(T.b4, { emp1: 'D12' });
    dbRun(insR, [EMP2, TEAM, T.b4, 'D12', Number(T.b4.slice(5, 7)), Number(T.b4.slice(0, 4))]);
    dbRun(insR, [EMP3, TEAM, T.b4, 'D12', Number(T.b4.slice(5, 7)), Number(T.b4.slice(0, 4))]);
    const esc2 = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.b4, makeup_options: [T.m4] }, demo1);
    check('اعتماد: طلب ثانٍ مصعَّد (queue_exhausted)',
        esc2.status === 200 && esc2.data && esc2.data.status === 'escalated', JSON.stringify(esc2.data));
    const appr = await api('POST', '/api/schedule/flex-requests/' + esc2.data.id + '/review', { action: 'approve' }, admin);
    check('اعتماد المسؤول = 200 applied + revision_id (الحراس النهائية أعيدت داخل tx)',
        appr.status === 200 && appr.data && appr.data.status === 'applied' && !!appr.data.revision_id, JSON.stringify(appr.data));
    check('اعتماد: مناوبة الموظف نُقلت للبديل + لا صف تغطية (لا عرض مقبول) + الفريقان الباقيان على يوم الأصل',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.m4])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.b4])[0].n === 0 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE team_id = ? AND shift_date = ?', [TEAM, T.b4])[0].n === 2);
    check('اعتماد: إشعار صاحب الطلب بالاعتماد والتطبيق',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'اعتُمد طلب المرونة وطُبّق'])[0].n === 1);

    // ═══ 11) حيًا: العدّاد الشهري — استبعاد cancelled/rejected ثم بلوغ الحد ═══
    console.log('\n── حيًا: العدّاد الشهري ──');
    const lMonth = T.l1.slice(0, 7);
    const liveApplied = "SELECT COUNT(*) n FROM flex_requests WHERE employee_id = ? AND month = ? AND status IN ('submitted','pending_validation','replacement_search','offer_pending','ready','escalated','applied')";
    const cntNow = dbAll(liveApplied, [EMP1, lMonth])[0].n;
    dbRun('UPDATE app_settings SET value = ? WHERE key = ?', [String(cntNow + 1), 'schedule_engine.max_flex_moves_per_month']);
    seedCoverage(T.l1, { emp1: 'D12', day: 5, night: 4 });
    const cntProof = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.l1, makeup_options: [T.l2] }, demo1);
    check('العدّاد: cancelled/rejected لا تُحتسب — طلب جديد ينجح عندما max = الحية+applied + 1',
        cntProof.status === 200 && cntProof.data && cntProof.data.status === 'applied', JSON.stringify(cntProof.data));
    dbRun('UPDATE app_settings SET value = ? WHERE key = ?', [String(cntNow + 1), 'schedule_engine.max_flex_moves_per_month']);
    seedCoverage(T.l3, { emp1: 'D12', day: 5, night: 4 });
    const atLimit = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.l3, makeup_options: [T.l4] }, demo1);
    check('العدّاد: بلوغ الحد الشهري = 422 FLEX_MONTHLY_LIMIT ولا صف جديد',
        atLimit.status === 422 && atLimit.data.code === 'FLEX_MONTHLY_LIMIT' &&
        dbAll(liveApplied, [EMP1, lMonth])[0].n === cntNow + 1, JSON.stringify(atLimit.data));
    dbRun('UPDATE app_settings SET value = ? WHERE key = ?', ['10', 'schedule_engine.max_flex_moves_per_month']);

    // ═══ 12) حيًا: حارس التبديل القائم (تعايش E-6) ═══
    console.log('\n── حيًا: FLEX_ROSTER_BUSY مع تبديل قائم ──');
    seedCoverage(T.s1, { emp1: 'D12', day: 5, night: 4 });
    clearEmps(T.s3, [EMP2]);
    dbRun(insR, [EMP2, TEAM, T.s3, 'D12', Number(T.s3.slice(5, 7)), Number(T.s3.slice(0, 4))]);
    const swap = await api('POST', '/api/my/shift-swaps', { target_employee_id: EMP2, my_shift_date: T.s1, target_shift_date: T.s3 }, demo1);
    check('E-6 سليم: تقديم تبديل بالتراضي = 200 pending_consent',
        swap.status === 200 && swap.data && swap.data.status === 'pending_consent', JSON.stringify(swap.data));
    const busy = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.s1, makeup_options: [T.s2] }, demo1);
    check('مرونة على مناوبة مرتبطة بتبديل قائم = 409 FLEX_ROSTER_BUSY',
        busy.status === 409 && busy.data.code === 'FLEX_ROSTER_BUSY', JSON.stringify(busy.data));
    const swapCancel = await api('POST', '/api/my/shift-swaps/' + swap.data.id + '/cancel', {}, demo1);
    check('E-6 سليم: إلغاء المبادر = 200 cancelled', swapCancel.status === 200 && swapCancel.data.status === 'cancelled');
    const afterFree = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.s1, makeup_options: [T.s2] }, demo1);
    check('بعد إلغاء التبديل: المرونة تنجح (الحارس يقرأ الحالة الحية فقط) = applied',
        afterFree.status === 200 && afterFree.data && afterFree.data.status === 'applied', JSON.stringify(afterFree.data));

    // ═══ 13) حيًا: حارس عدم التمكّن المحسوم (تعايش E-2) ═══
    console.log('\n── حيًا: FLEX_UNABLE_CONFLICT مع عدم تمكّن معتمد ──');
    seedCoverage(T.u1, { emp1: 'D12', day: 5, night: 4 });
    const ua = await api('POST', '/api/my/unable-attend', { off_date: T.u1, reason: 'ظرف طارئ' }, demo1);
    check('E-2 سليم: تقديم عدم تمكّن = 200', ua.status === 200 && ua.data && !!ua.data.id, JSON.stringify(ua.data));
    const uaRow = dbAll('SELECT * FROM unable_attend_requests WHERE id = ?', [ua.data.id])[0];
    if (uaRow.status !== 'approved' && uaRow.status !== 'auto_approved') {
        dbRun("UPDATE unable_attend_requests SET status = 'approved' WHERE id = ?", [ua.data.id]); // بذر حسم — نختبر حارس E-8 لا E-2
    }
    const uaFlex = await api('POST', '/api/my/flex-requests', { orig_shift_date: T.u1, makeup_options: [T.u2] }, demo1);
    check('مرونة على يوم بعدم تمكّن محسوم = 409 FLEX_UNABLE_CONFLICT (لا ازدواج مسارين)',
        uaFlex.status === 409 && uaFlex.data.code === 'FLEX_UNABLE_CONFLICT', JSON.stringify(uaFlex.data));
    const uaCancel = await api('POST', '/api/my/unable-attend/' + ua.data.id + '/cancel', {}, demo1);
    check('E-2 سليم: إلغاء عدم التمكّن = 200 cancelled',
        uaCancel.status === 200 && uaCancel.data && uaCancel.data.status === 'cancelled', JSON.stringify(uaCancel.data));

    // ═══ 14) حيًا: الملكية والتفويض + دخان E-1 ═══
    console.log('\n── حيًا: الأمن والملكية ──');
    check('مسارات البوابة بلا توكن = 401',
        (await api('GET', '/api/my/flex-requests')).status === 401 &&
        (await api('POST', '/api/my/flex-requests', { orig_shift_date: T.c1, makeup_options: [T.c2] })).status === 401 &&
        (await api('GET', '/api/my/flex-offers')).status === 401);
    check('مسارات المسؤول بلا توكن = 401',
        (await api('GET', '/api/schedule/flex-requests')).status === 401 &&
        (await api('POST', '/api/schedule/flex-requests/1/review', { action: 'approve' })).status === 401);
    check('مسارات المسؤول بموظف بلا schedule.requests.review = 403',
        (await api('GET', '/api/schedule/flex-requests', null, demo1)).status === 403 &&
        (await api('POST', '/api/schedule/flex-requests/1/review', { action: 'approve' }, demo1)).status === 403);
    const mine2 = await api('GET', '/api/my/flex-requests', null, demo2);
    check('قائمة موظف آخر لا تعرض طلبات EMP1 (الهوية من الجلسة)',
        mine2.status === 200 && !(mine2.data.requests || []).some(r => Number(r.employee_id) === Number(EMP1)));
    const foreignCancel = await api('POST', '/api/my/flex-requests/' + st.data.id + '/cancel', {}, demo2);
    check('إلغاء طلب غيرك = 403 FLEX_FORBIDDEN (الملكية قبل الحالة)',
        foreignCancel.status === 403 && foreignCancel.data.code === 'FLEX_FORBIDDEN');
    const badAction = await api('POST', '/api/schedule/flex-requests/' + esc2.data.id + '/review', { action: 'maybe' }, admin);
    check('إجراء مراجعة غير صالح = 422 FLEX_INVALID_ACTION',
        badAction.status === 422 && badAction.data.code === 'FLEX_INVALID_ACTION');
    const notFound = await api('POST', '/api/schedule/flex-requests/999999/review', { action: 'approve' }, admin);
    check('مراجعة طلب غير موجود = 404 FLEX_NOT_FOUND', notFound.status === 404 && notFound.data.code === 'FLEX_NOT_FOUND');
    const prefGet = await api('GET', '/api/my/schedule-preferences', null, demo1);
    const nextM = (() => { const d = riyadhOffset(31); return d.slice(0, 7); })();
    const prefPut = await api('PUT', '/api/my/schedule-preferences', { month: nextM, preferences: [] }, demo1);
    check('دخان E-1: تفضيلاتي GET=200 + PUT خارج النافذة = 422 (E-1 لم يُمس)',
        prefGet.status === 200 && prefPut.status === 422, 'GET=' + prefGet.status + ' PUT=' + prefPut.status);

    // ═══ 15) السلامة النهائية: roster + Audit + إشعارات ═══
    console.log('\n── السلامة النهائية ──');
    const allReq = dbAll('SELECT * FROM flex_requests');
    const byStatus = {};
    allReq.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
    check('flex_requests: 8 صفوف — applied×6 + cancelled×1 + rejected×1 + صفر حالة حية',
        allReq.length === 8 && byStatus.applied === 6 && byStatus.cancelled === 1 && byStatus.rejected === 1 &&
        !allReq.some(r => ['submitted', 'pending_validation', 'replacement_search', 'offer_pending', 'ready', 'escalated'].includes(r.status)),
        JSON.stringify(byStatus));
    check('كل applied لها applied_at + roster الفعلي على makeup_date (النقل مطابق للبديل)',
        dbAll(`SELECT COUNT(*) n FROM flex_requests f JOIN shift_roster sr ON sr.id = f.roster_id
               WHERE f.status = 'applied' AND f.applied_at IS NOT NULL AND sr.shift_date = f.makeup_date`)[0].n === 6);
    check('لا تكرار (موظف، تاريخ) في shift_roster للموظفين الثلاثة',
        dbAll(`SELECT COUNT(*) n FROM (SELECT employee_id, shift_date FROM shift_roster
               WHERE employee_id IN (?, ?, ?) GROUP BY employee_id, shift_date HAVING COUNT(*) > 1)`, [EMP1, EMP2, EMP3])[0].n === 0);
    check('صف تغطية واحد فقط أُدرج عبر كل التشغيل (مسار التغطية فقط)',
        dbAll(`SELECT COUNT(*) n FROM shift_audit_log WHERE change_type = 'add' AND reason LIKE '%تغطية مرونة%'`)[0].n === 1 &&
        dbAll(`SELECT COUNT(*) n FROM shift_audit_log WHERE change_type = 'edit' AND reason LIKE '%طلب مرونة%'`)[0].n === 6);
    check('schedule_revisions source=flex-move ×6 (مراجعة واحدة لكل تطبيق)',
        dbAll("SELECT COUNT(*) n FROM schedule_revisions WHERE source = 'flex-move'")[0].n === 6);
    const auditCount = (a) => dbAll('SELECT COUNT(*) n FROM audit_log WHERE action = ?', [a])[0].n;
    check('audit_log: flex_apply×6 + flex_cancel×1 + flex_review_reject×1 + flex_offer_decline×1 + flex_offer_invalidated×1',
        auditCount('flex_apply') === 6 && auditCount('flex_cancel') === 1 && auditCount('flex_review_reject') === 1 &&
        auditCount('flex_offer_decline') === 1 && auditCount('flex_offer_invalidated') === 1);
    check('audit_log: flex_submit×4 + flex_offer×4 + flex_escalate×2 (مسارات التغطية/التصعيد)',
        auditCount('flex_submit') === 4 && auditCount('flex_offer') === 4 && auditCount('flex_escalate') === 2);
    check('إشعارات صاحب الطلب النهائية بلا تكرار: نقل آلي×4 + قبول×1 + رفض×1 + اعتماد×1',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'نُقلت مناوبتك بطلب المرونة'])[0].n === 4 &&
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'قُبل عرض التغطية — نُقلت مناوبتك'])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'رُفض طلب المرونة'])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'اعتُمد طلب المرونة وطُبّق'])[0].n === 1);
    check('إشعارات عروض التغطية للمرشحين ×4 إجمالًا (2 لكل مسار تغطية) بلا تكرار',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id IN (?, ?) AND title = ?', [U2, U3, 'عرض تغطية مناوبة'])[0].n === 4);
    check('الإشعارات التشغيلية للتصعيد ×2 لحامل الصلاحية (لا تكرار داخل النافذة)',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [UADMIN, 'طلب مرونة يحتاج مراجعة'])[0].n === 2);
    check('flex_offers: 4 عروض — declined+accepted (تغطية) و invalidated+withdrawn (تقادم)',
        (() => { const o = dbAll('SELECT status, COUNT(*) n FROM flex_offers GROUP BY status'); const m = {}; o.forEach(r => m[r.status] = r.n);
            return o.length === 4 && m.declined === 1 && m.accepted === 1 && m.invalidated === 1 && m.withdrawn === 1; })());

    // ═══ الخلاصة ═══
    await stopServer();
    console.log('\n═══════════════════════════════════');
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failed > 0) {
        console.log('الفاشلة:');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('✅ E-8 FLEX TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
