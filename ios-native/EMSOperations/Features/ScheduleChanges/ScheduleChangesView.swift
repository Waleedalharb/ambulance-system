//
//  ScheduleChangesView.swift
//  EMSOperations
//
//  «سجل تغييرات جدولي» (قسم 14): قبل/بعد بوضوح، نوع التغيير،
//  سياق المراجعة (العملية/الفاعل) — كل رقم قابل للتتبع كما في البوابة.
//

import SwiftUI

struct ScheduleChangesView: View {
    @StateObject private var vm = ScheduleChangesViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if vm.changes.isEmpty {
                        EMSEmptyView(icon: "checkmark.circle", title: "لا توجد تغييرات على جدولك", detail: "عند أي تعديل في جدولك سيظهر هنا مع التفاصيل.")
                    } else {
                        ForEach(vm.changes) { change in
                            changeCard(change)
                        }
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("سجل تغييرات جدولي")
        .task { await vm.load() }
    }

    private func changeCard(_ c: ScheduleChangesDTO.Change) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSStatusPill(text: c.changeLabel ?? c.changeType ?? "تغيير", tone: tone(for: c.changeType))
                    Spacer()
                    Text(c.date ?? "")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }

                // قبل ← بعد (رمز المناوبة والفرقة)
                HStack(spacing: 12) {
                    changeSide(title: "قبل", code: c.oldShiftCode, team: c.oldTeam, faded: true)
                    Image(systemName: "arrow.left")
                        .foregroundStyle(EMSTheme.Colors.teal)
                    changeSide(title: "بعد", code: c.newShiftCode, team: c.newTeam, faded: false)
                }

                if let reason = c.reason, !reason.isEmpty {
                    Text("السبب: \(reason)")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }

                let src = [c.revisionSource, c.revisionActor].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                if !src.isEmpty {
                    Text(src)
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    private func changeSide(title: String, code: String?, team: String?, faded: Bool) -> some View {
        VStack(spacing: 4) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            Text(code ?? "—")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(faded ? EMSTheme.Colors.textMuted : .white)
            Text(team ?? "—")
                .font(.caption)
                .foregroundStyle(faded ? EMSTheme.Colors.textMuted : EMSTheme.Colors.textSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func tone(for type: String?) -> EMSTheme.StatusTone {
        switch type {
        case "add": return .normal
        case "delete": return .danger
        case "swap": return .action
        default: return .monitor
        }
    }
}

@MainActor
final class ScheduleChangesViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var changes: [ScheduleChangesDTO.Change] = []

    func load() async {
        if changes.isEmpty { state = .loading }
        do {
            let res: ScheduleChangesDTO = try await APIClient.shared.get("/api/my/schedule-changes")
            changes = res.changes
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: !changes.isEmpty, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: !changes.isEmpty, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }
}
