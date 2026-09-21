#!/usr/bin/env node
/**
 * ═══ preview-seed.js — زرع بيانات مراجعة P3 الاصطناعية على Render PR Preview فقط ═══
 * (مواصفة معتمدة من المالك 2026-09-21 — SPEC-PREVIEW-SEED.md، بتحققات الكود اللاحقة)
 *
 * الهدف: الحد الأدنى من البيانات الاصطناعية لمراجعة P3 بصريًا على الـPR Preview:
 *   تسجيل دخول (admin/director) · مناوبة نشطة · كادر فرق · قرارات حالة الفرق ·
 *   3 بلاغات بإحداثيات.
 *
 * ما يثبت مصدره من الكود (لا افتراضات):
 *   · حالة الفريق على الخريطة = قرار المشرف في shift_team_status فقط
 *     (staffing-events-service.js:1459) — team_id فيه هو اسم الفريق حرفيًا:
 *     getTeamDecisions تقرأه عبر canonicalTeamId وتُطابَق مع t.name
 *     (staffing-events-service.js:477-482)، والكتابة الإنتاجية تستلم أسماء
 *     الفرق من واجهة التكميل. تخزين المعرف الرقمي هنا يكسر المطابقة.
 *   · أعضاء الفريق (members/activeCount) = shift_roster ⋈ employees فقط
 *     (staffing-events-service.js:1201-1228 «SR-2: roster فقط — لا بديل») —
 *     فريق بلا كادر مجدول لا يدخل الحالة إطلاقًا (1317). أحداث staffing في
 *     operational_events لا تبني الكادر ولا الحالة، فلا يزرع هذا السكربت منها
 *     شيئًا.
 *   · البلاغات على الخريطة = incident_registry حصرًا (storage-adapter.js:261
 *     ← report-service.js:662 ← server.js:5287 /api/cad-reports) وأعمدة
 *     lat/lng/status موجودة فيه (db.js:1113-1118).
 *   · vehicleOk يُقرأ من أحداث vehicle غير المحصورة بالمناوبة (1264-1281) —
 *     زرع V-A القائم يكفي: veh_000017 (سريع 4) breakdown ← حمراء بالمركبة.
 *
 * One-shot / fail-closed (قرار المالك): إذا وُجدت أي بيانات قبل الزرع يرفض
 * التنفيذ بالكامل — لا إصلاح ولا دمج ولا إعادة زرع لقاعدة قائمة.
 *
 * الحراسات المانعة (كلها تسبق أي كتابة):
 *   1) IS_PULL_REQUEST === 'true'        — لا يعمل خارج PR Preview إطلاقًا.
 *   2) RENDER_DISK_PATH مضبوط            — نفس حسم STORAGE_PATH في server.js:545.
 *   3) PREVIEW_ADMIN_PASSWORD / PREVIEW_DIRECTOR_PASSWORD من env — لا قيم مضمّنة.
 *   4) القاعدة بكر: users/employees/reports/shifts/shift_roster/
 *      incident_registry/shift_team_status كلها صفر، ولا أحداث staffing مسبقة
 *      (أحداث V-A للمركبات فقط هي المسموح بقاؤها).
 *   5) teams.center ⊆ مراكز SSOT (config/operational-centers.json) — فشل = إيقاف.
 *
 * لا يقرأ ولا يكتب خارج قاعدة STORAGE_PATH المحلية. لا PII ولا بيانات إنتاج.
 *
 * التشغيل (من Shell الـPreview فقط):  node scripts/preview-seed.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ─── الحارس 1: PR Preview فقط ───
if (process.env.IS_PULL_REQUEST !== 'true') {
    console.error('⛔ مرفوض: IS_PULL_REQUEST !== "true" — هذا السكربت يعمل على Render PR Preview فقط.');
    process.exit(1);
}

// ─── الحارس 2: مسار التخزين الصريح (نفس أولوية server.js/db.js) ───
const STORAGE_PATH = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || null;
if (!STORAGE_PATH) {
    console.error('⛔ مرفوض: RENDER_DISK_PATH/DATA_DIR غير مضبوط — تشغيل غير مقصود خارج بيئة الـPreview.');
    process.exit(1);
}

// ─── الحارس 3: كلمات المرور من env حصرًا ───
const ADMIN_PASSWORD = process.env.PREVIEW_ADMIN_PASSWORD;
const DIRECTOR_PASSWORD = process.env.PREVIEW_DIRECTOR_PASSWORD;
if (!ADMIN_PASSWORD || !DIRECTOR_PASSWORD) {
    console.error('⛔ مرفوض: PREVIEW_ADMIN_PASSWORD و PREVIEW_DIRECTOR_PASSWORD مطلوبتان في Environment — لا قيم افتراضية مضمّنة.');
    process.exit(1);
}

const DB_PATH = path.join(STORAGE_PATH, 'ambulance.db');
if (!fs.existsSync(DB_PATH)) {
    console.error(`⛔ مرفوض: لا توجد قاعدة في ${DB_PATH} — أقلع الخدمة أولًا حتى تُنشئ المخطط.`);
    process.exit(1);
}

let Database, bcrypt;
try {
    Database = require('better-sqlite3');
    bcrypt = require('bcryptjs');
} catch (e) {
    console.error('⛔ مرفوض: better-sqlite3/bcryptjs غير متاحة — شغّل من جذر الخدمة حيث node_modules موجودة.');
    process.exit(1);
}

const db = new Database(DB_PATH); // WAL — تعايش آمن مع الخدمة العاملة
const now = new Date().toISOString();
const saudiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const saudiMonth = parseInt(saudiToday.slice(5, 7), 10);
const saudiYear = parseInt(saudiToday.slice(0, 4), 10);

const scalar = (sql) => db.prepare(sql).get().c;
const fail = (msg) => { console.error('⛔ مرفوض: ' + msg); db.close(); process.exit(1); };

// ─── الحارس 4: القاعدة بكر (one-shot / fail-closed) ───
const pristineChecks = {
    users: scalar('SELECT COUNT(*) AS c FROM users'),
    employees: scalar('SELECT COUNT(*) AS c FROM employees'),
    reports: scalar('SELECT COUNT(*) AS c FROM reports'),
    shifts: scalar('SELECT COUNT(*) AS c FROM shifts'),
    shift_roster: scalar('SELECT COUNT(*) AS c FROM shift_roster'),
    incident_registry: scalar('SELECT COUNT(*) AS c FROM incident_registry'),
    staffing_events: scalar(`SELECT COUNT(*) AS c FROM operational_events WHERE domain = 'staffing'`),
};
// shift_team_status قد لا يكون أُنشئ بعد (يُنشأ كسولًا) — يُفحص دفاعيًا
try {
    pristineChecks.shift_team_status = scalar('SELECT COUNT(*) AS c FROM shift_team_status');
} catch (_) {
    pristineChecks.shift_team_status = 0; // الجدول غائب = صفر بنيويًا
}
const dirty = Object.entries(pristineChecks).filter(([, v]) => v > 0);
if (dirty.length > 0) {
    console.error('⛔ مرفوض: القاعدة ليست بكرًا — one-shot/fail-closed. العدّات غير الصفرية:');
    for (const [k, v] of dirty) console.error(`   ${k} = ${v}`);
    console.error('   لا إصلاح ولا دمج ولا إعادة زرع. إن كانت هذه قاعدة Preview مزروعة مسبقًا فهي جاهزة أصلًا.');
    db.close();
    process.exit(1);
}

// ─── الحارس 5: teams.center ⊆ مراكز SSOT (مرآة فحص centers-geo-service) ───
const centersCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'operational-centers.json'), 'utf8'));
const geoNames = new Set(Object.keys(centersCfg.centers || {}));
const nonGeo = new Set(Object.keys(centersCfg.nonGeographicCenters || {})); // كائن: المفاتيح هي الأسماء
const teams = db.prepare('SELECT id, name, center, team_type, requiredPersonnel FROM teams ORDER BY sort_order').all();
if (teams.length === 0) fail('جدول teams فارغ — زرع DEFAULT_TEAMS الافتتاحي غير موجود (إقلاع غير مكتمل؟).');
const unknown = teams.filter(t => t.center && !geoNames.has(t.center) && !nonGeo.has(t.center));
if (unknown.length > 0) {
    console.error('⛔ مرفوض: مراكز فرق خارج SSOT:');
    for (const t of unknown) console.error(`   ${t.name} → ${t.center}`);
    db.close();
    process.exit(1);
}
console.log(`✅ حارس SSOT: ${teams.length} فريقًا، كل المراكز ضمن المرجع (جغرافية: ${geoNames.size}، غير جغرافية: ${[...nonGeo].join(' / ')}).`);

// ─── الزرع (معاملة واحدة: الكل أو لا شيء) ───
const SEED_ACTOR = 'preview-seed';
const SHIFT_CODE = 'D12'; // كود صباحي معتمد في القاموس الرسمي (DAY_ONLY_CODES) — يقبله isWorkDayCode للمناوبة الصباحية
const southTeams = teams.filter(t => t.team_type === 'جنوب' && t.center !== 'الفرق الإضافية'); // جنوب 1–12
const rapidTeams = teams.filter(t => t.team_type === 'سريع');                                  // سريع 1–4
const seedTeams = [...southTeams, ...rapidTeams];                                              // 16 فريقًا ميدانيًا

// تنويع الحالات المقصود (موثق في المواصفة §4):
const SKIP_DECISION = new Set(['جنوب 8']);      // بلا قرار ← pending الافتراضي
const MISSING_DECISION = new Set(['جنوب 9']);   // قرار missing

// 3 بلاغات اصطناعية داخل نطاق الرياض (إزاحة صغيرة عن مراكز من ملف SSOT)
const centerOf = (name) => (centersCfg.centers || {})[name].center;
const INCIDENTS = [
    { number: '99001', type: 'تجريبي', center: 'المنصورة', dLat: 0.004, dLng: 0.004, district: 'المنصورة' },
    { number: '99002', type: 'تجريبي', center: 'الحائر', dLat: -0.003, dLng: 0.005, district: 'الحائر' },
    { number: '99003', type: 'تجريبي', center: 'عكاظ', dLat: 0.005, dLng: -0.004, district: 'عكاظ' },
];

let memberSeq = 0;
const counts = { users: 0, shifts: 0, employees: 0, roster: 0, team_decisions: 0, incidents: 0 };

const runAll = db.transaction(() => {
    // ── 1) مستخدما المراجعة ──
    const insertUser = db.prepare(
        `INSERT INTO users (user_id, username, password, name, role, is_active, created_at, last_login)
         VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`);
    insertUser.run('preview-admin-001', 'preview_admin', bcrypt.hashSync(ADMIN_PASSWORD, 10), 'مدير مراجعة Preview', 'admin', now);
    insertUser.run('preview-director-001', 'preview_director', bcrypt.hashSync(DIRECTOR_PASSWORD, 10), 'مشرف مراجعة Preview', 'director', now);
    counts.users = 2;

    // ── 2) مناوبة نشطة بتاريخ اليوم ──
    // status='active' صراحةً: العمود افتراضه 'active' (db.js:1190) لكن getActiveShift
    // (storage-adapter.js:32) يفلتر عليه — نرسله صراحةً فلا يعتمد الزرع على DEFAULT.
    const shiftRes = db.prepare(
        `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time,
         total_reports, general_notes, last_update, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?)`)
        .run('مناوبة مراجعة P3 (Preview)', saudiToday, '08:00', 'صباحية', 'مراجعة', now,
            'مناوبة اصطناعية لمراجعة P3 على PR Preview — أنشأها preview-seed.js', now, now, now);
    const shiftId = shiftRes.lastInsertRowid;
    counts.shifts = 1;

    // ── 3) الكادر: employees + shift_roster (المصدر الوحيد لأعضاء الفرق — SR-2) ──
    // team_id رقمي هنا (FK إلى teams.id) بخلاف shift_team_status الذي مفتاحه الاسم.
    const insertEmployee = db.prepare(
        `INSERT INTO employees (employee_code, name, phone, job_title, is_active, created_at)
         VALUES (?, ?, NULL, 'مسعف', 1, ?)`);
    const insertRoster = db.prepare(
        `INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const t of seedTeams) {
        const size = t.team_type === 'سريع' ? 1 : 2; // requiredPersonnel: سريع=1
        for (let i = 0; i < size; i++) {
            memberSeq++;
            const code = `TST-${String(memberSeq).padStart(3, '0')}`;
            const name = `عضو تجريبي ${String(memberSeq).padStart(2, '0')}`;
            const empId = insertEmployee.run(code, name, now).lastInsertRowid;
            insertRoster.run(empId, t.id, saudiToday, SHIFT_CODE, saudiMonth, saudiYear, now);
            counts.employees++;
            counts.roster++;
        }
    }

    // ── 4) قرارات حالة الفرق — المصدر الوحيد لحالة الفريق على الخريطة ──
    // team_id هنا = اسم الفريق حرفيًا (t.name) وليس المعرف الرقمي — مطابق للمسار
    // الإنتاجي حرفيًا: getTeamDecisions تقرأ العمود عبر canonicalTeamId ثم تُطابَق
    // مع t.name (staffing-events-service.js:477-482 ← 1459)، والكتابة الإنتاجية
    // (_upsertDecision ← 912/1066) تستلم مفاتيح واجهة التكميل وهي أسماء الفرق
    // (أو rapid_N التي تُطبَّع إلى «سريع N»). تخزين الرقم هنا يكسر المطابقة.
    const insertDecision = db.prepare(
        `INSERT INTO shift_team_status (shift_id, team_id, status, reason, updated_by, updated_at, crew_key)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`);
    for (const t of seedTeams) {
        if (SKIP_DECISION.has(t.name)) continue; // جنوب 8: بلا قرار ← pending
        const status = MISSING_DECISION.has(t.name) ? 'missing' : 'ready';
        insertDecision.run(shiftId, t.name, status,
            status === 'missing' ? 'زرع مراجعة Preview — فرقة ناقصة اصطناعية' : null,
            SEED_ACTOR, now);
        counts.team_decisions++;
    }

    // ── 5) ثلاثة بلاغات اصطناعية بإحداثيات ──
    const insertIncident = db.prepare(
        `INSERT INTO incident_registry (shift_id, number, code, type, source, created_at, cad_created_at,
         address, district, lat, lng, status, description)
         VALUES (?, ?, NULL, ?, 'preview-seed', ?, ?, ?, ?, ?, ?, 'active', ?)`);
    for (const ic of INCIDENTS) {
        const [lat, lng] = centerOf(ic.center);
        insertIncident.run(shiftId, ic.number, ic.type, now, now,
            `موقع تجريبي قرب مركز ${ic.center}`, ic.district,
            lat + ic.dLat, lng + ic.dLng,
            'بلاغ اصطناعي لمراجعة طبقة البلاغات في الخريطة — لا يمثل حالة حقيقية');
        counts.incidents++;
    }
});

runAll();

// ─── ملخص نهائي للسجلات ───
console.log('');
console.log('════════════════ زرع مراجعة Preview اكتمل ════════════════');
console.log(`users=${counts.users} · shifts=${counts.shifts} · employees=${counts.employees} · roster=${counts.roster} · team_decisions=${counts.team_decisions} · incidents=${counts.incidents}`);
console.log(`المناوبة: «مناوبة مراجعة P3 (Preview)» — ${saudiToday} صباحية (active) · shift_code=${SHIFT_CODE}`);
console.log('الحالات المتوقعة على الخريطة: ready خضراء (14) · pending صفراء (جنوب 8) · missing حمراء (جنوب 9) · حمراء بمركبة معطلة (سريع 4 — من زرع V-A القائم).');
console.log('الدخول: preview_admin / preview_director (كلمات المرور من env).');
db.close();
