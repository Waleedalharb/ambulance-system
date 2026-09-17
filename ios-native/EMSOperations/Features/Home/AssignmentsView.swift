//
//  AssignmentsView.swift
//  EMSOperations
//
//  تكليفاتي (قسم 10): فترات التكليف القادمة/الحالية من /api/my/assignments.
//

import SwiftUI

struct AssignmentsView: View {
    @StateObject private var vm = AssignmentsViewModel()

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
        .emsPage("تكليفاتي")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let data = vm.data {
            if data.available == false {
                EMSEmptyView(
                    icon: "calendar.badge.exclamationmark",
                    title: "لا توجد تكليفات معروضة",
                    detail: data.reason)
            } else if let periods = data.periods, !periods.isEmpty {
                if let source = data.assignmentSource, source == "primary_fallback" {
                    EMSStatusPill(text: "يعرض التعيين الأساسي عند غياب الجدول", tone: .monitor)
                }
                ForEach(periods) { period in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(period.date ?? "—")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.white)
                                Spacer()
                                if let name = period.shiftName ?? period.shiftCode {
                                    EMSStatusPill(text: name, tone: .action)
                                }
                            }
                            if let start = period.timeStart, let end = period.timeEnd {
                                EMSInfoRow(label: "الوقت", value: "\(start) — \(end)")
                            }
                            EMSInfoRow(label: "الفرقة", value: period.teamName ?? "—")
                            EMSInfoRow(label: "المركز", value: period.center ?? "—")
                        }
                    }
                }
            } else {
                EMSEmptyView(
                    icon: "calendar",
                    title: "لا توجد تكليفات قادمة",
                    detail: "ستظهر هنا فترات تكليفك عند نشر الجدول")
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class AssignmentsViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: AssignmentsDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/my/assignments")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
