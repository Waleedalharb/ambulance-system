#!/usr/bin/env node
// ============================================
// upgrade-provisioned-accounts.js — ترقية حسابات التوفيق الجماعي
// (قرار المالك 2026-09-20): الـ125 الذين أُنشئوا بدور viewer يُرقَّون إلى
// حزمة المسعف العامل = دور user + منحة ops.my_portal الفردية — مطابقة
// الحسابين المرجعيين 61292 و11336 (المثبتة في user_permissions بالإنتاج).
//
// الاستهداف: الحسابات التي دورها 'viewer' حصرًا — لا تُمس الأدوار الأخرى
// (operator/field_leadership/sysadmin/user القائمة) ولا كلمات المرور.
//
// لكل حساب:
//   1) role: viewer ← user (يحمل مفتاح التوافق ops.execute فقط).
//   2) منحة فردية ops.my_portal في user_permissions (إن لم توجد).
//   3) إبطال جلساته النشطة (نفس منطق PermissionService: حظر بصمة التوكن
//      + تعطيل الجلسة) حتى يدخل بالصلاحيات الجديدة فورًا.
//   4) توثيق في audit_log.
//
// التشغيل:
//   node scripts/upgrade-provisioned-accounts.js            ← معاينة فقط
//   node scripts/upgrade-provisioned-accounts.js --apply    ← تنفيذ
// البيئة: DATA_DIR وDB_PATH — افتراضيًا data/ وdata/ambulance.db.
// ============================================
'use strict';

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ambulance.db');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const GRANTED_BY = 'owner-approved bulk 2026-09-20';

function main() {
    console.log('══ ترقية حسابات التوفيق — ' + (APPLY ? 'تنفيذ فعلي (--apply)' : 'معاينة فقط (dry-run)') + ' ══');
    console.log('DATA_DIR: ' + DATA_DIR);
    console.log('DB_PATH:  ' + DB_PATH);

    if (!fs.existsSync(DB_PATH)) { console.error('❌ قاعدة البيانات غير موجودة: ' + DB_PATH); process.exit(1); }
    if (!fs.existsSync(USERS_PATH)) { console.error('❌ users.json غير موجود: ' + USERS_PATH); process.exit(1); }

    const Database = require('better-sqlite3');
    const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    const targets = users.filter(u => u.role === 'viewer' && String(u.id).startsWith('emp-'));
    const untouched = users.length - targets.length;

    console.log('\nإجمالي الحسابات: ' + users.length);
    console.log('مستهدفون (role=viewer): ' + targets.length);
    console.log('غير مستهدفين (لن يُمسوا): ' + untouched);

    if (!APPLY) {
        console.log('\n— معاينة أول 10 —');
        for (const t of targets.slice(0, 10)) {
            console.log('  ~ ' + t.username + ' · ' + t.name + ' · viewer ← user + ops.my_portal');
        }
        console.log('\nلا كتابة. أعد التشغيل مع --apply للتنفيذ.');
        process.exit(0);
    }

    // نسخة احتياطية قبل أي كتابة
    const now = new Date().toISOString();
    const backupPath = USERS_PATH + '.bak-' + now.replace(/[:.]/g, '-');
    fs.copyFileSync(USERS_PATH, backupPath);
    console.log('\nنسخة احتياطية: ' + backupPath);

    // 1) ترقية الدور في users.json
    for (const t of targets) { t.role = 'user'; }
    const tmpPath = USERS_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(users, null, 2));
    fs.renameSync(tmpPath, USERS_PATH);

    // 2+3+4) المنحة + إبطال الجلسات + التدقيق — معاملة واحدة: كلها أو لا شيء
    const db = new Database(DB_PATH);
    let portalGranted = 0, sessionsRevoked = 0, audited = 0;
    const hasPerm = db.prepare("SELECT granted FROM user_permissions WHERE user_id = ? AND permission_key = 'ops.my_portal'");
    const grantPerm = db.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, 'ops.my_portal', 1, ?)");
    const listSessions = db.prepare("SELECT id, access_token_hash, session_expires FROM auth_sessions WHERE user_id = ? AND is_active = 1");
    const blacklist = db.prepare("INSERT OR IGNORE INTO token_blacklist (token_hash, token_type, user_id, session_id, reason, expires_at) VALUES (?, 'access', ?, ?, 'role_change', ?)");
    const deactivate = db.prepare("UPDATE auth_sessions SET is_active = 0, logout_time = ?, logout_reason = 'role_change' WHERE id = ?");
    const audit = db.prepare("INSERT INTO audit_log (user_id, user_name, action, detail, type) VALUES (?, ?, ?, ?, ?)");

    const runAll = db.transaction(() => {
        for (const t of targets) {
            const existing = hasPerm.get(String(t.id));
            if (!existing) { grantPerm.run(String(t.id), GRANTED_BY); portalGranted++; }
            for (const s of listSessions.all(String(t.id))) {
                if (s.access_token_hash) blacklist.run(s.access_token_hash, String(t.id), s.id, s.session_expires || null);
                deactivate.run(now, s.id);
                sessionsRevoked++;
            }
            audit.run('provision-script', 'ترقية توفيق جماعي', 'role_change',
                'ترقية ' + t.name + ' (' + t.username + ') · الدور: مستخدم قراءة ← مستخدم · منحة ops.my_portal' + (existing ? ' (قائمة)' : '') + ' · بلا مساس بكلمة المرور',
                'permissions');
            audited++;
        }
    });

    try {
        runAll();
    } catch (e) {
        console.error('❌ فشلت المعاملة ورُدّت بالكامل (users.json رُقّي — راجع النسخة الاحتياطية عند الحاجة): ' + e.message);
        db.close();
        process.exit(1);
    }
    db.close();

    console.log('\n══ التقرير ══');
    console.log('upgraded (viewer ← user): ' + targets.length);
    console.log('ops.my_portal granted:    ' + portalGranted);
    console.log('sessions revoked:         ' + sessionsRevoked);
    console.log('audited:                  ' + audited);
    console.log('untouched accounts:       ' + untouched);
    process.exit(0);
}

try { main(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
