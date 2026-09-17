//
//  HomeView.swift
//  EMSOperations
//
//  Operational Home (v2 قسم 7/8): ليست قائمة Menu — بل ملخص تشغيلي حي:
//  حالة المناوبة · مناوبة اليوم · الفريق · نبض العمليات (للصلاحيات)
//  · إجراءات سريعة · آخر التنبيهات. كل بياناتها من الـBackend حصرًا،
//  والأقسام مشروطة بخريطة /api/my/sections والصلاحيات الفعلية.
//

import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var network: NetworkMonitor
    @StateObject private var vm = HomeViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if let banner = network.bannerText {
                    EMSStatusPill(text: banner, tone: network.isOffline ? .danger : .monitor)
                }
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard(lines: 2)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(session: session, force: true) } }
                case .loaded:
                    if vm.portalUnavailable {
                        platformIdentityCard
                    }
                    if let p = vm.profile {
                        statusStrip(p)
                        shiftCard(p)
                    }
                    teamCard
                    if session.permissions.canAccessOperations { operationsPulseCard }
                    if session.permissions.canViewIndicators { indicatorsCard }
                    if !vm.portalUnavailable { quickActionsGrid }
                    recentNotificationsCard
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load(session: session, force: true) }
        .emsPage("EMS OPERATIONS")
        .task { await vm.load(session: session) }
    }

    // MARK: - بطاقة الهوية المؤسسية (حساب بلا بوابة موظف — عمليات/إدارة)

    private var platformIdentityCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "EMS OPERATIONS", systemImage: "cross.case.fill")
                if let roleLabel = session.permissions.roleLabel {
                    EMSInfoRow(label: "الدور", value: roleLabel)
                }
                Text("هذا الحساب غير مرتبط ببوابة الموظف — تُعرض لك الوحدات التشغيلية حسب صلاحياتك.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - شريط الحالة التشغيلية (من حالة المناوبة الفعلية فقط)

    @ViewBuilder
    private func statusStrip(_ p: ProfileDTO) -> some View {
        if let stateText = vm.shiftStateText {
            HStack(spacing: 10) {
                Circle()
                    .fill(vm.mates?.me?.onShift == true ? EMSTheme.Colors.emerald : EMSTheme.Colors.textMuted)
                    .frame(width: 10, height: 10)
                Text(stateText)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Spacer()
                if let team = vm.mates?.me?.teamName {
                    Text(team)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
            }
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - مناوبة اليوم

    private func shiftCard(_ p: ProfileDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    EMSectionHeader(title: "مناوبتي", systemImage: "clock.badge.checkmark")
                    if let src = p.today?.assignmentSource, src == "primary_fallback" {
                        EMSStatusPill(text: "تعيين أساسي", tone: .monitor)
                    }
                }
                if let today = p.today, today.shiftCode != nil {
                    EMSInfoRow(label: "التاريخ", value: today.date ?? "—")
                    EMSInfoRow(label: "الوردية", value: today.shiftName ?? today.shiftCode ?? "—")
                    if let start = today.timeStart, let end = today.timeEnd {
                        EMSInfoRow(label: "الفترة", value: "\(start) — \(end)")
                    }
                    EMSInfoRow(label: "الفريق", value: today.teamName ?? "—")
                    EMSInfoRow(label: "المركز", value: today.center ?? "—")
                } else {
                    Text("لا توجد مناوبة مسجلة اليوم")
                        .font(.subheadline)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
            }
        }
    }

    // MARK: - فريقي

    @ViewBuilder
    private var teamCard: some View {
        if let mates = vm.mates {
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    EMSectionHeader(title: "فريقي في المناوبة", systemImage: "person.3.fill")
                    HStack(spacing: 16) {
                        teamCounter(count: vm.teamCount, label: "الفرقة")
                        if vm.leadershipCount > 0 { teamCounter(count: vm.leadershipCount, label: "القيادة") }
                        if vm.opsCount > 0 { teamCounter(count: vm.opsCount, label: "العمليات") }
                        Spacer()
                    }
                    if let window = mates.window?.label {
                        Text(window)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
            }
        }
    }

    private func teamCounter(count: Int, label: String) -> some View {
        VStack(spacing: 2) {
            Text("\(count)")
                .font(.title3.weight(.bold))
                .foregroundStyle(EMSTheme.Colors.teal)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
    }

    // MARK: - نبض العمليات (صلاحيات ops.*) — عدّادات حية من الخادم

    private var operationsPulseCard: some View {
        NavigationLink(value: Destination.operations) {
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.title3)
                            .foregroundStyle(EMSTheme.Colors.teal)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("نبض العمليات")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                            Text("الفرق · الجاهزية · المركبات · الأحداث")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                        Image(systemName: "chevron.left")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    if let pulse = vm.pulse {
                        Divider().overlay(EMSTheme.Colors.divider)
                        HStack(spacing: 16) {
                            pulseCounter(pulse.activeVehicles, "مركبة عاملة", EMSTheme.Colors.emerald)
                            pulseCounter(pulse.breakdownVehicles, "متعطلة", EMSTheme.Colors.warning)
                            pulseCounter(pulse.outOfServiceVehicles, "خارج الخدمة", EMSTheme.Colors.danger)
                            if let rate = pulse.readinessRate {
                                pulseCounter(rate, "الجاهزية ٪", EMSTheme.Colors.teal)
                            } else if let ready = pulse.readyTeams, let required = pulse.requiredTeams {
                                pulseCounter(ready, "فرق جاهزة من \(required)", EMSTheme.Colors.teal)
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func pulseCounter(_ value: Int?, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value.map(String.init) ?? "—")
                .font(.title3.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
    }

    // MARK: - المؤشرات (indicators.contribution)

    private var indicatorsCard: some View {
        EMSCard {
            HStack(spacing: 12) {
                Image(systemName: "chart.bar.fill")
                    .font(.title3)
                    .foregroundStyle(EMSTheme.Colors.teal)
                VStack(alignment: .leading, spacing: 3) {
                    Text("مؤشرات المساهمة")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    Text("متاحة على منصة الويب حاليًا — ستصل Native في مرحلة لاحقة")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                Spacer()
            }
        }
    }

    // MARK: - الإجراءات السريعة (مشروطة بالأقسام)

    enum Destination: Hashable {
        case shift, mates, completion, incidents, vehicle, inventory, changes, assignments, operations
    }

    private struct Shortcut: Identifiable {
        let id = UUID()
        let title: String
        let icon: String
        let destination: Destination
    }

    private var shortcuts: [Shortcut] {
        var list: [Shortcut] = [.init(title: "مناوبتي التفصيلية", icon: "clock.badge.checkmark", destination: .shift)]
        guard let s = vm.sections else { return list }
        list.append(.init(title: "زملائي", icon: "person.3.fill", destination: .mates))
        if s.check { list.append(.init(title: "التكميل", icon: "checklist.checked", destination: .completion)) }
        if s.incidents { list.append(.init(title: "بلاغات فرقتي", icon: "doc.text.magnifyingglass", destination: .incidents)) }
        if s.vehicle { list.append(.init(title: "مركبتي", icon: "truck.box.fill", destination: .vehicle)) }
        if s.inventory { list.append(.init(title: "العهدة", icon: "shippingbox.fill", destination: .inventory)) }
        list.append(.init(title: "تغييرات جدولي", icon: "arrow.triangle.2.circlepath", destination: .changes))
        if s.assignments { list.append(.init(title: "تكليفاتي", icon: "calendar.badge.clock", destination: .assignments)) }
        return list
    }

    private var quickActionsGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            EMSectionHeader(title: "إجراءات سريعة")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: EMSTheme.spacing) {
                ForEach(shortcuts) { item in
                    NavigationLink(value: item.destination) {
                        VStack(spacing: 8) {
                            Image(systemName: item.icon)
                                .font(.body)
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(item.title)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                                .minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 78)
                        .background(EMSTheme.Colors.card)
                        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationDestination(for: Destination.self) { dest in
            switch dest {
            case .shift: CurrentShiftView()
            case .mates: ShiftMatesView()
            case .completion: CompletionView()
            case .incidents: ReportsView()
            case .vehicle: VehicleView()
            case .inventory: InventoryView()
            case .changes: ScheduleChangesView()
            case .assignments: AssignmentsView()
            case .operations: OperationsHomeView()
            }
        }
    }

    // MARK: - آخر التنبيهات

    @ViewBuilder
    private var recentNotificationsCard: some View {
        if !vm.recentNotifications.isEmpty {
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        EMSectionHeader(title: "آخر التنبيهات", systemImage: "bell.fill")
                        if vm.unreadCount > 0 {
                            EMSStatusPill(text: "\(vm.unreadCount) غير مقروء", tone: .action)
                        }
                    }
                    ForEach(vm.recentNotifications) { item in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(item.isRead ? EMSTheme.Colors.textMuted : EMSTheme.Colors.teal)
                                .frame(width: 7, height: 7)
                                .padding(.top, 5)
                            Text(item.message)
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
        }
    }
}
