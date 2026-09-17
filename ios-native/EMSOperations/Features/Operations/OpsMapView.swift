//
//  OpsMapView.swift
//  EMSOperations
//
//  الخريطة (تفعيل المنصة الأصلية): المراكز من GET /api/center-geo على MapKit
//  بصيغة iOS 16 (Map(coordinateRegion:annotationItems:annotationContent:)).
//  عرض فقط — لا تفاعل كتابي من الخريطة.
//

import SwiftUI
import MapKit

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
                    VStack(spacing: 2) {
                        Image(systemName: "cross.case.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(6)
                            .background(EMSTheme.Colors.teal)
                            .clipShape(Circle())
                        Text(pin.name)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(EMSTheme.Colors.navy.opacity(0.85))
                            .clipShape(Capsule())
                    }
                }
            }
            .ignoresSafeArea(edges: .bottom)
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

    struct CenterPin: Identifiable {
        let name: String
        let coordinate: CLLocationCoordinate2D
        let radius: Double?
        var id: String { name }
    }

    @Published var state: LoadState = .loading
    @Published private(set) var pins: [CenterPin] = []
    @Published private(set) var region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 24.7136, longitude: 46.6753), // الرياض — نقطة بداية عرضية فقط
        span: MKCoordinateSpan(latitudeDelta: 0.4, longitudeDelta: 0.4))

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            let dto: CenterGeoDTO = try await api.get("/api/center-geo")
            let found: [CenterPin] = (dto.data ?? [:]).compactMap { name, c in
                guard let pair = c.center, pair.count == 2 else { return nil }
                return CenterPin(
                    name: name,
                    coordinate: CLLocationCoordinate2D(latitude: pair[0], longitude: pair[1]),
                    radius: c.radius)
            }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            pins = found
            if !found.isEmpty { region = Self.region(containing: found) }
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    /// نطاق عرض يحوي كل المراكز مع هامش — حساب عرضي خالص على بيانات الخادم.
    private static func region(containing pins: [CenterPin]) -> MKCoordinateRegion {
        let lats = pins.map { $0.coordinate.latitude }
        let lngs = pins.map { $0.coordinate.longitude }
        let minLat = lats.min() ?? 24.7136, maxLat = lats.max() ?? 24.7136
        let minLng = lngs.min() ?? 46.6753, maxLng = lngs.max() ?? 46.6753
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2)
        let span = MKCoordinateSpan(
            latitudeDelta: max((maxLat - minLat) * 1.4, 0.05),
            longitudeDelta: max((maxLng - minLng) * 1.4, 0.05))
        return MKCoordinateRegion(center: center, span: span)
    }
}
