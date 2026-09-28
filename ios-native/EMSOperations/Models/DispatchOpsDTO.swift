//
//  DispatchOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال البلاغات والتوزيع (docs/native-ios-platform-parity.md §9) —
//  مطابقة لأشكال server.js وReportService.getIncidentSummary. الفكّ دفاعي:
//  كل الحقول اختيارية؛ العدّادات والخطورة تُشتق سيرفريًا وتُعرض كما هي.
//

import Foundation

// MARK: - GET /api/cad-reports — ملخص بلاغات المناوبة (ReportService.getIncidentSummary)
struct CadSummaryDTO: Decodable {
    struct Crew: Decodable, Identifiable {
        var id: String { "\(unit ?? "؟")|\(at ?? "")" }
        let unit: String?
        let at: String?
        let counted: Bool?
        let withdrawn: Bool?
        let manualCancelled: Bool?
        let manualCancelledBy: String?
        let manualCancelledAt: String?
        let manualCancelReason: String?
        let cadUrs: String?
        let cadReached: Bool?
        let cancelKind: String?
        let respArrivalMin: Double?
        let respMubasharaMin: Double?
    }
    struct Incident: Decodable, Identifiable {
        var id: String { number ?? UUID().uuidString }
        let number: String?
        let code: String?
        let type: String?
        let source: String?
        let status: String?
        let createdAt: String?
        let cadCreatedAt: String?
        let address: String?
        let district: String?
        let street: String?
        let city: String?
        let lat: Double?
        let lng: Double?
        let crews: [Crew]?
        let bestArrivalMin: Double?
        let bestMubasharaMin: Double?
        let severity: String?       // green | yellow | red | null (منتهٍ)
    }
    struct ResponseTime: Decodable {
        struct Stat: Decodable {
            let avg: Double?
            let count: Int?
        }
        let arrival: Stat?
        let mubashara: Stat?
        let definition: String?
    }
    struct MapStatus: Decodable {
        struct NamedCount: Decodable {
            let name: String?
            let count: Int?
        }
        let sectorStatus: String?
        let topDistrict: NamedCount?
        let positionedCount: Int?
        let noLocationCount: Int?
    }

    let success: Bool?
    let total: Int?
    let incidentsCount: Int?
    let activeCount: Int?
    let manualCount: Int?
    let byType: [String: Int]?
    let byCrew: [String: Int]?
    let byDistrict: [String: Int]?
    let incidents: [Incident]?
    let lastReportTs: Double?
    let responseTime: ResponseTime?
    let mapStatus: MapStatus?
}

// MARK: - GET /api/report-entry — البلاغات التفصيلية (المناوبة النشطة فقط)
struct ReportEntryDTO: Decodable, Identifiable {
    var id: String { serverId ?? UUID().uuidString }
    let serverId: String?
    let reportNumber: String?
    let type: String?
    let location: String?
    let priority: String?
    let center: String?
    let unit: String?
    let dispatchTime: String?
    let arrivalTime: String?
    let responseTime: String?
    let responseSeconds: Int?
    let dispatcher: String?
    let notes: String?
    let date: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case serverId = "id"
        case reportNumber, type, location, priority, center, unit
        case dispatchTime, arrivalTime, responseTime, responseSeconds
        case dispatcher, notes, date, createdAt
    }
}

struct ReportEntryListDTO: Decodable {
    let success: Bool?
    let records: [ReportEntryDTO]?
}

// MARK: - طلبات الكتابة

/// POST /api/report — توزيع بلاغ (الخادم يختم المناوبة النشطة سيرفريًا).
struct DispatchReportRequest: Encodable {
    let center: String
    let unit: String
    var type: String? = nil
}

/// POST /api/undo — التراجع عن آخر بلاغ لمركز/وحدة.
struct UndoReportRequest: Encodable {
    let center: String
    let unit: String
}

/// POST /api/cad-reports/:number/crews/:unit/cancel|restore — سبب اختياري.
struct CrewCancelRequest: Encodable {
    var reason: String? = nil
}

/// POST /api/report-entry — الحقول نفسها التي يرسلها النموذج المتقدم في
/// report-entry.html؛ id/createdAt/timestamp/date/shiftId تُختم سيرفريًا
/// فوق أي قيمة، لذا لا تُرسل من العميل إطلاقًا.
struct ReportEntryRequest: Encodable {
    let type: String
    let center: String
    let unit: String
    let dispatchTime: String
    let arrivalTime: String
    var reportNumber: String? = nil
    var location: String? = nil
    var priority: String? = nil
    var responseTime: String? = nil
    var responseSeconds: Int? = nil
    var dispatcher: String? = nil
    var notes: String? = nil
}

// MARK: - نتائج عامة
struct DispatchActionResponseDTO: Decodable {
    let success: Bool?
    let error: String?
    let already: Bool?
}
