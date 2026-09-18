//
//  PositioningOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال التمركز والذروة (docs/native-ios-platform-parity.md §11) —
//  مطابقة لأشكال server.js. خطط الذروة حرة الحقول (PositioningService)
//  فتُدار خامًا في الـViewModel؛ المهام/التنبيهات/السجل نماذج مثبتة.
//

import Foundation

/// فكّ متسامح لقيم JSON قد تختلف تمثيلًا بين البيانات القديمة والجديدة
/// (معرّفات رقمية قديمة، إحداثيات مخزنة كنصوص) — لا يُسقط الرد كاملًا
/// بسبب حقل واحد مختلف التمثيل.
private enum FlexText {
    static func string<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: key) { return String(i) }
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return String(d) }
        return nil
    }
    static func double<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return Double(s) }
        return nil
    }
}

/// رقم متسامح داخل مصفوفات الإحداثيات (Double أو نص رقمي).
private struct FlexNum: Decodable {
    let value: Double?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { value = d; return }
        if let s = try? c.decode(String.self) { value = Double(s); return }
        value = nil
    }
}

// MARK: - GET/POST /api/unit-locations — مواقع الوحدات حسب المركز
struct UnitLocationsDTO: Decodable {
    let success: Bool?
    /// center → unit → [lat, lng]
    let locations: [String: [String: [Double]]]?
    /// unit → عنوان نصي
    let addresses: [String: String]?

    enum CodingKeys: String, CodingKey { case success, locations, addresses }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = try c.decodeIfPresent(Bool.self, forKey: .success)
        if let raw = try c.decodeIfPresent([String: [String: [FlexNum]]].self, forKey: .locations) {
            locations = raw.mapValues { units in units.mapValues { $0.compactMap { $0.value } } }
        } else {
            locations = nil
        }
        addresses = try c.decodeIfPresent([String: String].self, forKey: .addresses)
    }
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

        enum CodingKeys: String, CodingKey {
            case id, location, unit, startTime, endTime, priority, notes, status, createdAt, lat, lng
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = FlexText.string(c, .id)
            location = FlexText.string(c, .location)
            unit = FlexText.string(c, .unit)
            startTime = FlexText.string(c, .startTime)
            endTime = FlexText.string(c, .endTime)
            priority = FlexText.string(c, .priority)
            notes = FlexText.string(c, .notes)
            status = FlexText.string(c, .status)
            createdAt = FlexText.string(c, .createdAt)
            lat = FlexText.double(c, .lat)
            lng = FlexText.double(c, .lng)
        }
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

        enum CodingKeys: String, CodingKey {
            case id, title, details, priority, unit, location, startTime, endTime, status, missionId, createdAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = FlexText.string(c, .id)
            title = FlexText.string(c, .title)
            details = FlexText.string(c, .details)
            priority = FlexText.string(c, .priority)
            unit = FlexText.string(c, .unit)
            location = FlexText.string(c, .location)
            startTime = FlexText.string(c, .startTime)
            endTime = FlexText.string(c, .endTime)
            status = FlexText.string(c, .status)
            missionId = FlexText.string(c, .missionId)
            createdAt = FlexText.string(c, .createdAt)
        }
    }
    struct Log: Decodable, Identifiable {
        let id: String?
        let icon: String?
        let action: String?
        let details: String?
        let priority: String?
        let time: String?
        let date: String?

        enum CodingKeys: String, CodingKey {
            case id, icon, action, details, priority, time, date
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = FlexText.string(c, .id)
            icon = FlexText.string(c, .icon)
            action = FlexText.string(c, .action)
            details = FlexText.string(c, .details)
            priority = FlexText.string(c, .priority)
            time = FlexText.string(c, .time)
            date = FlexText.string(c, .date)
        }
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
