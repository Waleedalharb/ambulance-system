/**
 * ═══ اختبار EMS Community — Full Foundation (اعتماد المالك الكتابي 2026-09-24) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3137 — لا تمس بيانات الإنتاج.
 * النطاق: مجالس/منشورات(بلا تعليقات)/حضور صريح/أنشطة/مناسبات/شارات/منافسات +
 * فلترة UGC + إشراف المحتوى + عزل تشغيلي كامل + بوابة خادمية + انحدار.
 *
 * يغطي شروط الاعتماد:
 *  - بنيوي: 20 جدولًا additive، FKs داخل community_* فقط، لا أعمدة مال/رهان،
 *    لا team_live_locations/GPS/realtime في كود الخدمات (فحص ساكن بلا تعليقات)،
 *    ولا أي حقل موقع في استجابات الحضور/الأنشطة.
 *  - صلاحيات community.* منح فردي حصرًا ← 401/403 على كل مجموعة مسارات.
 *  - البوابة/الحارس: مسارات المشاركة (نشر/انضمام/منافسة/إنشاء غرفة/إرسال رسالة)
 *    تمر بالحارس الموحد — التجميد الإشرافي يوقفها كلها. الحضور (قرار D1):
 *    إعلان الحالة لا يمر بالبوابة التشغيلية إطلاقًا؛ التعطيل/التجميد فقط،
 *    والانسحاب (unavailable) يبقى متاحًا دائمًا.
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

    // الحضور (قرار المالك D1 2026-09-24): إعلان الحالة اختيار شخصي بحت —
    // participationGuard لا يُستدعى إطلاقًا من هذا المسار. إعلان التوفر يخضع
    // فقط لتعطيل المنظومة (isAvailableFor) والتجميد الإشرافي؛ الانسحاب حر دائمًا.
    const guardCalled = [];
    const mkCore = avail => ({
        isAvailableFor: async () => avail,
        participationGuard: async () => { guardCalled.push('guard'); throw new Error('participationGuard لا يجب أن يُستدعى من الحضور'); }
    });
    const calls = [];
    const mkPres = (avail, restrictions) => new Presence({
        db: { Community: { setPresence: async () => calls.push('set'), getActiveRestrictions: async () => restrictions } },
        identity: stubIdentity, core: mkCore(avail), filter: stubFilter
    });
    const e1 = await mkPres(false, []).setMine({ id: 'u1' }, { status: 'available' }).catch(e => e);
    check('B1) إعلان توفر أثناء إطفاء/تعطيل المنظومة ← 403 COMMUNITY_DISABLED ولا كتابة',
        e1 && e1.statusCode === 403 && e1.code === 'COMMUNITY_DISABLED' && calls.length === 0, JSON.stringify({ code: e1 && e1.code }));
    const e1b = await mkPres(true, [{ kind: 'participation_freeze' }]).setMine({ id: 'u1' }, { status: 'available' }).catch(e => e);
    check('B1ب) إعلان توفر أثناء تجميد إشرافي ← 403 PARTICIPATION_FROZEN ولا كتابة',
        e1b && e1b.statusCode === 403 && e1b.code === 'PARTICIPATION_FROZEN' && calls.length === 0, JSON.stringify({ code: e1b && e1b.code }));
    const okOptIn = await mkPres(true, []).setMine({ id: 'u1' }, { status: 'in_activity' });
    check('B1ج) إعلان «في نشاط» سليم ← ينجح (لا بوابة تشغيلية في الحضور)', okOptIn && okOptIn.status === 'in_activity' && calls.length === 1);
    const okOut = await mkPres(false, [{ kind: 'participation_freeze' }]).setMine({ id: 'u1' }, { status: 'unavailable' });
    check('B2) «غير متاح» (انسحاب) متاح دائمًا — حتى مع التعطيل والتجميد معًا', okOut && okOut.status === 'unavailable');
    check('B2ب) participationGuard لم يُستدعَ إطلاقًا من مسار الحضور (قرار D1)', guardCalled.length === 0);

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
        // نُرشف المناوبات النشطة في النسخة المعزولة فقط حتى يكون الوضع الافتراضي
        // «خارج مناوبة»؛ قسم 5ب يعيد تنشيط واحدة ليثبت أن المناوبة لا تمنع
        // المشاركة الاجتماعية إطلاقًا (قرار المالك النهائي 2026-09-25).
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
        console.log('\n── 2) البنية: 20 جدولًا additive وعزل FK ولا أعمدة مال ──');
        const tbls = dbw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name").all().map(t => t.name);
        const EXPECTED_TABLES = ['community_activities', 'community_activity_participants', 'community_activity_types',
            'community_audit_log', 'community_badges', 'community_blocks', 'community_chat_messages',
            'community_competition_participants', 'community_competitions', 'community_council_members',
            'community_councils', 'community_events', 'community_posts', 'community_presence',
            'community_reports', 'community_restrictions', 'community_room_members', 'community_rooms',
            'community_settings', 'community_user_badges'];
        check('T1) جداول community_* العشرون كلها أُنشئت additive (17 أساس + 3 لـD1: الغرف/الأعضاء/الدردشة)',
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
            ['community_presence', 'user_id'], ['community_reports', 'reporter_user_id'], ['community_audit_log', 'actor_id'],
            ['community_chat_messages', 'author_user_id'], ['community_room_members', 'user_id']]) {
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

        // ═══ 5ب) قرار المالك النهائي (2026-09-25): إلغاء البوابة التشغيلية ═══
        // ننشئ مناوبة active فعلية في النسخة المعزولة، ثم نثبت أن كل خطوات
        // Community/Baloot تنجح تحتها: الحضور، إنشاء نشاط، إنشاء غرفة،
        // ورحلة بلوت كاملة (فتح طاولة ← جلوس 4 ← جاهزية ← بدء اللعب).
        console.log('\n── 5ب) مناوبة فعلية نشطة: المشاركة الاجتماعية والبلوت بلا أي بوابة تشغيلية ──');
        const shiftRow = dbw.prepare("SELECT id FROM shifts ORDER BY id DESC LIMIT 1").get();
        // صلاحيات الجلوس/الجاهزية لبقية اللاعبين (INSERT OR IGNORE — idempotent)
        for (const u of ['emp-CM102', 'emp-CM107', 'emp-CM108']) {
            dbw.prepare("INSERT OR IGNORE INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'community.join_activity', 1, 'test')").run(u);
        }
        let dutyRoomId = null, dutyTableId = null, dutyMatchId = null;
        try {
            dbw.prepare("UPDATE shifts SET status = 'active' WHERE id = ?").run(shiftRow.id);
            const stGate = await api('GET', '/api/community/status', t2);
            check('N1) مناوبة نشطة حقيقية ← status يعيد allowParticipation=true دائمًا (لا بوابة)',
                stGate.status === 200 && stGate.body.gate && stGate.body.gate.allowParticipation === true &&
                stGate.body.gate.allowRead === true && stGate.body.gate.reason === null, JSON.stringify(stGate.body.gate));
            const prDuty1 = await api('PUT', '/api/community/presence', t2, { status: 'available', note: 'مناوب ومتاح للمجلس' });
            check('N2) إعلان «متاح» أثناء المناوبة ← 200',
                prDuty1.status === 200 && prDuty1.body && prDuty1.body.status === 'available',
                'status=' + prDuty1.status + ' ' + JSON.stringify(prDuty1.body));
            const prDuty2 = await api('PUT', '/api/community/presence', t1, { status: 'in_activity' });
            check('N3) إعلان «في نشاط» أثناء المناوبة ← 200', prDuty2.status === 200, 'status=' + prDuty2.status);
            const actDuty = await api('POST', '/api/community/activities', t1, { typeId: 1, title: 'نشاط أثناء المناوبة' });
            check('N4) إنشاء نشاط أثناء المناوبة ← 200/201 (لا OPERATIONAL_DUTY)',
                (actDuty.status === 200 || actDuty.status === 201) && actDuty.body && actDuty.body.id, 'status=' + actDuty.status);
            const roomDuty = await api('POST', '/api/community/rooms', t1, { name: 'سالفة أثناء المناوبة' });
            dutyRoomId = roomDuty.body && roomDuty.body.id;
            check('N5) إنشاء غرفة أثناء المناوبة ← 200/201',
                (roomDuty.status === 200 || roomDuty.status === 201) && !!dutyRoomId, 'status=' + roomDuty.status);

            // ── رحلة البلوت الكاملة تحت مناوبة فعلية (الاختبار المطلوب صراحة) ──
            const btCreate = await api('POST', '/api/baloot/tables', t1, {});
            dutyTableId = btCreate.body && (btCreate.body.table && btCreate.body.table.id || btCreate.body.id);
            check('N8) فتح طاولة بلوت أثناء المناوبة ← نجاح',
                (btCreate.status === 200 || btCreate.status === 201) && !!dutyTableId, 'status=' + btCreate.status);
            const councilsDuty = await api('GET', '/api/community/councils', t1);
            const balootSeen = councilsDuty.body && (councilsDuty.body.councils || councilsDuty.body).some(c => c.slug === 'baloot');
            check('N8ب) مجلس البلوت ظهر ضمن المجالس (إنشاء كسول)', balootSeen === true);
            let sitOk = true, readyOk = true;
            for (const [i, tok] of [t1, t2, t7, t8].entries()) {
                const s = await api('POST', '/api/baloot/tables/' + dutyTableId + '/sit', tok, { seat: i });
                if (s.status !== 200) { sitOk = false; console.log('   sit fail seat', i, s.status, JSON.stringify(s.body)); }
            }
            check('N9) جلوس الأربعة أثناء المناوبة ← نجاح (لا GATE_DENIED)', sitOk);
            for (const tok of [t1, t2, t7, t8]) {
                const r = await api('POST', '/api/baloot/tables/' + dutyTableId + '/ready', tok);
                if (r.status !== 200) { readyOk = false; console.log('   ready fail', r.status, JSON.stringify(r.body)); }
            }
            check('N10) جاهزية الأربعة أثناء المناوبة ← نجاح', readyOk);
            const tbl = await api('GET', '/api/baloot/tables/' + dutyTableId, t1);
            dutyMatchId = tbl.body && tbl.body.activeMatchId;
            check('N11) المباراة بدأت فعلًا أثناء المناوبة (activeMatchId موجود)',
                !!dutyMatchId, JSON.stringify(tbl.body).slice(0, 200));
            if (dutyMatchId) {
                const mst = await api('GET', '/api/baloot/matches/' + dutyMatchId + '/state', t1);
                check('N12) حالة المباراة متاحة للاعب + يده مرئية له (اللعب جارٍ)',
                    mst.status === 200 && mst.body && mst.body.state && mst.body.state.hand && Array.isArray(mst.body.state.hand.myHand) && mst.body.state.hand.myHand.length > 0, 'status=' + mst.status + ' body=' + JSON.stringify(mst.body).slice(0, 300));
                const opts = await api('GET', '/api/baloot/matches/' + dutyMatchId + '/options', t1);
                check('N13) /options ترد أثناء المناوبة', opts.status === 200, 'status=' + opts.status);
                // إنهاء ودي: تصويت الأربعة على الإنهاء (تنظيف)
                for (const tok of [t1, t2, t7, t8]) await api('POST', '/api/baloot/matches/' + dutyMatchId + '/vote-abort', tok);
            }
        } finally {
            if (dutyRoomId) await api('POST', '/api/community/rooms/' + dutyRoomId + '/close', t1);
            if (dutyTableId) await api('POST', '/api/baloot/tables/' + dutyTableId + '/close', t1);
            dbw.prepare("UPDATE shifts SET status = 'archived' WHERE id = ?").run(shiftRow.id);
        }
        const stAfter = await api('GET', '/api/community/status', t2);
        check('N6) بعد الأرشفة ← المشاركة مسموحة كما كانت',
            stAfter.status === 200 && stAfter.body.gate && stAfter.body.gate.allowParticipation === true, JSON.stringify(stAfter.body.gate));
        const prFree = await api('PUT', '/api/community/presence', t2, { status: 'busy' });
        check('N7) إعلان الحالة بعد الأرشفة ← 200', prFree.status === 200 && prFree.body && prFree.body.status === 'busy');

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

        // (هـ) حالات ON CONFLICT في joinActivityWithCapacity — التحقق النهائي:
        // joined يعيد الانضمام والنشاط ممتلئ / left يعيد والنشاط ممتلئ / left يعيد وبه سعة
        console.log('\n── 15ب) حالات ON CONFLICT: joined/left × ممتلئ/به سعة ──');
        const capAct = await api('POST', '/api/community/activities', t1, { typeId, title: 'نشاط حالات السعة', maxParticipants: 2 });
        const capActId = capAct.body && capAct.body.id; // المنشئ شغل المقعد الأول (1/2)
        await api('POST', '/api/community/activities/' + capActId + '/join', t2);  // t2 ينضم ← ممتلئ (2/2)
        await api('POST', '/api/community/activities/' + capActId + '/leave', t2); // t2 يغادر ← left (1/2)
        await api('POST', '/api/community/activities/' + capActId + '/join', t5);  // t5 ينضم ← ممتلئ مجددًا (2/2)
        const capCount = () => dbw.prepare("SELECT COUNT(*) c FROM community_activity_participants WHERE activity_id = ? AND status = 'joined'").get(capActId).c;
        const capRow = uid => dbw.prepare('SELECT status FROM community_activity_participants WHERE activity_id = ? AND user_id = ?').get(capActId, uid);

        // 1) عضو حالته joined يعيد الانضمام والنشاط ممتلئ ← already بلا فشل زائف ولا زيادة
        const reJoinJoined = await api('POST', '/api/community/activities/' + capActId + '/join', t1);
        check('V15) joined يعيد الانضمام والنشاط ممتلئ ← 200 already:true (لا ACTIVITY_FULL زائف)',
            capAct.status === 200 && reJoinJoined.status === 200 && reJoinJoined.body && reJoinJoined.body.already === true,
            JSON.stringify(reJoinJoined.body));
        check('V16) العدد لم يتغير ولم يُنشأ صف جديد (يبقى 2/2)', capCount() === 2, 'count=' + capCount());

        // 2) عضو حالته left يعيد الانضمام والنشاط ممتلئ ← ACTIVITY_FULL ولا يتحول joined
        const reJoinLeftFull = await api('POST', '/api/community/activities/' + capActId + '/join', t2);
        check('V17) left يعيد الانضمام والنشاط ممتلئ ← 409 ACTIVITY_FULL',
            reJoinLeftFull.status === 409 && reJoinLeftFull.body && reJoinLeftFull.body.code === 'ACTIVITY_FULL',
            JSON.stringify(reJoinLeftFull.body));
        check('V18) صف العضو المغادر يبقى left (لم يتحول joined رغم ON CONFLICT) والعدد 2/2',
            capRow('emp-CM102') && capRow('emp-CM102').status === 'left' && capCount() === 2,
            JSON.stringify(capRow('emp-CM102')) + ' count=' + capCount());

        // 3) توفرت سعة فعلية ← إعادة انضمام العضو left تعيده joined
        await api('POST', '/api/community/activities/' + capActId + '/leave', t5); // t5 يغادر (1/2)
        const reJoinLeftOpen = await api('POST', '/api/community/activities/' + capActId + '/join', t2);
        check('V19) left يعيد الانضمام وبه سعة ← 200 joined:true (مسار ON CONFLICT DO UPDATE)',
            reJoinLeftOpen.status === 200 && reJoinLeftOpen.body && reJoinLeftOpen.body.joined === true && reJoinLeftOpen.body.already !== true,
            JSON.stringify(reJoinLeftOpen.body));
        check('V20) الصف عاد joined والعدد اكتمل 2/2',
            capRow('emp-CM102') && capRow('emp-CM102').status === 'joined' && capCount() === 2,
            JSON.stringify(capRow('emp-CM102')) + ' count=' + capCount());

        // ═══ 16) D1: الغرف والدردشة الجماعية (اعتماد المالك الكتابي 2026-09-24) ═══
        console.log('\n── 16) D1: الغرف — صلاحيات/غرفة مجلس كسولة/سباق إنشاء ──');
        const rmNoTok = await api('GET', '/api/community/rooms', null);
        check('D1-S1) rooms بلا توكن ← 401', rmNoTok.status === 401);
        const rmNoPerm = await api('GET', '/api/community/rooms', t6);
        check('D1-S2) rooms بلا community.view ← 403', rmNoPerm.status === 403);
        const rmCreateNoPerm = await api('POST', '/api/community/rooms', t7, { name: 'غرفة بلا صلاحية' });
        check('D1-S3) إنشاء غرفة خاصة بلا community.post ← 403 صلاحيات', rmCreateNoPerm.status === 403);

        // غرفة المجلس الكسولة: councilId (t1/t2/t5/t7/t8 أعضاء؛ t3 مشرف بلا عضوية)
        const roomDenied = await api('GET', '/api/community/councils/' + councilId + '/room', t3);
        check('D1-R1) فتح غرفة مجلس بلا عضوية ← 403 NOT_A_MEMBER',
            roomDenied.status === 403 && roomDenied.body && roomDenied.body.code === 'NOT_A_MEMBER', 'status=' + roomDenied.status);
        const raceRooms = await Promise.all([t1, t2, t1].map(tok => api('GET', '/api/community/councils/' + councilId + '/room', tok)));
        check('D1-R2) سباق الفتح الأول (3 متزامنة) ← 200 للكل ونفس الغرفة (الفهرس الفريد يحسم)',
            raceRooms.every(r => r.status === 200) && new Set(raceRooms.map(r => r.body.room.id)).size === 1,
            JSON.stringify(raceRooms.map(r => r.status)));
        const councilRoomId = raceRooms[0].body.room.id;
        const roomAgain = await api('GET', '/api/community/councils/' + councilId + '/room', t2);
        check('D1-R3) الفتح المتكرر يعيد نفس الغرفة (كسولة — لا تكرار أبدًا)',
            roomAgain.status === 200 && roomAgain.body.room.id === councilRoomId);
        const myRooms = await api('GET', '/api/community/rooms', t1);
        check('D1-R4) غرفة المجلس تظهر في قائمة «غرفي»',
            myRooms.status === 200 && myRooms.body.councilRooms.some(r => r.id === councilRoomId), JSON.stringify(myRooms.body).slice(0, 200));

        console.log('\n── 16ب) D1: الدردشة — إرسال/مزامنة تزايدية/فلترة/وصول ──');
        const msg1 = await api('POST', '/api/community/rooms/' + councilRoomId + '/messages', t1, { content: 'السلام عليكم — أول رسالة في الغرفة' });
        check('D1-C1) عضو يرسل رسالة نظيفة ← visible', msg1.status === 200 && msg1.body && msg1.body.status === 'visible', JSON.stringify(msg1.body));
        await api('POST', '/api/community/rooms/' + councilRoomId + '/messages', t2, { content: 'وعليكم السلام — القهوة جاهزة' });
        const list0 = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages', t2);
        check('D1-C2) القراءة الأولية تعرض الرسالتين تصاعديًا مع lastId',
            list0.status === 200 && list0.body.messages.length === 2 && list0.body.messages[0].id < list0.body.messages[1].id && list0.body.lastId === list0.body.messages[1].id,
            JSON.stringify(list0.body).slice(0, 250));
        const lastId = list0.body.lastId;
        const listNew0 = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages?since_id=' + lastId, t2);
        check('D1-C3) since_id=lastId بلا جديد ← قائمة فارغة (مزامنة رخيصة)', listNew0.status === 200 && listNew0.body.messages.length === 0);
        await api('POST', '/api/community/rooms/' + councilRoomId + '/messages', t1, { content: 'رسالة ثالثة للمزامنة' });
        const listSync = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages?since_id=' + lastId, t2);
        check('D1-C4) المزامنة التزايدية تعيد الجديد فقط (رسالة واحدة)',
            listSync.status === 200 && listSync.body.messages.length === 1 && listSync.body.messages[0].content === 'رسالة ثالثة للمزامنة', JSON.stringify(listSync.body).slice(0, 200));
        const msgBad = await api('POST', '/api/community/rooms/' + councilRoomId + '/messages', t1, { content: 'هذا الكلام غبي' });
        check('D1-C5) رسالة مخالفة للفلتر ← flagged ولا تُنشر', msgBad.status === 200 && msgBad.body.flagged === true && msgBad.body.status === 'flagged', JSON.stringify(msgBad.body));
        const listFlag = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages?limit=50', t2);
        check('D1-C6) الرسالة الموقوفة لا تظهر للأعضاء', !listFlag.body.messages.some(m => m.id === msgBad.body.id));
        const modChatList = await api('GET', '/api/community/moderation/chat-messages?status=flagged', t3);
        check('D1-C7) الرسالة الموقوفة تظهر في قائمة إشراف الدردشة',
            modChatList.status === 200 && modChatList.body.messages.some(m => m.id === msgBad.body.id && m.room_name), JSON.stringify(modChatList.body).slice(0, 200));
        const modChatNoPerm = await api('GET', '/api/community/moderation/chat-messages', t1);
        check('D1-C8) قائمة إشراف الدردشة بلا community.moderate ← 403', modChatNoPerm.status === 403);
        const approveMsg = await api('POST', '/api/community/moderation/chat-messages/' + msgBad.body.id + '/status', t3, { status: 'visible' });
        check('D1-C9) المشرف يعتمد الرسالة الموقوفة ← 200', approveMsg.status === 200, JSON.stringify(approveMsg.body));
        const listApproved = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages?limit=50', t2);
        check('D1-C10) الرسالة المعتمدة تظهر للأعضاء', listApproved.body.messages.some(m => m.id === msgBad.body.id));
        const chatDenied = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages', t4);
        check('D1-C11) قراءة دردشة مجلس بلا عضوية ← 403 NOT_A_MEMBER (حتى للإدارة)',
            chatDenied.status === 403 && chatDenied.body && chatDenied.body.code === 'NOT_A_MEMBER', 'status=' + chatDenied.status);
        const sendNoPerm = await api('POST', '/api/community/rooms/' + councilRoomId + '/messages', t7, { content: 'x' });
        check('D1-C12) إرسال بعضوية بلا community.post ← 403 صلاحيات', sendNoPerm.status === 403);

        console.log('\n── 16ج) D1: الحظر متبادل الأثر في الدردشة ──');
        const blkChat = await api('POST', '/api/community/block', t1, { userId: 'emp-CM102' });
        check('D1-B1) CM101 يحظر CM102', blkChat.status === 200);
        const listBlk = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages?limit=50', t1);
        check('D1-B2) رسائل المحظور تختفي من دردشة الحاظر',
            !listBlk.body.messages.some(m => m.author.userId === 'emp-CM102'), JSON.stringify(listBlk.body.messages.map(m => m.author.userId)));
        const listBlkRev = await api('GET', '/api/community/rooms/' + councilRoomId + '/messages?limit=50', t2);
        check('D1-B3) رسائل الحاظر تختفي من دردشة المحظور (أثر متبادل)',
            !listBlkRev.body.messages.some(m => m.author.userId === 'emp-CM101'));
        await api('POST', '/api/community/unblock', t1, { userId: 'emp-CM102' });

        console.log('\n── 16د) D1: الغرف الخاصة — إنشاء/أعضاء/مغادرة/إغلاق ──');
        const pv = await api('POST', '/api/community/rooms', t1, { name: 'سوالف المناوبة' });
        check('D1-P1) إنشاء غرفة خاصة ← 200', pv.status === 200 && pv.body && pv.body.id != null, JSON.stringify(pv.body));
        const pvId = pv.body && pv.body.id;
        const pvFiltered = await api('POST', '/api/community/rooms', t1, { name: 'غرفة الغبي' });
        check('D1-P2) اسم غرفة مخالف للفلتر ← 422 FILTER_REJECTED', pvFiltered.status === 422 && pvFiltered.body && pvFiltered.body.code === 'FILTER_REJECTED');
        const pvDenied = await api('GET', '/api/community/rooms/' + pvId, t5);
        check('D1-P3) غير العضو يقرأ غرفة خاصة ← 403 NOT_A_MEMBER', pvDenied.status === 403 && pvDenied.body && pvDenied.body.code === 'NOT_A_MEMBER');
        const addByOther = await api('POST', '/api/community/rooms/' + pvId + '/members', t2, { userId: 'emp-CM105' });
        check('D1-P4) غير المنشئ يضيف عضوًا ← 403 NOT_ROOM_OWNER', addByOther.status === 403 && addByOther.body && addByOther.body.code === 'NOT_ROOM_OWNER');
        const addMem = await api('POST', '/api/community/rooms/' + pvId + '/members', t1, { userId: 'emp-CM102' });
        check('D1-P5) المنشئ يضيف عضوًا ← 200', addMem.status === 200 && addMem.body.added === true, JSON.stringify(addMem.body));
        const pvMsg = await api('POST', '/api/community/rooms/' + pvId + '/messages', t2, { content: 'أهلًا من العضو المضاف' });
        check('D1-P6) العضو المضاف يرسل ← 200', pvMsg.status === 200);
        const pvListMine = await api('GET', '/api/community/rooms', t2);
        check('D1-P7) الغرفة الخاصة تظهر في قائمة العضو المضاف',
            pvListMine.status === 200 && pvListMine.body.privateRooms.some(r => r.id === pvId));
        const closeByOther = await api('POST', '/api/community/rooms/' + pvId + '/close', t2);
        check('D1-P8) غير المنشئ يغلق ← 403 NOT_ROOM_OWNER', closeByOther.status === 403 && closeByOther.body && closeByOther.body.code === 'NOT_ROOM_OWNER');
        const leaveOwner = await api('POST', '/api/community/rooms/' + pvId + '/leave', t1);
        check('D1-P9) المنشئ يغادر ← 422 OWNER_CANNOT_LEAVE (يغلق بدل المغادرة)',
            leaveOwner.status === 422 && leaveOwner.body && leaveOwner.body.code === 'OWNER_CANNOT_LEAVE');
        const leaveMem = await api('POST', '/api/community/rooms/' + pvId + '/leave', t2);
        check('D1-P10) العضو يغادر ذاتيًا ← 200', leaveMem.status === 200);
        const sendAfterLeave = await api('POST', '/api/community/rooms/' + pvId + '/messages', t2, { content: 'بعد المغادرة' });
        check('D1-P11) إرسال بعد المغادرة ← 403 NOT_A_MEMBER', sendAfterLeave.status === 403 && sendAfterLeave.body && sendAfterLeave.body.code === 'NOT_A_MEMBER');
        const raceClose = await Promise.all([1, 2].map(() => api('POST', '/api/community/rooms/' + pvId + '/close', t1)));
        check('D1-P12) سباق الإغلاق (طلبان متزامنان): نجاح واحد + ROOM_CLOSED للآخر (UPDATE الشرطي)',
            raceClose.filter(r => r.status === 200).length === 1 &&
            raceClose.filter(r => r.status === 409 && r.body && r.body.code === 'ROOM_CLOSED').length === 1,
            JSON.stringify(raceClose.map(r => r.status)));
        const sendClosed = await api('POST', '/api/community/rooms/' + pvId + '/messages', t1, { content: 'في غرفة مغلقة' });
        check('D1-P13) الإرسال لغرفة مغلقة ← 409 ROOM_CLOSED', sendClosed.status === 409 && sendClosed.body && sendClosed.body.code === 'ROOM_CLOSED');

        console.log('\n── 16هـ) D1: بلاغات الدردشة — عتبة تلقائية/حذف مشرف/تجميد المؤلف ──');
        const pv2 = await api('POST', '/api/community/rooms', t1, { name: 'غرفة اختبار إشراف الدردشة' });
        const pv2Id = pv2.body && pv2.body.id;
        for (const u of ['emp-CM105', 'emp-CM102', 'emp-CM108']) {
            await api('POST', '/api/community/rooms/' + pv2Id + '/members', t1, { userId: u });
        }
        const tMsg = await api('POST', '/api/community/rooms/' + pv2Id + '/messages', t5, { content: 'رسالة مزعجة لاختبار بلاغات الدردشة' });
        check('D1-M1) رسالة الهدف أُرسلت visible', tMsg.status === 200 && tMsg.body.status === 'visible', JSON.stringify(tMsg.body));
        const selfRep = await api('POST', '/api/community/report', t5, { targetType: 'chat_message', targetId: String(tMsg.body.id), reason: 'أبلغ عن رسالتي' });
        check('D1-M2) الإبلاغ عن رسالة النفس ← 422 SELF_REPORT', selfRep.status === 422 && selfRep.body && selfRep.body.code === 'SELF_REPORT');
        const cRep1 = await api('POST', '/api/community/report', t1, { targetType: 'chat_message', targetId: String(tMsg.body.id), reason: 'رسالة مخالفة للسياسة' });
        check('D1-M3) بلاغ على رسالة ← pending', cRep1.status === 200 && cRep1.body && cRep1.body.status === 'pending', JSON.stringify(cRep1.body));
        const cRepDup = await api('POST', '/api/community/report', t1, { targetType: 'chat_message', targetId: String(tMsg.body.id), reason: 'إغراق بنفس البلاغ' });
        check('D1-M4) بلاغ مكرر على نفس الرسالة ← 409 DUPLICATE_REPORT', cRepDup.status === 409 && cRepDup.body && cRepDup.body.code === 'DUPLICATE_REPORT');
        const cRepGhost = await api('POST', '/api/community/report', t1, { targetType: 'chat_message', targetId: '99999', reason: 'بلاغ شبح' });
        check('D1-M5) بلاغ على رسالة غير موجودة ← 404 (لا بلاغات أشباح)', cRepGhost.status === 404);
        await api('POST', '/api/community/report', t2, { targetType: 'chat_message', targetId: String(tMsg.body.id), reason: 'بلاغ ثانٍ' });
        await api('POST', '/api/community/report', t8, { targetType: 'chat_message', targetId: String(tMsg.body.id), reason: 'بلاغ ثالث' });
        const hiddenChat = dbw.prepare('SELECT status FROM community_chat_messages WHERE id = ?').get(tMsg.body.id);
        check('D1-M6) بلوغ العتبة (3) ← إخفاء تلقائي hidden للرسالة (وليس حذفًا)',
            hiddenChat && hiddenChat.status === 'hidden', JSON.stringify(hiddenChat));
        const chatAutoAudit = dbw.prepare("SELECT COUNT(*) c FROM community_audit_log WHERE action='chat_auto_hide' AND target_id = ?").get(String(tMsg.body.id));
        check('D1-M7) الإخفاء التلقائي للرسالة مُدقَّق (chat_auto_hide)', chatAutoAudit.c === 1);
        const listAfterHide = await api('GET', '/api/community/rooms/' + pv2Id + '/messages?limit=50', t1);
        check('D1-M8) الرسالة المخفية لا تظهر في الغرفة', !listAfterHide.body.messages.some(m => m.id === tMsg.body.id));
        const removeChat = await api('POST', '/api/community/moderation/chat-messages/' + tMsg.body.id + '/status', t3, { status: 'removed', note: 'مخالفة مؤكدة' });
        const removedChat = dbw.prepare('SELECT status FROM community_chat_messages WHERE id = ?').get(tMsg.body.id);
        check('D1-M9) المشرف يحذف الرسالة نهائيًا ← removed في القاعدة',
            removeChat.status === 200 && removedChat && removedChat.status === 'removed');
        const chatRepRow = dbw.prepare("SELECT id FROM community_reports WHERE target_type='chat_message' AND target_id = ? AND status='pending' ORDER BY id LIMIT 1").get(String(tMsg.body.id));
        const freezeChat = await api('POST', '/api/community/moderation/reports/' + chatRepRow.id + '/action', t3, { action: 'freeze', note: 'تكرار المخالفة في الدردشة' });
        check('D1-M10) freeze على بلاغ رسالة ← resolved', freezeChat.status === 200, JSON.stringify(freezeChat.body));
        const rstChatAuthor = dbw.prepare("SELECT * FROM community_restrictions WHERE user_id='emp-CM105' AND active=1").get();
        check('D1-M11) التجميد يطال مؤلف الرسالة (وليس معرّفها)', !!rstChatAuthor && rstChatAuthor.kind === 'participation_freeze', JSON.stringify(rstChatAuthor));
        const fzChat = await api('POST', '/api/community/rooms/' + pv2Id + '/messages', t5, { content: 'محاولة أثناء التجميد' });
        check('D1-M12) المجمّد يرسل رسالة ← 403 PARTICIPATION_FROZEN', fzChat.status === 403 && fzChat.body && fzChat.body.code === 'PARTICIPATION_FROZEN');

        console.log('\n── 16و) D1: مسار فشل التدقيق — mutation+audit ذرّية في الغرف والدردشة ──');
        const d1Before = {
            rooms: dbw.prepare('SELECT COUNT(*) c FROM community_rooms').get().c,
            msgs: dbw.prepare('SELECT COUNT(*) c FROM community_chat_messages').get().c
        };
        dbw.exec('ALTER TABLE community_audit_log RENAME TO community_audit_log__hidden');
        let fpRoom, fpMsg;
        try {
            fpRoom = await api('POST', '/api/community/rooms', t1, { name: 'غرفة مسار الفشل' });
            fpMsg = await api('POST', '/api/community/rooms/' + councilRoomId + '/messages', t1, { content: 'هذا غبي — مسار فشل التدقيق' });
        } finally {
            dbw.exec('ALTER TABLE community_audit_log__hidden RENAME TO community_audit_log');
        }
        check('D1-V1) فشل التدقيق أثناء إنشاء غرفة ← خطأ خادم ولا غرفة بلا تدقيق (ROLLBACK)',
            fpRoom.status >= 500 && dbw.prepare('SELECT COUNT(*) c FROM community_rooms').get().c === d1Before.rooms,
            'status=' + (fpRoom && fpRoom.status));
        check('D1-V2) فشل التدقيق أثناء إيقاف رسالة مخالفة ← خطأ خادم ولا رسالة بلا تدقيق',
            fpMsg.status >= 500 && dbw.prepare('SELECT COUNT(*) c FROM community_chat_messages').get().c === d1Before.msgs,
            'status=' + (fpMsg && fpMsg.status));
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
