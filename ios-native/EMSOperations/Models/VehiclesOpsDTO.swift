//
//  VehiclesOpsDTO.swift
//  EMSOperations
//
//  نماذج كتابات مجال المركبات (docs/native-ios-platform-parity.md §10) —
//  مطابقة لـserver.js وVehicleEventsService. قانون append-only: لا حذف
//  إطلاقًا؛ الإنهاء/التبديل أحداث تُغلق المفتوح. الحالات: active | reserve |
//  breakdown | out_of_service (السبب إلزامي للأخيرتين — قاعدة سيرفرية).
//

import Foundation

// MARK: - POST /api/vehicles/events — تغيير الحالة (ختم سيرفري)
struct VehicleStatusEventRequest: Encodable {
    let vehicleId: String
    let status: String            // active | reserve | breakdown | out_of_service
    var reason: String? = nil     // إلزامي سيرفريًا عند breakdown/out_of_service
    var note: String? = nil
}

// MARK: - POST /api/vehicles/assignment و /assignment/switch
struct VehicleAssignmentRequest: Encodable {
    let vehicleId: String
    let teamId: Int
    var note: String? = nil
}

// MARK: - POST /api/vehicles/assignment/end و /support/end
struct VehicleActionNoteRequest: Encodable {
    let vehicleId: String
    var note: String? = nil
}

// MARK: - POST /api/vehicles/support
struct VehicleSupportRequest: Encodable {
    let vehicleId: String
    let targetTeamId: Int
    var note: String? = nil
}

// MARK: - GET /api/vehicles/:id/history — تاريخ المركبة عبر المناوبات
struct VehicleHistoryDTO: Decodable {
    struct VehicleInfo: Decodable {
        let id: String?
        let name: String?
        let plateNumber: String?
        let callSign: String?
        let vehicleType: String?
        let modelYear: Int?
        let category: String?
        let designation: String?
        let adminStatus: String?
        let notes: String?
    }
    struct Current: Decodable {
        let status: String?
        let reason: String?
        let since: String?
        let teamId: Int?
        let teamName: String?
    }
    struct Event: Decodable, Identifiable {
        var id: String { "\(eventId ?? 0)|\(createdAt ?? "")|\(eventType ?? "")" }
        let eventId: Int?
        let domain: String?
        let eventType: String?
        let status: String?
        let reason: String?
        let note: String?
        let teamId: Int?
        let teamName: String?
        let center: String?
        let shiftDate: String?
        let shiftType: String?
        let actorName: String?
        let createdAt: String?
        let createdAtRiyadh: String?

        enum CodingKeys: String, CodingKey {
            case eventId = "id"
            case domain, eventType, status, reason, note, teamId, teamName
            case center, shiftDate, shiftType, actorName, createdAt, createdAtRiyadh
        }
    }
    let success: Bool?
    let vehicle: VehicleInfo?
    let current: Current?
    let events: [Event]?
}

// MARK: - السجل المرجعي (GET /api/vehicles/registry — صفوف snake_case)
struct VehicleRegistryDTO: Decodable {
    struct Item: Decodable, Identifiable {
        var id: String { vehicleId ?? plateNumber ?? UUID().uuidString }
        let vehicleId: String?
        let plateNumber: String?
        let callSign: String?
        let vehicleType: String?
        let modelYear: Int?
        let category: String?
        let designation: String?
        let adminStatus: String?
        let ownerCenterId: String?
        let sortOrder: Int?
        let notes: String?

        enum CodingKeys: String, CodingKey {
            case vehicleId = "id"
            case plateNumber = "plate_number"
            case callSign = "call_sign"
            case vehicleType = "vehicle_type"
            case modelYear = "model_year"
            case category, designation
            case adminStatus = "admin_status"
            case ownerCenterId = "owner_center_id"
            case sortOrder = "sort_order"
            case notes
        }
    }
    let success: Bool?
    let vehicles: [Item]?
}

/// POST /api/vehicles/registry (admin) — اللوحة والنوع والفئة والتعيين
/// وسنة الموديل إلزامية سيرفريًا.
struct VehicleRegistryRequest: Encodable {
    let plateNumber: String
    let vehicleType: String
    let category: String
    let designation: String
    let modelYear: Int
    var callSign: String? = nil
    var adminStatus: String? = nil
    var notes: String? = nil

    enum CodingKeys: String, CodingKey {
        case plateNumber = "plate_number"
        case vehicleType = "vehicle_type"
        case category, designation
        case modelYear = "model_year"
        case callSign = "call_sign"
        case adminStatus = "admin_status"
        case notes
    }
}

// MARK: - نتيجة عامة
struct VehicleActionResponseDTO: Decodable {
    let success: Bool?
    let error: String?
    let appended: Int?
    let shiftId: Int?
}
