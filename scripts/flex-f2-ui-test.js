// F-2 (الجدول المرن): اختبار واجهات طلبات تغيير المناوبة — بيئة معزولة بالكامل.
// يغطي: (أ) فحوص ستاتيكية — وجود صفحة المشرف وبوابتها Fail-Closed، رابط الشريط
// الجانبي وشرط إظهاره، بطاقة الموظف في my-ems وحمولة تقديم بلا employee_id
// (د2 + قاعدة المالك)، EventSource واحد، سلبيات النطاق (لا vacations، لا إدخال
// employee_id، لا endpoint خارج العقد) · (ب) حيًا: تقديم الملفات الثابتة 200
// ومحتواها، والمسارات الجديدة بلا توكن = 401.
// لا يلمس data/ الحقيقية إطلاقًا (VACUUM مؤقت). نفس هارنس leave-admin-ui-test.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 3098;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-f2-ui-'));
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
            res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: buf }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
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

async function main() {
    console.log('═══ F-2 SHIFT-CHANGE UI TEST — بيئة معزولة ═══');

    // ═══ 1) فحوص ستاتيكية على ملفات الواجهة (بلا خادم) ═══
    console.log('\n── فحوص ستاتيكية: صفحة المشرف ──');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'shift-change-admin.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'shift-change-admin.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const myems = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my-ems.js'), 'utf8');

    check('shift-change-admin.html: موجودة + RTL + هوية المنصة',
        html.includes('dir="rtl"') && html.includes('/css/platform-identity.css'));
    check('shift-change-admin.html: تحمّل core-auth + shift-change-admin.js?v=1 (نسخة كاش مثبتة)',
        html.includes('js/core/core-auth.js') && html.includes('js/shift-change-admin.js?v=1'));
    check('index.html: زر «مراجعة طلبات المناوبة» + navigateToPage(shift-change-admin.html?v=1)',
        idx.includes('id="sbShiftChangeReview"') && idx.includes("navigateToPage('shift-change-admin.html?v=1')"));
    check('index.html: إظهار الزر مشروط بـ star || requests.review',
        idx.includes("show('sbShiftChangeReview', star || perms.indexOf('requests.review') !== -1);"));
    check('shift-change-admin.js: البوابة على /api/auth/me + requests.review + permissions_star',
        js.includes("'/api/auth/me'") && js.includes("'requests.review'") && js.includes('permissions_star'));
    check('shift-change-admin.js: Fail-Closed — بطاقة «غير مصرّح» ولا جلب قبل اجتياز البوابة',
        js.includes('غير مصرّح') && js.indexOf('checkAccess()') !== -1 &&
        /checkAccess\(\)\.then\(function \(ok\) \{\s*if \(!ok\) return;/.test(js));
    check('سلبي: لا input/select باسم أو معرّف employee_id في صفحة المشرف إطلاقًا',
        !/name=["']employee_id["']/.test(js) && !/id=["']employee_id["']/.test(js) &&
        !/name=["']employee_id["']/.test(html) && !/id=["']employee_id["']/.test(html));
    check('سلبي: لا vacations ولا /api/vacations في صفحة المشرف إطلاقًا',
        !/vacations/i.test(js) && !/vacations/i.test(html));
    check('shift-change-admin.js: نداءات العقد فقط (قائمة + review + /api/sse)',
        js.includes("'/api/shift-change-request'") && js.includes("/review'") && js.includes("'/api/sse?token='"));
    check('shift-change-admin.js: «الفعلية الآن» من current_shift_code الحي + تحذير الانحراف',
        js.includes('current_shift_code') && js.includes('تغيّرت منذ التقديم'));
    check('shift-change-admin.js: عرض أثر applied من استجابة الاعتماد (F-1)',
        js.includes('r.data.applied') && js.includes('change_type'));
    check('shift-change-admin.js: 409/فشل القرار ⇒ رسالة السيرفر + إعادة جلب (الأولوية لحالة السيرفر)',
        js.includes('الأولوية لحالة السيرفر'));
    check('shift-change-admin.js: EventSource واحد فقط (لا اتصالات مكررة)',
        (js.match(/new EventSource/g) || []).length === 1);

    console.log('\n── فحوص ستاتيكية: بطاقة الموظف (my-ems) ──');
    check('my-ems.js: بطاقة shiftChangeCard + قائمة «طلباتي» من /api/my/shift-change-requests',
        myems.includes('id="shiftChangeCard"') && myems.includes("'/api/my/shift-change-requests'"));
    check('my-ems.js: التقديم إلى /api/shift-change-request بالتاريخ والرمز والسبب فقط',
        myems.includes("apiPost('/api/shift-change-request'") &&
        myems.includes('{ shift_date: date, proposed_shift_code: code, reason: reason || undefined }'));
    const submitBlock = myems.slice(myems.indexOf("apiPost('/api/shift-change-request'"), myems.indexOf("apiPost('/api/shift-change-request'") + 400);
    check('my-ems.js: حمولة التقديم لا تحمل employee_id ولا old_shift_code (اشتقاق سيرفي — د2 + قاعدة المالك)',
        !submitBlock.includes('employee_id') && !submitBlock.includes('old_shift_code'));
    check('my-ems.js: «مناوبتك الحالية» عرض للاطلاع من /api/my/schedule فقط',
        myems.includes('/api/my/schedule?month=') && myems.includes('مناوبتك الحالية'));
    check('my-ems.js: إلغاء المالك عبر /api/my/shift-change-requests/:id/cancel (د1)',
        myems.includes("/cancel'") && myems.includes('data-sccancel'));
    check('my-ems.js: تحديث لحظي عند إشعار «مناوبة» (refreshShiftChange)',
        myems.includes('refreshShiftChange') && /مناوبة/.test(myems));

    // ═══ 2) التهيئة المعزولة + إقلاع الخادم ═══
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');

    // ═══ 3) حيًا: تقديم الملفات الثابتة وبوابة المصادقة ═══
    console.log('\n── حيًا: الملفات الثابتة والمصادقة ──');
    const page = await api('GET', '/shift-change-admin.html');
    check('GET /shift-change-admin.html = 200 + يحوي requests.review',
        page.status === 200 && page.text.includes('requests.review'));
    const jsLive = await api('GET', '/js/shift-change-admin.js');
    check('GET /js/shift-change-admin.js = 200 + يحوي البوابة',
        jsLive.status === 200 && jsLive.text.includes('checkAccess'));
    const home = await api('GET', '/');
    check('GET / = 200 + يحوي زر sbShiftChangeReview',
        home.status === 200 && home.text.includes('sbShiftChangeReview'));
    const myLive = await api('GET', '/js/my-ems.js');
    check('GET /js/my-ems.js = 200 + يحوي بطاقة shiftChangeCard',
        myLive.status === 200 && myLive.text.includes('shiftChangeCard'));
    const noTokList = await api('GET', '/api/my/shift-change-requests');
    check('GET /api/my/shift-change-requests بلا توكن = 401', noTokList.status === 401);
    const noTokCancel = await api('POST', '/api/my/shift-change-requests/1/cancel', {});
    check('POST /api/my/shift-change-requests/:id/cancel بلا توكن = 401', noTokCancel.status === 401);

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
    console.log('✅ F-2 SHIFT-CHANGE UI TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
