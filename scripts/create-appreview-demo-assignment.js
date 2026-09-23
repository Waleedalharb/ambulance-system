/**
 * ═══ create-appreview-demo-assignment.js — تكليف تجريبي آمن لحساب مراجعة Apple ═══
 * اعتماد المالك 2026-09-23. الهدف: ألا تظهر شاشتا «الرئيسية/مناوباتي» فارغتين
 * في فيديو مراجعة App Store، دون أي أثر على التشغيل الحقيقي.
 *
 * ماذا يفعل بالضبط (و nothing else):
 *  ① فريق تجريبي واحد: name='Apple Review / Demo' — team_type=NULL (ليس ميدانيًا،
 *    فلا يدخل منطق البلاغات/GPS/التتبع إطلاقًا) وis_active=0 (خارج قوائم العمليات
 *    النشطة)، ويبقى ظاهرًا بالاسم في بوابة الموظف لأنها تقرأ كل الفرق.
 *  ② صفّا shift_roster لموظف 'appreview' الاصطناعي: اليوم + غدًا (توقيت الرياض)
 *    برمز D12 على الفريق التجريبي — تغطي نافذة التصوير أيًا كان وقتها.
 *
 * الضوابط (شروط المالك حرفيًا):
 *  - لا بيانات موظفين حقيقيين ولا بلاغات ولا مرضى — لا يُكتب إلا هذان العنصران.
 *  - Idempotent: التشغيل المتكرر لا يضاعف شيئًا.
 *  - --remove: يحذف الصفوف والفريق التجريبي فقط بعد انتهاء التصوير.
 *  - يفشل برسالة واضحة إذا لم يوجد موظف appreview (شغّل create-appreview-account.js أولًا).
 *  - لا يُعدّل ولا يحذف أي فريق أو موظف أو تعيين آخر.
 *
 * التشغيل (Render Shell على الإنتاج):
 *   node scripts/create-appreview-demo-assignment.js           ← قبل التصوير
 *   node scripts/create-appreview-demo-assignment.js --remove  ← بعد التصوير
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const STORAGE_PATH = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(STORAGE_PATH, 'ambulance.db');

const EMP_CODE = 'appreview';
const TEAM_NAME = 'Apple Review / Demo';
const SHIFT_CODE = 'D12'; // دوام 12 صباحًا — رمز قائم فعليًا ويُصنَّف «صباحية عمل»
const REMOVE = process.argv.includes('--remove');

/** تاريخ الرياض بصيغة YYYY-MM-DD — نفس مرجعية النظام (Asia/Riyadh). */
function riyadhDate(offsetDays) {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays); // الإزاحة قبل التنسيق تقريبية بأمان: ±3 ساعات فرق لا تقلب اليوم إلا عند منتصف الليل بالضبط — والصفوف تغطي يومين أصلًا
    return fmt.format(d);
}

(function main() {
    if (!fs.existsSync(DB_PATH)) { console.error('❌ قاعدة البيانات غير موجودة: ' + DB_PATH); process.exit(1); }
    const db = new Database(DB_PATH);
    const report = [];

    const emp = db.prepare('SELECT id, name FROM employees WHERE employee_code = ?').get(EMP_CODE);
    if (!emp) {
        console.error('❌ موظف المراجعة appreview غير موجود — شغّل أولًا:');
        console.error('   APP_REVIEW_PASSWORD=\'…\' node scripts/create-appreview-account.js');
        process.exit(1);
    }

    if (REMOVE) {
        const team = db.prepare('SELECT id FROM teams WHERE name = ?').get(TEAM_NAME);
        if (!team) { console.log('✅ لا شيء للإزالة — الفريق التجريبي غير موجود أصلًا'); db.close(); return; }
        const delRoster = db.prepare('DELETE FROM shift_roster WHERE employee_id = ? AND team_id = ?').run(emp.id, team.id);
        db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
        console.log('✅ أُزيل التكليف التجريبي: صفوف roster محذوفة = ' + delRoster.changes + ' · فريق «' + TEAM_NAME + '» حُذف');
        console.log('   لم يُمس أي فريق أو موظف أو تعيين آخر.');
        db.close();
        return;
    }

    // ① الفريق التجريبي — غير ميداني (team_type=NULL) وغير نشط عملياتيًا (is_active=0)
    let team = db.prepare('SELECT id FROM teams WHERE name = ?').get(TEAM_NAME);
    if (team) {
        report.push('الفريق التجريبي: موجود (id=' + team.id + ')');
    } else {
        const r = db.prepare("INSERT INTO teams (name, center, team_type, sort_order, is_active, requiredPersonnel) VALUES (?, ?, NULL, 9999, 0, 2)")
            .run(TEAM_NAME, TEAM_NAME);
        team = { id: r.lastInsertRowid };
        report.push('الفريق التجريبي: أُنشئ (id=' + team.id + ', team_type=NULL, is_active=0)');
    }

    // ② صفا اليوم وغدًا — بلا تكرار
    const hasRow = db.prepare('SELECT id FROM shift_roster WHERE employee_id = ? AND team_id = ? AND shift_date = ?');
    const insRow = db.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)');
    for (const offset of [0, 1]) {
        const date = riyadhDate(offset);
        if (hasRow.get(emp.id, team.id, date)) {
            report.push(date + ': موجود');
        } else {
            const [y, m] = date.split('-').map(Number);
            insRow.run(emp.id, team.id, date, SHIFT_CODE, m, y);
            report.push(date + ': أُنشئ تعيين ' + SHIFT_CODE);
        }
    }

    db.close();
    console.log('✅ التكليف التجريبي لمراجعة Apple جاهز:');
    report.forEach(r => console.log('   ' + r));
    console.log('   الموظف: ' + emp.name + ' (' + EMP_CODE + ') · الفريق: «' + TEAM_NAME + '» · الرمز: ' + SHIFT_CODE);
    console.log('   لا GPS ولا بلاغات لهذا الفريق (غير ميداني) — ولا أثر على التشغيل الحقيقي.');
    console.log('   بعد انتهاء التصوير: node scripts/create-appreview-demo-assignment.js --remove');
})();
