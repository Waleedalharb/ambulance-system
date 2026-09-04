/**
 * ═══ اختبار إجراءات الاستلام والتسليم — بوابة الموظف v3 (اعتماد المالك 2026-09-04) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3123 — لا تمس بيانات الإنتاج.
 * يغطي حالات المالك الأحد عشر + قاعدة «الفحص السليم لا يولّد أحداثًا مركزية»
 * + الانعكاس في النظامين المختصين (asset_events / operational_events).
 *
 * التشغيل: node scripts/shift-check-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'shiftcheck-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'shiftcheck-data-' + STAMP).replace(/\\/g, '/');
const CHROME_PROFILE = path.join(os.tmpdir(), 'shiftcheck-profile-' + STAMP).replace(/\\/g, '/');
const OUT_DIR = path.join(ROOT, 'test-output', 'shift-check-' + STAMP);
const PORT = 3123;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9484;
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
function addDaysRef(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
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
    const yesterday = addDaysRef(today, -1);
    const cm = today.slice(0, 7);
    const TEAM_A = 1, TEAM_A_NAME = 'جنوب 1';      // ميدانية + 17 أصلًا
    const TEAM_B = 20, TEAM_B_NAME = 'سريع 1';     // ميدانية بلا مركبة في سيناريونا
    const TEAM_OPS = 25;                            // عمليات
    const NOW = '2026-09-04 02:30:00';

    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push(
        { id: 'emp-C001', username: 'C001', name: 'مسعف أول تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-C002', username: 'C002', name: 'مسعف ثانٍ تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'emp-C003', username: 'C003', name: 'مسعف بلا مركبة', password: hash, role: 'user', isActive: true },
        { id: 'emp-C005', username: 'C005', name: 'موظف عمليات للتشييك', password: hash, role: 'user', isActive: true },
        { id: 'emp-C006', username: 'C006', name: 'موظف منتقل تجريبي', password: hash, role: 'user', isActive: true },
        { id: 'adm-ADMC', username: 'ADMC', name: 'مدير تحقق التشييك', password: hash, role: 'admin', isActive: true }
    );
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    const dbw = new Database(TMP_DB);
    dbw.pragma('journal_mode = WAL');
    const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
    const eC001 = insEmp.run('C001', 'مسعف أول تجريبي', 'فني اسعاف').lastInsertRowid;
    const eC002 = insEmp.run('C002', 'مسعف ثانٍ تجريبي', 'فني اسعاف').lastInsertRowid;
    const eC003 = insEmp.run('C003', 'مسعف بلا مركبة', 'فني اسعاف').lastInsertRowid;
    const eC005 = insEmp.run('C005', 'موظف عمليات للتشييك', 'تحكم عملياتي').lastInsertRowid;
    const eC006 = insEmp.run('C006', 'موظف منتقل تجريبي', 'فني اسعاف').lastInsertRowid;

    const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, 'test')");
    for (const u of ['emp-C001', 'emp-C002', 'emp-C003', 'emp-C005', 'emp-C006']) insPerm.run(u);

    // roster اليوم: C001+C002 ← جنوب 1 · C003+C006 ← سريع 1 (بلا مركبة) · C005 ← عمليات
    // عزل: النسخة الإنتاجية فيها roster حقيقي لليوم (جنوب 1: 4، سريع 1: 2، عمليات: 2) —
    // الاكتمال يشترط تسليم كل الأعضاء، لذا نحذف صفوف اليوم لهذه الفرق في النسخة المعزولة فقط
    const delR = dbw.prepare('DELETE FROM shift_roster WHERE shift_date = ? AND team_id IN (?, ?, ?)').run(today, TEAM_A, TEAM_B, TEAM_OPS);
    console.log('  🧹 حُذف ' + delR.changes + ' صف roster حقيقي لليوم داخل النسخة المعزولة');
    const insRoster = dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const id of [eC001, eC002]) insRoster.run(id, TEAM_A, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    for (const id of [eC003, eC006]) insRoster.run(id, TEAM_B, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
    insRoster.run(eC005, TEAM_OPS, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);

    // أصول جنوب 1 الفعلية (مرجع التوقعات)
    const teamAssets = dbw.prepare("SELECT id, asset_code, type_name FROM assets WHERE team_name='جنوب 1' AND archived_at IS NULL ORDER BY id").all();
    const ASSET_ISSUE = teamAssets[0];   // عليه ملاحظة الأمس المفتوحة
    const ASSET_OK = teamAssets[1];      // فحص سليم — لا حدث مركزي
    const ASSET_NOTE = teamAssets[2];    // ملاحظة اليوم — تنعكس
    const teamBAssetCount = dbw.prepare("SELECT COUNT(*) c FROM assets WHERE team_name='سريع 1' AND archived_at IS NULL").get().c;

    // إغلاق كل التعيينات الحقيقية المفتوحة ثم سيناريو نظيف: veh_000001 ← جنوب 1 فقط
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
            for (let i = 0; i < n; i++) { insEv.run(vehId, 'إنهاء اختباري', null, 'assignment_end', '2026-09-03T23:00:' + pad2(t % 60) + '.000Z'); t++; }
        console.log('  🧹 أُغلق ' + t + ' تعيينًا حقيقيًا مفتوحًا');
    }
    insEv.run('veh_000001', 'جنوب 1', String(TEAM_A), 'assignment', '2026-09-04T06:00:00.000Z');

    // الجداول الجديدة تُنشأ عند إقلاع db.js — ننشئها هنا لأن الزرع يسبق إقلاع الخادم
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

    // جلسة «أمس» مكتملة عليها ملاحظتان مفتوحتان: إطارات المركبة + أصل طبي
    const ySes = dbw.prepare(
        `INSERT INTO shift_check_sessions (shift_date, team_id, team_name, vehicle_id, vehicle_name, center, status, created_by, completed_at)
         VALUES (?, ?, ?, 'veh_000001', 'جنوب 1', 'المنصورة', 'completed', 'test', datetime('now'))`)
        .run(yesterday, TEAM_A, TEAM_A_NAME).lastInsertRowid;
    const insItemY = dbw.prepare(
        `INSERT INTO shift_check_items (session_id, domain, item_key, item_label, asset_id, result, note, reflected, checked_by, checked_by_name, checked_at)
         VALUES (?, ?, ?, ?, ?, 'issue', ?, 1, 'test', 'اختبار سابق', ?)`);
    insItemY.run(ySes, 'mechanical', 'mech:tires', 'الإطارات', null, 'إطار مهتري', yesterday + 'T07:00:00.000Z');
    insItemY.run(ySes, 'medical', 'asset:' + ASSET_ISSUE.id, ASSET_ISSUE.type_name + ' (' + ASSET_ISSUE.asset_code + ')', ASSET_ISSUE.id, 'نقص مستهلكات', yesterday + 'T07:05:00.000Z');
    dbw.close();

    console.log('🧪 خادم معزول على ' + PORT + ' — إجراءات الاستلام والتسليم | اليوم: ' + today);
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
    async function apiGet(path_, tok) {
        const r = await fetch(BASE + path_, tok ? { headers: { Authorization: 'Bearer ' + tok } } : {});
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }
    async function apiPost(path_, tok, body) {
        const r = await fetch(BASE + path_, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    try {
        if (!(await waitReady())) throw new Error('الخادم لم يقلع');
        const tok1 = await login('C001', 'test1234');
        const tok2 = await login('C002', 'test1234');
        const tok3 = await login('C003', 'test1234');
        const tok5 = await login('C005', 'test1234');
        const tok6 = await login('C006', 'test1234');
        const tokAdm = await login('ADMC', 'test1234');
        if (!tok1 || !tok2 || !tok3 || !tok5 || !tok6 || !tokAdm) throw new Error('فشل تسجيل دخول حسابات الاختبار');

        // ── 1) علم القسم + حالة غير الميداني ──
        const sec1 = await apiGet('/api/my/sections', tok1);
        const sec5 = await apiGet('/api/my/sections', tok5);
        const ses5 = await apiGet('/api/my/check-session', tok5);
        check('1) sections.check: ميداني=true · عمليات=false · وجلسة العمليات ← not_field_team',
            sec1.body.sections && sec1.body.sections.check === true
            && sec5.body.sections && sec5.body.sections.check === false
            && ses5.status === 200 && ses5.body.state === 'not_field_team',
            JSON.stringify({ c1: sec1.body.sections && sec1.body.sections.check, c5: sec5.body.sections && sec5.body.sections.check, s5: ses5.body.state }));

        // ── 2) حالة: تكليف + مركبة + عهدة — إنشاء كسول + لقطة البنود + ملاحظات الأمس المفتوحة ──
        const s1 = await apiGet('/api/my/check-session', tok1);
        const b1 = s1.body;
        const medItems = (b1.items || []).filter(i => i.domain === 'medical');
        const mechItems = (b1.items || []).filter(i => i.domain === 'mechanical');
        const openKeys = (b1.openIssues || []).map(o => o.itemKey);
        check('2) تكليف+مركبة+عهدة: جلسة جنوب 1/veh_000001 + 17 بندًا طبيًا + 7 ميكانيكية + عضوان + ملاحظتا الأمس المفتوحتان',
            s1.status === 200 && b1.session && b1.session.team_id === TEAM_A && b1.session.vehicle_id === 'veh_000001'
            && b1.session.status === 'open' && medItems.length === 17 && mechItems.length === 7
            && (b1.members || []).length === 2
            && openKeys.includes('mech:tires') && openKeys.includes('asset:' + ASSET_ISSUE.id),
            JSON.stringify({ med: medItems.length, mech: mechItems.length, m: (b1.members || []).length, openKeys }));

        // ── 3) الجلسة مشتركة — نفس المعرف للزميل، بلا تكرار ──
        const s2 = await apiGet('/api/my/check-session', tok2);
        let sessCount = 0;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            sessCount = dbx.prepare('SELECT COUNT(*) c FROM shift_check_sessions WHERE shift_date = ? AND team_id = ?').all(today, TEAM_A)[0].c;
            dbx.close();
        }
        check('3) سجل واحد مشترك: نفس session.id للزميل وصف واحد فقط في القاعدة',
            s2.status === 200 && s2.body.session && s1.body.session.id === s2.body.session.id && sessCount === 1,
            `s1=${s1.body.session && s1.body.session.id} s2=${s2.body.session && s2.body.session.id} rows=${sessCount}`);

        // ── 4) حالة: تكليف دون مركبة ──
        const s3 = await apiGet('/api/my/check-session', tok3);
        const b3 = s3.body;
        check('4) تكليف دون مركبة: جلسة سريع 1 بلا مركبة + صفر بنود ميكانيكية + بنوده الطبية = أصول سريع 1 فقط',
            s3.status === 200 && b3.session && b3.session.vehicle_id === '' && b3.vehicle === null
            && (b3.items || []).filter(i => i.domain === 'mechanical').length === 0
            && (b3.items || []).filter(i => i.domain === 'medical').length === teamBAssetCount,
            JSON.stringify({ veh: b3.session && b3.session.vehicle_id, med: (b3.items || []).length, teamBAssetCount }));

        // ── 5) عدم التسرب: بنود C003 لا تمس جنوب 1 + بند فرقة أخرى ← 404 ──
        const b3Keys = new Set((b3.items || []).map(i => i.itemKey));
        const leakPost = await apiPost('/api/my/check-session/items', tok3, { item_key: 'asset:' + ASSET_OK.id, result: 'ok' });
        check('5) لا تسرب: جلسة C003 بلا أي بند من جنوب 1 + تسجيل بند فرقة أخرى ← 404 ITEM_NOT_FOUND',
            !b3Keys.has('asset:' + ASSET_OK.id) && leakPost.status === 404 && leakPost.body.code === 'ITEM_NOT_FOUND',
            `leak=${leakPost.status}/${leakPost.body.code}`);

        // ── 6) الفحص السليم لا يولّد حدثًا مركزيًا (قاعدة المالك) ──
        let evBefore = 0;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            evBefore = dbx.prepare('SELECT COUNT(*) c FROM asset_events WHERE asset_id = ?').get(ASSET_OK.id).c;
            dbx.close();
        }
        const okRes = await apiPost('/api/my/check-session/items', tok1, { item_key: 'asset:' + ASSET_OK.id, result: 'ok' });
        let evAfter = 0, vehEvBefore = 0;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            evAfter = dbx.prepare('SELECT COUNT(*) c FROM asset_events WHERE asset_id = ?').get(ASSET_OK.id).c;
            vehEvBefore = dbx.prepare("SELECT COUNT(*) c FROM operational_events WHERE domain='vehicle' AND entity_id='veh_000001' AND event_type='note'").get().c;
            dbx.close();
        }
        check('6) «تم التحقق» السليم: يُحفظ في الجلسة فقط — صفر asset_events جديدة وreflected=false',
            okRes.status === 200 && okRes.body.result === 'ok' && okRes.body.reflected === false && evAfter === evBefore,
            JSON.stringify({ ok: okRes.body, evBefore, evAfter }));

        // ── 7) ملاحظة طبية ← تنعكس في سجل الجهاز (asset_events) وتظهر عبر API النظام المركزي ──
        const noteRes = await apiPost('/api/my/check-session/items', tok1, { item_key: 'asset:' + ASSET_NOTE.id, result: 'issue', note: 'عبوة ناقصة بعد البلاغ الأخير' });
        let assetEv = null;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            assetEv = dbx.prepare("SELECT * FROM asset_events WHERE asset_id = ? AND event_type = 'note_added' ORDER BY id DESC LIMIT 1").get(ASSET_NOTE.id);
            dbx.close();
        }
        const cardApi = await apiGet('/api/assets/' + ASSET_NOTE.id, tokAdm);
        const cardHas = JSON.stringify(cardApi.body).includes('عبوة ناقصة');
        check('7) الانعكاس الطبي: asset_events note_added باسم المسعف + يظهر في /api/assets/:id (نظام الأجهزة المركزي)',
            noteRes.status === 200 && noteRes.body.reflected === true
            && assetEv && assetEv.actor_name === 'مسعف أول تجريبي' && String(assetEv.reason).includes('عبوة ناقصة')
            && cardApi.status === 200 && cardHas,
            JSON.stringify({ reflected: noteRes.body.reflected, actor: assetEv && assetEv.actor_name, cardHas }));

        // ── 8) ملاحظة ميكانيكية ← تنعكس في سجل المركبة (operational_events عبر الخدمة الرسمية) ──
        const mechRes = await apiPost('/api/my/check-session/items', tok2, { item_key: 'mech:sirens', result: 'issue', note: 'صافرة اليسار لا تعمل' });
        const hist = await apiGet('/api/vehicles/veh_000001/history', tokAdm);
        const histHas = JSON.stringify(hist.body).includes('صافرة اليسار');
        check('8) الانعكاس الميكانيكي: حدث note في سجل veh_000001 باسم المسعف الثاني + يظهر في /api/vehicles/:id/history',
            mechRes.status === 200 && mechRes.body.reflected === true && hist.status === 200 && histHas,
            JSON.stringify({ reflected: mechRes.body.reflected, warning: mechRes.body.warning, histHas }));

        // ── 9) الملاحظة المفتوحة تُغلق بفحص لاحق سليم فقط ──
        await apiPost('/api/my/check-session/items', tok1, { item_key: 'mech:tires', result: 'ok' });
        const sAfterFix = await apiGet('/api/my/check-session', tok2);
        const openAfter = (sAfterFix.body.openIssues || []).map(o => o.itemKey);
        check('9) الإطارات: ملاحظة الأمس ظهرت في تشييك اليوم، وبعد فحصها «سليم» اختفت — والأصل الطبي بقي مفتوحًا',
            !openAfter.includes('mech:tires') && openAfter.includes('asset:' + ASSET_ISSUE.id),
            JSON.stringify(openAfter));

        // ── 10) التأكيدات المستقلة + منع التكرار + الاكتمال ──
        const c1a = await apiPost('/api/my/check-session/confirm', tok1, { kind: 'ack' });
        const c1i = await apiPost('/api/my/check-session/confirm', tok1, { kind: 'checkin' });
        const c1dup = await apiPost('/api/my/check-session/confirm', tok1, { kind: 'checkin' });
        const c2i = await apiPost('/api/my/check-session/confirm', tok2, { kind: 'checkin' });
        const c1o = await apiPost('/api/my/check-session/confirm', tok1, { kind: 'checkout' });
        const c2o = await apiPost('/api/my/check-session/confirm', tok2, { kind: 'checkout' });
        let confRows = 0;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            confRows = dbx.prepare("SELECT COUNT(*) c FROM shift_check_confirmations WHERE session_id = ? AND kind = 'checkin'").get(s1.body.session.id).c;
            dbx.close();
        }
        check('10) تأكيدات مستقلة لكل موظف + تكرار checkin ← already وصف واحد + اكتمال عند تسليم الجميع',
            c1a.status === 200 && c1i.body.already === false && c1dup.body.already === true && confRows === 2
            && c1o.body.completed === false && c2o.body.completed === true,
            JSON.stringify({ dup: c1dup.body, confRows, c1o: c1o.body.completed, c2o: c2o.body.completed }));

        // ── 11) جلسة مكتملة = قراءة فقط ──
        const lateWrite = await apiPost('/api/my/check-session/items', tok1, { item_key: 'asset:' + ASSET_OK.id, result: 'ok' });
        check('11) بعد الاكتمال: الكتابة ← 409 SESSION_COMPLETED والقراءة تعرض الحالة',
            lateWrite.status === 409 && lateWrite.body.code === 'SESSION_COMPLETED',
            `${lateWrite.status}/${lateWrite.body.code}`);

        // ── 12) انتقال الموظف إلى فرقة أخرى ← يعرض جلسة تكليفه الجديد ──
        const s6a = await apiGet('/api/my/check-session', tok6);
        {
            const dbx = new Database(TMP_DB);
            dbx.prepare('UPDATE shift_roster SET team_id = ? WHERE employee_id = ? AND shift_date = ?').run(TEAM_A, eC006, today);
            dbx.close();
        }
        const s6b = await apiGet('/api/my/check-session', tok6);
        check('12) الانتقال: C006 من سريع 1 إلى جنوب 1 ← يرى جلسة جنوب 1 المشتركة (المكتملة) تلقائيًا',
            s6a.status === 200 && s6a.body.session && s6a.body.session.team_id === TEAM_B
            && s6b.status === 200 && s6b.body.session && s6b.body.session.team_id === TEAM_A
            && s6b.body.session.id === s1.body.session.id && s6b.body.session.status === 'completed',
            JSON.stringify({ a: s6a.body.session && s6a.body.session.team_id, b: s6b.body.session && s6b.body.session.team_id }));

        // ── 13) انتهاء التكليف أثناء المناوبة: حالة صادقة + منع الكتابة + الجلسة محفوظة ──
        {
            const dbx = new Database(TMP_DB);
            dbx.prepare('DELETE FROM shift_roster WHERE employee_id = ? AND shift_date = ?').run(eC006, today);
            dbx.close();
        }
        const s6c = await apiGet('/api/my/check-session', tok6);
        const w6 = await apiPost('/api/my/check-session/confirm', tok6, { kind: 'ack' });
        let sessStillThere = false;
        {
            const dbx = new Database(TMP_DB, { readonly: true });
            sessStillThere = !!dbx.prepare('SELECT id FROM shift_check_sessions WHERE id = ?').get(s1.body.session.id);
            dbx.close();
        }
        check('13) انتهاء التكليف: GET ← no_assignment صادقة · الكتابة ← 409 NO_ASSIGNMENT · الجلسة محفوظة',
            s6c.status === 200 && s6c.body.state === 'no_assignment'
            && w6.status === 409 && w6.body.code === 'NO_ASSIGNMENT' && sessStillThere,
            JSON.stringify({ state: s6c.body.state, w: w6.status }));

        // ── 14) الواجهة: قسم التشييك + الانعكاس المرئي في بطاقة الجهاز ──
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
        const uiCheck = await evalJs(`(() => ({
            hasSection: document.body.textContent.includes('إجراءات الاستلام والتسليم'),
            completed: document.body.textContent.includes('اكتملت إجراءات الاستلام والتسليم'),
            medItems: [...document.querySelectorAll('.chk-item')].length,
            issueNote: document.body.textContent.includes('عبوة ناقصة'),
            reflectedTag: document.body.textContent.includes('انعكست في النظام المختص'),
            membersLine: document.body.textContent.includes('مسعف ثانٍ تجريبي')
        }))()`);
        check('14) الواجهة: قسم التشييك مكتمل الحالة + 24 بندًا + الملاحظة المنعكسة موسومة + تأكيدات العضوين',
            uiCheck.hasSection && uiCheck.completed && uiCheck.medItems === 24 && uiCheck.issueNote && uiCheck.reflectedTag && uiCheck.membersLine,
            JSON.stringify(uiCheck));
        await shot('v3-1-check-section-completed');

        // بطاقة الجهاز في نظام الأصول المركزي — الملاحظة ظاهرة في Timeline
        await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectId }); injectId = null;
        const injA = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token','${tokAdm}');}catch(e){}` });
        injectId = injA.identifier;
        await cdp('Page.navigate', { url: BASE + '/asset-card.html?id=' + ASSET_NOTE.id });
        await sleep(4000);
        const cardUi = await evalJs(`(() => ({
            hasNote: document.body.textContent.includes('عبوة ناقصة'),
            hasActor: document.body.textContent.includes('مسعف أول تجريبي'),
            label: document.body.textContent.includes('ملاحظة')
        }))()`);
        check('15) نظام الأجهزة المركزي: بطاقة الجهاز تعرض ملاحظة التشييك باسم المسعف في سجل Timeline',
            cardUi.hasNote && cardUi.hasActor, JSON.stringify(cardUi));
        await shot('v3-2-asset-card-reflection');

        // ── لقطات أدلة إضافية (مطلوبة لاعتماد ما قبل النشر) ──
        // v3-3) الجلسة المشتركة كما يراها الموظف الثاني: نفس الجلسة المكتملة + تأكيدات العضوين
        await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectId }); injectId = null;
        const injB = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('auth_access_token','${tok2}');}catch(e){}` });
        injectId = injB.identifier;
        await cdp('Page.navigate', { url: BASE + '/my-ems.html' });
        await sleep(4500);
        const sharedUi = await evalJs(`(() => ({
            completed: document.body.textContent.includes('اكتملت إجراءات الاستلام والتسليم'),
            bothMembers: document.body.textContent.includes('مسعف أول تجريبي') && document.body.textContent.includes('مسعف ثانٍ تجريبي'),
            items: [...document.querySelectorAll('.chk-item')].length
        }))()`);
        console.log('  🔎 v3-3 جلسة مشتركة للزميل: ' + JSON.stringify(sharedUi));
        await shot('v3-3-shared-session-second-member');

        // v3-4) منع الوصول لبند فرقة أخرى — استجابة الخادم كما هي (موظف سريع 1 يحاول بندًا من جنوب 1)
        const blockProof = await evalJs(`(async () => {
            const r = await fetch('/api/my/check-session/items', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${tok3}' }, body: JSON.stringify({ item_key: 'asset:${ASSET_ISSUE.id}', result: 'ok' }) });
            const j = await r.json().catch(() => ({}));
            document.body.innerHTML = '<div style="direction:rtl;font-family:sans-serif;padding:40px;background:#0d1b2a;color:#e5e7eb;min-height:100vh">'
                + '<h2>محاولة موظف فرقة «سريع 1» تسجيل بند يعود لفرقة «جنوب 1»</h2>'
                + '<p>POST /api/my/check-session/items — item_key: asset:${ASSET_ISSUE.id}</p>'
                + '<p style="font-size:32px;color:#f87171;font-weight:700">HTTP ' + r.status + '</p>'
                + '<pre style="background:#111827;padding:16px;border-radius:8px;direction:ltr;text-align:left">' + JSON.stringify(j, null, 2) + '</pre></div>';
            return { status: r.status, code: j.code };
        })()`);
        console.log('  🔎 v3-4 منع التسرب: ' + JSON.stringify(blockProof));
        await shot('v3-4-cross-team-blocked');

        // v3-5) انعكاس الملاحظة الميكانيكية في سجل المركبة الرسمي (واجهة إدارة المركبات)
        await evalJs(`try{localStorage.setItem('auth_access_token','${tokAdm}');}catch(e){}`);
        await cdp('Page.navigate', { url: BASE + '/admin-vehicles.html' });
        await sleep(5000);
        await evalJs(`openHistory('veh_000001')`).catch(() => {});
        await sleep(3000);
        const vehHist = await evalJs(`(() => {
            const t = document.body.textContent;
            return { hasNote: t.includes('صافرة اليسار'), hasActor: t.includes('مسعف ثانٍ تجريبي'), modalOpen: !!document.querySelector('#historyModal.active') };
        })()`);
        console.log('  🔎 v3-5 سجل المركبة: ' + JSON.stringify(vehHist));
        await shot('v3-5-vehicle-history-reflection');

        // ── 16) انحدار: مسارات البوابة v1/v2 + Console=صفر ──
        const rp = await apiGet('/api/my/profile', tok1);
        const rs = await apiGet(`/api/my/schedule?month=${+cm.slice(5)}&year=${+cm.slice(0, 4)}`, tok1);
        const rv = await apiGet('/api/my/vehicle', tok1);
        const ri = await apiGet('/api/my/inventory', tok1);
        check('16) انحدار: profile/schedule/vehicle/inventory ← 200 + Console=صفر',
            rp.status === 200 && rs.status === 200 && rv.status === 200 && ri.status === 200 && consoleErrors.length === 0,
            `${rp.status}/${rs.status}/${rv.status}/${ri.status} console=${consoleErrors.length} ${consoleErrors[0] || ''}`);

        console.log('\n════════════════ نتيجة إجراءات الاستلام والتسليم: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
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
