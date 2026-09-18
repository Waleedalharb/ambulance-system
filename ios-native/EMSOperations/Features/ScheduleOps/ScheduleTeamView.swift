//
//  ScheduleTeamView.swift
//  EMSOperations
//
//  وجها «فريق» و«مركز» (centerMode): منتقي فريق/مركز ثم شبكة
//  موظفيه × أيام الشهر عبر ScheduleRosterGrid. المركز يجمع فرقه
//  من سجل الفرق المرجعي (teams.center) — لا اشتقاق في العميل.
//

import SwiftUI

struct ScheduleTeamView: View {
    @ObservedObject var vm: ScheduleOpsViewModel
    var centerMode: Bool = false
    var allowsEmptyTap: Bool = false
    var onSelect: (ScheduleCellContext) -> Void

    @State private var selection: String = ""

    private var options: [String] {
        centerMode ? vm.centers : vm.teamNamesInRoster
    }

    private var filtered: [RosterMonthDTO.Entry] {
        guard !selection.isEmpty else { return [] }
        return centerMode ? vm.entries(center: selection) : vm.entries(team: selection)
    }

    var body: some View {
        VStack(spacing: EMSTheme.spacing) {
            if options.isEmpty {
                EMSEmptyView(icon: centerMode ? "building.2" : "person.3",
                             title: centerMode ? "لا توجد مراكز مسجلة" : "لا توجد فرق في هذا الشهر")
            } else {
                selector
                switch vm.rosterState {
                case .loading:
                    EMSSkeletonCard(lines: 5)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.reloadMonth() } }
                case .loaded:
                    if filtered.isEmpty {
                        EMSEmptyView(icon: "calendar", title: "لا توجد سجلات لهذا الاختيار")
                    } else {
                        EMSCard {
                            ScheduleRosterGrid(entries: filtered, days: vm.monthDays,
                                               codes: vm.codes, allowsEmptyTap: allowsEmptyTap,
                                               onSelect: onSelect)
                        }
                    }
                }
            }
        }
        .onAppear { alignSelection() }
        .onChange(of: vm.selectedMonth) { _ in alignSelection() }
    }

    private func alignSelection() {
        if selection.isEmpty || !options.contains(selection) {
            selection = options.first ?? ""
        }
    }

    private var selector: some View {
        Menu {
            ForEach(options, id: \.self) { o in
                Button {
                    selection = o
                } label: {
                    if o == selection {
                        Label(o, systemImage: "checkmark")
                    } else {
                        Text(o)
                    }
                }
            }
        } label: {
            HStack {
                Image(systemName: centerMode ? "building.2.fill" : "person.3.fill")
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text(selection.isEmpty ? (centerMode ? "اختر مركزًا" : "اختر فريقًا") : selection)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            .padding(EMSTheme.cardPadding)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
        }
    }
}
