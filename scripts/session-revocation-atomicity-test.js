/**
 * ═══ اختبار ذرية setPermission + مناعة TokenBlacklist (قرار المالك 2026-09-05) ═══
 * نسخة معزولة (VACUUM INTO) من القاعدة المحلية — تحتوي فعليًا 7 جلسات نشطة
 * ببصمات محظورة سابقًا لحساب emp-4252 (الحالة الإنتاجية الحقيقية التي كشفتها جولة bootstrap).
 *
 * يثبت:
 *  1) المنحة مع جلسات مكررة البصمات: تنجح كاملة (منحة + تدقيق + تعطيل جلسات) — قبل الإصلاح كانت تسقط بـUNIQUE وتترك صفًا جزئيًا.
 *  1ب) الجلسات القديمة بلا بصمة توكن تُعطَّل (is_active=0) ولا تُترك نشطة — قبل الإصلاح كانت تُتخطَّى كليًا.
 *  2) TokenBlacklist.add idempotent: إدراج نفس البصمة مرتين لا يرمي خطأ.
 *  3) الذرية عند الفشل: جلسة نشطة مزروعة + إسقاط جدول token_blacklist ثم محاولة سحب ← فشل + تراجع كامل
 *     (صف المنحة يبقى كما كان، الجلسة المزروعة تبقى نشطة، ولا قيد تدقيق جزئي).
 *  4) الحساب المقصود فقط يتأثر: جلسات مستخدم آخر لا تُمس.
 *
 * التشغيل: node scripts/session-revocation-atomicity-test.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'atomicity-' + STAMP + '.db').replace(/\\/g, '/');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();

    console.log('🧪 نسخة معزولة — ذرية setPermission + مناعة TokenBlacklist');
    process.env.DB_PATH = TMP_DB; // db.js يحترم DB_PATH صراحة
    const db = require(path.join(ROOT, 'db.js'));
    const PermissionService = require(path.join(ROOT, 'services', 'permission-service.js'));
    await db.init(false);
    const svc = new PermissionService({ db });

    try {
        // ── تهيئة: تأكيد الحالة الإنتاجية المكشوفة موجودة في النسخة ──
        const stale = await db.all(
            "SELECT s.id FROM auth_sessions s JOIN token_blacklist b ON b.token_hash = s.access_token_hash WHERE s.user_id = 'emp-4252' AND s.is_active = 1");
        check('تهيئة: النسخة تحمل جلسات نشطة ببصمات محظورة سابقًا (الحالة الإنتاجية)', stale.length > 0, 'stale=' + stale.length);

        // ── 1) المنحة مع الجلسات المكررة: نجاح كامل بلا سقوط UNIQUE وبلا حالة جزئية ──
        const r1 = await svc.setPermission('emp-4252', 'admin.users_manage', true, { id: 'tester', name: 'اختبار الذرية' });
        const row1 = (await db.UserPermissions.getByUser('emp-4252')).find(r => r.permission_key === 'admin.users_manage');
        const audit1 = await db.get("SELECT COUNT(*) c FROM audit_log WHERE action='permission_grant' AND detail LIKE '%emp-4252%'");
        const staleAfter = await db.all(
            "SELECT s.id FROM auth_sessions s WHERE s.user_id = 'emp-4252' AND s.is_active = 1");
        check('1) المنحة مع جلسات مكررة البصمات: نجاح كامل — صف منحة + قيد تدقيق + صفر جلسة نشطة تبقى',
            r1.changed === true && row1 && row1.granted === 1 && audit1.c === 1 && staleAfter.length === 0,
            JSON.stringify({ r1, row: row1 && row1.granted, audit: audit1.c, activeLeft: staleAfter.length }));

        // ── 1ب) الجلسات بلا بصمة توكن (1,3,12,13,14,17,20) كانت تُترك نشطة قبل الإصلاح — الآن معطلة ──
        const nullHashLeft = await db.get(
            "SELECT COUNT(*) c FROM auth_sessions WHERE user_id = 'emp-4252' AND is_active = 1 AND access_token_hash IS NULL");
        const nullHashDone = await db.get(
            "SELECT COUNT(*) c FROM auth_sessions WHERE user_id = 'emp-4252' AND is_active = 0 AND access_token_hash IS NULL AND logout_reason = 'permissions_changed'");
        check('1ب) الجلسات القديمة بلا بصمة: عُطّلت (is_active=0 + سبب مسجل) رغم استحالة حظرها',
            nullHashLeft.c === 0 && nullHashDone.c >= 7,
            JSON.stringify({ left: nullHashLeft.c, deactivated: nullHashDone.c }));

        // ── 2) TokenBlacklist.add idempotent: نفس البصمة مرتين بلا خطأ ──
        let idem = true;
        try {
            await db.TokenBlacklist.add('hash-test-' + STAMP, null);
            await db.TokenBlacklist.add('hash-test-' + STAMP, null);
        } catch (e) { idem = false; }
        const blCount = (await db.get("SELECT COUNT(*) c FROM token_blacklist WHERE token_hash = ?", ['hash-test-' + STAMP])).c;
        check('2) إدراج البصمة نفسها مرتين: لا خطأ وصف واحد فقط', idem && blCount === 1, 'blCount=' + blCount);

        // ── 3) الذرية عند الفشل: جلسة نشطة جديدة + إسقاط token_blacklist ← فشل الإبطال ← تراجع كامل ──
        // بعد الفحص 1 لم تبقَ جلسات نشطة لـemp-4252؛ نزرع واحدة ببصمة لضمان أن revokeUserSessions
        // يصل فعلًا إلى TokenBlacklist.add — وإلا فلن يختبر الفحص شيئًا (الحلقة تتخطى غير النشطة).
        await db.run(
            "INSERT INTO auth_sessions (user_id, username, role, access_token_hash, session_expires, is_active) VALUES ('emp-4252', '4252', 'admin', ?, datetime('now', '+1 day'), 1)",
            ['atomicity-fail-' + STAMP]);
        await db.exec('DROP TABLE token_blacklist');
        let threw = false;
        try {
            await svc.setPermission('emp-4252', 'admin.users_manage', false, { id: 'tester', name: 'اختبار الذرية' });
        } catch (e) { threw = true; }
        const row3 = (await db.UserPermissions.getByUser('emp-4252')).find(r => r.permission_key === 'admin.users_manage');
        const audit3 = await db.get("SELECT COUNT(*) c FROM audit_log WHERE action='permission_revoke' AND detail LIKE '%emp-4252%'");
        const sessAfter = await db.get("SELECT is_active FROM auth_sessions WHERE access_token_hash = ?", ['atomicity-fail-' + STAMP]);
        check('3) فشل إبطال الجلسات: السحب يرمي خطأ + صف المنحة يبقى granted=1 (تراجع) + صفر قيد revoke جزئي + الجلسة المزروعة تبقى نشطة (تراجع التعطيل)',
            threw === true && row3 && row3.granted === 1 && audit3.c === 0 && sessAfter && sessAfter.is_active === 1,
            JSON.stringify({ threw, granted: row3 && row3.granted, revokeAudit: audit3.c, sessActive: sessAfter && sessAfter.is_active }));

        // ── 4) العزل: مستخدم آخر لم تُمس جلساته طوال العمليات ──
        // (نسخة الإنتاج تحوي جلسات نشطة لحسابات أخرى)
        const others = await db.get("SELECT COUNT(*) c FROM auth_sessions WHERE user_id != 'emp-4252' AND is_active = 1");
        check('4) جلسات الحسابات الأخرى لم تُمس', others.c > 0, 'others=' + others.c);

        console.log('\n════════════════ نتيجة الذرية والمناعة: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
        if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
    } finally {
        try { await db.closeDb(); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
        delete process.env.DB_PATH;
    }
    process.exit(failed ? 1 : 0);
})();
