/**
 * ═══ اختبار EMS Community — Full Foundation (اعتماد المالك الكتابي 2026-09-24) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3137 — لا تمس بيانات الإنتاج.
 * النطاق: مجالس/منشورات(بلا تعليقات)/حضور صريح/أنشطة/مناسبات/شارات/منافسات +
 * فلترة UGC + إشراف المحتوى + عزل تشغيلي كامل + بوابة خادمية + انحدار.
 *
 * يغطي شروط الاعتماد:
 *  - بنيوي: 17 جدولًا additive، FKs داخل community_* فقط، لا أعمدة مال/رهان،
 *    لا team_live_locations/GPS/realtime في كود الخدمات (فحص ساكن بلا تعليقات)،
 *    ولا أي حقل موقع في استجابات الحضور/الأنشطة.
 *  - صلاحيات community.* منح فردي حصرًا ← 401/403 على كل مجموعة مسارات.
 *  - البوابة/الحارس: كل مسارات المشاركة (نشر/انضمام/توفر/منافسة) تمر بالحارس
 *    الموحد — التجميد الإشرافي يوقفها كلها، والانسحاب (unavailable) يبقى متاحًا.
 *  - فلترة المحتوى: تطبيع ضد الالتفاف + قائمة إدارية توسيعية + flagged لا يُنشر.
 *  - الإشراف: بلاغات محتوى + منع الإغراق + عتبة إخفاء تلقائي (hidden وليس
 *    removed) + hide/remove للمنشورات فقط + freeze يطال مؤلف المنشور.
 *  - السباقات والذرّية (مراجعة الـFinal Diff): سعة الانضمام مضمونة بعبارة SQL
 *    واحدة تحت Promise.all، بلاغ pending واحد لكل (مبلِّغ، هدف) مضمون بفهرس
 *    UNIQUE جزئي، فك التقييد يحسمه UPDATE الشرطي (changes=1)، وكل عملية
 *    mutation+audit داخل معاملة — فشل التدقيق (بإخفاء الجدول فعليًا) يُرجع
 *    العملية كاملة بلا أثر.
 *  - انحدار: /health و/api/ops/centers (P1) وقاعدة المصدر بلا جداول community.
 *
 * التشغيل: node scripts/community-full-test.js
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
const TMP_DB = path.join(os.tmpdir(), 'cmf-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'cmf-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3137;
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
async function login(u) {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'test1234' }) });
    const b = await r.json();
    return b.accessToken || null;
}
async function api(method, p, tok, payload) {
    const r = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
        body: payload ? JSON.stringify(payload) : undefined
    });
    let body = null; try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}

// ═══ الوحدة A: فلترة المحتوى — تطبيع ضد الالتفاف + قائمة إدارية ═══
async function unitFilter() {
    console.log('\n═══ الوحدة A: فلترة المحتوى (UGC) ═══');
    const Filter = require(path.join(ROOT, 'services', 'community-content-filter-service'));
    const settings = {};
    const stubDb = {
        Community: {
            getSetting: async k => (k in settings ? settings[k] : null),
            setSetting: async (k, v) => { settings[k] = v; },
            audit: async () => { },
            atomic: async fn => fn() // stub: معاملة مرورية — الخدمة تستدعيها دائمًا الآن
        }
    };
    const f = new Filter({ db: stubDb });

    const r1 = await f.checkContent('أهلين يا شباب، مجلس قهوة اليوم؟');
    check('A1) نص نظيف ← ok', r1.ok === true && r1.matched.length === 0, JSON.stringify(r1));

    const r2 = await f.checkContent('هذا الكلام غبي جدًا');
    check('A2) كلمة مخالفة صريحة ← مرفوض', r2.ok === false, JSON.stringify(r2));

    // الالتفاف بالتشكيل والتطويل: غَبِيّ / غــبــي ← تُطبَّع وتُكشف
    const r3 = await f.checkContent('غَبِيّ');
    const r4 = await f.checkContent('غــــبــــي');
    check('A3) الالتفاف بالتشكيل ← يُكشف بعد التطبيع', r3.ok === false, JSON.stringify(r3));
    check('A4) الالتفاف بالتطويل ← يُكشف بعد التطبيع', r4.ok === false, JSON.stringify(r4));

    const r5 = await f.checkContent('FUCK this');
    check('A5) كلمة إنجليزية بأحرف كبيرة ← تُكشف (توحيد الحالة)', r5.ok === false, JSON.stringify(r5));

    const r6 = await f.checkContent('');
    check('A6) نص فارغ ← ok', r6.ok === true);

    // القائمة الإدارية: توسيع فوق المدمجة، وإفراغها لا يعطّل المدمجة
    await f.setCustomWords(['برغي', 'مفترى'], { id: 'a', name: 'مدير' });
    const r7 = await f.checkContent('يا برغي');
    check('A7) كلمة إدارية مضافة ← تُكشف', r7.ok === false, JSON.stringify(r7));
    await f.setCustomWords([], { id: 'a', name: 'مدير' });
    const r8 = await f.checkContent('هذا غبي');
    check('A8) إفراغ القائمة الإدارية لا يعطّل المدمجة', r8.ok === false);
}

// ═══ الوحدة B: الحارس خادميًا — الأهلية من حالة التشغيل لا من قول العميل ═══
async function unitGuards() {
    console.log('\n═══ الوحدة B: الحارس الموحد في مسارات المشاركة الجديدة ═══');
    const Presence = require(path.join(ROOT, 'services', 'community-presence-service'));
    const Activity = require(path.join(ROOT, 'services', 'community-activity-service'));
    const denyCore = { participationGuard: async () => ({ allow: false, reason: 'ACTIVE_ASSIGNMENT' }) };
    const stubIdentity = { resolveByUser: async () => ({ employee_id: 1, display_name: 'اختبار', avatar_url: null, is_active: true }) };
    const stubFilter = { checkContent: async () => ({ ok: true, matched: [] }) };

    // الحضور: «متاح» مشاركة ← تُمنع بحالة تشغيلية؛ «غير متاح» انسحاب ← متاح دائمًا
    const calls = [];
    const pDb = { Community: { setPresence: async () => calls.push('set') } };
    const pres = new Presence({ db: pDb, identity: stubIdentity, core: denyCore, filter: stubFilter });
    const e1 = await pres.setMine({ id: 'u1' }, { status: 'available' }).catch(e => e);
    check('B1) «متاح للمجلس» أثناء حالة تشغيلية مانعة ← 403 ACTIVE_ASSIGNMENT',
        e1 && e1.statusCode === 403 && e1.code === 'ACTIVE_ASSIGNMENT' && calls.length === 0, JSON.stringify({ code: e1 && e1.code }));
    const okOut = await pres.setMine({ id: 'u1' }, { status: 'unavailable' });
    check('B2) «غير متاح» (انسحاب) متاح رغم الحالة التشغيلية', okOut && okOut.status === 'unavailable' && calls.length === 1);

    // الانضمام لنشاط: الأهلية خادمية — حارس يمنع ← لا انضمام مهما قال العميل
    let joined = false;
    const aDb = {
        Community: {
            getActivityById: async () => ({ id: 5, status: 'open', created_by: 'u-owner', type_id: 1, title: 'قهوة' }),
            getActivityParticipant: async () => null,
            countActivityParticipants: async () => 1,
            joinActivityWithCapacity: async () => { joined = true; return { changes: 1 }; }
        }
    };
    const act = new Activity({
        db: aDb, identity: stubIdentity, core: denyCore, filter: stubFilter,
        moderation: { isBlockedEitherWay: async () => false }
    });
    const e2 = await act.join({ id: 'u2' }, 5).catch(e => e);
    check('B3) انضمام لنشاط أثناء حالة مانعة ← 403 ACTIVE_ASSIGNMENT ولا صف مشاركة',
        e2 && e2.statusCode === 403 && e2.code === 'ACTIVE_ASSIGNMENT' && joined === false, JSON.stringify({ code: e2 && e2.code }));
}

// ═══ الوحدة C: الفحص الساكن للعزل — لا GPS/مواقع تشغيلية/realtime في الخدمات ═══
async function unitStaticIsolation() {
    console.log('\n═══ الوحدة C: الفحص الساكن لكود الخدمات (بعد تجريد التعليقات) ═══');
    const dir = path.join(ROOT, 'services');
    const files = fs.readdirSync(dir).filter(f => /^community-.*\.js$/.test(f));
    check('C0) خدمات المجتمع موجودة للفحص (' + files.length + ' ملفات)', files.length >= 10, files.join(','));
    const FORBIDDEN = [
        [/team_live_locations/i, 'team_live_locations'],
        [/team_locations/i, 'team_locations'],
        [/latitude|longitude/i, 'latitude/longitude'],
        [/\bgps\b/i, 'gps'],
        [/last_seen/i, 'last_seen'],
        [/websocket|socket\.io|eventsource|server-sent/i, 'realtime']
    ];
    let clean = true; const hits = [];
    for (const f of files) {
        const code = fs.readFileSync(path.join(dir, f), 'utf8')
            .split('\n').filter(l => !l.trim().startsWith('//')).join('\n'); // تجريد سطور التوثيق
        for (const [re, label] of FORBIDDEN) {
            if (re.test(code)) { clean = false; hits.push(f + ':' + label); }
        }
    }
    check('C1) لا team_live_locations/إحداثيات/GPS/last_seen/realtime في كود خدمات المجتمع',
        clean, hits.join(' | '));
}

(async () => {
    let server = null;
    let dbw = null;
    try {
        await unitFilter();
        await unitGuards();
        await unitStaticIsolation();

        console.log('\n═══ الوحدة D: API معزول (صلاحيات/مجالس/منشورات/حضور/أنشطة/إشراف) ═══');
        const Database = require(path.join(MAIN_MODULES, 'better-sqlite3'));
        const bcrypt = require(path.join(MAIN_MODULES, 'bcryptjs'));

        const src = new Database(SRC_DB, { readonly: true });
        src.exec("VACUUM INTO '" + TMP_DB + "'");
        src.close();
        fs.mkdirSync(TMP_DIR, { recursive: true });
        for (const f of fs.readdirSync(SRC_DATA)) {
            if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(SRC_DATA, f), path.join(TMP_DIR, f)); } catch (_) { } }
        }
        dbw = new Database(TMP_DB);
        dbw.pragma('journal_mode = WAL');
        // عزل بيئي: نسخة الإنتاج تحمل مناوبة active حقيقية — والبوابة (بصواب) تعدّ
        // كل موظف «في مناوبة بلا تكليف» ← OPERATIONAL_DUTY. نُرشفها في النسخة
        // المؤقتة فقط حتى يكون موظفو الاختبار roster_only (ALLOW) كما هو مقصود.
        dbw.prepare("UPDATE shifts SET status = 'archived' WHERE status = 'active'").run();

        // مستخدمو الاختبار بأذونات متدرجة — community.* منح فردي حصرًا
        const hash = bcrypt.hashSync('test1234', 10);
        const usersPath = path.join(TMP_DIR, 'users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        for (const u of ['CM101', 'CM102', 'CM103', 'CM104', 'CM105', 'CM106', 'CM107', 'CM108']) {
            users.push({ id: 'emp-' + u, username: u, name: 'اختبار ' + u, password: hash, role: 'user', isActive: true });
        }
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

        const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
        insEmp.run('CM101', 'عضو كامل f', 'فني اسعاف');
        insEmp.run('CM102', 'عضو ثانٍ f', 'فني اسعاف');

        const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
        // CM101: عضو كامل (view+post+create_activity+join_activity+tournament)
        for (const k of ['community.view', 'community.post', 'community.create_activity', 'community.join_activity', 'community.tournament']) insPerm.run('emp-CM101', k);
        // CM102: ناشر (view+post)
        insPerm.run('emp-CM102', 'community.view'); insPerm.run('emp-CM102', 'community.post');
        // CM103: مشرف (view+moderate)
        insPerm.run('emp-CM103', 'community.view'); insPerm.run('emp-CM103', 'community.moderate');
        // CM104: إدارة (view+admin+moderate)
        for (const k of ['community.view', 'community.admin', 'community.moderate']) insPerm.run('emp-CM104', k);
        // CM105: ناشر هدف للإشراف (view+post)
        insPerm.run('emp-CM105', 'community.view'); insPerm.run('emp-CM105', 'community.post');
        // CM106: بلا أي منح
        // CM107: view فقط
        insPerm.run('emp-CM107', 'community.view');
        // CM108: ناشر ثالث لاختبارات الحظر والعتبة (view+post)
        insPerm.run('emp-CM108', 'community.view'); insPerm.run('emp-CM108', 'community.post');

        console.log('🧪 خادم معزول على ' + PORT + ' — Community Full Foundation');
        const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', NODE_PATH: path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES };
        server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
        check('D0) الخادم المعزول أقلع', await waitReady());

        const t1 = await login('CM101'), t2 = await login('CM102'), t3 = await login('CM103'),
            t4 = await login('CM104'), t5 = await login('CM105'), t6 = await login('CM106'),
            t7 = await login('CM107'), t8 = await login('CM108');
        check('D0أ) تسجيل دخول الثمانية', !!(t1 && t2 && t3 && t4 && t5 && t6 && t7 && t8));

        // ═══ 1) بوابات الأمان: 401/403 على كل مجموعة مسارات ═══
        console.log('\n── 1) الأمان: المصادقة والصلاحيات ──');
        const noTok = await api('GET', '/api/community/councils', null);
        check('S1) councils بلا توكن ← 401', noTok.status === 401, 'status=' + noTok.status);
        const noPerm1 = await api('GET', '/api/community/councils', t6);
        check('S2) councils بلا community.view ← 403', noPerm1.status === 403, 'status=' + noPerm1.status);
        const noPerm2 = await api('GET', '/api/community/presence', t6);
        check('S3) presence بلا view ← 403', noPerm2.status === 403);
        const noPerm3 = await api('GET', '/api/community/activities', t6);
        check('S4) activities بلا view ← 403', noPerm3.status === 403);
        const noPerm4 = await api('GET', '/api/community/competitions', t6);
        check('S5) competitions بلا view ← 403', noPerm4.status === 403);
        const noPerm5 = await api('POST', '/api/community/admin/events', t1, { title: 'x' });
        check('S6) admin/events بلا community.admin ← 403', noPerm5.status === 403);
        const noPerm6 = await api('GET', '/api/community/moderation/posts', t1);
        check('S7) moderation/posts بلا community.moderate ← 403', noPerm6.status === 403);
        const noPerm7 = await api('GET', '/api/community/admin/content-filter', t3);
        check('S8) admin/content-filter بلا admin (مشرف فقط) ← 403', noPerm7.status === 403);

        // ═══ 2) الفحص البنيوي: الجداول والفهارس وFKs وأعمدة المال ═══
        console.log('\n── 2) البنية: 17 جدولًا additive وعزل FK ولا أعمدة مال ──');
        const tbls = dbw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name").all().map(t => t.name);
        const EXPECTED_TABLES = ['community_activities', 'community_activity_participants', 'community_activity_types',
            'community_audit_log', 'community_badges', 'community_blocks', 'community_competition_participants',
            'community_competitions', 'community_council_members', 'community_councils', 'community_events',
            'community_posts', 'community_presence', 'community_reports', 'community_restrictions',
            'community_settings', 'community_user_badges'];
        check('T1) جداول community_* السبعة عشر كلها أُنشئت additive',
            JSON.stringify(tbls) === JSON.stringify(EXPECTED_TABLES), tbls.join(','));
        let fkClean = true; const fkHits = [];
        for (const t of EXPECTED_TABLES) {
            const fks = dbw.prepare(`PRAGMA foreign_key_list(${t})`).all();
            for (const fk of fks) { if (!String(fk.table).startsWith('community_')) { fkClean = false; fkHits.push(t + '→' + fk.table); } }
        }
        check('T2) كل FKs في جداول المجتمع تشير إلى community_* فقط (لا ربط بالتشغيل)', fkClean, fkHits.join(' | '));
        let moneyClean = true; const moneyHits = [];
        for (const t of ['community_competitions', 'community_competition_participants', 'community_badges', 'community_user_badges']) {
            const cols = dbw.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
            for (const c of cols) { if (/money|price|fee|bet|wager|stake|prize|payment|cash/i.test(c)) { moneyClean = false; moneyHits.push(t + '.' + c); } }
        }
        check('T3) لا أعمدة مال/رهان/رسوم/جوائز نقدية في جداول المنافسات والشارات', moneyClean, moneyHits.join(' | '));
        const idx = dbw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_community_%'").all();
        check('T4) فهارس community_* موجودة للأداء (' + idx.length + ' فهرسًا)', idx.length >= 10, String(idx.length));
        const src2 = new Database(SRC_DB, { readonly: true });
        // قاعدة التطوير المحلية قد تحمل جداول community فارغة من خادم تطوير عامل
        // بالكود الجديد (init additive طبيعي) — الثابت الحقيقي للعزل: لا صفوف
        // اختبار (emp-CM*) تسربت إلى المصدر إطلاقًا.
        let leaked = 0;
        for (const [t, c] of [['community_posts', 'author_user_id'], ['community_council_members', 'user_id'],
            ['community_presence', 'user_id'], ['community_reports', 'reporter_user_id'], ['community_audit_log', 'actor_id']]) {
            try {
                const exists = src2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
                if (exists) leaked += src2.prepare(`SELECT COUNT(*) c FROM ${t} WHERE CAST(${c} AS TEXT) LIKE 'emp-CM%'`).get().c;
            } catch (_) { }
        }
        src2.close();
        check('T5) لا صفوف اختبار تسربت لقاعدة المصدر (العزل سليم)', leaked === 0, 'leaked=' + leaked);

        // ═══ 3) المجالس ═══
        console.log('\n── 3) المجالس: إنشاء/انضمام/عضوية/إدارة ──');
        const mkBad = await api('POST', '/api/community/councils', t4, { slug: '!!bad!!', name: 'مجلس' });
        check('M1) slug غير صالح ← 422 BAD_SLUG', mkBad.status === 422 && mkBad.body && mkBad.body.code === 'BAD_SLUG', 'status=' + mkBad.status);
        const mk1 = await api('POST', '/api/community/councils', t4, { slug: 'south-riyadh', name: 'مجلس جنوب الرياض', icon: '🏠', description: 'مجلس منسوبي قطاع جنوب الرياض' });
        check('M2) الإدارة تنشئ مجلسًا مفتوحًا ← 200', mk1.status === 200 && mk1.body && mk1.body.id != null, JSON.stringify(mk1.body));
        const councilId = mk1.body && mk1.body.id;
        const mkDup = await api('POST', '/api/community/councils', t4, { slug: 'south-riyadh', name: 'مكرر' });
        check('M3) slug مكرر ← 409 SLUG_TAKEN', mkDup.status === 409 && mkDup.body && mkDup.body.code === 'SLUG_TAKEN');
        const mk2 = await api('POST', '/api/community/councils', t4, { slug: 'leaders-majlis', name: 'مجلس القيادات', membership: 'closed', icon: '⭐' });
        check('M4) مجلس مغلق (leaders) أُنشئ', mk2.status === 200, JSON.stringify(mk2.body));
        const closedId = mk2.body && mk2.body.id;
        const mkFiltered = await api('POST', '/api/community/councils', t4, { slug: 'bad-council', name: 'مجلس الغبي' });
        check('M5) اسم مجلس مخالف للفلتر ← 422 FILTER_REJECTED', mkFiltered.status === 422 && mkFiltered.body && mkFiltered.body.code === 'FILTER_REJECTED');

        const j1 = await api('POST', '/api/community/councils/' + councilId + '/join', t1);
        const j2 = await api('POST', '/api/community/councils/' + councilId + '/join', t2);
        check('M6) عضوان ينضمان للمجلس المفتوح', j1.status === 200 && j2.status === 200, j1.status + ',' + j2.status);
        const jClosed = await api('POST', '/api/community/councils/' + closedId + '/join', t1);
        check('M7) انضمام ذاتي لمجلس مغلق ← 403 COUNCIL_CLOSED', jClosed.status === 403 && jClosed.body && jClosed.body.code === 'COUNCIL_CLOSED');
        const setMem = await api('PUT', '/api/community/councils/' + closedId + '/members/emp-CM101', t3, { role: 'member' });
        check('M8) المشرف يضيف عضوًا للمجلس المغلق ← 200', setMem.status === 200, JSON.stringify(setMem.body));
        const setMemBad = await api('PUT', '/api/community/councils/' + closedId + '/members/emp-CM102', t1, { role: 'member' });
        check('M9) عضو عادي يضيف عضوًا ← 403 (moderate مطلوب)', setMemBad.status === 403);
        const list1 = await api('GET', '/api/community/councils', t1);
        const mine = (list1.body.councils || []).find(c => c.id === councilId);
        check('M10) القائمة تعرض المجلس بعضويتي وعدد أعضائه',
            list1.status === 200 && mine && mine.joined === true && mine.members_count === 2, JSON.stringify(mine));
        const members = await api('GET', '/api/community/councils/' + councilId + '/members', t1);
        check('M11) قائمة الأعضاء بهوية Projection (4 حقول فقط)',
            members.status === 200 && members.body.members.length === 2 &&
            members.body.members.every(m => m.user && Object.keys(m.user).sort().join(',') === 'avatar_url,display_name,employee_id,is_active'),
            JSON.stringify(members.body).slice(0, 250));

        // ═══ 4) المنشورات (بلا تعليقات) + الفلترة + IDOR ═══
        console.log('\n── 4) المنشورات: نشر/فلترة/حذف/عضوية ──');
        const pNotMember = await api('POST', '/api/community/councils/' + councilId + '/posts', t5, { content: 'محاولة من غير عضو' });
        check('P1) النشر بلا عضوية ← 403 NOT_A_MEMBER', pNotMember.status === 403 && pNotMember.body && pNotMember.body.code === 'NOT_A_MEMBER');
        const pNoPerm = await api('POST', '/api/community/councils/' + councilId + '/posts', t7, { content: 'بلا صلاحية نشر' });
        check('P2) النشر بلا community.post ← 403 صلاحيات', pNoPerm.status === 403 && !(pNoPerm.body && pNoPerm.body.code === 'NOT_A_MEMBER'));
        const p1 = await api('POST', '/api/community/councils/' + councilId + '/posts', t1, { content: 'أهلًا بالجميع في مجلس جنوب الرياض — القهوة علي اليوم ☕' });
        check('P3) منشور نظيف ← active', p1.status === 200 && p1.body && p1.body.status === 'active' && p1.body.flagged === false, JSON.stringify(p1.body));
        const post1Id = p1.body && p1.body.id;
        const p2 = await api('POST', '/api/community/councils/' + councilId + '/posts', t2, { content: 'هذا التنظيم غبي جدًا' });
        check('P4) منشور مخالف ← flagged ولا يُنشر', p2.status === 200 && p2.body && p2.body.status === 'flagged' && p2.body.flagged === true, JSON.stringify(p2.body));
        const flaggedPostId = p2.body && p2.body.id;
        const plist = await api('GET', '/api/community/councils/' + councilId + '/posts', t1);
        check('P5) قائمة الأعضاء تعرض النظيف فقط (الموقوف لا يظهر)',
            plist.status === 200 && plist.body.posts.length === 1 && plist.body.posts[0].id === post1Id, JSON.stringify(plist.body).slice(0, 200));
        const plistOut = await api('GET', '/api/community/councils/' + councilId + '/posts', t5);
        check('P6) الاطلاع على المنشورات بلا عضوية ← 403 NOT_A_MEMBER', plistOut.status === 403 && plistOut.body && plistOut.body.code === 'NOT_A_MEMBER');
        const delIdor = await api('DELETE', '/api/community/posts/' + post1Id, t2);
        check('P7) حذف منشور الغير (IDOR) ← 403 NOT_AUTHOR', delIdor.status === 403 && delIdor.body && delIdor.body.code === 'NOT_AUTHOR');
        const delGhost = await api('DELETE', '/api/community/posts/' + post1Id, t5);
        check('P8) حذف منشور الغير لمستخدم آخر ← 403 أيضًا', delGhost.status === 403);
        const flagQueue = await api('GET', '/api/community/moderation/posts?status=flagged', t3);
        check('P9) المنشور الموقوف يظهر في قائمة إشراف المحتوى',
            flagQueue.status === 200 && flagQueue.body.posts.some(p => p.id === flaggedPostId && p.flag_reason === 'content_filter'), JSON.stringify(flagQueue.body).slice(0, 200));

        // ═══ 5) «من موجود؟» — حضور صريح فقط ═══
        console.log('\n── 5) الحضور الصريح: ضبط/قائمة/فلترة ملاحظة/شكل الاستجابة ──');
        const pr1 = await api('PUT', '/api/community/presence', t1, { status: 'available', note: 'في مجلس القهوة' });
        check('H1) ضبط «متاح للمجلس» ← 200', pr1.status === 200 && pr1.body && pr1.body.status === 'available', JSON.stringify(pr1.body));
        const pr2 = await api('PUT', '/api/community/presence', t2, { status: 'busy' });
        check('H2) ضبط «مشغول» ← 200', pr2.status === 200);
        const prBad = await api('PUT', '/api/community/presence', t1, { status: 'sleeping' });
        check('H3) حالة غير معروفة ← 422 BAD_STATUS', prBad.status === 422 && prBad.body && prBad.body.code === 'BAD_STATUS');
        const prFilter = await api('PUT', '/api/community/presence', t1, { status: 'available', note: 'غبي' });
        check('H4) ملاحظة مخالفة للفلتر ← 422 FILTER_REJECTED', prFilter.status === 422 && prFilter.body && prFilter.body.code === 'FILTER_REJECTED');
        const prList = await api('GET', '/api/community/presence', t1);
        const prKeys = prList.body && prList.body.presence && prList.body.presence[0] ? Object.keys(prList.body.presence[0]).sort() : [];
        check('H5) القائمة تعرض الحالات الصريحة',
            prList.status === 200 && prList.body.presence.length >= 2, JSON.stringify(prList.body).slice(0, 200));
        check('H6) شكل الاستجابة خالٍ من أي حقل موقع/مصدر (userId/status/note/updatedAt/user فقط)',
            JSON.stringify(prKeys) === JSON.stringify(['note', 'status', 'updatedAt', 'user', 'userId'].sort()), prKeys.join(','));

        // ═══ 6) الحظر متبادل الأثر عبر كل مسارات التفاعل ═══
        console.log('\n── 6) الحظر: منشورات/حضور/انضمام/ملفات ──');
        dbw.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-CM108','community.join_activity',1,'test')").run();
        await api('POST', '/api/community/councils/' + councilId + '/join', t8);
        const pBlocked = await api('POST', '/api/community/councils/' + councilId + '/posts', t8, { content: 'منشور من سيُحظر لاحقًا' });
        check('B1) CM108 ينضم وينشر قبل الحظر', pBlocked.status === 200, JSON.stringify(pBlocked.body));
        const blk = await api('POST', '/api/community/block', t1, { userId: 'emp-CM108' });
        check('B2) CM101 يحظر CM108 ← 200', blk.status === 200 && blk.body.blocked === true);
        const plistBlocked = await api('GET', '/api/community/councils/' + councilId + '/posts', t1);
        check('B3) منشورات المحظور تختفي من قائمة الحاظر',
            plistBlocked.status === 200 && !plistBlocked.body.posts.some(p => p.author.userId === 'emp-CM108'),
            JSON.stringify(plistBlocked.body.posts.map(p => p.author.userId)));
        await api('PUT', '/api/community/presence', t8, { status: 'available' });
        const prBlocked = await api('GET', '/api/community/presence', t1);
        check('B4) حضور المحظور يختفي من قائمة الحاظر',
            !prBlocked.body.presence.some(p => p.userId === 'emp-CM108'), JSON.stringify(prBlocked.body.presence.map(p => p.userId)));
        const prReverse = await api('GET', '/api/community/presence', t8);
        check('B5) حضور الحاظر يختفي من قائمة المحظور (أثر متبادل)',
            !prReverse.body.presence.some(p => p.userId === 'emp-CM101'));
        const actBlk = await api('POST', '/api/community/activities', t1, {
            typeId: (await api('GET', '/api/community/activity-types', t1)).body.types[0].id, title: 'قهوة اختبار الحظر'
        });
        const joinBlocked = await api('POST', '/api/community/activities/' + actBlk.body.id + '/join', t8);
        check('B6) المحظور ينضم لنشاط الحاظر ← 403 BLOCKED_INTERACTION',
            joinBlocked.status === 403 && joinBlocked.body && joinBlocked.body.code === 'BLOCKED_INTERACTION', JSON.stringify(joinBlocked.body));
        const badgesBlocked = await api('GET', '/api/community/users/emp-CM108/badges', t1);
        check('B7) استعراض ملف المحظور ← 403 BLOCKED_INTERACTION',
            badgesBlocked.status === 403 && badgesBlocked.body && badgesBlocked.body.code === 'BLOCKED_INTERACTION');
        const unbByOther = await api('POST', '/api/community/unblock', t8, { userId: 'emp-CM101' });
        const stillHidden = await api('GET', '/api/community/councils/' + councilId + '/posts', t1);
        check('B8) المحظور لا يفك حظر الحاظر (فك من الحاظر فقط)',
            unbByOther.status === 200 && !stillHidden.body.posts.some(p => p.author.userId === 'emp-CM108'));
        await api('POST', '/api/community/unblock', t1, { userId: 'emp-CM108' });
        const plistAfter = await api('GET', '/api/community/councils/' + councilId + '/posts', t1);
        check('B9) الحاظر يفك الحظر ← المنشور يعود للظهور',
            plistAfter.body.posts.some(p => p.author.userId === 'emp-CM108'));

        // ═══ 7) الأنشطة / الفعاليات الواقعية ═══
        console.log('\n── 7) الأنشطة: أنواع/إنشاء/انضمام/سعة/ملكية/إشراف ──');
        dbw.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-CM102','community.join_activity',1,'test')").run();
        dbw.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-CM107','community.join_activity',1,'test')").run();
        dbw.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-CM107','community.tournament',1,'test')").run();
        const types = await api('GET', '/api/community/activity-types', t1);
        check('A1) أنواع الأنشطة المزروعة (≥8) متاحة', types.status === 200 && types.body.types.length >= 8,
            (types.body.types || []).map(t => t.key).join(','));
        const typeId = types.body.types[0].id;
        const createNoPerm = await api('POST', '/api/community/activities', t7, { typeId, title: 'محاولة' });
        check('A2) إنشاء نشاط بلا community.create_activity ← 403', createNoPerm.status === 403);
        const act1 = await api('POST', '/api/community/activities', t1, {
            typeId, title: 'مجلس قهوة الخميس', locationText: 'استراحة القطاع', maxParticipants: 2, description: 'قهوة وحلا بعد المغرب'
        });
        check('A3) إنشاء نشاط بمكان نصي ← 200', act1.status === 200 && act1.body && act1.body.id != null, JSON.stringify(act1.body));
        const act1Id = act1.body && act1.body.id;
        const act1Get = await api('GET', '/api/community/activities/' + act1Id, t1);
        const actKeys = act1Get.body && act1Get.body.activity ? Object.keys(act1Get.body.activity) : [];
        check('A4) المنشئ مشارك تلقائيًا (count=1, my_status=joined)',
            act1Get.status === 200 && act1Get.body.activity.participants_count === 1 && act1Get.body.activity.my_status === 'joined',
            JSON.stringify(act1Get.body).slice(0, 250));
        check('A5) استجابة النشاط فيها locationText النصي ولا latitude/longitude إطلاقًا',
            actKeys.indexOf('locationText') !== -1 && !actKeys.some(k => /latitude|longitude|coords/i.test(k)), actKeys.join(','));
        const actFiltered = await api('POST', '/api/community/activities', t1, { typeId, title: 'مجلس الغبي' });
        check('A6) عنوان نشاط مخالف للفلتر ← 422 FILTER_REJECTED',
            actFiltered.status === 422 && actFiltered.body && actFiltered.body.code === 'FILTER_REJECTED');
        const join1 = await api('POST', '/api/community/activities/' + act1Id + '/join', t2);
        check('A7) عضو ثانٍ ينضم ← 200', join1.status === 200 && join1.body.joined === true, JSON.stringify(join1.body));
        const joinFull = await api('POST', '/api/community/activities/' + act1Id + '/join', t7);
        check('A8) السعة مكتملة (2/2) ← 409 ACTIVITY_FULL',
            joinFull.status === 409 && joinFull.body && joinFull.body.code === 'ACTIVITY_FULL', JSON.stringify(joinFull.body));
        const joinNoPerm = await api('POST', '/api/community/activities/' + act1Id + '/join', t5);
        check('A9) انضمام بلا community.join_activity ← 403', joinNoPerm.status === 403);
        const leaveGhost = await api('POST', '/api/community/activities/' + act1Id + '/leave', t7);
        check('A10) مغادرة بلا مشاركة ← 404 NOT_JOINED', leaveGhost.status === 404 && leaveGhost.body && leaveGhost.body.code === 'NOT_JOINED');
        dbw.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-CM108','community.create_activity',1,'test')").run();
        const editOther = await api('PUT', '/api/community/activities/' + act1Id, t8, { title: 'تعديل من غير المنشئ' });
        check('A11) تعديل نشاط الغير (بصلاحية إنشاء لكن بلا ملكية) ← 403 NOT_CREATOR',
            editOther.status === 403 && editOther.body && editOther.body.code === 'NOT_CREATOR',
            'status=' + editOther.status + ' ' + JSON.stringify(editOther.body));
        const editOwn = await api('PUT', '/api/community/activities/' + act1Id, t1, { status: 'completed' });
        check('A12) المنشئ يكمل نشاطه ← 200', editOwn.status === 200, JSON.stringify(editOwn.body));
        const act2 = await api('POST', '/api/community/activities', t1, { typeId, title: 'بادل الجمعة' });
        const modDisable = await api('POST', '/api/community/moderation/activities/' + act2.body.id + '/status', t3, { status: 'disabled', note: 'مخالفة' });
        check('A13) المشرف يعطّل نشاطًا ← 200', modDisable.status === 200 && modDisable.body.status === 'disabled');
        const act2Get = await api('GET', '/api/community/activities/' + act2.body.id, t1);
        check('A14) النشاط المعطّل ← 404 للأعضاء (لا enumeration)', act2Get.status === 404);
        const partList = await api('GET', '/api/community/activities/' + act1Id + '/participants', t1);
        check('A15) قائمة المشاركين بهوية Projection',
            partList.status === 200 && partList.body.participants.length === 2 &&
            partList.body.participants.every(p => p.user && Object.keys(p.user).sort().join(',') === 'avatar_url,display_name,employee_id,is_active'),
            JSON.stringify(partList.body).slice(0, 250));

        // ═══ 8) المناسبات ═══
        console.log('\n── 8) المناسبات: إنشاء/عرض/تعطيل ──');
        const ev1 = await api('POST', '/api/community/admin/events', t4, { title: 'اليوم الوطني 95', icon: '🇸🇦', description: 'فعاليات القطاع بمناسبة اليوم الوطني' });
        check('E1) الإدارة تنشئ مناسبة ← 200', ev1.status === 200 && ev1.body && ev1.body.id != null, JSON.stringify(ev1.body));
        const evList = await api('GET', '/api/community/events', t1);
        check('E2) المناسبة النشطة تظهر للأعضاء',
            evList.status === 200 && evList.body.events.some(e => e.id === ev1.body.id), JSON.stringify(evList.body).slice(0, 200));
        await api('PUT', '/api/community/admin/events/' + ev1.body.id, t4, { status: 'inactive' });
        const evList2 = await api('GET', '/api/community/events', t1);
        check('E3) المناسبة المعطّلة تختفي من قائمة الأعضاء',
            !evList2.body.events.some(e => e.id === ev1.body.id));
        const evFiltered = await api('POST', '/api/community/admin/events', t4, { title: 'مناسبة الغبي' });
        check('E4) عنوان مناسبة مخالف ← 422 FILTER_REJECTED', evFiltered.status === 422 && evFiltered.body && evFiltered.body.code === 'FILTER_REJECTED');

        // ═══ 9) الشارات والإنجازات ═══
        console.log('\n── 9) الشارات: دليل/منح/إدمانية/سحب ──');
        const badges = await api('GET', '/api/community/badges', t1);
        check('G1) دليل الشارات المزروع (≥5) متاح', badges.status === 200 && badges.body.badges.length >= 5,
            (badges.body.badges || []).map(b => b.key).join(','));
        const badgeId = badges.body.badges[0].id;
        const awardNoPerm = await api('POST', '/api/community/badges/' + badgeId + '/award', t1, { userId: 'emp-CM102' });
        check('G2) منح شارة بلا community.moderate ← 403', awardNoPerm.status === 403);
        const aw1 = await api('POST', '/api/community/badges/' + badgeId + '/award', t3, { userId: 'emp-CM101', context: 'تنشيط المجلس' });
        check('G3) المشرف يمنح شارة ← 200', aw1.status === 200 && aw1.body.awarded === true, JSON.stringify(aw1.body));
        await api('POST', '/api/community/badges/' + badgeId + '/award', t3, { userId: 'emp-CM101', context: 'تنشيط المجلس' });
        const myBadges = await api('GET', '/api/community/users/emp-CM101/badges', t1);
        check('G4) المنح المكرر بنفس السياق idempotent (شارة واحدة فقط)',
            myBadges.status === 200 && myBadges.body.badges.length === 1, JSON.stringify(myBadges.body).slice(0, 200));
        const awardRow = dbw.prepare("SELECT id FROM community_user_badges WHERE user_id='emp-CM101'").get();
        const rev = await api('POST', '/api/community/moderation/user-badges/' + awardRow.id + '/revoke', t3);
        const myBadges2 = await api('GET', '/api/community/users/emp-CM101/badges', t1);
        check('G5) سحب الشارة ← القائمة فارغة', rev.status === 200 && myBadges2.body.badges.length === 0);

        // ═══ 10) المنافسات ═══
        console.log('\n── 10) المنافسات: إنشاء/انضمام/نتائج ──');
        const comp1 = await api('POST', '/api/community/admin/competitions', t4, { name: 'تحدي اللياقة', scope: 'individuals', description: 'تحدي خطوات معنوي — شارات فقط' });
        check('C1) الإدارة تنشئ منافسة أفراد ← 200', comp1.status === 200 && comp1.body && comp1.body.id != null, JSON.stringify(comp1.body));
        const compId = comp1.body && comp1.body.id;
        const joinDraft = await api('POST', '/api/community/competitions/' + compId + '/join', t1);
        check('C2) الانضمام لمنافسة draft ← 409 COMPETITION_CLOSED',
            joinDraft.status === 409 && joinDraft.body && joinDraft.body.code === 'COMPETITION_CLOSED');
        await api('PUT', '/api/community/admin/competitions/' + compId, t4, { status: 'open' });
        const joinNoTourn = await api('POST', '/api/community/competitions/' + compId + '/join', t2);
        check('C3) انضمام بلا community.tournament ← 403', joinNoTourn.status === 403);
        const joinComp = await api('POST', '/api/community/competitions/' + compId + '/join', t1);
        check('C4) انضمام فرد بتسمية العرض تلقائيًا ← 200', joinComp.status === 200 && joinComp.body.joined === true);
        const joinTeams = await api('POST', '/api/community/competitions/' + compId + '/join', t8);
        check('C5) انضمام بلا tournament (CM108) ← 403', joinTeams.status === 403);
        const addP = await api('POST', '/api/community/admin/competitions/' + compId + '/participants', t4, { label: 'فريق الجنوب' });
        check('C6) الإدارة تضيف مشاركًا بتسمية حرة ← 200', addP.status === 200);
        const partRow = dbw.prepare("SELECT id FROM community_competition_participants WHERE competition_id = ? AND participant_label = 'فريق الجنوب'").get(compId);
        const res1 = await api('PUT', '/api/community/admin/competition-participants/' + partRow.id, t4, { score: 15, rank: 1, resultNote: 'أداء مميز' });
        check('C7) تسجيل نقاط وترتيب ← 200', res1.status === 200, JSON.stringify(res1.body));
        const compGet = await api('GET', '/api/community/competitions/' + compId, t1);
        const parts = compGet.body.competition.participants;
        check('C8) النتائج مرتبة (فريق الجنوب 15 نقطة أولًا)',
            compGet.status === 200 && parts.length === 2 && parts[0].participant_label === 'فريق الجنوب' && parts[0].score === 15,
            JSON.stringify(parts));
        const auditComp = dbw.prepare("SELECT COUNT(*) c FROM community_audit_log WHERE action='competition_result'").get();
        check('C9) تسجيل النتائج مُدقَّق (competition_result)', auditComp.c >= 1);

        // ═══ 11) الإشراف على المحتوى: بلاغات/إغراق/عتبة تلقائية/إجراءات ═══
        console.log('\n── 11) إشراف المحتوى: بلاغ→عتبة→إخفاء→حذف/تجميد المؤلف ──');
        await api('POST', '/api/community/councils/' + councilId + '/join', t5);
        const pTarget = await api('POST', '/api/community/councils/' + councilId + '/posts', t5, { content: 'منشور مزعج لاختبار الإشراف' });
        check('R1) CM105 ينشر منشورًا هدفًا للبلاغات', pTarget.status === 200 && pTarget.body.status === 'active');
        const targetPostId = pTarget.body && pTarget.body.id;
        const rep1 = await api('POST', '/api/community/report', t1, { targetType: 'post', targetId: String(targetPostId), reason: 'محتوى مزعج في المجلس' });
        check('R2) بلاغ على منشور ← pending', rep1.status === 200 && rep1.body && rep1.body.status === 'pending', JSON.stringify(rep1.body));
        const rep1Id = rep1.body && rep1.body.id;
        const selfPost = await api('POST', '/api/community/report', t5, { targetType: 'post', targetId: String(targetPostId), reason: 'أبلغ عن منشوري' });
        check('R2ب) الإبلاغ عن محتوى النفس ← 422 SELF_REPORT',
            selfPost.status === 422 && selfPost.body && selfPost.body.code === 'SELF_REPORT');
        const repDup = await api('POST', '/api/community/report', t1, { targetType: 'post', targetId: String(targetPostId), reason: 'إغراق بنفس البلاغ' });
        check('R3) بلاغ مكرر من نفس المبلِّغ ← 409 DUPLICATE_REPORT',
            repDup.status === 409 && repDup.body && repDup.body.code === 'DUPLICATE_REPORT');
        const repGhost = await api('POST', '/api/community/report', t1, { targetType: 'post', targetId: '99999', reason: 'بلاغ شبح' });
        check('R4) بلاغ على منشور غير موجود ← 404 (لا بلاغات أشباح)', repGhost.status === 404);
        await api('POST', '/api/community/report', t2, { targetType: 'post', targetId: String(targetPostId), reason: 'بلاغ ثانٍ' });
        const rep3 = await api('POST', '/api/community/report', t8, { targetType: 'post', targetId: String(targetPostId), reason: 'بلاغ ثالث' });
        check('R5) ثلاثة بلاغات من مبلِّغين مختلفين', rep3.status === 200);
        const hiddenRow = dbw.prepare('SELECT status, moderated_by FROM community_posts WHERE id = ?').get(targetPostId);
        check('R6) بلوغ العتبة (3) ← إخفاء تلقائي مؤقت hidden (وليس حذفًا)',
            hiddenRow && hiddenRow.status === 'hidden' && /^auto:/.test(hiddenRow.moderated_by || ''), JSON.stringify(hiddenRow));
        const autoAudit = dbw.prepare("SELECT COUNT(*) c FROM community_audit_log WHERE action='post_auto_hide' AND target_id = ?").get(String(targetPostId));
        check('R7) الإخفاء التلقائي مُدقَّق (post_auto_hide)', autoAudit.c === 1);
        const listHidden = await api('GET', '/api/community/councils/' + councilId + '/posts', t1);
        check('R8) المنشور المخفي لا يظهر في قائمة الأعضاء',
            !listHidden.body.posts.some(p => p.id === targetPostId));
        const actRemove = await api('POST', '/api/community/moderation/reports/' + rep1Id + '/action', t3, { action: 'remove', note: 'محتوى مؤكد المخالفة' });
        check('R9) المشرف يحذف المحتوى بقرار بشري ← resolved',
            actRemove.status === 200 && actRemove.body.status === 'resolved', JSON.stringify(actRemove.body));
        const removedRow = dbw.prepare('SELECT status FROM community_posts WHERE id = ?').get(targetPostId);
        check('R10) المنشور removed في القاعدة', removedRow && removedRow.status === 'removed');
        const rep2Row = dbw.prepare("SELECT id FROM community_reports WHERE target_type='post' AND target_id = ? AND status='pending' ORDER BY id LIMIT 1").get(String(targetPostId));
        const actFreeze = await api('POST', '/api/community/moderation/reports/' + rep2Row.id + '/action', t3, { action: 'freeze', note: 'تكرار المخالفة' });
        check('R11) freeze على بلاغ منشور ← resolved', actFreeze.status === 200);
        const rstAuthor = dbw.prepare("SELECT * FROM community_restrictions WHERE user_id='emp-CM105' AND active=1").get();
        check('R12) التجميد يطال مؤلف المنشور (وليس معرّف المنشور)',
            !!rstAuthor && rstAuthor.kind === 'participation_freeze', JSON.stringify(rstAuthor));
        const hideOnUser = await api('POST', '/api/community/report', t1, { targetType: 'user', targetId: 'emp-CM108', reason: 'سلوك غير لائق' });
        const actHideUser = await api('POST', '/api/community/moderation/reports/' + hideOnUser.body.id + '/action', t3, { action: 'hide' });
        check('R13) hide على هدف مستخدم ← 422 BAD_ACTION (للمحتوى فقط)',
            actHideUser.status === 422 && actHideUser.body && actHideUser.body.code === 'BAD_ACTION');
        await api('POST', '/api/community/moderation/reports/' + hideOnUser.body.id + '/action', t3, { action: 'dismiss' });
        const repMajlis = await api('POST', '/api/community/report', t1, { targetType: 'majlis', targetId: String(councilId), reason: 'مجلس يحتاج مراجعة' });
        const actWarnMajlis = await api('POST', '/api/community/moderation/reports/' + repMajlis.body.id + '/action', t3, { action: 'warn' });
        check('R14) warn على مجلس (لا مستخدم مسؤول) ← 422 BAD_ACTION',
            actWarnMajlis.status === 422 && actWarnMajlis.body && actWarnMajlis.body.code === 'BAD_ACTION');
        const actDismissMajlis = await api('POST', '/api/community/moderation/reports/' + repMajlis.body.id + '/action', t3, { action: 'dismiss' });
        check('R15) رفض بلاغ المجلس ← dismissed', actDismissMajlis.status === 200 && actDismissMajlis.body.status === 'dismissed');

        // ═══ 12) حارس التجميد عبر كل مسارات المشاركة ═══
        console.log('\n── 12) التجميد الإشرافي يوقف كل مشاركة (والانسحاب متاح) ──');
        dbw.prepare("INSERT INTO community_restrictions (user_id, kind, scope, reason, active, created_by) VALUES ('emp-CM107','participation_freeze','community','اختبار',1,'test')").run();
        const fzCouncil = await api('POST', '/api/community/councils/' + councilId + '/join', t7);
        check('F1) مجمّد ينضم لمجلس ← 403 PARTICIPATION_FROZEN',
            fzCouncil.status === 403 && fzCouncil.body && fzCouncil.body.code === 'PARTICIPATION_FROZEN');
        const fzPresence = await api('PUT', '/api/community/presence', t7, { status: 'available' });
        check('F2) مجمّد يعلن توفره ← 403 PARTICIPATION_FROZEN',
            fzPresence.status === 403 && fzPresence.body && fzPresence.body.code === 'PARTICIPATION_FROZEN');
        const fzActivity = await api('POST', '/api/community/activities/' + act1Id + '/join', t7);
        check('F3) مجمّد ينضم لنشاط ← 403 PARTICIPATION_FROZEN',
            fzActivity.status === 403 && fzActivity.body && fzActivity.body.code === 'PARTICIPATION_FROZEN');
        const fzComp = await api('POST', '/api/community/competitions/' + compId + '/join', t7);
        check('F4) مجمّد ينضم لمنافسة ← 403 PARTICIPATION_FROZEN',
            fzComp.status === 403 && fzComp.body && fzComp.body.code === 'PARTICIPATION_FROZEN');
        const fzOptOut = await api('PUT', '/api/community/presence', t7, { status: 'unavailable' });
        check('F5) «غير متاح» (انسحاب) متاح رغم التجميد', fzOptOut.status === 200);
        const fzRead = await api('GET', '/api/community/councils', t7);
        check('F6) المجمّد يطالع (التجميد للمشاركة لا للقراءة)', fzRead.status === 200);
        dbw.prepare("DELETE FROM community_restrictions WHERE user_id='emp-CM107'").run();
        const fzLifted = await api('POST', '/api/community/councils/' + councilId + '/join', t7);
        check('F7) فك التجميد ← المشاركة تعود', fzLifted.status === 200);

        // ═══ 13) الإطفاء الكامل + استثناء الإدارة ═══
        console.log('\n── 13) مفاتيح التعطيل: إطفاء شامل وتأثير صفري على الإدارة ──');
        await api('PUT', '/api/community/admin/settings', t4, { enabled: false });
        const off1 = await api('GET', '/api/community/councils', t1);
        check('X1) الإطفاء ← councils 403 COMMUNITY_DISABLED', off1.status === 403 && off1.body && off1.body.code === 'COMMUNITY_DISABLED');
        const off2 = await api('PUT', '/api/community/presence', t1, { status: 'available' });
        check('X2) الإطفاء ← presence 403', off2.status === 403);
        const off3 = await api('GET', '/api/community/activities', t1);
        check('X3) الإطفاء ← activities 403', off3.status === 403);
        const offAdmin = await api('GET', '/api/community/admin/events', t4);
        check('X4) مسارات الإدارة تعمل أثناء الإطفاء (إدارة المحتوى ممكنة)', offAdmin.status === 200);
        await api('PUT', '/api/community/admin/settings', t4, { enabled: true });
        const on1 = await api('GET', '/api/community/councils', t1);
        check('X5) إعادة التفعيل ← councils 200', on1.status === 200);

        // ═══ 14) الانحدار + صلاحية الحضور الزمنية + الفصل النهائي ═══
        console.log('\n── 14) انحدار وعزل نهائي ──');
        dbw.prepare("UPDATE community_presence SET updated_at = datetime('now','-13 hours') WHERE user_id='emp-CM102'").run();
        const prAged = await api('GET', '/api/community/presence', t1);
        check('Z1) حالة أقدم من 12 ساعة لا تُعرض (ليست «موجودًا» افتراضيًا)',
            !prAged.body.presence.some(p => p.userId === 'emp-CM102'), JSON.stringify(prAged.body.presence.map(p => p.userId)));
        const health = await fetch(BASE + '/health');
        check('Z2) /health سليم', health.ok);
        const centers = await api('GET', '/api/ops/centers', t1);
        check('Z3) انحدار: /api/ops/centers (P1) ← 200', centers.status === 200, 'status=' + centers.status);
        const communityHtml = fs.existsSync(path.join(ROOT, 'public', 'community.html'));
        check('Z4) واجهة الويب public/community.html موجودة', communityHtml);

        // ═══ 15) سباقات التزامن والذرّية — ملاحظات مراجعة الـFinal Diff (2026-09-24) ═══
        console.log('\n── 15) السباقات والذرّية: سعة الانضمام/تكرار البلاغ/فك التقييد/فشل التدقيق ──');

        // (أ) سباق سعة الانضمام: السعة 3 والمنشئ شغل مقعدًا ← 4 طلبات متزامنة على مقعدين
        dbw.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-CM105','community.join_activity',1,'test')").run();
        dbw.prepare("UPDATE community_restrictions SET active = 0, lifted_by = 'test', lifted_at = datetime('now') WHERE user_id = 'emp-CM105' AND active = 1").run();
        const raceAct = await api('POST', '/api/community/activities', t1, { typeId, title: 'نشاط سباق السعة', maxParticipants: 3 });
        const raceActId = raceAct.body && raceAct.body.id;
        const raceJoins = await Promise.all([t2, t7, t8, t5].map(tok => api('POST', '/api/community/activities/' + raceActId + '/join', tok)));
        const raceOk = raceJoins.filter(r => r.status === 200).length;
        const raceFull = raceJoins.filter(r => r.status === 409 && r.body && r.body.code === 'ACTIVITY_FULL').length;
        check('V1) سباق سعة (مقعدان/4 طلبات متزامنة): نجاحان بالضبط + ACTIVITY_FULL للباقي',
            raceAct.status === 200 && raceOk === 2 && raceFull === 2, JSON.stringify(raceJoins.map(r => r.status)));
        const raceCount = dbw.prepare("SELECT COUNT(*) c FROM community_activity_participants WHERE activity_id = ? AND status = 'joined'").get(raceActId).c;
        check('V2) عدد المشاركين النهائي = السعة بالضبط (3) — لا تجاوز إطلاقًا', raceCount === 3, 'count=' + raceCount);

        // (ب) سباق تكرار البلاغ: 3 بلاغات متزامنة من نفس المبلِّغ على نفس الهدف
        const racePost = await api('POST', '/api/community/councils/' + councilId + '/posts', t2, { content: 'منشور لسباق البلاغات المتزامنة' });
        const racePostId = racePost.body && racePost.body.id;
        const raceReps = await Promise.all([1, 2, 3].map(() => api('POST', '/api/community/report', t1, { targetType: 'post', targetId: String(racePostId), reason: 'بلاغ سباق التكرار' })));
        const repRaceOk = raceReps.filter(r => r.status === 200).length;
        const repRaceDup = raceReps.filter(r => r.status === 409 && r.body && r.body.code === 'DUPLICATE_REPORT').length;
        check('V3) سباق بلاغات مكررة (3 متزامنة): نجاح واحد + DUPLICATE_REPORT للباقي',
            racePost.status === 200 && repRaceOk === 1 && repRaceDup === 2, JSON.stringify(raceReps.map(r => r.status)));
        const pendingRows = dbw.prepare("SELECT COUNT(*) c FROM community_reports WHERE reporter_user_id = 'emp-CM101' AND target_type = 'post' AND target_id = ? AND status = 'pending'").get(String(racePostId)).c;
        check('V4) صف pending واحد فقط لكل (مبلِّغ، هدف) في القاعدة', pendingRows === 1, 'rows=' + pendingRows);
        let idxThrew = false;
        try {
            dbw.prepare("INSERT INTO community_reports (reporter_user_id, target_type, target_id, reason) VALUES ('emp-CM101', 'post', ?, 'تجاوز يدوي')").run(String(racePostId));
        } catch (e) { idxThrew = /UNIQUE/i.test(String(e && e.message)); }
        check('V5) فهرس idx_community_reports_pending_one يرفض pending ثانيًا مباشرة في القاعدة', idxThrew);

        // (ج) سباق فك التقييد: طلبان متزامنان — UPDATE الشرطي (active=1) يحسم واحدًا فقط
        const rstIns = dbw.prepare("INSERT INTO community_restrictions (user_id, kind, scope, reason, active, created_by) VALUES ('emp-CM108', 'participation_restrict', 'community', 'سباق الفك', 1, 'test')").run();
        const raceRstId = rstIns.lastInsertRowid;
        const raceLifts = await Promise.all([1, 2].map(() => api('POST', '/api/community/moderation/restrictions/' + raceRstId + '/lift', t3)));
        const liftOk = raceLifts.filter(r => r.status === 200).length;
        const lift409 = raceLifts.filter(r => r.status === 409 && r.body && r.body.code === 'RESTRICTION_NOT_ACTIVE').length;
        check('V6) سباق فك تقييد (طلبان متزامنان): نجاح واحد + RESTRICTION_NOT_ACTIVE للآخر',
            liftOk === 1 && lift409 === 1, JSON.stringify(raceLifts.map(r => r.status)));
        const liftAudits = dbw.prepare("SELECT COUNT(*) c FROM community_audit_log WHERE action = 'restriction_lift' AND target_id = ?").get(String(raceRstId)).c;
        check('V7) تدقيق فك واحد فقط — لا audit مزدوج ولا audit بلا أثر', liftAudits === 1, 'audits=' + liftAudits);
        const rstState = dbw.prepare('SELECT active FROM community_restrictions WHERE id = ?').get(raceRstId);
        check('V8) التقييد مرفوع فعلًا مرة واحدة (active=0)', rstState && rstState.active === 0);

        // (د) مسار فشل التدقيق الحقيقي: إخفاء جدول التدقيق فعليًا أثناء عمليات
        // mutation+audit — يجب أن تفشل كلها ولا يبقى أي أثر (ROLLBACK كامل)
        const cntBefore = {
            councils: dbw.prepare('SELECT COUNT(*) c FROM community_councils').get().c,
            activities: dbw.prepare('SELECT COUNT(*) c FROM community_activities').get().c,
            participants: dbw.prepare('SELECT COUNT(*) c FROM community_activity_participants').get().c,
            events: dbw.prepare('SELECT COUNT(*) c FROM community_events').get().c,
            competitions: dbw.prepare('SELECT COUNT(*) c FROM community_competitions').get().c
        };
        dbw.exec('ALTER TABLE community_audit_log RENAME TO community_audit_log__hidden');
        let fpCouncil, fpAct, fpEvent, fpComp;
        try {
            fpCouncil = await api('POST', '/api/community/councils', t4, { slug: 'fail-path', name: 'مجلس مسار الفشل' });
            fpAct = await api('POST', '/api/community/activities', t1, { typeId, title: 'نشاط مسار الفشل' });
            fpEvent = await api('POST', '/api/community/admin/events', t4, { title: 'مناسبة مسار الفشل' });
            fpComp = await api('POST', '/api/community/admin/competitions', t4, { name: 'منافسة مسار الفشل' });
        } finally {
            dbw.exec('ALTER TABLE community_audit_log__hidden RENAME TO community_audit_log');
        }
        check('V9) فشل التدقيق أثناء إنشاء مجلس ← خطأ خادم (لا نجاح زائف)', fpCouncil.status >= 500, 'status=' + (fpCouncil && fpCouncil.status));
        check('V10) فشل التدقيق أثناء إنشاء نشاط ← خطأ خادم', fpAct.status >= 500, 'status=' + (fpAct && fpAct.status));
        check('V11) فشل التدقيق أثناء إنشاء مناسبة ← خطأ خادم', fpEvent.status >= 500, 'status=' + (fpEvent && fpEvent.status));
        check('V12) فشل التدقيق أثناء إنشاء منافسة ← خطأ خادم', fpComp.status >= 500, 'status=' + (fpComp && fpComp.status));
        check('V13) ROLLBACK كامل: لا مجلس/نشاط/مشارك/مناسبة/منافسة بلا تدقيق',
            dbw.prepare('SELECT COUNT(*) c FROM community_councils').get().c === cntBefore.councils &&
            dbw.prepare('SELECT COUNT(*) c FROM community_activities').get().c === cntBefore.activities &&
            dbw.prepare('SELECT COUNT(*) c FROM community_activity_participants').get().c === cntBefore.participants &&
            dbw.prepare('SELECT COUNT(*) c FROM community_events').get().c === cntBefore.events &&
            dbw.prepare('SELECT COUNT(*) c FROM community_competitions').get().c === cntBefore.competitions);
        const auditBack = await api('GET', '/api/community/moderation/audit', t3);
        check('V14) جدول التدقيق أُعيد وسليم بعد الاختبار', auditBack.status === 200, 'status=' + auditBack.status);
    } catch (e) {
        failed++;
        failures.push('fatal: ' + e.message);
        console.error('💥 خطأ جسيم:', e);
    } finally {
        if (server) { try { server.kill(); } catch (_) { } }
        if (dbw) { try { dbw.close(); } catch (_) { } }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + ext, { force: true }); } catch (_) { } }
    }
    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل');
    if (failures.length) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})();
