//
//  ScheduleMonthView.swift
//  EMSOperations
//
//  وجه «شهر»: شبكة الشهر الكاملة (فرق ← موظفون ← أيام) عبر
//  ScheduleRosterGrid المشتركة. نقر خلية قائمة يفتح تفاصيلها،
//  ونقر خانة فارغة يفتح الإضافة لمن يملك صلاحية الكتابة فقط.
//

import SwiftUI

struct ScheduleMonthView: View {
    @ObservedObject var vm: ScheduleOpsViewModel
    var allowsEmptyTap: Bool = false
    var onSelect: (ScheduleCellContext) -> Void

    var body: some View {
        switch vm.rosterState {
        case .loading:
            EMSSkeletonCard(lines: 6)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.reloadMonth() } }
        case .loaded:
            if vm.roster.isEmpty {
                EMSEmptyView(icon: "calendar", title: "لا توجد سجلات لهذا الشهر",
                             detail: "لم يُسجَّل أي سطر في جدول \(vm.selectedMonthLabel) حتى الآن.")
            } else {
                EMSCard {
                    ScheduleRosterGrid(entries: vm.roster, days: vm.monthDays,
                                       codes: vm.codes, allowsEmptyTap: allowsEmptyTap,
                                       onSelect: onSelect)
                }
            }
        }
    }
}
