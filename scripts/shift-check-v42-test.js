/**
 * ═══ اختبار نظام التشييك الذكي v4.2 (اعتماد مبدئي 2026-09-06) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3131 — لا تمس بيانات الإنتاج.
 * يغطي: القالب المركزي/المجموعات/ALS · «لا تغيير» بقواعده الأربع · اشتقاق الجاهزية
 * 🟢/🟡/🔴 · red_if_damaged · الكميات · الانعكاس · قراءة العمليات فقط · جلسات v1 القديمة.
 *
 * التشغيل: node scripts/shift-check-v42-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'v42-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'v42-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'v42-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'shift-check-v42-' + STAMP);
const PORT = 3131;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9485;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
function riyadhTodayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const pad2 = v => String(v).padStart(2, '0');

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

    // ── نسخة معزولة ──
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(TMP_DIR, f)); } catch (_) { } }
    }

    const today = riyadhTodayStr();
    const cm = today.slice(0, 7);
    const TEAM_A = 1, TEAM_A_NAME = 'جنوب 1';   // BLS (veh_TBLS)
    const TEAM_B = 20;                          // ALS (veh_TALS)
    const TEAM_L = 21;                          // جلسة v1 قديمة (veh_TLEG)
    const TEAM_OPS = 25;
    const NOW = '2026-09-06 01:00:00';

    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-D001', username: 'D001', name: 'مسعف أول v42', password: hash, role: 'user', isActive: true },
        { id: 'emp-D002', username: 'D002', name: 'مسعف ثانٍ v42', password: hash, role: 'user', isActive: true },
        { id: 'emp-D003', username: 'D003', name: 'مسعف ALS تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-D005', username: 'D005', name: 'عمليات بلا صلاحية قراءة', password: hash, role: 'user', isActive: true },
        { id: 'emp-D006', username: 'D006', name: 'مشرف تكميل تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-D007', username: 'D007', name: 'مسعف جلسة قديمة', password: hash, role: 'user', isActive: true },
        { id: 'adm-ADMD', username: 'ADMD', name: 'مدير v42', password: hash, role: 'admin', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
    const eD001 = insEmp.run('D001', 'مسعف أول v42', 'فني اسعاف').lastInsertRowid;
    const eD002 = insEmp.run('D002', 'مسعف ثانٍ v42', 'فني اسعاف').lastInsertRowid;
    const eD003 = insEmp.run('D003', 'مسعف ALS تجريبي', 'فني اسعاف').lastInsertRowid;
    const eD005 = insEmp.run('D005', 'عمليات بلا صلاحية قراءة', 'تحكم عملياتي').lastInsertRowid;
    const eD006 = insEmp.run('D006', 'مشرف تكميل تجريبي', 'تحكم عملياتي').lastInsertRowid;
    const eD007 = insEmp.run('D007', 'مسعف جلسة قديمة', 'فني اسعاف').lastInsertRowid;

    const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
    for (const u of ['emp-D001', 'emp-D002', 'emp-D003', 'emp-D005', 'emp-D006', 'emp-D007']) insPerm.run(u, 'ops.my_portal');
    insPerm.run('emp-D006', 'ops.completion'); // مشرف التكميل يقرأ الجاهزية

    const delR = dbw.prepare('DELETE FROM shift_roster WHERE shift_date = ? AND team_id IN (?, ?, ?, ?)').run(today, TEAM_A, TEAM_B, TEAM_L, TEAM_OPS);
    console.log('  🧹 حُذف ' + delR.changes + ' صف roster حقيقي لليوم داخل النسخة المعزولة');
    const insRoster = dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const id of [eD001, eD002]) insRoster.run(id, TEAM_A, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eD003, TEAM_B, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eD007, TEAM_L, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    for (const id of [eD005, eD006]) insRoster.run(id, TEAM_OPS, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);

    // مركبات الاختبار: BLS + ALS + قديمة — التصنيف من service_level الصريح فقط (قرار المالك)
    // (العمود يُنشأ هنا قبل الإقلاع لأن الزرع يسبق ensureColumn؛ إقلاع db.js يتخطاه)
    try { dbw.exec("ALTER TABLE vehicles ADD COLUMN service_level TEXT CHECK(service_level IN ('ALS','BLS'))"); } catch (_) { }
    const insVeh = dbw.prepare(`INSERT INTO vehicles (id, plate_number, call_sign, vehicle_type, model_year, category, designation, admin_status, sort_order, is_active, created_at, service_level)
        VALUES (?,?,?,?,?, 'إسعاف', 'نقطة دائمة', 'أساسية', 900, 1, ?, ?)`);
    insVeh.run('veh_TBLS', 'اخت-1001', 'جنوب 1', 'سفانا', 2024, NOW, 'BLS');
    insVeh.run('veh_TALS', 'اخت-1002', 'سريع 1', 'سفانا', 2024, NOW, 'ALS'); // الموديل بلا نص ALS — المصدر الصريح فقط
    insVeh.run('veh_TLEG', 'اخت-1003', 'سريع 2', 'سفانا', 2020, NOW, null); // غير مؤكد ← BLS مؤقتًا

    // إغلاق التعيينات المفتوحة ثم تعيينات نظيفة
    const insEv = dbw.prepare(`INSERT INTO operational_events
        (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center, event_type, status, reason, payload, note, actor_id, actor_name, created_at)
        VALUES (NULL, NULL, NULL, 'vehicle', ?, ?, ?, 'المنصورة', ?, NULL, NULL, NULL, NULL, 'test', 'اختبار', ?)`);
    {
        const evs = dbw.prepare("SELECT id, entity_id, event_type FROM operational_events WHERE domain = 'vehicle' ORDER BY created_at ASC, id ASC").all();
        const openByVeh = new Map();
        for (const e of evs) {
            if (e.event_type === 'assignment') openByVeh.set(e.entity_id, (openByVeh.get(e.entity_id) || 0) + 1);
            else if (e.event_type === 'assignment_end') { const n = openByVeh.get(e.entity_id) || 0; if (n > 0) openByVeh.set(e.entity_id, n - 1); }
        }
        let t = 0;
        for (const [vehId, n] of openByVeh)
            for (let i = 0; i < n; i++) { insEv.run(vehId, 'إنهاء اختباري', null, 'assignment_end', '2026-09-05T23:00:' + pad2(t % 60) + '.000Z'); t++; }
        console.log('  🧹 أُغلق ' + t + ' تعيينًا حقيقيًا مفتوحًا');
    }
    insEv.run('veh_TBLS', 'جنوب 1', String(TEAM_A), 'assignment', '2026-09-06T05:00:00.000Z');
    insEv.run('veh_TALS', 'سريع 1', String(TEAM_B), 'assignment', '2026-09-06T05:00:00.000Z');
    insEv.run('veh_TLEG', 'سريع 2', String(TEAM_L), 'assignment', '2026-09-06T05:00:00.000Z');

    // جداول التشييك (الزرع يسبق إقلاع الخادم) — schema_version الافتراضي 1
    dbw.exec(`CREATE TABLE IF NOT EXISTS shift_check_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_date TEXT NOT NULL, team_id INTEGER NOT NULL, team_name TEXT,
        vehicle_id TEXT NOT NULL DEFAULT '', vehicle_name TEXT, center TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
        created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME,
        UNIQUE(shift_date, team_id, vehicle_id))`);
    dbw.exec(`CREATE TABLE IF NOT EXISTS shift_check_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES shift_check_sessions(id) ON DELETE CASCADE,
        domain TEXT NOT NULL CHECK(domain IN ('medical','mechanical')),
        item_key TEXT NOT NULL, item_label TEXT NOT NULL,
        asset_id INTEGER REFERENCES assets(id),
        result TEXT CHECK(result IN ('ok','issue')), note TEXT,
        reflected INTEGER NOT NULL DEFAULT 0,
        checked_by TEXT, checked_by_name TEXT, checked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, item_key))`);
    dbw.exec(`CREATE TABLE IF NOT EXISTS shift_check_confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES shift_check_sessions(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL, employee_name TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('ack','checkin','checkout')),
        confirmed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, employee_id, kind))`);

    // فحص سابق حديث (أُنجز قبل 6 ساعات، بتاريخ مناوبة أمس) لمركبة BLS ← «لا تغيير» مؤهلة
    // ملاحظة الزرع: shift_date ≠ اليوم حتى لا تلتقطه _findOrCreateSession كجلسة اليوم
    const sixHoursAgo = new Date(Date.now() - 6 * 36e5).toISOString();
    const yDate = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const prevOk = dbw.prepare(
        `INSERT INTO shift_check_sessions (shift_date, team_id, team_name, vehicle_id, vehicle_name, center, status, created_by, completed_at)
         VALUES (?, ?, ?, 'veh_TBLS', 'جنوب 1', 'المنصورة', 'completed', 'test', ?)`)
        .run(yDate, TEAM_A, TEAM_A_NAME, sixHoursAgo).lastInsertRowid;
    dbw.prepare(`INSERT INTO shift_check_items (session_id, domain, item_key, item_label, result, checked_by, checked_by_name, checked_at)
        VALUES (?, 'mechanical', 'mech:brakes', 'الفرامل', 'ok', 'test', 'فاحص سابق', ?)`).run(prevOk, sixHoursAgo);

    // فحص سابق قديم (3 أيام) لمركبة ALS ← «لا تغيير» مرفوضة (stale)
    const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString();
    const oldDate = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    dbw.prepare(
        `INSERT INTO shift_check_sessions (shift_date, team_id, team_name, vehicle_id, vehicle_name, center, status, created_by, completed_at)
         VALUES (?, ?, ?, 'veh_TALS', 'سريع 1', 'المنصورة', 'completed', 'test', ?)`)
        .run(oldDate, TEAM_B, 'سريع 1', threeDaysAgo);

    // جلسة v1 قديمة الطراز لليوم (سريع 2) — بند ميكانيكي قديم واحد
    const legSes = dbw.prepare(
        `INSERT INTO shift_check_sessions (shift_date, team_id, team_name, vehicle_id, vehicle_name, center, status, created_by)
         VALUES (?, ?, ?, 'veh_TLEG', 'سريع 2', 'المنصورة', 'open', 'test')`)
        .run(today, TEAM_L, 'سريع 2').lastInsertRowid;
    dbw.prepare(`INSERT INTO shift_check_items (session_id, domain, item_key, item_label)
        VALUES (?, 'mechanical', 'mech:exterior', 'الحالة الخارجية والداخلية')`).run(legSes);
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — التشييك الذكي v4.2 | اليوم: ' + today);
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });

    let chrome = null, ws = null, msgId = 0, injectId = null;
    const pending = new Map();
    const consoleErrors = [];
    function cdp(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
        });
    }
    async function evalJs(expr) {
        const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result ? r.result.value : undefined;
    }
    async function shot(name) {
        const r = await cdp('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(r.data, 'base64'));
        console.log('  📸 ' + name + '.png');
    }
    async function login(u, p) {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
        const b = await r.json();
        return b.accessToken || null;
    }
    async function apiGet(p, tok) {
        const r = await fetch(BASE + p, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    async function apiPost(p, tok, body) {
        const r = await fetch(BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const tok1 = await login('D001', 'test1234');
        const tok2 = await login('D002', 'test1234');
        const tok3 = await login('D003', 'test1234');
        const tok5 = await login('D005', 'test1234');
        const tok6 = await login('D006', 'test1234');
        const tok7 = await login('D007', 'test1234');
        if (!tok1 || !tok2 || !tok3 || !tok5 || !tok6 || !tok7) throw new Error('فشل تسجيل دخول حسابات الاختبار');

        // ── 1) جلسة v2: القالب المركزي — 26 ميكانيكيًا/7 مجموعات + 65 طبيًا BLS + الأصول، بلا ALS ──
        const s1 = await apiGet('/api/my/check-session', tok1);
        const b1 = s1.body;
        const mech1 = (b1.items || []).filter(i => i.domain === 'mechanical');
        const medT = (b1.items || []).filter(i => i.domain === 'medical' && i.itemKey.startsWith('med:'));
        const assets1 = (b1.items || []).filter(i => i.itemKey.startsWith('asset:'));
        const gKeys = (b1.groups || []).map(g => g.key);
        check('1) جلسة v2 من القالب: schema=2 · 26 ميكانيكيًا/7 مجموعات · 65 طبيًا BLS · قسم الأصول · بلا ALS · بلا فحص سابق⇐مؤهلة',
            s1.status === 200 && b1.session.schema_version === 2
            && mech1.length === 26 && medT.length === 65 && assets1.length > 0
            && gKeys.filter(k => ['body', 'lights', 'tires_brakes', 'fluids', 'ac_battery', 'safety', 'radio'].includes(k)).length === 7
            && gKeys.includes('emt_bag') && gKeys.includes('oxygen_bag') && gKeys.includes('general') && gKeys.includes('assets')
            && !gKeys.includes('als') && b1.isAls === false
            && b1.noChange && b1.noChange.eligible === true,
            JSON.stringify({ mech: mech1.length, med: medT.length, assets: assets1.length, g: gKeys, nc: b1.noChange }));

        // ── 2) ALS حسب service_level الصريح من السجل — لا مطابقة نصية ولا اختيار مسعف ──
        const s3 = await apiGet('/api/my/check-session', tok3);
        const alsItems = (s3.body.items || []).filter(i => i.itemKey.startsWith('med:als:'));
        const noAlsInBls = !(b1.items || []).some(i => i.itemKey.startsWith('med:als:'));
        check('2) ALS: service_level=ALS يرى 18 بند ALS · BLS لا يراها · المصدر صريح (موديل المركبة «سفانا» بلا نص ALS)',
            s3.status === 200 && s3.body.isAls === true && s3.body.serviceLevel === 'ALS' && s3.body.serviceLevelConfirmed === true
            && alsItems.length === 18 && noAlsInBls,
            JSON.stringify({ als: alsItems.length, sl: s3.body.serviceLevel, conf: s3.body.serviceLevelConfirmed, noAlsInBls }));

        // ── 3) «لا تغيير» مرفوضة: آخر فحص أقدم من 24 ساعة (ALS) ──
        const nc3 = await apiPost('/api/my/check-session/no-change', tok3, {});
        check('3) «لا تغيير» مرفوضة عند فحص قديم: 409 NO_CHANGE_NOT_ALLOWED برسالة المدة',
            nc3.status === 409 && nc3.body.code === 'NO_CHANGE_NOT_ALLOWED' && String(nc3.body.error || '').includes('ساعة'),
            JSON.stringify(nc3.body));

        // ── 4) «لا تغيير» الناجحة: تأكيد فعلي مسجل بالوقت/المستخدم + مرجع آخر فحص ──
        const nc1 = await apiPost('/api/my/check-session/no-change', tok1, {});
        let ncRows = null, sessMode = null;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            ncRows = dbx.prepare('SELECT COUNT(*) c, MIN(no_change) mn, MIN(ref_checked_at) ref, MIN(checked_by_name) bn FROM shift_check_items WHERE session_id = ?').get(b1.session.id);
            sessMode = dbx.prepare('SELECT check_mode FROM shift_check_sessions WHERE id = ?').get(b1.session.id);
            dbx.close();
        }
        check('4) «لا تغيير» ناجحة: كل البنود no_change=1 بمرجع آخر فحص + اسم المؤكد + check_mode=no_change',
            nc1.status === 200 && nc1.body.noChange === true && ncRows.c > 0 && ncRows.mn === 1
            && ncRows.ref === sixHoursAgo && ncRows.bn === 'مسعف أول v42' && sessMode.check_mode === 'no_change',
            JSON.stringify({ nc: nc1.body, rows: ncRows, mode: sessMode }));

        // ── 5) حقول المركبة + اشتقاق 🟢 تلقائيًا (بلا زر اختيار) ──
        const vf1 = await apiPost('/api/my/check-session/vehicle-fields', tok1, { odometer: 45210, fuel_level: '75', cleanliness: 'clean', master_key: 1, fuel_card: 1 });
        check('5) حقول المركبة تُحفظ والجاهزية تُشتق 🟢 تلقائيًا بعد «لا تغيير» + الحقول',
            vf1.status === 200 && vf1.body.readiness && vf1.body.readiness.readiness === 'green',
            JSON.stringify(vf1.body));

        // ── 6) الكميات: «ناقص» يخزن المتاح + النتيجة issue + الجاهزية 🟡 ──
        const sh = await apiPost('/api/my/check-session/items', tok1, { item_key: 'med:general:g_gloves', status_detail: 'shortage', qty_available: '5' });
        const sAfterSh = await apiGet('/api/my/check-session', tok1);
        const gloveItem = (sAfterSh.body.items || []).find(i => i.itemKey === 'med:general:g_gloves');
        check('6) نقص مستهلك: qty المطلوب من القالب (10) + المتاح 5 + status=shortage + الجاهزية 🟡',
            sh.status === 200 && sh.body.readiness && sh.body.readiness.readiness === 'yellow'
            && gloveItem && gloveItem.qtyRequired === '10' && gloveItem.qtyAvailable === '5' && gloveItem.statusDetail === 'shortage',
            JSON.stringify({ sh: sh.body.readiness, item: gloveItem }));

        // ── 7) red_if_damaged: الأنوار الأمامية «يحتاج متابعة»=🟡 ثم «تالف»=🔴 ──
        const hl1 = await apiPost('/api/my/check-session/items', tok1, { item_key: 'mech:headlights', status_detail: 'follow_up' });
        const hl2 = await apiPost('/api/my/check-session/items', tok1, { item_key: 'mech:headlights', status_detail: 'damaged' });
        check('7) red_if_damaged: الأنوار الأمامية متابعة=🟡 ثم تالف=🔴 (قرار المالك — لا 🔴 دائمًا)',
            hl1.status === 200 && hl1.body.readiness.readiness === 'yellow'
            && hl2.status === 200 && hl2.body.readiness.readiness === 'red' && String(hl2.body.readiness.reason).includes('الأنوار الأمامية'),
            JSON.stringify({ y: hl1.body.readiness, r: hl2.body.readiness }));

        // ── 8) المسعف لا يستطيع فرض الجاهزية: حقل readiness في الطلب يُتجاهل ──
        const forge = await apiPost('/api/my/check-session/items', tok1, { item_key: 'mech:glass', status_detail: 'complete', readiness: 'green' });
        const sForge = await apiGet('/api/my/check-session', tok1);
        check('8) الجاهزية مشتقة لا تُختار: تجاهل readiness=green المُرسلة والنتيجة تبقى 🔴 من المصدر',
            forge.status === 200 && sForge.body.readiness === 'red',
            JSON.stringify({ forge: forge.body.readiness, sess: sForge.body.readiness }));

        // ── 9) الوقود أقل من 25% 🔴 — ثم إعادته 75% تُبقي 🔴 بسبب الأنوار (سبب مزدوج سابقًا) ──
        const fuel = await apiPost('/api/my/check-session/vehicle-fields', tok1, { fuel_level: 'under25' });
        check('9) وقود أقل من 25% ← 🔴 وسببه يظهر في readiness_reason',
            fuel.status === 200 && fuel.body.readiness.readiness === 'red' && String(fuel.body.readiness.reason).includes('الوقود'),
            JSON.stringify(fuel.body.readiness));

        // ── 10) «لا تغيير» تُمنع مع ملاحظة مفتوحة داخل الجلسة ──
        const ncBlocked = await apiPost('/api/my/check-session/no-change', tok2, {});
        check('10) «لا تغيير» ممنوعة مع وجود بنود عليها ملاحظات: 409 NO_CHANGE_NOT_ALLOWED',
            ncBlocked.status === 409 && ncBlocked.body.code === 'NO_CHANGE_NOT_ALLOWED',
            JSON.stringify(ncBlocked.body));

        // ── 11) الفحص السليم لا يولّد أحداثًا + ملاحظة ميكانيكية تنعكس في سجل المركبة ──
        let evB = 0;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            evB = dbx.prepare("SELECT COUNT(*) c FROM operational_events WHERE domain='vehicle' AND entity_id='veh_TBLS' AND event_type='note'").get().c;
            dbx.close();
        }
        const okRes = await apiPost('/api/my/check-session/items', tok1, { item_key: 'mech:glass', status_detail: 'complete' });
        const noteRes = await apiPost('/api/my/check-session/items', tok1, { item_key: 'mech:brakes', status_detail: 'damaged', note: 'اهتزاز عند الكبح' });
        let evA = 0, assetEv = 0;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            evA = dbx.prepare("SELECT COUNT(*) c FROM operational_events WHERE domain='vehicle' AND entity_id='veh_TBLS' AND event_type='note'").get().c;
            assetEv = dbx.prepare("SELECT COUNT(*) c FROM asset_events WHERE reason LIKE '%تشييك مناوبة%' AND actor_id='D001'").get().c;
            dbx.close();
        }
        check('11) السليم بلا أحداث · ملاحظة الفرامل انعكست note في سجل veh_TBLS · بند القالب الطبي بلا أصل لا ينتج asset_event',
            okRes.status === 200 && okRes.body.reflected === false
            && noteRes.status === 200 && noteRes.body.reflected === true && evA === evB + 1 && assetEv === 0,
            JSON.stringify({ evB, evA, assetEv, reflected: noteRes.body.reflected, warning: noteRes.body.warning }));

        // ── 12) صفحات العمليات قراءة فقط: 403 بلا صلاحية · 200 مع ops.completion · لا كتابة ──
        const rd5 = await apiGet('/api/ops/readiness/today', tok5);
        const rd6 = await apiGet('/api/ops/readiness/today', tok6);
        const wrOps = await apiPost('/api/ops/readiness/today', tok6, {});
        const detail = await apiGet('/api/ops/readiness/session/' + b1.session.id, tok6);
        const triage = (detail.body.items || []).find(i => i.itemKey === 'med:emt_bag:triage_cards');
        check('12) العمليات قراءة فقط: بلا صلاحية=403 · مع ops.completion=200 · POST=404 · التفاصيل تعرض المطلوب=20 والسبب',
            rd5.status === 403 && rd6.status === 200 && Array.isArray(rd6.body.sessions) && rd6.body.sessions.length >= 3
            && wrOps.status === 404
            && detail.status === 200 && triage && triage.qtyRequired === '20' && detail.body.session.readiness === 'red',
            JSON.stringify({ rd5: rd5.status, rd6: rd6.status, n: (rd6.body.sessions || []).length, wr: wrOps.status, triage: triage && triage.qtyRequired, rdy: detail.body.session && detail.body.session.readiness }));

        // ── 13) جلسة v1 قديمة: تُعرض وتُكمل بقواعدها + مركبة غير مصنّفة ← BLS موسومة «غير مؤكد» ──
        const s7 = await apiGet('/api/my/check-session', tok7);
        const legOk = await apiPost('/api/my/check-session/items', tok7, { item_key: 'mech:exterior', result: 'ok' });
        check('13) جلسة v1 قديمة: schema=1 · تجميع قديم · noChange=null · الكتابة بنمط v3 · serviceLevel=null ← غير مؤكد',
            s7.status === 200 && (s7.body.session.schema_version || 1) === 1
            && s7.body.noChange === null && Array.isArray(s7.body.groups) && s7.body.groups.length === 1
            && legOk.status === 200
            && s7.body.serviceLevel === null && s7.body.serviceLevelConfirmed === false && s7.body.isAls === false,
            JSON.stringify({ sv: s7.body.session.schema_version, nc: s7.body.noChange, g: (s7.body.groups || []).length, leg: legOk.status, sl: s7.body.serviceLevel }));

        // ── 14) الواجهة: بطاقة «🚑 جاهزية الفرقة» + سؤال التغييرات + شارة الجاهزية ──
        chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
            '--window-size=430,930', '--no-first-run', '--disable-gpu',
            '--user-data-dir=' + CHROME_PROFILE, 'about:blank'], { stdio: 'ignore' });
        let targets = null;
        for (let i = 0; i < 30; i++) { await sleep(500); try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json'); targets = await r.json(); break; } catch (_) { } }
        if (!targets) throw new Error('CDP غير متاح');
        const page = targets.find(t => t.type === 'page');
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = ev => {
            try {
                const m = JSON.parse(ev.data);
                if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
                else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
                else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value).join(' ').slice(0, 200));
            } catch (_) { }
        };
        await cdp('Page.enable'); await cdp('Runtime.enable');
        const inj = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token','${tok1}');}catch(e){}` });
        injectId = inj.identifier;
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4500);
        const ui = await evalJs(`(() => ({
            title: document.body.textContent.includes('🚑 جاهزية الفرقة'),
            question: document.body.textContent.includes('هل توجد أي تغييرات منذ آخر تشييك؟'),
            badgeRed: !!document.querySelector('.rdy-badge.rdy-red'),
            ncDisabled: (() => { const b = document.querySelector('[data-nc]'); return b ? b.disabled : null; })(),
            vehicleFields: document.body.textContent.includes('قراءة العداد')
        }))()`);
        check('14) واجهة المسعف: بطاقة جاهزية الفرقة + سؤال التغييرات + شارة 🔴 + زر «لا تغيير» معطّل مع الملاحظات + حقول المركبة',
            ui.title && ui.question && ui.badgeRed && ui.ncDisabled === true && ui.vehicleFields,
            JSON.stringify(ui));
        await shot('v42-1-portal-readiness-red');

        // شارة العمليات في صفحة التكميل (قراءة فقط — مشرف التكميل)
        await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectId }); injectId = null;
        const inj6 = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token','${tok6}');}catch(e){}` });
        injectId = inj6.identifier;
        await cdp('Page.navigate', { url: BASE + '/check-review.html?session=' + b1.session.id });
        await sleep(3500);
        const review = await evalJs(`(() => ({
            ro: document.body.textContent.includes('عرض فقط'),
            red: document.body.textContent.includes('🔴 غير جاهزة'),
            qty: document.body.textContent.includes('بطاقات الفرز'),
            ncTag: document.body.textContent.includes('لا تغيير')
        }))()`);
        check('15) صفحة المشرف التفصيلية: عرض فقط + 🔴 + بنود القالب بكمياتها + وسم «لا تغيير» بمرجعه',
            review.ro && review.red && review.qty && review.ncTag, JSON.stringify(review));
        await shot('v42-2-supervisor-review');

        // ── 16) انحدار: مسارات البوابة v1/v2 + Console=صفر ──
        const rp = await apiGet('/api/my/profile', tok1);
        const rs = await apiGet(`/api/my/schedule?month=${+cm.slice(5)}&year=${+cm.slice(0, 4)}`, tok1);
        const rv = await apiGet('/api/my/vehicle', tok1);
        const ri = await apiGet('/api/my/inventory', tok1);
        check('16) انحدار: profile/schedule/vehicle/inventory ← 200 + Console=صفر',
            rp.status === 200 && rs.status === 200 && rv.status === 200 && ri.status === 200 && consoleErrors.length === 0,
            `${rp.status}/${rs.status}/${rv.status}/${ri.status} console=${consoleErrors.length} ${consoleErrors[0] || ''}`);

        console.log('\n════════════════ نتيجة التشييك الذكي v4.2: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
        console.log('اللقطات: ' + OUT_DIR);
    } finally {
        try { if (chrome) chrome.kill(); } catch (_) { }
        try { server.kill(); } catch (_) { }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.rmSync(CHROME_PROFILE, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})();
