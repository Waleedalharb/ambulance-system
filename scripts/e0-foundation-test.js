// ═══ E-0 (FSS): اختبار تأسيس قاعدة محرك الجدولة ═══
// قرارات M1–M14 معتمدة 2026-10-06. نطاق الاختبار:
//  أ) كتالوج الصلاحيات: 3 مفاتيح جديدة، لا دور يحملها، المفاتيح القائمة لم تُمس.
//  ب) DB معزولة (DB_PATH مؤقت — لا يلمس data/ الحقيقية): زرع خامل idempotent،
//     schedule_months بمخططه وقيوده، monthly_required_hours لا يُمس.
//  ج) قارئ الإعدادات: افتراضيات، احترام override، سقوط على الافتراضي، مفتاح مجهول.
// لا خادم، لا HTTP، لا UI — أساس فقط.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flex-e0-'));
process.env.DB_PATH = path.join(TMP_ROOT, 'ambulance.db'); // قبل استيراد db.js — عزل كامل

(async () => {
    try {
        // ── أ) كتالوج الصلاحيات (ثابت — بلا DB) ──
        const { PERMISSIONS, PERMISSION_KEYS, ROLES_PERMISSIONS } = require('../config/permissions.js');
        const NEW_KEYS = ['schedule.proposals.manage', 'schedule.requests.review', 'schedule.settings.manage'];

        check('أ1: المفاتيح الثلاثة موجودة في كتالوج PERMISSIONS', NEW_KEYS.every(k => PERMISSIONS[k]));
        check('أ2: المفاتيح الثلاثة ضمن domain=schedule', NEW_KEYS.every(k => PERMISSIONS[k] && PERMISSIONS[k].domain === 'schedule'));
        check('أ3: المفاتيح الثلاثة داخلة في PERMISSION_KEYS', NEW_KEYS.every(k => PERMISSION_KEYS.includes(k)));
        const rolesWithNewKeys = Object.entries(ROLES_PERMISSIONS)
            .filter(([role, perms]) => !perms.includes('*') && NEW_KEYS.some(k => perms.includes(k)))
            .map(([role]) => role);
        check('أ4: لا دور يحمل أيًا من المفاتيح الثلاثة (منح فردي حصرًا)', rolesWithNewKeys.length === 0, rolesWithNewKeys.join(','));
        check('أ5: sysadmin/admin يبقيان على * فقط (لا إدراج صريح للمفاتيح الجديدة)',
            eq(ROLES_PERMISSIONS.sysadmin, ['*']) && eq(ROLES_PERMISSIONS.admin, ['*']));
        check('أ6: requests.review القائمة (F-1) لم تُمس وما زالت في الكتالوج', !!PERMISSIONS['requests.review']);
        check('أ7: shift.approve القائمة لم تُمس وما زالت في الكتالوج', !!PERMISSIONS['shift.approve']);
        check('أ8: مفاتيح F-3 (generate/bulk_update/employees.manage) لم تُمس',
            !!PERMISSIONS['schedule.generate'] && !!PERMISSIONS['schedule.bulk_update'] && !!PERMISSIONS['employees.manage']);

        // ── ب) قاعدة البيانات المعزولة ──
        const db = require('../db.js');
        const { ENGINE_DEFAULTS, ENGINE_SETTING_KEYS, getEngineSetting, getEngineConfig } = require('../services/schedule-engine/config.js');

        await db.init(false); // جداول + ترحيلات مخطط + الزرع الخامل

        const keysInDb = await db.all('SELECT key, value FROM app_settings WHERE key LIKE ?', ['schedule_engine.%']);
        check('ب1: الزرع أدرج المفاتيح الثمانية كلها', keysInDb.length === ENGINE_SETTING_KEYS.length && keysInDb.length === 8,
            'found=' + keysInDb.length);
        const allDefaultsMatch = ENGINE_SETTING_KEYS.every(k => {
            const row = keysInDb.find(r => r.key === k);
            return row && eq(JSON.parse(row.value), ENGINE_DEFAULTS[k]);
        });
        check('ب2: كل القيم المزروعة تطابق الافتراضيات المجمّدة (M1/M4/M6/M7/M8/M9/M14)', allDefaultsMatch);

        const mrh = await db.get('SELECT value FROM app_settings WHERE key = ?', ['monthly_required_hours']);
        check('ب3: monthly_required_hours لم يُمس (لم يزرعه E-0 ولم يغيّره)', !mrh);

        // الخمول: قيمة معدّلة يدويًا يجب ألا تُستبدل عند إعادة التهيئة
        await db.AppSettings.set('schedule_engine.min_rest_hours', 10);
        await db.init(false);
        const afterReinit = await db.AppSettings.get('schedule_engine.min_rest_hours');
        check('ب4: الزرع خامل — القيمة المعدّلة يدويًا (10) لم تُستبدل بعد init ثانية', afterReinit === 10, 'got=' + afterReinit);
        const countAfter = await db.get('SELECT COUNT(*) c FROM app_settings WHERE key LIKE ?', ['schedule_engine.%']);
        check('ب5: إعادة init لم تضف مفاتيح مكررة (ما زالت 8)', countAfter.c === 8, 'got=' + countAfter.c);

        // schedule_months — المخطط والقيود
        const cols = await db.all("PRAGMA table_info(schedule_months)");
        const colNames = cols.map(c => c.name);
        check('ب6: schedule_months موجود بالأعمدة الخمسة المعتمدة',
            eq(colNames, ['month', 'status', 'published_by', 'published_at', 'created_at']), colNames.join(','));
        await db.run("INSERT INTO schedule_months (month) VALUES ('2099-01')");
        const draftRow = await db.get("SELECT * FROM schedule_months WHERE month = '2099-01'");
        check('ب7: الإدراج الافتراضي يعمل وstatus=draft وحقول النشر NULL',
            !!draftRow && draftRow.status === 'draft' && draftRow.published_by === null && draftRow.published_at === null);
        let checkFailed = false;
        try { await db.run("INSERT INTO schedule_months (month, status) VALUES ('2099-02', 'locked')"); }
        catch (e) { checkFailed = true; }
        check('ب8: قيد CHECK يرفض أي حالة غير draft/published', checkFailed);
        let pkFailed = false;
        try { await db.run("INSERT INTO schedule_months (month) VALUES ('2099-01')"); }
        catch (e) { pkFailed = true; }
        check('ب9: المفتاح الأساسي month يمنع التكرار', pkFailed);

        const grants = await db.get(
            "SELECT COUNT(*) c FROM user_permissions WHERE permission_key IN ('schedule.proposals.manage','schedule.requests.review','schedule.settings.manage')");
        check('ب10: صفر منح فعلية للمفاتيح الثلاثة (لا منح تلقائي — M10)', grants.c === 0, 'got=' + grants.c);

        // ── ج) قارئ الإعدادات ──
        const cfgAll = await getEngineConfig();
        check('ج1: getEngineConfig تعيد كل المفاتيح الثمانية', eq(Object.keys(cfgAll).sort(), ENGINE_SETTING_KEYS.slice().sort()));
        const rest = await getEngineSetting('schedule_engine.min_rest_hours');
        check('ج2: القارئ يحترم قيمة app_settings المعدّلة (10 ≠ الافتراضي 8)', rest === 10, 'got=' + rest);
        await db.AppSettings.delete('schedule_engine.min_rest_hours');
        const restFallback = await getEngineSetting('schedule_engine.min_rest_hours');
        check('ج3: حذف المفتاح يسقط على الافتراضي المجمّد (8)', restFallback === 8, 'got=' + restFallback);
        const coverage = await getEngineSetting('schedule_engine.coverage_default');
        check('ج4: coverage_default = 2/2/8 (M4 — نقطة انطلاق بلا تغيير سلوك)', eq(coverage, { day: 2, night: 2, total: 8 }));
        const window_ = await getEngineSetting('schedule_engine.preference_window');
        check('ج5: تقويم M8 = فتح 10 · إغلاق 20 · نشر 21–25', eq(window_, { open_day: 10, close_day: 20, publish_from: 21, publish_to: 25 }));
        check('ج6: مفتاح مجهول يعيد undefined ولا يرمي', (await getEngineSetting('schedule_engine.no_such_key')) === undefined);

        await db.closeDb();
    } catch (e) {
        failed++;
        failures.push('fatal: ' + e.message);
        console.log('❌ fatal — ' + e.message);
        console.error(e);
    } finally {
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
    }

    console.log('');
    console.log(`✅ نجح: ${passed} | ❌ فشل: ${failed}`);
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})();
