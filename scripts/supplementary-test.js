// ═══ المناوبة التكميلية: اختبار capability المستقلة — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية (نمط e8-flex-test).
// SRC_DB / SRC_USERS: مسارا القاعدة والمستخدمين المصدر (افتراضيًا ROOT/data —
// تُمرَّر من الخارج عند العمل في worktree لا يحوي data/ الحقيقية).
// يغطي: (أ) فحوص ستاتيكية — المخطط (الجدول المستقل + الفهرس الجزئي + لا خلط
// مع flex)، Fail-Closed للإعدادين المعلّقين، كتابة shift_roster محصورة في
// _applyInTx، المسارات الستة بصلاحياتها القائمة (لا Permission جديد)، نقاء
// الخدمة · (ب) حيًا: Migration، SUPP_CONFIG_MISSING قبل الزرع، عقد المقترحات
// (candidates/unavailable/limits/hours)، حراس التقديم (422 بلا صف)، التقديم
// الصالح (pending_review — لا اعتماد آلي)، التكرار + سباق التقديم (409)،
// فشل التحقق (rejected بأسباب E-4 ولا يستهلك العدّاد)، الحد الشهري، صلاحيات
// المراجعة (403)، الرفض، الاعتماد+التطبيق الذري (roster + audit + revision
// + إشعار)، سباق الاعتماد المزدوج، فشل إعادة التحقق اللحظية ⇒ escalated،
// الإلغاء (ملكية/حالة)، الانقضاء الكسول، سلامة roster النهائية.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const SRC_DB = process.env.SRC_DB || path.join(ROOT, 'data', 'ambulance.db');
const SRC_USERS = process.env.SRC_USERS || path.join(ROOT, 'data', 'users.json');
const PORT = 3106;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-'));
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
function riyadhMonth() {
    const p = TimeRiyadh.riyadhParts(new Date());
    return `${p.year}-${p.month}`;
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
    console.log('═══ SUPPLEMENTARY TEST — المناوبة التكميلية — بيئة معزولة ═══');
    console.log('المصدر: ' + SRC_DB);

    // ═══ 1) فحوص ستاتيكية (بلا خادم) ═══
    console.log('\n── فحوص ستاتيكية: المخطط والإعدادات ──');
    const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    const suppSrc = fs.readFileSync(path.join(ROOT, 'services', 'schedule-engine', 'supplementary-service.js'), 'utf8');
    const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const { ENGINE_DEFAULTS } = require(path.join(ROOT, 'services', 'schedule-engine', 'config.js'));

    const sBlock = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS supplementary_requests'), dbSrc.indexOf("logger.info('supplementary_requests table created')"));
    check('db.js: جدول supplementary_requests مستقل بالحالات السبع + escalation_reason + roster_id قابل للفراغ',
        sBlock.includes('target_date TEXT NOT NULL') && sBlock.includes('escalation_reason') &&
        sBlock.includes('roster_id INTEGER REFERENCES shift_roster(id)') && !sBlock.includes('roster_id INTEGER NOT NULL') &&
        ['pending_review', 'approved', 'applied', 'rejected', 'cancelled', 'expired', 'escalated'].every(s => sBlock.includes(`'${s}'`)));
    check('db.js: الفهرس الفريد الجزئي uq_supp_live_emp_date (حيّة فقط)',
        dbSrc.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_supp_live_emp_date ON supplementary_requests(employee_id, target_date)') &&
        dbSrc.includes("WHERE status IN ('pending_review','approved','escalated')"));
    check('config.js: الإعدادان المعلّقان ليسا في ENGINE_DEFAULTS عمدًا (لا رقم صامت)',
        !('schedule_engine.supp_max_per_month' in ENGINE_DEFAULTS) &&
        !('schedule_engine.supp_min_notice_hours' in ENGINE_DEFAULTS));
    check('supplementary-service.js: الإعدادان يُقرآن من app_settings مباشرة عبر حارس «عدد صحيح موجب» + SUPP_CONFIG_MISSING (Fail-Closed)',
        suppSrc.includes("_readPositiveIntSetting(KEY_MAX_PER_MONTH)") && suppSrc.includes("_readPositiveIntSetting(KEY_MIN_NOTICE_HOURS)") &&
        suppSrc.includes('AppSettings.get(key)') && suppSrc.includes('Number.isInteger') &&
        suppSrc.includes('SUPP_CONFIG_MISSING'));

    console.log('\n── فحوص ستاتيكية: حدود الخدمة ──');
    const applyStart = suppSrc.indexOf('_applyInTx(hdl, req, actor)');
    const applyBlock = suppSrc.slice(applyStart);
    const insRoster = (suppSrc.match(/INSERT INTO shift_roster/g) || []).length;
    const updRoster = (suppSrc.match(/UPDATE shift_roster/g) || []).length;
    check('supplementary-service.js: كتابة shift_roster محصورة في _applyInTx (INSERT واحد فقط · صفر UPDATE)',
        insRoster === 1 && updRoster === 0 && applyStart > 0 && applyBlock.includes('INSERT INTO shift_roster'));
    check('supplementary-service.js: نقاء الخدمة — لا إشعارات ولا SSE ولا HTTP (تُطلق من server.js بعد COMMIT)',
        !suppSrc.includes('notifyPersonal') && !suppSrc.includes('notifyOperational') &&
        !suppSrc.includes('EventSource') && !suppSrc.includes('express'));
    const reqs = Array.from(suppSrc.matchAll(/require\('([^']+)'\)/g)).map(m => m[1]);
    check('supplementary-service.js: الاستيرادات = TimeRiyadh + E-4 + التغطية فقط',
        reqs.every(r => ['../../public/js/time-riyadh.js', './validation-service.js', './coverage-service.js'].includes(r)),
        JSON.stringify(reqs));
    check('supplementary-service.js: لا اعتماد آلي — التقديم الصالح ينتهي pending_review فقط',
        suppSrc.includes("'pending_review'") && !suppSrc.slice(suppSrc.indexOf('async submit'), suppSrc.indexOf('async cancel')).includes("'applied'"));

    console.log('\n── فحوص ستاتيكية: قرارا 2026-10-08 (أ/ب) — مصدر التكميلية والسياق ──');
    const valSrc = fs.readFileSync(path.join(ROOT, 'services', 'schedule-engine', 'validation-service.js'), 'utf8');
    check('supplementary-service.js: مصدر المقترحات = status «تكميل» بأوقات فعلية فقط (لا hard-code لرموز)',
        suppSrc.includes(".filter(c => c.status === 'تكميل' && c.time_start && c.time_end)") &&
        suppSrc.includes('_periodFromTimes'));
    check('supplementary-service.js: السياق يُمرَّر في استدعاءات validateAssignment الثلاثة (candidates + submit + review)',
        (suppSrc.match(/context: 'supplementary'/g) || []).length === 3);
    check('supplementary-service.js: بوابة التقديم ترفض كل ما ليس «تكميل» بأوقات فعلية',
        suppSrc.includes("if (!(code.status === 'تكميل' && code.time_start && code.time_end))"));
    check('validation-service.js: معامل context اختياري بافتراضي null (سلوك المستدعين الحاليين حرفيًا)',
        valSrc.includes('context = null }') && valSrc.includes("const isSupp = context === 'supplementary'"));
    check('validation-service.js: قبول «تكميل» محصور بالسياق وبأوقات فعلية — بوابة «دوام» بقيت أولى',
        valSrc.includes("code.status !== 'دوام' && !(isSupp && code.status === 'تكميل' && code.time_start && code.time_end)") &&
        valSrc.includes('_periodOfCtx'));
    for (const f of ['flex-service.js', 'swap-service.js', 'proposal-service.js']) {
        const src = fs.readFileSync(path.join(ROOT, 'services', 'schedule-engine', f), 'utf8');
        check(`سلبي: ${f} لا يمرّر context إطلاقًا (E-8/العروض/التبديل بلا تغيير)`, !src.includes('context:'));
    }
    const covSrc = fs.readFileSync(path.join(ROOT, 'services', 'schedule-engine', 'coverage-service.js'), 'utf8');
    check('سلبي: coverage-service.js لا يعرف «التكميلية» إطلاقًا (قرار ب — التغطية من «دوام» فقط)',
        !covSrc.includes('supplementary') && !covSrc.includes('تكميل'));

    console.log('\n── فحوص ستاتيكية: المسارات والصلاحيات ──');
    const suppRoutes = srvSrc.slice(srvSrc.indexOf("app.get('/api/my/supplementary-candidates'"), srvSrc.indexOf("app.get('/api/schedule/flex-requests'"));
    check('server.js: المسارات الستة موجودة (4 بوابة + 2 مراجعة)',
        ["app.get('/api/my/supplementary-candidates'", "app.post('/api/my/supplementary-requests'",
         "app.get('/api/my/supplementary-requests'", "app.post('/api/my/supplementary-requests/:id/cancel'",
         "app.get('/api/schedule/supplementary-requests'", "app.post('/api/schedule/supplementary-requests/:id/review'"].every(s => suppRoutes.includes(s)));
    check('server.js: صلاحيات قائمة فقط — ops.my_portal ×4 + schedule.requests.review ×2 (لا Permission جديد)',
        (suppRoutes.match(/authorizePerm\('ops\.my_portal'\)/g) || []).length === 4 &&
        (suppRoutes.match(/authorizePerm\('schedule\.requests\.review'\)/g) || []).length === 2);
    check('سلبي: لا مفتاح صلاحية جديد يحوي supp في server.js إطلاقًا',
        !srvSrc.match(/'(ops|schedule)\.[a-z_.]*supp[a-z_.]*'/i));
    check('server.js: الإشعارات بعد COMMIT + permKey للمراجعة = schedule.requests.review',
        suppRoutes.includes("eventKey: 'supplementary.submitted'") && suppRoutes.includes("permKey: 'schedule.requests.review'") &&
        suppRoutes.includes('notifyPersonal'));

    // ═══ 2) التهيئة المعزولة + إقلاع الخادم ═══
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(SRC_USERS, 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    const adminUser = users.find(u => u.username === '4252');
    if (!adminUser) throw new Error('المستخدم الإداري 4252 غير موجود في users.json المصدر');
    adminUser.password = hash;
    // القاعدة المصدر مخطط فقط (employees فارغة) — بذر ذاتي محكم لموظفي الاختبار
    // وربطهم بمستخدمين جدد (employee_code = username — نمط resolveEmployee)
    for (const [code, name] of [['DEMO101', 'موظف تجريبي 101'], ['DEMO102', 'موظف تجريبي 102'], ['DEMO103', 'موظف تجريبي 103']]) {
        dbRun("INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?, ?, 'مسعف', 1)", [code, name]);
        users.push({ id: 'test-' + code, username: code, name, password: hash, role: 'user', isActive: true });
    }
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    for (const un of ['DEMO101', 'DEMO102', 'DEMO103']) {
        dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'supp-test')", ['test-' + un]);
    }
    const U1 = 'test-DEMO101';
    const U2 = 'test-DEMO102';
    const UADMIN = String(adminUser.id);

    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;

    dbRun("UPDATE employees SET is_active = 0 WHERE employee_code NOT IN ('DEMO101','DEMO102','DEMO103')");
    dbRun('DELETE FROM team_assignments WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    const insTA = 'INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, ?, ?, ?, ?)';
    for (const e of [EMP1, EMP2, EMP3]) dbRun(insTA, [e, TEAM, '2026-01-01', null, 1, 'supp-test']);
    const insR = 'INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)';
    function clearEmps(date, emps) {
        dbRun(`DELETE FROM shift_roster WHERE employee_id IN (${emps.map(() => '?').join(',')}) AND shift_date = ?`, [...emps, date]);
    }

    // تواريخ الاختبار — كلها مستقبلية بفارق مريح عن نافذة الإشعار (8 ساعات)
    const T = { s1: riyadhOffset(3), s2: riyadhOffset(4), s3: riyadhOffset(5), s4: riyadhOffset(6), s5: riyadhOffset(7), s6: riyadhOffset(9), busy: riyadhOffset(10) };
    for (const d of Object.values(T)) clearEmps(d, [EMP1, EMP2, EMP3]);

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');
    dbRun('DELETE FROM unable_attend_requests WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    dbRun('DELETE FROM leave_requests WHERE employee_id IN (?, ?, ?)', [EMP1, EMP2, EMP3]);
    const demo1 = await login('DEMO101', 'test123');
    const demo2 = await login('DEMO102', 'test123');
    const demo3 = await login('DEMO103', 'test123');
    const admin = await login('4252', 'test123');

    // ═══ 3) حيًا: Migration + Fail-Closed ═══
    console.log('\n── حيًا: Migration + Fail-Closed ──');
    const suppObjects = dbAll("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE '%supp%'").map(r => r.name);
    check('Migration: الجدول + الفهرس الجزئي أُنشئا عند الإقلاع على نسخة طازجة',
        ['supplementary_requests', 'uq_supp_live_emp_date', 'idx_supp_emp_month'].every(n => suppObjects.includes(n)),
        JSON.stringify(suppObjects));
    check('الإعدادان المعلّقان غير موجودين في app_settings (نسخة الإنتاج طازجة)',
        dbAll("SELECT COUNT(*) n FROM app_settings WHERE key LIKE '%supp_%'")[0].n === 0);
    const closedC = await api('GET', `/api/my/supplementary-candidates?month=${riyadhMonth()}`, null, demo1);
    check('غياب الإعدادين ⇒ candidates = 503 SUPP_CONFIG_MISSING (Fail-Closed)',
        closedC.status === 503 && closedC.data && closedC.data.code === 'SUPP_CONFIG_MISSING', JSON.stringify(closedC.data));
    const closedS = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'CPD' }, demo1);
    check('غياب الإعدادين ⇒ submit = 503 SUPP_CONFIG_MISSING',
        closedS.status === 503 && closedS.data && closedS.data.code === 'SUPP_CONFIG_MISSING');
    check('SUPp_CONFIG_MISSING لم يُنشئ أي صف', dbAll('SELECT COUNT(*) n FROM supplementary_requests')[0].n === 0);

    // زرع الإعدادين (قيم اختبار — القرار النهائي للمالك)
    dbRun("INSERT INTO app_settings (key, value) VALUES ('schedule_engine.supp_max_per_month', '10')");
    dbRun("INSERT INTO app_settings (key, value) VALUES ('schedule_engine.supp_min_notice_hours', '8')");

    // ═══ 3ب) حيًا: القيم غير الصالحة للإعدادين ⇒ 503 آمن بلا أي كتابة ═══
    // (توجيه المالك 2026-10-09: عدد صحيح موجب حصرًا؛ 0 لا يُقبل إلا بقرار تشغيلي صريح)
    console.log('\n── حيًا: القيم غير الصالحة للإعدادين — Fail-Closed ──');
    const rosterCountBeforeInvalid = dbAll('SELECT COUNT(*) n FROM shift_roster')[0].n;
    const suppCountBeforeInvalid = dbAll('SELECT COUNT(*) n FROM supplementary_requests')[0].n;
    const suppKeys = ['schedule_engine.supp_max_per_month', 'schedule_engine.supp_min_notice_hours'];
    const invalidVals = ['abc', '0', '-3', '2.5'];
    let invalidAllClosed = true; const invalidDetails = [];
    for (const k of suppKeys) {
        const good = k.endsWith('max_per_month') ? '10' : '8';
        for (const bad of invalidVals) {
            dbRun('UPDATE app_settings SET value = ? WHERE key = ?', [bad, k]);
            const rC = await api('GET', `/api/my/supplementary-candidates?month=${riyadhMonth()}`, null, demo1);
            const rS = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'CPD' }, demo1);
            const ok = rC.status === 503 && rC.data && rC.data.code === 'SUPP_CONFIG_MISSING' &&
                       rS.status === 503 && rS.data && rS.data.code === 'SUPP_CONFIG_MISSING';
            if (!ok) { invalidAllClosed = false; invalidDetails.push(`${k}=${bad}: candidates=${rC.status} submit=${rS.status}`); }
        }
        dbRun('UPDATE app_settings SET value = ? WHERE key = ?', [good, k]);
    }
    check('القيم غير الصالحة (abc / 0 / -3 / 2.5) لكلا المفتاحين ⇒ 503 SUPP_CONFIG_MISSING في candidates وsubmit',
        invalidAllClosed, invalidDetails.join(' | '));
    check('فشل التحقق من القيم غير الصالحة لم يُنشئ أي طلب ولم يمس shift_roster',
        dbAll('SELECT COUNT(*) n FROM supplementary_requests')[0].n === suppCountBeforeInvalid &&
        dbAll('SELECT COUNT(*) n FROM shift_roster')[0].n === rosterCountBeforeInvalid);
    // تأكيد أن الاستعادة أعادت المسار السليم قبل متابعة الأقسام
    const afterRestore = await api('GET', `/api/my/supplementary-candidates?month=${riyadhMonth()}`, null, demo1);
    check('استعادة القيم الصالحة تُعيد candidates إلى 200 (لا تلوث للأقسام التالية)',
        afterRestore.status === 200, JSON.stringify(afterRestore.data).slice(0, 120));

    // ═══ 4) حيًا: عقد المقترحات ═══
    console.log('\n── حيًا: عقد المقترحات (candidates/unavailable/limits/hours) ──');
    const noMonth = await api('GET', '/api/my/supplementary-candidates', null, demo1);
    check('بلا month = 422 SUPP_INVALID_MONTH', noMonth.status === 422 && noMonth.data.code === 'SUPP_INVALID_MONTH');
    // يوم «مشغول» لـEMP1 لإثبات أسباب عدم التوفر
    dbRun(insR, [EMP1, TEAM, T.busy, 'D12', Number(T.busy.slice(5, 7)), Number(T.busy.slice(0, 4))]);
    const cand = await api('GET', `/api/my/supplementary-candidates?month=${T.busy.slice(0, 7)}`, null, demo1);
    check('candidates = 200 بالعقد الكامل (limits/hours/candidates/unavailable)',
        cand.status === 200 && cand.data && cand.data.limits && typeof cand.data.limits.max_per_month === 'number' &&
        typeof cand.data.limits.used === 'number' && cand.data.hours && 'required_hours' in cand.data.hours &&
        'worked_hours' in cand.data.hours && 'remaining_hours' in cand.data.hours &&
        Array.isArray(cand.data.candidates) && Array.isArray(cand.data.unavailable), JSON.stringify(cand.data).slice(0, 200));
    const today = riyadhOffset(0);
    check('كل أيام المقترحات مستقبلية (اليوم مستبعد بنيويًا)',
        cand.data.candidates.every(c => c.date > today) && cand.data.unavailable.every(u => u.date > today));
    const cpd = cand.data.candidates.find(c => c.shift_code === 'CPD');
    check('بطاقة candidate مكتملة الحقول — CPD (تكميلية صباحية 05:00–17:00 · 12 س · period=day)',
        !!cpd && cpd.shift_name === 'تكميلية صباحية' && cpd.time_start === '05:00' && cpd.time_end === '17:00' &&
        cpd.duration_hours === 12 && cpd.period === 'day' && typeof cpd.coverage_gap === 'boolean', JSON.stringify(cpd));
    const cpn = cand.data.candidates.find(c => c.shift_code === 'CPN');
    check('CPN يظهر كمقترح مستقل — تكميلية ليلية 17:00–05:00 · 12 س · period=night (من الأوقات الفعلية)',
        !!cpn && cpn.shift_name === 'تكميلية ليلية' && cpn.time_start === '17:00' && cpn.time_end === '05:00' &&
        cpn.duration_hours === 12 && cpn.period === 'night', JSON.stringify(cpn));
    check('لا رمز «دوام» ضمن مقترحات التكميلية إطلاقًا (D12/N12/D8 ممنوعة في هذا المسار)',
        cand.data.candidates.every(c => !['D12', 'N12', 'D8'].includes(c.shift_code)));
    const knownSupp = new Set(dbAll("SELECT code FROM shift_codes WHERE status = 'تكميل' AND time_start IS NOT NULL AND time_end IS NOT NULL").map(r => r.code));
    check('كل المقترحات رموزها «تكميل» بأوقات فعلية (CP8/CP24 بلا أوقات مستبعدة)',
        cand.data.candidates.length > 0 && cand.data.candidates.every(c => knownSupp.has(c.shift_code)));
    const busyUn = cand.data.unavailable.filter(u => u.date === T.busy);
    check('اليوم المشغول يظهر في unavailable بسبب E-4 الصحيح (MULTIPLE_SHIFTS_SAME_DAY لكل رمز)',
        busyUn.length > 0 && busyUn.every(u => Array.isArray(u.reasons) && u.reasons.includes('MULTIPLE_SHIFTS_SAME_DAY')),
        JSON.stringify(busyUn).slice(0, 200));

    // ═══ 5) حيًا: حراس التقديم — 422 بلا صف ═══
    console.log('\n── حيًا: حراس التقديم ──');
    const badDate = await api('POST', '/api/my/supplementary-requests', { target_date: '2026-13-99', shift_code: 'CPD' }, demo1);
    check('تاريخ غير صالح = 422 SUPP_INVALID_DATE', badDate.status === 422 && badDate.data.code === 'SUPP_INVALID_DATE');
    const past = await api('POST', '/api/my/supplementary-requests', { target_date: riyadhOffset(-1), shift_code: 'CPD' }, demo1);
    check('تاريخ في الماضي = 422 SUPP_PAST_DATE', past.status === 422 && past.data.code === 'SUPP_PAST_DATE');
    const badCode = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'XX9' }, demo1);
    check('رمز غير معروف = 422 SUPP_INVALID_CODE', badCode.status === 422 && badCode.data.code === 'SUPP_INVALID_CODE');
    const nonWork = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'E' }, demo1);
    check('رمز إجازة = 422 SUPP_INVALID_CODE', nonWork.status === 422 && nonWork.data.code === 'SUPP_INVALID_CODE');
    const trainC = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'C' }, demo1);
    check('رمز تدريب = 422 SUPP_INVALID_CODE (ليس تكميلية حتى بالسياق)', trainC.status === 422 && trainC.data.code === 'SUPP_INVALID_CODE');
    const noTime = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'CP8' }, demo1);
    check('رمز «تكميل» بلا أوقات فعلية (CP8) = 422 SUPP_INVALID_CODE', noTime.status === 422 && noTime.data.code === 'SUPP_INVALID_CODE');
    const duwam = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'D12' }, demo1);
    check('رمز «دوام» (D12) مرفوض في مسار التكميلية = 422 SUPP_INVALID_CODE — السياق لا يسرّب القبول للخارج',
        duwam.status === 422 && duwam.data.code === 'SUPP_INVALID_CODE', JSON.stringify(duwam.data));
    const notice = await api('POST', '/api/my/supplementary-requests', { target_date: today, shift_code: 'CPD' }, demo1);
    check('داخل نافذة الإشعار (اليوم 05:00) = 422 SUPP_NOTICE_WINDOW', notice.status === 422 && notice.data.code === 'SUPP_NOTICE_WINDOW', JSON.stringify(notice.data));
    check('كل الرفض أعلاه لم يُنشئ أي صف', dbAll('SELECT COUNT(*) n FROM supplementary_requests')[0].n === 0);

    // ═══ 6) حيًا: التقديم الصالح — pending_review بلا اعتماد آلي ═══
    console.log('\n── حيًا: التقديم الصالح ──');
    const ok1 = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'CPD' }, demo1);
    check('التقديم الصالح = 200 pending_review (لا applied آلي إطلاقًا)',
        ok1.status === 200 && ok1.data && ok1.data.status === 'pending_review' && !!ok1.data.id, JSON.stringify(ok1.data));
    const row1 = dbAll('SELECT * FROM supplementary_requests WHERE id = ?', [ok1.data.id])[0];
    check('الصف: pending_review بالفريق المشتق سيرفريًا + لقطة التحقق',
        row1.status === 'pending_review' && row1.team_id === TEAM && (row1.validation_json || '').includes('"OK"'));
    check('لا كتابة في shift_roster عند التقديم',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.s1])[0].n === 0);
    check('إشعار تشغيلي لحامل schedule.requests.review (admin) بالطلب الجديد',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [UADMIN, 'طلب مناوبة تكميلية بانتظار المراجعة'])[0].n >= 1);
    const dup = await api('POST', '/api/my/supplementary-requests', { target_date: T.s1, shift_code: 'CPN' }, demo1);
    check('تقديم ثانٍ على نفس اليوم = 409 SUPP_DUPLICATE_REQUEST', dup.status === 409 && dup.data.code === 'SUPP_DUPLICATE_REQUEST', JSON.stringify(dup.data));

    console.log('\n── حيًا: سباق تقديم متزامن على نفس اليوم ──');
    const race = await Promise.all([
        api('POST', '/api/my/supplementary-requests', { target_date: T.s2, shift_code: 'CPD' }, demo2),
        api('POST', '/api/my/supplementary-requests', { target_date: T.s2, shift_code: 'CPN' }, demo2)
    ]);
    const raceOk = race.filter(r => r.status === 200).length;
    const race409 = race.filter(r => r.status === 409 && r.data && r.data.code === 'SUPP_DUPLICATE_REQUEST').length;
    check('السباق: نجاح واحد + 409 واحد بالضبط (الفهرس الجزئي حسم)', raceOk === 1 && race409 === 1, JSON.stringify(race.map(r => [r.status, r.data && r.data.code])));
    const winnerRow = dbAll('SELECT * FROM supplementary_requests WHERE employee_id = ? AND target_date = ?', [EMP2, T.s2])[0];

    // ═══ 7) حيًا: فشل التحقق عند التقديم — rejected بأسباب ولا يستهلك العدّاد ═══
    console.log('\n── حيًا: فشل التحقق عند التقديم ──');
    const inv = await api('POST', '/api/my/supplementary-requests', { target_date: T.busy, shift_code: 'CPN' }, demo1);
    check('يوم فيه مناوبة = 200 status=rejected بأسباب E-4 (MULTIPLE_SHIFTS_SAME_DAY)',
        inv.status === 200 && inv.data && inv.data.status === 'rejected' && Array.isArray(inv.data.reasons) &&
        inv.data.reasons.includes('MULTIPLE_SHIFTS_SAME_DAY'), JSON.stringify(inv.data));
    check('الصف المرفوض مُدقَّق في القاعدة (rejected + validation_json)',
        dbAll("SELECT COUNT(*) n FROM supplementary_requests WHERE id = ? AND status = 'rejected' AND validation_json LIKE '%MULTIPLE_SHIFTS_SAME_DAY%'", [inv.data.id])[0].n === 1);

    // ═══ 8) حيًا: الحد الشهري (rejected لا يستهلك) ═══
    console.log('\n── حيًا: الحد الشهري ──');
    const monthOfS1 = T.s1.slice(0, 7);
    const usedNow = dbAll(
        `SELECT COUNT(*) n FROM supplementary_requests WHERE employee_id = ? AND month = ? AND status IN ('pending_review','escalated','applied')`,
        [EMP1, monthOfS1])[0].n;
    check('العدّاد = الطلبات الحية فقط (rejected لم يُحتسب)', usedNow === 1, 'used=' + usedNow);
    dbRun("UPDATE app_settings SET value = '1' WHERE key = 'schedule_engine.supp_max_per_month'");
    const overLimit = await api('POST', '/api/my/supplementary-requests', { target_date: T.s3, shift_code: 'CPD' }, demo1);
    check('بلوغ الحد الشهري = 422 SUPP_MONTHLY_LIMIT', overLimit.status === 422 && overLimit.data.code === 'SUPP_MONTHLY_LIMIT', JSON.stringify(overLimit.data));
    dbRun("UPDATE app_settings SET value = '10' WHERE key = 'schedule_engine.supp_max_per_month'");

    // ═══ 9) حيًا: صلاحيات المراجعة ═══
    console.log('\n── حيًا: صلاحيات المراجعة ──');
    const q403 = await api('GET', '/api/schedule/supplementary-requests', null, demo1);
    check('قائمة المراجعة بموظف بلا schedule.requests.review = 403', q403.status === 403);
    const r403 = await api('POST', `/api/schedule/supplementary-requests/${ok1.data.id}/review`, { action: 'approve' }, demo1);
    check('المراجعة بموظف بلا الصلاحية = 403', r403.status === 403);
    const queue = await api('GET', '/api/schedule/supplementary-requests', null, admin);
    check('قائمة المراجعة للمسؤول = 200 وتشمل الطلب القائم',
        queue.status === 200 && Array.isArray(queue.data.requests) && queue.data.requests.some(r => r.id === ok1.data.id));

    // ═══ 10) حيًا: الرفض ═══
    console.log('\n── حيًا: رفض المسؤول ──');
    const rej = await api('POST', `/api/schedule/supplementary-requests/${ok1.data.id}/review`, { action: 'reject', note: 'تغطية المركز لا تسمح هذا الأسبوع' }, admin);
    check('الرفض = 200 rejected + review_note محفوظ',
        rej.status === 200 && rej.data.status === 'rejected' &&
        dbAll('SELECT COUNT(*) n FROM supplementary_requests WHERE id = ? AND status = ? AND review_note = ?', [ok1.data.id, 'rejected', 'تغطية المركز لا تسمح هذا الأسبوع'])[0].n === 1);
    check('إشعار شخصي لصاحب الطلب بالرفض',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U1, 'رُفض طلب المناوبة التكميلية'])[0].n >= 1);
    check('لا كتابة في shift_roster عند الرفض',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP1, T.s1])[0].n === 0);

    // ═══ 11) حيًا: الاعتماد + التطبيق الذري ═══
    console.log('\n── حيًا: اعتماد + تطبيق ذري ──');
    const app1 = await api('POST', `/api/schedule/supplementary-requests/${winnerRow.id}/review`, { action: 'approve' }, admin);
    check('الاعتماد = 200 applied + revision_id (ذري في نفس الترانزاكشن)',
        app1.status === 200 && app1.data.status === 'applied' && !!app1.data.revision_id, JSON.stringify(app1.data));
    const winCode = winnerRow.shift_code;
    const rosterRow = dbAll('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP2, T.s2])[0];
    check('roster: صف واحد بالرمز والفريق المطلوبين بالضبط',
        !!rosterRow && rosterRow.shift_code === winCode && rosterRow.team_id === TEAM &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP2, T.s2])[0].n === 1);
    const appliedRow = dbAll('SELECT * FROM supplementary_requests WHERE id = ?', [winnerRow.id])[0];
    check('الطلب: applied + roster_id مربوط + applied_at',
        appliedRow.status === 'applied' && appliedRow.roster_id === rosterRow.id && !!appliedRow.applied_at);
    check('shift_audit_log (add) + schedule_revisions (supplementary) بنفس revision_id',
        dbAll("SELECT COUNT(*) n FROM shift_audit_log WHERE roster_id = ? AND change_type = 'add' AND revision_id = ?", [rosterRow.id, app1.data.revision_id])[0].n === 1 &&
        dbAll("SELECT COUNT(*) n FROM schedule_revisions WHERE id = ? AND source = 'supplementary'", [app1.data.revision_id])[0].n === 1);
    check('إشعار شخصي لصاحب الطلب بالاعتماد',
        dbAll('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND title = ?', [U2, 'اعتُمدت مناوبتك التكميلية'])[0].n >= 1);

    // ═══ 12) حيًا: سباق الاعتماد المزدوج ═══
    console.log('\n── حيًا: سباق اعتماد مزدوج ──');
    const ok3 = await api('POST', '/api/my/supplementary-requests', { target_date: T.s4, shift_code: 'CPD' }, demo3);
    const dbl = await Promise.all([
        api('POST', `/api/schedule/supplementary-requests/${ok3.data.id}/review`, { action: 'approve' }, admin),
        api('POST', `/api/schedule/supplementary-requests/${ok3.data.id}/review`, { action: 'approve' }, admin)
    ]);
    const dblApplied = dbl.filter(r => r.status === 200 && r.data && r.data.status === 'applied').length;
    const dblErr = dbl.filter(r => r.status === 409).length;
    check('سباق الاعتماد: applied واحد + 409 واحد بالضبط', dblApplied === 1 && dblErr === 1, JSON.stringify(dbl.map(r => [r.status, r.data && (r.data.code || r.data.status)])));
    check('سباق الاعتماد: صف roster واحد فقط (لا تطبيق مزدوج)',
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP3, T.s4])[0].n === 1);

    // ═══ 13) حيًا: تغيّر roster قبل الاعتماد ⇒ إعادة التحقق تفشل ⇒ escalated ═══
    console.log('\n── حيًا: إعادة التحقق اللحظية عند الاعتماد ──');
    const ok5 = await api('POST', '/api/my/supplementary-requests', { target_date: T.s5, shift_code: 'CPD' }, demo3);
    dbRun(insR, [EMP3, TEAM, T.s5, 'N12', Number(T.s5.slice(5, 7)), Number(T.s5.slice(0, 4))]); // تغيّر خارجي
    const stale = await api('POST', `/api/schedule/supplementary-requests/${ok5.data.id}/review`, { action: 'approve' }, admin);
    check('الاعتماد بعد تغيّر roster = escalated (revalidation_failed) بلا كتابة إضافية',
        stale.status === 200 && stale.data.status === 'escalated' &&
        dbAll("SELECT COUNT(*) n FROM supplementary_requests WHERE id = ? AND status = 'escalated' AND escalation_reason LIKE 'revalidation_failed%'", [ok5.data.id])[0].n === 1 &&
        dbAll('SELECT COUNT(*) n FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [EMP3, T.s5])[0].n === 1, JSON.stringify(stale.data));
    const retryStale = await api('POST', `/api/schedule/supplementary-requests/${ok5.data.id}/review`, { action: 'approve' }, admin);
    check('إعادة المحاولة على المصعّد تفشل بصدق (409 SUPP_REVALIDATION_FAILED) والحالة ثابتة',
        retryStale.status === 409 && retryStale.data.code === 'SUPP_REVALIDATION_FAILED' &&
        dbAll('SELECT status FROM supplementary_requests WHERE id = ?', [ok5.data.id])[0].status === 'escalated');

    // ═══ 14) حيًا: الإلغاء ═══
    console.log('\n── حيًا: الإلغاء ──');
    const ok6 = await api('POST', '/api/my/supplementary-requests', { target_date: T.s6, shift_code: 'CPD' }, demo1);
    const notMine = await api('POST', `/api/my/supplementary-requests/${ok6.data.id}/cancel`, {}, demo2);
    check('إلغاء طلب غيري = 403 SUPP_FORBIDDEN', notMine.status === 403 && notMine.data.code === 'SUPP_FORBIDDEN');
    const cancelled = await api('POST', `/api/my/supplementary-requests/${ok6.data.id}/cancel`, {}, demo1);
    check('إلغاء المالك = 200 cancelled', cancelled.status === 200 && cancelled.data.status === 'cancelled');
    const again = await api('POST', `/api/my/supplementary-requests/${ok6.data.id}/cancel`, {}, demo1);
    check('إلغاء ثانٍ = 409 SUPP_NOT_CANCELLABLE', again.status === 409 && again.data.code === 'SUPP_NOT_CANCELLABLE');
    check('cancelled لا يستهلك العدّاد ويفتح المجال لطلب جديد على يوم آخر',
        dbAll(`SELECT COUNT(*) n FROM supplementary_requests WHERE employee_id = ? AND month = ? AND status IN ('pending_review','escalated','applied')`,
            [EMP1, T.s6.slice(0, 7)])[0].n === 0);

    // ═══ 15) حيًا: الانقضاء الكسول ═══
    console.log('\n── حيًا: الانقضاء الكسول ──');
    const yesterday = riyadhOffset(-1);
    dbRun(`INSERT INTO supplementary_requests (employee_id, month, target_date, shift_code, team_id, status, created_by, updated_at)
           VALUES (?, ?, ?, 'CPD', ?, 'pending_review', ?, datetime('now'))`, [EMP1, yesterday.slice(0, 7), yesterday, TEAM, U1]);
    const mine = await api('GET', '/api/my/supplementary-requests', null, demo1);
    const expiredRow = (mine.data.requests || []).find(r => r.target_date === yesterday);
    check('الحيّ المتجاوز ليومه ⇒ expired عند القراءة (انقضاء كسول)',
        !!expiredRow && expiredRow.status === 'expired');
    check('قائمتي تعيد طلباتي فقط (ownership)',
        mine.status === 200 && (mine.data.requests || []).every(r => r.employee_id === EMP1));

    // ═══ 16) حيًا: قيود E-4 على رموز «تكميل» + قرار (ب) ═══
    console.log('\n── حيًا: M6 (ليالٍ متتالية) + الراحة الدنيا على التكميلية + ثبات التغطية ──');
    // M6: EMP3 مع CPN في d-2 وd-1 وd+1 ⇒ CPN في d يكمل 4 ليالٍ متتالية (max=3)
    const m6d = riyadhOffset(12);
    for (const dd of [riyadhOffset(10), riyadhOffset(11), m6d, riyadhOffset(13)]) clearEmps(dd, [EMP3]);
    for (const dd of [riyadhOffset(10), riyadhOffset(11), riyadhOffset(13)])
        dbRun(insR, [EMP3, TEAM, dd, 'CPN', Number(dd.slice(5, 7)), Number(dd.slice(0, 4))]);
    const m6Cand = await api('GET', `/api/my/supplementary-candidates?month=${m6d.slice(0, 7)}`, null, demo3);
    const m6Cpn = m6Cand.data.unavailable.find(u => u.date === m6d && u.shift_code === 'CPN');
    check('M6 على التكميلية: CPN بين جيران CPN (d-2/d-1/d+1) ⇒ CONSECUTIVE_NIGHTS_EXCEEDED (الجيران يُحتسبون ليالٍ عبر _periodOfCtx)',
        m6Cand.status === 200 && !!m6Cpn && m6Cpn.reasons.includes('CONSECUTIVE_NIGHTS_EXCEEDED'), JSON.stringify(m6Cpn));
    const m6CpdUn = m6Cand.data.unavailable.find(u => u.date === m6d && u.shift_code === 'CPD');
    const m6CpdOk = m6Cand.data.candidates.find(c => c.date === m6d && c.shift_code === 'CPD');
    check('M6 صارم مع الليلية فقط: CPD في اليوم نفسه لا يحمل CONSECUTIVE_NIGHTS_EXCEEDED',
        !!m6CpdOk || (m6CpdUn && !m6CpdUn.reasons.includes('CONSECUTIVE_NIGHTS_EXCEEDED')), JSON.stringify(m6CpdUn));
    // الراحة الدنيا: EMP2 مع N12 (17:00–05:00) في d2 ⇒ CPD (05:00) في d2+1 براحة 0 ساعة
    const d2 = riyadhOffset(14);
    clearEmps(d2, [EMP2]); clearEmps(riyadhOffset(15), [EMP2]);
    dbRun(insR, [EMP2, TEAM, d2, 'N12', Number(d2.slice(5, 7)), Number(d2.slice(0, 4))]);
    const restCand = await api('GET', `/api/my/supplementary-candidates?month=${riyadhOffset(15).slice(0, 7)}`, null, demo2);
    const restCpd = restCand.data.unavailable.find(u => u.date === riyadhOffset(15) && u.shift_code === 'CPD');
    check('الراحة الدنيا على التكميلية: N12 ثم CPD (راحة 0 س) ⇒ REST_BELOW_MINIMUM',
        restCand.status === 200 && !!restCpd && restCpd.reasons.includes('REST_BELOW_MINIMUM'), JSON.stringify(restCpd));
    // قرار (ب): صف CPD/CPN المطبَّق (قسم 11) لا يُحتسب في عدّ التغطية — تعريف computeCoverage = «دوام» بأوقات فقط
    const covCount = dbAll(
        `SELECT COUNT(*) n FROM shift_roster r JOIN shift_codes c ON c.code = r.shift_code
         WHERE r.team_id = ? AND r.shift_date = ? AND c.status = 'دوام' AND c.time_start IS NOT NULL`, [TEAM, T.s2])[0].n;
    const suppRowCount = dbAll('SELECT COUNT(*) n FROM shift_roster WHERE team_id = ? AND shift_date = ?', [TEAM, T.s2])[0].n;
    check('قرار (ب): تطبيق المناوبة التكميلية لا يغيّر عدّ تغطية «دوام» (الصف موجود والعدّ ثابت)',
        suppRowCount >= 1 && covCount === 0, `roster=${suppRowCount} coverageCount=${covCount}`);

    // ═══ 17) حيًا: السلامة النهائية ═══
    console.log('\n── حيًا: السلامة النهائية ──');
    check('لا ازدواج roster لأي (موظف، يوم) بين موظفي الاختبار',
        dbAll(`SELECT employee_id, shift_date, COUNT(*) n FROM shift_roster
               WHERE employee_id IN (?, ?, ?) GROUP BY employee_id, shift_date HAVING n > 1`, [EMP1, EMP2, EMP3]).length === 0);
    check('Audit: supp_submit + supp_apply + supp_expire + supp_escalate مسجلة',
        ['supp_submit', 'supp_apply', 'supp_expire', 'supp_escalate', 'supp_cancel', 'supp_review_reject'].every(a =>
            dbAll('SELECT COUNT(*) n FROM audit_log WHERE action = ?', [a])[0].n >= 1));

    console.log(`\n═══ النتيجة: ${passed} ناجح · ${failed} فاشل ═══`);
    if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
    await stopServer();
    process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
