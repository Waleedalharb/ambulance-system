//
//  ShiftLifecycleDTO.swift
//  EMSOperations
//
//  نماذج دورة المناوبة (docs/native-ios-platform-parity.md §8) —
//  بدء/إنهاء/اعتماد تسليم + طوارئ (أرشفة/حذف/تعديل قسري).
//  الأرشفة الرسمية والتحقق والسجل في ArchiveOps (§15) — هنا دورة
//  الحياة الحية والطوارئ فقط.
//

import Foundation

// MARK: - دورة الحياة (نتائج المحرك — شكل حر)

/// POST /api/start-new-shift (shift.lifecycle، server.js:3446) — نتيجة
/// ShiftService.startShift (شكل حر: success + shift أو error).
/// POST /api/shift/:id/end (shift.lifecycle، server.js:3466) — نتيجة endShift.
/// POST /api/shift/:id/handover-approve (shift.approve، server.js:3482) —
/// نتيجة archiveService.archive.
struct ShiftLifecycleResultDTO: Decodable {
    let success: Bool?
    let message: String?
    let error: String?
    let shiftId: Int?

    enum CodingKeys: String, CodingKey {
        case success, message, error
        case shiftId = "shift_id"
    }

    enum AltKeys: String, CodingKey { case shiftIdCamel = "shiftId" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = try? c.decode(Bool.self, forKey: .success)
        message = try? c.decode(String.self, forKey: .message)
        error = try? c.decode(String.self, forKey: .error)
        if let v = try? c.decode(Int.self, forKey: .shiftId) {
            shiftId = v
        } else {
            let alt = try decoder.container(keyedBy: AltKeys.self)
            shiftId = try? alt.decode(Int.self, forKey: .shiftIdCamel)
        }
    }
}

/// جسم بدء المناوبة — shiftType اختياري (الخادم يحسم الافتراضي).
struct StartShiftRequestDTO: Encodable {
    let shiftType: String?
}

/// جسم إنهاء المناوبة — handoverNotes اختيارية (server.js:3470).
struct EndShiftRequestDTO: Encodable {
    let handoverNotes: String?
}

// MARK: - الطوارئ (admin/director)

/// GET /api/emergency/active-shifts (server.js:3563) —
/// { success, count, shifts: [صف SQLite خام: id/shift_name/.../status] }
struct EmergencyShiftsResponseDTO: Decodable {
    let success: Bool?
    let count: Int?
    let shifts: [EmergencyShiftDTO]?
}

struct EmergencyShiftDTO: Decodable, Identifiable {   // id: Int? — هوية سيرفرية حقيقية
    let id: Int?
    let shiftName: String?
    let shiftDate: String?
    let shiftType: String?
    let status: String?
    let startTime: String?
    let totalReports: Int?

    enum CodingKeys: String, CodingKey {
        case id, status
        case shiftName = "shift_name"
        case shiftDate = "shift_date"
        case shiftType = "shift_type"
        case startTime = "start_time"
        case totalReports = "total_reports"
    }

    var stableId: Int { id ?? 0 }
    var displayName: String { shiftName ?? "مناوبة #\(id ?? 0)" }
}

/// استجابات الطوارئ — { success, message } (server.js:3576/3593/3607).
/// POST archive-shift: { shiftId } (admin/director)
/// POST delete-shift: { shiftId } (admin فقط)
/// POST edit-shift: { shiftId, shiftType?, shiftDate? } (admin فقط)
struct EmergencyShiftRequestDTO: Encodable {
    let shiftId: Int
    let shiftType: String?
    let shiftDate: String?

    init(shiftId: Int, shiftType: String? = nil, shiftDate: String? = nil) {
        self.shiftId = shiftId
        self.shiftType = shiftType
        self.shiftDate = shiftDate
    }
}
