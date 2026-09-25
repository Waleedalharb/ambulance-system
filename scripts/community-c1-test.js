/**
 * ═══ اختبار C1: EMS Community — Foundation (اعتماد المالك الكتابي 2026-09-24) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3136 — لا تمس بيانات الإنتاج.
 * النطاق: أساس المجتمع فقط — صلاحيات/هوية/بوابة/حظر/بلاغ/إشراف/تدقيق/تعطيل.
 * لا مجالس ولا منشورات ولا فعاليات ولا بطولات ولا realtime (C2+).
 *
 * يغطي شروط الاعتماد العشرة:
 *  - عزل تام: لا تعديل على الجداول التشغيلية، لا قراءة من team_live_locations،
 *    ولا وصول لـemployees خارج Projection (display_name/avatar_url/is_active فقط).
 *  - الصلاحيات community.* منح فردي حصرًا ← 401/403.
 *  - البوابة التشغيلية: تعيين الحالات من resolveEffectiveAssignment الفعلي
 *    (وحدة A بستاب حتمي) — المنع ثابت معماريًا وreason عام غير حساس.
 *  - Block من طرف واحد بأثر متبادل + فك من الحاظر فقط.
 *  - Report → Queue → Action → Audit + تجميد مشاركة + فك تقييد.
 *  - مفاتيح التعطيل (كامل/دور) في اتجاه التقييد فقط، وadmin مستثنى حتى يفعّل.
 *  - إجراءات السلامة متاحة أثناء الحالة التشغيلية (لا تمر بالبوابة).
 *  - انحدار: /health و/api/ops/centers (P1) بلا تغيير.
 *
 * التشغيل: node scripts/community-c1-test.js
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
const TMP_DB = path.join(os.tmpdir(), 'cmc1-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'cmc1-data-' + STAMP).replace(/\\/g, '/');
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

// ═══ الوحدة A: البوابة التشغيلية بستاب حتمي — تعيين حالات الكود الفعلي ═══
async function unitGate() {
    console.log('\n═══ الوحدة A: البوابة التشغيلية (حالات resolveEffectiveAssignment الفعلية) ═══');
    const Gate = require(path.join(ROOT, 'services', 'community-operational-gate-service'));
    const mk = eff => new Gate({ assignment: { resolveEffectiveAssignment: async () => eff } });
    const U = { id: 'u1' };

    const g1 = await mk({ deployable: true, teamId: 1, shiftMode: 'active_shift', warnings: [] }).evaluate(U);
    check('A1) مناوبة نشطة + تكليف ميداني ← DENY ACTIVE_ASSIGNMENT + قفل القراءة',
        g1.allowParticipation === false && g1.allowRead === false && g1.reason === 'ACTIVE_ASSIGNMENT', JSON.stringify(g1));

    const g2 = await mk({ deployable: false, blockReason: 'no_assignment', shiftMode: 'active_shift', warnings: [] }).evaluate(U);
    check('A2) مناوبة نشطة بدون تكليف ← DENY OPERATIONAL_DUTY + قراءة مسموحة',
        g2.allowParticipation === false && g2.allowRead === true && g2.reason === 'OPERATIONAL_DUTY', JSON.stringify(g2));

    const g3 = await mk({ deployable: false, blockReason: 'absent', shiftMode: 'active_shift', warnings: [] }).evaluate(U);
    check('A3) غياب/تأخر ← DENY ATTENDANCE_STATE',
        g3.allowParticipation === false && g3.reason === 'ATTENDANCE_STATE', JSON.stringify(g3));

    const g4 = await mk({ deployable: true, teamId: 1, shiftMode: 'staffing_unavailable', warnings: [] }).evaluate(U);
    check('A4) staffing_unavailable (مناوبة نشطة بلا حالة) ← DENY fail-closed',
        g4.allowParticipation === false && g4.reason === 'OPERATIONAL_DUTY', JSON.stringify(g4));

    const g5 = await mk({ deployable: true, teamId: 1, shiftMode: 'roster_only', warnings: [] }).evaluate(U);
    check('A5) roster_only (خارج المناوبة/تكليف قادم) ← ALLOW كامل',
        g5.allowParticipation === true && g5.allowRead === true && g5.reason === null, JSON.stringify(g5));

    const g6 = await mk({ notFound: true, deployable: false, blockReason: 'no_employee', shiftMode: 'roster_only', warnings: [] }).evaluate(U);
    check('A6) بلا ملف موظف (حساب نظام) ← ALLOW',
        g6.allowParticipation === true && g6.reason === null, JSON.stringify(g6));

    const g7 = await new Gate({ assignment: { resolveEffectiveAssignment: async () => { throw new Error('boom'); } } }).evaluate(U);
    check('A7) خطأ في الاستعلام ← DENY fail-closed بسبب عام',
        g7.allowParticipation === false && g7.reason === 'OPERATIONAL_DUTY', JSON.stringify(g7));

    check('A8) reason لا يحمل تفاصيل تشغيلية (فريق/بلاغ/موقع) في كل الحالات',
        [g1, g2, g3, g4, g7].every(g => g.reason === null || /^(OPERATIONAL_DUTY|ACTIVE_ASSIGNMENT|ATTENDANCE_STATE)$/.test(g.reason)));
}

// ═══ الوحدة C: إثبات إصلاحَي مراجعة الـdiff (2026-09-24) ═══
async function unitFixes() {
    console.log('\n═══ الوحدة C: ذرّية الإشراف + عزل مطابقة الهوية ═══');

    // C1: الهوية لا تطابق بالاسم إطلاقًا — موظف بنفس الاسم موجود، لكن بلا
    // employee_code=username ← employee_id=null ولا يُصدر استعلام اسم أصلًا
    const Identity = require(path.join(ROOT, 'services', 'community-identity-service'));
    const tmpUsers = path.join(os.tmpdir(), 'cmc1-users-' + STAMP + '.json');
    fs.writeFileSync(tmpUsers, JSON.stringify([
        { id: 'u-nomatch', username: 'NOEMP01', name: 'موظف متشابه الاسم', isActive: true }
    ]));
    let nameQueryIssued = false;
    const stubDb = {
        get: async (sql) => {
            if (/WHERE\s+name\s*=/.test(sql)) { nameQueryIssued = true; return { id: 99, name: 'موظف متشابه الاسم', is_active: 1 }; }
            return null; // employee_code=NOEMP01 غير موجود
        }
    };
    const ident = new Identity({ db: stubDb, usersPath: tmpUsers });
    const proj = await ident.resolveByUser({ id: 'u-nomatch' });
    check('C1) بلا employee_code مطابق ← employee_id=null رغم وجود موظف بنفس الاسم',
        proj && proj.employee_id === null && proj.display_name === 'موظف متشابه الاسم', JSON.stringify(proj));
    check('C2) استعلام employees بالاسم لم يُصدر إطلاقًا', nameQueryIssued === false);
    try { fs.rmSync(tmpUsers, { force: true }); } catch (_) { }

    // C3–C5: الذرّية الحقيقية — فشل أي خطوة يُرجع العملية كاملة (ROLLBACK)
    const Moderation = require(path.join(ROOT, 'services', 'community-moderation-service'));
    const mkDb = (failAt, calls) => ({
        beginTransaction: () => calls.push('BEGIN'),
        commitTransaction: () => calls.push('COMMIT'),
        rollbackTransaction: () => calls.push('ROLLBACK'),
        Community: {
            getReportById: async () => ({ id: 7, status: 'pending', target_type: 'user', target_id: 'u-target' }),
            resolveReport: async () => {
                calls.push('resolve');
                if (failAt === 'resolve') throw new Error('fail-resolve');
                return failAt === 'stale' ? { id: 7, changes: 0 } : { id: 7, changes: 1 }; // stale = سباق مشرفَين
            },
            addRestriction: async () => { calls.push('restrict'); if (failAt === 'restrict') throw new Error('fail-restrict'); },
            audit: async () => { calls.push('audit'); if (failAt === 'audit') throw new Error('fail-audit'); }
        }
    });
    const stubIdent = { resolveByUserId: async () => ({ employee_id: 1, display_name: 'x', avatar_url: null, is_active: true }) };
    const actor = { id: 'u-mod', name: 'مشرف' };

    const c3 = [];
    await new Moderation({ db: mkDb('audit', c3), identity: stubIdent })
        .handleReport(actor, 7, { action: 'freeze' }).catch(e => c3.push('threw:' + e.message));
    check('C3) فشل audit بعد resolve+restrict ← ROLLBACK ولا COMMIT',
        c3.join(',') === 'BEGIN,resolve,restrict,audit,ROLLBACK,threw:fail-audit', c3.join(','));

    const c4 = [];
    await new Moderation({ db: mkDb('restrict', c4), identity: stubIdent })
        .handleReport(actor, 7, { action: 'freeze' }).catch(e => c4.push('threw:' + e.message));
    check('C4) فشل addRestriction ← ROLLBACK ولا audit ولا COMMIT',
        c4.join(',') === 'BEGIN,resolve,restrict,ROLLBACK,threw:fail-restrict', c4.join(','));

    const c5 = [];
    const ok = await new Moderation({ db: mkDb(null, c5), identity: stubIdent })
        .handleReport(actor, 7, { action: 'freeze' });
    check('C5) المسار السليم ← BEGIN..COMMIT بلا ROLLBACK ويُرجع resolved',
        c5.join(',') === 'BEGIN,resolve,restrict,audit,COMMIT' && ok.status === 'resolved', c5.join(','));

    // C6: حارس السباق — UPDATE أصاب 0 صف (مشرف آخر سبق) ← 409 + ROLLBACK
    // ولا restriction ولا audit مزدوجان إطلاقًا
    const c6 = [];
    const raceErr = await new Moderation({ db: mkDb('stale', c6), identity: stubIdent })
        .handleReport(actor, 7, { action: 'freeze' }).catch(e => e);
    check('C6) UPDATE بـ0 صف (سباق مشرفَين) ← 409 ALREADY_HANDLED + ROLLBACK بلا restrict/audit',
        raceErr && raceErr.code === 'ALREADY_HANDLED' && c6.join(',') === 'BEGIN,resolve,ROLLBACK', c6.join(','));
}

(async () => {
    let server = null;
    try {
        await unitGate();
        await unitFixes();

        console.log('\n═══ الوحدة B: API معزول (صلاحيات/هوية/حظر/بلاغ/إشراف/تعطيل) ═══');
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

        // مستخدمون: عضوان + مشرف + مدير مجتمع + بلا صلاحيات
        const hash = bcrypt.hashSync('test1234', 10);
        const usersPath = path.join(TMP_DIR, 'users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        for (const u of ['CM001', 'CM002', 'CM003', 'CM004', 'CM005']) {
            users.push({ id: 'emp-' + u, username: u, name: 'اختبار ' + u, password: hash, role: 'user', isActive: true });
        }
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

        const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
        insEmp.run('CM001', 'عضو أول c1', 'فني اسعاف');
        insEmp.run('CM002', 'عضو ثانٍ c1', 'فني اسعاف');

        const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
        insPerm.run('emp-CM001', 'community.view');
        insPerm.run('emp-CM002', 'community.view');
        insPerm.run('emp-CM003', 'community.view');
        insPerm.run('emp-CM003', 'community.moderate');
        insPerm.run('emp-CM004', 'community.view');
        insPerm.run('emp-CM004', 'community.admin');
        insPerm.run('emp-CM004', 'community.moderate'); // مشرف ثانٍ — لاختبار سباق المعالجة
        // CM005: لا منح إطلاقًا

        console.log('🧪 خادم معزول على ' + PORT + ' — Community C1 Foundation');
        const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', NODE_PATH: path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES };
        server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
        check('B0) الخادم المعزول أقلع', await waitReady());

        const tok1 = await login('CM001');
        const tok2 = await login('CM002');
        const tok3 = await login('CM003');
        const tok4 = await login('CM004');
        const tok5 = await login('CM005');
        check('B0أ) تسجيل دخول الخمسة', !!(tok1 && tok2 && tok3 && tok4 && tok5));

        // ═══ الحراسة ═══
        const noTok = await api('GET', '/api/community/status', null);
        check('B1) status بلا توكن ← 401', noTok.status === 401, 'status=' + noTok.status);
        const noPerm = await api('GET', '/api/community/status', tok5);
        check('B2) status بلا community.view ← 403', noPerm.status === 403, 'status=' + noPerm.status);
        const modNoPerm = await api('GET', '/api/community/moderation/queue', tok1);
        check('B3) queue بلا community.moderate ← 403', modNoPerm.status === 403, 'status=' + modNoPerm.status);
        const admNoPerm = await api('GET', '/api/community/admin/settings', tok1);
        check('B4) settings بلا community.admin ← 403', admNoPerm.status === 403, 'status=' + admNoPerm.status);

        // ═══ الحالة + الهوية (Projection) ═══
        const st1 = await api('GET', '/api/community/status', tok1);
        check('B5) status ← 200 + enabled + gate بالمفاتيح الثلاثة',
            st1.status === 200 && st1.body && st1.body.enabled === true &&
            typeof st1.body.gate.allowRead === 'boolean' && typeof st1.body.gate.allowParticipation === 'boolean' &&
            (st1.body.gate.reason === null || typeof st1.body.gate.reason === 'string'), JSON.stringify(st1.body).slice(0, 200));
        const meKeys = st1.body && st1.body.me ? Object.keys(st1.body.me).sort() : [];
        check('B6) Projection الهوية = 4 حقول فقط (لا phone/job_title/كود)',
            JSON.stringify(meKeys) === JSON.stringify(['avatar_url', 'display_name', 'employee_id', 'is_active'].sort()),
            meKeys.join(','));
        check('B7) display_name من ملف الموظف المطابق (employee_code=username)',
            st1.body.me.display_name === 'عضو أول c1' && st1.body.me.employee_id != null, JSON.stringify(st1.body.me));

        // ═══ Block ──
        const selfBlock = await api('POST', '/api/community/block', tok1, { userId: 'emp-CM001' });
        check('B8) حظر النفس ← 422 SELF_BLOCK', selfBlock.status === 422 && selfBlock.body && selfBlock.body.code === 'SELF_BLOCK', 'status=' + selfBlock.status);
        const blk = await api('POST', '/api/community/block', tok1, { userId: 'emp-CM002' });
        check('B9) CM001 يحظر CM002 ← 200', blk.status === 200 && blk.body && blk.body.blocked === true, JSON.stringify(blk.body));
        const blkList = await api('GET', '/api/community/blocks', tok1);
        check('B10) قائمة حظر CM001 تحوي CM002 بهوية Projection',
            blkList.status === 200 && blkList.body.blocks.length === 1 &&
            blkList.body.blocks[0].userId === 'emp-CM002' &&
            blkList.body.blocks[0].user && blkList.body.blocks[0].user.display_name === 'عضو ثانٍ c1',
            JSON.stringify(blkList.body).slice(0, 250));
        const blkDb = dbw.prepare("SELECT COUNT(*) c FROM community_blocks WHERE blocker_user_id='emp-CM002' AND blocked_user_id='emp-CM001'").get();
        check('B11) الحظر من طرف واحد (لا صف عكسي) — الأثر المتبادل اشتقاقي', blkDb.c === 0);

        // ═══ Report → Queue → Action → Audit ═══
        const selfRep = await api('POST', '/api/community/report', tok2, { targetType: 'user', targetId: 'emp-CM002', reason: 'تجربة' });
        check('B12) الإبلاغ عن النفس ← 422 SELF_REPORT', selfRep.status === 422 && selfRep.body && selfRep.body.code === 'SELF_REPORT');
        const badType = await api('POST', '/api/community/report', tok2, { targetType: 'post', targetId: '99999999', reason: 'تجربة محتوى' });
        // Full Foundation (اعتماد المالك 2026-09-24): بلاغات المحتوى أصبحت موجودة فعلًا —
        // التوقع المحدّث: منشور غير موجود ← 404 POST_NOT_FOUND (لا TARGET_NOT_AVAILABLE من C1)
        check('B13) بلاغ على منشور غير موجود ← 404 POST_NOT_FOUND (البلاغات على المحتوى مدعومة منذ Full Foundation)',
            badType.status === 404 && badType.body && badType.body.code === 'POST_NOT_FOUND', 'status=' + badType.status);
        const ghost = await api('POST', '/api/community/report', tok2, { targetType: 'user', targetId: 'emp-GHOST', reason: 'تجربة' });
        check('B14) بلاغ على مستخدم غير موجود ← 404', ghost.status === 404, 'status=' + ghost.status);
        const rep = await api('POST', '/api/community/report', tok2, { targetType: 'user', targetId: 'emp-CM001', reason: 'سلوك غير لائق في المجلس' });
        check('B15) CM002 يبلّغ CM001 ← pending', rep.status === 200 && rep.body && rep.body.status === 'pending' && rep.body.id != null, JSON.stringify(rep.body));
        const repId = rep.body && rep.body.id;

        const queue = await api('GET', '/api/community/moderation/queue', tok3);
        check('B16) قائمة المشرف تحوي البلاغ pending',
            queue.status === 200 && queue.body.reports.some(r => r.id === repId && r.status === 'pending'), JSON.stringify(queue.body).slice(0, 250));

        const badAct = await api('POST', '/api/community/moderation/reports/' + repId + '/action', tok3, { action: 'hide' });
        check('B17) إجراء hide (محجوز لمحتوى C2) ← 422 BAD_ACTION', badAct.status === 422 && badAct.body && badAct.body.code === 'BAD_ACTION');

        const freeze = await api('POST', '/api/community/moderation/reports/' + repId + '/action', tok3, { action: 'freeze', note: 'تجميد مؤقت' });
        check('B18) freeze ← resolved + تقييد نشط', freeze.status === 200 && freeze.body.status === 'resolved', JSON.stringify(freeze.body));
        const rst = dbw.prepare("SELECT * FROM community_restrictions WHERE user_id='emp-CM001' AND active=1").get();
        check('B19) تقييد participation_freeze نشط على CM001 في القاعدة', !!rst && rst.kind === 'participation_freeze');

        const stFrozen = await api('GET', '/api/community/status', tok1);
        check('B20) status يعكس participationFrozen=true', stFrozen.status === 200 && stFrozen.body.participationFrozen === true);

        const again = await api('POST', '/api/community/moderation/reports/' + repId + '/action', tok3, { action: 'warn' });
        check('B21) معالجة بلاغ مُعالج ← 409 ALREADY_HANDLED', again.status === 409 && again.body && again.body.code === 'ALREADY_HANDLED', 'status=' + again.status);

        const lift = await api('POST', '/api/community/moderation/restrictions/' + rst.id + '/lift', tok3);
        check('B22) فك التقييد ← 200', lift.status === 200 && lift.body.lifted === true, JSON.stringify(lift.body));
        const stFree = await api('GET', '/api/community/status', tok1);
        check('B23) participationFrozen=false بعد الفك', stFree.status === 200 && stFree.body.participationFrozen === false);

        const audit = await api('GET', '/api/community/moderation/audit', tok3);
        const acts = (audit.body && audit.body.audit || []).map(a => a.action);
        check('B24) التدقيق يحوي block_create + report_create + report_handle + restriction_lift',
            ['block_create', 'report_create', 'report_handle', 'restriction_lift'].every(a => acts.indexOf(a) !== -1), acts.join(','));

        // ═══ مفاتيح التعطيل (تقييد فقط) ═══
        const dis = await api('PUT', '/api/community/admin/settings', tok4, { enabled: false });
        check('B25) إطفاء المنظومة ← enabled:false', dis.status === 200 && dis.body.enabled === false, JSON.stringify(dis.body));
        const stOff = await api('GET', '/api/community/status', tok1);
        check('B26) status بعد الإطفاء ← 403 COMMUNITY_DISABLED', stOff.status === 403 && stOff.body && stOff.body.code === 'COMMUNITY_DISABLED');
        const blkOff = await api('POST', '/api/community/block', tok1, { userId: 'emp-CM002' });
        check('B27) الحظر أيضًا يتوقف مع الإطفاء الكامل (تقييد شامل)', blkOff.status === 403);
        const admStill = await api('GET', '/api/community/admin/settings', tok4);
        check('B28) admin يصل settings رغم الإطفاء (لإعادة التفعيل)', admStill.status === 200);

        const roleOff = await api('PUT', '/api/community/admin/settings', tok4, { enabled: true, disabledRoles: ['user'] });
        check('B29) تعطيل دور user ← disabledRoles=[user]', roleOff.status === 200 && JSON.stringify(roleOff.body.disabledRoles) === '["user"]', JSON.stringify(roleOff.body));
        const stRole = await api('GET', '/api/community/status', tok1);
        check('B30) دور معطّل ← 403 COMMUNITY_DISABLED', stRole.status === 403 && stRole.body && stRole.body.code === 'COMMUNITY_DISABLED');
        const roleOn = await api('PUT', '/api/community/admin/settings', tok4, { disabledRoles: [] });
        const stBack = await api('GET', '/api/community/status', tok1);
        check('B31) إعادة الدور ← status 200', roleOn.status === 200 && stBack.status === 200);

        // ═══ فك الحظر من الحاظر فقط ═══
        const unbOther = await api('POST', '/api/community/unblock', tok2, { userId: 'emp-CM001' });
        const stillBlocked = dbw.prepare("SELECT COUNT(*) c FROM community_blocks WHERE blocker_user_id='emp-CM001' AND blocked_user_id='emp-CM002'").get();
        check('B32) المحظور لا يفك حظر الحاظر (لا صف له أصلًا)', unbOther.status === 200 && stillBlocked.c === 1);
        const unb = await api('POST', '/api/community/unblock', tok1, { userId: 'emp-CM002' });
        const blkAfter = await api('GET', '/api/community/blocks', tok1);
        check('B33) الحاظر يفك الحظر ← القائمة فارغة', unb.status === 200 && blkAfter.body.blocks.length === 0);

        // ═══ سباق مشرفَين على نفس البلاغ (تزامن فعلي Promise.all) ═══
        const rep2 = await api('POST', '/api/community/report', tok1, { targetType: 'user', targetId: 'emp-CM002', reason: 'بلاغ سباق المعالجة' });
        const rep2Id = rep2.body && rep2.body.id;
        check('B33أ) بلاغ ثانٍ pending لاختبار السباق', rep2.status === 200 && rep2Id != null, JSON.stringify(rep2.body));
        const race = await Promise.all([
            api('POST', '/api/community/moderation/reports/' + rep2Id + '/action', tok3, { action: 'freeze', note: 'مشرف أول' }),
            api('POST', '/api/community/moderation/reports/' + rep2Id + '/action', tok4, { action: 'freeze', note: 'مشرف ثانٍ' })
        ]);
        const statuses = race.map(r => r.status).sort((a, b) => a - b);
        check('B33ب) مشرفان متزامنان على بلاغ واحد ← 200 واحد + 409 واحد بالضبط',
            statuses[0] === 200 && statuses[1] === 409, statuses.join(','));
        const winner = race.find(r => r.status === 200);
        const loser = race.find(r => r.status === 409);
        check('B33ج) الفائز resolved والخاسر ALREADY_HANDLED',
            winner && winner.body && winner.body.status === 'resolved' &&
            loser && loser.body && loser.body.code === 'ALREADY_HANDLED', JSON.stringify({ w: winner && winner.body, l: loser && loser.body }).slice(0, 300));
        const rstRace = dbw.prepare("SELECT COUNT(*) c FROM community_restrictions WHERE user_id='emp-CM002' AND active=1").get();
        const auditRace = dbw.prepare("SELECT COUNT(*) c FROM community_audit_log WHERE action='report_handle' AND target_id='emp-CM002'").get();
        check('B33د) restriction واحد فقط وaudit واحد فقط رغم الطلبين المتزامنين',
            rstRace.c === 1 && auditRace.c === 1, 'restrictions=' + rstRace.c + ' audit=' + auditRace.c);

        // ═══ انحدار ═══
        const health = await fetch(BASE + '/health');
        check('B34) /health سليم', health.ok);
        const centers = await api('GET', '/api/ops/centers', tok1);
        check('B35) انحدار: /api/ops/centers (P1) ← 200', centers.status === 200, 'status=' + centers.status);

        // ═══ العزل البنيوي ═══
        const tbls = dbw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name").all().map(t => t.name);
        // Full Foundation (اعتماد المالك 2026-09-24): الجداول أصبحت 17 — التوقع المحدّث:
        // جداول C1 الخمسة موجودة ضمنها (subset) — التحقق الكامل من الـ17 في community-full-test
        const C1_TABLES = ['community_audit_log', 'community_blocks', 'community_reports', 'community_restrictions', 'community_settings'];
        check('B36) جداول C1 الخمسة موجودة ضمن جداول المجتمع (' + tbls.length + ' جدولًا بعد Full Foundation)',
            C1_TABLES.every(t => tbls.indexOf(t) !== -1), tbls.join(','));
        const src2 = new Database(SRC_DB, { readonly: true });
        // Full Foundation: قاعدة التطوير المحلية قد تحمل جداول community فارغة من
        // خادم تطوير عامل بالكود الجديد (init additive طبيعي). الثابت الحقيقي
        // للعزل: لا صفوف اختبار (emp-CM*) تسربت إلى المصدر إطلاقًا.
        let leaked = 0;
        for (const [t, c] of [['community_posts', 'author_user_id'], ['community_council_members', 'user_id'],
            ['community_presence', 'user_id'], ['community_reports', 'reporter_user_id'], ['community_audit_log', 'actor_id']]) {
            try {
                const exists = src2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
                if (exists) leaked += src2.prepare(`SELECT COUNT(*) c FROM ${t} WHERE CAST(${c} AS TEXT) LIKE 'emp-CM%'`).get().c;
            } catch (_) { }
        }
        src2.close();
        check('B37) لا صفوف اختبار تسربت لقاعدة المصدر (العزل سليم)', leaked === 0, 'leaked=' + leaked);
    } catch (e) {
        failed++;
        failures.push('fatal: ' + e.message);
        console.error('💥 خطأ جسيم:', e);
    } finally {
        if (server) { try { server.kill(); } catch (_) { } }
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + ext, { force: true }); } catch (_) { } }
    }
    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل');
    if (failures.length) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})();
