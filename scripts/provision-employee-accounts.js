#!/usr/bin/env node
// ============================================
// provision-employee-accounts.js — توفيق جماعي لحسابات الدخول
// (قرار المالك 2026-09-20 — دخول جميع الموظفين للتطبيق الأصلي)
//
// المصدر: جدول employees نفسه (مصدر الحقيقة — مطابقة جدول شهر 9 أثبتت
// 146/146). لا إدخال يدوي للأسماء أو الأكواد.
//
// القواعد:
//   - الحسابات الجديدة فقط: username = employee_code · كلمة المرور
//     الأولية = employee_code · الدور viewer · بلا أي منحة صلاحية.
//   - الحسابات الموجودة (الـ19+) لا تُمس: لا كلمة مرور، لا دور، لا إعادة إنشاء.
//   - id الحساب = 'emp-<code>' (عقد الهوية المثبت في server.js).
//
// التشغيل:
//   node scripts/provision-employee-accounts.js            ← معاينة فقط (لا كتابة)
//   node scripts/provision-employee-accounts.js --apply    ← تنفيذ فعلي
// البيئة: DATA_DIR (مجلد users.json) وDB_PATH (قاعدة البيانات) — افتراضيًا data/.
// ============================================
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const APPLY = process.argv.includes('--apply');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ambulance.db');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

async function main() {
    console.log('══ توفيق حسابات الموظفين — ' + (APPLY ? 'تنفيذ فعلي (--apply)' : 'معاينة فقط (dry-run)') + ' ══');
    console.log('DATA_DIR: ' + DATA_DIR);
    console.log('DB_PATH:  ' + DB_PATH);

    if (!fs.existsSync(DB_PATH)) { console.error('❌ قاعدة البيانات غير موجودة: ' + DB_PATH); process.exit(1); }
    if (!fs.existsSync(USERS_PATH)) { console.error('❌ users.json غير موجود: ' + USERS_PATH); process.exit(1); }

    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    const employees = db.prepare(
        "SELECT employee_code, name, job_title FROM employees WHERE COALESCE(is_active,1) = 1 ORDER BY employee_code"
    ).all();

    const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    const existingUsernames = new Set(users.map(u => String(u.username)));
    const existingIds = new Set(users.map(u => String(u.id)));

    const toCreate = [];
    const skipped = [];
    const conflicts = [];
    for (const emp of employees) {
        const code = String(emp.employee_code).trim();
        if (!code) { conflicts.push({ code: '(فارغ)', name: emp.name, reason: 'كود موظف فارغ' }); continue; }
        if (existingUsernames.has(code) || existingIds.has('emp-' + code)) {
            skipped.push({ code, name: emp.name });
            continue;
        }
        toCreate.push({ code, name: emp.name, jobTitle: emp.job_title || '' });
    }

    console.log('\nموظفون نشطون: ' + employees.length);
    console.log('حسابات قائمة (لن تُمس): ' + users.length);
    console.log('سيُنشأ: ' + toCreate.length + ' · سيُتجاوز (موجود): ' + skipped.length + ' · تعارضات: ' + conflicts.length);

    if (!APPLY) {
        console.log('\n— معاينة أول 10 حسابات ستُنشأ —');
        for (const t of toCreate.slice(0, 10)) {
            console.log('  + ' + t.code + ' · ' + t.name + ' · ' + t.jobTitle + ' · role=viewer');
        }
        console.log('\nلا كتابة. أعد التشغيل مع --apply للتنفيذ.');
        db.close();
        process.exit(0);
    }

    // ── التنفيذ ──
    const salt = await bcrypt.genSalt(12);
    const created = [];
    const failed = [];
    const now = new Date().toISOString();

    // نسخة احتياطية قبل أي كتابة
    const backupPath = USERS_PATH + '.bak-' + now.replace(/[:.]/g, '-');
    fs.copyFileSync(USERS_PATH, backupPath);
    console.log('\nنسخة احتياطية: ' + backupPath);

    for (const t of toCreate) {
        try {
            const hashed = await bcrypt.hash(t.code, salt); // كلمة المرور الأولية = الكود
            users.push({
                id: 'emp-' + t.code,
                username: t.code,
                name: t.name,
                password: hashed,
                role: 'viewer',
                isActive: true
            });
            created.push(t);
        } catch (e) {
            failed.push({ ...t, reason: e.message });
        }
    }

    // كتابة ذرية: ملف مؤقت ثم rename
    const tmpPath = USERS_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(users, null, 2));
    fs.renameSync(tmpPath, USERS_PATH);

    // توثيق في audit_log (صف لكل حساب — كل رقم قابل للتتبع) — بلا كلمات مرور نهائيًا
    let audited = 0;
    try {
        const dbw = new Database(DB_PATH);
        const stmt = dbw.prepare(
            "INSERT INTO audit_log (user_id, user_name, action, detail, type) VALUES (?, ?, ?, ?, ?)"
        );
        const insertAll = dbw.transaction((rows) => {
            for (const row of rows) {
                stmt.run('provision-script', 'توفيق جماعي', 'user_create',
                    'إنشاء حساب ' + row.name + ' (' + row.code + ') · الدور: مستخدم قراءة · كلمة مرور أولية = الكود الوظيفي (لم تُسجَّل) · صلاحيات ممنوحة: لا شيء',
                    'permissions');
            }
        });
        insertAll(created);
        audited = created.length;
        dbw.close();
    } catch (e) {
        console.error('⚠️  فشل توثيق audit_log (الحسابات أُنشئت): ' + e.message);
    }

    db.close();

    console.log('\n══ التقرير ══');
    console.log('created:  ' + created.length);
    console.log('skipped:  ' + skipped.length + ' (حسابات قائمة — لم تُمس)');
    console.log('failed:   ' + failed.length);
    console.log('audited:  ' + audited);
    if (conflicts.length) {
        console.log('conflicts:');
        for (const c of conflicts) console.log('  ! ' + c.code + ' · ' + c.name + ' · ' + c.reason);
    }
    if (failed.length) {
        for (const f of failed) console.log('  ✗ ' + f.code + ' · ' + f.name + ' · ' + f.reason);
    }
    console.log('\nإجمالي الحسابات الآن: ' + users.length);
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
