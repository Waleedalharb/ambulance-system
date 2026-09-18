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
        "ops.report_detail", "ops.deployments", "ops.forms",
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
}

@MainActor
final class PermissionStore: ObservableObject {
    @Published private(set) var payload: MePermissionsDTO?
    @Published private(set) var loadFailed = false

    private let api = APIClient.shared

    var permissions: [String] { payload?.permissions ?? [] }
    var isStar: Bool { payload?.permissionsStar ?? false }
    var roleLabel: String? { payload?.roleLabel }

    var canAccessEmployeePortal: Bool { PermissionMapper.canAccessEmployeePortal(permissions, star: isStar) }
    var canAccessOperations: Bool { PermissionMapper.canAccessOperations(permissions, star: isStar) }
    var canViewIndicators: Bool { PermissionMapper.canViewIndicators(permissions, star: isStar) }
    var canViewPhones: Bool { PermissionMapper.canViewPhones(permissions, star: isStar) }

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
