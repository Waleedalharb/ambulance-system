/**
 * ═══ اختبار البث اللحظي للإشعارات التشغيلية (A-1) — اعتماد المالك 2026-10-03 ═══
 *
 * الجزء A — وحدوي (قاعدة مؤقتة + broadcastToUsers مزيّف):
 *   1) notifyOperational يبث notification_created لكل admin/director نشط أُنشئ
 *      له صف فعلًا — بمعرّف صفّه هو، وبلا وصول لغير المستهدفين.
 *   2) التكرار داخل نافذة 5 دقائق = touch بلا صف جديد **وبلا بث ثانٍ**
 *      (نفس سياسة Push — لا إزعاج للشاشة).
 *   3) غياب broadcastToUsers = بلا بث وبلا رمي (وضع الاختبارات/التدهور الآمن).
 *   4) Push لا يتأثر: يُستدعى لنفس المستهدفين كما كان.
 *
 * الجزء B — مساريّ (سيرفر معزول: VACUUM INTO + DATA_DIR مؤقت + بورت 3137):
 *   5) مسؤول متصل عبر SSE + موظف يقدّم طلب إجازة ← حدث notification_created
 *      يصل المسؤول لحظيًا بلا Refresh، ويحمل العنوان والتصنيف الصحيحين.
 *   6) مستخدم غير مستهدف متصل عبر SSE ← لا يصله الحدث.
 *   7) الصف موجود في القاعدة (GET /api/notifications) — البث فوق التخزين لا بدله.
 *   8) التقديم المكرر فورًا ← لا حدث SSE ثانٍ (منع التكرار).
 *   9) حدث تشغيلي آخر (بلاغ جديد report-entry) ← يصل لحظيًا بنفس القناة.
 *
 * التشغيل: node scripts/notification-live-broadcast-test.js
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
const TMP_DB = path.join(os.tmpdir(), 'nlb-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'nlb-data-' + STAMP).replace(/\\/g, '/');
const TMP_DIR_B = path.join(os.tmpdir(), 'nlb-unit-' + STAMP).replace(/\\/g, '/');
const PORT = 3137;
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
const MAIN_MODULES = path.join('C:\\', 'projects', 'Ambulance Dispatch', 'node_modules');
function resolveModule(name) {
    const local = path.join(ROOT, 'node_modules', name);
    return fs.existsSync(local) ? local : path.join(MAIN_MODULES, name);
}

let EMP = null;
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
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'))
        .filter(u => !['NLBADMIN', 'NLBUSER', EMP.employee_code].includes(u.username));
    users.push({ id: 'nlb-admin-1', username: 'NLBADMIN', name: 'مسؤول اختبار البث', password: hash, role: 'admin', isActive: true });
    users.push({ id: 'nlb-emp-1', username: EMP.employee_code, name: EMP.name, password: hash, role: 'user', isActive: true });
    users.push({ id: 'nlb-user-1', username: 'NLBUSER', name: 'مستخدم غير مستهدف', password: hash, role: 'user', isActive: true });
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
}
function boot() {
    const nodePath = path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES;
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', NODE_PATH: nodePath };
    delete env.APNS_KEY; delete env.APNS_KEY_BASE64; delete env.APNS_KEY_ID; delete env.APNS_TEAM_ID;
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

/** قارئ SSE بسيط: يجمع أحداث data: المحلَّلة، ويُغلق يدويًا. */
function connectSSE(token) {
    const events = [];
    const ac = new AbortController();
    const ready = (async () => {
        const r = await fetch(BASE + '/api/sse', { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal });
        if (!r.ok || !r.body) throw new Error('SSE connect failed: ' + r.status);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const p of parts) {
                const line = p.split('\n').find(l => l.startsWith('data: '));
                if (!line) continue;
                try { events.push(JSON.parse(line.slice(6))); } catch (_) { }
            }
        }
    })().catch(e => { if (!ac.signal.aborted) console.error('[sse]', e.message); });
    return { events, close: () => { ac.abort(); }, ready };
}
async function waitEvent(events, pred, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const hit = events.find(pred);
        if (hit) return hit;
        await sleep(150);
    }
    return null;
}

// ═══ الجزء A: وحدوي — بث موجَّه فوق الإنشاء الفعلي ═══
async function partA() {
    console.log('═══ A) notifyOperational: بث موجَّه لمن أُنشئ له صف ═══');
    fs.mkdirSync(TMP_DIR_B, { recursive: true });
    process.env.DATA_DIR = TMP_DIR_B;
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

    const broadcasts = [];
    const stubBroadcast = (ids, payload) => { broadcasts.push({ ids: ids.slice(), payload }); };
    const pushCalls = [];
    const stubGateway = { sendToUsers: async (ids, payload) => { pushCalls.push({ ids: ids.slice(), payload }); return { sent: ids.length }; } };
    notificationService.init({ usersPath: usersPathB, getDb: () => db, broadcastToUsers: stubBroadcast, pushGateway: stubGateway });

    const msg = 'موظف اختبار: إجازة سنوية من 2027-05-01 إلى 2027-05-03';
    const r1 = await notificationService.notifyOperational({ eventKey: 'leave.submitted', title: 'طلب إجازة جديد', message: msg, push: true });
    check('A1) صفان للمستهدفَين النشطَين', r1.created === 2, JSON.stringify(r1));
    const targetIds = broadcasts.map(b => b.ids[0]).sort();
    check('A2) بث لكل مستهدف أُنشئ له صف — رسالة لكلٍّ على حدة', broadcasts.length === 2 && targetIds.join(',') === 'b-admin-1,b-dir-1', JSON.stringify(broadcasts.map(b => b.ids)));
    check('A3) عقد الحدث: notification_created + العنوان + التصنيف', broadcasts.every(b => b.payload.type === 'notification_created' && b.payload.notification && b.payload.notification.title === 'طلب إجازة جديد' && b.payload.notification.type === 'warning'), JSON.stringify(broadcasts[0] && broadcasts[0].payload));
    check('A4) كل بث يحمل معرّف صف مستهدفه الحقيقي', await (async () => {
        for (const b of broadcasts) {
            const nid = b.payload.notification.id;
            const row = await db.Notifications.getById ? await db.Notifications.getById(nid) : null;
            if (!row || String(row.user_id) !== b.ids[0]) return false;
            if (String(b.payload.notification.user_id) !== b.ids[0]) return false;
        }
        return true;
    })());
    check('A5) لا بث لغير المستهدفين (b-user-1 وغير النشط)', !broadcasts.some(b => b.ids.includes('b-user-1') || b.ids.includes('b-admin-2')));
    check('A6) Push لم يتأثر: استُدعي مرة واحدة لنفس المستهدفين', pushCalls.length === 1 && pushCalls[0].ids.sort().join(',') === 'b-admin-1,b-dir-1');

    const r2 = await notificationService.notifyOperational({ eventKey: 'leave.submitted', title: 'طلب إجازة جديد', message: msg, push: true });
    check('A7) التكرار داخل النافذة: touch بلا صف جديد', r2.created === 0 && r2.deduped === 2, JSON.stringify(r2));
    check('A8) التكرار بلا بث ثانٍ وبلا Push ثانٍ', broadcasts.length === 2 && pushCalls.length === 1, 'broadcasts=' + broadcasts.length + ' push=' + pushCalls.length);

    // التدهور الآمن: بلا broadcastToUsers لا بث ولا رمي
    notificationService.init({ usersPath: usersPathB, getDb: () => db, broadcastToUsers: null, pushGateway: null });
    let threw = false;
    try { await notificationService.notifyOperational({ eventKey: 'report.entry_added', title: 'بلاغ جديد', message: 'اختبار بلا بث ' + STAMP }); }
    catch (_) { threw = true; }
    check('A9) غياب broadcastToUsers = بلا رمي (وضع آمن)', !threw);

    await db.closeDb().catch(() => { });
}

// ═══ الجزء B: مساريّ — SSE حي عبر سيرفر معزول ═══
async function partB() {
    console.log('═══ B) وصول لحظي عبر SSE الحقيقي ═══');
    makeIsolated();
    const server = boot();
    try {
        if (!await waitReady(BASE)) throw new Error('السيرفر لم يقلع');
        const adminTok = await login('NLBADMIN');
        const empTok = await login(EMP.employee_code);
        const otherTok = await login('NLBUSER');

        const adminChan = connectSSE(adminTok);
        const otherChan = connectSSE(otherTok);
        await waitEvent(adminChan.events, e => e.type === 'connected');
        await waitEvent(otherChan.events, e => e.type === 'connected');
        check('B0) قناتا SSE متصلتان (مسؤول + غير مستهدف)', adminChan.events.some(e => e.type === 'connected') && otherChan.events.some(e => e.type === 'connected'));

        // 5) طلب إجازة ← حدث لحظي للمسؤول
        const createR = await fetch(BASE + '/api/leave-requests', { method: 'POST', headers: auth(empTok), body: JSON.stringify({ employee_id: EMP.id, start_date: '2027-05-01', end_date: '2027-05-03', type: 'إجازة', reason: 'اختبار بث' }) });
        const createD = await createR.json();
        check('B1) تقديم الطلب ينجح', createR.ok && createD.success && createD.id, JSON.stringify(createD).slice(0, 160));
        const hit = await waitEvent(adminChan.events, e => e.type === 'notification_created' && e.notification && e.notification.title === 'طلب إجازة جديد');
        check('B2) notification_created يصل المسؤول لحظيًا بلا Refresh', !!hit, JSON.stringify(adminChan.events.map(e => e.type)));
        check('B3) الحمولة تحمل رسالة الموظف والتصنيف warning', !!hit && (hit.notification.message || '').includes(EMP.name) && hit.notification.type === 'warning');

        // 6) غير المستهدف لا يصله
        await sleep(800);
        check('B4) المستخدم غير المستهدف لا يصله الحدث', !otherChan.events.some(e => e.type === 'notification_created' && e.notification && e.notification.title === 'طلب إجازة جديد'));

        // 7) الصف محفوظ في القاعدة
        const notifR = await fetch(BASE + '/api/notifications', { headers: auth(adminTok) });
        const notifD = await notifR.json();
        check('B5) الإشعار محفوظ في القاعدة (يظهر عند فتح الصفحة أيضًا)', (notifD.notifications || []).some(n => n.title === 'طلب إجازة جديد' && (n.message || '').includes(EMP.name)));

        // 8) التكرار بلا حدث ثانٍ
        const countBefore = adminChan.events.filter(e => e.type === 'notification_created' && e.notification && e.notification.title === 'طلب إجازة جديد').length;
        await fetch(BASE + '/api/leave-requests', { method: 'POST', headers: auth(empTok), body: JSON.stringify({ employee_id: EMP.id, start_date: '2027-05-01', end_date: '2027-05-03', type: 'إجازة', reason: 'اختبار بث' }) });
        await sleep(1200);
        const countAfter = adminChan.events.filter(e => e.type === 'notification_created' && e.notification && e.notification.title === 'طلب إجازة جديد').length;
        check('B6) التقديم المكرر: بلا حدث ثانٍ (لا تكرار)', countBefore === 1 && countAfter === 1, 'before=' + countBefore + ' after=' + countAfter);

        // 9) حدث تشغيلي آخر عبر نفس القناة — بلاغ جديد (report-entry)
        const repR = await fetch(BASE + '/api/report-entry', { method: 'POST', headers: auth(adminTok), body: JSON.stringify({ center: 'المنصورة', team: 'جنوب 1', type: 'حالة مرضية', priority: 'عادية' }) });
        const repOk = repR.ok;
        if (repOk) {
            const repHit = await waitEvent(adminChan.events, e => e.type === 'notification_created' && e.notification && e.notification.title === 'بلاغ جديد');
            check('B7) حدث تشغيلي آخر (بلاغ جديد) يصل لحظيًا', !!repHit, JSON.stringify(adminChan.events.map(e => e.type)));
        } else {
            check('B7) حدث تشغيلي آخر (بلاغ جديد) يصل لحظيًا', false, 'report-entry status=' + repR.status);
        }

        adminChan.close(); otherChan.close();
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
