#!/usr/bin/env node
// ============================================
// preview-my-portal-grants.js — معاينة فقط (قرار المالك 2026-09-20)
// يعرض الحسابات القديمة (ما قبل التوفيق الجماعي) ووضع ops.my_portal فيها،
// ليراجع المالك القائمة قبل أي منح. **لا يكتب شيئًا إطلاقًا — لا يوجد
// وضع --apply في هذا السكربت عمدًا.**
//
// تعريف «الحساب القديم»: من لا يحمل منحة ops.my_portal بتوقيع الترقية
// الجماعية (granted_by = 'owner-approved bulk 2026-09-20') — تلك علامة
// الحسابات الـ125 الموفَّقة. كل ما عداها قديم، فيُعرض للمراجعة.
//
// الاقتراح آلي وشفاف (للمراجعة لا للتنفيذ):
//   · يقترح المنح: حساب يقابل موظفًا نشطًا (username = employee_code)
//     ولا يحمل المنحة ولا يجتاز البوابة بدوره.
//   · تخطي: لا يقابل موظفًا نشطًا، أو المنحة موجودة أصلًا، أو دوره '*'
//     (sysadmin/admin يجتاز authorizePerm تلقائيًا عبر النجمة — المنحة
//     زائدة عن الحاجة له؛ ops.my_portal مصممة منحة فردية لحسابات
//     الموظفين التشغيلية، ولا يحملها أي دور).
//   · المخرجات تُجمَّع: A حسابات تشغيلية (operator/field_leadership) ·
//     B أدوار النجمة (sysadmin/admin) · C غيرها — وتُظهر حالة الموظف
//     (نشط/غير نشط) صراحة.
//
// التشغيل: node scripts/preview-my-portal-grants.js
// البيئة: DATA_DIR وDB_PATH — افتراضيًا data/ وdata/ambulance.db.
// ============================================
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ambulance.db');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const BULK_MARKER = 'owner-approved bulk 2026-09-20';

const { ROLE_LABELS, ROLES_PERMISSIONS } = require('../config/permissions');

/// دور نجمة؟ ('*' ضمن افتراضيات الدور — sysadmin/admin)
function isStarRole(role) {
    const d = ROLES_PERMISSIONS[role];
    return Array.isArray(d) && d.indexOf('*') !== -1;
}
/// هل يحمل الدور مفاتيح ops.* افتراضيًا؟
function roleOpsKeys(role) {
    if (isStarRole(role)) return '* (كل المفاتيح)';
    const d = ROLES_PERMISSIONS[role] || [];
    const ops = d.filter(k => k.startsWith('ops.'));
    return ops.length ? ops.join(', ') : 'لا شيء';
}

function main() {
    console.log('══ معاينة منحة ops.my_portal للحسابات القديمة — قراءة فقط ══');
    console.log('DATA_DIR: ' + DATA_DIR);
    console.log('DB_PATH:  ' + DB_PATH);

    if (!fs.existsSync(DB_PATH)) { console.error('❌ قاعدة البيانات غير موجودة: ' + DB_PATH); process.exit(1); }
    if (!fs.existsSync(USERS_PATH)) { console.error('❌ users.json غير موجود: ' + USERS_PATH); process.exit(1); }

    const Database = require('better-sqlite3');
    const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    const db = new Database(DB_PATH, { readonly: true });

    const empByCode = db.prepare('SELECT name, job_title, COALESCE(is_active,1) AS active FROM employees WHERE employee_code = ?');
    const permRows = db.prepare("SELECT user_id, granted, granted_by FROM user_permissions WHERE permission_key = 'ops.my_portal'").all();

    const bulkUpgraded = new Set();
    const hasPortal = new Set();
    for (const r of permRows) {
        if (r.granted_by === BULK_MARKER) bulkUpgraded.add(String(r.user_id));
        if (r.granted) hasPortal.add(String(r.user_id));
    }

    const oldAccounts = users.filter(u => !bulkUpgraded.has(String(u.id)));
    const newAccounts = users.length - oldAccounts.length;

    console.log('\nإجمالي الحسابات: ' + users.length);
    console.log('حسابات التوفيق الجماعي (مستبعدة — تحمل المنحة أصلًا): ' + newAccounts);
    console.log('الحسابات القديمة موضوع المراجعة: ' + oldAccounts.length);

    // تجميع: A تشغيلية (operator/field_leadership) · B أدوار النجمة · C غيرها
    const groups = { A: [], B: [], C: [] };
    for (const u of oldAccounts) {
        const role = String(u.role || '');
        const g = (role === 'operator' || role === 'field_leadership') ? 'A' : (isStarRole(role) ? 'B' : 'C');
        groups[g].push(u);
    }

    let suggest = 0, skipNoEmp = 0, skipHas = 0, skipStar = 0;
    const GROUP_TITLES = {
        A: 'A — الحسابات التشغيلية (operator / field_leadership)',
        B: 'B — أدوار النجمة (sysadmin / admin) — يجتازون البوابة بدورهم',
        C: 'C — أدوار أخرى'
    };
    for (const g of ['A', 'B', 'C']) {
        if (!groups[g].length) continue;
        console.log('\n— ' + GROUP_TITLES[g] + ' (' + groups[g].length + ') —');
        for (const u of groups[g]) {
            const role = String(u.role || '');
            const roleLabel = ROLE_LABELS[role] || role || '—';
            const emp = empByCode.get(String(u.username));
            const linked = emp && emp.active;
            const granted = hasPortal.has(String(u.id));
            const star = isStarRole(role);
            let verdict;
            if (!linked) { skipNoEmp++; verdict = 'تخطي — لا يقابل موظفًا نشطًا'; }
            else if (granted) { skipHas++; verdict = 'تخطي — المنحة موجودة أصلًا'; }
            else if (star) { skipStar++; verdict = 'تخطي — يجتاز البوابة عبر الدور (*) بلا حاجة لمنحة'; }
            else { suggest++; verdict = '✦ يقترح المنح'; }
            console.log('  ' + String(u.username) +
                ' | ' + (u.name || '—') +
                ' | الدور: ' + role + ' (' + roleLabel + ')' +
                ' | الموظف: ' + (emp ? emp.name + ' · ' + (emp.job_title || '—') + ' · ' + (emp.active ? 'نشط' : 'غير نشط') : 'لا يقابل موظفًا') +
                ' | ops.*: ' + roleOpsKeys(role) +
                ' | ops.my_portal: ' + (granted ? 'موجودة (منحة)' : star ? 'فعّالة عبر (*)' : 'غائبة') +
                ' | ' + verdict);
        }
    }
    db.close();

    console.log('\n══ الملخص ══');
    console.log('يقترح المنح:              ' + suggest);
    console.log('تخطي (بلا موظف نشط):      ' + skipNoEmp);
    console.log('تخطي (منحة قائمة):        ' + skipHas);
    console.log('تخطي (نجمة الدور تكفي):   ' + skipStar);
    console.log('\nمعاينة فقط — لا كتابة ولا --apply في هذا السكربت. القرار للمالك.');
    process.exit(0);
}

try { main(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
