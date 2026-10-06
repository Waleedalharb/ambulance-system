// ═══ E-4 (FSS): اختبار خدمتي Coverage الموحدة + Validation — بيئة معزولة ═══
// نسخة VACUUM مؤقتة — لا يلمس data/ الحقيقية. اختبار على مستوى الخدمات
// مباشرة (لا Endpoints في E-4 — قرار ج1). يغطي قائمة المالك حرفيًا:
// Coverage: 2/2/8 pass · day/night/total below fail · team override ·
// team→center · overnight · عقد E-2 (الغلاف الرقيق) · Validation: راحة 8س
// pass/fail · overnight temporal · overlap · next-day · 3 ليالٍ pass/4 fail ·
// config-driven · إجازة معتمدة · عدم تمكّن محسوم/معلق/مرفوض/ملغي (ج2) ·
// تفريق ج3 (valid/wouldBreak/met/still_below) · Integrity: صفر كتابة
// shift_roster + صفر تغيير مخطط.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e4-'));
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');

function riyadhOffset(n) {
    const p = TimeRiyadh.riyadhParts(new Date());
    const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + n));
    return d.toISOString().slice(0, 10);
}
const fp = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');

async function main() {
    console.log('═══ E-4 COVERAGE + VALIDATION TEST — بيئة معزولة (مستوى الخدمات) ═══');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));

    process.env.DB_PATH = TMP_DB;
    process.env.DATA_DIR = TMP_DATA;
    const db = require(path.join(ROOT, 'db.js'));
    await db.init(false);
    const coverageService = require(path.join(ROOT, 'services', 'schedule-engine', 'coverage-service.js'));
    const { validateAssignment } = require(path.join(ROOT, 'services', 'schedule-engine', 'validation-service.js'));

    // ── التهيئة: رموز اختبار بأوقات حتمية + فريق + موظفون ──
    const TEAM = (await db.get("SELECT id FROM teams WHERE name = 'جنوب 1'")).id;
    const TEAM2 = (await db.get('SELECT id FROM teams WHERE id != ? ORDER BY id LIMIT 1', [TEAM])).id;
    const TEAM_CENTER = (await db.get('SELECT center FROM teams WHERE id = ?', [TEAM])).center;
    const emps = (await db.all('SELECT id FROM employees WHERE is_active = 1 ORDER BY id LIMIT 12')).map(r => r.id);
    const [E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11, E12] = emps;

    const CODES = [
        ['E4D', 'يومي 07-19', '07:00', '19:00'],   // day
        ['E4N', 'ليلي 19-07', '19:00', '07:00'],   // night عابر لمنتصف الليل
        ['E4A', 'مسائي 16-23', '16:00', '23:00'],  // night
        ['E4B', 'فجري 05-13', '05:00', '13:00'],   // day
        ['E4L', 'طويل 20-08', '20:00', '08:00']    // night عابر
    ];
    for (const [code, name, ts, te] of CODES) {
        await db.run("INSERT OR REPLACE INTO shift_codes (code, name, time_start, time_end, status) VALUES (?, ?, ?, ?, 'دوام')", [code, name, ts, te]);
    }
    const nonWork = await db.get("SELECT code FROM shift_codes WHERE status != 'دوام' LIMIT 1");

    const marks = emps.map(() => '?').join(',');
    await db.run(`DELETE FROM team_assignments WHERE employee_id IN (${marks})`, emps);
    for (const id of emps) {
        if (id === E11) continue; // E11: بلا عضوية (سيناريو الأهلية)
        await db.run("INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary, source) VALUES (?, ?, '2026-01-01', NULL, 1, 'flex-e4-test')", [id, TEAM]);
    }
    await db.run('UPDATE employees SET is_active = 0 WHERE id = ?', [E12]); // E12: غير نشط

    // ── صفوف roster لكل السيناريوهات (تواريخ معزولة +40 فصاعدًا) ──
    const D = (n) => riyadhOffset(n);
    async function roster(empId, teamId, date, code) {
        await db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)',
            [empId, teamId, date, code, Number(date.slice(5, 7)), Number(date.slice(0, 4))]);
    }
    // D41: فريق كامل 5 يومي + 3 ليلي = 8
    for (const e of [E1, E2, E3, E4, E5]) await roster(e, TEAM, D(41), 'E4D');
    for (const e of [E6, E7, E8]) await roster(e, TEAM, D(41), 'E4N');
    // D42: 2 يومي + 2 ليلي = 4 (نقص total فقط)
    await roster(E1, TEAM, D(42), 'E4D'); await roster(E2, TEAM, D(42), 'E4D');
    await roster(E3, TEAM, D(42), 'E4N'); await roster(E4, TEAM, D(42), 'E4N');
    // D43: ليلي واحد (تصنيف overnight)
    await roster(E1, TEAM, D(43), 'E4N');
    // جيران الراحة/التداخل
    await roster(E1, TEAM, D(46), 'E4D');
    await roster(E1, TEAM, D(48), 'E4A');
    await roster(E1, TEAM, D(50), 'E4N');
    await roster(E1, TEAM, D(52), 'E4L');
    await roster(E1, TEAM, D(55), 'E4B');
    await roster(E1, TEAM, D(57), 'E4B');
    // ليالٍ متتالية (ن8: D59-60+مرشح D61 = 3 · ن9/ن10: D95-97+مرشح D98 = 4 — معزولة)
    await roster(E2, TEAM, D(59), 'E4N'); await roster(E2, TEAM, D(60), 'E4N');
    await roster(E2, TEAM, D(95), 'E4N'); await roster(E2, TEAM, D(96), 'E4N'); await roster(E2, TEAM, D(97), 'E4N');
    // مناوبة قائمة لسيناريو التعدد + رمز غير تغطية للغلاف
    await roster(E1, TEAM, D(72), 'E4D');
    await roster(E1, TEAM, D(90), nonWork.code);
    // D73: فريق ناقص 2/2/4 (سيناريو ج3-add)
    await roster(E1, TEAM, D(73), 'E4D'); await roster(E2, TEAM, D(73), 'E4D');
    await roster(E3, TEAM, D(73), 'E4N'); await roster(E4, TEAM, D(73), 'E4N');
    // D74: فريق مكتمل 5 يومي + 3 ليلي (سيناريو ج3-remove)
    for (const e of [E1, E2, E3, E4, E5]) await roster(e, TEAM, D(74), 'E4D');
    for (const e of [E6, E7, E8]) await roster(e, TEAM, D(74), 'E4N');

    // إجازات وعدم تمكّن لـE3
    await db.run("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status) VALUES (?, ?, ?, 'إجازة', 'approved')", [E3, D(66), D(66)]);
    await db.run("INSERT INTO leave_requests (employee_id, start_date, end_date, type, status) VALUES (?, ?, ?, 'إجازة', 'pending')", [E3, D(67), D(67)]);
    const uaIns = "INSERT INTO unable_attend_requests (employee_id, month, off_date, reason, status, is_exception, created_by) VALUES (?, ?, ?, NULL, ?, 0, 1)";
    await db.run(uaIns, [E3, D(68).slice(0, 7), D(68), 'auto_approved']);
    await db.run(uaIns, [E3, D(69).slice(0, 7), D(69), 'pending_review']);
    await db.run(uaIns, [E3, D(70).slice(0, 7), D(70), 'rejected']);
    await db.run(uaIns, [E3, D(71).slice(0, 7), D(71), 'cancelled']);

    // ── بصمتا النزاهة قبل أي استدعاء خدمة ──
    const rosterFpBefore = fp(await db.all('SELECT * FROM shift_roster ORDER BY rowid'));
    const schemaFpBefore = fp(await db.all("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"));

    // ═══ أ) Coverage ═══
    console.log('\n── Coverage: القواعد والاشتقاق ──');
    const full = await coverageService.computeCoverage(db, TEAM, D(41));
    check('ت1: 2/2/8 مكتملة (5 يومي + 3 ليلي = 8) ⇒ met=true بلا missing',
        full.met === true && full.missing.length === 0 && full.day === 5 && full.night === 3 && full.total === 8);
    check('ت2: المركز يُشتق من teams.center (SSOT — A-2)', full.center === TEAM_CENTER, String(full.center));
    const dayBreak = await coverageService.assessChange(db, { teamId: TEAM, date: D(41), removeEmployeeIds: [E1, E2, E3, E4] });
    check('ت3: day تحت الحد ⇒ wouldBreak=true + missing=[day]',
        dayBreak.wouldBreak === true && dayBreak.coverage_after.day === 1 && dayBreak.coverage_after.missing.includes('day'));
    const nightBreak = await coverageService.assessChange(db, { teamId: TEAM, date: D(41), removeEmployeeIds: [E6, E7] });
    check('ت4: night تحت الحد ⇒ wouldBreak=true + missing=[night]',
        nightBreak.wouldBreak === true && nightBreak.coverage_after.night === 1 && nightBreak.coverage_after.missing.includes('night'));
    const totalShort = await coverageService.computeCoverage(db, TEAM, D(42));
    check('ت5: total تحت الحد فقط (2/2/4) ⇒ met=false + missing=[total] حصرًا',
        totalShort.met === false && totalShort.missing.length === 1 && totalShort.missing[0] === 'total',
        JSON.stringify(totalShort.missing));
    await db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.coverage_team_overrides', ?)",
        [JSON.stringify({ [String(TEAM)]: { day: 1, night: 1, total: 2 } })]);
    const overridden = await coverageService.computeCoverage(db, TEAM, D(42));
    check('ت6: Team Override (1/1/2) يجعل نفس الواقع met=true', overridden.met === true);
    await db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.coverage_team_overrides', '{}')");
    const over = await coverageService.computeCoverage(db, TEAM, D(43));
    check('ت7: المناوبة العابرة لمنتصف الليل (E4N 19:00) تُصنّف night',
        over.night === 1 && over.day === 0);

    console.log('\n── Coverage: عقد E-2 عبر الغلاف الرقيق ──');
    const helper = require(path.join(ROOT, 'services', 'schedule-engine', 'coverage-helper.js'));
    const okImpact = await helper.assessRemovalImpact(db, E5, D(41));
    check('ت8: خروج من فريق عند الحد تمامًا (8/8) ⇒ assessable=true + wouldBreak=true (الإجمالي ينزل لـ7)',
        okImpact.assessable === true && okImpact.wouldBreak === true && okImpact.detail.after_removal.total === 7,
        JSON.stringify(okImpact.detail));
    const noRoster = await helper.assessRemovalImpact(db, E9, D(44));
    check('ت9: لا roster لليوم ⇒ assessable=false (no_roster_for_date)',
        noRoster.assessable === false && noRoster.detail.reason === 'no_roster_for_date');
    const nonCov = await helper.assessRemovalImpact(db, E1, D(90));
    check('ت10: مناوبة ليست تغطية ⇒ assessable=false (not_a_coverage_shift)',
        nonCov.assessable === false && nonCov.detail.reason === 'not_a_coverage_shift');

    // ═══ ب) Validation ═══
    console.log('\n── Validation: البنية والراحة الزمنية (M7) ──');
    const baseline = await validateAssignment(db, { employeeId: E5, date: D(45), shiftCode: 'E4D', operation: 'add' });
    check('ن1: سيناريو نظيف ⇒ valid=true + بنية منظمة (checks/reasons/coverage)',
        baseline.valid === true && Array.isArray(baseline.checks) && Array.isArray(baseline.reasons) &&
        baseline.checks.every(c => c.code && c.status) && baseline.coverage_before && baseline.coverage_after);
    const restPass = await validateAssignment(db, { employeeId: E1, date: D(47), shiftCode: 'E4D', operation: 'add' });
    check('ن2: راحة 12 ساعة (يومي←يومي) ⇒ REST_MINIMUM pass + valid',
        restPass.valid === true && restPass.checks.find(c => c.code === 'REST_MINIMUM').status === 'pass');
    const restFail = await validateAssignment(db, { employeeId: E1, date: D(49), shiftCode: 'E4B', operation: 'add' });
    check('ن3: راحة 6 ساعات (مسائي ينتهي 23:00 ← فجري 05:00) ⇒ REST_BELOW_MINIMUM + detail بالساعات',
        restFail.valid === false && restFail.reasons.includes('REST_BELOW_MINIMUM') &&
        restFail.checks.find(c => c.code === 'REST_MINIMUM').detail.rest_before_hours === 6);
    const overRest = await validateAssignment(db, { employeeId: E1, date: D(51), shiftCode: 'E4D', operation: 'add' });
    check('ن4: overnight temporal — ليلي (19→07) ثم يومي 07:00: راحة 0س بلا تداخل ⇒ REST fail فقط',
        overRest.reasons.includes('REST_BELOW_MINIMUM') && !overRest.reasons.includes('SHIFT_OVERLAP') &&
        overRest.checks.find(c => c.code === 'REST_MINIMUM').detail.rest_before_hours === 0 &&
        overRest.checks.find(c => c.code === 'OVERLAP').status === 'pass');
    const overlap = await validateAssignment(db, { employeeId: E1, date: D(53), shiftCode: 'E4D', operation: 'add' });
    check('ن5: تقاطع مع امتداد ليلي طويل (20→08) ⇒ SHIFT_OVERLAP',
        overlap.valid === false && overlap.reasons.includes('SHIFT_OVERLAP'));
    const nextConflict = await validateAssignment(db, { employeeId: E1, date: D(54), shiftCode: 'E4N', operation: 'add' });
    check('ن6: امتداد المرشحة يصطدم بفجري الغد 05:00 ⇒ NEXT_DAY_CONFLICT',
        nextConflict.valid === false && nextConflict.reasons.includes('NEXT_DAY_CONFLICT'));
    const nextRest = await validateAssignment(db, { employeeId: E1, date: D(56), shiftCode: 'E4A', operation: 'add' });
    check('ن7: راحة بعدية 6 ساعات (مسائي ← فجري الغد) ⇒ REST_BELOW_MINIMUM (rest_after=6)',
        nextRest.reasons.includes('REST_BELOW_MINIMUM') && !nextRest.reasons.includes('NEXT_DAY_CONFLICT') &&
        nextRest.checks.find(c => c.code === 'REST_MINIMUM').detail.rest_after_hours === 6);

    console.log('\n── Validation: الليالي المتتالية (M6) ──');
    const threeN = await validateAssignment(db, { employeeId: E2, date: D(61), shiftCode: 'E4N', operation: 'add' });
    check('ن8: 3 ليالٍ متتالية (الحد) ⇒ pass',
        threeN.checks.find(c => c.code === 'CONSECUTIVE_NIGHTS').status === 'pass' && threeN.valid === true);
    const fourN = await validateAssignment(db, { employeeId: E2, date: D(98), shiftCode: 'E4N', operation: 'add' });
    check('ن9: 4 ليالٍ متتالية ⇒ CONSECUTIVE_NIGHTS_EXCEEDED (run=4 > max=3)',
        fourN.valid === false && fourN.reasons.includes('CONSECUTIVE_NIGHTS_EXCEEDED') &&
        fourN.checks.find(c => c.code === 'CONSECUTIVE_NIGHTS').detail.run === 4);
    await db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.max_consecutive_nights', '4')");
    const fourCfg = await validateAssignment(db, { employeeId: E2, date: D(98), shiftCode: 'E4N', operation: 'add' });
    check('ن10: السقف Config-driven — رفعه لـ4 يجعل نفس الواقع pass',
        fourCfg.checks.find(c => c.code === 'CONSECUTIVE_NIGHTS').status === 'pass');
    await db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schedule_engine.max_consecutive_nights', '3')");

    console.log('\n── Validation: الإجازات وعدم التمكّن (ج2) ──');
    const lvAppr = await validateAssignment(db, { employeeId: E3, date: D(66), shiftCode: 'E4D', operation: 'add' });
    check('ن11: إجازة معتمدة تغطي اليوم ⇒ LEAVE_CONFLICT_APPROVED',
        lvAppr.valid === false && lvAppr.reasons.includes('LEAVE_CONFLICT_APPROVED'));
    const lvPend = await validateAssignment(db, { employeeId: E3, date: D(67), shiftCode: 'E4D', operation: 'add' });
    check('ن12: إجازة pending ⇒ warn فقط وvalid=true (ج2)',
        lvPend.valid === true && lvPend.checks.find(c => c.code === 'LEAVE').status === 'warn');
    const uaAppr = await validateAssignment(db, { employeeId: E3, date: D(68), shiftCode: 'E4D', operation: 'add' });
    check('ن13: عدم تمكّن auto_approved ⇒ UNABLE_ATTEND_CONFLICT',
        uaAppr.valid === false && uaAppr.reasons.includes('UNABLE_ATTEND_CONFLICT'));
    const uaPend = await validateAssignment(db, { employeeId: E3, date: D(69), shiftCode: 'E4D', operation: 'add' });
    check('ن14: عدم تمكّن pending_review ⇒ warn فقط وvalid=true (ج2)',
        uaPend.valid === true && uaPend.checks.find(c => c.code === 'UNABLE_ATTEND').status === 'warn');
    const uaRej = await validateAssignment(db, { employeeId: E3, date: D(70), shiftCode: 'E4D', operation: 'add' });
    const uaCan = await validateAssignment(db, { employeeId: E3, date: D(71), shiftCode: 'E4D', operation: 'add' });
    check('ن15: rejected/cancelled لا تمنع إطلاقًا ⇒ pass وvalid=true',
        uaRej.valid === true && uaRej.checks.find(c => c.code === 'UNABLE_ATTEND').status === 'pass' &&
        uaCan.valid === true && uaCan.checks.find(c => c.code === 'UNABLE_ATTEND').status === 'pass');

    console.log('\n── Validation: الهوية والأهلية والرمز ──');
    const inactive = await validateAssignment(db, { employeeId: E12, date: D(45), shiftCode: 'E4D', operation: 'add' });
    check('ن16: موظف غير نشط ⇒ EMPLOYEE_NOT_ACTIVE',
        inactive.valid === false && inactive.reasons.includes('EMPLOYEE_NOT_ACTIVE'));
    const noTeam = await validateAssignment(db, { employeeId: E11, date: D(45), shiftCode: 'E4D', operation: 'add' });
    check('ن17: بلا عضوية فريق حية ⇒ EMPLOYEE_NO_ACTIVE_TEAM + COVERAGE=skip',
        noTeam.valid === false && noTeam.reasons.includes('EMPLOYEE_NO_ACTIVE_TEAM') &&
        noTeam.checks.find(c => c.code === 'COVERAGE').status === 'skip');
    const mismatch = await validateAssignment(db, { employeeId: E1, date: D(45), shiftCode: 'E4D', operation: 'add', teamId: TEAM2 });
    check('ن18: teamId يخالف العضوية الحية ⇒ EMPLOYEE_NO_ACTIVE_TEAM (لا يُقبل كمدخل موثوق)',
        mismatch.valid === false && mismatch.reasons.includes('EMPLOYEE_NO_ACTIVE_TEAM'));
    const multi = await validateAssignment(db, { employeeId: E1, date: D(72), shiftCode: 'E4N', operation: 'add' });
    check('ن19: مناوبة قائمة لنفس اليوم ⇒ MULTIPLE_SHIFTS_SAME_DAY',
        multi.valid === false && multi.reasons.includes('MULTIPLE_SHIFTS_SAME_DAY'));
    const unknown = await validateAssignment(db, { employeeId: E1, date: D(45), shiftCode: 'XXX99', operation: 'add' });
    check('ن20: رمز غير معروف ⇒ UNKNOWN_SHIFT_CODE',
        unknown.valid === false && unknown.reasons.includes('UNKNOWN_SHIFT_CODE'));
    const notWork = await validateAssignment(db, { employeeId: E1, date: D(45), shiftCode: nonWork.code, operation: 'add' });
    check('ن21: رمز ليس «دوام» ⇒ NOT_A_WORK_SHIFT',
        notWork.valid === false && notWork.reasons.includes('NOT_A_WORK_SHIFT'));

    console.log('\n── Validation: تفريق ج3 الإلزامي ──');
    const addShort = await validateAssignment(db, { employeeId: E5, date: D(73), shiftCode: 'E4D', operation: 'add' });
    check('ن22: إضافة لفريق ناقص (2/2/4): valid=true + wouldBreak=false + met=false + still_below=true',
        addShort.valid === true && addShort.wouldBreak === false &&
        addShort.coverage_after.met === false && addShort.still_below_minimum === true,
        JSON.stringify({ valid: addShort.valid, wouldBreak: addShort.wouldBreak, met: addShort.coverage_after.met, still: addShort.still_below_minimum }));
    const remBreak = await validateAssignment(db, { employeeId: E6, date: D(74), shiftCode: 'E4N', operation: 'remove' });
    check('ن23: إزالة تنزل تحت الحد: valid=false + wouldBreak=true + COVERAGE_BELOW_MINIMUM',
        remBreak.valid === false && remBreak.wouldBreak === true && remBreak.reasons.includes('COVERAGE_BELOW_MINIMUM'));

    // ═══ ج) النزاهة ═══
    console.log('\n── النزاهة ──');
    const rosterFpAfter = fp(await db.all('SELECT * FROM shift_roster ORDER BY rowid'));
    check('ص1: shift_roster لم يُكتب إليه إطلاقًا (بصمة مطابقة قبل/بعد كل الاستدعاءات)',
        rosterFpBefore === rosterFpAfter);
    const schemaFpAfter = fp(await db.all("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"));
    check('ص2: صفر Migration/DDL (بصمة المخطط مطابقة)', schemaFpBefore === schemaFpAfter);

    // ═══ الخلاصة ═══
    await db.closeDb();
    console.log('\n═══════════════════════════════════');
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failed > 0) {
        console.log('الفاشلة:');
        failures.forEach(f => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('✅ E-4 COVERAGE + VALIDATION TEST: PASS — ' + passed + ' فحصًا');
    process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
