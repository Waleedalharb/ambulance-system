/**
 * ═══ اختبار طبقة APNs (v6) — push_devices + PushGateway + الربط ═══
 *
 * السيناريوهات:
 *   1) Migration: جدول push_devices يُنشأ على قاعدة طازجة
 *   2) upsert: إدراج ثم إعادة تسجيل = تفعيل + تحديث (لا صف مكرر)
 *   3) انتقال الجهاز لحساب آخر = إعادة ربط بالحساب الجديد
 *   4) deactivateByUser / deactivateToken + activeForUsers يرشّح المعطَّل
 *   5) البوابة بلا مفاتيح بيئة = {disabled:true} ولا تُنشئ مزوّدًا أصلًا
 *   6) إرسال مفعّل بمزوّد مزيّف: تجميع حسب البيئة + شارة auto لكل مستخدم
 *   7) توكن ميت (Unregistered) يُفصل فورًا ولا يُرسل له مجددًا
 *   8) فشل المزوّد لا يرمي — يُحصى failed ويكمل الباقين
 *   9) notifyPersonal: ينشئ + يبث + يرسل Push بنفس الحمولة (kind=notification)
 *  10) ScheduleChangeNotifier: إشعار داخلي sent ثم Push (kind=schedule_change)
 *      وبلا بوابة = نفس السلوك القديم حرفيًا (pushed=0)
 *  11) حراسة المصدر: المسارات بـ authenticate+authorizePerm، الخروج يفصل
 *      الأجهزة، .gitignore يحمي *.p8، my-ems.js محروس بـ Capacitor
 *
 * التشغيل: node scripts/push-apns-test.js   (يتطلب node_modules المتاحة)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const STAMP = Date.now();
const TMP_DIR = path.join(os.tmpdir(), 'push-apns-' + STAMP).replace(/\\/g, '/');
fs.mkdirSync(TMP_DIR, { recursive: true });
process.env.DATA_DIR = TMP_DIR; // قبل require db.js — مصدر التخزين يُقرأ عند التحميل

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}

const TOKEN_A = 'a'.repeat(64), TOKEN_B = 'b'.repeat(64), TOKEN_C = 'c'.repeat(64);

async function main() {
    console.log('═══ A) قاعدة حقيقية مؤقتة: push_devices ═══');
    const db = require('../db.js');
    await db.init(true);

    // 1) الجدول وُجد
    const tbl = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='push_devices'");
    check('1) migration تنشئ push_devices', !!tbl);

    // 2) upsert إدراج ثم إعادة تسجيل
    await db.PushDevices.upsert({ user_id: 'u1', device_token: TOKEN_A, platform: 'ios', environment: 'development' });
    let row = await db.get('SELECT * FROM push_devices WHERE device_token = ?', [TOKEN_A]);
    check('2أ) upsert يدرج الجهاز مفعّلًا', row && row.user_id === 'u1' && row.is_active === 1);
    await db.PushDevices.deactivateToken(TOKEN_A);
    await db.PushDevices.upsert({ user_id: 'u1', device_token: TOKEN_A, platform: 'ios', environment: 'development' });
    const rows = await db.all('SELECT * FROM push_devices WHERE device_token = ?', [TOKEN_A]);
    row = rows[0];
    check('2ب) إعادة التسجيل تُفعل بلا صف مكرر', rows.length === 1 && row.is_active === 1 && row.deactivated_at == null);

    // 3) انتقال الجهاز لحساب آخر
    await db.PushDevices.upsert({ user_id: 'u2', device_token: TOKEN_A, platform: 'ios', environment: 'development' });
    row = await db.get('SELECT * FROM push_devices WHERE device_token = ?', [TOKEN_A]);
    check('3) انتقال الجهاز يعيد ربطه بالحساب الجديد', row.user_id === 'u2');

    // 4) الفصل والترشيح
    await db.PushDevices.upsert({ user_id: 'u1', device_token: TOKEN_B, platform: 'ios', environment: 'production' });
    await db.PushDevices.upsert({ user_id: 'u1', device_token: TOKEN_C, platform: 'ios', environment: 'development' });
    await db.PushDevices.deactivateByUser('u2');
    let active = await db.PushDevices.activeForUsers(['u1', 'u2']);
    check('4أ) deactivateByUser يفصل أجهزة الحساب', active.every(d => d.user_id === 'u1') && active.length === 2);
    await db.PushDevices.deactivateToken(TOKEN_C);
    active = await db.PushDevices.activeForUsers(['u1']);
    check('4ب) deactivateToken + activeForUsers يرشّح المعطَّل', active.length === 1 && active[0].device_token === TOKEN_B);

    console.log('═══ B) PushGateway: التعطيل الآمن والإرسال ═══');
    delete process.env.APNS_KEY; delete process.env.APNS_KEY_BASE64;
    delete process.env.APNS_KEY_ID; delete process.env.APNS_TEAM_ID;
    const PushGateway = require('../services/push-gateway');

    // 5) معطّل بلا مفاتيح
    let factoryCalls = 0;
    const gwOff = new PushGateway({ db, providerFactory: () => { factoryCalls++; return { send: async () => ({ sent: [{}], failed: [] }) }; } });
    const offRes = await gwOff.sendToUsers(['u1'], { title: 't', body: 'b' });
    check('5) بلا مفاتيح = disabled ولا مزوّد يُنشأ', offRes.disabled === true && factoryCalls === 0);

    // 6+7+8) مفعّل بمزوّد مزيّف
    process.env.APNS_KEY = 'test-key-material-not-a-real-key';
    process.env.APNS_KEY_ID = 'KID123'; process.env.APNS_TEAM_ID = 'TID456';
    const sentLog = [];
    const fakeFactory = (env) => ({
        env,
        send: async (note, token) => {
            sentLog.push({ env, note, token });
            if (token === 'DEAD') return { sent: [], failed: [{ device: token, response: { reason: 'Unregistered' } }] };
            if (token === 'FLAKY') throw new Error('network down');
            return { sent: [{ device: token }], failed: [] };
        }
    });
    const stubDb = {
        get: async (sql) => (/FROM notifications/.test(sql) ? { c: 2 } : { c: 1 }), // شارة u1 = 2+1
        PushDevices: {
            _deactivated: [],
            async activeForUsers() {
                return [
                    { user_id: 'u1', device_token: 'LIVE-DEV', environment: 'development' },
                    { user_id: 'u1', device_token: 'LIVE-PROD', environment: 'production' },
                    { user_id: 'u1', device_token: 'DEAD', environment: 'development' },
                    { user_id: 'u1', device_token: 'FLAKY', environment: 'development' }
                ];
            },
            async deactivateToken(t) { this._deactivated.push(t); return { changes: 1 }; }
        }
    };
    const gw = new PushGateway({ db: stubDb, providerFactory: fakeFactory });
    check('6أ) isEnabled باكتمال المفاتيح', gw.isEnabled() === true);
    const res = await gw.sendToUsers(['u1'], { title: 'تحديث في جدول المناوبات', body: 'تم تغيير مناوبتك', badge: 'auto', data: { kind: 'schedule_change' } });
    const devSends = sentLog.filter(s => s.env === 'development');
    const prodSends = sentLog.filter(s => s.env === 'production');
    check('6ب) تجميع الإرسال حسب البيئة', devSends.length === 3 && prodSends.length === 1, JSON.stringify(sentLog.map(s => s.env)));
    check('6ج) شارة auto = 2+1 لكل جهاز', sentLog.every(s => s.note.badge === 3), JSON.stringify(sentLog.map(s => s.note.badge)));
    check('6د) الحمولة والعنوان يمران حرفيًا', sentLog[0] && sentLog[0].note.title === 'تحديث في جدول المناوبات' && sentLog[0].note.data.kind === 'schedule_change' && sentLog[0].note.topic === 'online.emsoperations.app');
    check('7) التوكن الميت يُفصل فورًا', res.deactivated === 1 && stubDb.PushDevices._deactivated.includes('DEAD'));
    check('8) فشل المزوّد يُحصى ولا يرمي', res.failed === 2 && res.sent === 2, JSON.stringify(res));

    console.log('═══ C) الربط مع نقطتي الإنشاء القائمتين ═══');
    // 9) notifyPersonal
    const pushCalls = [];
    const spyGateway = { sendToUsers: async (ids, payload) => { pushCalls.push({ ids, payload }); return { sent: 1 }; } };
    const broadcastCalls = [];
    const notifService = require('../services/notification-service');
    const tmpUsers = path.join(TMP_DIR, 'users.json');
    fs.writeFileSync(tmpUsers, JSON.stringify([{ id: 'u1', username: '11336', role: 'user', isActive: true }]));
    notifService.init({
        usersPath: tmpUsers,
        getDb: () => ({ Notifications: { create: async () => 42 } }),
        broadcastToUsers: (ids, payload) => broadcastCalls.push({ ids, payload }),
        pushGateway: spyGateway
    });
    const np = await notifService.notifyPersonal('u1', { title: 'تكليف جديد', message: 'لديك تكليف', type: 'urgent' });
    check('9أ) notifyPersonal ينشئ ويبث كما كان', np.id === 42 && np.type === 'danger' && broadcastCalls.length === 1);
    check('9ب) notifyPersonal يرسل Push لنفس المستهدف', pushCalls.length === 1 && pushCalls[0].ids[0] === 'u1' && pushCalls[0].payload.data.kind === 'notification' && pushCalls[0].payload.data.notification_id === 42 && pushCalls[0].payload.badge === 'auto');

    // 10) ScheduleChangeNotifier مع بوابة وبدونها
    const ScheduleChangeNotifier = require('../services/schedule-change-notifier');
    const auditRow = { id: 7, employee_id: 79, shift_date: '2026-09-20', change_type: 'edit', old_shift_code: 'D12', new_shift_code: 'N12', old_team_id: 1, new_team_id: 1, roster_id: 55 };
    const stubDb2 = {
        ShiftAuditLog: { getByIds: async () => [auditRow] },
        all: async () => [{ id: 1, name: 'جنوب 1' }],
        get: async (sql) => (/FROM employees/.test(sql) ? { id: 79, employee_code: '11336', name: 'موظف اختبار', phone: null } : null),
        NotificationLog: {
            async getByRevisionAndRecipient() { return []; },
            async create() { return 900; },
            async markAsSent() { return { changes: 1 }; }
        }
    };
    const push2 = [];
    const notifier = new ScheduleChangeNotifier({ db: stubDb2, usersPath: tmpUsers, broadcastToUsers: () => { }, pushGateway: { sendToUsers: async (ids, p) => { push2.push({ ids, p }); return { sent: 2, failed: 0 }; } } });
    const st = await notifier.notifyRevision({ revisionId: 5, auditIds: [7] });
    check('10أ) الإشعار الداخلي يعمل كما كان (notified=1)', st.notified === 1 && st.failed === 0);
    check('10ب) Push بنفس العنوان والحمولة (kind=schedule_change)', push2.length === 1 && push2[0].p.title === 'تحديث في جدول المناوبات' && push2[0].p.data.kind === 'schedule_change' && push2[0].p.data.revision_id === 5 && st.pushed === 2);
    const notifierNoGw = new ScheduleChangeNotifier({ db: stubDb2, usersPath: tmpUsers, broadcastToUsers: () => { } });
    const st2 = await notifierNoGw.notifyRevision({ revisionId: 5, auditIds: [7] });
    check('10ج) بلا بوابة = السلوك القديم حرفيًا (pushed=0)', st2.notified === 1 && st2.pushed === 0);

    console.log('═══ D) حراسة المصدر ═══');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const myEmsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my-ems.js'), 'utf8');
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const pushRegSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'push-register.js'), 'utf8');
    check('11أ) مسارا register/unregister محروسان (authenticate + ops.my_portal)',
        /app\.post\('\/api\/my\/push\/register', authenticate, authorizePerm\('ops\.my_portal'\)/.test(serverSrc) &&
        /app\.post\('\/api\/my\/push\/unregister', authenticate, authorizePerm\('ops\.my_portal'\)/.test(serverSrc));
    check('11ب) الخروج يفصل أجهزة الحساب', /logout[\s\S]{0,3000}PushDevices\.deactivateByUser/.test(serverSrc) || /PushDevices\.deactivateByUser[\s\S]{0,3000}logout successful/.test(serverSrc));
    check('11ج) .gitignore يحمي مفاتيح .p8', /^\*\.p8$/m.test(gitignore));
    check('11د) my-ems.js محروس بـ Capacitor فقط', /Capacitor\.isNativePlatform/.test(myEmsSrc) && /push-register\.js/.test(myEmsSrc));
    check('11هـ) push-register.js لا يربط قبل المصادقة ولا يرسل معرّف مستخدم', /if \(!authToken\(\)\) return/.test(pushRegSrc) && !/user_id/.test(pushRegSrc));
    check('11و) package.json: apn + @capacitor/push-notifications', !!(pkg.dependencies && pkg.dependencies.apn && pkg.dependencies['@capacitor/push-notifications']));
    check('11ز) لا مرجع لملف .p8 في الكود', !/['"][^'"]*\.p8['"]/.test(serverSrc) && !/['"][^'"]*\.p8['"]/.test(fs.readFileSync(path.join(ROOT, 'services', 'push-gateway.js'), 'utf8')));

    await db.closeDb().catch(() => { });
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }

    console.log('\n═══════════════════════════════');
    console.log(`النتيجة: ${passed} ناجح / ${failed} فاشل`);
    if (failures.length) { console.log('الفاشلة:\n - ' + failures.join('\n - ')); process.exit(1); }
    process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
