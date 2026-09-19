//
//  VehicleView.swift
//  EMSOperations
//
//  مركبتي (قسم 15): المركبات المرتبطة بالتكليف الحالي من /api/my/vehicle.
//  عرض فقط — لا تعديل من التطبيق في هذه المرحلة.
//

import SwiftUI

struct VehicleView: View {
    @StateObject private var vm = VehicleViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    content
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("مركبتي")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let data = vm.data {
            if let team = data.team {
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        EMSectionHeader(title: "التكليف الحالي", systemImage: "person.3")
                        EMSInfoRow(label: "الفرقة", value: team.teamName ?? "—")
                        EMSInfoRow(label: "المركز", value: team.center ?? "—")
                    }
                }
            }

            if data.available == false {
                EMSEmptyView(
                    icon: "truck.box",
                    title: "لا توجد مركبة مرتبطة حاليًا",
                    detail: data.reason ?? "سيظهر المركبة عند ارتباطها بتكليفك")
            } else if let vehicles = data.vehicles, !vehicles.isEmpty {
                ForEach(vehicles) { v in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Image(systemName: "truck.box.fill")
                                    .foregroundStyle(EMSTheme.Colors.teal)
                                Text(v.displayName)
                                    .font(.headline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                if let status = v.status {
                                    EMSStatusPill(text: status, tone: .normal)
                                }
                            }
                            Divider().overlay(EMSTheme.Colors.divider)
                            if let call = v.callSign {
                                EMSInfoRow(label: "النداء", value: call)
                            }
                            if let plate = v.plateNumber {
                                EMSInfoRow(label: "اللوحة", value: plate)
                            }
                            if let team = v.teamName {
                                EMSInfoRow(label: "الفرقة", value: team)
                            }
                        }
                    }
                }
            } else {
                EMSEmptyView(
                    icon: "truck.box",
                    title: "لا توجد بيانات مركبة",
                    detail: data.reason)
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class VehicleViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: VehicleDTO?

    private let api = APIClient.shared

    func load() async {
        if data == nil { state = .loading }
        do {
            data = try await api.get("/api/my/vehicle")
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }
}
