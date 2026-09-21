//
//  OpsDTO.swift
//  EMSOperations
//
//  نماذج وحدة العمليات — مطابقة لأشكال الـBackend المُتحقق منها من المصدر
//  (docs/native-platform-activation.md). فكّ دفاعي: كل الحقول اختيارية
//  ما عدا ما يضمنه الخادم صراحة؛ لا حساب ولا اشتقاق في العميل.
//

import Foundation

// MARK: - /api/teams — سجل الفرق المرجعي (جدول teams في db.js)
struct OpsTeamsDTO: Decodable {
    struct Team: Decodable, Identifiable {
        let teamId: Int?
        let name: String?
        let center: String?
        let teamType: String?
        let sortOrder: Int?
        let isActive: Int?          // SQLite 0/1
        let requiredPersonnel: Int?

        var id: String { name ?? String(teamId ?? 0) }

        enum CodingKeys: String, CodingKey {
            case name, center, requiredPersonnel
            case teamId = "id"
            case teamType = "team_type"
            case sortOrder = "sort_order"
            case isActive = "is_active"
        }
    }
    let success: Bool?
    let teams: [Team]?
}

// MARK: - /api/staffing/state ← StaffingEventsService.deriveTeamReadiness
struct StaffingStateDTO: Decodable {
    struct Member: Decodable, Identifiable {
        var id: String { "\(name ?? "؟")|\(role ?? "")|\(state ?? "")|\(since ?? "")" }
        let name: String?
        let jobTitle: String?
        let code: String?
        let phone: String?
        let role: String?           // base | support | activation
        let state: String?          // active | absence | late | assignment | activation
        let activationKind: String? // overlap | volunteer — تمييز عرضي خالص
        let supportType: String?
        let coverageType: String?
        let fromCenter: String?
        let since: String?
        let recordedBy: String?
    }
    struct Absentee: Decodable, Identifiable {
        var id: String { "\(name ?? "؟")|\(since ?? "")" }
        let name: String?
        let jobTitle: String?
        let code: String?
        let phone: String?
        let reason: String?
        let since: String?
        let recordedBy: String?
        let type: String?           // absence | late
    }
    struct LastDecision: Decodable {
        let status: String?
        let reason: String?
        let by: String?
        let at: String?
    }
    struct TeamReadiness: Decodable {
        let status: String?         // ready | missing | offline | pending
        let reason: String?
        let activeCount: Int?
        let requiredPersonnel: Int?
        let center: String?
        let members: [Member]?
        let absentees: [Absentee]?
        let vacant: Int?
        let vehicleId: String?
        let vehicleStatus: String?
        let vehicleOk: Bool?
        let supportVehicleIds: [String]?
        let lastDecision: LastDecision?
    }
    struct Workforce: Decodable {
        let totalStaff: Int?
        let totalRequired: Int?
        let scheduledStaff: Int?
        let supporters: Int?
        let absentees: Int?
        let requiredTeams: Int?
        let readyTeams: Int?
        let missingTeams: Int?
        let offlineTeams: Int?
        let pendingTeams: Int?
        let totalCars: Int?
        let readinessRate: Int?
        let operationalReadinessRate: Int?
    }
    let success: Bool?
    let shiftId: Int?
    let domain: String?
    /// قاموس: اسم الفريق ← حالته. JSON لا يضمن ترتيب المفاتيح — الفرز في sortedTeamNames.
    let teams: [String: TeamReadiness]?
    let workforce: Workforce?

    /// فرز طبيعي (جنوب 1..10 ثم سريع…) — نفس دلالة sortTeamsNatural في الخادم.
    var sortedTeamNames: [String] {
        (teams ?? [:]).keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}

// MARK: - /api/vehicles/board ← VehicleEventsService.getBoard
struct VehiclesBoardDTO: Decodable {
    struct Counters: Decodable {
        let active: Int?
        let reserve: Int?
        let breakdown: Int?
        let outOfService: Int?
        let unset: Int?

        enum CodingKeys: String, CodingKey {
            case active, reserve, breakdown, unset
            case outOfService = "out_of_service"
        }
    }
    struct Vehicle: Decodable, Identifiable {
        let vehicleId: String?      // veh_NNNNNN
        let name: String?           // call_sign أو plate_number
        let status: String?         // active | reserve | breakdown | out_of_service | null
        let reason: String?
        let since: String?
        let inWorkshop: Bool?
        let teamId: Int?
        let supportingTeamId: Int?

        var id: String { vehicleId ?? name ?? UUID().uuidString }
        var displayName: String { name ?? vehicleId ?? "مركبة" }

        enum CodingKeys: String, CodingKey {
            case name, status, reason, since, inWorkshop, teamId, supportingTeamId
            case vehicleId = "id"
        }
    }
    struct SupportLink: Decodable, Identifiable {
        let vehicleId: String?
        let name: String?
        let homeTeamId: Int?
        let targetTeamId: Int?
        let since: String?

        var id: String { vehicleId ?? UUID().uuidString }
    }
    let success: Bool?
    let shiftId: Int?
    let counters: Counters?
    let vehicles: [Vehicle]?
    let unassigned: [Vehicle]?
    let support: [SupportLink]?
}

// MARK: - /api/timeline — الأحداث التشغيلية
struct TimelineDTO: Decodable {
    struct Item: Decodable, Identifiable {
        var id: String { "\(date ?? "؟")|\(time ?? "")|\(title ?? "؟")" }
        let title: String?
        let desc: String?
        let type: String?
        let date: String?
        let time: String?
    }
    let success: Bool?
    let data: [Item]?

    /// الخادم يقرأ timeline.json خامًا — قد يكون كائنًا قديمًا لا مصفوفة.
    /// نتسامح مع الشكلين: غير-المصفوفة = لا أحداث (حالة صادقة لا خطأ فكّ ترميز).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = try c.decodeIfPresent(Bool.self, forKey: .success)
        data = (try? c.decodeIfPresent([Item].self, forKey: .data)) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case success, data }
}

// MARK: - /api/ops/centers — إحداثيات المراكز من المصدر الوحيد (SSOT)
// عقد server.js:1511 ← CentersGeoService: المراكز الجغرافية المعتمدة فقط في data،
// وسلامة المرجع في integrity (المراكز الناقصة من teams.center تظهر في missing).
struct OpsCentersDTO: Decodable {
    struct Center: Decodable {
        let center: [Double]?       // [lat, lng]
        let radius: Double?
        let address: String?
    }
    struct Integrity: Decodable {
        struct Missing: Decodable {
            let center: String?
            let teams: [String]?
        }
        let complete: Bool?
        let missing: [Missing]?
        let loadError: String?
    }
    let success: Bool?
    let version: Int?
    let data: [String: Center]?
    let integrity: Integrity?
}

// MARK: - /api/current-shift — سياق المناوبة الحالية
struct CurrentShiftDTO: Decodable {
    struct Shift: Decodable {
        let id: Int?
        let status: String?
        let type: String?
        let date: String?
    }
    struct PrepShift: Decodable {
        let type: String?
        let date: String?
    }
    let success: Bool?
    let shift: Shift?
    let serverNow: String?
    let prepShift: PrepShift?
}

// MARK: - /api/smart-operator/assessment ← decision-engine.assess
struct SmartAssessmentDTO: Decodable {
    struct ShiftInfo: Decodable {
        let id: Int?
        let type: String?
        let date: String?
        let status: String?
    }
    struct Readiness: Decodable {
        let percent: Int?
        let status: String?         // stable | attention | critical
    }
    struct Risk: Decodable, Identifiable {
        var id: String { "\(code ?? "؟")|\(team ?? "")|\(title ?? "")" }
        let code: String?
        let severity: String?       // critical | warning | info
        let team: String?
        let title: String?
        let detail: String?
    }
    struct Recommendation: Decodable, Identifiable {
        var id: String { "\(code ?? "؟")|\(priority ?? 0)|\(title ?? "")" }
        let code: String?
        let priority: Int?
        let title: String?
        let action: String?
    }
    struct Proactive: Decodable, Identifiable {
        var id: String { "\(code ?? "؟")|\(text ?? "")" }
        let code: String?
        let text: String?
    }
    struct Assessment: Decodable {
        let generatedAt: String?
        let shift: ShiftInfo?
        let shiftPhase: String?     // early | mid | late | final | unknown
        let readiness: Readiness?
        let risks: [Risk]?
        let recommendations: [Recommendation]?
        let proactive: [Proactive]?
        let summary: String?
        let supportCount: Int?
    }
    let success: Bool?
    let data: Assessment?
}
