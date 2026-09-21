//
//  ArchiveOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال الأرشيف (docs/native-ios-platform-parity.md §15) —
//  قائمة المناوبات المؤرشفة + التحقق من سلامة الأرشيف + سجل الأرشفة +
//  إجراءات الأرشفة/الاستعادة/إعادة الأرشفة. كل الأشكال مُتحققة من
//  server.js وshift-archive-engine.js (انظر تعليقات كل نموذج).
//

import Foundation

// MARK: - GET /api/shifts/archive — قائمة المناوبات (server.js:2877)
/// استجابة: { success, shifts: [normalizeShiftRow], total, page, total_pages }
struct ArchiveListResponseDTO: Decodable {
    let success: Bool?
    let shifts: [ArchiveShiftDTO]?
    let total: Int?
    let page: Int?
    let totalPages: Int?

    enum CodingKeys: String, CodingKey {
        case success, shifts, total, page
        case totalPages = "total_pages"
    }
}

/// صف المناوبة من normalizeShiftRow (server.js:2117) — الحقول كلها متسامحة.
struct ArchiveShiftDTO: Decodable, Identifiable {
    let id: Int
    let shiftName: String?
    let shiftDate: String?
    let shiftTime: String?
    let shiftType: String?
    let shiftDay: String?
    let startTime: String?
    let totalReports: Int?
    let generalNotes: String?
    let lastUpdate: String?
    let status: String?        // 'active' افتراضيًا سيرفريًا
    let archivedAt: String?
    let createdAt: String?

    var displayName: String {
        shiftName ?? "مناوبة #\(id)"
    }
    var isArchived: Bool { status == "archived" }
    var statusTitle: String {
        switch status {
        case "archived": return "مؤرشفة"
        case "pending_handover": return "بانتظار التسليم"
        default: return "نشطة"
        }
    }
}

// MARK: - GET /api/shifts/:id/verify-archive (server.js:15048)
/// استجابة: { success, shiftId, passed, timestamp, checks }
/// checks من ShiftIntegrityChecker.verify (shift-archive-engine.js:827):
/// hashMatch / dataLinkage / fileIntegrity / dataCompleteness / noDuplicates —
/// كل فحص { passed: Bool, ...حقول إضافية حرة }. DTO متسامح.
struct VerifyArchiveResponseDTO: Decodable {
    let success: Bool?
    let shiftId: Int?
    let passed: Bool?
    let timestamp: String?
    let checks: [String: ArchiveCheckDTO]?
}

/// فحص سلامة واحد — passed ثابت، والباقي حسب نوع الفحص.
struct ArchiveCheckDTO: Decodable {
    let passed: Bool?
    let issues: [String]?
    let error: String?
    let checked: Int?
    let missing: Int?
    let missingSections: [String]?
    let duplicateCount: Int?
}

// MARK: - GET /api/shifts/:id/archive-log (server.js:15108)
/// استجابة: { success, shiftId, logs }
/// سطر السجل من ShiftAuditLogger.log (shift-archive-engine.js:973):
/// { id: "timestamp-random", timestamp: ISO, operation, shiftId, details, user: {id,name,role}? }
struct ArchiveLogResponseDTO: Decodable {
    let success: Bool?
    let shiftId: Int?
    let logs: [ArchiveLogEntryDTO]?
}

struct ArchiveLogEntryDTO: Decodable {
    /// المعرف سيرفري نصي ("1700000000000-ab12cd").
    let id: String?
    let timestamp: String?
    let operation: String?     // validate | snapshot | save | verify | rollback | archive
    let shiftId: Int?
    let details: ArchiveLogDetailsDTO?
    let user: ArchiveLogUserDTO?

    enum CodingKeys: String, CodingKey {
        case id, timestamp, operation, shiftId, details, user
    }

    // فكّ متسامح: details حرة الشكل وقد لا تكون كائنًا في بعض المسارات —
    // سطر معيب واحد لا يجب أن يسقط سجل الأرشفة كاملًا.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decode(String.self, forKey: .id)
        timestamp = try? c.decode(String.self, forKey: .timestamp)
        operation = try? c.decode(String.self, forKey: .operation)
        shiftId = try? c.decode(Int.self, forKey: .shiftId)
        details = try? c.decode(ArchiveLogDetailsDTO.self, forKey: .details)
        user = try? c.decode(ArchiveLogUserDTO.self, forKey: .user)
    }

    var stableId: String { id ?? "\(timestamp ?? "")-\(operation ?? "")" }

    var operationTitle: String {
        switch operation {
        case "validate": return "تحقق قبل الأرشفة"
        case "snapshot": return "إنشاء اللقطة"
        case "save":     return "حفظ الأرشيف"
        case "verify":   return "التحقق من السلامة"
        case "rollback": return "تراجع"
        case "archive":  return "أرشفة"
        default:         return operation ?? "عملية"
        }
    }
}

struct ArchiveLogUserDTO: Decodable {
    let id: Int?
    let name: String?
    let role: String?
}

/// details حرة الشكل — نلتقط الحقول النصية المعروفة فقط ونتجاهل أي اختلاف
/// في الأنواع (السجل يُبنى من مسارات كثيرة في المحرك).
struct ArchiveLogDetailsDTO: Decodable {
    let status: String?
    let message: String?
    let error: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        status = try? c.decode(String.self, forKey: AnyKey("status"))
        message = try? c.decode(String.self, forKey: AnyKey("message"))
        error = try? c.decode(String.self, forKey: AnyKey("error"))
    }

    var summary: String? { message ?? status ?? error }

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
}

// MARK: - إجراءات الكتابة
/// POST /api/shift/:id/archive (admin، server.js:3517) — نتيجة archiveService.archive
/// POST /api/shift/:id/restore (admin+director، server.js:3545) — نتيجة startShift
/// POST /api/shifts/:id/rearchive (admin، server.js:15074) —
///   { success, shiftId, message, snapshotHash, duration }
/// الشكل العام متسامح لأن نتيجة المحرك تختلف بين المسارات الثلاثة.
struct ArchiveActionResponseDTO: Decodable {
    let success: Bool?
    let message: String?
    let error: String?
    let snapshotHash: String?
    let duration: Double?
    /// بعض نتائج المحرك تُعيد المناوبة الجديدة (restore = startShift).
    let shiftId: Int?
}

/// جسم طلب الأرشفة المباشرة — reason اختياري (server.js:3527).
struct ArchiveRequestDTO: Encodable {
    let reason: String?
}
