//
//  RequestsDTO.swift
//  EMSOperations
//
//  نماذج المجالات 23-26 (إعلانات · إجازات · طلبات تغيير المناوبة · خروج الفرق) —
//  مطابقة لمعالجات server.js وdb.js وservices/signout-service.js.
//  لا حساب في العميل؛ الحالة والحسم النهائي من الخادم.
//

import Foundation

// MARK: - الإعلانات (§23) — GET /api/announcements → {success, data[]}
struct AnnouncementDTO: Decodable, Identifiable {
    let id: String
    let title: String?
    let body: String?
    let date: String?
    let pinned: Bool?
    let urgent: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, title, body, date, pinned, urgent
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // الخادم يولّد id كنص من Date.now() — فك مرن تحسبًا لأي شكل.
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) }
        else { id = UUID().uuidString }
        title = try? c.decode(String.self, forKey: .title)
        body = try? c.decode(String.self, forKey: .body)
        date = try? c.decode(String.self, forKey: .date)
        pinned = try? c.decode(Bool.self, forKey: .pinned)
        urgent = try? c.decode(Bool.self, forKey: .urgent)
    }
}

struct AnnouncementsResponseDTO: Decodable {
    let success: Bool?
    let data: [AnnouncementDTO]?
}

/// جسم إضافة إعلان — POST /api/announcements/add (admin فقط سيرفريًا).
struct AnnouncementAddBody: Encodable {
    let title: String
    let body: String
    let pinned: Bool
    let urgent: Bool
}

// MARK: - الإجازات المجدولة (§24) — GET /api/vacations → مصفوفة خام
// عنصر الملف المرجعي: {code, name, role, vacationStart, vacationEnd}.
// الحفظ save-vacations كتابة JSON كاملة قديمة — مؤجلة موثقة (قراءة فقط هنا).
struct VacationEntryDTO: Decodable, Identifiable {
    var id: String { code ?? name ?? UUID().uuidString }
    let code: String?
    let name: String?
    let role: String?
    let vacationStart: String?
    let vacationEnd: String?

    var hasVacation: Bool {
        !(vacationStart ?? "").isEmpty && !(vacationEnd ?? "").isEmpty
    }
}

// MARK: - طلبات الإجازة (§24) — db.LeaveRequests (JOIN employees)
struct LeaveRequestDTO: Decodable, Identifiable {
    let id: Int
    let employeeId: Int?
    let startDate: String?
    let endDate: String?
    let type: String?
    let status: String?
    let reason: String?
    let approvedBy: Int?
    let approvedAt: String?
    let createdAt: String?
    let employeeName: String?
    let employeeCode: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case employeeId = "employee_id"
        case startDate = "start_date"
        case endDate = "end_date"
        case type, status, reason
        case approvedBy = "approved_by"
        case approvedAt = "approved_at"
        case createdAt = "created_at"
        case employeeName = "employee_name"
        case employeeCode = "employee_code"
    }

    var isPending: Bool { status == "pending" }
    var statusLabel: String {
        switch status {
        case "approved": return "معتمدة"
        case "denied": return "مرفوضة"
        case "cancelled": return "ملغاة"
        default: return "قيد المراجعة"
        }
    }
    var statusTone: EMSTheme.StatusTone {
        switch status {
        case "approved": return .normal
        case "denied": return .danger
        case "cancelled": return .neutral
        default: return .monitor
        }
    }
}

struct LeaveRequestsResponseDTO: Decodable {
    let success: Bool?
    let requests: [LeaveRequestDTO]?
}

/// جسم طلب إجازة — POST /api/leave-requests (employee_id رقمي إلزامي).
struct LeaveRequestBody: Encodable {
    let employee_id: Int
    let start_date: String
    let end_date: String
    let type: String
    let reason: String?
}

/// جسم اعتماد/رفض — POST /api/leave-requests/:id/approve (admin/director).
struct LeaveApproveBody: Encodable {
    let status: String   // approved | denied
}

// MARK: - طلبات تغيير المناوبة (§25) — db.ShiftChangeRequests
struct ShiftChangeRequestDTO: Decodable, Identifiable {
    let id: Int
    let rosterId: Int?
    let employeeId: Int?
    let teamId: Int?
    let shiftDate: String?
    let proposedShiftCode: String?
    let oldShiftCode: String?
    let requestedBy: String?
    let requestedByName: String?
    let status: String?
    let reason: String?
    let reviewedBy: String?
    let reviewedAt: String?
    let createdAt: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case rosterId = "roster_id"
        case employeeId = "employee_id"
        case teamId = "team_id"
        case shiftDate = "shift_date"
        case proposedShiftCode = "proposed_shift_code"
        case oldShiftCode = "old_shift_code"
        case requestedBy = "requested_by"
        case requestedByName = "requested_by_name"
        case status, reason
        case reviewedBy = "reviewed_by"
        case reviewedAt = "reviewed_at"
        case createdAt = "created_at"
    }

    var isPending: Bool { status == "pending" }
    var statusLabel: String {
        switch status {
        case "approved": return "مقبول"
        case "denied": return "مرفوض"
        case "cancelled": return "ملغى"
        default: return "قيد المراجعة"
        }
    }
    var statusTone: EMSTheme.StatusTone {
        switch status {
        case "approved": return .normal
        case "denied": return .danger
        case "cancelled": return .neutral
        default: return .monitor
        }
    }
}

struct ShiftChangeListResponseDTO: Decodable {
    let success: Bool?
    let requests: [ShiftChangeRequestDTO]?
}

/// جسم طلب تغيير مناوبة — POST /api/shift-change-request (authenticate).
/// employee_id/shift_date/proposed_shift_code إلزامية سيرفريًا.
struct ShiftChangeRequestBody: Encodable {
    let employee_id: Int
    let shift_date: String
    let proposed_shift_code: String
    let old_shift_code: String?
    let team_id: Int?
    let reason: String?
}

/// جسم المراجعة — POST /api/shift-change-request/:id/review (admin/director).
struct ShiftChangeReviewBody: Encodable {
    let status: String   // approved | denied | cancelled
}

// MARK: - خروج الفرق (§26) — services/signout-service.js (_rowToJson camelCase)
struct SignoutDTO: Decodable, Identifiable {
    /// معرف السجل الرقمي من القاعدة — نعرّفه باسم داخلي ونشتق id نصيًا ثابتًا.
    let recordId: Int?
    let shiftId: Int?
    let shiftDate: String?
    let shiftType: String?
    let eventType: String?
    let team: String?
    let members: [String]?
    let notes: String?
    let recordedByName: String?
    let createdAt: String?

    var id: String { "\(recordId ?? 0)-\(team ?? "")-\(createdAt ?? "")" }

    private enum CodingKeys: String, CodingKey {
        case recordId = "id"
        case shiftId, shiftDate, shiftType, eventType, team, members, notes
        case recordedByName, createdAt
    }
}

struct SignoutListResponseDTO: Decodable {
    let success: Bool?
    let signouts: [SignoutDTO]?
}

/// اقتراح أفراد الفرقة — GET /api/signouts/suggest?team=
/// الخادم يدمج حقول الاقتراح في الجذر: {success, members, source, sourceShiftId, sourceLabel}.
struct SignoutSuggestDTO: Decodable {
    let success: Bool?
    let members: [String]?
    let source: String?
    let sourceShiftId: Int?
    let sourceLabel: String?

    var sourceText: String {
        switch source {
        case "signout": return "من آخر تسليم معتمد"
        case "current_shift": return "من تشكيلة المناوبة الحالية"
        case "previous_shift": return "من المناوبة السابقة"
        default: return sourceLabel ?? ""
        }
    }
}

/// جسم تسجيل الخروج — POST /api/signouts (ops.team_exit).
/// append-only: إعادة التسجيل = حدث جديد يبقي الأثر (لا UPDATE).
struct SignoutRecordBody: Encodable {
    let team: String
    let members: [String]
    let notes: String?
    let createdAt: String?   // وقت يدوي اختياري — الخادم يختم عند الغياب
}
