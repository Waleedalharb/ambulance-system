// ═══ E-1 (FSS): اختبار تفضيلات الموظفين — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية.
// يغطي: النافذة (M8 عبر إعدادات E-0) · اشتقاق الهوية خادميًا · ops.my_portal
// · التحققات الثمانية+ · Full-Replace ذرّي · حد الزملاء 3 (M14) · قبول زميل
// من فريق آخر (قرار E-1/②) · Audit · صفر كتابة في shift_roster (بصمة).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e1-'));
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
function setWindow(openDay, closeDay) {
    // INSERT OR REPLACE: قاعدة الإنتاج لا تحتوي مفاتيح E-0 بعد (لم تُنشر)،
    // والزرع الخامل عند الإقلاع لن يستبدل قيمتنا لأنها موجودة.
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.preference_window', ?)",
        [JSON.stringify({ open_day: openDay, close_day: closeDay, publish_from: 21, publish_to: 25 })]);
}

async function main() {
    console.log('═══ E-1 EMPLOYEE PREFERENCES TEST — بيئة معزولة ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (['DEMO101', 'DEMO102', 'DEMO103'].includes(u.username)) u.password = hash; });
    // حساب بلا ملف موظف (لاختبار NO_EMPLOYEE) — نسخ بنية مستخدم قائم بلا افتراض حقول (نمط F-2)
    const demoProto = users.find(u => u.username === 'DEMO101');
    users.push(Object.assign({}, demoProto, { id: 'test-noemp1', username: 'NOEMP1', name: 'حساب بلا ملف', password: hash }));
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));
    // ops.my_portal منحة فردية حصرًا (لا دور يحملها) — نمنحها لـ DEMO101 ولـ NOEMP1 (نمط F-2)
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e1-test')", [demoProto.id]);
    dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('test-noemp1', 'ops.my_portal', 1, 'flex-e1-test')");

    // الشهر المستهدف بتوقيت الرياض — نفس حساب الخدمة حرفيًا (الشهر القادم)
    const p = TimeRiyadh.riyadhParts(new Date());
    const cy = Number(p.year), cm = Number(p.month);
    const nm = cm === 12 ? 1 : cm + 1, ny = cm === 12 ? cy + 1 : cy;
    const TARGET = `${ny}-${String(nm).padStart(2, '0')}`;
    const OTHER_MONTH = nm === 12 ? `${ny + 1}-01` : `${ny}-${String(nm + 1).padStart(2, '0')}`;
    console.log('الشهر المستهدف: ' + TARGET + ' (اليوم الرياض: ' + cy + '-' + cm + '-' + p.day + ')');

    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    // 4 زملاء نشطين فعليين (≠ EMP1) — لاختبار حد الزمالة بمعزل عن نشاط الزميل
    const ACTIVE_COLLEAGUES = dbAll('SELECT id FROM employees WHERE is_active = 1 AND id != ? ORDER BY id LIMIT 4', [EMP1]).map(r => r.id);
    if (ACTIVE_COLLEAGUES.length < 4) throw new Error('يحتاج الاختبار 4 موظفين نشطين على الأقل غير DEMO101');
    const demo3User = users.find(u => u.username === 'DEMO103');
    // DEMO103 بلا ops.my_portal — لاختبار 403
    dbRun("DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'ops.my_portal'", [demo3User.id]);
    dbRun("DELETE FROM audit_log WHERE action = 'schedule_preferences_replace'");
    // افتح النافذة بأمان حول اليوم الحالي (اليوم بين 1 و28 دائمًا)
    setWindow(1, 28);

    const rosterFpBefore = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));
    await startServer();
    console.log('— الخادم يعمل على :' + PORT + ' —');
    // employee_preferences يُنشأ عند إقلاع الخادم (initTables) — التنظيف بعد الإقلاع
    dbRun('DELETE FROM employee_preferences WHERE month = ?', [TARGET]);
    const demo1 = await login('DEMO101', 'test123');
    const demo3 = await login('DEMO103', 'test123');
    const noemp = await login('NOEMP1', 'test123');

    console.log('\n── الوصول والهوية ──');
    const noToken = await api('GET', '/api/my/schedule-preferences', null, null);
    check('أ1: بلا توكن ⇒ 401', noToken.status === 401, 'status=' + noToken.status);
    const noPerm = await api('GET', '/api/my/schedule-preferences', null, demo3);
    check('أ2: بلا ops.my_portal ⇒ 403 (Fail-Closed)', noPerm.status === 403, 'status=' + noPerm.status);
    const adminGet = await api('GET', '/api/my/schedule-preferences', null, noemp);
    check('أ3: حساب مخوَّل بلا ملف موظف ⇒ 404 NO_EMPLOYEE', adminGet.status === 404 && adminGet.data && adminGet.data.code === 'NO_EMPLOYEE', 'status=' + adminGet.status);

    console.log('\n── النافذة والقراءة ──');
    const g0 = await api('GET', '/api/my/schedule-preferences', null, demo1);
    check('ب1: GET ينجح ويعيد النافذة مفتوحة والشهر المستهدف الصحيح',
        g0.status === 200 && g0.data.window && g0.data.window.is_open === true && g0.data.window.target_month === TARGET,
        JSON.stringify(g0.data && g0.data.window));
    check('ب2: GET يعيد مصفوفة تفضيلات فارغة في البداية', Array.isArray(g0.data.preferences) && g0.data.preferences.length === 0);

    console.log('\n── الحفظ الصحيح ──');
    const goodSet = [
        { pref_type: 'shift', pref_value: 'D12' },
        { pref_type: 'shift', pref_value: 'N10' },
        { pref_type: 'day_off', pref_value: TARGET + '-15' },
        { pref_type: 'colleague', pref_value: String(EMP2) },
        { pref_type: 'colleague', pref_value: String(EMP3) }  // زميل آخر (ربما فريق مختلف) — يُقبل ولا يُرفض (قرار E-1/②)
    ];
    const put1 = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: goodSet }, demo1);
    check('ج1: حفظ 5 تفضيلات صحيحة (شيفت/راحة/زميلان) ⇒ 200', put1.status === 200 && put1.data.success === true, JSON.stringify(put1.data).slice(0, 200));
    check('ج2: الاستجابة تعرض added=5 وremoved=0', put1.data.added && put1.data.added.length === 5 && put1.data.removed && put1.data.removed.length === 0,
        'added=' + (put1.data.added || []).length + ' removed=' + (put1.data.removed || []).length);
    const rowsAfter1 = dbAll('SELECT * FROM employee_preferences WHERE employee_id = ? AND month = ?', [EMP1, TARGET]);
    check('ج3: القاعدة تحتوي 5 صفوف بـ created_by مشتق خادميًا (ليس من العميل)',
        rowsAfter1.length === 5 && rowsAfter1.every(r => String(r.created_by) === String(demoProto.id)),
        'rows=' + rowsAfter1.length);
    const g1 = await api('GET', '/api/my/schedule-preferences', null, demo1);
    check('ج4: GET يعكس المجموعة المحفوظة (5 عناصر)', g1.data.preferences.length === 5, 'got=' + g1.data.preferences.length);

    console.log('\n── الاستبدال الكامل ──');
    const put2 = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'D12' }] }, demo1);
    check('د1: استبدال بعنصر واحد ⇒ 200', put2.status === 200);
    check('د2: added=0 (D12 موجودة) وremoved=4', (put2.data.added || []).length === 0 && (put2.data.removed || []).length === 4,
        'added=' + (put2.data.added || []).length + ' removed=' + (put2.data.removed || []).length);
    const rowsAfter2 = dbAll('SELECT * FROM employee_preferences WHERE employee_id = ? AND month = ?', [EMP1, TARGET]);
    check('د3: القاعدة تحتوي صفًا واحدًا فقط بعد الاستبدال', rowsAfter2.length === 1 && rowsAfter2[0].pref_value === 'D12');
    const putEmpty = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [] }, demo1);
    check('د4: مصفوفة فارغة = مسح الكل ⇒ 200 وصفر صفوف',
        putEmpty.status === 200 && dbAll('SELECT * FROM employee_preferences WHERE employee_id = ? AND month = ?', [EMP1, TARGET]).length === 0);

    console.log('\n── أكواد الرفض (صفر كتابة لكل منها) ──');
    const badMonth = await api('PUT', '/api/my/schedule-preferences', { month: '2026-1', preferences: [] }, demo1);
    check('ه1: شهر بصيغة خاطئة ⇒ 422 INVALID_MONTH', badMonth.status === 422 && badMonth.data.code === 'INVALID_MONTH', badMonth.status + '/' + (badMonth.data || {}).code);
    const otherMonth = await api('PUT', '/api/my/schedule-preferences', { month: OTHER_MONTH, preferences: [] }, demo1);
    check('ه2: شهر غير المستهدف ⇒ 422 PREFERENCE_WINDOW_CLOSED', otherMonth.status === 422 && otherMonth.data.code === 'PREFERENCE_WINDOW_CLOSED');
    const badType = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'night', pref_value: 'x' }] }, demo1);
    check('ه3: نوع غير معروف ⇒ 422 INVALID_PREF_TYPE', badType.status === 422 && badType.data.code === 'INVALID_PREF_TYPE');
    const badCode = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'ZZZ' }] }, demo1);
    check('ه4: رمز غير موجود ⇒ 422 INVALID_SHIFT_CODE', badCode.status === 422 && badCode.data.code === 'INVALID_SHIFT_CODE');
    const leaveCode = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'V' }] }, demo1);
    check('ه5: رمز بحالة غير «دوام» (V=إجازة) ⇒ 422 INVALID_SHIFT_CODE', leaveCode.status === 422 && leaveCode.data.code === 'INVALID_SHIFT_CODE');
    const badDate = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'day_off', pref_value: OTHER_MONTH + '-10' }] }, demo1);
    check('ه6: راحة خارج الشهر المستهدف ⇒ 422 INVALID_DAY_OFF_DATE', badDate.status === 422 && badDate.data.code === 'INVALID_DAY_OFF_DATE');
    const badDate2 = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'day_off', pref_value: TARGET + '-32' }] }, demo1);
    check('ه7: تاريخ مشوه (يوم 32) ⇒ 422 INVALID_DAY_OFF_DATE', badDate2.status === 422 && badDate2.data.code === 'INVALID_DAY_OFF_DATE');
    const selfColleague = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'colleague', pref_value: String(EMP1) }] }, demo1);
    check('ه8: تفضيل النفس ⇒ 422 COLLEAGUE_SELF', selfColleague.status === 422 && selfColleague.data.code === 'COLLEAGUE_SELF');
    const ghostColleague = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'colleague', pref_value: '999999' }] }, demo1);
    check('ه9: زميل غير موجود ⇒ 422 COLLEAGUE_NOT_ACTIVE', ghostColleague.status === 422 && ghostColleague.data.code === 'COLLEAGUE_NOT_ACTIVE');
    const fourColleagues = await api('PUT', '/api/my/schedule-preferences', {
        month: TARGET, preferences: ACTIVE_COLLEAGUES.map(id => ({ pref_type: 'colleague', pref_value: String(id) }))
    }, demo1);
    check('ه10: 4 زملاء ⇒ 422 COLLEAGUE_LIMIT_EXCEEDED (M14: حد 3)', fourColleagues.status === 422 && fourColleagues.data.code === 'COLLEAGUE_LIMIT_EXCEEDED');
    const dup = await api('PUT', '/api/my/schedule-preferences', {
        month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'D12' }, { pref_type: 'shift', pref_value: 'D12' }]
    }, demo1);
    check('ه11: تكرار نفس التفضيل ⇒ 422 DUPLICATE_PREFERENCE', dup.status === 422 && dup.data.code === 'DUPLICATE_PREFERENCE');

    console.log('\n── الذرّية والنافذة المغلقة ──');
    await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'N12' }] }, demo1);
    const atomic = await api('PUT', '/api/my/schedule-preferences', {
        month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'D8' }, { pref_type: 'shift', pref_value: 'ZZZ' }]
    }, demo1);
    const rowsAfterAtomic = dbAll('SELECT * FROM employee_preferences WHERE employee_id = ? AND month = ?', [EMP1, TARGET]);
    check('و1: عنصر غير صالح ضمن حمولة ⇒ 422', atomic.status === 422);
    check('و2: الذرّية: المجموعة السابقة (N12) بقيت كما هي — صفر كتابة جزئية',
        rowsAfterAtomic.length === 1 && rowsAfterAtomic[0].pref_value === 'N12', JSON.stringify(rowsAfterAtomic));
    setWindow(25, 26); // اليوم (6) خارجها ⇒ مغلقة
    const closedPut = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'D12' }] }, demo1);
    check('و3: نافذة مغلقة ⇒ 422 PREFERENCE_WINDOW_CLOSED مع توجيه للمسارات اليدوية',
        closedPut.status === 422 && closedPut.data.code === 'PREFERENCE_WINDOW_CLOSED' && /تغيير المناوبة|التبديل|الإجازة/.test(closedPut.data.error || ''));
    const closedGet = await api('GET', '/api/my/schedule-preferences', null, demo1);
    check('و4: GET يعرض is_open=false عند الإغلاق (القراءة لا تُغلق)', closedGet.status === 200 && closedGet.data.window.is_open === false);
    setWindow(1, 28); // إعادة الفتح للفحوص الأخيرة

    console.log('\n── القيود والتدقيق والعزل ──');
    let uniqueThrew = false;
    try { dbRun('INSERT INTO employee_preferences (employee_id, month, pref_type, pref_value, created_by) VALUES (?, ?, ?, ?, ?)', [EMP1, TARGET, 'shift', 'N12', 1]); }
    catch (e) { uniqueThrew = true; }
    check('ز1: قيد UNIQUE (employee+month+type+value) يمنع التكرار على مستوى القاعدة', uniqueThrew);
    let checkThrew = false;
    try { dbRun('INSERT INTO employee_preferences (employee_id, month, pref_type, pref_value, created_by) VALUES (?, ?, ?, ?, ?)', [EMP1, TARGET, 'bogus', 'x', 1]); }
    catch (e) { checkThrew = true; }
    check('ز2: قيد CHECK يمنع نوعًا غير معروف على مستوى القاعدة', checkThrew);
    const audits = dbAll("SELECT * FROM audit_log WHERE action = 'schedule_preferences_replace' ORDER BY id");
    check('ز3: بالضبط 4 قيود Audit = الحفظات الناجحة الأربع فقط (كل 422 فاشل ترك صفر Audit — ذرّية التدقيق مع الكتابة)',
        audits.length === 4 && audits.every(a => a.user_name && a.detail.includes(TARGET)), 'audits=' + audits.length);
    check('ز3ب: user_id في كل قيود الـAudit مشتق خادميًا من الجلسة (لا من الـpayload)',
        audits.every(a => String(a.user_id) === String(demoProto.id) && a.type === 'schedule'));
    const rosterFpAfter = fp(dbAll('SELECT * FROM shift_roster ORDER BY id'));
    check('ز4: بصمة shift_roster لم تتغير — E-1 لا يكتب في الجدول إطلاقًا', rosterFpBefore === rosterFpAfter);
    const mrh = dbAll("SELECT value FROM app_settings WHERE key = 'monthly_required_hours'");
    check('ز5: monthly_required_hours محفوظ (لم يُمس)', mrh.length === 1 && JSON.parse(mrh[0].value) === 192);
    const otherEmpRows = dbAll('SELECT * FROM employee_preferences WHERE employee_id != ? AND month = ?', [EMP1, TARGET]);
    check('ز6: عزل الموظفين — لا صفوف لموظف آخر من عمليات DEMO101', otherEmpRows.length === 0);

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
