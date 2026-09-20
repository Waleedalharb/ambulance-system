//
//  PortalDTO.swift
//  EMSOperations
//
//  نماذج بوابة الموظف — مطابقة لأشكال my-portal-service.js (API mapping §3).
//  كل الحقول اختيارية دفاعيًا ما عدا ما يضمنه الخادم؛ لا حساب في العميل.
//

import Foundation

// MARK: - /api/my/profile (Codable: تُخزَّن مؤقتًا للعرض دون اتصال — SafeCache)
struct ProfileDTO: Codable {
    struct Employee: Codable {
        let id: Int?
        let code: String?
        let name: String
        let jobTitle: String?
    }
    struct Today: Codable {
        let date: String?
        let shiftCode: String?
        let shiftName: String?
        let timeStart: String?
        let timeEnd: String?
        let teamId: Int?
        let teamName: String?
        let center: String?
        let assignmentSource: String?
    }
    let employee: Employee
    let today: Today?
    let lastRosterUpdate: String?
}

// MARK: - /api/my/schedule
struct ScheduleDTO: Decodable {
    struct Day: Decodable, Identifiable {
        var id: String { date ?? UUID().uuidString }
        let date: String?
        let shiftCode: String?
        let shiftName: String?
        let codeStatus: String?
        let teamId: Int?
        let teamName: String?
        let center: String?
    }
    let month: Int
    let year: Int
    let coverage: String?
    let elapsedDays: Int?
    let coveredDays: Int?
    let days: [Day]
    let lastUpdate: String?
}

// MARK: - /api/my/sections
struct SectionsDTO: Decodable {
    struct Sections: Decodable {
        let profile: Bool
        let schedule: Bool
        let assignments: Bool
        let incidents: Bool
        let vehicle: Bool
        let inventory: Bool
        let check: Bool
    }
    let sections: Sections
}

// MARK: - /api/my/shift-mates
struct ShiftMatesDTO: Decodable {
    struct Window: Decodable {
        let date: String?
        let side: String?
        let label: String?
        let source: String?
        let active: Bool?
    }
    struct Me: Decodable {
        let onShift: Bool?
        let state: String?
        let shiftCode: String?
        let teamId: Int?
        let teamName: String?
    }
    struct Person: Decodable, Identifiable {
        /// الخادم يرسل employeeId — بلا هذا الربط يكون id=nil دائمًا وينهار
        /// تمييز ForEach (صفوف متطابقة الهوية ⟵ سبب ظهور أسماء «مكررة»).
        let id: Int?
        let name: String
        let jobTitle: String?
        let teamName: String?
        let shiftCode: String?
        let phone: String?      // يصل فقط لحامل staff.phone_view — الخادم يطبق الصلاحية
        let isMe: Bool?

        enum CodingKeys: String, CodingKey {
            case id = "employeeId"
            case name, jobTitle, teamName, shiftCode, phone, isMe
        }
    }
    let available: Bool
    let window: Window?
    let me: Me?
    let team: [Person]?
    let leadership: [Person]?
    let ops: [Person]?
}

// MARK: - /api/my/notifications
struct PortalNotificationsDTO: Decodable {
    struct Item: Decodable, Identifiable {
        let id: Int
        let message: String
        let status: String?
        let shiftDate: String?
        let revisionId: Int?
        let createdAt: String?
        let openedAt: String?
        let acknowledgedAt: String?

        var isRead: Bool { status == "read" || status == "acknowledged" }
        var isAcked: Bool { status == "acknowledged" }
    }
    let notifications: [Item]
    let unreadCount: Int?
    let unackedCount: Int?
}

struct MarkStatusResponse: Decodable {
    let success: Bool?
    let status: String?
}

// MARK: - /api/my/schedule-changes
struct ScheduleChangesDTO: Decodable {
    struct Change: Decodable, Identifiable {
        let id: Int
        let date: String?
        let oldShiftCode: String?
        let newShiftCode: String?
        let oldTeam: String?
        let newTeam: String?
        let changeType: String?
        let changeLabel: String?
        let reason: String?
        let changedByName: String?
        let createdAt: String?
        let revisionId: Int?
        let revisionSource: String?
        let revisionActor: String?
    }
    let changes: [Change]
}

// MARK: - /api/my/vehicle
struct VehicleDTO: Decodable {
    struct TeamView: Decodable {
        let teamId: Int?
        let teamName: String?
        let center: String?
    }
    /// حقول المركبة مرنة — خدمة أحداث المركبات قد تُغنيها لاحقًا.
    struct Vehicle: Decodable, Identifiable {
        let id: Int?
        let name: String?
        let callSign: String?
        let plateNumber: String?
        let status: String?
        let teamName: String?

        enum CodingKeys: String, CodingKey {
            case id, name, status
            case callSign = "call_sign"
            case plateNumber = "plate_number"
            case teamName = "team_name"
        }
        var displayName: String { name ?? callSign ?? plateNumber ?? "مركبة" }
    }
    let team: TeamView?
    let assignmentSource: String?
    let vehicles: [Vehicle]?
    let available: Bool?
    let reason: String?
}

// MARK: - /api/my/inventory
struct InventoryDTO: Decodable {
    struct TeamView: Decodable {
        let teamId: Int?
        let teamName: String?
        let center: String?
    }
    struct Assets: Decodable {
        let total: Int?
        let byStatus: [String: Int]?
    }
    struct LastSession: Decodable {
        let id: Int?
        let status: String?
        let startedAt: String?
        let submittedAt: String?
        let approvedAt: String?
        let conductorName: String?

        enum CodingKeys: String, CodingKey {
            case id, status
            case startedAt = "started_at"
            case submittedAt = "submitted_at"
            case approvedAt = "approved_at"
            case conductorName = "conductor_name"
        }
    }
    let team: TeamView?
    let assignmentSource: String?
    let hasData: Bool?
    let assets: Assets?
    let lastSession: LastSession?
}

// MARK: - /api/my/team-incidents
struct TeamIncidentsDTO: Decodable {
    struct Counter: Decodable {
        let date: String?
        let count: Int?
        let reason: String?
    }
    struct Week: Decodable {
        let start: String?
        let end: String?
        let count: Int?
    }
    struct Month: Decodable {
        let year: Int?
        let month: Int?
        let count: Int?
    }
    struct ByTeam: Decodable, Identifiable {
        var id: String { "\(teamId ?? 0)-\(from ?? "")" }
        let teamId: Int?
        let teamName: String?
        let center: String?
        let from: String?
        let to: String?
        let count: Int?
    }
    let today: Counter?
    let week: Week?
    let month: Month?
    let byTeam: [ByTeam]?
    let unmatchedUnits: Int?
    let note: String?
}

// MARK: - /api/my/check-session (العقد الفعلي v4.2 — shift-check-service.js getSession)
// الاستجابة camelCase في المستوى الأعلى، باستثناء: session (صف DB خام snake_case)
// وconfirmations وvehicleFields (snake_case). الطلبات كلها snake_case.
// الجاهزية والحرجية تُعرض كما يرسلها السيرفر حرفيًا — لا حساب في العميل (SSOT).
struct CheckSessionDTO: Decodable {
    /// الحالات الصادقة بلا جلسة: no_assignment | not_field_team — nil عند وجود جلسة.
    let state: String?
    let today: String?

    /// صف shift_check_sessions الخام — مفاتيحه snake_case.
    struct SessionInfo: Decodable {
        let id: Int?
        let status: String?       // open | completed
        let schemaVersion: Int?
        let completedAt: String?

        enum CodingKeys: String, CodingKey {
            case id, status
            case schemaVersion = "schema_version"
            case completedAt = "completed_at"
        }
    }
    let session: SessionInfo?
    let vehicle: VehicleDTO.Vehicle?
    let vehicleType: String?
    let serviceLevel: String?
    let serviceLevelConfirmed: Bool?
    let isAls: Bool?

    struct TeamView: Decodable {
        let teamId: Int?
        let teamName: String?
        let center: String?
    }
    let team: TeamView?

    struct Member: Decodable, Identifiable {
        let id: Int?
        let name: String?
        let employeeCode: String?

        enum CodingKeys: String, CodingKey {
            case id, name
            case employeeCode = "employee_code"
        }
    }
    let members: [Member]?

    struct MeView: Decodable {
        let id: Int?
        let name: String?
        let code: String?
    }
    let me: MeView?

    struct Item: Decodable, Identifiable {
        var id: String { itemKey ?? UUID().uuidString }
        let itemKey: String?
        let domain: String?       // mechanical | medical
        let label: String?
        let groupKey: String?
        let qtyRequired: String?
        let result: String?       // ok | issue | nil
        let statusDetail: String? // complete|shortage|damaged|unavailable|follow_up
        let qtyAvailable: String?
        let note: String?
        let noChange: Bool?
        let refCheckedAt: String?
        let checkedByName: String?
        let checkedAt: String?
        let reflected: Bool?
    }
    let items: [Item]?

    struct Group: Decodable, Identifiable {
        var id: String { key ?? UUID().uuidString }
        let key: String?
        let label: String?
        let domain: String?
        let isAssets: Bool?
        let items: [Item]?
    }
    let groups: [Group]?

    /// snake_case وسط رد camelCase — مفاتيح صريحة إلزامية.
    struct Confirmation: Decodable, Identifiable {
        var id: String { "\(employeeId ?? 0)-\(kind ?? "")" }
        let employeeId: Int?
        let employeeName: String?
        let kind: String?         // ack | checkin | checkout
        let confirmedAt: String?

        enum CodingKeys: String, CodingKey {
            case kind
            case employeeId = "employee_id"
            case employeeName = "employee_name"
            case confirmedAt = "confirmed_at"
        }
    }
    let confirmations: [Confirmation]?

    struct OpenIssue: Decodable, Identifiable {
        var id: String { "\(domain ?? "")-\(itemKey ?? "")" }
        let domain: String?
        let itemKey: String?
        let label: String?
        let note: String?
        let byName: String?
        let at: String?
    }
    let openIssues: [OpenIssue]?

    let readiness: String?        // green | yellow | red | nil (لم يُستكمل)
    let readinessReason: String?
    let readinessAt: String?
    let checkMode: String?        // full | partial | no_change

    /// snake_case كما في قاعدة البيانات.
    struct VehicleFields: Decodable {
        let odometer: Int?
        let fuelLevel: String?
        let cleanliness: String?
        let masterKey: Int?
        let fuelCard: Int?

        enum CodingKeys: String, CodingKey {
            case odometer, cleanliness
            case fuelLevel = "fuel_level"
            case masterKey = "master_key"
            case fuelCard = "fuel_card"
        }
    }
    let vehicleFields: VehicleFields?
    let itemStatuses: [String]?

    struct NoChangeInfo: Decodable {
        struct LastCheck: Decodable {
            let at: String?
            let vehicleName: String?
        }
        let eligible: Bool?
        let reasons: [String]?
        let lastCheck: LastCheck?
    }
    let noChange: NoChangeInfo?
    let noChangeMaxAgeHours: Int?
}

/// POST /api/my/check-session/items — status_detail يحدد result سيرفريًا
/// (complete → ok؛ غيرها → issue)، فلا نرسل result إطلاقًا.
struct CheckItemRequest: Encodable {
    let itemKey: String
    let statusDetail: String
    let note: String?
    let qtyAvailable: String?

    enum CodingKeys: String, CodingKey {
        case note
        case itemKey = "item_key"
        case statusDetail = "status_detail"
        case qtyAvailable = "qty_available"
    }
}

/// POST /api/my/check-session/vehicle-fields — whitelist سيرفري صارم.
/// Codable (وليس Encodable فقط) لأن PendingCheckStore يخزنها للإرسال لاحقًا.
struct CheckVehicleFieldsRequest: Codable {
    let odometer: Int?
    let fuelLevel: String?
    let cleanliness: String?
    let masterKey: Int?
    let fuelCard: Int?

    enum CodingKeys: String, CodingKey {
        case odometer, cleanliness
        case fuelLevel = "fuel_level"
        case masterKey = "master_key"
        case fuelCard = "fuel_card"
    }
}

/// POST /api/my/check-session/confirm — kind: ack | checkin | checkout
struct CheckConfirmRequest: Encodable {
    let kind: String
}

/// رد الكتابة الموحد: items / vehicle-fields / no-change.
/// readiness كائن {readiness, reason} يعيده _recomputeReadiness (أو null للجلسات القديمة).
struct CheckWriteResponse: Decodable {
    struct Readiness: Decodable {
        let readiness: String?
        let reason: String?
    }
    let success: Bool?
    let sessionId: Int?
    let readiness: Readiness?
    let warning: String?
    let reflected: Bool?
}

struct CheckConfirmResponse: Decodable {
    let success: Bool?
    let sessionId: Int?
    let kind: String?
    let already: Bool?
    let completed: Bool?
}

// MARK: - /api/my/assignments (فك مرن — الحقول الأساسية مضمونة، الباقي اختياري)
struct AssignmentsDTO: Decodable {
    struct Period: Decodable, Identifiable {
        var id: String { "\(date ?? "؟")-\(shiftCode ?? "؟")-\(teamName ?? "؟")" }
        let date: String?
        let shiftCode: String?
        let shiftName: String?
        let timeStart: String?
        let timeEnd: String?
        let teamId: Int?
        let teamName: String?
        let center: String?
        let source: String?
    }
    let periods: [Period]?
    let assignmentSource: String?
    let available: Bool?
    let reason: String?
}
