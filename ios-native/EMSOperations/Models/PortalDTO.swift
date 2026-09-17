//
//  PortalDTO.swift
//  EMSOperations
//
//  نماذج بوابة الموظف — مطابقة لأشكال my-portal-service.js (API mapping §3).
//  كل الحقول اختيارية دفاعيًا ما عدا ما يضمنه الخادم؛ لا حساب في العميل.
//

import Foundation

// MARK: - /api/my/profile
struct ProfileDTO: Decodable {
    struct Employee: Decodable {
        let id: Int?
        let code: String?
        let name: String
        let jobTitle: String?
    }
    struct Today: Decodable {
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
        let id: Int?
        let name: String
        let jobTitle: String?
        let teamName: String?
        let shiftCode: String?
        let phone: String?      // يصل فقط لحامل staff.phone_view — الخادم يطبق الصلاحية
        let isMe: Bool?
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

// MARK: - /api/my/check-session (D10 — الحالات الأساسية، التفاصيل تُثبت على الجهاز)
struct CheckSessionDTO: Decodable {
    struct TeamView: Decodable {
        let id: Int?
        let name: String?
        let center: String?
    }
    let state: String?            // no_assignment | not_field_team | nil عند وجود جلسة
    let today: String?
    let team: TeamView?
    // عند وجود جلسة نشطة يعيد الخادم session/vehicle — نفكها بمرونة
    let session: Session?
    let vehicle: VehicleDTO.Vehicle?

    struct Session: Decodable {
        let id: Int?
        let status: String?
        let items: [Item]?
    }
    struct Item: Decodable, Identifiable {
        var id: String { itemKey ?? UUID().uuidString }
        let itemKey: String?
        let label: String?
        let result: String?
        let note: String?

        enum CodingKeys: String, CodingKey {
            case label, result, note
            case itemKey = "item_key"
        }
    }
}

struct CheckItemRequest: Encodable {
    let itemKey: String
    let result: String
    let note: String?

    enum CodingKeys: String, CodingKey {
        case result, note
        case itemKey = "item_key"
    }
}

struct CheckConfirmResponse: Decodable {
    let success: Bool?
    let status: String?
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
