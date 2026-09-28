//
//  HospitalsDTO.swift
//  EMSOperations
//
//  نماذج مجال المستشفيات (§17) — مطابقة لأشكال الـBackend المُتحقق منها من
//  المصدر (server.js:5545-5620/8910 + hospital-monitor-service.js).
//  فكّ دفاعي: كل الحقول اختيارية؛ لا حساب في العميل.
//

import Foundation

// MARK: - سجل المستشفيات (hospitals.json — حقول الواجهة: name/specialty/type/hours/lat/lng)
struct HospitalDTO: Decodable, Identifiable {
    let name: String?
    let specialty: String?
    let type: String?              // عام | متخصص | مجمع | طوارئ
    let hours: String?
    let lat: Double?
    let lng: Double?

    var id: String { name ?? UUID().uuidString }
}

struct HospitalsListDTO: Decodable {
    let success: Bool?
    let data: [HospitalDTO]?
}

// MARK: - تنبيه مراقبة مستشفى (hospital-monitor-service — st.alerts)
struct HospitalAlertDTO: Decodable, Identifiable {
    let id: String?
    let key: String?
    let type: String?              // dwell-exceed
    let state: String?             // open | acknowledged | resolved
    let shiftId: Int?
    let eventId: String?
    let unitCode: String?
    let southTeam: String?
    let facility: String?
    let dwellMin: Double?
    let ongoing: Bool?
    let firstRaisedAt: String?
    let lastRaisedAt: String?
    let updates: Int?
    let ackAt: String?
    let ackByName: String?
    let resolvedAt: String?
    let resolution: String?
    let unreliable: Bool?

    enum CodingKeys: String, CodingKey {
        case id, key, type, state, facility, ongoing, updates, resolution, unreliable
        case shiftId
        case eventId
        case unitCode
        case southTeam
        case dwellMin
        case firstRaisedAt
        case lastRaisedAt
        case ackAt
        case ackByName
        case resolvedAt
    }
}

// MARK: - ملخص المراقبة (GET /api/hospital-monitor/summary)
struct HospitalMonitorSummaryDTO: Decodable {
    struct Window: Decodable {
        let label: String?
        let from: String?
        let to: String?
    }
    struct Journey: Decodable, Identifiable {
        let key: String?
        let eventId: String?
        let unitCode: String?
        let southTeam: String?
        let episodeState: String?    // at-hospital | monitoring-lost | last-known
        let monitoringLost: Bool?
        let dwellMin: Double?
        let ongoing: Bool?
        let dwellCapped: Bool?

        var id: String { key ?? UUID().uuidString }
    }
    struct Facility: Decodable, Identifiable {
        let facility: String?
        let cases: Int?
        let avgDwellMin: Double?
        let exceedances: Int?
        let ongoing: Int?
        let unmeasured: Int?
        let monitoringLost: Int?
        let journeys: [Journey]?

        var id: String { facility ?? UUID().uuidString }
    }

    let success: Bool?
    let window: Window?
    let totalTransferred: Int?
    let currentAtHospital: Int?
    let lastKnownOnly: Int?
    let monitoringLost: Int?
    let avgDwellMin: Double?
    let exceedances: Int?
    let ongoing: Int?
    let unmeasured: Int?
    let facilities: [Facility]?
    let alerts: [HospitalAlertDTO]?
    let activeAlerts: Int?
}

// MARK: - تاريخ رحلة (GET /api/hospital-monitor/history?key=)
struct HospitalHistoryEntryDTO: Decodable, Identifiable {
    let at: String?
    let key: String?
    let field: String?
    let alert: String?             // raised | resolved
    let dwellMin: Double?
    let facility: String?
    let to: String?
    let unreliable: Bool?

    var id: String { "\(at ?? "")|\(field ?? "")|\(alert ?? "")|\(to ?? "")" }
}

struct HospitalHistoryDTO: Decodable {
    let success: Bool?
    let key: String?
    let history: [HospitalHistoryEntryDTO]?
}

// MARK: - استجابة الإقرار (POST /api/hospital-monitor/alerts/:id/ack)
struct HospitalAlertAckDTO: Decodable {
    let success: Bool?
    let changed: Bool?
    let alert: HospitalAlertDTO?
}
