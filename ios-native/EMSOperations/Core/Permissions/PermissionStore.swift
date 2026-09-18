//
//  PermissionStore.swift
//  EMSOperations
//
//  الصلاحيات الفعلية (v2 قسم 6/31): المصدر الوحيد /api/auth/me/permissions
//  (المنح الفردية + الفعلية + '*'). العميل يبني الـUI المناسب فقط —
//  القرار الأمني النهائي يبقى على الخادم في كل طلب.
//

import Foundation

/// قدرات التطبيق المشتقة من الصلاحيات — دوال نقية لسهولة الاختبار.
enum PermissionMapper {
    /// مفاتيح ops.* التي تفتح وحدة العمليات (حسب config/permissions.js).
    static let operationsKeys: [String] = [
        "ops.execute", "ops.completion", "ops.dispatch", "ops.reports",
        "ops.report_detail", "ops.report_revert", "ops.deployments", "ops.forms",
        "ops.team_exit", "ops.vehicles", "ops.alerts"
    ]

    static func has(_ permissions: [String], star: Bool, _ key: String) -> Bool {
        star || permissions.contains(key)
    }

    /// بوابة الموظف التشغيلية.
    static func canAccessEmployeePortal(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.my_portal")
    }

    /// وحدة العمليات — أي مفتاح تشغيلي.
    static func canAccessOperations(_ permissions: [String], star: Bool) -> Bool {
        star || permissions.contains(where: { operationsKeys.contains($0) })
    }

    /// مؤشرات المساهمة (الإدارة).
    static func canViewIndicators(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "indicators.contribution")
    }

    /// أرقام الجوالات (الخادم يطبقها أيضًا — هنا للعرض فقط).
    static func canViewPhones(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "staff.phone_view")
    }

    /// مشاهدة الجداول العامة.
    static func canViewSchedules(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.view")
    }

    /// تنفيذ التكميل (قرارات الفرق/أحداث الأشخاص/السجلات).
    static func canCompleteOps(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.completion")
    }

    /// تسجيل المتطوعين (منحة مستقلة عن ops.completion).
    static func canVolunteers(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.volunteers")
    }

    /// تمركز الوحدات وخطط/مهام الذروة.
    static func canDeployOps(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.deployments")
    }

    /// توزيع البلاغات وإلغاء/استعادة طواقم CAD.
    static func canDispatch(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.dispatch")
    }

    /// التراجع عن آخر بلاغ موزّع.
    static func canRevertReports(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.report_revert")
    }

    /// البلاغات التفصيلية (إدخال/حذف).
    static func canReportDetail(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.report_detail")
    }

    /// أحداث المركبات: إسناد/تبديل/دعم/حالة ميكانيكية.
    static func canVehicleOps(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "ops.vehicles")
    }

    // ── مفاتيح الجداول التفصيلية (config/permissions.js — كلها منح فردية حصرًا) ──
    // من لا يملك المفتاح لا يرى الإجراء إطلاقًا؛ الحسم النهائي على الخادم (403).

    /// تعديل خلية مناوبة ليوم واحد.
    static func canEditScheduleCell(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.edit_cell")
    }

    /// إدارة سجلات الجدول (إضافة/تحديث/حذف سجل).
    static func canManageScheduleEmployees(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.employees")
    }

    /// استيراد الجداول (الرسمي وroster).
    static func canImportSchedule(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.import")
    }

    /// التحديث الجماعي والمسودات والتراجع/الإعادة.
    static func canBulkUpdateSchedule(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.bulk_update")
    }

    /// تبديل مناوبتين.
    static func canSwapSchedule(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.swap")
    }

    /// مزامنة ملفات الجدولة.
    static func canSyncSchedule(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.sync")
    }

    /// تصدير الجداول (JSON/PDF).
    static func canExportSchedule(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.export")
    }

    /// مسح بيانات الجداول — شديدة الحساسية (يدوية حصرًا).
    static func canClearSchedule(_ permissions: [String], star: Bool) -> Bool {
        has(permissions, star: star, "schedule.clear")
    }
}

@MainActor
final class PermissionStore: ObservableObject {
    @Published private(set) var payload: MePermissionsDTO?
    @Published private(set) var loadFailed = false

    private let api = APIClient.shared

    var permissions: [String] { payload?.permissions ?? [] }
    var isStar: Bool { payload?.permissionsStar ?? false }
    var role: String? { payload?.role }
    var roleLabel: String? { payload?.roleLabel }

    /// دور الإدارة/القيادة — بوابة الإجراءات المقيدة سيرفريًا بالدور (لا مفتاح منح).
    var isAdminOrDirector: Bool { role == "admin" || role == "director" }

    /// دور الإدارة حصرًا — سجل المركبات المرجعي ومسارات authorize(['admin']).
    var isAdmin: Bool { role == "admin" }

    /// التوليد الذكي للجداول مقيد سيرفريًا بدور admin/director (لا مفتاح منح).
    var canGenerateSchedule: Bool { isAdminOrDirector }

    var canAccessEmployeePortal: Bool { PermissionMapper.canAccessEmployeePortal(permissions, star: isStar) }
    var canAccessOperations: Bool { PermissionMapper.canAccessOperations(permissions, star: isStar) }
    var canViewIndicators: Bool { PermissionMapper.canViewIndicators(permissions, star: isStar) }
    var canViewPhones: Bool { PermissionMapper.canViewPhones(permissions, star: isStar) }
    var canViewSchedules: Bool { PermissionMapper.canViewSchedules(permissions, star: isStar) }
    var canCompleteOps: Bool { PermissionMapper.canCompleteOps(permissions, star: isStar) }
    var canVolunteers: Bool { PermissionMapper.canVolunteers(permissions, star: isStar) }
    var canDeployOps: Bool { PermissionMapper.canDeployOps(permissions, star: isStar) }
    var canDispatch: Bool { PermissionMapper.canDispatch(permissions, star: isStar) }
    var canRevertReports: Bool { PermissionMapper.canRevertReports(permissions, star: isStar) }
    var canReportDetail: Bool { PermissionMapper.canReportDetail(permissions, star: isStar) }
    var canVehicleOps: Bool { PermissionMapper.canVehicleOps(permissions, star: isStar) }
    var canEditScheduleCell: Bool { PermissionMapper.canEditScheduleCell(permissions, star: isStar) }
    var canManageScheduleEmployees: Bool { PermissionMapper.canManageScheduleEmployees(permissions, star: isStar) }
    var canImportSchedule: Bool { PermissionMapper.canImportSchedule(permissions, star: isStar) }
    var canBulkUpdateSchedule: Bool { PermissionMapper.canBulkUpdateSchedule(permissions, star: isStar) }
    var canSwapSchedule: Bool { PermissionMapper.canSwapSchedule(permissions, star: isStar) }
    var canSyncSchedule: Bool { PermissionMapper.canSyncSchedule(permissions, star: isStar) }
    var canExportSchedule: Bool { PermissionMapper.canExportSchedule(permissions, star: isStar) }
    var canClearSchedule: Bool { PermissionMapper.canClearSchedule(permissions, star: isStar) }

    /// يُستدعى بعد المصادقة مباشرة. الفشل لا يكسر الدخول — يُسجَّل وتُخفى الوحدات المشروطة.
    func load() async {
        loadFailed = false
        do {
            payload = try await api.get("/api/auth/me/permissions")
            #if DEBUG
            // Swift 6: ثوابت محلية — لا تُقرأ الخصائص داخل استيفاء OSLog.
            let loadedRole = payload?.roleLabel ?? "—"
            let loadedStar = payload?.permissionsStar ?? false
            let loadedCount = payload?.permissions?.count ?? 0
            let loadedPermissions = (payload?.permissions ?? []).joined(separator: ", ")
            let derivedOperations = canAccessOperations
            let derivedPortal = canAccessEmployeePortal
            let derivedIndicators = canViewIndicators
            AppLogger.auth.info("permissions loaded — role: \(loadedRole, privacy: .public) · star: \(loadedStar) · count: \(loadedCount)")
            AppLogger.auth.info("permissions list: \(loadedPermissions, privacy: .public)")
            AppLogger.auth.info("derived — operations: \(derivedOperations) · portal: \(derivedPortal) · indicators: \(derivedIndicators)")
            #endif
        } catch {
            loadFailed = true
            AppLogger.auth.error("permissions load failed")
        }
    }

    func reset() {
        payload = nil
        loadFailed = false
    }
}
