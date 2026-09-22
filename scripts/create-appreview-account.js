/**
 * ═══ create-appreview-account.js — حساب مراجعة Apple (اعتماد المالك 2026-09-22) ═══
 * يُنشئ حساب مراجعة App Store ثابتًا على قاعدة البيئة الحالية:
 *  - موظف اصطناعي employee_code='appreview' (لا بيانات موظف حقيقي).
 *  - مستخدم username='appreview' بدور viewer (صفر افتراضيات، صفر إدارة).
 *  - منحتان فرديتان فقط: ops.my_portal (بوابة الموظف) + schedule.view (قراءة الجداول).
 *
 * الحماية:
 *  - كلمة المرور تُقرأ من APP_REVIEW_PASSWORD فقط — لا قيمة في الكود إطلاقًا.
 *  - Idempotent: تشغيله مرتين لا يضاعف شيئًا ولا يغيّر كلمة مرور حساب قائم.
 *  - لا يحذف ولا يعدّل أي حساب أو موظف أو منحة قائمة.
 *
 * التشغيل (Render Shell على الإنتاج):
 *   APP_REVIEW_PASSWORD='<كلمة المرور المعتمدة>' node scripts/create-appreview-account.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const STORAGE_PATH = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(STORAGE_PATH, 'ambulance.db');
const USERS_PATH = path.join(STORAGE_PATH, 'users.json');

const USERNAME = 'appreview';
const USER_ID = 'emp-appreview';
const DISPLAY_NAME = 'Apple Review';
const JOB_TITLE = 'مراجعة المتجر';
const GRANTS = ['ops.my_portal', 'schedule.view'];
const ROLE = 'viewer';

(function main() {
    const password = process.env.APP_REVIEW_PASSWORD;
    if (!password || password.length < 10) {
        console.error('❌ APP_REVIEW_PASSWORD مطلوبة (10 أحرف فأكثر) — لا تُكتب كلمة المرور في الكود');
        process.exit(1);
    }
    if (!fs.existsSync(DB_PATH)) { console.error('❌ قاعدة البيانات غير موجودة: ' + DB_PATH); process.exit(1); }
    if (!fs.existsSync(USERS_PATH)) { console.error('❌ users.json غير موجود: ' + USERS_PATH); process.exit(1); }

    const db = new Database(DB_PATH);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const report = { employee: 'موجود', user: 'موجود', grants: [] };

    // 1) ملف الموظف الاصطناعي
    const emp = db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(USERNAME);
    if (!emp) {
        db.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)')
            .run(USERNAME, DISPLAY_NAME, JOB_TITLE);
        report.employee = 'أُنشئ';
    }

    // 2) الحساب في users.json — لا يُمس إن وُجد (كلمة المرور القائمة تبقى)
    const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    if (!users.some(u => u.username === USERNAME || String(u.id) === USER_ID)) {
        users.push({
            id: USER_ID,
            username: USERNAME,
            name: DISPLAY_NAME,
            password: bcrypt.hashSync(password, 10),
            role: ROLE,
            isActive: true,
            createdAt: now,
            lastLogin: null
        });
        fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
        report.user = 'أُنشئ';
    }

    // 3) المنحتان الفرديتان — لا تكرار
    const hasGrant = db.prepare('SELECT 1 FROM user_permissions WHERE user_id = ? AND permission_key = ? AND granted = 1');
    const insGrant = db.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'create-appreview-account')");
    for (const g of GRANTS) {
        if (hasGrant.get(USER_ID, g)) { report.grants.push(g + ': موجودة'); }
        else { insGrant.run(USER_ID, g); report.grants.push(g + ': مُنحت'); }
    }

    db.close();
    console.log('✅ حساب مراجعة Apple جاهز:');
    console.log('   username: ' + USERNAME + ' · role: ' + ROLE);
    console.log('   الموظف: ' + report.employee + ' · الحساب: ' + report.user);
    console.log('   المنح: ' + report.grants.join(' · '));
    console.log('   كلمة المرور هي قيمة APP_REVIEW_PASSWORD التي مرّرتها (لا تُعرض ولا تُخزَّن نصًا).');
})();
