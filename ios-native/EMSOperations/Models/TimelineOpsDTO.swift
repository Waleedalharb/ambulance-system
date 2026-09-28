//
//  TimelineOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال خطوط الأحداث (§14) — مطابقة لأشكال الـBackend المُتحقق منها
//  من المصدر (server.js + staffing-events-service.js + vehicle-events-service.js
//  + db.js). فكّ دفاعي: كل الحقول اختيارية؛ لا حساب ولا اشتقاق في العميل.
//

import Foundation

// MARK: - صف operational_events الخام (db.js — مخطط الجدول)
struct OpEventDTO: Decodable, Identifiable {
    let rowId: Int?
    let shiftId: Int?
    let domain: String?
    let entityId: String?
    let entityName: String?
    let teamId: String?
    let center: String?
    let eventType: String?
    let status: String?
    let reason: String?
    let payload: String?          // JSON خام نصي — لا يُفكّ في العميل
    let note: String?
    let actorName: String?
    let createdAt: String?

    var id: String { "\(rowId ?? 0)|\(createdAt ?? "")|\(eventType ?? "")" }

    enum CodingKeys: String, CodingKey {
        case rowId = "id"
        case shiftId = "shift_id"
        case domain
        case entityId = "entity_id"
        case entityName = "entity_name"
        case teamId = "team_id"
        case center
        case eventType = "event_type"
        case status, reason, payload, note
        case actorName = "actor_name"
        case createdAt = "created_at"
    }
}

// MARK: - سجل التأخير المشتق سيرفريًا (staffing-events-service deriveLateRecords)
struct LateRecordDTO: Decodable, Identifiable {
    let employee: String?
    let teamId: String?
    let startedAt: String?
    let arrivedAt: String?
    let durationMinutes: Int?
    let status: String?           // arrived | not_arrived
    let sourceEventType: String?  // late | absence
    let jobTitle: String?
    let code: String?
    let operationalStart: String?
    let responsibilityStart: String?
    let carryForwardAt: String?
    let carriedFromShiftId: Int?
    let delayUnderShiftMinutes: Int?

    var id: String { "\(employee ?? "؟")|\(startedAt ?? "")|\(status ?? "")" }
}

// MARK: - سجل التغطية المشتق سيرفريًا (deriveCoverageRecords)
struct CoverageRecordDTO: Decodable, Identifiable {
    let employee: String?
    let employeeNumber: String?
    let fromCenter: String?
    let coverageType: String?
    let coverageTypeLabel: String?
    let teamId: String?
    let startedAt: String?
    let endedAt: String?
    let durationMinutes: Int?
    let status: String?           // active | ended
    let approvedBy: String?

    var id: String { "\(employee ?? "؟")|\(startedAt ?? "")|\(coverageType ?? "")" }
}

// MARK: - GET /api/staffing/timeline
struct StaffingTimelineDTO: Decodable {
    let success: Bool?
    let shiftId: Int?
    let events: [OpEventDTO]?
    let lateRecords: [LateRecordDTO]?
    let coverageRecords: [CoverageRecordDTO]?
}

// MARK: - GET /api/vehicles/timeline
struct VehiclesTimelineDTO: Decodable {
    let success: Bool?
    let shiftId: Int?
    let events: [OpEventDTO]?
}

// MARK: - GET /api/shifts/:id/timeline — صف shift_timeline_events (db.js)
struct ShiftTimelineEventDTO: Decodable, Identifiable {
    let rowId: Int?
    let eventType: String?
    let eventTitle: String?
    let eventDescription: String?
    let eventTime: String?
    let createdByName: String?
    let createdAt: String?

    var id: String { "\(rowId ?? 0)|\(eventTime ?? "")" }

    enum CodingKeys: String, CodingKey {
        case rowId = "id"
        case eventType = "event_type"
        case eventTitle = "event_title"
        case eventDescription = "event_description"
        case eventTime = "event_time"
        case createdByName = "created_by_name"
        case createdAt = "created_at"
    }
}

struct ShiftTimelineDTO: Decodable {
    let success: Bool?
    let events: [ShiftTimelineEventDTO]?
}

// MARK: - GET/POST /api/shift-events/:shiftId — سجل أحداث المناوبة اليدوي
struct ShiftEventDTO: Decodable, Identifiable {
    let id: String
    let shiftId: Int?
    let type: String?
    let description: String?
    let timestamp: String?
    let createdAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // id نصي في العقد المشتق (String(rowId)) وقد يأتي رقمًا من صف خام
        if let s = try? c.decode(String.self, forKey: .id) {
            id = s
        } else if let n = try? c.decode(Int.self, forKey: .id) {
            id = String(n)
        } else {
            id = UUID().uuidString
        }
        shiftId = try c.decodeIfPresent(Int.self, forKey: .shiftId)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        timestamp = try c.decodeIfPresent(String.self, forKey: .timestamp)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    enum CodingKeys: String, CodingKey {
        case id, type, description, timestamp
        case shiftId = "shiftId"
        case createdAt = "createdAt"
    }
}

struct ShiftEventsDTO: Decodable {
    let success: Bool?
    let events: [ShiftEventDTO]?
}

struct ShiftEventCreateRequestDTO: Encodable {
    let type: String
    let description: String
    let timestamp: String?
}

struct ShiftEventCreateResponseDTO: Decodable {
    let success: Bool?
    let event: ShiftEventDTO?
}

struct BasicSuccessDTO: Decodable {
    let success: Bool?
}
