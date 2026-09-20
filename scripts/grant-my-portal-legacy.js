#!/usr/bin/env node
// ============================================
// grant-my-portal-legacy.js — منحة ops.my_portal للحسابات التشغيلية القديمة
// (اعتماد المالك 2026-09-20 — المجموعة A من المعاينة: 16 حسابًا)
//
// الحماية (بقرار المالك): لا قائمة أكواد ثابتة كحارس وحيد — الأهلية تُفحص
// لكل حساب وقت التنفيذ نفسه، وكل شرط من الشروط الأربعة إلزامي:
//   1) الدور operator أو field_leadership حصرًا.
//   2) الدور ليس نجمة ('*') — sysadmin/admin يجتازون بدورهم ولا يُمسّون.
//   3) username يقابل موظفًا نشطًا (employee_code).
//   4) لا منحة ops.my_portal قائمة (granted=1) — ومن سُحبت منحته (granted=0)
//      يُعاد منحه بتحديث الصف لا بإدراج جديد.
// من تغيّر وضعه بين المعاينة والتنفيذ يُتخطى ويُبلَّغ — لا يُمنح.
// لا يُلمس: sysadmin · admin · user · أي حامل منحة قائمة · حسابات التوفيق.
// معاملة واحدة (كلها أو لا شيء) + توثيق audit_log لكل حساب.
// لا إبطال جلسات: getEffective بلا كاش فيُحتسب فورًا سيرفريًا؛ والتطبيق
// يلتقطها عند أول دخول/تحديث صلاحيات.
//
// التشغيل:
//   node scripts/grant-my-portal-legacy.js            ← معاينة فقط
//   node scripts/grant-my-portal-legacy.js --apply    ← تنفيذ
// البيئة: DATA_DIR وDB_PATH — افتراضيًا data/ وdata/ambulance.db.
// ============================================
'use strict';

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ambulance.db');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const PERM = 'ops.my_portal';
const GRANTED_BY = 'owner-approved legacy my_portal 2026-09-20';
const ELIGIBLE_ROLES = new Set(['operator', 'field_leadership']);

const { ROLE_LABELS, ROLES_PERMISSIONS } = require('../config/permissions');

function isStarRole(role) {
    const d = ROLES_PERMISSIONS[role];
    return Array.isArray(d) && d.indexOf('*') !== -1;
}

function main() {
    console.log('══ منحة ops.my_portal للحسابات التشغيلية القديمة — ' + (APPLY ? 'تنفيذ فعلي (--apply)' : 'معاينة فقط (dry-run)') + ' ══');
    console.log('DATA_DIR: ' + DATA_DIR);
    console.log('DB_PATH:  ' + DB_PATH);

    if (!fs.existsSync(DB_PATH)) { console.error('❌ قاعدة البيانات غير موجودة: ' + DB_PATH); process.exit(1); }
    if (!fs.existsSync(USERS_PATH)) { console.error('❌ users.json غير موجود: ' + USERS_PATH); process.exit(1); }

    const Database = require('better-sqlite3');
    const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    const db = new Database(DB_PATH);

    const empByCode = db.prepare('SELECT name, job_title, COALESCE(is_active,1) AS active FROM employees WHERE employee_code = ?');
    const permRow = db.prepare('SELECT granted FROM user_permissions WHERE user_id = ? AND permission_key = ?');

    // فحص الأهلية لحساب واحد — يُستدعى في المعاينة ويُعاد استدعاؤه وقت التنفيذ
    function evaluate(u) {
        const role = String(u.role || '');
        if (!ELIGIBLE_ROLES.has(role)) {
            return { ok: false, why: isStarRole(role) ? 'دور نجمة — يجتاز بدوره' : 'دور خارج operator/field_leadership (' + (role || '—') + ')' };
        }
        if (isStarRole(role)) return { ok: false, why: 'دور نجمة — يجتاز بدوره' };
        const emp = empByCode.get(String(u.username));
        if (!emp || !emp.active) return { ok: false, why: 'لا يقابل موظفًا نشطًا' };
        const row = permRow.get(String(u.id), PERM);
        if (row && row.granted) return { ok: false, why: 'المنحة موجودة أصلًا' };
        return { ok: true, emp, regrant: !!row, role };
    }

    const eligible = [], skipped = [];
    for (const u of users) {
        const r = evaluate(u);
        if (r.ok) eligible.push({ u, ...r });
        else skipped.push({ u, why: r.why });
    }

    console.log('\nإجمالي الحسابات: ' + users.length);
    console.log('مؤهلون للمنحة الآن: ' + eligible.length);
    console.log('مُتخطَّون: ' + skipped.length);

    console.log('\n— المؤهلون (سيُمنحون عند --apply) —');
    for (const e of eligible) {
        console.log('  ✦ ' + e.u.username + ' | ' + (e.u.name || '—') +
            ' | الدور: ' + e.role + ' (' + (ROLE_LABELS[e.role] || e.role) + ')' +
            ' | الموظف: ' + e.emp.name + ' · ' + (e.emp.job_title || '—') + ' · نشط' +
            (e.regrant ? ' | إعادة منح بعد سحب سابق' : ''));
    }
    console.log('\n— المتخطَّون (لن يُمسّوا) —');
    for (const s of skipped) console.log('  · ' + s.u.username + ' | ' + (s.u.name || '—') + ' | ' + s.why);

    if (!APPLY) {
        console.log('\nلا كتابة. أعد التشغيل مع --apply للتنفيذ.');
        db.close();
        process.exit(0);
    }
    if (eligible.length === 0) {
        console.log('\nلا أحد مؤهل — لا شيء للتنفيذ.');
        db.close();
        process.exit(0);
    }

    const grantPerm = db.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)');
    const regrant = db.prepare('UPDATE user_permissions SET granted = 1, granted_by = ? WHERE user_id = ? AND permission_key = ?');
    const audit = db.prepare('INSERT INTO audit_log (user_id, user_name, action, detail, type) VALUES (?, ?, ?, ?, ?)');

    let granted = 0, mismatch = 0, audited = 0;
    const report = [];
    const runAll = db.transaction(() => {
        for (const e of eligible) {
            // إعادة فحص الأهلية داخل المعاملة — من تغيّر وضعه يُتخطى (بند المالك 6)
            const recheck = evaluate(e.u);
            if (!recheck.ok) { mismatch++; report.push('  ⤫ ' + e.u.username + ' → تخطّي (تغيّر الوضع: ' + recheck.why + ')'); continue; }
            if (recheck.regrant) regrant.run(GRANTED_BY, String(e.u.id), PERM);
            else grantPerm.run(String(e.u.id), PERM, GRANTED_BY);
            granted++;
            report.push('  ✓ ' + e.u.username + ' → قبل: ops.my_portal غائبة → بعد: ممنوحة' + (recheck.regrant ? ' (إعادة منح)' : ''));
            audit.run('grant-script', 'منحة my_portal للحسابات القديمة', 'permission_grant',
                'منحة ops.my_portal لـ' + e.emp.name + ' (' + e.u.username + ') · دور ' + e.role + ' · حساب تشغيلي قديم مرتبط بموظف نشط · اعتماد المالك 2026-09-20',
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

    console.log('\n══ نتيجة كل حساب ══');
    for (const line of report) console.log(line);
    console.log('\n══ التقرير ══');
    console.log('granted:          ' + granted);
    console.log('skipped (تغيّر):  ' + mismatch);
    console.log('audited:          ' + audited);
    console.log('untouched:        ' + (skipped.length + mismatch));
    console.log('sessions revoked: 0 (تُحتسب فورًا سيرفريًا · التطبيق يلتقطها عند الدخول التالي)');
    process.exit(0);
}

try { main(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
