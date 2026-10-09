//
//  SupplementaryDTO.swift
//  EMSOperations
//
//  عقد «الجدول المرن» (المناوبة التكميلية) — معتمد 2026-10-08:
//  - GET  /api/my/supplementary-candidates?month=YYYY-MM
//  - POST /api/my/supplementary-requests            { target_date, shift_code }
//  - GET  /api/my/supplementary-requests
//  - POST /api/my/supplementary-requests/:id/cancel
//
//  لا توليد لأي candidate داخل iOS — كل ما يُعرض يأتي من الـBackend.
//  لا CPD/CPN hard-coded — الرموز والأسماء والأوقات تُعرض كما يرجعها العقد.
//  ترجمة reason codes تتم هنا (طبقة DTO/UI mapping) مع fallback آمن لأي
//  code غير معروف — لا حذف للخيار ولا افتراض معنى غير موجود.
//

import Foundation

// MARK: - مقترحات المناوبة التكميلية

struct SupplementaryCandidatesDTO: Decodable {
    let success: Bool?
    let month: String?
    let limits: Limits?
    let hours: Hours?
    let candidates: [Candidate]
    let unavailable: [Unavailable]

    struct Limits: Decodable {
        let maxPerMonth: Int?
        let used: Int?

        enum CodingKeys: String, CodingKey {
            case maxPerMonth = "max_per_month"
            case used
        }
    }

    /// معلومات توجيهية فقط (ليست بوابة أهلية) — أي حقل قد يغيب ⇒ nil بصدق.
    struct Hours: Decodable {
        let requiredHours: Double?
        let workedHours: Double?
        let remainingHours: Double?

        enum CodingKeys: String, CodingKey {
            case requiredHours = "required_hours"
            case workedHours = "worked_hours"
            case remainingHours = "remaining_hours"
        }
    }

    struct Candidate: Decodable, Identifiable, Hashable {
        let date: String
        let shiftCode: String
        let shiftName: String?
        let timeStart: String?
        let timeEnd: String?
        let durationHours: Double?
        let period: String?          // "day" | "night" (يُشتق سيرفريًا من الأوقات الفعلية)
        let coverageGap: Bool?

        var id: String { "\(date)|\(shiftCode)" }

        enum CodingKeys: String, CodingKey {
            case date
            case shiftCode = "shift_code"
            case shiftName = "shift_name"
            case timeStart = "time_start"
            case timeEnd = "time_end"
            case durationHours = "duration_hours"
            case period
            case coverageGap = "coverage_gap"
        }

        /// صباح/ليل من الحقل السيرفري `period` — لا استنتاج محلي من الرمز.
        var isNight: Bool { period == "night" }
    }

    struct Unavailable: Decodable, Identifiable, Hashable {
        let date: String
        let shiftCode: String
        let reasons: [String]

        var id: String { "\(date)|\(shiftCode)" }

        enum CodingKeys: String, CodingKey {
            case date
            case shiftCode = "shift_code"
            case reasons
        }
    }

    enum CodingKeys: String, CodingKey {
        case success, month, limits, hours, candidates, unavailable
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = try c.decodeIfPresent(Bool.self, forKey: .success)
        month = try c.decodeIfPresent(String.self, forKey: .month)
        limits = try c.decodeIfPresent(Limits.self, forKey: .limits)
        hours = try c.decodeIfPresent(Hours.self, forKey: .hours)
        candidates = try c.decodeIfPresent([Candidate].self, forKey: .candidates) ?? []
        unavailable = try c.decodeIfPresent([Unavailable].self, forKey: .unavailable) ?? []
    }
}

// MARK: - تقديم طلب / إلغاء

struct SupplementarySubmitResponseDTO: Decodable {
    let success: Bool?
    let id: Int?
    let status: String?          // pending_review | rejected (+أسباب)
    let reasons: [String]?
}

struct SupplementaryCancelResponseDTO: Decodable {
    let success: Bool?
    let status: String?          // cancelled
}

/// جسم التقديم — يطابق عقد الـBackend حرفيًا (snake_case).
struct SupplementarySubmitBody: Encodable {
    let targetDate: String
    let shiftCode: String

    enum CodingKeys: String, CodingKey {
        case targetDate = "target_date"
        case shiftCode = "shift_code"
    }
}

// MARK: - طلباتي

struct SupplementaryRequestsDTO: Decodable {
    let success: Bool?
    let requests: [SupplementaryRequest]

    enum CodingKeys: String, CodingKey { case success, requests }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = try c.decodeIfPresent(Bool.self, forKey: .success)
        requests = try c.decodeIfPresent([SupplementaryRequest].self, forKey: .requests) ?? []
    }
}

struct SupplementaryRequest: Decodable, Identifiable, Hashable {
    let id: Int
    let targetDate: String?
    let shiftCode: String?
    let teamName: String?
    let status: String?
    let reviewNote: String?
    let escalationReason: String?
    let createdAt: String?
    let appliedAt: String?
    let rosterId: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case targetDate = "target_date"
        case shiftCode = "shift_code"
        case teamName = "team_name"
        case status
        case reviewNote = "review_note"
        case escalationReason = "escalation_reason"
        case createdAt = "created_at"
        case appliedAt = "applied_at"
        case rosterId = "roster_id"
    }

    /// القاعدة الذهبية: لا يُعرض كمناوبة رسمية إلا من مصدر الجدول الرسمي
    /// بعد applied — هذا الحقل للعرض داخل قسم الجدول المرن فقط.
    var isApplied: Bool { status == "applied" }
    var isCancellable: Bool { ["pending_review", "approved", "escalated"].contains(status ?? "") }
}

// MARK: - حالات الطلب (عرض)

enum SupplementaryStatusDisplay {
    /// الحالات السبع المعتمدة في العقد — أي قيمة غير معروفة تُعرض بنصها الخام
    /// (صدق بيانات) بدل افتراض معنى.
    static func title(for status: String?) -> String {
        switch status {
        case "pending_review": return "بانتظار المراجعة"
        case "approved": return "معتمد — بانتظار التطبيق"
        case "applied": return "مطبَّق في الجدول"
        case "rejected": return "مرفوض"
        case "cancelled": return "ملغى"
        case "expired": return "منتهي"
        case "escalated": return "مصعَّد للمراجعة"
        case .some(let raw) where !raw.isEmpty: return raw
        default: return "غير معروف"
        }
    }

    static func tone(for status: String?) -> EMSTheme.StatusTone {
        switch status {
        case "applied": return .normal
        case "pending_review", "approved": return .action
        case "rejected": return .danger
        case "escalated": return .monitor
        default: return .neutral
        }
    }
}

// MARK: - ترجمة reason codes (طبقة UI/DTO mapping)

enum SupplementaryReasonText {
    /// الرموز المعروفة من عقد E-4/التكميلية — أي code غير معروف يُعرض كما هو
    /// بلا حذف للخيار وبلا افتراض معنى غير موجود (fallback آمن).
    static func message(for code: String) -> String {
        switch code {
        case "REST_BELOW_MINIMUM": return "لا يحقق فترة الراحة المطلوبة"
        case "COVERAGE_BELOW_MINIMUM": return "التغطية التشغيلية لا تسمح"
        case "CONSECUTIVE_NIGHTS_EXCEEDED": return "يتجاوز الحد المسموح للمناوبات الليلية المتتالية"
        case "MULTIPLE_SHIFTS_SAME_DAY": return "يوجد طلب أو مناوبة في هذا اليوم"
        case "SHIFT_OVERLAP": return "يتداخل مع مناوبة أخرى"
        case "LEAVE_CONFLICT_APPROVED": return "يوجد إجازة معتمدة في هذا اليوم"
        case "UNABLE_ATTEND_CONFLICT": return "مسجَّل تعذر حضور في هذا اليوم"
        case "NEXT_DAY_CONFLICT": return "يتعارض مع مناوبة اليوم التالي"
        case "EMPLOYEE_NOT_ACTIVE": return "الملف الوظيفي غير نشط"
        case "EMPLOYEE_NO_ACTIVE_TEAM": return "لا يوجد فريق نشط في هذا التاريخ"
        case "NOT_A_WORK_SHIFT": return "الرمز ليس مناوبة عمل"
        case "UNKNOWN_SHIFT_CODE": return "رمز المناوبة غير معروف"
        case "SUPP_NOTICE_WINDOW": return "خارج نافذة التقديم المسموحة"
        case "SUPP_MONTHLY_LIMIT": return "بلغت الحد الشهري للطلبات"
        case "SUPP_DUPLICATE_REQUEST": return "يوجد طلب قائم لهذا اليوم"
        default: return code
        }
    }
}
