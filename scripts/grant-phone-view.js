#!/usr/bin/env node
// ============================================
// grant-phone-view.js — منحة staff.phone_view للقيادة والعمليات
// (اعتماد المالك 2026-09-20): الجوال في «زملائي/التكميل/الحوض/المرشحين»
// لا يصل إلا لحامل staff.phone_view أو admin.users_manage (بوابة 474aba5).
// هذه المنحة للحسابات التي تستخدم التكميل والقيادة فقط — 19 حسابًا بقائمة
// أكواد وظيفية ثابتة اعتمدها المالك، لا استنتاج ولا توسيع.
//
// الضمانات:
//   · dry-run افتراضي — لا كتابة إلا مع --apply.
//   · لا يغيّر أي صلاحية أخرى ولا يزيل أي منحة قائمة ولا ينشئ حسابات.
//   · الاستهداف بالكود الوظيفي (username = employee_code) لا بالاسم.
//   · حارس مزدوج: يُرفض أي كود لا يقابل موظفًا نشطًا بمسمى قيادة/عمليات
//     بالمطابقة التامة (حماية من خطأ إدراج في القائمة).
//   · حساب 102462 غير مدرج عمدًا — admin.users_manage تكشف الجوالات أصلًا.
//   · كل الكتابات في معاملة واحدة: كلها أو لا شيء + توثيق audit_log.
//   · لا إبطال جلسات: getEffective يقرأ المنح من القاعدة في كل طلب
//     (بلا كاش) — الأثر فوري دون إخراج القيادة من جلساتهم أثناء المناوبة.
//
// التشغيل:
//   node scripts/grant-phone-view.js            ← معاينة فقط
//   node scripts/grant-phone-view.js --apply    ← تنفيذ
// البيئة: DATA_DIR وDB_PATH — افتراضيًا data/ وdata/ambulance.db.
// ============================================
'use strict';

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ambulance.db');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const PERM = 'staff.phone_view';
const GRANTED_BY = 'owner-approved phone_view 2026-09-20';

// القائمة المعتمدة من المالك (19) — قيادة ميدانية + عمليات بالمطابقة التامة
const TARGET_CODES = [
    // تحكم عملياتي (4)
    '8323', '101886', '101915', '101353',
    // تنسيق استجابة (5)
    '10373', '4252', '10717', '11120', '102752',
    // كبير مسعفين (5)
    '8745', '6263', '692', '6182', '8968',
    // مساعد كبير مسعفين (5)
    '9666', '61277', '61296', '7454', '11079'
];
const ALLOWED_TITLES = new Set([
    'كبير مسعفين', 'مساعد كبير المسعفين', 'مساعد كبير مسعفين',
    'تحكم عملياتي', 'تنسيق الاستجابة', 'تنسيق استجابة'
]);

function main() {
    console.log('══ منحة staff.phone_view للقيادة والعمليات — ' + (APPLY ? 'تنفيذ فعلي (--apply)' : 'معاينة فقط (dry-run)') + ' ══');
    console.log('DATA_DIR: ' + DATA_DIR);
    console.log('DB_PATH:  ' + DB_PATH);

    if (!fs.existsSync(DB_PATH)) { console.error('❌ قاعدة البيانات غير موجودة: ' + DB_PATH); process.exit(1); }
    if (!fs.existsSync(USERS_PATH)) { console.error('❌ users.json غير موجود: ' + USERS_PATH); process.exit(1); }

    const Database = require('better-sqlite3');
    const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    const byUsername = {};
    for (const u of users) byUsername[String(u.username)] = u;

    const db = new Database(DB_PATH);
    const empByCode = db.prepare('SELECT name, job_title, COALESCE(is_active,1) AS active FROM employees WHERE employee_code = ?');
    const hasPerm = db.prepare('SELECT granted FROM user_permissions WHERE user_id = ? AND permission_key = ?');

    let needGrant = 0, already = 0, conflicts = 0;
    const plan = [];
    console.log('\nالمستهدف: ' + TARGET_CODES.length + ' حسابًا');
    for (const code of TARGET_CODES) {
        const u = byUsername[code];
        if (!u) {
            conflicts++;
            plan.push({ code, status: 'conflict', note: 'لا يوجد حساب بهذا الكود — لا إنشاء (بقرار المالك)' });
            continue;
        }
        const emp = empByCode.get(code);
        if (!emp || !emp.active || !ALLOWED_TITLES.has(emp.job_title || '')) {
            conflicts++;
            plan.push({ code, status: 'conflict', note: 'الموظف غير نشط أو مسماه خارج قيادة/عمليات: ' + (emp ? (emp.job_title || '—') : 'غير موجود') });
            continue;
        }
        const existing = hasPerm.get(String(u.id), PERM);
        if (existing && existing.granted) {
            already++;
            plan.push({ code, status: 'already', name: emp.name, title: emp.job_title, role: u.role });
        } else {
            needGrant++;
            plan.push({ code, status: existing ? 'regrant' : 'grant', id: String(u.id), name: emp.name, title: emp.job_title, role: u.role });
        }
    }

    console.log('\n— التفصيل —');
    for (const p of plan) {
        if (p.status === 'conflict') console.log('  ⚠ ' + p.code + ' · ' + p.note);
        else if (p.status === 'already') console.log('  = ' + p.code + ' · ' + p.name + ' · ' + p.title + ' · المنحة موجودة مسبقًا');
        else console.log('  + ' + p.code + ' · ' + p.name + ' · ' + p.title + ' · role=' + p.role + (p.status === 'regrant' ? ' · إعادة منح بعد إلغاء سابق' : ''));
    }
    console.log('\nيحتاج المنحة: ' + needGrant);
    console.log('موجودة مسبقًا: ' + already);
    console.log('تعارضات: ' + conflicts);

    if (!APPLY) {
        console.log('\nلا كتابة. أعد التشغيل مع --apply للتنفيذ.');
        db.close();
        process.exit(conflicts > 0 ? 2 : 0);
    }
    if (conflicts > 0) {
        console.error('\n❌ توجد تعارضات — أُوقف التنفيذ حمايةً. راجع المعاينة أولًا.');
        db.close();
        process.exit(2);
    }
    if (needGrant === 0) {
        console.log('\nلا شيء للتنفيذ — كل المستهدفين يحملون المنحة أصلًا.');
        db.close();
        process.exit(0);
    }

    const grantPerm = db.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)');
    const regrant = db.prepare('UPDATE user_permissions SET granted = 1, granted_by = ? WHERE user_id = ? AND permission_key = ?');
    const audit = db.prepare('INSERT INTO audit_log (user_id, user_name, action, detail, type) VALUES (?, ?, ?, ?, ?)');

    let granted = 0, audited = 0;
    const runAll = db.transaction(() => {
        for (const p of plan) {
            if (p.status !== 'grant' && p.status !== 'regrant') continue;
            if (p.status === 'regrant') regrant.run(GRANTED_BY, p.id, PERM);
            else grantPerm.run(p.id, PERM, GRANTED_BY);
            granted++;
            audit.run('grant-script', 'منحة phone_view جماعية', 'permission_grant',
                'منحة staff.phone_view لـ' + p.name + ' (' + p.code + ') · ' + p.title + ' · قائمة المالك المعتمدة 2026-09-20 · بلا مساس بأي صلاحية أخرى',
                'permissions');
            audited++;
        }
    });

    try {
        runAll();
    } catch (e) {
        console.error('❌ فشلت المعاملة ورُدّت بالكامل — لم تُكتب أي منحة: ' + e.message);
        db.close();
        process.exit(1);
    }
    db.close();

    console.log('\n══ التقرير ══');
    console.log('staff.phone_view granted: ' + granted);
    console.log('audited:                  ' + audited);
    console.log('already held (untouched): ' + already);
    console.log('sessions revoked:         0 (الأثر فوري — getEffective بلا كاش)');
    console.log('إجمالي حاملي المنحة الآن: ' + (already + granted));
    process.exit(0);
}

try { main(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
