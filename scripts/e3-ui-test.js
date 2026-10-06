// ═══ E-3 (FSS): اختبار واجهات التفضيلات وعدم التمكّن — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية.
// يغطي: (أ) فحوص ستاتيكية — صفحة المشرف وبوابتها Fail-Closed (ج4)، رابط الشريط
// الجانبي بـ schedule.requests.review (M10)، بطاقتا الموظف في my-ems (ج1)، منتقي
// الزملاء من المسار الحي (ج3 — لا بيانات ثابتة)، حد M14، سلبيات النطاق (لا
// employee_id من الواجهة، لا localStorage في مقطع E-3) · (ب) حيًا: عقد
// team-colleagues (ج3: SSOT/استبعاد النفس/النشطون فقط/العضوية المنتهية)، إنفاذ
// نافذة M8 خادميًا (ج2/ب: مغلقة⇒422 · مفتوحة⇒200+roundtrip)، بوابة المشرف
// 401/403/200، وتدفق عدم التمكّن من عقد الواجهة.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e3-'));
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
    d.prepare(sql).run(...(params || []));
    d.close();
}
function riyadhOffset(n) {
    const p = TimeRiyadh.riyadhParts(new Date());
    const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + n));
    return d.toISOString().slice(0, 10);
}
function nextMonth() {
    const p = TimeRiyadh.riyadhParts(new Date());
    let y = Number(p.year), m = Number(p.month) + 1;
    if (m > 12) { m = 1; y++; }
    return `${y}-${String(m).padStart(2, '0')}`;
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
    console.log('═══ E-3 UI TEST — تفضيلاتي + عدم التمكّن + شاشة المشرف — بيئة معزولة ═══');

    // ═══ 1) فحوص ستاتيكية (بلا خادم) ═══
    console.log('\n── فحوص ستاتيكية: صفحة المشرف (ج4) ──');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'unable-attend-admin.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'unable-attend-admin.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const myhtml = fs.readFileSync(path.join(ROOT, 'public', 'my-ems.html'), 'utf8');
    const myems = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my-ems.js'), 'utf8');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    check('unable-attend-admin.html: موجودة + RTL + هوية المنصة',
        html.includes('dir="rtl"') && html.includes('/css/platform-identity.css'));
    check('unable-attend-admin.html: تحمّل core-auth + unable-attend-admin.js?v=1 (نسخة كاش مثبتة)',
        html.includes('js/core/core-auth.js') && html.includes('js/unable-attend-admin.js?v=1'));
    check('index.html: زر «مراجعة طلبات عدم التمكّن» + navigateToPage',
        idx.includes('id="sbUnableAttendReview"') && idx.includes("navigateToPage('unable-attend-admin.html?v=1')"));
    check('index.html: إظهار الزر مشروط بـ star || schedule.requests.review (M10)',
        idx.includes("show('sbUnableAttendReview', star || perms.indexOf('schedule.requests.review') !== -1);"));
    check('unable-attend-admin.js: البوابة على /api/auth/me + schedule.requests.review + permissions_star',
        js.includes("'/api/auth/me'") && js.includes("'schedule.requests.review'") && js.includes('permissions_star'));
    check('unable-attend-admin.js: Fail-Closed — بطاقة «غير مصرّح» ولا جلب قبل اجتياز البوابة',
        js.includes('غير مصرّح') && /checkAccess\(\)\.then\(function \(ok\) \{\s*if \(!ok\) return;/.test(js));
    check('سلبي: لا input/select باسم أو معرّف employee_id في صفحة المشرف إطلاقًا',
        !/name=["']employee_id["']/.test(js) && !/id=["']employee_id["']/.test(js) &&
        !/name=["']employee_id["']/.test(html) && !/id=["']employee_id["']/.test(html));
    check('unable-attend-admin.js: نداءات العقد فقط (قائمة + review + /api/sse)',
        js.includes("'/api/schedule/unable-attend'") && js.includes("/review'") && js.includes("'/api/sse?token='"));
    check('unable-attend-admin.js: ملاحظة المراجعة اختيارية (د3) + 409 ⇒ رسالة السيرفر وإعادة جلب',
        js.includes('uaNote') && js.includes('note || undefined') && js.includes('الأولوية لحالة السيرفر'));
    check('unable-attend-admin.js: EventSource واحد فقط (لا اتصالات مكررة)',
        (js.match(/new EventSource/g) || []).length === 1);
    check('unable-attend-admin.js: الحالات الخمس معرّفة + شارة الاستثناء (M1)',
        ['pending_review', 'auto_approved', 'approved', 'rejected', 'cancelled'].every(s => js.includes(s)) && js.includes('استثناء'));

    console.log('\n── فحوص ستاتيكية: بطاقتا الموظف (ج1) ──');
    check('my-ems.js: بطاقة prefsCard + GET/PUT /api/my/schedule-preferences (عقد E-1)',
        myems.includes('id="prefsCard"') && myems.includes("api('/api/my/schedule-preferences')") &&
        myems.includes("apiSend('/api/my/schedule-preferences', 'PUT'"));
    check('my-ems.js: بطاقة unableCard + تقديم/إلغاء عبر عقد E-2',
        myems.includes('id="unableCard"') && myems.includes("apiPost('/api/my/unable-attend'") &&
        myems.includes("apiPost('/api/my/unable-attend/' + b.dataset.uacancel + '/cancel'"));
    check('my-ems.js: منتقي الزملاء من /api/my/team-colleagues الحي (ج3 — لا قائمة ثابتة)',
        myems.includes("'/api/my/team-colleagues'"));
    check('my-ems.js: حد 3 زملاء تلميح واجهة (M14) + تفضيل إيجابي فقط',
        myems.includes('الحد الأقصى لتفضيلات الزمالة هو 3') && !myems.includes('لا أريد العمل مع'));
    check('my-ems.js: حمولة تقديم عدم التمكّن بلا employee_id (اشتقاق سيرفي)',
        (() => {
            const i = myems.indexOf("apiPost('/api/my/unable-attend'");
            const block = myems.slice(i, i + 200);
            return !block.includes('employee_id');
        })());
    check('my-ems.js: تحديث لحظي عند إشعار «تمكّن» (refreshUnable عبر SSE القائم — A-1)',
        myems.includes('refreshUnable') && /تمكّن/.test(myems.slice(myems.indexOf('es.onmessage'), myems.indexOf('es.onerror'))));
    check('my-ems.js: مقطع E-3 كامل بلا localStorage (قيد المالك — كل عرض من API)',
        (() => {
            const i = myems.indexOf('FSS E-3');
            const j = myems.indexOf('v5.1: التحديث اللحظي');
            if (i === -1 || j <= i) return false;
            const code = myems.slice(i, j).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
            return !code.includes('localStorage');
        })());
    check('my-ems.html: my-ems.js?v=9 (نسخة كاش مرفوعة — E-7 رفعها من v=8) + أنماط E-3 (card-head.prefs/pf-sec)',
        myhtml.includes('js/my-ems.js?v=9') && myhtml.includes('.card-head.prefs::before') && myhtml.includes('.pf-sec'));
    check('my-ems.html: تحميل التفضيلات وعدم التمكّن ضمن Promise.all بسقوط آمن لا يُسقط الصفحة',
        myems.includes("api('/api/my/schedule-preferences').catch(() => ({ __error: true }))") &&
        myems.includes("api('/api/my/unable-attend').catch(() => ({ __error: true }))"));

    console.log('\n── فحوص ستاتيكية: مسار الزملاء في الخادم (ج3) ──');
    check('server.js: GET /api/my/team-colleagues محروس بـ ops.my_portal + هوية من الجلسة',
        srv.includes("app.get('/api/my/team-colleagues', authenticate, authorizePerm('ops.my_portal')") &&
        srv.indexOf("app.get('/api/my/team-colleagues'") < srv.indexOf("app.get('/api/my/unable-attend'"));
    check('server.js: team-colleagues من team_assignments فقط + النشطون + استبعاد النفس + العضوية الحية',
        (() => {
            const i = srv.indexOf("app.get('/api/my/team-colleagues'");
            const block = srv.slice(i, i + 2200);
            return block.includes('FROM team_assignments ta') && block.includes('e.is_active = 1') &&
                block.includes('ta.employee_id != ?') && block.includes("ta.end_date IS NULL OR ta.end_date = '' OR ta.end_date >= ?");
        })());

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
        dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e3-test')", [u.id]);
    }

    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const EMP3 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO103'")[0].id;
    const others = dbAll('SELECT id FROM employees WHERE is_active = 1 AND id NOT IN (?, ?, ?) ORDER BY id LIMIT 2', [EMP1, EMP2, EMP3]);
    const EMP_INACTIVE = others[0].id;
    const EMP_ENDED = others[1].id;
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;

    // فريق الاختبار (ج3): 3 نشطين + غير نشط + عضوية منتهية — من team_assignments حصرًا
    dbRun('DELETE FROM team_assignments WHERE employee_id IN (?, ?, ?, ?, ?)', [EMP1, EMP2, EMP3, EMP_INACTIVE, EMP_ENDED]);
    const insTA = 'INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, ?, ?, ?, ?)';
    dbRun(insTA, [EMP1, TEAM, '2026-01-01', null, 1, 'flex-e3-test']);
    dbRun(insTA, [EMP2, TEAM, '2026-01-01', null, 1, 'flex-e3-test']);
    dbRun(insTA, [EMP3, TEAM, '2026-01-01', null, 1, 'flex-e3-test']);
    dbRun(insTA, [EMP_INACTIVE, TEAM, '2026-01-01', null, 1, 'flex-e3-test']);
    dbRun(insTA, [EMP_ENDED, TEAM, '2026-01-01', riyadhOffset(-1), 1, 'flex-e3-test']);
    dbRun('UPDATE employees SET is_active = 0 WHERE id = ?', [EMP_INACTIVE]);

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');
    const demo1 = await login('DEMO101', 'test123');
    const admin = await login('4252', '4252');

    // ═══ 3) حيًا: الملفات الثابتة ═══
    console.log('\n── حيًا: الملفات الثابتة ──');
    const adminPage = await api('GET', '/unable-attend-admin.html');
    check('GET /unable-attend-admin.html = 200 + يحوي schedule.requests.review',
        adminPage.status === 200 && adminPage.text.includes('schedule.requests.review'));
    const adminJs = await api('GET', '/js/unable-attend-admin.js');
    check('GET /js/unable-attend-admin.js = 200 + يحوي البوابة',
        adminJs.status === 200 && adminJs.text.includes('checkAccess'));
    const myPage = await api('GET', '/my-ems.html');
    check('GET /my-ems.html = 200 + my-ems.js?v=9',
        myPage.status === 200 && myPage.text.includes('js/my-ems.js?v=9'));
    const myJs = await api('GET', '/js/my-ems.js');
    check('GET /js/my-ems.js = 200 + يحوي بطاقتي prefsCard/unableCard',
        myJs.status === 200 && myJs.text.includes('prefsCard') && myJs.text.includes('unableCard'));
    const home = await api('GET', '/');
    check('GET / = 200 + يحوي زر sbUnableAttendReview',
        home.status === 200 && home.text.includes('sbUnableAttendReview'));

    // ═══ 4) حيًا: عقد team-colleagues (ج3) ═══
    console.log('\n── حيًا: GET /api/my/team-colleagues ──');
    const noTokColl = await api('GET', '/api/my/team-colleagues');
    check('team-colleagues بلا توكن = 401', noTokColl.status === 401);
    const coll = await api('GET', '/api/my/team-colleagues', null, demo1);
    check('team-colleagues = 200 + team مشتق من team_assignments (SSOT)',
        coll.status === 200 && coll.data && coll.data.team && Number(coll.data.team.id) === Number(TEAM),
        JSON.stringify(coll.data && coll.data.team));
    const collIds = (coll.data.colleagues || []).map(c => Number(c.id));
    check('الموظف نفسه مستبعد من القائمة', !collIds.includes(Number(EMP1)));
    check('الزميلان النشطان (DEMO102/103) حاضران', collIds.includes(Number(EMP2)) && collIds.includes(Number(EMP3)));
    check('غير النشط مستبعد رغم عضويته الحية', !collIds.includes(Number(EMP_INACTIVE)));
    check('صاحب العضوية المنتهية مستبعد', !collIds.includes(Number(EMP_ENDED)));

    // ═══ 5) حيًا: بوابة شاشة المشرف ═══
    console.log('\n── حيًا: بوابة schedule.requests.review ──');
    const noTokQ = await api('GET', '/api/schedule/unable-attend');
    check('قائمة المراجعة بلا توكن = 401', noTokQ.status === 401);
    const empQ = await api('GET', '/api/schedule/unable-attend', null, demo1);
    check('قائمة المراجعة بموظف بلا schedule.requests.review = 403 (Fail-Closed)', empQ.status === 403);
    const adminQ = await api('GET', '/api/schedule/unable-attend', null, admin);
    check('قائمة المراجعة بحامل الصلاحية (admin *) = 200 + requests مصفوفة',
        adminQ.status === 200 && adminQ.data && Array.isArray(adminQ.data.requests));

    // ═══ 6) حيًا: نافذة M8 خادمية (ج2/ب) + roundtrip عقد التفضيلات ═══
    console.log('\n── حيًا: إنفاذ النافذة + عقد التفضيلات ──');
    const TARGET = nextMonth();
    const todayDay = Number(TimeRiyadh.riyadhParts(new Date()).day);
    // نافذة مغلقة قسرًا (يوم واحد لا يطابق اليوم) ⇒ 422 · ثم مفتوحة ⇒ 200
    const closedDay = todayDay === 1 ? 2 : 1;
    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.preference_window', ?)",
        [JSON.stringify({ open_day: closedDay, close_day: closedDay, publish_from: 21, publish_to: 25 })]);
    const closedPut = await api('PUT', '/api/my/schedule-preferences', { month: TARGET, preferences: [{ pref_type: 'shift', pref_value: 'D12' }] }, demo1);
    check('PUT خارج النافذة = 422 PREFERENCE_WINDOW_CLOSED (ج2/ب خادميًا — وليس واجهة فقط)',
        closedPut.status === 422 && closedPut.data && closedPut.data.code === 'PREFERENCE_WINDOW_CLOSED');
    const getClosed = await api('GET', '/api/my/schedule-preferences', null, demo1);
    check('GET يبقى مسموحًا خارج النافذة + يعيد window.is_open=false',
        getClosed.status === 200 && getClosed.data && getClosed.data.window && getClosed.data.window.is_open === false);

    dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.preference_window', ?)",
        [JSON.stringify({ open_day: 1, close_day: 31, publish_from: 21, publish_to: 25 })]);
    const openPut = await api('PUT', '/api/my/schedule-preferences', {
        month: TARGET,
        preferences: [
            { pref_type: 'shift', pref_value: 'D12' },
            { pref_type: 'day_off', pref_value: TARGET + '-10' },
            { pref_type: 'colleague', pref_value: String(EMP2) }
        ]
    }, demo1);
    check('PUT داخل النافذة = 200 (shift + day_off + colleague من فريقه)',
        openPut.status === 200 && openPut.data && openPut.data.success === true, JSON.stringify(openPut.data));
    const getOpen = await api('GET', '/api/my/schedule-preferences', null, demo1);
    const gotPrefs = (getOpen.data && getOpen.data.preferences) || [];
    check('GET يعيد التفضيلات الثلاث المخزَّنة (roundtrip العقد الذي تستهلكه الواجهة)',
        getOpen.status === 200 && gotPrefs.length === 3 &&
        gotPrefs.some(p => p.pref_type === 'colleague' && String(p.pref_value) === String(EMP2)));

    // ═══ 7) حيًا: تدفق عدم التمكّن من عقد الواجهة ═══
    console.log('\n── حيًا: عقد عدم التمكّن ──');
    const D1 = riyadhOffset(20);
    const submit = await api('POST', '/api/my/unable-attend', { off_date: D1, reason: 'ظرف عائلي' }, demo1);
    check('POST /api/my/unable-attend = 200 + حالة صالحة (auto_approved أو pending_review)',
        submit.status === 200 && submit.data && ['auto_approved', 'pending_review'].includes(submit.data.status),
        JSON.stringify(submit.data));
    const mine = await api('GET', '/api/my/unable-attend', null, demo1);
    check('GET /api/my/unable-attend يعكس الطلب + max_days وlive_count (عدّاد M1 للواجهة)',
        mine.status === 200 && mine.data && typeof mine.data.max_days === 'number' &&
        (mine.data.requests || []).some(r => r.off_date === D1));
    const cancel = await api('POST', '/api/my/unable-attend/' + submit.data.id + '/cancel', {}, demo1);
    check('إلغاء المالك عبر العقد = 200 cancelled (د1)', cancel.status === 200 && cancel.data && cancel.data.status === 'cancelled');

    // ═══ الخلاصة ═══
    await stopServer();
    console.log('\n═══════════════════════════════════');
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failed > 0) {
        console.log('الفاشلة:');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('✅ E-3 UI TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
