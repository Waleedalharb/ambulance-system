//
//  IndicatorsDTO.swift
//  EMSOperations
//
//  نماذج مجال المؤشرات والتحليلات (§21) — مطابقة لأشكال الـBackend المُتحقق
//  منها من المصدر (indicator-service.js + crew-activity-service.js).
//  قراءات فقط؛ لا حساب في العميل. التحفظات (caveats) جزء من العقد وتُعرض كما هي.
//

import Foundation

// MARK: - GET /api/indicators/dashboard (indicator-service getDashboard)
struct IndicatorsDashboardDTO: Decodable {
    struct ShiftStats: Decodable {
        let totalShifts: Int?
        let totalReports: Int?
        let avgReportsPerShift: Int?
        let maxReports: Int?
        let minReports: Int?
        let todayShifts: Int?
    }
    struct RecentShift: Decodable, Identifiable {
        let id: Int?
        let name: String?
        let date: String?
        let type: String?
        let totalReports: Int?
    }
    struct Week: Decodable, Identifiable {
        let weekStart: String?
        let shiftCount: Int?
        let reports: Int?
        let avg: Int?
        let max: Int?
        let min: Int?
        var id: String { weekStart ?? UUID().uuidString }
    }
    struct CenterCount: Decodable, Identifiable {
        let center: String?
        let count: Int?
        var id: String { center ?? UUID().uuidString }
    }

    let success: Bool?
    let shiftStats: ShiftStats?
    let recentShifts: [RecentShift]?
    let shiftTypes: [String: Int]?
    let weekly: [Week]?
    let centerDistribution: [CenterCount]?
}

// MARK: - GET /api/indicators/contribution (indicators.contribution)
struct ContributionDTO: Decodable {
    struct Range: Decodable {
        let from: String?
        let to: String?
    }
    struct Positioning: Decodable {
        let created: Int?
        let updated: Int?
        let ended: Int?
        let swept: Int?
        let total: Int?
    }
    struct Forms: Decodable {
        let total: Int?
        let byType: [String: Int]?
    }
    struct WorkflowActions: Decodable {
        let create: Int?
        let approve: Int?
        let pdf: Int?
        let reissue: Int?
        let editFields: Int?
        let other: Int?
        let total: Int?

        enum CodingKeys: String, CodingKey {
            case create, approve, pdf, reissue, other, total
            case editFields = "edit_fields"
        }
    }
    struct Works: Decodable {
        let completions: Int?
        let dispatchActions: Int?
        let reports: Int?
        let dispatchUndo: Int?
        let detailedReports: Int?
        let positioning: Positioning?
        let signouts: Int?
        let forms: Forms?
        let staffingEvents: Int?
        let vehicleEvents: Int?
        let logisticsEvents: Int?
        let centerEvents: Int?
        let workflowActions: WorkflowActions?
        let scheduleEdits: Int?
        let shiftLifecycle: Int?
        let docs: Int?
        let announcements: Int?
        let alertsAcked: Int?
    }
    struct Employee: Decodable, Identifiable {
        let employeeCode: String?
        let name: String?
        let jobTitle: String?
        let hasUserAccount: Bool?
        let hasSchedule: Bool?
        let scheduledHours: Double?
        let shifts: Int?
        let uncountedRosterDays: Int?
        let works: Works?
        let totalWorks: Int?

        var id: String { employeeCode ?? name ?? UUID().uuidString }
    }
    struct Groups: Decodable {
        let operations: [Employee]?
        let fieldLeadership: [Employee]?
    }
    struct UnmatchedTitle: Decodable, Identifiable {
        let jobTitle: String?
        let count: Int?
        var id: String { jobTitle ?? UUID().uuidString }
    }

    let success: Bool?
    let year: Int?
    let month: Int?
    let monthKey: String?
    let range: Range?
    let generatedAt: String?
    let groups: Groups?
    let unmatchedJobTitles: [UnmatchedTitle]?
    let caveats: [String]?
}

// MARK: - GET /api/crew-performance/activity (crew-activity-service getActivity)
struct CrewActivityDTO: Decodable {
    struct PeriodRange: Decodable {
        let from: String?
        let to: String?
        let shiftsCount: Int?

        enum CodingKeys: String, CodingKey {
            case from, to
            case shiftsCount = "shifts_count"
        }
    }
    struct Standing: Decodable, Identifiable {
        let rank: Int?
        let team: String?
        let center: String?
        let reportsCount: Int?
        let members: Int?
        let membersIncomplete: Int?
        let shiftMinutes: Int?
        let activeMinutes: Int?

        var id: String { team ?? "\(rank ?? 0)" }

        enum CodingKeys: String, CodingKey {
            case rank, team, center, members
            case reportsCount = "reports_count"
            case membersIncomplete = "members_incomplete"
            case shiftMinutes = "shift_minutes"
            case activeMinutes = "active_minutes"
        }
    }
    struct Meta: Decodable {
        let teamsRanked: Int?
        let teamsActiveWithoutReports: Int?
        let note: String?

        enum CodingKeys: String, CodingKey {
            case note
            case teamsRanked = "teams_ranked"
            case teamsActiveWithoutReports = "teams_active_without_reports"
        }
    }

    let success: Bool?
    let scope: String?
    let period: String?
    let periodRange: PeriodRange?
    let label: String?
    let generatedAt: String?
    let standings: [Standing]?
    let meta: Meta?

    enum CodingKeys: String, CodingKey {
        case success, scope, period, label, standings, meta
        case periodRange = "period_range"
        case generatedAt = "generated_at"
    }
}
