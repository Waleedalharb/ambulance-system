// A-4.4 S1: اختبار واجهة «إجازاتي» في بوابة الموظف — بيئة معزولة بالكامل (نسخة VACUUM مؤقتة).
// يغطي: (أ) sections.leave من my-portal-service · (ب) نداءات الواجهة الحية حرفيًا
// (GET/POST/PUT/DELETE /api/leave-requests + events) بنطاق الموظف · (ج) فحوص
// ستاتيكية: بطاقة إجازاتي وأنماطها و?v=7 · (د) فحوص سلبية: لا employee_id يُدخَل
// أو يُختار من الواجهة، ولا استخدام لمسار conflicts المحجوز للمراجع · (هـ) SSE
// حي: إشعار التقديم للمخوَّل وإشعار الاعتماد للمالك (A-1) الذي يحدّث البطاقة لحظيًا.
// لا يلمس data/ الحقيقية إطلاقًا. نفس هارنس leave-backend-test (إصلاحا Content-Length والمستمع).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3098;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-a44s1-'));
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
    console.log('═══ A-4.4 S1 LEAVE UI SMOKE — بيئة معزولة ═══');

    // ═══ 1) فحوص ستاتيكية على ملفات الواجهة (بلا خادم) ═══
    console.log('\n── فحوص ستاتيكية: الواجهة ──');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my-ems.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'my-ems.html'), 'utf8');
    const svc = fs.readFileSync(path.join(ROOT, 'services', 'my-portal-service.js'), 'utf8');

    check('my-ems.html: نسخة الكاش مرفوعة (?v=7)', html.includes('js/my-ems.js?v=7'));
    check('my-ems.html: أنماط بطاقة الإجازات (.lv-form/.lv-status/.card-head.leave)',
        html.includes('.lv-form') && html.includes('.lv-status') && html.includes('.card-head.leave'));
    check('my-ems.js: بطاقة «إجازاتي» + renderLeave/bindLeaveEvents/refreshLeave',
        js.includes('إجازاتي') && js.includes('function renderLeave') && js.includes('function bindLeaveEvents') && js.includes('function refreshLeave'));
    check('سلبي: لا input/select باسم أو معرّف employee_id في الواجهة إطلاقًا',
        !/name=["']employee_id["']/.test(js) && !/id=["']employee_id["']/.test(js) &&
        !/name=["']employee_id["']/.test(html) && !/id=["']employee_id["']/.test(html));
    check('سلبي: الواجهة لا تستدعي /api/leave-requests/conflicts (محجوز لـ leave.review — ذِكره في التعليقات توثيق فقط)',
        !/api\(\s*['"]\/api\/leave-requests\/conflicts/.test(js) && !/fetch\(\s*['"]\/api\/leave-requests\/conflicts/.test(js));
    check('my-ems.js: employee_id يُرسل من profile الحساب فقط (leaveProfile.employee.id)',
        js.includes('employee_id: leaveProfile.employee.id'));
    check('my-portal-service.js: قسم leave مضاف إلى خريطة الأقسام', /leave:\s*true/.test(svc));
    check('my-ems.js: حارس SSE يقرأ العنوان/النص من data.notification (عقد A-1 الحقيقي)', js.includes('data.notification'));

    // ═══ 2) التهيئة المعزولة + إقلاع الخادم ═══
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    const hash = bcrypt.hashSync('test123', 10);
    users.forEach(u => { if (u.username === 'DEMO101' || u.username === 'DEMO102') u.password = hash; });
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users, null, 2));

    // منح فردي لـ ops.my_portal داخل النسخة المؤقتة فقط — الصلاحية «منح فردي
    // حصرًا» (config/permissions.js) ومخزنها user_permissions في SQLite، ولا
    // يحملها أحد في قاعدة التطوير. الإنتاج يمنحها من لوحة الصلاحيات؛ هنا نحاكي
    // ذلك على نسخة الاختبار (مثل بذر كلمة المرور — لا يمس data/ الحقيقية).
    const Database2 = require('better-sqlite3');
    {
        const tmp = new Database2(TMP_DB);
        const demo1Id = users.find(u => u.username === 'DEMO101').id;
        const demo2Id = users.find(u => u.username === 'DEMO102').id;
        tmp.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by, created_at) VALUES (?, 'ops.my_portal', 1, 'a44s1-test', datetime('now'))")
            .run(demo1Id);
        tmp.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by, created_at) VALUES (?, 'ops.my_portal', 1, 'a44s1-test', datetime('now'))")
            .run(demo2Id);
        tmp.close();
    }

    await startServer();
    console.log('\n— الخادم يعمل على :' + PORT + ' —');
    const admin = await login('4252', '4252');
    const demo1 = await login('DEMO101', 'test123');
    const EMP1 = dbAll("SELECT id FROM employees WHERE employee_code = 'DEMO101'")[0].id;

    // ═══ 3) خريطة الأقسام + profile (نداءات load() نفسها) ═══
    console.log('\n── خريطة الأقسام + profile ──');
    const sections = await api('GET', '/api/my/sections', null, demo1);
    check('/api/my/sections: قسم leave ظاهر للموظف المربوط', sections.ok && sections.data.sections && sections.data.sections.leave === true);
    const profile = await api('GET', '/api/my/profile', null, demo1);
    check('/api/my/profile: employee.id متاح (مصدر employee_id الوحيد للواجهة)',
        profile.ok && profile.data.employee && Number(profile.data.employee.id) === EMP1);

    // ═══ 4) التدفق الحي بنفس نداءات الواجهة + SSE (A-1) ═══
    console.log('\n── التدفق الحي: تقديم ← إشعار المخوَّل ──');
    const adminSSE = listenSSE(admin);
    await new Promise(r => setTimeout(r, 800));
    const adminNotifP = adminSSE.waitFor(m => m.type === 'notification_created' && m.notification && /إجاز/.test((m.notification.title || '') + ' ' + (m.notification.message || '')), 7000);
    const D1 = plusDays(10), D1E = plusDays(12);
    const s1 = await api('POST', '/api/leave-requests',
        { employee_id: Number(profile.data.employee.id), start_date: D1, end_date: D1E, type: 'إجازة', reason: 'اختبار واجهة' }, demo1);
    check('POST من الموظف بـ employee_id من profile: 200 + id + warnings[]', s1.ok && s1.data.success && s1.data.id && Array.isArray(s1.data.warnings), JSON.stringify(s1.data));
    const adminSse = await adminNotifP;
    check('SSE: «طلب إجازة جديد» يصل المخوَّل لحظيًا (يحدّث شاشته بلا Refresh)', !!adminSse, 'لم يصل خلال 7 ثوانٍ');
    adminSSE.close();

    const mine = await api('GET', '/api/leave-requests', null, demo1);
    check('GET: الموظف يرى طلباته فقط (نطاق Server-side — M3)',
        mine.ok && mine.data.requests.length > 0 && mine.data.requests.every(r => r.employee_id === EMP1));
    check('GET: الطلب الجديد ظاهر بحالة pending', mine.data.requests.some(r => r.id === s1.data.id && r.status === 'pending'));

    // تعديل المالك — نفس نداء زر «تعديل» في الواجهة
    const edit = await api('PUT', '/api/leave-requests/' + s1.data.id,
        { start_date: plusDays(11), end_date: plusDays(13), type: 'مرضية', reason: 'معدَّل من الواجهة' }, demo1);
    check('PUT المالك (pending، قبل البداية) ينجح — نداء الواجهة نفسه', edit.ok && edit.data.success === true);

    // سجل الأحداث — نفس نداء زر «السجل»
    const ev = await api('GET', '/api/leave-requests/' + s1.data.id + '/events', null, demo1);
    check('GET /:id/events: سجل المالك يرجع أحداثًا (تقديم + تعديل)',
        ev.ok && ev.data.events.length === 2 && ev.data.events[0].from_status === null && ev.data.events[1].to_status === 'pending');

    // إلغاء المالك — نفس نداء زر «إلغاء الطلب» (بلا جسم)
    const cancel = await api('DELETE', '/api/leave-requests/' + s1.data.id, null, demo1);
    check('DELETE المالك لطلبه pending ينجح — نداء الواجهة نفسه', cancel.ok);
    const afterCancel = await api('GET', '/api/leave-requests', null, demo1);
    check('بعد الإلغاء: الطلب يظهر cancelled ولا يُحذف فيزيائيًا (M1)',
        afterCancel.ok && afterCancel.data.requests.some(r => r.id === s1.data.id && r.status === 'cancelled'));

    // اعتماد مخوَّل ← إشعار شخصي للمالك لحظيًا (الذي يستدعي refreshLeave في الواجهة)
    console.log('\n── اعتماد المخوَّل ← إشعار المالك اللحظي ──');
    const demoSSE = listenSSE(demo1);
    await new Promise(r => setTimeout(r, 800));
    const ownerNotifP = demoSSE.waitFor(m => m.type === 'notification_created' && m.notification && /إجاز/.test((m.notification.title || '') + ' ' + (m.notification.message || '')), 7000);
    const s2 = await api('POST', '/api/leave-requests',
        { employee_id: EMP1, start_date: plusDays(20), end_date: plusDays(21), type: 'استثنائية' }, demo1);
    check('تقديم ثانٍ للاختبار الإشعاري نجح', s2.ok);
    const ap = await api('POST', '/api/leave-requests/' + s2.data.id + '/approve', { status: 'approved' }, admin);
    check('اعتماد المخوَّل نجح', ap.ok);
    const ownerSse = await ownerNotifP;
    check('SSE: إشعار الاعتماد يصل المالك لحظيًا ← تحديث «إجازاتي» بلا Refresh', !!ownerSse, 'لم يصل خلال 7 ثوانٍ');
    const mine2 = await api('GET', '/api/leave-requests', null, demo1);
    check('بعد الاعتماد: الحالة الجديدة approved تظهر في جلب الموظف', mine2.data.requests.some(r => r.id === s2.data.id && r.status === 'approved'));
    demoSSE.close();

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
    console.log('✅ LEAVE UI SMOKE: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch(async (e) => {
    console.error('FATAL:', e);
    await stopServer();
    process.exit(1);
});
