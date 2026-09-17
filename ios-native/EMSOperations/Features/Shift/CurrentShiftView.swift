//
//  CurrentShiftView.swift
//  EMSOperations
//
//  «مناوبتي» (قسم 11): سياق النافذة الفعلي من /api/my/shift-mates
//  (الليلية الممتدة محسوبة خادميًا) + تفاصيل اليوم من /api/my/profile.
//  لا حساب في العميل — الخادم مصدر الحقيقة.
//

import SwiftUI

struct CurrentShiftView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = CurrentShiftViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard(lines: 2)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if let mates = vm.mates {
                        contextCard(mates)
                        if let team = mates.team, !team.isEmpty {
                            teamPreview(team)
                        }
                    }
                    if let p = vm.profile, let today = p.today {
                        detailsCard(today)
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("مناوبتي")
        .task { await vm.load() }
    }

    private func contextCard(_ m: ShiftMatesDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    EMSectionHeader(title: "السياق الحالي", systemImage: "clock.fill")
                    Spacer()
                    if let me = m.me {
                        switch me.state {
                        case "active": EMSStatusPill(text: "على المناوبة", tone: .normal)
                        case "upcoming": EMSStatusPill(text: "قادمة", tone: .action)
                        default: EMSStatusPill(text: "خارج المناوبة", tone: .neutral)
                        }
                    }
                }
                if let w = m.window {
                    EMSInfoRow(label: "التاريخ", value: w.date ?? "—")
                    EMSInfoRow(label: "الوجهة", value: w.label ?? "—")
                }
                if let me = m.me {
                    EMSInfoRow(label: "رمز مناوبتي", value: me.shiftCode ?? "—")
                    EMSInfoRow(label: "فرقتي", value: me.teamName ?? "—")
                }
            }
        }
    }

    private func teamPreview(_ team: [ShiftMatesDTO.Person]) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "طاقم الفرقة (\(team.count))", systemImage: "person.3.fill")
                ForEach(team.prefix(6)) { person in
                    HStack {
                        Text(person.name)
                            .font(.subheadline)
                            .foregroundStyle(.white)
                        if person.isMe == true {
                            Text("(أنا)")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.teal)
                        }
                        Spacer()
                        Text(person.jobTitle ?? "")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                if team.count > 6 {
                    NavigationLink("عرض الكل — زملائي في المناوبة") {
                        ShiftMatesView()
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private func detailsCard(_ today: ProfileDTO.Today) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 12) {
                EMSectionHeader(title: "تفاصيل اليوم", systemImage: "calendar.badge.clock")
                EMSInfoRow(label: "التاريخ", value: today.date ?? "—")
                EMSInfoRow(label: "المناوبة", value: today.shiftName ?? today.shiftCode ?? "—")
                if let s = today.timeStart, let e = today.timeEnd {
                    EMSInfoRow(label: "الوقت", value: "\(s) — \(e)")
                }
                EMSInfoRow(label: "الفرقة", value: today.teamName ?? "—")
                EMSInfoRow(label: "المركز", value: today.center ?? "—")
            }
        }
    }
}

@MainActor
final class CurrentShiftViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var mates: ShiftMatesDTO?
    @Published var profile: ProfileDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            async let m: ShiftMatesDTO = api.get("/api/my/shift-mates")
            async let p: ProfileDTO = api.get("/api/my/profile")
            let (mates, profile) = try await (m, p)
            self.mates = mates
            self.profile = profile
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
