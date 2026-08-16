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
    // التشغيل اليومي (يُفكَّك لاحقًا عند حاجة فعلية فقط: ops.reports/completion/...)
    'ops.execute':          { label: 'التشغيل اليومي (بلاغات/تكميل/تمركزات/نماذج/حالات/خروج فرق/متطوعون)', domain: 'ops' },
    // الجداول — مفصولة بالكامل (بند ثالثًا)
    'schedule.view':        { label: 'مشاهدة الجداول', domain: 'schedule' },
    'schedule.import':      { label: 'استيراد الجداول (منح فردي فقط — لا دور يمنحها)', domain: 'schedule' },
    'schedule.edit_cell':   { label: 'تعديل خلية جدول', domain: 'schedule' },
    'schedule.generate':    { label: 'توليد الجدول الذكي', domain: 'schedule' },
    'schedule.swap':        { label: 'استبدال/تراجع/إعادة بالجداول', domain: 'schedule' },
    'schedule.bulk_update': { label: 'تحديث جماعي ومسودات الجداول', domain: 'schedule' },
    // المناوبة: الدورة ≠ الاعتماد
    'shift.lifecycle':      { label: 'دورة حياة المناوبة (بدء/إنهاء/تحديث)', domain: 'shift' },
    'shift.approve':        { label: 'اعتماد المناوبة (تسليم/أرشفة/استعادة)', domain: 'shift' },
    // سير العمل: الإدارة ≠ الاعتماد
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

// '*' = كل الصلاحيات. schedule.import غائبة عمدًا من كل دور (منح فردي فقط).
const ROLES_PERMISSIONS = {
    sysadmin: ['*'],
    ops_supervisor: [
        'ops.execute',
        'schedule.view', 'schedule.edit_cell', 'schedule.generate', 'schedule.swap', 'schedule.bulk_update',
        'shift.lifecycle', 'shift.approve',
        'workflow.manage', 'workflow.approve',
        'indicators.contribution',
        'employees.manage',
        'archive.sensitive'
    ],
    field_leadership: [
        'ops.execute',          // جاهزية الفرق/المركبات/الحالات/خروج الفرق/النماذج الميدانية
        'schedule.view',        // مشاهدة فقط — بلا تعديل ولا استيراد
        'archive.sensitive'     // متابعة ميدانية تشمل اللقطات
    ],
    operator: [
        'ops.execute',
        'schedule.view'
    ],
    viewer: [],                  // مشاهدة فقط — القراءة متاحة للموثّقين أصلًا، ولا كتابة إطلاقًا
    // ── الأدوار التقنية الحالية (المرحلة 0: لا تغيير سلوكي) ──
    admin: ['*'],
    director: [
        'ops.execute',
        'schedule.view', 'schedule.edit_cell', 'schedule.generate', 'schedule.swap', 'schedule.bulk_update',
        'shift.lifecycle', 'shift.approve',
        'workflow.manage', 'workflow.approve',
        'indicators.contribution',
        'employees.manage',
        'archive.sensitive'
    ],
    user: ['ops.execute', 'schedule.view']
};

module.exports = { PERMISSIONS, PERMISSION_KEYS, ROLE_LABELS, ROLES_PERMISSIONS };
