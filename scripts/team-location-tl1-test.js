/**
 * ═══ اختبار TL1: الموقع التشغيلي الحي للفرق (اعتماد المالك 2026-09-21) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3135 — لا تمس بيانات الإنتاج.
 * النطاق: خدمة الموقع فقط (GPS ← SSOT ← API). لا خريطة ولا ETA ولا iOS هنا.
 *
 * يغطي قرارات المالك المعتمدة:
 *  - السيرفر يحسم الفرقة من تكليف اليوم؛ team_id من العميل ← 400 صريح.
 *  - الإرسال للفرق الميدانية فقط (جنوب/دعم/سريع) ← غير ذلك 422 NO_FIELD_ASSIGNMENT.
 *  - صف واحد لكل فرقة: الأحدث recorded_at يفوز، التعادل للأدق — applied:false بصدق.
 *  - الحالة مشتقة عند القراءة: fresh ≤120s · stale ≤15min · unavailable (>15min
 *    أو accuracy>500m) تُعاد بالحالة وageSeconds (الخيار A المعتمد 2026-09-21 —
 *    آخر موقع معروف، ليس موقعًا حيًا ولا يدخل أقرب-فرقة/ETA مستقبلًا).
 *  - received_at سيرفري حتمًا — القيمة القادمة من العميل لا أثر لها.
 *  - القراءة محروسة بـ ops.team_locations.view (منح فردي) ← 401/403.
 *  - انحدار: /api/ops/centers (P1) وcheck-session بلا تغيير.
 *
 * التشغيل: node scripts/team-location-tl1-test.js
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
const TMP_DB = path.join(os.tmpdir(), 'tl1-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'tl1-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3135;
const BASE = 'http://127.0.0.1:' + PORT;
const MAIN_MODULES = path.join(MAIN_REPO, 'node_modules');

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

async function login(u) {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'test1234' }) });
    const b = await r.json();
    return b.accessToken || null;
}
async function apiGet(p, tok) {
    const r = await fetch(BASE + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
    let body = null; try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}
async function apiPost(p, tok, payload) {
    const r = await fetch(BASE + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
        body: JSON.stringify(payload)
    });
    let body = null; try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}

(async () => {
    let server = null;
    try {
        const Database = require(path.join(MAIN_MODULES, 'better-sqlite3'));
        const bcrypt = require(path.join(MAIN_MODULES, 'bcryptjs'));

        // ── نسخة معزولة ──
        const src = new Database(SRC_DB, { readonly: true });
        src.exec("VACUUM INTO '" + TMP_DB + "'");
        src.close();
        fs.mkdirSync(TMP_DIR, { recursive: true });
        for (const f of fs.readdirSync(SRC_DATA)) {
            if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(SRC_DATA, f), path.join(TMP_DIR, f)); } catch (_) { } }
        }

        const dbw = new Database(TMP_DB);
        dbw.pragma('journal_mode = WAL');

        // فرق حقيقية: 4 ميدانية (جنوب) + 1 غير ميدانية (عمليات)
        const fieldTeams = dbw.prepare("SELECT id, name FROM teams WHERE is_active = 1 AND team_type = 'جنوب' ORDER BY id LIMIT 4").all();
        const opsTeam = dbw.prepare("SELECT id, name FROM teams WHERE is_active = 1 AND team_type = 'عمليات' ORDER BY id LIMIT 1").get();
        if (fieldTeams.length < 4 || !opsTeam) throw new Error('فرق اختبار غير كافية في النسخة المعزولة');
        const [T1, T2, T3, T4] = fieldTeams;
        console.log('  🧭 فرق الاختبار: ميدانية=' + fieldTeams.map(t => t.name).join('/') + ' · غير ميدانية=' + opsTeam.name);

        const today = riyadhTodayStr();
        const cm = today.slice(0, 7);
        const NOW = new Date().toISOString().replace('T', ' ').slice(0, 19);

        // مستخدمون: عضوان لنفس الفرقة + غير ميداني + قارئ مواقع + بلا صلاحيات
        const hash = bcrypt.hashSync('test1234', 10);
        const usersPath = path.join(TMP_DIR, 'users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        for (const u of ['TL001', 'TL002', 'TL003', 'TL004', 'TL005']) {
            users.push({ id: 'emp-' + u, username: u, name: 'اختبار ' + u, password: hash, role: 'user', isActive: true });
        }
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

        const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
        const e1 = insEmp.run('TL001', 'عضو أول tl1', 'فني اسعاف').lastInsertRowid;
        const e2 = insEmp.run('TL002', 'عضو ثانٍ tl1', 'فني اسعاف').lastInsertRowid;
        const e3 = insEmp.run('TL003', 'غير ميداني tl3', 'فني اسعاف').lastInsertRowid;
        insEmp.run('TL004', 'قارئ مواقع tl4', 'تحكم عملياتي');
        insEmp.run('TL005', 'بلا صلاحيات tl5', 'فني اسعاف');

        const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
        insPerm.run('emp-TL001', 'ops.my_portal');
        insPerm.run('emp-TL002', 'ops.my_portal');
        insPerm.run('emp-TL003', 'ops.my_portal');
        insPerm.run('emp-TL004', 'ops.team_locations.view');
        // TL005: لا منح — role=user (ops.execute التوافقي لا يفتح شيئًا)

        const insRoster = dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
        insRoster.run(e1, T1.id, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
        insRoster.run(e2, T1.id, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW); // عضو ثانٍ لنفس الفرقة
        insRoster.run(e3, opsTeam.id, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW); // تكليف غير ميداني

        console.log('🧪 خادم معزول على ' + PORT + ' — TL1 الموقع الحي للفرق | اليوم: ' + today);
        const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', NODE_PATH: path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES };
        server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
        check('0) الخادم المعزول أقلع', await waitReady());

        // بذر حالات بعد الإقلاع (الجدول أُنشئ بواسطة initDatabase):
        // T2=stale (5 دقائق) · T3=unavailable قديم (20 دقيقة) · T4=unavailable دقة (600م)
        const insLoc = dbw.prepare(`INSERT INTO team_live_locations
            (team_id, latitude, longitude, accuracy, recorded_at, received_at, source_employee_id, updated_at)
            VALUES (?,?,?,?,?,?,?,?)`);
        const iso = ms => new Date(ms).toISOString();
        const nowMs = Date.now();
        insLoc.run(T2.id, 24.61, 46.75, 12, iso(nowMs - 5 * 60 * 1000), iso(nowMs - 5 * 60 * 1000), e1, iso(nowMs));
        insLoc.run(T3.id, 24.56, 46.76, 12, iso(nowMs - 20 * 60 * 1000), iso(nowMs - 20 * 60 * 1000), e1, iso(nowMs));
        insLoc.run(T4.id, 24.44, 46.61, 600, iso(nowMs - 30 * 1000), iso(nowMs), e1, iso(nowMs));

        const tok1 = await login('TL001');
        const tok2 = await login('TL002');
        const tok3 = await login('TL003');
        const tok4 = await login('TL004');
        const tok5 = await login('TL005');
        check('0أ) تسجيل دخول الخمسة', !!(tok1 && tok2 && tok3 && tok4 && tok5));

        // ═══ الحراسة ═══
        const noTok = await apiPost('/api/my/team-location', null, { latitude: 24.6, longitude: 46.7, recordedAt: iso(nowMs) });
        check('1) POST بلا توكن ← 401', noTok.status === 401, 'status=' + noTok.status);
        const noPerm = await apiPost('/api/my/team-location', tok5, { latitude: 24.6, longitude: 46.7, recordedAt: iso(nowMs) });
        check('2) POST بلا ops.my_portal ← 403', noPerm.status === 403, 'status=' + noPerm.status);

        // ═══ الإرسال السليم ═══
        const rec1 = iso(nowMs - 10 * 1000); // قبل 10 ثوانٍ — fresh
        const ok1 = await apiPost('/api/my/team-location', tok1, { latitude: 24.614, longitude: 46.751, accuracy: 12, recordedAt: rec1 });
        check('3) GPS صالح من عضو فرقة ميدانية ← 200 + applied + fresh + teamId الفرقة',
            ok1.status === 200 && ok1.body && ok1.body.success === true && ok1.body.applied === true &&
            ok1.body.status === 'fresh' && ok1.body.teamId === T1.id && ok1.body.teamName === T1.name,
            JSON.stringify(ok1.body));

        // ═══ عدم الوثوق بالعميل ═══
        const withTeam = await apiPost('/api/my/team-location', tok1, { latitude: 24.6, longitude: 46.7, recordedAt: iso(nowMs), team_id: 999 });
        check('4) team_id في الجسم ← 400 TEAM_ID_NOT_ACCEPTED (لا تجاهل صامت)',
            withTeam.status === 400 && withTeam.body && withTeam.body.code === 'TEAM_ID_NOT_ACCEPTED',
            'status=' + withTeam.status + ' ' + JSON.stringify(withTeam.body));
        const badLat = await apiPost('/api/my/team-location', tok1, { latitude: 95, longitude: 46.7, recordedAt: iso(nowMs) });
        check('5) latitude خارج النطاق ← 400 validateBody', badLat.status === 400, 'status=' + badLat.status);
        const badDate = await apiPost('/api/my/team-location', tok1, { latitude: 24.6, longitude: 46.7, recordedAt: 'not-a-date' });
        check('6) recordedAt غير صالح ← 422 BAD_INPUT', badDate.status === 422 && badDate.body && badDate.body.code === 'BAD_INPUT',
            'status=' + badDate.status);

        // ═══ غير الميداني ═══
        const notField = await apiPost('/api/my/team-location', tok3, { latitude: 24.6, longitude: 46.7, recordedAt: iso(nowMs) });
        check('7) تكليف غير ميداني ← 422 NO_FIELD_ASSIGNMENT',
            notField.status === 422 && notField.body && notField.body.code === 'NO_FIELD_ASSIGNMENT',
            'status=' + notField.status + ' ' + JSON.stringify(notField.body));
        const opsRow = dbw.prepare('SELECT COUNT(*) c FROM team_live_locations WHERE team_id = ?').get(opsTeam.id);
        check('8) لا صف يُنشأ للفرقة غير الميدانية', opsRow.c === 0);

        // ═══ قاعدة العضوين: الأحدث recorded_at يفوز ═══
        const recNewer = iso(nowMs - 5 * 1000);
        const ok2 = await apiPost('/api/my/team-location', tok2, { latitude: 24.62, longitude: 46.75, accuracy: 8, recordedAt: recNewer });
        check('9) العضو الثاني بموقع أحدث ← applied:true', ok2.status === 200 && ok2.body && ok2.body.applied === true,
            JSON.stringify(ok2.body));
        const recOlder = iso(nowMs - 60 * 1000);
        const older = await apiPost('/api/my/team-location', tok1, { latitude: 24.0, longitude: 46.0, accuracy: 5, recordedAt: recOlder });
        check('10) موقع أقدم من المخزن ← applied:false older_than_current (لا يفشل ولا يكتب)',
            older.status === 200 && older.body && older.body.applied === false && older.body.reason === 'older_than_current',
            JSON.stringify(older.body));
        const rowT1 = dbw.prepare('SELECT latitude, source_employee_id FROM team_live_locations WHERE team_id = ?').get(T1.id);
        check('11) الصف الواحد محفوظ للفائز (العضو الثاني) — لا فرقتان',
            rowT1 && rowT1.source_employee_id === e2 && Math.abs(rowT1.latitude - 24.62) < 0.0001,
            JSON.stringify(rowT1));
        const countT1 = dbw.prepare('SELECT COUNT(*) c FROM team_live_locations WHERE team_id = ?').get(T1.id);
        check('12) صف واحد فقط للفرقة رغم عضوين يرسلان', countT1.c === 1);

        // ═══ received_at سيرفري حتمًا ═══
        const fakeRecv = await apiPost('/api/my/team-location', tok2, {
            latitude: 24.63, longitude: 46.76, accuracy: 9,
            recordedAt: iso(nowMs), receivedAt: '2020-01-01T00:00:00.000Z'
        });
        check('13) الإرسال مع receivedAt مزيف ← 200 (الحقل لا أثر له)', fakeRecv.status === 200 && fakeRecv.body && fakeRecv.body.applied === true);
        const rowRecv = dbw.prepare('SELECT received_at, recorded_at FROM team_live_locations WHERE team_id = ?').get(T1.id);
        const recvMs = Date.parse(rowRecv.received_at);
        check('14) received_at سيرفري ≈ الآن (لا يُؤخذ من الجهاز)',
            Number.isFinite(recvMs) && Math.abs(recvMs - Date.now()) < 60 * 1000 && !rowRecv.received_at.startsWith('2020'),
            JSON.stringify(rowRecv));

        // ═══ القراءة: الحراسة + الحالات المشتقة ═══
        const readNoTok = await apiGet('/api/ops/team-locations', null);
        check('15) GET بلا توكن ← 401', readNoTok.status === 401);
        const readNoPerm = await apiGet('/api/ops/team-locations', tok5);
        check('16) GET بلا ops.team_locations.view ← 403', readNoPerm.status === 403, 'status=' + readNoPerm.status);
        const readOk = await apiGet('/api/ops/team-locations', tok4);
        const teams = (readOk.body && readOk.body.teams) || {};
        check('17) GET بالمفتاح المستقل ← 200 + success + version',
            readOk.status === 200 && readOk.body && readOk.body.success === true && readOk.body.version === 1,
            'status=' + readOk.status);
        const t1v = teams[T1.name];
        check('18) فرقة العضوين تظهر مرة واحدة fresh مع مصدر الموقع وعمره',
            !!t1v && t1v.status === 'fresh' && t1v.teamId === T1.id && t1v.sourceEmployee === 'عضو ثانٍ tl1' &&
            typeof t1v.ageSeconds === 'number' && t1v.ageSeconds <= 120,
            JSON.stringify(t1v));
        const t2v = teams[T2.name];
        check('19) موقع عمره 5 دقائق ← stale مع ageSeconds صادق',
            !!t2v && t2v.status === 'stale' && t2v.ageSeconds > 120 && t2v.ageSeconds <= 900,
            JSON.stringify(t2v));
        check('20) unavailable تُعاد بالحالة (الخيار A المعتمد): القديمة (20 د) ورديئة الدقة (600م) موجودتان بـ status=unavailable و ageSeconds صادق — آخر موقع معروف وليس حيًا',
            teams[T3.name] && teams[T3.name].status === 'unavailable' && teams[T3.name].ageSeconds > 900 &&
            teams[T4.name] && teams[T4.name].status === 'unavailable' &&
            typeof teams[T3.name].latitude === 'number',
            JSON.stringify({ t3: teams[T3.name], t4: teams[T4.name] }));

        // ═══ انحدار ═══
        const centers = await apiGet('/api/ops/centers', tok4);
        check('21) انحدار P1: /api/ops/centers ← 200 + integrity.complete',
            centers.status === 200 && centers.body && centers.body.integrity && centers.body.integrity.complete === true,
            'status=' + centers.status);
        const checkSession = await apiGet('/api/my/check-session', tok1);
        check('22) انحدار: /api/my/check-session يعمل لعضو الفرقة', checkSession.status === 200, 'status=' + checkSession.status);

        dbw.close();
    } catch (e) {
        check('سير الاختبار بلا استثناء', false, e.message);
    }

    console.log('');
    console.log('════════════════ TL1 الموقع الحي للفرق: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    if (server) server.kill();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    for (const p of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(p); } catch (_) { } }
    process.exit(failed ? 1 : 0);
})();
