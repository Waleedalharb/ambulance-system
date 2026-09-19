//
//  PositioningOpsViewModel.swift
//  EMSOperations
//
//  مخزن التمركز والذروة (§11): مواقع الوحدات + خطط الذروة (خامة —
//  عقد PositioningService حر الحقول مع PositioningStarted/Updated/Ended)
//  + مهام الذروة وتنبيهاتها. الكتابة بصلاحية ops.deployments (الحذف
//  للمهام admin/director)؛ arrivalTime/departureTime تُختم سيرفريًا
//  بدلالة «الآن» — لا نرسل طابعًا زمنيًا من الجهاز لهما أبدًا.
//

import Foundation

/// عنصر عرض لخطة ذروة خامة — إسقاط متسامح من مفاتيح العقد الحر.
struct PeakPlanItem: Identifiable {
    let id: String
    let title: String
    let location: String?
    let unit: String?
    let startTime: String?
    let endTime: String?
    let status: String?
    let arrivalTime: String?
    let departureTime: String?
    let notes: String?
}

@MainActor
final class PositioningOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var locations: [String: [String: [Double]]] = [:]
    @Published private(set) var addresses: [String: String] = [:]
    @Published private(set) var plans: [PeakPlanItem] = []
    @Published private(set) var missions: [PeakDataDTO.Mission] = []
    @Published private(set) var alerts: [PeakDataDTO.Alert] = []
    @Published private(set) var logs: [PeakDataDTO.Log] = []

    private let api = APIClient.shared

    static let localMinuteFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"   // datetime-local — normalizePlanTimes سيرفري
        return f
    }()

    var centers: [String] { locations.keys.sorted() }

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            async let locCall: UnitLocationsDTO = api.get("/api/unit-locations")
            async let peakCall: PeakDataDTO = api.get("/api/peak-data")
            async let plansCall: Any = api.getRaw("/api/peak-plans")
            let (loc, peak, plansRaw) = try await (locCall, peakCall, plansCall)
            locations = loc.locations ?? [:]
            addresses = loc.addresses ?? [:]
            missions = peak.data?.missions ?? []
            alerts = peak.data?.alerts ?? []
            logs = peak.data?.logs ?? []
            if let dict = plansRaw as? [String: Any], let list = dict["plans"] as? [[String: Any]] {
                plans = list.map { planItem($0) }
            }
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    private func planItem(_ d: [String: Any]) -> PeakPlanItem {
        func s(_ keys: [String]) -> String? {
            for k in keys {
                if let v = d[k] as? String, !v.isEmpty { return v }
                if let v = d[k] as? Int { return String(v) }
            }
            return nil
        }
        return PeakPlanItem(
            id: s(["id"]) ?? UUID().uuidString,
            title: s(["title"]) ?? "—",
            location: s(["location"]),
            unit: s(["unit"]),
            startTime: s(["startTime"]),
            endTime: s(["endTime"]),
            status: s(["status"]),
            arrivalTime: s(["arrivalTime"]),
            departureTime: s(["departureTime"]),
            notes: s(["notes"]))
    }

    // MARK: - تمركز الوحدات

    func setUnitLocation(center: String, unit: String, lat: Double, lng: Double, address: String?) async throws {
        let res: UnitLocationsDTO = try await api.post("/api/unit-locations",
            body: UnitLocationRequest(center: center, unit: unit, lat: lat, lng: lng, address: address))
        locations = res.locations ?? locations
        addresses = res.addresses ?? addresses
    }

    func setUnitAddress(unit: String, address: String) async throws {
        _ = try await api.postRaw("/api/unit-location-addresses",
                                  jsonObject: ["unit": unit, "address": address])
        addresses[unit] = address
    }

    // MARK: - خطط الذروة (خام — يحفظ العقد الحر)

    func createPlan(title: String, location: String, unit: String?,
                    start: Date?, end: Date?, notes: String?) async throws {
        var body: [String: Any] = ["title": title, "location": location]
        if let unit, !unit.isEmpty { body["unit"] = unit }
        if let start { body["startTime"] = Self.localMinuteFormatter.string(from: start) }
        if let end { body["endTime"] = Self.localMinuteFormatter.string(from: end) }
        if let notes, !notes.isEmpty { body["notes"] = notes }
        _ = try await api.postRaw("/api/peak-plans", jsonObject: body)
        await reload()
    }

    func updatePlan(id: String, title: String, location: String, notes: String?) async throws {
        var body: [String: Any] = ["title": title, "location": location]
        body["notes"] = notes ?? ""
        _ = try await api.putRaw("/api/peak-plans/\(id)", jsonObject: body)
        await reload()
    }

    /// ختم وصول/مغادرة بدلالة «الآن» — الخادم يختم من ساعته.
    func stampPlan(id: String, key: String) async throws {
        _ = try await api.putRaw("/api/peak-plans/\(id)", jsonObject: [key: "now"])
        await reload()
    }

    func deletePlan(id: String) async throws {
        let _: PeakActionResponseDTO = try await api.delete("/api/peak-plans/\(id)")
        await reload()
    }

    // MARK: - مهام الذروة

    func createMission(location: String, unit: String, startTime: String, endTime: String,
                       priority: String?, notes: String?) async throws {
        let _: PeakActionResponseDTO = try await api.post("/api/peak-mission",
            body: PeakMissionRequest(location: location, unit: unit, startTime: startTime,
                                     endTime: endTime, priority: priority, notes: notes))
        await reload()
    }

    func resolveAlert(_ alertId: String) async throws {
        let _: PeakActionResponseDTO = try await api.post("/api/peak-resolve",
            body: PeakResolveRequest(alertId: alertId))
        await reload()
    }

    func deleteMission(_ id: String) async throws {
        let _: PeakActionResponseDTO = try await api.delete("/api/peak-mission/\(id)")
        await reload()
    }
}
