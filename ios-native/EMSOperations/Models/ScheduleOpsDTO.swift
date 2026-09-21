//
//  ScheduleOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال الجداول — مطابقة لأشكال الـBackend المُتحقق منها من المصدر
//  (docs/native-schedule-parity.md). فكّ دفاعي: كل الحقول اختيارية ما عدا
//  ما يضمنه الخادم صراحة؛ لا حساب ولا اشتقاق في العميل.
//

import Foundation

// MARK: - GET /api/shift-roster?month&year — شبكة الجدول الشهرية
struct RosterMonthDTO: Decodable {
    /// Codable: تصدير JSON يعيد ترميز السجلات لمشاركتها ملفًا.
    struct Entry: Codable, Identifiable {
        let id: Int?
        let employeeId: Int?
        let teamId: Int?
        let shiftDate: String?       // YYYY-MM-DD
        let shiftCode: String?
        let month: Int?
        let year: Int?
        let employeeName: String?
        let employeeCode: String?
        let teamName: String?

        enum CodingKeys: String, CodingKey {
            case id, month, year
            case employeeId = "employee_id"
            case teamId = "team_id"
            case shiftDate = "shift_date"
            case shiftCode = "shift_code"
            case employeeName = "employee_name"
            case employeeCode = "employee_code"
            case teamName = "team_name"
        }

        /// مفتاح عرض ثابت — السجل قد يصل بلا id في حالات الحدود.
        var stableId: String { id.map(String.init) ?? "\(employeeId ?? 0)-\(shiftDate ?? "؟")" }
    }
    let success: Bool?
    let roster: [Entry]?
}

// MARK: - GET /api/shift-roster/months — الشهور المتاحة
struct RosterMonthsDTO: Decodable {
    let success: Bool?
    let months: [String]?            // "YYYY-MM" تصاعديًا
}

// MARK: - GET /api/shift-roster/stats — إحصاءات شهر
struct RosterStatsDTO: Decodable {
    let success: Bool?
    let totalShifts: Int?
    let employeesCount: Int?
    let shiftCodeBreakdown: [String: Int]?
    let teamCoverage: [String: Int]?
    let conflictsCount: Int?

    enum CodingKeys: String, CodingKey {
        case success
        case totalShifts = "total_shifts"
        case employeesCount = "employees_count"
        case shiftCodeBreakdown = "shift_code_breakdown"
        case teamCoverage = "team_coverage"
        case conflictsCount = "conflicts_count"
    }
}

// MARK: - GET /api/shift-codes — الرموز المعتمدة (لمنتقي التحرير)
struct ShiftCodesDTO: Decodable {
    struct Code: Decodable, Identifiable {
        let codeId: Int?
        let code: String?
        let name: String?
        let timeStart: String?
        let timeEnd: String?
        let color: String?
        let status: String?

        var id: String { code ?? String(codeId ?? 0) }

        enum CodingKeys: String, CodingKey {
            case code, name, color, status
            case codeId = "id"
            case timeStart = "time_start"
            case timeEnd = "time_end"
        }

        var displayLabel: String {
            guard let c = code else { return name ?? "—" }
            if let n = name, !n.isEmpty, n != c { return "\(c) — \(n)" }
            return c
        }
    }
    let success: Bool?
    let codes: [Code]?
}

// MARK: - GET /api/employees · /api/employees/search — دليل الموظفين
struct EmployeeDirectoryDTO: Decodable {
    struct Person: Decodable, Identifiable {
        let id: Int?
        let name: String?
        let employeeCode: String?
        let jobTitle: String?
        let isActive: Int?

        enum CodingKeys: String, CodingKey {
            case id, name
            case employeeCode = "employee_code"
            case jobTitle = "job_title"
            case isActive = "is_active"
        }
    }
    let success: Bool?
    let employees: [Person]?
    let results: [Person]?           // مسار search
}

// MARK: - GET /api/shift-roster/employee-schedule/:employeeId
struct EmployeeScheduleDTO: Decodable {
    struct Day: Decodable, Identifiable {
        var id: String { "\(date ?? "؟")|\(shiftCode ?? "؟")" }
        let date: String?
        let shiftCode: String?
        let shiftName: String?
        let teamName: String?
        let teamId: Int?

        enum CodingKeys: String, CodingKey {
            case date
            case shiftCode = "shift_code"
            case shiftName = "shift_name"
            case teamName = "team_name"
            case teamId = "team_id"
        }
    }
    let success: Bool?
    let schedule: [Day]?
}

// MARK: - GET /api/shift-roster/audit-log — سجل التدقيق (قبل/بعد سيرفري)
struct RosterAuditLogDTO: Decodable {
    struct Entry: Decodable, Identifiable {
        let id: Int?
        let rosterId: Int?
        let employeeId: Int?
        let teamId: Int?
        let shiftDate: String?
        let oldShiftCode: String?
        let newShiftCode: String?
        let oldTeamId: Int?
        let newTeamId: Int?
        let changedBy: String?
        let changedByName: String?
        let changeType: String?        // edit | swap | bulk | delete | add
        let reason: String?
        let createdAt: String?

        enum CodingKeys: String, CodingKey {
            case id, reason
            case rosterId = "roster_id"
            case employeeId = "employee_id"
            case teamId = "team_id"
            case shiftDate = "shift_date"
            case oldShiftCode = "old_shift_code"
            case newShiftCode = "new_shift_code"
            case oldTeamId = "old_team_id"
            case newTeamId = "new_team_id"
            case changedBy = "changed_by"
            case changedByName = "changed_by_name"
            case changeType = "change_type"
            case createdAt = "created_at"
        }
    }
    let success: Bool?
    let entries: [Entry]?
}

// MARK: - GET /api/shift-roster/drafts — مسودات المستخدم
struct RosterDraftsDTO: Decodable {
    struct Draft: Decodable, Identifiable {
        let id: Int?
        let draftDataJson: String?
        let operationType: String?     // edit | swap | bulk | delete | add
        let createdBy: String?
        let createdByName: String?
        let createdAt: String?
        let appliedAt: String?
        let revertedAt: String?

        enum CodingKeys: String, CodingKey {
            case id
            case draftDataJson = "draft_data_json"
            case operationType = "operation_type"
            case createdBy = "created_by"
            case createdByName = "created_by_name"
            case createdAt = "created_at"
            case appliedAt = "applied_at"
            case revertedAt = "reverted_at"
        }

        var isPending: Bool { appliedAt == nil && revertedAt == nil }
    }
    let success: Bool?
    let drafts: [Draft]?
}

// MARK: - POST /api/shift-roster/validate — تحقق مسبق
struct RosterValidateResponseDTO: Decodable {
    struct Conflict: Decodable, Identifiable {
        var id: String { "\(type ?? "؟")|\(employeeId ?? 0)|\(shiftDate ?? "؟")" }
        let type: String?              // missing_fields | invalid_code | duplicate | invalid_team
        let message: String?
        let employeeId: Int?
        let shiftDate: String?
        let teamId: Int?

        enum CodingKeys: String, CodingKey {
            case type, message
            case employeeId = "employee_id"
            case shiftDate = "shift_date"
            case teamId = "team_id"
        }
    }
    let success: Bool?
    let valid: Bool?
    let conflicts: [Conflict]?
}

// MARK: - PUT /api/shift-roster/cell — نتيجة تعديل خلية
struct RosterCellResponseDTO: Decodable {
    let success: Bool?
    let entry: RosterMonthDTO.Entry?
}

// MARK: - POST /api/shift-roster/bulk-update
struct RosterBulkResponseDTO: Decodable {
    struct Updated: Decodable {
        let rosterId: Int?
        let auditId: Int?
        enum CodingKeys: String, CodingKey {
            case rosterId = "roster_id"
            case auditId = "auditId"
        }
    }
    let success: Bool?
    let updated: Int?
    let conflicts: [RosterValidateResponseDTO.Conflict]?
}

// MARK: - POST /api/shift-roster/swap
struct RosterSwapResponseDTO: Decodable {
    struct Swapped: Decodable {
        let rosterId: Int?
        let oldEmployeeId: Int?
        let newEmployeeId: Int?
        enum CodingKeys: String, CodingKey {
            case rosterId = "roster_id"
            case oldEmployeeId = "old_employee_id"
            case newEmployeeId = "new_employee_id"
        }
    }
    let success: Bool?
    let swapped: [Swapped]?
}

// MARK: - POST /api/shift-roster/undo · /redo
struct RosterDraftActionResponseDTO: Decodable {
    let success: Bool?
    let draft: RosterDraftsDTO.Draft?
    let message: String?
}

// MARK: - POST /api/shift-roster/export — تصدير JSON
struct RosterExportResponseDTO: Decodable {
    let success: Bool?
    let downloadUrl: String?
    let format: String?
    let data: [RosterMonthDTO.Entry]?

    enum CodingKeys: String, CodingKey {
        case success, format, data
        case downloadUrl = "download_url"
    }
}

// MARK: - POST /api/shift-schedule/generate — التوليد الذكي (admin/director)
struct ScheduleGenerateResponseDTO: Decodable {
    let success: Bool?
    let mode: String?
    let schedule: [RosterMonthDTO.Entry]?
    let alerts: [ScheduleAlert]?

    struct ScheduleAlert: Decodable, Identifiable {
        var id: String { "\(alertDate ?? "؟")|\(alertType ?? "؟")|\(message ?? "")" }
        let alertDate: String?
        let alertType: String?
        let message: String?

        enum CodingKeys: String, CodingKey {
            case message
            case alertDate = "alert_date"
            case alertType = "alert_type"
        }
    }
}

// MARK: - GET /api/shift-schedule/month — الجدول المولّد (قراءة)
struct AutoScheduleMonthDTO: Decodable {
    let success: Bool?
    let schedule: [RosterMonthDTO.Entry]?
    let alerts: [ScheduleGenerateResponseDTO.ScheduleAlert]?
}

// MARK: - GET /api/schedule/metrics — مؤشرات الساعات (من ScheduleMetricsService)
struct ScheduleMetricsDTO: Decodable {
    struct EmployeeMetric: Decodable, Identifiable {
        var id: String { employeeCode ?? name ?? "؟" }
        let employeeCode: String?
        let name: String?
        let jobTitle: String?
        let specialty: String?
        let scheduledHours: Double?
        let requiredHours: Double?
        let deltaHours: Double?
        let status: String?            // complete | under | over
        let uncountedEntries: Int?
    }
    struct Summary: Decodable {
        let totalEmployees: Int?
        let complete: Int?
        let under: Int?
        let over: Int?
        let totalHours: Double?
        let avgHours: Double?
        let uncountedEntries: Int?
    }
    let success: Bool?
    let employees: [EmployeeMetric]?
    let summary: Summary?
}

// MARK: - طلبات الكتابة (Encodable)

struct RosterCellUpdateRequest: Encodable {
    let employeeCode: String
    let date: String
    let shiftCode: String
}

struct RosterAddRequest: Encodable {
    let employee_id: Int
    let shift_date: String
    let shift_code: String
    let month: Int
    let year: Int
    let team_id: Int?
}

struct RosterValidateRequest: Encodable {
    struct Change: Encodable {
        let employee_id: Int
        let shift_date: String
        let shift_code: String
        let team_id: Int?
    }
    let changes: [Change]
}

struct RosterBulkUpdateRequest: Codable {
    /// Codable: فكّ draft_data_json عند إعادة تطبيق المسودة (undo/redo).
    struct Change: Codable {
        let roster_id: Int
        var employee_id: Int?
        var team_id: Int?
        var shift_date: String?
        var shift_code: String?
        var old_shift_code: String?
    }
    let changes: [Change]
}

struct RosterSwapRequest: Encodable {
    let roster_id_1: Int
    let roster_id_2: Int
}

struct RosterDraftRequest: Encodable {
    let draft_data_json: String
    let operation_type: String
}

struct ScheduleGenerateRequest: Encodable {
    let year: Int
    let month: Int
    let mode: String                 // normal | alternative
}

struct RosterExportRequest: Encodable {
    let format: String               // excel | pdf
    let month: Int
    let year: Int
}

/// نتيجة نجاح عامة (إضافة/حذف/تحديث سجل/مسح بالمدى).
struct RosterGenericResponseDTO: Decodable {
    let success: Bool?
    let id: Int?
    let message: String?
    let deleted: Int?              // POST clear — عدد السجلات المحذوفة
}

// MARK: - GET /api/check-monthly-table → {exists} (server.js:9589)
/// فحص وجود الجدول الشهري الرسمي (Excel مرفوع من الويب — قراءة Native فقط).
struct MonthlyTableCheckDTO: Decodable {
    let exists: Bool?
}
