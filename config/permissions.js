/**
 * ═══ خريطة الصلاحيات المركزية — config/permissions.js ═══
 * المرحلة 0 (معتمدة 2026-08-16): بنية فقط — لا يُنقل أي مسار إلى authorizePerm
 * في هذه المرحلة، ولا يتغير سلوك أي مستخدم حالي.
 *
 * القواعد المعتمدة:
 *  - Role = الصلاحيات الافتراضية · Permissions = منح/سحب فردي فوق الدور.
 *  - schedule.import = منح فردي فقط — لا يُمنح لأي دور تلقائيًا (بند ثانيًا/تاسعًا).
 *  - لا ربط تلقائي بـ job_title / رمز القوة / الفريق / المركز / المناوبة (بند خامسًا).
 *  - الحسم خادمي دائمًا (403) — الواجهة عرض فقط (بند الثاني عشر).
 *  - الأدوار التقنية الحالية admin/director/user تبقى كما هي؛ admin = '*'.
 */
'use strict';

// ── كتالوج الصلاحيات المعتمد ──
const PERMISSIONS = {
    // التشغيل اليومي — المرحلة 1: فُكِّك إلى مفاتيح دقيقة (معتمد 2026-08-17)
    // ops.execute يبقى مؤقتًا للتوافق مع أي منح سابق — لا يُحذف
    'ops.execute':          { label: 'التشغيل اليومي (مفتاح شامل قديم — للتوافق فقط)', domain: 'ops' },
    'ops.completion':       { label: 'التكميل', domain: 'ops' },
    'ops.dispatch':         { label: 'توزيع البلاغات', domain: 'ops' },
    'ops.reports':          { label: 'البلاغات', domain: 'ops' },
    'ops.report_revert':    { label: 'التراجع عن البلاغ', domain: 'ops' },
    'ops.report_detail':    { label: 'البلاغات التفصيلية', domain: 'ops' },
    'ops.deployments':      { label: 'التمركزات', domain: 'ops' },
    'ops.forms':            { label: 'النماذج', domain: 'ops' },
    'ops.team_exit':        { label: 'تسجيل خروج الفرق', domain: 'ops' },
    'ops.volunteers':       { label: 'المتطوعون', domain: 'ops' },
    // مرحلة ربط العمليات (معتمدة 2026-08-17): 3 مفاتيح جديدة
    // ops.vehicles ضمن حزمة operator/field_leadership — مسؤولية مستقلة عن التكميل
    // ops.files وops.alerts: منح فردي حاليًا حصرًا — لا تدخل أي دور تلقائيًا (قرار المالك ④)
    'ops.vehicles':         { label: 'تشغيل وإسناد المركبات', domain: 'ops' },
    'ops.files':            { label: 'رفع الملفات التشغيلية (منح فردي حاليًا — لا دور يحملها)', domain: 'ops' },
    'ops.alerts':           { label: 'معالجة التنبيهات (منح فردي حاليًا — لا دور يحملها)', domain: 'ops' },
    // الجداول — مفصولة بالكامل، وكلها منح فردية حصرًا: لا دور يحملها (بند ثالثًا/سابعًا)
    // مرحلة تفكيك الجداول (معتمدة 2026-08-17): +employees/sync/export/print/clear
    // schedule.print: لا مسار خادمي — تحكم واجهة فقط (موثّق أنه ليس حماية أمنية)
    // schedule.clear: شديدة الحساسية — ممنوعة من كل دور، يدوية حصرًا
    'schedule.view':        { label: 'مشاهدة الجداول (منح فردي فقط)', domain: 'schedule' },
    'schedule.import':      { label: 'استيراد الجداول (منح فردي فقط — لا دور يمنحها)', domain: 'schedule' },
    'schedule.edit_cell':   { label: 'تعديل خلية جدول (منح فردي فقط)', domain: 'schedule' },
    'schedule.employees':   { label: 'إدارة موظفي الجدول: إضافة/حذف/ترتيب (منح فردي فقط)', domain: 'schedule' },
    'schedule.generate':    { label: 'توليد الجدول الذكي (منح فردي فقط)', domain: 'schedule' },
    'schedule.swap':        { label: 'استبدال/تراجع/إعادة بالجداول (منح فردي فقط)', domain: 'schedule' },
    'schedule.bulk_update': { label: 'تحديث جماعي ومسودات الجداول (منح فردي فقط)', domain: 'schedule' },
    'schedule.sync':        { label: 'مزامنة الجدول مع الخادم/حفظه (منح فردي فقط)', domain: 'schedule' },
    'schedule.export':      { label: 'تصدير الجداول عبر الخادم — PDF مركز/فئة (أزرار Excel/الطباعة: تحكم واجهة فقط)', domain: 'schedule' },
    'schedule.print':       { label: 'طباعة الجداول (تحكم واجهة فقط — لا مسار خادمي)', domain: 'schedule' },
    'schedule.clear':       { label: '⚠️ مسح كل بيانات الجداول — شديدة الحساسية: يدوية حصرًا ولا دور يحملها', domain: 'schedule' },
    // المناوبة: الدورة ≠ الاعتماد
    'shift.lifecycle':      { label: 'دورة حياة المناوبة (بدء/إنهاء/تحديث)', domain: 'shift' },
    'shift.approve':        { label: 'اعتماد المناوبة (تسليم/أرشفة/استعادة)', domain: 'shift' },
    // سير العمل: المشاهدة ≠ الإدارة ≠ الاعتماد
    'workflow.view':        { label: 'مشاهدة سير العمل', domain: 'workflow' },
    'workflow.manage':      { label: 'إدارة سير العمل (إعداد/تعديل/إعادة إصدار)', domain: 'workflow' },
    'workflow.approve':     { label: 'اعتماد سير العمل', domain: 'workflow' },
    // المؤشرات
    'indicators.contribution': { label: 'مؤشرات مساهمة الموظفين', domain: 'indicators' },
    // الإدارة
    'employees.manage':     { label: 'إدارة الموظفين والفرق والتعيينات', domain: 'admin' },
    'symbols.manage':       { label: 'إدارة رموز الجداول (فوقها القفل السري المستقل)', domain: 'admin' },
    'admin.users_manage':   { label: 'إدارة المستخدمين والأدوار والصلاحيات', domain: 'admin' },
    'admin.settings':       { label: 'إعدادات النظام (ساعات/ثيمات/هوية)', domain: 'admin' },
    'admin.tech':           { label: 'الأدوات التقنية الحساسة (مراقبة/إصلاح/تدمير)', domain: 'admin' },
    'data.delete':          { label: 'حذف البيانات الحساسة', domain: 'admin' },
    // الأرشيف الحساس (بند عاشرًا): لا يُمنح لـ viewer تلقائيًا
    'archive.sensitive':    { label: 'لقطات المناوبات الحساسة وسلامة الأرشيف', domain: 'archive' }
};

const PERMISSION_KEYS = Object.keys(PERMISSIONS);

// ── الأدوار الخمسة المعتمدة + الأدوار التقنية الحالية (لا تُكسر) ──
const ROLE_LABELS = {
    sysadmin: 'مدير النظام',
    ops_supervisor: 'مشرف العمليات',
    field_leadership: 'القيادة الميدانية',
    operator: 'مستخدم تشغيل',
    viewer: 'مستخدم قراءة',
    // التقنية الحالية (تبقى كما هي — director يُعرض «مشرف العمليات»)
    admin: 'مدير النظام',
    director: 'مشرف العمليات',
    user: 'مستخدم'
};

// '*' = كل الصلاحيات. المرحلة 1 (معتمد 2026-08-17) + الحزم الموحدة (معتمدة 2026-08-17):
//  - كل مفاتيح schedule.* أُفرغت من جميع الأدوار — منح فردي حصرًا (بند سابعًا).
//  - ops.execute الشامل بقي في الكتالوج للتوافق لكنه لا يُمنح افتراضيًا إلا للدور القديم user.
//  - operator/field_leadership: حزمة موحدة — تنفيذ: completion/dispatch/deployments/forms/vehicles،
//    + report_revert/report_detail/team_exit/volunteers (مفاتيح تنفيذ نطاقاتها بعد ربط العمليات)
//    + ops.reports (محجوزة لمرحلة ربط القراءات لاحقًا) + workflow.view.
//    مرحلة ربط العمليات (2026-08-17): GET العمليات تبقى للموثّقين (قرار ①)؛
//    مفاتيح ops.* تحرس مسارات التنفيذ فقط. ops.files/ops.alerts فرديتان — لا دور يحملهما.
//  - field_leadership تزيد workflow.approve فقط. ops_supervisor غير مُسند حاليًا.
const OPS_EXECUTE = ['ops.completion', 'ops.dispatch', 'ops.deployments', 'ops.forms', 'ops.vehicles'];
const OPS_VIEW = ['ops.reports', 'ops.report_revert', 'ops.report_detail', 'ops.team_exit', 'ops.volunteers'];
const OPS_ALL = OPS_EXECUTE.concat(OPS_VIEW);
const ROLES_PERMISSIONS = {
    sysadmin: ['*'],
    ops_supervisor: [
        ...OPS_ALL,
        'shift.lifecycle', 'shift.approve',
        'workflow.view', 'workflow.manage', 'workflow.approve',
        'indicators.contribution',
        'employees.manage',
        'archive.sensitive'
    ],
    field_leadership: [
        ...OPS_ALL,             // نفس حزمة operator التشغيلية
        'workflow.view',
        'workflow.approve'      // اعتماد سير العمل (كبير/مساعد كبير المسعفين)
    ],
    operator: [
        ...OPS_ALL,             // 4 تنفيذ + 5 اطلاع — حزمة التحكم والتنسيق الموحدة
        'workflow.view'
    ],
    viewer: [],                    // مشاهدة فقط — القراءة متاحة للموثّقين أصلًا، ولا كتابة إطلاقًا
    // ── الأدوار التقنية الحالية (لا تغيير سلوكي — الـ20 يبقون admin='*') ──
    admin: ['*'],
    director: [
        ...OPS_ALL,
        'shift.lifecycle', 'shift.approve',
        'workflow.view', 'workflow.manage', 'workflow.approve',
        'indicators.contribution',
        'employees.manage',
        'archive.sensitive'
    ],
    user: ['ops.execute']          // المفتاح الشامل القديم — توافق فقط، بلا schedule.*
};

module.exports = { PERMISSIONS, PERMISSION_KEYS, ROLE_LABELS, ROLES_PERMISSIONS };
