//
//  CompletionOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال التكميل العملياتي (docs/native-ios-platform-parity.md §7) —
//  مطابقة لأشكال الـBackend المُتحقق منها من المصدر (server.js +
//  staffing-events-service.js + notes-service.js). فكّ دفاعي.
//
//  ملاحظة معمارية: غيابات/ملاحظات المناوبة قوائم «حرة الحقول»
//  (استبدال جماعي) — تُدار خامًا عبر APIClient.getRaw/postRaw في
//  CompletionOpsViewModel حفاظًا على الحقول غير المعروفة، ولا تُمثَّل هنا.
//

import Foundation

// MARK: - GET /api/staffing/available-support — حوض الدعم المتاح
struct SupportPoolDTO: Decodable {
    struct Supporter: Decodable, Identifiable {
        var id: String { name ?? "؟" }
        let name: String?
        let employeeCode: String?
        let jobTitle: String?
        let phone: String?            // بوابة staff.phone_view خادميًا — null لغير المخوَّل
        let team: String?
        let shiftCode: String?
        let sourceUnit: String?
        let kind: String?
        let volunteer: Bool?          // «متطوع — غير مفعّل» (مسار الـOverlap)

        enum CodingKeys: String, CodingKey {
            case name, team, kind, volunteer
            case employeeCode, jobTitle, shiftCode, sourceUnit, phone
        }
    }
    let success: Bool?
    let shiftId: Int?
    let supporters: [Supporter]?
}

// MARK: - GET /api/staffing/volunteer-candidates?q= — مرشحو التطوع
struct VolunteerCandidatesDTO: Decodable {
    struct Candidate: Decodable, Identifiable {
        var id: String { name ?? "؟" }
        let name: String?
        let employeeCode: String?
        let jobTitle: String?
        let phone: String?            // بوابة staff.phone_view خادميًا — null لغير المخوَّل
        let dayCode: String?
    }
    let success: Bool?
    let shiftId: Int?
    let candidates: [Candidate]?
}

// MARK: - نتيجة حفظ أحداث الأشخاص (POST /api/shift-completion)
// ملاحظة: سجل أحداث المناوبة GET /api/shift-events/:shiftId يستخدم التعريف
// القانوني الوحيد ShiftEventsDTO/ShiftEventDTO من TimelineOpsDTO (توحيد تكرار).
struct CompletionSaveResponseDTO: Decodable {
    let success: Bool?
    let message: String?
    let appended: Int?
    let corrected: Bool?
    let stampedShiftType: String?
    let stampedShiftDate: String?
}

// MARK: - نتائج إجراءات staffing (activation / activation/end / volunteer)
struct StaffingActionResponseDTO: Decodable {
    let success: Bool?
    let appended: Int?
    let shiftId: Int?
    let message: String?
}

// MARK: - نتيجة نجاح عامة لسجلات المناوبة (events/notes/absences)
struct ShiftRecordActionResponseDTO: Decodable {
    let success: Bool?
}

// MARK: - طلبات الكتابة (Encodable)

/// حدث شخص واحد ضمن POST /api/shift-completion (تدفق VA).
/// الأنواع المقبولة سيرفريًا: absence · late · assignment · arrival ·
/// external_support · volunteer_support · support_end · offline · ready ·
/// missing · correction (corrects: arrival_time|late_void|absence_void|arrival_void)
/// · activation · activation_end.
struct PersonEventRequest: Encodable {
    let type: String
    var employeeName: String? = nil
    var teamId: String? = nil
    var reason: String? = nil
    var corrects: String? = nil
    var arrivalAt: String? = nil
}

/// جسم POST /api/shift-completion — بلا notes (لا نمس ملاحظات الراديو من هنا).
struct CompletionEventsRequest: Encodable {
    let shiftType: String
    let shiftDate: String
    let events: [PersonEventRequest]
}

struct StaffingActivationRequest: Encodable {
    let employeeName: String
    let teamName: String
    var note: String? = nil
}

struct StaffingActivationEndRequest: Encodable {
    let employeeName: String
    var note: String? = nil
}

struct StaffingVolunteerRequest: Encodable {
    var employeeCode: String? = nil
    var employeeName: String? = nil
    var note: String? = nil
}

struct ShiftEventCreateRequest: Encodable {
    let type: String
    let description: String
}
