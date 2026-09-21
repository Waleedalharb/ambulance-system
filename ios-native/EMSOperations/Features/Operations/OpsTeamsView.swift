//
//  OpsTeamsView.swift
//  EMSOperations
//
//  الفرق (تفعيل المنصة الأصلية): سجل الفرق المرجعي من GET /api/teams.
//  عرض فقط — قراءة، بلا أي مسار كتابة.
//

import SwiftUI

struct OpsTeamsView: View {
    @StateObject private var vm = OpsTeamsViewModel()

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
        .emsPage("الفرق")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if vm.sortedTeams.isEmpty {
            EMSEmptyView(
                icon: "person.3",
                title: "لا توجد فرق نشطة",
                detail: "سيظهر سجل الفرق هنا عند توفره من المنظومة")
        } else {
            ForEach(vm.sortedTeams) { team in
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: "person.3.fill")
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(team.name ?? "فريق")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(.white)
                            Spacer()
                            if let required = team.requiredPersonnel {
                                EMSStatusPill(text: "\(required) أفراد", tone: .neutral)
                            }
                        }
                        Divider().overlay(EMSTheme.Colors.divider)
                        EMSInfoRow(label: "المركز", value: team.center ?? "—")
                        if let type = team.teamType, !type.isEmpty {
                            EMSInfoRow(label: "النوع", value: type)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class OpsTeamsViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: OpsTeamsDTO?

    private let api = APIClient.shared

    var sortedTeams: [OpsTeamsDTO.Team] {
        let list = (data?.teams ?? []).filter { ($0.isActive ?? 1) != 0 }
        return list.sorted {
            ($0.sortOrder ?? 0) != ($1.sortOrder ?? 0)
                ? ($0.sortOrder ?? 0) < ($1.sortOrder ?? 0)
                : ($0.name ?? "").localizedStandardCompare($1.name ?? "") == .orderedAscending
        }
    }

    func load() async {
        if data == nil { state = .loading }
        do {
            data = try await api.get("/api/teams")
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }
}
