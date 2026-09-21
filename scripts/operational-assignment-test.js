/**
 * ═══ اختبار operational-assignment-service — التكليف التشغيلي الفعلي (معتمد 2026-09-21) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3136 — لا تمس بيانات الإنتاج.
 * يختبر السلوك الطرفي عبر POST /api/my/team-location الحقيقي (الربط المعتمد)،
 * على مناوبة نشطة + أحداث staffing فعلية داخل النسخة المعزولة.
 *
 * يغطي قرارات المالك الخمسة:
 *  1) الغياب أعلى من الإسناد · التعارف = رفض بلا تخمين · correction يستبعد المستهدف.
 *  2) مطابقة الشخص بالكود ثم الاسم التام.
 *  3) لا مناوبة نشطة ← جدولة فقط.
 *  4) exit مفتوح = غياب ← 422 ABSENT_TODAY · return يغلقه فيعود مؤهلًا.
 *  5) activation مفتوح = إسناد تشغيلي ← المفعَّل يرسل على فرقة تفعيله.
 *  + سيناريو المالك: أحمد غائب/محمد مجدول/خالد بديل بإسناد، وsupport_end يعيد خالد.
 *
 * التشغيل: node scripts/operational-assignment-test.js
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
const TMP_DB = path.join(os.tmpdir(), 'oas-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'oas-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3136;
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
async function postLoc(tok, extra) {
    const r = await fetch(BASE + '/api/my/team-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ latitude: 24.61, longitude: 46.75, accuracy: 10, recordedAt: new Date().toISOString(), ...(extra || {}) })
    });
    let body = null; try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}

(async () => {
    let server = null;
    try {
        const Database = require(path.join(MAIN_MODULES, 'better-sqlite3'));
        const bcrypt = require(path.join(MAIN_MODULES, 'bcryptjs'));

        const src = new Database(SRC_DB, { readonly: true });
        src.exec("VACUUM INTO '" + TMP_DB + "'");
        src.close();
        fs.mkdirSync(TMP_DIR, { recursive: true });
        for (const f of fs.readdirSync(SRC_DATA)) {
            if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(SRC_DATA, f), path.join(TMP_DIR, f)); } catch (_) { } }
        }

        const dbw = new Database(TMP_DB);
        dbw.pragma('journal_mode = WAL');

        const T1 = dbw.prepare("SELECT id, name FROM teams WHERE is_active=1 AND team_type='جنوب' ORDER BY id LIMIT 1").get(); // جنوب 1
        const T2 = dbw.prepare("SELECT id, name FROM teams WHERE is_active=1 AND team_type='جنوب' ORDER BY id LIMIT 1 OFFSET 1").get(); // جنوب 2
        const T3 = dbw.prepare("SELECT id, name FROM teams WHERE is_active=1 AND team_type='جنوب' ORDER BY id LIMIT 1 OFFSET 2").get(); // جنوب 3
        if (!T1 || !T2 || !T3) throw new Error('فرق اختبار غير كافية');

        const today = riyadhTodayStr();
        const cm = today.slice(0, 7);
        const NOW = new Date().toISOString().replace('T', ' ').slice(0, 19);

        // أرشفة كل المناوبات النشطة المنسوخة ثم مناوبة نشطة واحدة لليوم (صباحية)
        dbw.prepare("UPDATE shifts SET status = 'archived' WHERE status = 'active'").run();
        const SHIFT_ID = STAMP;
        dbw.prepare(`INSERT INTO shifts (id, shift_name, shift_date, shift_time, shift_type, start_time, status, created_at, updated_at)
                     VALUES (?, ?, ?, '06:00:00', 'صباح', ?, 'active', ?, ?)`)
            .run(SHIFT_ID, 'صباح - ' + today, today, new Date().toISOString(), NOW, NOW);

        // الموظفون: أحمد+محمد مجدولان على T1 · خالد+سالم على T2 · فهد ووجدي بلا جدولة (تفعيل/تعارض)
        const PEOPLE = [
            { u: 'OA01', name: 'أحمد عامر التجريبي', team: T1 },
            { u: 'OA02', name: 'محمد عامر التجريبي', team: T1 },
            { u: 'OA03', name: 'خالد عامر التجريبي', team: T2 },
            { u: 'OA04', name: 'سالم عامر التجريبي', team: T2 },
            { u: 'OA05', name: 'فهد عامر التجريبي', team: null },
            { u: 'OA06', name: 'وجدي عامر التجريبي', team: null }
        ];
        const hash = bcrypt.hashSync('test1234', 10);
        const usersPath = path.join(TMP_DIR, 'users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        for (const p of PEOPLE) users.push({ id: 'emp-' + p.u, username: p.u, name: p.name, password: hash, role: 'user', isActive: true });
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
        const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
        const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
        const insRoster = dbw.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
        for (const p of PEOPLE) {
            const eid = insEmp.run(p.u, p.name, 'فني اسعاف').lastInsertRowid;
            insPerm.run('emp-' + p.u, 'ops.my_portal');
            if (p.team) insRoster.run(eid, p.team.id, today, 'D12', +cm.slice(5), +cm.slice(0, 4), NOW, NOW);
        }

        // أحداث staffing — entity_id = الاسم التام · team_id = اسم الفرقة (نمط المنصة)
        let evSeq = 0;
        const insEvent = dbw.prepare(`INSERT INTO operational_events
            (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, event_type, reason, payload, actor_id, actor_name, created_at)
            VALUES (?, ?, 'صباح', 'staffing', ?, ?, ?, ?, ?, ?, 'test', 'اختبار', ?)`);
        function addEvent(personName, teamName, type, payloadObj, reason) {
            const iso = new Date(Date.now() + (evSeq++) * 1000).toISOString();
            const info = insEvent.run(SHIFT_ID, today, personName, personName, teamName, type,
                reason || null, payloadObj ? JSON.stringify(payloadObj) : null, iso);
            return info.lastInsertRowid;
        }

        console.log('🧪 خادم معزول على ' + PORT + ' — التكليف التشغيلي الفعلي | اليوم: ' + today + ' shift=' + SHIFT_ID);
        const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', NODE_PATH: path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES };
        server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
        check('0) الخادم المعزول أقلع بمناوبة نشطة لليوم', await waitReady());

        const tok = {};
        for (const p of PEOPLE) tok[p.u] = await login(p.u);
        check('0أ) دخول الخمسة', PEOPLE.every(p => !!tok[p.u]));

        // 1) خط الأساس: محمد مجدول على T1 بلا أحداث ← roster
        let r = await postLoc(tok.OA02);
        check('1) مجدول بلا أحداث ← 200 على فرقة جدولته (source=roster)',
            r.status === 200 && r.body && r.body.applied === true && r.body.teamId === T1.id && r.body.source === 'roster',
            JSON.stringify(r.body));

        // 2) سيناريو المالك: أحمد غائب ← مرفوض
        addEvent('أحمد عامر التجريبي', T1.name, 'absence', null, 'اختبار غياب');
        r = await postLoc(tok.OA01);
        check('2) غياب مفتوح ← 422 ABSENT_TODAY (الغائب لا يمثل موقع الفرقة)',
            r.status === 422 && r.body && r.body.code === 'ABSENT_TODAY', JSON.stringify(r.body));

        // 3) خالد بديل بإسناد مفتوح إلى T1 ← يُقبل على T1 رغم أن جدولته T2
        addEvent('خالد عامر التجريبي', T1.name, 'assignment', { coverageType: 'temporary_assignment' });
        r = await postLoc(tok.OA03);
        check('3) بديل بإسناد مفتوح ← 200 على فرقة الإسناد (source=assignment_event)',
            r.status === 200 && r.body && r.body.applied === true && r.body.teamId === T1.id && r.body.source === 'assignment_event',
            JSON.stringify(r.body));

        // 4) الغياب أعلى من الإسناد: بديل غائب ← مرفوض
        addEvent('خالد عامر التجريبي', T1.name, 'absence', null, 'اختبار');
        r = await postLoc(tok.OA03);
        check('4) بديل عليه غياب مفتوح ← 422 ABSENT_TODAY (الغياب أعلى أولوية)',
            r.status === 422 && r.body && r.body.code === 'ABSENT_TODAY', JSON.stringify(r.body));

        // 5) arrival يغلق غياب خالد ← يعود مؤهلًا على فرقة إسناده
        addEvent('خالد عامر التجريبي', T1.name, 'arrival', null);
        r = await postLoc(tok.OA03);
        check('5) arrival يغلق الغياب ← البديل يعود 200 على فرقة الإسناد',
            r.status === 200 && r.body && r.body.teamId === T1.id && r.body.source === 'assignment_event',
            JSON.stringify(r.body));

        // 6) correction absence_void يلغي غياب أحمد المستهدف ← يعود مؤهلًا
        const absId = dbw.prepare("SELECT id FROM operational_events WHERE event_type='absence' AND entity_id='أحمد عامر التجريبي' ORDER BY id DESC LIMIT 1").get().id;
        addEvent('أحمد عامر التجريبي', T1.name, 'correction', { corrects: 'absence_void', targetEventId: absId, source: 'test' });
        r = await postLoc(tok.OA01);
        check('6) correction absence_void ← الغياب الملغى لا يحجب (200 roster)',
            r.status === 200 && r.body && r.body.teamId === T1.id && r.body.source === 'roster',
            JSON.stringify(r.body));

        // 7) support_end يغلق إسناد خالد ← يعود لفرقة جدولته T2
        addEvent('خالد عامر التجريبي', T1.name, 'support_end', null);
        r = await postLoc(tok.OA03);
        check('7) support_end يغلق الإسناد ← خالد يعود لفرقة جدولته T2 (roster)',
            r.status === 200 && r.body && r.body.teamId === T2.id && r.body.source === 'roster',
            JSON.stringify(r.body));

        // 8) تعارض حقيقي: وجدي (بلا جدولة) بإسنادين مفتوحين إلى T1 وT2 معًا ←
        //    داعم فعلي في فرقتين ميدانيتين = تكليفان متعارضان ← رفض بلا تخمين.
        //    (ملاحظة فحص: المجدول المُسند لفرقة أخرى يُرفع من effectiveRoster
        //     فرقته الأساسية أصلًا، فالازدواج الحقيقي يأتي من دعمين واردين.)
        addEvent('وجدي عامر التجريبي', T1.name, 'assignment', { coverageType: 'temporary_assignment', employeeNumber: 'OA06' });
        addEvent('وجدي عامر التجريبي', T2.name, 'assignment', { coverageType: 'temporary_assignment', employeeNumber: 'OA06' });
        r = await postLoc(tok.OA06);
        check('8) إسنادان مفتوحان لفرقتين ميدانيتين ← 422 CONFLICTING_ASSIGNMENT (رفض بلا تخمين)',
            r.status === 422 && r.body && r.body.code === 'CONFLICTING_ASSIGNMENT', JSON.stringify(r.body));
        addEvent('وجدي عامر التجريبي', T1.name, 'support_end', null); // إغلاق الإسنادين
        addEvent('وجدي عامر التجريبي', T2.name, 'support_end', null);

        // 9) exit مفتوح = غياب ← 422 · return يغلقه ← يعود مؤهلًا
        addEvent('محمد عامر التجريبي', T1.name, 'exit', null, 'خروج اختبار');
        r = await postLoc(tok.OA02);
        check('9أ) exit مفتوح ← 422 ABSENT_TODAY (قرار 4)', r.status === 422 && r.body && r.body.code === 'ABSENT_TODAY',
            JSON.stringify(r.body));
        addEvent('محمد عامر التجريبي', T1.name, 'return', null);
        r = await postLoc(tok.OA02);
        check('9ب) return يغلق exit ← يعود 200 على فرقته', r.status === 200 && r.body && r.body.teamId === T1.id,
            JSON.stringify(r.body));

        // 10) activation مفتوح = إسناد: فهد (بلا جدولة أصلًا) مفعَّل على T1 ← يُقبل عليها
        addEvent('فهد عامر التجريبي', T1.name, 'activation', { employeeNumber: 'OA05' });
        r = await postLoc(tok.OA05);
        check('10) activation مفتوح ← المفعَّل يرسل على فرقة تفعيله رغم غيابه من الجدولة (قرار 5)',
            r.status === 200 && r.body && r.body.teamId === T1.id && r.body.source === 'assignment_event',
            JSON.stringify(r.body));

        // 11) لا مناوبة نشطة ← الجدولة فقط (قرار 3)
        dbw.prepare("UPDATE shifts SET status = 'archived' WHERE id = ?").run(SHIFT_ID);
        r = await postLoc(tok.OA02);
        check('11) أرشفة المناوبة ← جدولة فقط: محمد 200 roster رغم أحداثه السابقة',
            r.status === 200 && r.body && r.body.teamId === T1.id && r.body.source === 'roster',
            JSON.stringify(r.body));
        r = await postLoc(tok.OA05);
        check('12) بلا مناوبة نشطة: المفعَّل غير المجدول ← 422 NO_FIELD_ASSIGNMENT (لا تخمين أحداث مناوبة أخرى)',
            r.status === 422 && r.body && r.body.code === 'NO_FIELD_ASSIGNMENT', JSON.stringify(r.body));

        // 13) الصدق التخزيني: المحاولات المرفوضة لم تُنشئ صفوفًا لفرق بأيدي محجوبين
        const rowsT2 = dbw.prepare('SELECT COUNT(*) c FROM team_live_locations WHERE team_id = ?').get(T2.id);
        check('13) صف T2 الوحيد من إرسال خالد الشرعي بعد عودته (لا كتابة أثناء الحجب)',
            rowsT2.c === 1, JSON.stringify(rowsT2));

        dbw.close();
    } catch (e) {
        check('سير الاختبار بلا استثناء', false, e.message);
    }

    console.log('');
    console.log('════════════════ التكليف التشغيلي الفعلي: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    if (server) server.kill();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    for (const p of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(p); } catch (_) { } }
    process.exit(failed ? 1 : 0);
})();
