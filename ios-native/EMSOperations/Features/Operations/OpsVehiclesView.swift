//
//  OpsVehiclesView.swift
//  EMSOperations
//
//  المركبات (تفعيل المنصة الأصلية): لوحة الأسطول من GET /api/vehicles/board
//  ← VehicleEventsService.getBoard — عدّادات الحالة + المعيّنة + الدعم
//  + غير المعيّنة. عرض فقط — لا تعيين ولا تغيير حالة من التطبيق.
//

import SwiftUI

struct OpsVehiclesView: View {
    @StateObject private var vm = OpsVehiclesViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 3)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    content
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("المركبات")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let counters = vm.data?.counters {
            countersCard(counters)
        }
        assignedSection
        supportSection
        unassignedSection
    }

    // MARK: - العدّادات (من الخادم كما هي)

    private func countersCard(_ c: VehiclesBoardDTO.Counters) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "حالة الأسطول", systemImage: "truck.box.fill")
                HStack(spacing: 14) {
                    counter(c.active, "عاملة", EMSTheme.Colors.emerald)
                    counter(c.reserve, "احتياط", EMSTheme.Colors.teal)
                    counter(c.breakdown, "متعطلة", EMSTheme.Colors.warning)
                    counter(c.outOfService, "خارج الخدمة", EMSTheme.Colors.danger)
                    Spacer()
                }
            }
        }
    }

    private func counter(_ value: Int?, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value ?? 0)")
                .font(.title3.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
    }

    // MARK: - المعيّنة

    @ViewBuilder
    private var assignedSection: some View {
        let list = vm.data?.vehicles ?? []
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "المعيّنة للفرق")
                ForEach(list) { v in
                    vehicleCard(v)
                }
            }
        }
    }

    private func vehicleCard(_ v: VehiclesBoardDTO.Vehicle) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "truck.box.fill")
                        .foregroundStyle(EMSTheme.Colors.teal)
                    Text(v.displayName)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white)
                    Spacer()
                    if let status = v.status {
                        EMSStatusPill(text: vm.statusLabel(status), tone: vm.statusTone(status))
                    } else {
                        EMSStatusPill(text: "بلا حالة", tone: .neutral)
                    }
                }
                if v.inWorkshop == true {
                    EMSStatusPill(text: "في الورشة", tone: .monitor)
                }
                if let reason = v.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - الدعم المفتوح (مركبة تدعم فريقًا آخر)

    @ViewBuilder
    private var supportSection: some View {
        let list = vm.data?.support ?? []
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "الدعم المفتوح")
                ForEach(list) { s in
                    EMSCard {
                        HStack(spacing: 10) {
                            Image(systemName: "arrow.triangle.swap")
                                .foregroundStyle(EMSTheme.Colors.teal)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(s.name ?? s.vehicleId ?? "مركبة")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Text("تدعم فريقًا آخر — رقم \(s.targetTeamId.map(String.init) ?? "—")")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    // MARK: - غير المعيّنة

    @ViewBuilder
    private var unassignedSection: some View {
        let list = vm.data?.unassigned ?? []
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "غير المعيّنة")
                ForEach(list) { v in
                    EMSCard {
                        HStack(spacing: 10) {
                            Image(systemName: "truck.box")
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                            Text(v.displayName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                            Spacer()
                            if v.inWorkshop == true {
                                EMSStatusPill(text: "في الورشة", tone: .monitor)
                            } else if let status = v.status {
                                EMSStatusPill(text: vm.statusLabel(status), tone: vm.statusTone(status))
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class OpsVehiclesViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: VehiclesBoardDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/vehicles/board")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    // MARK: - عرض الحالات (القيم سيرفرية — التسمية عرضية فقط)

    func statusLabel(_ status: String) -> String {
        switch status {
        case "active": return "عاملة"
        case "reserve": return "احتياط"
        case "breakdown": return "متعطلة"
        case "out_of_service": return "خارج الخدمة"
        default: return status
        }
    }

    func statusTone(_ status: String) -> EMSTheme.StatusTone {
        switch status {
        case "active": return .normal
        case "reserve": return .action
        case "breakdown": return .monitor
        case "out_of_service": return .danger
        default: return .neutral
        }
    }
}
