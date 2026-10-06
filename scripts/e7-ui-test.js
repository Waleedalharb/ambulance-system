// ═══ E-7 (FSS): اختبار واجهات العروض التكميلية والتبديل بالتراضي — بيئة معزولة بالكامل ═══
// نسخة VACUUM مؤقتة + users.json مؤقت — لا يلمس data/ الحقيقية.
// يغطي: (أ) فحوص ستاتيكية — بطاقتا البوابة (proposalsCard/swapCard)، شاشتا المسؤول
// (shift-swap-admin/schedule-proposals-admin) وبوابتاهما Fail-Closed، رابطا الشريط
// الجانبي بصلاحيتيهما، L4 (لا M5 في بطاقة الموظف — التفصيل للمسؤول فقط)، L2 (لا API
// جديد — مناوبتي من /api/my/schedule القائم)، L5 (الزملاء من team-colleagues)،
// سلبيات النطاق (لا localStorage في مقطع E-7، لا employee_id في حمولة الواجهة، لا
// endpoint غير العقود المجمّدة) · (ب) حيًا: الملفات الثابتة، بوابات الصلاحية
// 401/403/200 للمسارين، عقدا /api/my/proposals و/api/my/shift-swaps، وتدفق تبديل
// كامل عبر عقد الواجهة (تقديم ⇐ رفض الطرف الثاني ⇐ إلغاء المبادر).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3102;
const BASE = `http://localhost:${PORT}`;
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e7-'));
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
    console.log('═══ E-7 UI TEST — عروضي التكميلية + التبديل بالتراضي + شاشتا المسؤول — بيئة معزولة ═══');

    // ═══ 1) فحوص ستاتيكية (بلا خادم) ═══
    console.log('\n── فحوص ستاتيكية: بطاقتا البوابة (L1) ──');
    const myhtml = fs.readFileSync(path.join(ROOT, 'public', 'my-ems.html'), 'utf8');
    const myems = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my-ems.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const swapHtml = fs.readFileSync(path.join(ROOT, 'public', 'shift-swap-admin.html'), 'utf8');
    const swapJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'shift-swap-admin.js'), 'utf8');
    const propHtml = fs.readFileSync(path.join(ROOT, 'public', 'schedule-proposals-admin.html'), 'utf8');
    const propJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'schedule-proposals-admin.js'), 'utf8');

    check('my-ems.js: بطاقة proposalsCard + GET /api/my/proposals + respond بعقد accept|decline',
        myems.includes('id="proposalsCard"') && myems.includes("api('/api/my/proposals')") &&
        myems.includes("apiPost('/api/my/proposals/' + id + '/respond'") &&
        myems.includes("decision: isAccept ? 'accept' : 'decline'"));
    check('my-ems.js: حالات العروض الخمس معرّفة (offered/accepted/declined/withdrawn/superseded)',
        ['offered', 'accepted', 'declined', 'withdrawn', 'superseded'].every(s => myems.includes(s)));
    check('my-ems.js: بطاقة swapCard + عقد E-6 (submit/consent/cancel)',
        myems.includes('id="swapCard"') && myems.includes("apiPost('/api/my/shift-swaps'") &&
        myems.includes("'/consent'") && myems.includes("'/cancel'") && myems.includes("api('/api/my/shift-swaps')"));
    check('my-ems.js: حالات التبديل السبع معرّفة',
        ['pending_consent', 'declined_by_peer', 'pending_review', 'auto_applied', 'applied', 'rejected', 'cancelled'].every(s => myems.includes(s)));

    console.log('\n── فحوص ستاتيكية: L4 — لا M5 في بطاقة الموظف ──');
    check('my-ems.js: سبب العرض للموظف مبسّط وثابت (لا ترتيب ولا عدالة)',
        myems.includes('وصلك هذا العرض لأنه متوافق مع تفضيلاتك وقواعد الجدولة'));
    check('my-ems.js: مقطع E-7 لا يعرض ranking_explanation/pref_ratio/burden إطلاقًا (الكود — التعليقات الموثقة تُستثنى)',
        (() => {
            const i = myems.indexOf('FSS E-7');
            const j = myems.indexOf('v5.1: التحديث اللحظي');
            if (i === -1 || j <= i) return false;
            const code = myems.slice(i, j).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
            return !code.includes('ranking_explanation') && !code.includes('pref_ratio') &&
                !code.includes('burden_nights') && !code.includes('rank_position');
        })());

    console.log('\n── فحوص ستاتيكية: L2/L5 — مصادر الواجهة ──');
    check('my-ems.js: مناوبتي من /api/my/schedule القائم (L2 — لا API جديد للمناوبات)',
        /api\(`\/api\/my\/schedule\?month=\$\{m\}&year=\$\{y\}`\)/.test(myems));
    check('my-ems.js: الزملاء من /api/my/team-colleagues الحي (L5 — لا قائمة ثابتة)',
        myems.includes("api('/api/my/team-colleagues')"));
    check('my-ems.js: حمولة التبديل = target_employee_id + التاريخان فقط (لا roster_id/shift_code من العميل)',
        myems.includes('{ target_employee_id: Number(collId), my_shift_date: myDate, target_shift_date: targetDate }'));
    check('my-ems.js: مقطع E-7 كامل بلا localStorage (قيد المالك — كل عرض من API)',
        (() => {
            const i = myems.indexOf('FSS E-7');
            const j = myems.indexOf('v5.1: التحديث اللحظي');
            if (i === -1 || j <= i) return false;
            const code = myems.slice(i, j).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
            return !code.includes('localStorage');
        })());
    check('my-ems.js: تحديث لحظي — «تكميلي»⇒refreshProposals و«تبديل»⇒refreshSwaps+refreshSchedule (A-1 القائم)',
        (() => {
            const i = myems.indexOf('es.onmessage');
            const j = myems.indexOf('es.onerror');
            const block = myems.slice(i, j);
            return /تكميلي/.test(block) && /تبديل/.test(block) &&
                block.includes('refreshProposals()') && block.includes('refreshSwaps()') && block.includes('refreshSchedule()');
        })());
    check('my-ems.html: my-ems.js?v=9 (نسخة كاش مرفوعة للبطاقتين الجديدتين)',
        myhtml.includes('js/my-ems.js?v=9'));
    check('my-ems.js: الجلبان الجديدان ضمن Promise.all بسقوط آمن لا يُسقط الصفحة',
        myems.includes("api('/api/my/proposals').catch(() => ({ __error: true }))") &&
        myems.includes("api('/api/my/shift-swaps').catch(() => ({ __error: true }))"));

    console.log('\n── فحوص ستاتيكية: شاشة مراجعة التبديل ──');
    check('shift-swap-admin.html: موجودة + RTL + هوية المنصة + core-auth + js?v=1',
        swapHtml.includes('dir="rtl"') && swapHtml.includes('/css/platform-identity.css') &&
        swapHtml.includes('js/core/core-auth.js') && swapHtml.includes('js/shift-swap-admin.js?v=1'));
    check('shift-swap-admin.js: البوابة على /api/auth/me + schedule.requests.review + permissions_star',
        swapJs.includes("'/api/auth/me'") && swapJs.includes("'schedule.requests.review'") && swapJs.includes('permissions_star'));
    check('shift-swap-admin.js: Fail-Closed — بطاقة «غير مصرّح» ولا جلب قبل اجتياز البوابة',
        swapJs.includes('غير مصرّح') && /checkAccess\(\)\.then\(function \(ok\) \{\s*if \(!ok\) return;/.test(swapJs));
    check('shift-swap-admin.js: نداءات العقد فقط (قائمة + review + /api/sse) — لا API جديد',
        swapJs.includes("'/api/schedule/shift-swaps'") && swapJs.includes("/review'") && swapJs.includes("'/api/sse?token='") &&
        !swapJs.includes('/api/my/'));
    check('shift-swap-admin.js: ترجمة escalation_reason — النافذة + roster_changed + أكواد E-4 (REST_BELOW_MINIMUM…)',
        swapJs.includes('roster_changed_at_consent') && swapJs.includes('48') &&
        ['REST_BELOW_MINIMUM', 'CONSECUTIVE_NIGHTS_EXCEEDED', 'SHIFT_OVERLAP', 'NEXT_DAY_CONFLICT',
         'MULTIPLE_SHIFTS_SAME_DAY', 'LEAVE_CONFLICT_APPROVED', 'UNABLE_ATTEND_CONFLICT',
         'EMPLOYEE_NO_ACTIVE_TEAM', 'EMPLOYEE_NOT_ACTIVE', 'COVERAGE_BELOW_MINIMUM'].every(c => swapJs.includes(c)));
    check('سلبي: نصوص أسباب المراجعة المعروضة للمسؤول خالية من أي رمز داخلي (قرار المالك — تبسيط العرض فقط)',
        (() => {
            const block = swapJs.slice(swapJs.indexOf('var REASON_LABEL'), swapJs.indexOf('var REASON_FALLBACK'));
            const values = Array.from(block.matchAll(/:\s*'([^']+)'/g)).map(m => m[1]);
            return values.length >= 10 && values.every(v => !/[A-Z0-9_]{5,}/.test(v)) &&
                swapJs.includes('REASON_FALLBACK') && swapJs.includes('سبب المراجعة') &&
                !swapJs.includes("' (' + code") && !swapHtml.includes('escalation_reason');
        })());
    check('shift-swap-admin.js: قرار approve|reject + note اختيارية + 409⇒رسالة السيرفر وإعادة جلب',
        swapJs.includes("decide('approve')") && swapJs.includes("decide('reject')") &&
        swapJs.includes('note || undefined') && swapJs.includes('الأولوية لحالة السيرفر'));
    check('shift-swap-admin.js: EventSource واحد فقط + الحالات السبع في الفلتر',
        (swapJs.match(/new EventSource/g) || []).length === 1 &&
        ['pending_review', 'pending_consent', 'auto_applied', 'applied', 'declined_by_peer', 'rejected', 'cancelled'].every(s => swapHtml.includes(s)));
    check('سلبي: لا input/select باسم أو معرّف employee_id في شاشة التبديل إطلاقًا',
        !/name=["']employee_id["']/.test(swapJs) && !/id=["']employee_id["']/.test(swapJs) &&
        !/name=["']employee_id["']/.test(swapHtml) && !/id=["']employee_id["']/.test(swapHtml));

    console.log('\n── فحوص ستاتيكية: شاشة العروض التكميلية ──');
    check('schedule-proposals-admin.html: موجودة + RTL + هوية المنصة + core-auth + js?v=1',
        propHtml.includes('dir="rtl"') && propHtml.includes('/css/platform-identity.css') &&
        propHtml.includes('js/core/core-auth.js') && propHtml.includes('js/schedule-proposals-admin.js?v=1'));
    check('schedule-proposals-admin.js: البوابة على /api/auth/me + schedule.proposals.manage + permissions_star',
        propJs.includes("'/api/auth/me'") && propJs.includes("'schedule.proposals.manage'") && propJs.includes('permissions_star'));
    check('schedule-proposals-admin.js: Fail-Closed — بطاقة «غير مصرّح» ولا جلب قبل اجتياز البوابة',
        propJs.includes('غير مصرّح') && /checkAccess\(\)\.then\(function \(ok\) \{\s*if \(!ok\) return;/.test(propJs));
    check('schedule-proposals-admin.js: نداءات العقد الأربعة فقط (generate/list/runs/withdraw) + /api/teams',
        propJs.includes("'/api/schedule/proposals/generate'") && propJs.includes("'/api/schedule/proposals'") &&
        propJs.includes("'/api/schedule/proposals/runs/'") && propJs.includes("'/withdraw'") &&
        propJs.includes("'/api/teams'") && !propJs.includes('/api/my/'));
    check('schedule-proposals-admin.js: تفصيل عوامل الترتيب الكامل للمسؤول (L4) — الأبعاد الأربعة في نافذة التشغيلة بصياغة عربية',
        propJs.includes('pref_fulfilled') && propJs.includes('pref_total') && propJs.includes('burden_nights') &&
        propJs.includes('rank_position') && propJs.includes('عمر الطلب') && propJs.includes('employee_id'));
    check('schedule-proposals-admin.js: سحب يوضح تسلسل J5 + 409 MONTH_PUBLISHED⇒رسالة السيرفر',
        propJs.includes('J5') && propJs.includes('رسالة السيرفر') && propJs.includes('MONTH_PUBLISHED'));
    check('schedule-proposals-admin.js: EventSource واحد فقط + شهر افتراضي = الشهر القادم',
        (propJs.match(/new EventSource/g) || []).length === 1 && propJs.includes('nextMonthValue'));
    check('سلبي: واجهة العروض تعرض عوامل الترتيب بالعربي فقط — لا رموز داخلية في HTML ولا أكواد خام معروضة (قرار المالك)',
        !/M5|J5|K4/.test(propHtml) &&
        propJs.includes('translateInvalidated') && propJs.includes('translateNote') &&
        propJs.includes('عوامل الترتيب') && propJs.includes('الأقدم رقمًا وظيفيًا') &&
        !propJs.includes("'رتبة M5'") && !propHtml.includes('رتبة M5'));
    check('schedule-proposals-admin.js: توضيح «ليست تقييمًا لأداء الموظف» تحت عوامل الترتيب (قرار المالك)',
        propJs.includes('لا تمثل تقييمًا لأداء الموظف') && propJs.includes('m5-note') && propHtml.includes('.m5-note'));

    console.log('\n── فحوص ستاتيكية: روابط التنقل ──');
    check('index.html: زرا «مراجعة طلبات التبديل» و«العروض التكميلية» + navigateToPage',
        idx.includes('id="sbShiftSwapReview"') && idx.includes("navigateToPage('shift-swap-admin.html?v=1')") &&
        idx.includes('id="sbScheduleProposals"') && idx.includes("navigateToPage('schedule-proposals-admin.html?v=1')"));
    check('index.html: إظهارهما مشروط بصلاحيتيهما الصحيحتين',
        idx.includes("show('sbShiftSwapReview', star || perms.indexOf('schedule.requests.review') !== -1);") &&
        idx.includes("show('sbScheduleProposals', star || perms.indexOf('schedule.proposals.manage') !== -1);"));

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
        dbRun("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'flex-e7-test')", [u.id]);
    }

    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;
    const EMP2 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO102'")[0].id;
    const TEAM = dbAll("SELECT id FROM teams WHERE name = 'جنوب 1'")[0].id;

    // فريق الاختبار: DEMO101 + DEMO102 نشطان بنفس الفريق (K3) — عضوية حية من team_assignments
    dbRun('DELETE FROM team_assignments WHERE employee_id IN (?, ?)', [EMP1, EMP2]);
    const insTA = 'INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, ?, ?, ?, ?)';
    dbRun(insTA, [EMP1, TEAM, '2026-01-01', null, 1, 'flex-e7-test']);
    dbRun(insTA, [EMP2, TEAM, '2026-01-01', null, 1, 'flex-e7-test']);

    // مناوبتان فعليتان في shift_roster (تواريخ مستقبلية — نافذة 48س لا تنطبق)
    const D1 = riyadhOffset(10), D2 = riyadhOffset(12), D3 = riyadhOffset(14), D4 = riyadhOffset(16);
    const insR = 'INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)';
    for (const [emp, dt] of [[EMP1, D1], [EMP2, D2], [EMP1, D3], [EMP2, D4]]) {
        dbRun('DELETE FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [emp, dt]);
        dbRun(insR, [emp, TEAM, dt, 'D12', Number(dt.slice(5, 7)), Number(dt.slice(0, 4))]);
    }

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');
    const demo1 = await login('DEMO101', 'test123');
    const demo2 = await login('DEMO102', 'test123');
    const admin = await login('4252', '4252');

    // ═══ 3) حيًا: الملفات الثابتة ═══
    console.log('\n── حيًا: الملفات الثابتة ──');
    const swapPage = await api('GET', '/shift-swap-admin.html');
    check('GET /shift-swap-admin.html = 200 + عنوانها التشغيلي العربي (لا مفاتيح صلاحيات في الصفحة — قرار المالك)',
        swapPage.status === 200 && swapPage.text.includes('مراجعة طلبات التبديل بالتراضي') &&
        !swapPage.text.includes('schedule.requests.review'));
    const swapJsLive = await api('GET', '/js/shift-swap-admin.js');
    check('GET /js/shift-swap-admin.js = 200 + يحوي البوابة',
        swapJsLive.status === 200 && swapJsLive.text.includes('checkAccess'));
    const propPage = await api('GET', '/schedule-proposals-admin.html');
    check('GET /schedule-proposals-admin.html = 200 + عنوانها التشغيلي العربي (لا مفاتيح صلاحيات في الصفحة — قرار المالك)',
        propPage.status === 200 && propPage.text.includes('العروض التكميلية للجدولة') &&
        !propPage.text.includes('schedule.proposals.manage'));
    const propJsLive = await api('GET', '/js/schedule-proposals-admin.js');
    check('GET /js/schedule-proposals-admin.js = 200 + يحوي البوابة',
        propJsLive.status === 200 && propJsLive.text.includes('checkAccess'));
    const myPage = await api('GET', '/my-ems.html');
    check('GET /my-ems.html = 200 + my-ems.js?v=9',
        myPage.status === 200 && myPage.text.includes('js/my-ems.js?v=9'));
    const myJsLive = await api('GET', '/js/my-ems.js');
    check('GET /js/my-ems.js = 200 + يحوي بطاقتي proposalsCard/swapCard',
        myJsLive.status === 200 && myJsLive.text.includes('proposalsCard') && myJsLive.text.includes('swapCard'));
    const home = await api('GET', '/');
    check('GET / = 200 + يحوي زري sbShiftSwapReview/sbScheduleProposals',
        home.status === 200 && home.text.includes('sbShiftSwapReview') && home.text.includes('sbScheduleProposals'));

    // ═══ 4) حيًا: بوابات الصلاحية للمسارين (Fail-Closed) ═══
    console.log('\n── حيًا: بوابات schedule.requests.review و schedule.proposals.manage ──');
    const noTokSw = await api('GET', '/api/schedule/shift-swaps');
    check('قائمة التبديل بلا توكن = 401', noTokSw.status === 401);
    const empSw = await api('GET', '/api/schedule/shift-swaps', null, demo1);
    check('قائمة التبديل بموظف بلا schedule.requests.review = 403', empSw.status === 403);
    const adminSw = await api('GET', '/api/schedule/shift-swaps?status=pending_review', null, admin);
    check('قائمة التبديل بحامل الصلاحية (admin *) = 200 + requests مصفوفة',
        adminSw.status === 200 && adminSw.data && Array.isArray(adminSw.data.requests));

    const noTokPr = await api('GET', '/api/schedule/proposals?month=2027-01&team_id=' + TEAM);
    check('قائمة العروض بلا توكن = 401', noTokPr.status === 401);
    const empPr = await api('GET', '/api/schedule/proposals?month=2027-01&team_id=' + TEAM, null, demo1);
    check('قائمة العروض بموظف بلا schedule.proposals.manage = 403', empPr.status === 403);
    const empGen = await api('POST', '/api/schedule/proposals/generate', { month: '2027-01', team_id: TEAM }, demo1);
    check('توليد العروض بموظف بلا schedule.proposals.manage = 403', empGen.status === 403);
    const adminPr = await api('GET', '/api/schedule/proposals?month=2027-01&team_id=' + TEAM, null, admin);
    check('قائمة العروض بحامل الصلاحية = 200 + proposals مصفوفة',
        adminPr.status === 200 && adminPr.data && Array.isArray(adminPr.data.proposals));
    const adminPrBad = await api('GET', '/api/schedule/proposals?team_id=' + TEAM, null, admin);
    check('قائمة العروض بلا month = 422 INVALID_MONTH (عقد E-5 محفوظ)',
        adminPrBad.status === 422 && adminPrBad.data && adminPrBad.data.code === 'INVALID_MONTH');

    // ═══ 5) حيًا: عقدا البوابة اللذان تستهلكهما البطاقتان ═══
    console.log('\n── حيًا: /api/my/proposals + /api/my/shift-swaps ──');
    const myProps = await api('GET', '/api/my/proposals', null, demo1);
    check('GET /api/my/proposals = 200 + proposals مصفوفة (عقد بطاقة العروض)',
        myProps.status === 200 && myProps.data && Array.isArray(myProps.data.proposals));
    const mySw = await api('GET', '/api/my/shift-swaps', null, demo1);
    check('GET /api/my/shift-swaps = 200 + requests مصفوفة (عقد بطاقة التبديل)',
        mySw.status === 200 && mySw.data && Array.isArray(mySw.data.requests));
    const mySwNoTok = await api('GET', '/api/my/shift-swaps');
    check('عقدا البوابة بلا توكن = 401', mySwNoTok.status === 401 && (await api('GET', '/api/my/proposals')).status === 401);

    // ═══ 6) حيًا: تدفق تبديل كامل عبر عقد الواجهة (تقديم ⇐ رفض ⇐ إلغاء) ═══
    console.log('\n── حيًا: تدفق التبديل من عقد الواجهة ──');
    const submit1 = await api('POST', '/api/my/shift-swaps',
        { target_employee_id: EMP2, my_shift_date: D1, target_shift_date: D2 }, demo1);
    check('POST /api/my/shift-swaps (حمولة الواجهة: زميل + تاريخان فقط) = 200 pending_consent',
        submit1.status === 200 && submit1.data && submit1.data.status === 'pending_consent', JSON.stringify(submit1.data));
    const targetView = await api('GET', '/api/my/shift-swaps', null, demo2);
    const incoming = (targetView.data.requests || []).find(r => Number(r.id) === Number(submit1.data.id));
    check('الهدف يرى الطلب مُثرى بالأسماء والفريق (ما تعرضه البطاقة)',
        !!incoming && !!incoming.initiator_name && !!incoming.team_name &&
        incoming.initiator_shift_code === 'D12' && incoming.target_shift_code === 'D12');
    const decline = await api('POST', '/api/my/shift-swaps/' + submit1.data.id + '/consent', { decision: 'decline' }, demo2);
    check('رفض الطرف الثاني عبر العقد = 200 declined_by_peer',
        decline.status === 200 && decline.data && decline.data.status === 'declined_by_peer');

    const submit2 = await api('POST', '/api/my/shift-swaps',
        { target_employee_id: EMP2, my_shift_date: D3, target_shift_date: D4 }, demo1);
    check('طلب ثانٍ للإلغاء = 200 pending_consent',
        submit2.status === 200 && submit2.data && submit2.data.status === 'pending_consent', JSON.stringify(submit2.data));
    const cancel = await api('POST', '/api/my/shift-swaps/' + submit2.data.id + '/cancel', {}, demo1);
    check('إلغاء المبادر عبر العقد = 200 cancelled (K5)',
        cancel.status === 200 && cancel.data && cancel.data.status === 'cancelled');
    const adminSees = await api('GET', '/api/schedule/shift-swaps?status=cancelled', null, admin);
    check('شاشة المسؤول تعرض الملغي ضمن فلتر cancelled (نفس عقد الواجهة)',
        adminSees.status === 200 && (adminSees.data.requests || []).some(r => Number(r.id) === Number(submit2.data.id)));

    // سلبيات العقد من زاوية الواجهة
    const badSelf = await api('POST', '/api/my/shift-swaps',
        { target_employee_id: EMP1, my_shift_date: D1, target_shift_date: D1 }, demo1);
    check('تبديل مع النفس = 422 SWAP_SELF (الخادم حارس الواجهة)',
        badSelf.status === 422 && badSelf.data && badSelf.data.code === 'SWAP_SELF');
    const badDate = await api('POST', '/api/my/shift-swaps',
        { target_employee_id: EMP2, my_shift_date: D1, target_shift_date: riyadhOffset(30) }, demo1);
    check('تاريخ زميل بلا مناوبة = 404 SWAP_ROSTER_NOT_FOUND (تلميح الواجهة صادق — التحقق خادمي)',
        badDate.status === 404 && badDate.data && badDate.data.code === 'SWAP_ROSTER_NOT_FOUND');

    // ═══ الخلاصة ═══
    await stopServer();
    console.log('\n═══════════════════════════════════');
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failed > 0) {
        console.log('الفاشلة:');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('✅ E-7 UI TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
