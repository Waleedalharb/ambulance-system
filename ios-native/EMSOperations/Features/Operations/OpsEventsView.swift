//
//  OpsEventsView.swift
//  EMSOperations
//
//  الأحداث التشغيلية (تفعيل المنصة الأصلية): الخط الزمني من GET /api/timeline.
//  عرض فقط — قراءة، بلا أي مسار كتابة.
//

import SwiftUI

struct OpsEventsView: View {
    @StateObject private var vm = OpsEventsViewModel()

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
        .emsPage("الأحداث التشغيلية")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        let items = vm.data?.data ?? []
        if items.isEmpty {
            EMSEmptyView(
                icon: "bolt",
                title: "لا توجد أحداث مسجلة",
                detail: "تظهر الأحداث التشغيلية هنا أولًا بأول")
        } else {
            ForEach(items) { item in
                EMSCard {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: vm.icon(for: item.type))
                            .font(.subheadline)
                            .foregroundStyle(vm.tone(for: item.type).color)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title ?? "حدث")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .fixedSize(horizontal: false, vertical: true)
                            if let desc = item.desc, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: 6) {
                                if let date = item.date {
                                    Text(date)
                                }
                                if let time = item.time, !time.isEmpty {
                                    Text("·")
                                    Text(time)
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class OpsEventsViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: TimelineDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/timeline")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    // MARK: - عرض الأنواع (القيم سيرفرية — الأيقونة واللون عرضيان فقط)

    func icon(for type: String?) -> String {
        switch type {
        case "alert", "warning": return "exclamationmark.triangle.fill"
        case "vehicle": return "truck.box.fill"
        case "staffing": return "person.3.fill"
        default: return "bolt.fill"
        }
    }

    func tone(for type: String?) -> EMSTheme.StatusTone {
        switch type {
        case "alert", "warning": return .monitor
        case "critical": return .danger
        default: return .action
        }
    }
}
