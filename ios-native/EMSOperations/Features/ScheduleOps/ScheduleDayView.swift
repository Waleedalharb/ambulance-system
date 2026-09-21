//
//  ScheduleDayView.swift
//  EMSOperations
//
//  وجه «يوم»: منتقي تاريخ داخل الشهر المختار + تعيينات ذلك اليوم
//  مجمعة بالفريق. نقر أي تعيين يفتح تفاصيل الخلية.
//

import SwiftUI

struct ScheduleDayView: View {
    @ObservedObject var vm: ScheduleOpsViewModel
    var onSelect: (ScheduleCellContext) -> Void

    @State private var selectedDate: Date = Date()

    private var monthRange: ClosedRange<Date>? {
        guard let first = vm.monthDays.first, let last = vm.monthDays.last,
              let start = ScheduleDateKit.date(first), let end = ScheduleDateKit.date(last) else { return nil }
        return start...end
    }

    private var dayEntries: [RosterMonthDTO.Entry] {
        vm.entries(date: ScheduleDateKit.string(selectedDate))
    }

    private var teamsOrdered: [String] {
        var seen: [String] = []
        for e in dayEntries {
            let n = e.teamName ?? "بدون فريق"
            if !seen.contains(n) { seen.append(n) }
        }
        return seen
    }

    var body: some View {
        VStack(spacing: EMSTheme.spacing) {
            if let monthRange {
                EMSCard {
                    DatePicker("اليوم", selection: $selectedDate, in: monthRange, displayedComponents: .date)
                        .datePickerStyle(.graphical)
                        .environment(\.locale, Locale(identifier: "ar"))
                        .tint(EMSTheme.Colors.teal)
                }
            }
            switch vm.rosterState {
            case .loading:
                EMSSkeletonCard(lines: 4)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.reloadMonth() } }
            case .loaded:
                if dayEntries.isEmpty {
                    EMSEmptyView(icon: "calendar.badge.exclamationmark",
                                 title: "لا توجد تعيينات في هذا اليوم")
                } else {
                    ForEach(teamsOrdered, id: \.self) { team in
                        teamCard(team)
                    }
                }
            }
        }
        .onAppear { alignDateWithMonth() }
        .onChange(of: vm.selectedMonth) { _ in alignDateWithMonth() }
    }

    /// اليوم الحالي إن كان ضمن الشهر، وإلا أول أيامه.
    private func alignDateWithMonth() {
        guard let range = monthRange else { return }
        let today = Date()
        selectedDate = range.contains(today) ? today : range.lowerBound
    }

    private func teamCard(_ team: String) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: team, systemImage: "person.3.fill")
                ForEach(dayEntries.filter { ($0.teamName ?? "بدون فريق") == team }) { entry in
                    Button {
                        onSelect(.existing(entry))
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.employeeName ?? "—")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                                if let code = entry.employeeCode, !code.isEmpty {
                                    Text(code)
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            Spacer()
                            EMSStatusPill(text: vm.codeLabel(entry.shiftCode), tone: .action)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
