// ============================================
// SR-2: استيراد لمرة واحدة — الجدولة الحالية (data/schedule-employees.json)
// ← employees + shift_roster. JSON هنا «ملف استيراد» فقط، وبعد هذه الخطوة
// لا تقرأه أي جهة تشغيلية إطلاقًا.
// التشغيل: node scripts/import-schedule-to-roster.js
//   (يحترم DB_PATH لاستهداف قاعدة أخرى — مثل قاعدة الاختبارات)
// ============================================
const path = require('path');
const fs = require('fs');

async function main() {
    const schedulePath = path.join(__dirname, '..', 'data', 'schedule-employees.json');
    if (!fs.existsSync(schedulePath)) {
        console.error('❌ ملف الجدولة غير موجود:', schedulePath);
        process.exit(1);
    }
    const scheduleEmployees = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
    if (!Array.isArray(scheduleEmployees)) {
        console.error('❌ بنية ملف الجدولة غير صالحة (ليست مصفوفة)');
        process.exit(1);
    }

    const db = require('../db');
    await db.init();
    const RosterSyncService = require('../services/roster-sync-service');
    const sync = new RosterSyncService({ db });

    console.log(`▶ مزامنة ${scheduleEmployees.length} موظفًا من ملف الاستيراد...`);
    const stats = await sync.syncFromSchedule(scheduleEmployees);
    console.log('✅ اكتملت المزامنة:');
    console.log(`   موظفون في الجدولة : ${stats.employeesSeen}`);
    console.log(`   أُنشئوا            : ${stats.created}`);
    console.log(`   حُدّثوا            : ${stats.updated} (أُعيد تفعيل ${stats.reactivated})`);
    console.log(`   عُطّلوا (لا حذف)   : ${stats.deactivated}`);
    console.log(`   صفوف roster        : ${stats.rosterRows}`);
    console.log(`   فترات مشمولة       : ${stats.rosterPeriods.join(', ') || '—'}`);
    console.log(`   موظفون متخطّون     : ${stats.skippedEmployees}`);
    console.log(`   مداخل متخطّاة      : ${stats.skippedEntries} (تواريخ/رموز غير صالحة)`);
    await db.closeDb();
}

main().catch(e => { console.error('❌ فشل الاستيراد:', e); process.exit(1); });
