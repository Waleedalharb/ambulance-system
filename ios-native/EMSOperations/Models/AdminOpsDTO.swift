//
//  AdminOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال الإدارة (docs/native-ios-platform-parity.md §20) —
//  مستخدمون/موظفون/فرق/رموز/أنماط/إعدادات/تدقيق. كل الأشكال مُتحققة من
//  server.js وdb.js (أرقام الأسطر في التعليقات). الكتابة كلها سيرفية
//  الحسم ومقيدة بالدور/المفتاح كما في المسارات.
//

import Foundation

// MARK: - المستخدمون

/// GET /api/users (admin، server.js:1997) — { success, users: [{id, username, name, role, isActive}] }
/// id قد يكون نصيًا ('emp-<code>') أو رقميًا — نفكّه بمرونة.
struct AdminUsersResponseDTO: Decodable {
    let success: Bool?
    let users: [AdminUserDTO]?
}

struct AdminUserDTO: Decodable {
    let id: FlexibleID?
    let username: String?
    let name: String?
    let role: String?
    let isActive: Bool?

    var stableId: String { id?.value ?? username ?? UUID().uuidString }
    var displayName: String { name ?? username ?? "—" }
}

/// معرّف مرن (نص أو رقم) — حسابات users.json تستخدم 'emp-<code>' وأرقامًا قديمة.
enum FlexibleID: Decodable, Hashable {
    case string(String)
    case int(Int)

    var value: String {
        switch self {
        case .string(let s): return s
        case .int(let i): return String(i)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) { self = .int(i); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        self = .string("?")
    }
}

/// POST /api/users/:id/role (admin.users_manage، server.js:1643) —
/// { success, changed, oldRole, newRole, role_label, sessionsRevoked }
struct RoleChangeResponseDTO: Decodable {
    let success: Bool?
    let changed: Bool?
    let message: String?
    let roleLabel: String?
    let sessionsRevoked: Int?

    enum CodingKeys: String, CodingKey {
        case success, changed, message, sessionsRevoked
        case roleLabel = "role_label"
    }
}

struct RoleChangeRequestDTO: Encodable {
    let role: String
}

/// POST /api/users (admin.users_manage، server.js:1689) — 201:
/// { success, user, employee, tempPassword, permissionsGranted }
/// tempPassword تُعاد مرة واحدة فقط — تُعرض للمنفذ ولا تُخزَّن.
struct CreateUserRequestDTO: Encodable {
    let username: String
    let name: String
    let role: String
    let employeeCode: String
}

struct CreateUserResponseDTO: Decodable {
    struct CreatedUser: Decodable {
        let id: String?
        let username: String?
        let name: String?
        let role: String?
    }
    struct LinkedEmployee: Decodable {
        let name: String?
        let jobTitle: String?
    }
    let success: Bool?
    let user: CreatedUser?
    let employee: LinkedEmployee?
    let tempPassword: String?
}

/// الأدوار المعتمدة سيرفريًا (server.js:1648-1649) — القائمة نفسها تُعرض
/// للاختيار؛ الخادم يرفض أي قيمة خارجها.
enum AdminRoles {
    static let all: [String] = [
        "sysadmin", "ops_supervisor", "field_leadership", "operator", "viewer",
        "admin", "director", "user"
    ]
    static func label(_ role: String) -> String {
        switch role {
        case "sysadmin": return "مدير النظام"
        case "ops_supervisor": return "مشرف العمليات"
        case "field_leadership": return "القيادة الميدانية"
        case "operator": return "المشغّل"
        case "viewer": return "مطالع"
        case "admin": return "إدارة (قديم)"
        case "director": return "قيادة (قديم)"
        case "user": return "مستخدم (قديم)"
        default: return role
        }
    }
}

// MARK: - الموظفون

/// GET /api/employees (server.js:11150) — الأعمدة حسب صلاحية الطالب
/// (employeeColumnsFor:11139): الأساس للجميع، phone لحامل staff.phone_view
/// أو admin.users_manage، وحقول التوثيق لحامل admin.users_manage فقط.
struct AdminEmployeesResponseDTO: Decodable {
    let success: Bool?
    let employees: [AdminEmployeeDTO]?
}

struct AdminEmployeeDTO: Decodable {
    let id: Int?
    let employeeCode: String?
    let name: String?
    let jobTitle: String?
    let symbol: String?
    let isActive: Int?        // SQLite 0/1
    let patternCode: String?
    let createdAt: String?
    let phone: String?
    let phoneVerified: Int?
    let phoneVerifiedAt: String?
    let phoneVerifiedBy: String?

    enum CodingKeys: String, CodingKey {
        case id, name, symbol, phone
        case employeeCode = "employee_code"
        case jobTitle = "job_title"
        case isActive = "is_active"
        case patternCode = "pattern_code"
        case createdAt = "created_at"
        case phoneVerified = "phone_verified"
        case phoneVerifiedAt = "phone_verified_at"
        case phoneVerifiedBy = "phone_verified_by"
    }

    var stableId: Int { id ?? 0 }
    var active: Bool { (isActive ?? 1) == 1 }
    var verified: Bool { (phoneVerified ?? 0) == 1 }
}

/// GET /api/employees/search?q= (server.js:11163) — { success, results }
struct AdminEmployeeSearchDTO: Decodable {
    let success: Bool?
    let results: [AdminEmployeeDTO]?
}

/// POST /api/employees (admin، server.js:11195) — employee_code + name إلزاميان.
struct CreateEmployeeRequestDTO: Encodable {
    let employeeCode: String
    let name: String
    let jobTitle: String?
    let symbol: String?

    enum CodingKeys: String, CodingKey {
        case name, symbol
        case employeeCode = "employee_code"
        case jobTitle = "job_title"
    }
}

/// PUT /api/employees/:id (admin، server.js:11208) — جسم حر يمرر لـ db.Employees.update.
struct UpdateEmployeeRequestDTO: Encodable {
    let name: String?
    let jobTitle: String?
    let symbol: String?

    enum CodingKeys: String, CodingKey {
        case name, symbol
        case jobTitle = "job_title"
    }
}

/// POST /api/employees/:id/verify-phone (admin، server.js:11221) —
/// يشترط confirmResponsibility: true صراحة.
struct VerifyPhoneRequestDTO: Encodable {
    let confirmResponsibility: Bool
}

/// PUT /api/employees/:code/phone (admin/director، server.js:12821).
struct UpdatePhoneRequestDTO: Encodable {
    let phone: String
}

/// PUT /api/employees/:code/pattern (admin/director، server.js:12730).
struct SetPatternRequestDTO: Encodable {
    let patternCode: String?
}

/// POST /api/employees/:code/transfer (admin/director، server.js:12909) —
/// teamId + scope(day|from-date) + date(YYYY-MM-DD) كلها إلزامية سيرفريًا.
struct TransferEmployeeRequestDTO: Encodable {
    let teamId: Int
    let scope: String
    let date: String
}

/// استجابة نجاح عامة للمسارات الإدارية البسيطة.
struct AdminActionResponseDTO: Decodable {
    let success: Bool?
    let id: Int?
    let error: String?
}

// MARK: - الفرق

/// GET /api/teams (server.js:11282) — db.Teams.getAll (db.js:2550).
struct AdminTeamsResponseDTO: Decodable {
    let success: Bool?
    let teams: [AdminTeamDTO]?
}

struct AdminTeamDTO: Decodable, Identifiable {
    let id: Int?
    let name: String?
    let center: String?
    let teamType: String?
    let sortOrder: Int?
    let isActive: Int?
    let requiredPersonnel: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, center
        case teamType = "team_type"
        case sortOrder = "sort_order"
        case isActive = "is_active"
        case requiredPersonnel
    }

    var active: Bool { (isActive ?? 1) == 1 }
}

/// POST /api/teams (admin، server.js:11303) — name + center إلزاميان.
struct TeamRequestDTO: Encodable {
    let name: String
    let center: String
    let teamType: String?
    let sortOrder: Int?
    let isActive: Bool?

    enum CodingKeys: String, CodingKey {
        case name, center
        case teamType = "team_type"
        case sortOrder = "sort_order"
        case isActive = "is_active"
    }
}

// MARK: - رموز المناوبات

/// GET /api/shift-codes (server.js:11340) — db.ShiftCodes.getAll (db.js:2709).
struct ShiftCodesResponseDTO: Decodable {
    let success: Bool?
    let codes: [ShiftCodeDTO]?
}

struct ShiftCodeDTO: Decodable, Identifiable {
    let id: Int?
    let code: String?
    let name: String?
    let timeStart: String?
    let timeEnd: String?
    let color: String?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case id, code, name, color, status
        case timeStart = "time_start"
        case timeEnd = "time_end"
    }
}

/// POST/PUT /api/shift-codes (admin، server.js:11361/11374) — code + name إلزاميان في الإنشاء.
struct ShiftCodeRequestDTO: Encodable {
    let code: String
    let name: String
    let timeStart: String?
    let timeEnd: String?
    let color: String?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case code, name, color, status
        case timeStart = "time_start"
        case timeEnd = "time_end"
    }
}

// MARK: - أنماط المناوبات

/// GET /api/shift-patterns (server.js:12689) — db.ShiftPatterns.getAll.
struct ShiftPatternsResponseDTO: Decodable {
    let success: Bool?
    let patterns: [ShiftPatternDTO]?
}

struct ShiftPatternDTO: Decodable {
    let code: String?
    let name: String?
    let cycleJson: String?
    let isActive: Int?

    enum CodingKeys: String, CodingKey {
        case code, name
        case cycleJson = "cycle_json"
        case isActive = "is_active"
    }

    var active: Bool { (isActive ?? 1) == 1 }
}

/// PUT /api/shift-patterns/:code (admin، server.js:12700).
struct ShiftPatternRequestDTO: Encodable {
    let name: String?
    let isActive: Bool?

    enum CodingKeys: String, CodingKey {
        case name
        case isActive = "is_active"
    }
}

// MARK: - رموز الجداول (القفل السري)

/// GET /api/schedule-symbols (symbols.manage، server.js:11426) —
/// { success, symbols, patterns, secretConfigured }
struct SymbolsRegistryResponseDTO: Decodable {
    let success: Bool?
    let symbols: [SymbolEntryDTO]?
    let secretConfigured: Bool?
}

/// سطر سجل الرموز (db.js:2591 — schedule_symbols_registry).
struct SymbolEntryDTO: Decodable {
    let id: Int?
    let code: String?
    let name: String?
    let symbolType: String?
    let groupName: String?
    let team: String?
    let hours: Double?
    let timeStart: String?
    let timeEnd: String?
    let isShift: Int?
    let source: String?
    let status: String?
    let usageCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, code, name, team, hours, source, status
        case symbolType = "symbol_type"
        case groupName = "group_name"
        case timeStart = "time_start"
        case timeEnd = "time_end"
        case isShift = "is_shift"
        case usageCount = "usage_count"
    }

    var stableId: Int { id ?? 0 }
}

/// GET /api/schedule-symbols/audit (symbols.manage، server.js:11450) —
/// db.SymbolAuditLog.getAll (db.js:2654): actor_name/action/code/old_value/new_value + created_at.
struct SymbolAuditResponseDTO: Decodable {
    let success: Bool?
    let log: [SymbolAuditEntryDTO]?
}

struct SymbolAuditEntryDTO: Decodable {
    let id: Int?
    let actorName: String?
    let action: String?
    let code: String?
    let oldValue: String?
    let newValue: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, action, code
        case actorName = "actor_name"
        case oldValue = "old_value"
        case newValue = "new_value"
        case createdAt = "created_at"
    }
}

/// POST /api/schedule-symbols/unlock (server.js:11461) —
/// { success, unlockToken, expiresInMinutes }
struct SymbolUnlockResponseDTO: Decodable {
    let success: Bool?
    let unlockToken: String?
    let expiresInMinutes: Int?
}

struct SymbolUnlockRequestDTO: Encodable {
    let secret: String
}

/// POST /api/schedule-symbols/secret (server.js:11485) — next ≥ 6 أحرف ومطابق للتأكيد.
struct SymbolSecretRequestDTO: Encodable {
    let current: String?
    let next: String
    let confirm: String
}

/// POST /api/schedule-symbols (server.js:11510) — code + symbol_type إلزاميان.
struct SymbolCreateRequestDTO: Encodable {
    let code: String
    let symbolType: String
    let name: String?

    enum CodingKeys: String, CodingKey {
        case code, name
        case symbolType = "symbol_type"
    }
}

/// POST /api/schedule-symbols/:id/status (server.js:11543).
struct SymbolStatusRequestDTO: Encodable {
    let status: String
}

// MARK: - الإعدادات والمراقبة

/// GET/PUT /api/settings/monthly-required-hours (server.js:12417/12429) — { success, value }
struct MonthlyHoursDTO: Decodable {
    let success: Bool?
    let value: Double?
}

struct MonthlyHoursRequestDTO: Encodable {
    let value: Double
}

/// GET /api/disk-usage (admin/director، server.js:10279) —
/// { success, disk: {total, used, available, percent}, storagePath }
struct DiskUsageDTO: Decodable {
    struct Disk: Decodable {
        let total: String?
        let used: String?
        let available: String?
        let percent: String?
    }
    let success: Bool?
    let disk: Disk?
    let storagePath: String?
}

// MARK: - سجل التدقيق العام

/// GET /api/audit-log (authenticate، server.js:10803) —
/// سطر موحد: { id, action, details, category, user, role, userId, shift_id, timestamp }
struct AuditLogResponseDTO: Decodable {
    let success: Bool?
    let logs: [AuditLogEntryDTO]?
}

struct AuditLogEntryDTO: Decodable {
    let id: String?
    let action: String?
    let details: String?
    let category: String?
    let user: String?
    let role: String?
    let timestamp: String?

    var stableId: String { id ?? "\(timestamp ?? "")-\(action ?? "")" }
}

// MARK: - إشعارات النظام (§5)

/// GET /api/notifications/log (authenticate، server.js:12260) —
/// سطر notification_log (db.js:888): الحالات pending/sent/delivered/failed/read/acknowledged.
struct NotificationLogResponseDTO: Decodable {
    let success: Bool?
    let notifications: [NotificationLogEntryDTO]?
}

struct NotificationLogEntryDTO: Decodable {
    let id: Int?
    let notificationType: String?
    let recipientId: Int?
    let recipientUserId: String?
    let recipientName: String?
    let recipientPhone: String?
    let message: String?
    let channel: String?
    let status: String?
    let sentAt: String?
    let deliveredAt: String?
    let openedAt: String?
    let errorMessage: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, message, channel, status
        case notificationType = "notification_type"
        case recipientId = "recipient_id"
        case recipientUserId = "recipient_user_id"
        case recipientName = "recipient_name"
        case recipientPhone = "recipient_phone"
        case sentAt = "sent_at"
        case deliveredAt = "delivered_at"
        case openedAt = "opened_at"
        case errorMessage = "error_message"
        case createdAt = "created_at"
    }

    var stableId: Int { id ?? 0 }

    var statusTitle: String {
        switch status {
        case "pending": return "معلّق"
        case "sent": return "مرسل"
        case "delivered": return "مسلَّم"
        case "read": return "مقروء"
        case "acknowledged": return "مؤكَّد"
        case "failed": return "فشل"
        default: return status ?? "—"
        }
    }

    var statusTone: EMSTheme.StatusTone {
        switch status {
        case "delivered", "read", "acknowledged": return .normal
        case "sent": return .action
        case "failed": return .danger
        case "pending": return .monitor
        default: return .neutral
        }
    }
}

/// POST /api/notifications/send (admin/director، server.js:12233) —
/// recipient_id + message إلزاميان؛ type من CHECK الثلاثة.
struct NotificationSendRequestDTO: Encodable {
    let recipientId: Int
    let message: String
    let type: String

    enum CodingKeys: String, CodingKey {
        case message, type
        case recipientId = "recipient_id"
    }
}
