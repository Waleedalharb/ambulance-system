//
//  ReportsView.swift
//  EMSOperations
//
//  بلاغات فرقتي (قسم 17): عدّادات اليوم/الأسبوع/الشهر من /api/my/team-incidents.
//  الأرقام من الخادم كما هي — لا حساب في العميل، وتُعرض ملاحظة الخادم التوضيحية.
//

import SwiftUI

struct ReportsView: View {
    @StateObject private var vm = ReportsViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 3)
                    EMSSkeletonCard(lines: 2)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    content
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("بلاغات فرقتي")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let data = vm.data {
            // العدّادات الثلاثة
            HStack(spacing: EMSTheme.spacing) {
                counterCard(title: "اليوم", value: data.today?.count, subtitle: data.today?.date)
                counterCard(title: "الأسبوع", value: data.week?.count,
                            subtitle: [data.week?.start, data.week?.end].compactMap { $0 }.joined(separator: " — "))
                counterCard(title: "الشهر", value: data.month?.count,
                            subtitle: data.month?.month.map { "\($0)/\(data.month?.year ?? 0)" })
            }

            if let unmatched = data.unmatchedUnits, unmatched > 0 {
                EMSCard {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(EMSTheme.Colors.warning)
                        Text("وحدات غير مطابقة في العدّ: \(unmatched)")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textSecondary)
                        Spacer()
                    }
                }
            }

            if let byTeam = data.byTeam, !byTeam.isEmpty {
                EMSCard {
                    VStack(alignment: .leading, spacing: 10) {
                        EMSectionHeader(title: "حسب الفرقة", systemImage: "person.3")
                        ForEach(byTeam) { row in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(row.teamName ?? "فرقة")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.white)
                                    Spacer()
                                    Text("\(row.count ?? 0)")
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                }
                                if let from = row.from, let to = row.to {
                                    Text("\(from) — \(to)")
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            if row.id != byTeam.last?.id {
                                Divider().overlay(EMSTheme.Colors.divider)
                            }
                        }
                    }
                }
            }

            // ملاحظة توضيحية — من الخادم إن وُجدت وإلا النص المعتمد
            EMSCard {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(EMSTheme.Colors.teal)
                    Text(data.note ?? "هذه العدّادات إحصاء تشغيلي لبلاغات فرقتك في الفترة المعروضة، وهي للاطلاع ولا تُعد مؤشر أداء فردي.")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private func counterCard(title: String, value: Int?, subtitle: String?) -> some View {
        VStack(spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(EMSTheme.Colors.textSecondary)
            Text(value.map { "\($0)" } ?? "—")
                .font(.title2.weight(.bold))
                .foregroundStyle(EMSTheme.Colors.teal)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }
}

// MARK: - ViewModel

@MainActor
final class ReportsViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: TeamIncidentsDTO?

    private let api = APIClient.shared

    func load() async {
        if data == nil { state = .loading }
        do {
            data = try await api.get("/api/my/team-incidents")
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }
}
