/**
 * ═══ اختبار E2E حقيقي عبر HTTP — تدشين نظام «التمركز» (2026-09-28) ═══
 * يثبت السلسلة كاملة على خادم الفرع الفعلي (server.js مُشغَّل فعليًا):
 *
 *   POST /api/peak-plans (نفس endpoint الذي تستدعيه savePeakPlan في الواجهة)
 *     → PositioningService.create → حلّ أعضاء «جنوب 2» من shift_roster اليوم
 *     → notification بـ task_key=positioning:<id> + data_json مهيكلة
 *     → GET /api/my/notifications للمسعف ← يظهر العنصر المهيكل
 *     → PUT تحديث المركز ← الصف نفسه يتحدث (لا صف جديد) ويعود غير مقروء
 *     → POST read?source=personal ← ختم القراءة
 *     → Refresh متكرر ← لا صفوف جديدة (Idempotency)
 *     → تمركز لفرقة أخرى ← مسعف جنوب 2 لا يستلم شيئًا
 *
 * العزل: DATA_DIR/DB_PATH/PORT مؤقتة + قاعدة طازجة تهيّئها server.js نفسها +
 * بذر roster حقيقي البنية (teams/shift_codes/shift_roster/users.json).
 *
 * التشغيل: node scripts/positioning-e2e-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const STAMP = Date.now();
const TMP_DIR = path.join(os.tmpdir(), 'positioning-e2e-' + STAMP).replace(/\\/g, '/');
const TMP_DB = path.join(TMP_DIR, 'ambulance.db').replace(/\\/g, '/');
const PORT = 3124;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 90) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
function riyadhTodayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function api(token, method, p, body) {
    const r = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let j = null; try { j = await r.json(); } catch (_) { }
    return { status: r.status, json: j };
}

let server = null;
(async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
    const hash = bcrypt.hashSync('test1234', 10);
    // الحسابات: مشغّل عمليات (ينشئ التمركز) + مسعف على جنوب 2 + مسعف على فرقة أخرى
    fs.writeFileSync(path.join(TMP_DIR, 'users.json'), JSON.stringify([
        { id: 'e2e-ops', username: 'e2eops', name: 'مشغل الاختبار', password: hash, role: 'admin', isActive: true },
        { id: 'e2e-T901', username: 'T901', name: 'مسعف جنوب 2', password: hash, role: 'user', isActive: true },
        { id: 'e2e-T902', username: 'T902', name: 'مسعف شمال 1', password: hash, role: 'user', isActive: true }
    ], null, 2));

    console.log('🧪 خادم الفرع الفعلي على ' + PORT + ' — E2E تمركز جنوب 2 | اليوم: ' + riyadhTodayStr());
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverErr = '';
    server.stderr.on('data', d => { serverErr += String(d); });

    if (!(await waitReady())) {
        check('0) إقلاع الخادم', false, serverErr.slice(-400));
        throw new Error('server did not start');
    }
    check('0) خادم الفرع أقلع وأجاب /health', true);

    // ── بذر roster حقيقي البنية بعد أن أنشأ الخادم المخطط ──
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const today = riyadhTodayStr();
    const [yy, mm] = today.split('-').map(Number);
    dbw.prepare("INSERT OR IGNORE INTO teams (name, center) VALUES ('جنوب 2', 'الخالدية'), ('شمال 1', 'العليا')").run();
    const teamS = dbw.prepare("SELECT id FROM teams WHERE name = 'جنوب 2'").get().id;
    const teamN = dbw.prepare("SELECT id FROM teams WHERE name = 'شمال 1'").get().id;
    dbw.prepare("INSERT OR IGNORE INTO shift_codes (code, name, status) VALUES ('D12', 'يومي 12', 'دوام')").run();
    dbw.prepare("UPDATE shift_codes SET status = 'دوام' WHERE code = 'D12'").run();
    const empS = dbw.prepare("INSERT INTO employees (employee_code, name, is_active) VALUES ('T901', 'مسعف جنوب 2', 1)").run().lastInsertRowid;
    const empN = dbw.prepare("INSERT INTO employees (employee_code, name, is_active) VALUES ('T902', 'مسعف شمال 1', 1)").run().lastInsertRowid;
    dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?,?,?,?,?,?)')
        .run(empS, teamS, today, 'D12', mm, yy);
    dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?,?,?,?,?,?)')
        .run(empN, teamN, today, 'D12', mm, yy);
    dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('e2e-ops','ops.deployments',1,'e2e')").run();
    dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('e2e-T901','ops.my_portal',1,'e2e')").run();
    dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('e2e-T902','ops.my_portal',1,'e2e')").run();

    // ── 1) دخول ──
    const opsLogin = await api(null, 'POST', '/api/auth/login', { username: 'e2eops', password: 'test1234' });
    const medLogin = await api(null, 'POST', '/api/auth/login', { username: 'T901', password: 'test1234' });
    check('1) دخول المشغّل والمسعف', !!(opsLogin.json && opsLogin.json.accessToken && medLogin.json && medLogin.json.accessToken),
        JSON.stringify({ ops: opsLogin.status, med: medLogin.status }));
    const opsTok = opsLogin.json.accessToken, medTok = medLogin.json.accessToken;

    // ── 2) إنشاء تمركز لجنوب 2 عبر نفس endpoint الواجهة ──
    const payload = {
        title: 'مركز الخالدية', planType: 'positioning', location: 'حي الخالدية - تقاطع الملك فهد',
        unit: 'جنوب 2', teamType: 'advanced', startTime: today + 'T05:00', endTime: today + 'T17:00',
        priority: 'high', notes: '', lat: '24.71', lng: '46.68', status: 'active'
    };
    const created = await api(opsTok, 'POST', '/api/peak-plans', payload);
    const planId = created.json && created.json.plan && created.json.plan.id;
    check('2) POST /api/peak-plans نجح وأعاد الخطة', created.status === 200 && !!planId, JSON.stringify(created.json).slice(0, 200));

    // ── 3) إثبات السجل في قاعدة البيانات مباشرة ──
    await sleep(300); // الإشعار لاحق للكتابة داخل نفس الاستدعاء — احتياط زمني بسيط
    const rowsS = dbw.prepare("SELECT * FROM notifications WHERE user_id = 'e2e-T901'").all();
    check('3أ) سجل notification واحد لمسعف جنوب 2', rowsS.length === 1, String(rowsS.length));
    const n0 = rowsS[0] || {};
    check('3ب) task_key = positioning:<planId>', n0.task_key === 'positioning:' + planId, n0.task_key);
    let d0 = null; try { d0 = JSON.parse(n0.data_json || 'null'); } catch (_) { }
    check('3ج) data_json صحيحة (team/center/start/end/priority/positioning_task_id)',
        !!(d0 && d0.type === 'positioning' && d0.team === 'جنوب 2' && d0.center === 'مركز الخالدية'
            && d0.start_time && d0.end_time && d0.priority === 'high' && d0.positioning_task_id === String(planId)),
        JSON.stringify(d0));
    check('3د) غير مقروء عند الإنشاء (is_read=0)', n0.is_read === 0);
    check('3هـ) مسعف الفرقة الأخرى: صفر إشعارات', dbw.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 'e2e-T902'").get().c === 0);
    check('3و) المشغّل ليس مستلمًا لمهمة التمركز (لا task_key له — إشعاره التشغيلي الإداري القائم سلوك معتمد)',
        dbw.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 'e2e-ops' AND task_key IS NOT NULL").get().c === 0);

    // ── 4) الظهور في /api/my/notifications ──
    const list1 = await api(medTok, 'GET', '/api/my/notifications');
    const item = list1.json && (list1.json.notifications || []).find(n => n.source === 'personal' && n.type === 'positioning');
    check('4أ) العنصر المهيكل يظهر في API المسعف', !!item, JSON.stringify(list1.json).slice(0, 250));
    check('4ب) الحقول المهيكلة في الاستجابة (center/team/start_time/end_time/taskKey)',
        !!(item && item.data && item.data.center === 'مركز الخالدية' && item.data.team === 'جنوب 2'
            && item.data.start_time && item.data.end_time && item.taskKey === 'positioning:' + planId));
    check('4ج) العنوان «مهمة تمركز جديدة» والرسالة تحمل التوجيه',
        !!(item && item.title === 'مهمة تمركز جديدة' && /تم توجيهك للتمركز في مركز الخالدية/.test(item.message || '')));
    check('4د) unreadCount يشمل إشعار التمركز', (list1.json.unreadCount || 0) >= 1, String(list1.json.unreadCount));

    // ── 5) ختم القراءة ──
    const rd = await api(medTok, 'POST', '/api/my/notifications/' + item.id + '/read?source=personal');
    check('5أ) ختم القراءة personal ناجح', rd.status === 200 && rd.json && rd.json.status === 'read', JSON.stringify(rd.json));
    check('5ب) الصف مقروء فعلًا في القاعدة', dbw.prepare('SELECT is_read FROM notifications WHERE id = ?').get(item.id).is_read === 1);

    // ── 6) تعديل التمركز ← تحديث الصف نفسه لا إنشاء صف ──
    const upd = await api(opsTok, 'PUT', '/api/peak-plans/' + encodeURIComponent(planId), { title: 'مركز العليا', location: 'حي العليا' });
    check('6أ) PUT التعديل نجح', upd.status === 200, String(upd.status));
    await sleep(300);
    const rowsAfterUpd = dbw.prepare("SELECT * FROM notifications WHERE user_id = 'e2e-T901'").all();
    check('6ب) ما زال صفًا واحدًا لنفس positioning_task_id', rowsAfterUpd.length === 1, String(rowsAfterUpd.length));
    const n1 = rowsAfterUpd[0] || {};
    const d1 = JSON.parse(n1.data_json || '{}');
    check('6ج) المحتوى تحدّث (مركز العليا + kind=updated) وعاد غير مقروء',
        d1.center === 'مركز العليا' && d1.kind === 'updated' && n1.is_read === 0 && /تحديث/.test(n1.title || ''));

    // ── 7) Idempotency تحت القراءة المتكررة (Refresh/فتح التطبيق) ──
    await api(medTok, 'GET', '/api/my/notifications');
    await api(medTok, 'GET', '/api/my/notifications');
    await api(medTok, 'GET', '/api/my/notifications');
    check('7) ثلاث قراءات متتالية: لا صفوف جديدة', dbw.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 'e2e-T901'").get().c === 1);

    // ── 8) تمركز لفرقة أخرى ← مسعف جنوب 2 لا يستلم ──
    await sleep(10);
    await api(opsTok, 'POST', '/api/peak-plans', { ...payload, title: 'مركز العليا', unit: 'شمال 1' });
    await sleep(300);
    check('8أ) تمركز شمال 1: مسعف جنوب 2 بلا صفوف جديدة', dbw.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 'e2e-T901'").get().c === 1);
    check('8ب) تمركز شمال 1 وصل لمناوبها فعلًا', dbw.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 'e2e-T902'").get().c === 1);

    dbw.close();
    console.log('\n═══ النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل ═══');
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    if (server) server.kill();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('❌ فشل عام:', err.message || err);
    if (server) server.kill();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    process.exit(1);
});
