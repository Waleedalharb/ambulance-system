//
//  InventoryView.swift
//  EMSOperations
//
//  العهدة (قسم 16): ملخص الأصول وآخر جلسة جرد من /api/my/inventory.
//  عرض فقط — لا تعديل من التطبيق في هذه المرحلة.
//

import SwiftUI

struct InventoryView: View {
    @StateObject private var vm = InventoryViewModel()

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
        .emsPage("العهدة")
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

            if data.hasData == false {
                EMSEmptyView(
                    icon: "shippingbox",
                    title: "لا توجد بيانات عهدة بعد",
                    detail: "ستظهر الأصول عند تسجيلها للفرقة")
            } else {
                if let assets = data.assets {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: "الأصول", systemImage: "shippingbox.fill")
                            EMSInfoRow(label: "الإجمالي", value: "\(assets.total ?? 0)")
                            if let byStatus = data.assets?.byStatus, !byStatus.isEmpty {
                                Divider().overlay(EMSTheme.Colors.divider)
                                ForEach(byStatus.sorted(by: { $0.key < $1.key }), id: \.key) { status, count in
                                    EMSInfoRow(label: status, value: "\(count)")
                                }
                            }
                        }
                    }
                }

                if let session = data.lastSession {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: "آخر جلسة جرد", systemImage: "clock.arrow.circlepath")
                            if let status = session.status {
                                EMSInfoRow(label: "الحالة", value: status)
                            }
                            if let conductor = session.conductorName {
                                EMSInfoRow(label: "أجراها", value: conductor)
                            }
                            if let submitted = session.submittedAt {
                                EMSInfoRow(label: "تاريخ الرفع", value: submitted)
                            }
                            if let approved = session.approvedAt {
                                EMSInfoRow(label: "تاريخ الاعتماد", value: approved)
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
final class InventoryViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: InventoryDTO?

    private let api = APIClient.shared

    func load() async {
        if data == nil { state = .loading }
        do {
            data = try await api.get("/api/my/inventory")
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }
}
