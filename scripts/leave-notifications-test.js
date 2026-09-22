/**
 * ═══ اختبار إشعارات الإجازات/تغيير المناوبة (Inbox + Push) — اعتماد المالك 2026-09-22 ═══
 *
 * الجزء A — وحدوي (قاعدة مؤقتة + بوابة Push مزيّفة):
 *   1) notifyOperational({push:true}) ينشئ صفًا لكل admin/director نشط فقط
 *      ويرسل Push لمن أُنشئ لهم صف حصرًا (kind=notification + badge:auto).
 *   2) التكرار داخل نافذة 5 دقائق = touch بلا صف جديد **وبلا Push ثانٍ**.
 *   3) تصنيف الحدثين الجديدين: leave.submitted / shift_change.submitted ← warning.
 *
 * الجزء B — مساريّ (سيرفر معزول: VACUUM INTO + DATA_DIR مؤقت + بورت 3135):
 *   4) تقديم طلب إجازة ← صف «طلب إجازة جديد» في Inbox المسؤول (يحمل اسم الموظف).
 *   5) التقديم المكرر فورًا ← صف واحد فقط لدى المسؤول (منع التكرار يعمل عبر المسار).
 *   6) القبول ← إشعار شخصي «تمت الموافقة على طلب الإجازة» لحساب الموظف المربوط
 *      (users.username = employees.employee_code).
 *   7) الرفض ← «تم رفض طلب الإجازة».
 *   8) طلب تغيير مناوبة ← صف «طلب تغيير مناوبة جديد» لدى المسؤول.
 *   9) مراجعته ← إشعار شخصي لصاحبه «تمت الموافقة على طلب تغيير المناوبة».
 *  10) الحراسة: بلا توكن 401. وكل المسارات نجحت بلا مفاتيح APNs (وضع معطَّل آمن —
 *      الطلب لا يُفقد حتى لو Push غير مفعّل).
 *
 * التشغيل: node scripts/leave-notifications-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const MAIN_REPO = path.join('C:\\', 'projects', 'Ambulance Dispatch');
const SRC_DATA = path.join(MAIN_REPO, 'data');
const SRC_DB = path.join(SRC_DATA, 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'lven-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'lven-data-' + STAMP).replace(/\\/g, '/');
const TMP_DIR_B = path.join(os.tmpdir(), 'lven-unit-' + STAMP).replace(/\\/g, '/');
const PORT = 3135;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(base, tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}

// الـworktree قد يفتقد better-sqlite3/bcryptjs — نحسم من المستودع الرئيسي عند الحاجة.
const MAIN_MODULES = path.join('C:\\', 'projects', 'Ambulance Dispatch', 'node_modules');
function resolveModule(name) {
    const local = path.join(ROOT, 'node_modules', name);
    return fs.existsSync(local) ? local : path.join(MAIN_MODULES, name);
}

let EMP = null; // موظف حقيقي من نسخة القاعدة — يُربط حسابه بـ employee_code

function makeIsolated() {
    const Database = require(resolveModule('better-sqlite3'));
    const bcrypt = require(resolveModule('bcryptjs'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    EMP = src.prepare("SELECT id, employee_code, name FROM employees WHERE is_active = 1 AND employee_code IS NOT NULL AND employee_code != '' LIMIT 1").get();
    src.close();
    if (!EMP) throw new Error('لا يوجد موظف نشط بـ employee_code في نسخة القاعدة');
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(SRC_DATA)) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(SRC_DATA, f), path.join(TMP_DIR, f)); } catch (_) { } }
    }
    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    // قد يوجد حساب حقيقي بنفس employee_code — نستبعده حتى يفوز حساب الاختبار
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'))
        .filter(u => u.username !== 'LNADMIN' && u.username !== EMP.employee_code);
    users.push({ id: 'ln-admin-1', username: 'LNADMIN', name: 'مسؤول اختبار الإشعارات', password: hash, role: 'admin', isActive: true });
    users.push({ id: 'ln-emp-1', username: EMP.employee_code, name: EMP.name, password: hash, role: 'user', isActive: true });
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
}

function boot() {
    const nodePath = path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES;
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', NODE_PATH: nodePath };
    delete env.APNS_KEY; delete env.APNS_KEY_BASE64; delete env.APNS_KEY_ID; delete env.APNS_TEAM_ID; // وضع معطَّل آمن
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    return server;
}

async function login(username) {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test1234' }) });
    const d = await r.json();
    const token = d.token || d.accessToken || (d.data && (d.data.token || d.data.accessToken));
    if (!r.ok || !token) throw new Error('فشل دخول ' + username + ': ' + JSON.stringify(d).slice(0, 200));
    return token;
}
const auth = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
async function notifTitles(token) {
    const r = await fetch(BASE + '/api/notifications', { headers: auth(token) });
    const d = await r.json();
    return (d.notifications || []).map(n => n.title + ' | ' + (n.message || ''));
}

// ═══ الجزء A: وحدوي — notifyOperational({push}) مع بوابة مزيّفة ═══
async function partA() {
    console.log('═══ A) notifyOperational: Inbox fan-out + Push انتقائي ═══');
    fs.mkdirSync(TMP_DIR_B, { recursive: true });
    process.env.DATA_DIR = TMP_DIR_B; // قبل require db.js — مصدر التخزين يُقرأ عند التحميل
    const db = require('../db.js');
    await db.init(true);
    const notificationService = require('../services/notification-service');

    const usersB = [
        { id: 'b-admin-1', username: 'BA1', role: 'admin', isActive: true },
        { id: 'b-admin-2', username: 'BA2', role: 'admin', isActive: false }, // غير نشط — يُستبعد
        { id: 'b-dir-1', username: 'BD1', role: 'director', isActive: true },
        { id: 'b-user-1', username: 'BU1', role: 'user', isActive: true }     // ليس مسؤولًا — يُستبعد
    ];
    const usersPathB = path.join(TMP_DIR_B, 'users.json');
    fs.writeFileSync(usersPathB, JSON.stringify(usersB));

    const pushCalls = [];
    const stubGateway = { sendToUsers: async (ids, payload) => { pushCalls.push({ ids: ids.slice(), payload }); return { sent: ids.length }; } };
    notificationService.init({ usersPath: usersPathB, getDb: () => db, broadcastToUsers: null, pushGateway: stubGateway });

    const msg = 'موظف اختبار: إجازة سنوية من 2027-02-01 إلى 2027-02-03';
    const r1 = await notificationService.notifyOperational({ eventKey: 'leave.submitted', title: 'طلب إجازة جديد', message: msg, push: true });
    check('A1) صف لكل admin/director نشط فقط (2 لا 4)', r1.created === 2, JSON.stringify(r1));
    check('A2) Push استُدعي مرة واحدة لمن أُنشئ لهم صف حصرًا', pushCalls.length === 1 && pushCalls[0].ids.sort().join(',') === 'b-admin-1,b-dir-1', JSON.stringify(pushCalls.map(c => c.ids)));
    check('A3) حمولة Push: kind=notification + badge:auto + الحدث', pushCalls.length === 1 && pushCalls[0].payload.badge === 'auto' && pushCalls[0].payload.data && pushCalls[0].payload.data.kind === 'notification' && pushCalls[0].payload.data.event === 'leave.submitted');
    check('A4) التصنيف warning', r1.type === 'warning');

    const r2 = await notificationService.notifyOperational({ eventKey: 'leave.submitted', title: 'طلب إجازة جديد', message: msg, push: true });
    check('A5) التكرار داخل النافذة = touch بلا صف جديد', r2.created === 0 && r2.deduped === 2, JSON.stringify(r2));
    check('A6) التكرار لا يُزعج الجهاز — بلا Push ثانٍ', pushCalls.length === 1, 'pushCalls=' + pushCalls.length);

    check('A7) shift_change.submitted ← warning', notificationService.classify('shift_change.submitted') === 'warning');
    check('A8) push غير مفعّل افتراضيًا: بلا البوابة لا تُستدعى', await (async () => {
        const before = pushCalls.length;
        await notificationService.notifyOperational({ eventKey: 'leave.submitted', title: 'طلب إجازة آخر', message: msg + ' — نسخة بلا push' });
        return pushCalls.length === before;
    })());

    await db.closeDb().catch(() => { });
}

// ═══ الجزء B: مساريّ — سيرفر معزول ═══
async function partB() {
    console.log('═══ B) مسارات الإجازات/تغيير المناوبة عبر سيرفر معزول ═══');
    makeIsolated();
    const server = boot();
    try {
        if (!await waitReady(BASE)) throw new Error('السيرفر لم يقلع');
        const adminTok = await login('LNADMIN');
        const empTok = await login(EMP.employee_code);

        // 10) الحراسة
        const noTok = await fetch(BASE + '/api/leave-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        check('B10) بلا توكن = 401', noTok.status === 401);

        // 4) تقديم طلب إجازة
        const createR = await fetch(BASE + '/api/leave-requests', { method: 'POST', headers: auth(empTok), body: JSON.stringify({ employee_id: EMP.id, start_date: '2027-02-01', end_date: '2027-02-03', type: 'إجازة', reason: 'اختبار إشعارات' }) });
        const createD = await createR.json();
        check('B4أ) تقديم الطلب ينجح (بلا مفاتيح APNs — الطلب لا يُفقد)', createR.ok && createD.success && createD.id, JSON.stringify(createD).slice(0, 200));
        const leaveId = createD.id;

        let adminTitles = await notifTitles(adminTok);
        check('B4ب) Inbox المسؤول: «طلب إجازة جديد» يحمل اسم الموظف', adminTitles.some(t => t.includes('طلب إجازة جديد') && t.includes(EMP.name)), adminTitles.slice(-3).join(' || '));

        // 5) التكرار الفوري عبر المسار
        await fetch(BASE + '/api/leave-requests', { method: 'POST', headers: auth(empTok), body: JSON.stringify({ employee_id: EMP.id, start_date: '2027-02-01', end_date: '2027-02-03', type: 'إجازة', reason: 'اختبار إشعارات' }) });
        adminTitles = await notifTitles(adminTok);
        const dupCount = adminTitles.filter(t => t.includes('طلب إجازة جديد') && t.includes(EMP.name) && t.includes('2027-02-01')).length;
        check('B5) التقديم المكرر = صف واحد فقط لدى المسؤول', dupCount === 1, 'rows=' + dupCount);

        // 6) القبول
        const apprR = await fetch(BASE + '/api/leave-requests/' + leaveId + '/approve', { method: 'POST', headers: auth(adminTok), body: JSON.stringify({ status: 'approved' }) });
        check('B6أ) القبول ينجح', apprR.ok);
        let empTitles = await notifTitles(empTok);
        check('B6ب) صاحب الطلب يستلم «تمت الموافقة على طلب الإجازة»', empTitles.some(t => t.includes('تمت الموافقة على طلب الإجازة') && t.includes('2027-02-01')), empTitles.slice(-3).join(' || '));

        // 7) الرفض (طلب ثانٍ بتواريخ مختلفة)
        const create2 = await fetch(BASE + '/api/leave-requests', { method: 'POST', headers: auth(empTok), body: JSON.stringify({ employee_id: EMP.id, start_date: '2027-03-10', end_date: '2027-03-11', type: 'مرضية' }) });
        const create2D = await create2.json();
        const denyR = await fetch(BASE + '/api/leave-requests/' + create2D.id + '/approve', { method: 'POST', headers: auth(adminTok), body: JSON.stringify({ status: 'denied' }) });
        check('B7أ) الرفض ينجح', denyR.ok);
        empTitles = await notifTitles(empTok);
        check('B7ب) صاحب الطلب يستلم «تم رفض طلب الإجازة»', empTitles.some(t => t.includes('تم رفض طلب الإجازة') && t.includes('2027-03-10')), empTitles.slice(-3).join(' || '));

        // 8) طلب تغيير مناوبة
        const scR = await fetch(BASE + '/api/shift-change-request', { method: 'POST', headers: auth(empTok), body: JSON.stringify({ employee_id: EMP.id, shift_date: '2027-02-05', proposed_shift_code: 'N', old_shift_code: 'M', reason: 'اختبار' }) });
        const scD = await scR.json();
        check('B8أ) تقديم طلب تغيير المناوبة ينجح', scR.ok && scD.success && scD.id, JSON.stringify(scD).slice(0, 200));
        adminTitles = await notifTitles(adminTok);
        check('B8ب) Inbox المسؤول: «طلب تغيير مناوبة جديد»', adminTitles.some(t => t.includes('طلب تغيير مناوبة جديد') && t.includes('2027-02-05')), adminTitles.slice(-3).join(' || '));

        // 9) مراجعة طلب التغيير
        const revR = await fetch(BASE + '/api/shift-change-request/' + scD.id + '/review', { method: 'POST', headers: auth(adminTok), body: JSON.stringify({ status: 'approved' }) });
        check('B9أ) المراجعة تنجح', revR.ok);
        empTitles = await notifTitles(empTok);
        check('B9ب) صاحب الطلب يستلم «تمت الموافقة على طلب تغيير المناوبة»', empTitles.some(t => t.includes('تمت الموافقة على طلب تغيير المناوبة') && t.includes('2027-02-05')), empTitles.slice(-3).join(' || '));
    } finally {
        server.kill();
    }
}

(async () => {
    try {
        await partA();
        await partB();
    } catch (e) {
        failed++; failures.push('fatal: ' + e.message);
        console.error('❌ فشل عام:', e.message);
    } finally {
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.rmSync(TMP_DIR_B, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    console.log('\n════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})();
