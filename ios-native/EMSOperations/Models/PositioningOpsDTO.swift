//
//  PositioningOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال التمركز والذروة (docs/native-ios-platform-parity.md §11) —
//  مطابقة لأشكال server.js. خطط الذروة حرة الحقول (PositioningService)
//  فتُدار خامًا في الـViewModel؛ المهام/التنبيهات/السجل نماذج مثبتة.
//

import Foundation

// MARK: - GET/POST /api/unit-locations — مواقع الوحدات حسب المركز
struct UnitLocationsDTO: Decodable {
    let success: Bool?
    /// center → unit → [lat, lng]
    let locations: [String: [String: [Double]]]?
    /// unit → عنوان نصي
    let addresses: [String: String]?
}

// MARK: - GET /api/peak-data — مهام الذروة والتنبيهات والسجل
struct PeakDataDTO: Decodable {
    struct Mission: Decodable, Identifiable {
        let id: String?
        let location: String?
        let unit: String?
        let startTime: String?
        let endTime: String?
        let priority: String?
        let notes: String?
        let status: String?
        let createdAt: String?
        let lat: Double?
        let lng: Double?
    }
    struct Alert: Decodable, Identifiable {
        let id: String?
        let title: String?
        let details: String?
        let priority: String?
        let unit: String?
        let location: String?
        let startTime: String?
        let endTime: String?
        let status: String?
        let missionId: String?
        let createdAt: String?
    }
    struct Log: Decodable, Identifiable {
        let id: String?
        let icon: String?
        let action: String?
        let details: String?
        let priority: String?
        let time: String?
        let date: String?
    }
    struct Payload: Decodable {
        let missions: [Mission]?
        let alerts: [Alert]?
        let logs: [Log]?
    }
    let success: Bool?
    let data: Payload?
}

// MARK: - طلبات الكتابة

struct UnitLocationRequest: Encodable {
    let center: String
    let unit: String
    let lat: Double
    let lng: Double
    var address: String? = nil
}

struct UnitLocationAddressRequest: Encodable {
    let unit: String
    let address: String
}

struct PeakMissionRequest: Encodable {
    let location: String
    let unit: String
    let startTime: String
    let endTime: String
    var priority: String? = nil
    var notes: String? = nil
    var lat: Double? = nil
    var lng: Double? = nil
}

struct PeakResolveRequest: Encodable {
    let alertId: String
}

// MARK: - نتائج عامة
struct PeakActionResponseDTO: Decodable {
    let success: Bool?
    let mission: PeakDataDTO.Mission?
}
