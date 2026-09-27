//
//  HomeView.swift
//  EMSOperations
//
//  الرئيسية بالمرجع البصري المعتمد (توجيه المالك 2026-09-28): Hero إسعاف الرياض
//  (تحية + اسم + شعار المشهد) ← الوضع التشغيلي الآن (للصلاحيات، عدّادات الخادم
//  الخام) ← مناوبتك القادمة (من profile/schedule الفعلية + عدّ تنازلي) ←
//  إجراءات سريعة تنتقل للتبويبات/الشاشات القائمة ← آخر الأحداث (إشعارات فعلية).
//  كل بياناتها من الـBackend حصرًا — لا أرقام ثابتة ولا بيانات تجريبية.
//  طبقة عرض فقط: لا تغيير في أي ربط أو منطق أو عقد API قائمة.
//

import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var network: NetworkMonitor
    @EnvironmentObject private var tabRouter: AppTabRouter
    @StateObject private var vm = HomeViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                heroSection

                VStack(spacing: EMSTheme.spacing) {
                    if let banner = network.bannerText {
                        EMSStatusPill(text: banner, tone: network.isOffline ? .danger : .monitor)
                    }
                    // تنبيه كلمة المرور الأولية (= الكود) — يظهر حتى يغيّرها من «حسابي» (قرار المالك 2026-09-20)
                    if InitialPasswordAdvisory.isPending(for: session.currentUser?.username) {
                        EMSStatusPill(text: "كلمة المرور الحالية هي كود الموظف — ننصحك بتغييرها من تبويب «حسابي»", tone: .action)
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
                        if session.permissions.canAccessOperations {
                            operationalStatusCard
                        }
                        if !vm.portalUnavailable {
                            nextShiftCard
                            quickActionsRow
                        }
                        latestEventsCard
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
        }
        .refreshable { await vm.load(session: session, force: true) }
        // تسجيل الوجهات في جذر الشاشة — لا داخل البلاطات (خلل 2026-09-20).
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
            case .requests: MyRequestsView()
            }
        }
        .emsPage("EMS OPERATIONS")
        // المرجع: الـHero يبدأ من أعلى الشاشة — لا شريط تنقّل في الرئيسية.
        .toolbar(.hidden, for: .navigationBar)
        .task { await vm.load(session: session) }
    }

    // MARK: - Hero (إسعاف الرياض + التحية + الاسم)

    private var heroSection: some View {
        ZStack(alignment: .top) {
            Image("home_hero")
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity)
                .frame(height: 250)
                .clipped()
            // تدرج يذيب الصورة في خلفية التطبيق أسفلًا ويضمن وضوح النص أعلى
            LinearGradient(colors: [EMSTheme.Colors.navy.opacity(0.45),
                                    EMSTheme.Colors.navy.opacity(0.05),
                                    EMSTheme.Colors.navy.opacity(0.75),
                                    EMSTheme.Colors.navy],
                           startPoint: .top, endPoint: .bottom)

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 10) {
                    heroAvatar
                    VStack(alignment: .leading, spacing: 2) {
                        Text(vm.greeting)
                            .font(.subheadline)
                            .foregroundStyle(Color.white.opacity(0.9))
                        Text(displayName)
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Text("مستعد ليوم جديد من العطاء 👋")
                            .font(.caption)
                            .foregroundStyle(Color.white.opacity(0.75))
                    }
                    Spacer()
                    if session.permissions.canAccessEmployeePortal {
                        Button { tabRouter.selected = .notifications } label: {
                            Image(systemName: "bell.fill")
                                .font(.subheadline)
                                .foregroundStyle(.white)
                                .padding(9)
                                .background(Color.black.opacity(0.35))
                                .clipShape(Circle())
                                .overlay(alignment: .topLeading) {
                                    if vm.unreadCount > 0 {
                                        Circle()
                                            .fill(EMSTheme.Colors.danger)
                                            .frame(width: 9, height: 9)
                                    }
                                }
                        }
                        .accessibilityLabel("الإشعارات")
                    }
                }

                Spacer()

                Text("معاً لسلامة مجتمعنا")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                Text("جاهزون .. لنكون بالقرب دائماً")
                    .font(.subheadline)
                    .foregroundStyle(Color.white.opacity(0.8))
            }
            .padding(.horizontal, EMSTheme.pagePadding)
            .padding(.top, 54) // منطقة الحالة — شريط التنقل مخفي في الرئيسية
            .padding(.bottom, 14)
        }
        .frame(height: 250)
        .ignoresSafeArea(edges: .top)
    }

    /// صورة الموظف — حرف اسمه حتى يوفر الخادم avatar_url (نفس fallback البلوت).
    private var heroAvatar: some View {
        let name = displayName
        return Text(String(name.prefix(1)))
            .font(.headline.weight(.bold))
            .foregroundStyle(.white)
            .frame(width: 52, height: 52)
            .background(EMSTheme.Colors.navySoft.opacity(0.85))
            .clipShape(Circle())
            .overlay(Circle().stroke(EMSTheme.Colors.teal, lineWidth: 2))
            .accessibilityHidden(true)
    }

    private var displayName: String {
        vm.profile?.employee.name ?? session.currentUser?.name ?? "منظومة العمليات"
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

    // MARK: - الوضع التشغيلي الآن (عدّادات الخادم الخام — ops.* فقط)

    @ViewBuilder
    private var operationalStatusCard: some View {
        if let pulse = vm.pulse {
            EMSCard {
                VStack(spacing: 12) {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(EMSTheme.Colors.emerald)
                                    .frame(width: 8, height: 8)
                                Text("الوضع التشغيلي الآن")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                            }
                            Text(pulseSubtitle(pulse))
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                        if let rate = pulse.readinessRate {
                            readinessGauge(rate)
                        }
                    }
                    HStack(spacing: 8) {
                        statTile(value: pulse.activeVehicles, total: vehiclesTotal(pulse),
                                 label: "المركبات الجاهزة", icon: "cross.case.fill", color: EMSTheme.Colors.emerald)
                        statTile(value: pulse.readyTeams, total: pulse.requiredTeams,
                                 label: "الفرق العاملة", icon: "person.3.fill", color: EMSTheme.Colors.teal)
                        statTile(value: pulse.breakdownVehicles, total: nil,
                                 label: "تحتاج متابعة", icon: "exclamationmark.triangle.fill", color: EMSTheme.Colors.warning)
                        statTile(value: pulse.outOfServiceVehicles, total: nil,
                                 label: "خارج الخدمة", icon: "wrench.fill", color: EMSTheme.Colors.danger)
                    }
                }
            }
        }
    }

    /// عنوان فرعي مشتق من العدّادات نفسها — لا نص ثابت مضلل.
    private func pulseSubtitle(_ pulse: HomeViewModel.OpsPulse) -> String {
        let issues = (pulse.outOfServiceVehicles ?? 0) + (pulse.breakdownVehicles ?? 0)
        return issues == 0 ? "جميع الأنظمة تعمل بشكل طبيعي" : "يوجد \(issues) ما يحتاج متابعة"
    }

    private func vehiclesTotal(_ pulse: HomeViewModel.OpsPulse) -> Int? {
        guard let a = pulse.activeVehicles else { return nil }
        return a + (pulse.breakdownVehicles ?? 0) + (pulse.outOfServiceVehicles ?? 0)
    }

    /// عدّاد الجاهزية الدائري — نسبة الخادم كما هي.
    private func readinessGauge(_ rate: Int) -> some View {
        ZStack {
            Circle()
                .stroke(EMSTheme.Colors.navySoft, lineWidth: 6)
            Circle()
                .trim(from: 0, to: CGFloat(max(0, min(100, rate))) / 100)
                .stroke(EMSTheme.Colors.teal, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text("\(rate)%")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                Text("الجاهزية")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .frame(width: 64, height: 64)
        .accessibilityElement(children: .combine)
    }

    private func statTile(value: Int?, total: Int?, label: String, icon: String, color: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(color)
            HStack(spacing: 2) {
                Text(value.map(String.init) ?? "—")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                if let total {
                    Text("من \(total)")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(EMSTheme.Colors.navySoft.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - مناوبتك القادمة (من profile/schedule الفعلية)

    private var nextShiftCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: vm.nextShift?.isOngoing == true ? "مناوبتك الحالية" : "مناوبتك القادمة",
                                    systemImage: "calendar")
                    Spacer()
                    Button { tabRouter.selected = .schedule } label: {
                        Image(systemName: "chevron.left")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    .accessibilityLabel("فتح مناوباتي")
                }

                if let ns = vm.nextShift {
                    Text(vm.arabicDateLabel(ns.date))
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)

                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            if let shift = ns.shiftName {
                                Text(shift)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(EMSTheme.Colors.warning)
                                    .padding(.horizontal, 10).padding(.vertical, 4)
                                    .background(EMSTheme.Colors.warning.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                            if let start = ns.start, let end = ns.end {
                                Label("\(timeLabel(start)) — \(timeLabel(end))", systemImage: "clock")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                            if let center = ns.center {
                                Label("المركز: \(center)", systemImage: "mappin")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                            if let team = ns.teamName {
                                Label("الفريق: \(team)", systemImage: "person.2")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                        }
                        Spacer()
                        countdownColumn(ns)
                    }
                } else {
                    Text("لا توجد مناوبة قادمة مسجلة في جدول هذا الشهر")
                        .font(.subheadline)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
            }
        }
    }

    /// العد التنازلي للمناوبة — يوم/ساعة/دقيقة من وقت البدء الفعلي (أو النهاية
    /// أثناء المناوبة الجارية). أيام الجدول المستقبلية بلا أوقات تعرض الأيام فقط.
    @ViewBuilder
    private func countdownColumn(_ ns: HomeViewModel.NextShiftInfo) -> some View {
        VStack(spacing: 4) {
            Text(ns.isOngoing ? "متبقي على نهايتها" : "متبقي على المناوبة")
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            if ns.start != nil || ns.end != nil {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    let remaining = countdownParts(ns, now: context.date)
                    HStack(spacing: 6) {
                        countdownBox(remaining.days, "يوم")
                        countdownBox(remaining.hours, "ساعة")
                        countdownBox(remaining.minutes, "دقيقة")
                    }
                }
            } else {
                // يوم مستقبلي بلا وقت بدء من الخادم — الأيام فقط (لا أرقام مفترضة)
                let days = riyadhDaysUntil(ns.date)
                HStack(spacing: 6) {
                    countdownBox(days, days == 1 ? "يوم" : "أيام")
                }
            }
        }
    }

    private func countdownParts(_ ns: HomeViewModel.NextShiftInfo, now: Date) -> (days: Int, hours: Int, minutes: Int) {
        let target = ns.isOngoing ? ns.end : ns.start
        guard let target else { return (0, 0, 0) }
        let remaining = max(0, Int(target.timeIntervalSince(now)))
        return (remaining / 86400, (remaining % 86400) / 3600, (remaining % 3600) / 60)
    }

    private func riyadhDaysUntil(_ date: Date) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        let today = cal.startOfDay(for: Date())
        return max(0, cal.dateComponents([.day], from: today, to: date).day ?? 0)
    }

    private func countdownBox(_ value: Int, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(String(format: "%02d", value))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(EMSTheme.Colors.teal)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
        .frame(width: 48)
        .padding(.vertical, 6)
        .background(EMSTheme.Colors.navySoft.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func timeLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    // MARK: - الإجراءات السريعة (انتقال للتبويبات/الشاشات القائمة حسب المرجع)

    enum Destination: Hashable {
        case shift, mates, completion, incidents, vehicle, inventory, changes, assignments, operations, requests
    }

    private var quickActionsRow: some View {
        HStack(spacing: 10) {
            if session.permissions.canAccessOperations {
                quickTile("العمليات", icon: "point.3.connected.trianglepath.dotted", color: EMSTheme.Colors.teal) {
                    tabRouter.selected = .operations
                }
            }
            if session.permissions.canAccessEmployeePortal {
                quickTile("الجدول", icon: "calendar", color: EMSTheme.Colors.emerald) {
                    tabRouter.selected = .schedule
                }
            } else if session.permissions.canViewSchedules {
                quickTile("الجداول", icon: "calendar.badge.clock", color: EMSTheme.Colors.emerald) {
                    tabRouter.selected = .scheduleOps
                }
            }
            if session.permissions.canAccessEmployeePortal {
                NavigationLink(value: Destination.requests) {
                    quickTileLabel("طلباتي", icon: "doc.text.fill", color: EMSTheme.Colors.danger)
                }
                .buttonStyle(.plain)
            }
            quickTile("المحادثات", icon: "bubble.left.and.bubble.right.fill", color: EMSTheme.Colors.warning) {
                tabRouter.selected = .chat
            }
        }
    }

    private func quickTile(_ title: String, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) { quickTileLabel(title, icon: icon, color: color) }
            .buttonStyle(.plain)
    }

    private func quickTileLabel(_ title: String, icon: String, color: Color) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(color)
            Text(title)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 74)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    // MARK: - آخر الأحداث (إشعارات فعلية)

    @ViewBuilder
    private var latestEventsCard: some View {
        if !vm.recentNotifications.isEmpty {
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        EMSectionHeader(title: "آخر الأحداث", systemImage: "list.bullet")
                        Spacer()
                        if session.permissions.canAccessEmployeePortal {
                            Button("عرض الكل") { tabRouter.selected = .notifications }
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                        }
                    }
                    ForEach(vm.recentNotifications) { item in
                        HStack(alignment: .center, spacing: 8) {
                            Circle()
                                .fill(item.isRead ? EMSTheme.Colors.textMuted : EMSTheme.Colors.teal)
                                .frame(width: 7, height: 7)
                            Text(item.message)
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if let time = vm.notificationTime(item.createdAt) {
                                Text(time)
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                    }
                }
            }
        }
    }
}
