//
//  OpsMapView.swift
//  EMSOperations
//
//  الخريطة (تفعيل المنصة الأصلية): ثلاث طبقات قراءة فقط بنفس منطق خريطة الويب
//  (smart-map.js) — 🏥 المراكز من GET /api/ops/centers (المصدر الوحيد SSOT —
//  لا جدول إحداثيات محلي) · 🚑 الفرق من GET /api/staffing/state (حالة سيرفرية
//  + تموضع حلقي عرضي حول المركز — لا GPS) · 📍 البلاغات النشطة ذات الإحداثيات
//  من GET /api/cad-reports (severity سيرفري).
//  لا اشتقاق ولا بيانات مختلقة: فرقة بلا مركز معروف أو بلاغ بلا إحداثيات لا يُرسم.
//  إن كان مرجع المراكز غير مكتمل (integrity.complete=false) تُعرض البيانات
//  المتاحة مع تنبيه غير حاجب يسمّي المراكز الناقصة — لا فشل صامت ولا إخفاء.
//  لا polling ولا SSE — تحديث يدوي فقط عبر زر التحديث (Map ليست ScrollView،
//  فـ.refreshable لا تنطبق عليها في iOS 16). عرض فقط — لا تفاعل كتابي من الخريطة.
//

import SwiftUI
import MapKit

// MARK: - دوال نقية مشتركة مع منطق الويب (قابلة للاختبار — لا حالة ولا شبكة)

/// شدة العرض الموحدة — تقابل sev-green/yellow/red/none في smart-map.js.
enum OpsMapSeverity: String {
    case green, yellow, red, none
}

/// الإزاحة الحلقية حول المركز — نقل حرفي من teamPosition في smart-map.js:
/// angle = 2π × index / count ثم (lat + 0.0011·cos، lng + 0.0011·sin).
/// فرقة وحيدة (أو مدخل غير صالح) ← بلا إزاحة: إحداثيات المركز نفسها.
func opsMapRingOffset(index: Int, count: Int) -> (dLat: Double, dLng: Double) {
    guard count > 1, index >= 0, index < count else { return (0, 0) }
    let ang = (2 * Double.pi * Double(index)) / Double(count)
    return (0.0011 * cos(ang), 0.0011 * sin(ang))
}

/// شدة الفرقة — نفس teamSev في smart-map.js حرفيًا:
/// missing/offline أو vehicleOk === false ← red · pending ← yellow · غيرها ← green.
/// ملاحظة توافق: vehicleOk الغائب (nil) ليس red — الويب يختبر === false فقط.
func opsMapTeamSeverity(status: String?, vehicleOk: Bool?) -> OpsMapSeverity {
    if status == "missing" || status == "offline" || vehicleOk == false { return .red }
    if status == "pending" { return .yellow }
    return .green
}

/// شدة المركز = أسوأ حالة بين فرقه الظاهرة (نفس cSev في renderTeams) — بلا فرق ← none.
func opsMapCenterSeverity(_ teamSeverities: [OpsMapSeverity]) -> OpsMapSeverity {
    if teamSeverities.isEmpty { return .none }
    if teamSeverities.contains(.red) { return .red }
    if teamSeverities.contains(.yellow) { return .yellow }
    return .green
}

/// البلاغات المرئية — نفس فلتر الويب (renderIncidents): النشطة فقط وبإحداثيات فعلية.
/// المنتهية/الملغاة وبلا إحداثيات لا تُرسم إطلاقًا (لا مواقع مختلقة).
func opsMapVisibleIncidents(_ incidents: [CadSummaryDTO.Incident]?) -> [CadSummaryDTO.Incident] {
    (incidents ?? []).filter { $0.status == "active" && $0.lat != nil && $0.lng != nil }
}

/// شدة البلاغ — severity سيرفري مباشرة، والغياب yellow (كسطر 616 في smart-map.js).
func opsMapIncidentSeverity(_ severity: String?) -> OpsMapSeverity {
    switch severity {
    case "green": return .green
    case "red": return .red
    default: return .yellow
    }
}

// MARK: - View

struct OpsMapView: View {
    @StateObject private var vm = OpsMapViewModel()

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) {
                    EMSSkeletonCard(lines: 4)
                }
                .padding(EMSTheme.pagePadding)
            case .failed(let message):
                VStack {
                    Spacer()
                    EMSErrorView(message: message) { Task { await vm.load() } }
                    Spacer()
                }
            case .loaded:
                loadedContent
            }
        }
        .emsPage("الخريطة")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var loadedContent: some View {
        if vm.pins.isEmpty {
            VStack {
                Spacer()
                EMSEmptyView(
                    icon: "map",
                    title: "لا توجد إحداثيات مراكز",
                    detail: "تظهر المراكز على الخريطة عند توفر إحداثياتها من المنظومة")
                Spacer()
            }
        } else {
            Map(coordinateRegion: .constant(vm.region), annotationItems: vm.pins) { pin in
                MapAnnotation(coordinate: pin.coordinate) {
                    pinView(pin)
                }
            }
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .top) {
                // تنبيه الخيار A: مرجع SSOT غير مكتمل — غير حاجب ولا يمنع التحديث
                if !vm.missingCenters.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(EMSTheme.Colors.warning)
                        Text("مرجع المراكز غير مكتمل: " + vm.missingCenters.joined(separator: "، "))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(EMSTheme.Colors.navy.opacity(0.85))
                    .clipShape(Capsule())
                    .padding(.top, 8)
                    .allowsHitTesting(false)
                    .accessibilityLabel("تنبيه: مرجع المراكز غير مكتمل")
                }
            }
            .overlay(alignment: .topTrailing) {
                Button {
                    Task { await vm.reload() }
                } label: {
                    Group {
                        if vm.isRefreshing { ProgressView().tint(EMSTheme.Colors.teal) }
                        else { Image(systemName: "arrow.clockwise") }
                    }
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(10)
                    .background(EMSTheme.Colors.navy.opacity(0.85))
                    .clipShape(Circle())
                }
                .disabled(vm.isRefreshing)
                .padding(12)
                .accessibilityLabel("تحديث الخريطة")
            }
        }
    }

    /// لون الطبقة — مطابق لدلالة الويب: green ← emerald · yellow ← warning ·
    /// red ← danger · none (مركز بلا فرق) ← teal الافتراضي.
    private func pinColor(_ severity: OpsMapSeverity) -> Color {
        switch severity {
        case .green: return EMSTheme.Colors.emerald
        case .yellow: return EMSTheme.Colors.warning
        case .red: return EMSTheme.Colors.danger
        case .none: return EMSTheme.Colors.teal
        }
    }

    @ViewBuilder
    private func pinView(_ pin: OpsMapViewModel.MapPin) -> some View {
        switch pin.kind {
        case .center:
            VStack(spacing: 2) {
                Image(systemName: "cross.case.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(6)
                    .background(pinColor(pin.severity))
                    .clipShape(Circle())
                Text(pin.name)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(EMSTheme.Colors.navy.opacity(0.85))
                    .clipShape(Capsule())
            }
        case .team:
            VStack(spacing: 2) {
                Image(systemName: "truck.pickup.side.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(5)
                    .background(pinColor(pin.severity))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                Text(pin.name)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(EMSTheme.Colors.navy.opacity(0.85))
                    .clipShape(Capsule())
            }
        case .incident:
            VStack(spacing: 2) {
                Image(systemName: "mappin.circle.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(pinColor(pin.severity))
                    .background(EMSTheme.Colors.navy.opacity(0.85))
                    .clipShape(Circle())
                Text(pin.name)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(EMSTheme.Colors.navy.opacity(0.85))
                    .clipShape(Capsule())
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class OpsMapViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    enum PinKind {
        case center, team, incident
    }

    struct MapPin: Identifiable {
        let kind: PinKind
        let id: String
        let name: String
        let coordinate: CLLocationCoordinate2D
        let severity: OpsMapSeverity
    }

    @Published var state: LoadState = .loading
    @Published private(set) var pins: [MapPin] = []
    @Published private(set) var isRefreshing = false
    /// أسماء المراكز الناقصة من مرجع SSOT (integrity) — فارغة عند الاكتمال.
    @Published private(set) var missingCenters: [String] = []
    @Published private(set) var region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 24.7136, longitude: 46.6753), // الرياض — نقطة بداية عرضية فقط
        span: MKCoordinateSpan(latitudeDelta: 0.4, longitudeDelta: 0.4))

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await fetchAll(showLoading: true)
    }

    /// تحديث يدوي فقط (زر التحديث) — لا polling ولا مؤقتات.
    func reload() async {
        if isRefreshing { return }
        isRefreshing = true
        await fetchAll(showLoading: false)
        isRefreshing = false
    }

    private func fetchAll(showLoading: Bool) async {
        if showLoading { state = .loading }
        do {
            // المراكز إلزامية للشاشة؛ الفرق/البلاغات طبقات إثرائية — فشلها
            // يُخفي طبقتها بصدق ولا يكسر الخريطة (لا بيانات مختلقة).
            async let centersCall: OpsCentersDTO = api.get("/api/ops/centers")
            async let staffingCall: StaffingStateDTO = api.get("/api/staffing/state")
            async let reportsCall: CadSummaryDTO = api.get("/api/cad-reports")
            let centers = try await centersCall
            let staffing = try? await staffingCall
            let reports = try? await reportsCall
            missingCenters = Self.missingCenterNames(centers.integrity)
            let built = Self.buildPins(centers: centers, staffing: staffing, reports: reports)
            pins = built
            if !built.isEmpty { region = Self.region(containing: built.map(\.coordinate)) }
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    /// أسماء المراكز الناقصة من مرجع SSOT — فارغة عند اكتمال المرجع أو غياب الحقل.
    /// الخيار A المعتمد: عرض البيانات المتاحة + تنبيه يسمّي الناقص (لا إخفاء ولا حجب).
    static func missingCenterNames(_ integrity: OpsCentersDTO.Integrity?) -> [String] {
        guard integrity?.complete == false else { return [] }
        return (integrity?.missing ?? []).compactMap(\.center)
    }

    /// بناء الطبقات الثلاث — منطق عرضي صِرف فوق قيم الخادم (لا اشتقاق):
    /// المراكز من ops/centers (SSOT) · الفرق من staffing/state (مركز الفرقة يصل
    /// في الحمولة نفسها) · البلاغات النشطة ذات الإحداثيات من cad-reports.
    static func buildPins(centers: OpsCentersDTO, staffing: StaffingStateDTO?, reports: CadSummaryDTO?) -> [MapPin] {
        var centerCoord: [String: CLLocationCoordinate2D] = [:]
        for (name, c) in (centers.data ?? [:]) {
            guard let pair = c.center, pair.count == 2 else { continue }
            centerCoord[name] = CLLocationCoordinate2D(latitude: pair[0], longitude: pair[1])
        }

        // فرق كل مركز — الفرز الطبيعي الثابت نفسه حتى لا تتبدل الأماكن بين التحديثات
        let teams = staffing?.teams ?? [:]
        var siblingsByCenter: [String: [String]] = [:]
        for (name, tr) in teams {
            guard let centerName = tr.center, centerCoord[centerName] != nil else { continue }
            siblingsByCenter[centerName, default: []].append(name)
        }
        for centerName in siblingsByCenter.keys {
            siblingsByCenter[centerName]?.sort { $0.localizedStandardCompare($1) == .orderedAscending }
        }

        var teamPins: [MapPin] = []
        var severitiesByCenter: [String: [OpsMapSeverity]] = [:]
        for (centerName, siblings) in siblingsByCenter {
            guard let base = centerCoord[centerName] else { continue }
            for (index, name) in siblings.enumerated() {
                guard let tr = teams[name] else { continue }
                let severity = opsMapTeamSeverity(status: tr.status, vehicleOk: tr.vehicleOk)
                let offset = opsMapRingOffset(index: index, count: siblings.count)
                teamPins.append(MapPin(
                    kind: .team,
                    id: "t:" + name,
                    name: name,
                    coordinate: CLLocationCoordinate2D(
                        latitude: base.latitude + offset.dLat,
                        longitude: base.longitude + offset.dLng),
                    severity: severity))
                severitiesByCenter[centerName, default: []].append(severity)
            }
        }

        let centerPins: [MapPin] = centerCoord.keys
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            .map { name in
                MapPin(
                    kind: .center,
                    id: "c:" + name,
                    name: name,
                    coordinate: centerCoord[name] ?? CLLocationCoordinate2D(),
                    severity: opsMapCenterSeverity(severitiesByCenter[name] ?? []))
            }

        let incidentPins: [MapPin] = opsMapVisibleIncidents(reports?.incidents).map { incident in
            MapPin(
                kind: .incident,
                id: "i:" + (incident.number ?? UUID().uuidString),
                name: incident.number ?? "بلاغ",
                coordinate: CLLocationCoordinate2D(
                    latitude: incident.lat ?? 0,
                    longitude: incident.lng ?? 0),
                severity: opsMapIncidentSeverity(incident.severity))
        }

        return centerPins + teamPins + incidentPins
    }

    /// نطاق عرض يحوي كل العلامات مع هامش — حساب عرضي خالص على بيانات الخادم.
    private static func region(containing coords: [CLLocationCoordinate2D]) -> MKCoordinateRegion {
        let lats = coords.map(\.latitude)
        let lngs = coords.map(\.longitude)
        let minLat = lats.min() ?? 24.7136, maxLat = lats.max() ?? 24.7136
        let minLng = lngs.min() ?? 46.6753, maxLng = lngs.max() ?? 46.6753
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2)
        let span = MKCoordinateSpan(
            latitudeDelta: max((maxLat - minLat) * 1.4, 0.05),
            longitudeDelta: max((maxLng - minLng) * 1.4, 0.05))
        return MKCoordinateRegion(center: center, span: span)
    }
}
