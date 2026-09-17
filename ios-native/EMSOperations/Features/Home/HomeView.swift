//
//  HomeView.swift
//  EMSOperations
//
//  الرئيسية التشغيلية (قسم 10): ملخص اليوم + اختصارات مشروطة
//  بخريطة /api/my/sections (نفس منطق البوابة — العرض بالتكليف الفعلي).
//

import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = HomeViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if vm.isOffline {
                    EMSStatusPill(text: "غير متصل — تعرض آخر بيانات محفوظة", tone: .monitor)
                }
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard(lines: 2)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(session: session) } }
                case .loaded:
                    if let p = vm.profile {
                        todayCard(p)
                    }
                    shortcutsGrid
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load(session: session) }
        .emsPage("الرئيسية")
        .task { await vm.load(session: session) }
    }

    // MARK: - بطاقة اليوم

    private func todayCard(_ p: ProfileDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p.employee.name)
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                        Text("الرقم الوظيفي: \(p.employee.code ?? "—")")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    Spacer()
                    if let src = p.today?.assignmentSource, src == "primary_fallback" {
                        EMSStatusPill(text: "تعيين أساسي", tone: .monitor)
                    }
                }
                Divider().overlay(EMSTheme.Colors.divider)
                if let today = p.today, today.shiftCode != nil {
                    EMSInfoRow(label: "مناوبة اليوم", value: today.shiftName ?? today.shiftCode ?? "—")
                    if let start = today.timeStart, let end = today.timeEnd {
                        EMSInfoRow(label: "الوقت", value: "\(start) — \(end)")
                    }
                    EMSInfoRow(label: "الفرقة", value: today.teamName ?? "—")
                    EMSInfoRow(label: "المركز", value: today.center ?? "—")
                } else {
                    Text("لا توجد مناوبة مسجلة اليوم")
                        .font(.subheadline)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
            }
        }
    }

    // MARK: - الاختصارات (مشروطة بالأقسام)

    private struct Shortcut: Identifiable {
        let id = UUID()
        let title: String
        let icon: String
        let destination: Destination
    }

    private enum Destination: Hashable {
        case mates, completion, incidents, vehicle, inventory, changes, assignments
    }

    private var shortcuts: [Shortcut] {
        guard let s = vm.sections else { return [] }
        var list: [Shortcut] = []
        list.append(.init(title: "زملائي في المناوبة", icon: "person.3.fill", destination: .mates))
        if s.check { list.append(.init(title: "التكميل", icon: "checklist.checked", destination: .completion)) }
        if s.incidents { list.append(.init(title: "بلاغات فرقتي", icon: "doc.text.magnifyingglass", destination: .incidents)) }
        if s.vehicle { list.append(.init(title: "مركبتي", icon: "truck.box.fill", destination: .vehicle)) }
        if s.inventory { list.append(.init(title: "العهدة", icon: "shippingbox.fill", destination: .inventory)) }
        list.append(.init(title: "سجل تغييرات جدولي", icon: "arrow.triangle.2.circlepath", destination: .changes))
        if s.assignments { list.append(.init(title: "تكليفاتي", icon: "calendar.badge.clock", destination: .assignments)) }
        return list
    }

    private var shortcutsGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: EMSTheme.spacing) {
            ForEach(shortcuts) { item in
                NavigationLink(value: item.destination) {
                    VStack(spacing: 10) {
                        Image(systemName: item.icon)
                            .font(.title3)
                            .foregroundStyle(EMSTheme.Colors.teal)
                        Text(item.title)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 92)
                    .background(EMSTheme.Colors.card)
                    .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .navigationDestination(for: Destination.self) { dest in
            switch dest {
            case .mates: ShiftMatesView()
            case .completion: CompletionView()
            case .incidents: ReportsView()
            case .vehicle: VehicleView()
            case .inventory: InventoryView()
            case .changes: ScheduleChangesView()
            case .assignments: AssignmentsView()
            }
        }
    }
}
