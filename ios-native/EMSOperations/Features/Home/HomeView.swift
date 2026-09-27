//
//  HomeView.swift
//  EMSOperations
//
//  الرئيسية بالمرجع البصري المعتمد (بروتوكول التطابق البكسلي 2026-09-28):
//  المرجع = مواصفة حرفية. المواضع مثبتة كما تظهر في الصورة (أفاتار يسار /
//  إجراءات يمين / عنوان أسفل اليسار / عدّادات يمين البطاقات) عبر حاوية LTR
//  صريحة حتى لا يعيد RTL توزيع العناصر؛ النصوص العربية تُشكَّل صحيحة داخليًا.
//  المقاسات مستخرجة من المرجع 851×1848px على إطار 393pt (÷2.165).
//  كل البيانات من الـBackend حصرًا — لا أرقام ثابتة. طبقة عرض فقط:
//  لا تغيير في أي ربط أو منطق أو عقد API قائمة.
//
//  عوائق مرفوعة للمالك (بانتظار قراره — لم تُخترع بيانات لها):
//  كبسولة الطقس، زر البحث، شارة عدد «طلباتي» — لا مصدر بيانات لها حاليًا.
//

import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var network: NetworkMonitor
    @EnvironmentObject private var tabRouter: AppTabRouter
    @StateObject private var vm = HomeViewModel()

    // MARK: - مقاسات المرجع (pt بعد التحويل من بكسلات المرجع)

    private let heroHeight: CGFloat = 226      // 490px
    private let pagePad: CGFloat = 18          // 38px
    private let cardGap: CGFloat = 9           // ~20px

    /// ألوان البلاطات الملوّنة في المرجع (غير موجودة في الهوية — محلية لهذه الشاشة)
    private let refBlue = Color(red: 0.36, green: 0.62, blue: 0.98)
    private let refPurple = Color(red: 0.67, green: 0.45, blue: 0.95)
    private let chipText = Color(red: 0.24, green: 0.15, blue: 0.03)

    var body: some View {
        ScrollView {
            VStack(spacing: cardGap) {
                heroSection

                VStack(spacing: cardGap) {
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
                .padding(.horizontal, pagePad)
            }
        }
        .refreshable { await vm.load(session: session, force: true) }
        // المرجع مرسوم على مستوى بصري مطلق — تثبيت المواضع بحاوية LTR صريحة
        // (النصوص العربية تُشكَّل بشكل صحيح داخل كل Text على حدة).
        .environment(\.layoutDirection, .leftToRight)
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

    // MARK: - Hero (إسعاف الرياض — برج المملكة وسط / إسعاف يمين)

    private var heroSection: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                Image("home_hero")
                    .resizable()
                    .scaledToFill()
                    .frame(width: proxy.size.width, height: heroHeight)
                    .clipped()
                // تدرج يذيب الصورة في خلفية التطبيق أسفلًا ويضمن وضوح النص
                LinearGradient(colors: [EMSTheme.Colors.navy.opacity(0.55),
                                        EMSTheme.Colors.navy.opacity(0.05),
                                        EMSTheme.Colors.navy.opacity(0.55),
                                        EMSTheme.Colors.navy],
                               startPoint: .top, endPoint: .bottom)

                VStack(alignment: .leading, spacing: 0) {
                    // الصف العلوي: أفاتار + تحية يسارًا / إشعارات يمينًا
                    HStack(alignment: .top, spacing: 10) {
                        heroAvatar
                        VStack(alignment: .leading, spacing: 2) {
                            Text(vm.greeting)
                                .font(.system(size: 13))
                                .foregroundStyle(Color.white.opacity(0.85))
                            Text(displayName)
                                .font(.system(size: 17, weight: .bold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                            Text("مستعد ليوم جديد من العطاء 👋")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.white.opacity(0.75))
                        }
                        Spacer()
                        if session.permissions.canAccessEmployeePortal {
                            Button { tabRouter.selected = .notifications } label: {
                                Image(systemName: "bell")
                                    .font(.system(size: 13))
                                    .foregroundStyle(.white)
                                    .frame(width: 35, height: 35)
                                    .background(Color.black.opacity(0.35))
                                    .clipShape(Circle())
                                    .overlay(alignment: .topTrailing) {
                                        if vm.unreadCount > 0 {
                                            Circle()
                                                .fill(EMSTheme.Colors.danger)
                                                .frame(width: 9, height: 9)
                                                .offset(x: -2, y: 2)
                                        }
                                    }
                            }
                            .accessibilityLabel("الإشعارات")
                        }
                    }

                    Spacer()

                    // كتلة العنوان أسفل اليسار: شريط teal ثم العنوان ثم الوصف
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(EMSTheme.Colors.teal)
                        .frame(width: 30, height: 3.5)
                        .padding(.bottom, 6)
                    Text("معاً لسلامة مجتمعنا")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.bottom, 4)
                    Text("جاهزون .. لنكون بالقرب دائماً")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.white.opacity(0.8))
                }
                .padding(.horizontal, pagePad)
                .padding(.top, proxy.safeAreaInsets.top + 10)
                .padding(.bottom, 10)
            }
        }
        .frame(height: heroHeight)
        .ignoresSafeArea(edges: .top)
    }

    /// صورة الموظف — حرف اسمه حتى يوفر الخادم avatar_url (نفس fallback البلوت).
    private var heroAvatar: some View {
        Text(String(displayName.prefix(1)))
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 42, height: 42)
            .background(EMSTheme.Colors.navySoft.opacity(0.85))
            .clipShape(Circle())
            .overlay(Circle().stroke(EMSTheme.Colors.teal, lineWidth: 1.5))
            // نقطة الاتصال الخضراء أسفل يمين الأفاتار كما في المرجع
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(EMSTheme.Colors.emerald)
                    .frame(width: 9, height: 9)
                    .overlay(Circle().stroke(EMSTheme.Colors.navy, lineWidth: 2))
            }
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
            // حشوات المرجع لهذه البطاقة أضيق من EMSCard الموحّدة (أعلى 7 / أسفل 6)
            VStack(spacing: 5) {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(EMSTheme.Colors.emerald)
                                    .frame(width: 9, height: 9)
                                Text("الوضع التشغيلي الآن")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundStyle(.white)
                            }
                            Text(pulseSubtitle(pulse))
                                .font(.system(size: 11))
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                        if let rate = pulse.readinessRate {
                            readinessGauge(rate)
                        }
                    }
                    // ترتيب المرجع يسار→يمين: خارج الخدمة / تحتاج متابعة / الفرق / المركبات
                    HStack(spacing: 10) {
                        opsTile(value: pulse.outOfServiceVehicles, total: nil,
                                label: "خارج الخدمة", icon: "wrench.fill", color: EMSTheme.Colors.danger)
                        opsTile(value: pulse.breakdownVehicles, total: nil,
                                label: "تحتاج متابعة", icon: "exclamationmark.triangle.fill", color: EMSTheme.Colors.warning)
                        opsTile(value: pulse.readyTeams, total: pulse.requiredTeams,
                                label: "الفرق العاملة", icon: "person.3.fill", color: refBlue)
                        opsTile(value: pulse.activeVehicles, total: vehiclesTotal(pulse),
                                label: "المركبات الجاهزة", icon: "cross.case.fill", color: EMSTheme.Colors.emerald)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 7)
                .padding(.bottom, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(EMSTheme.Colors.card)
                .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
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

    /// عدّاد الجاهزية الدائري — نسبة الخادم كما هي (70pt في المرجع).
    private func readinessGauge(_ rate: Int) -> some View {
        ZStack {
            Circle()
                .stroke(EMSTheme.Colors.navySoft, lineWidth: 6.5)
            Circle()
                .trim(from: 0, to: CGFloat(max(0, min(100, rate))) / 100)
                .stroke(EMSTheme.Colors.teal, style: StrokeStyle(lineWidth: 6.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text(verbatim: "\(rate)%")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                Text("الجاهزية")
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .frame(width: 70, height: 70)
        .accessibilityElement(children: .combine)
    }

    /// بلاطة مؤشر تشغيلي: خلفية ملوّنة شفافة + أيقونة يسارًا + رقم وتسمية يمينًا.
    private func opsTile(value: Int?, total: Int?, label: String, icon: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(color)
            Spacer(minLength: 2)
            VStack(alignment: .trailing, spacing: 1) {
                Text(value.map(String.init) ?? "—")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.white)
                Text(label)
                    .font(.system(size: 9.5))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let total {
                    Text("من \(total)")
                        .font(.system(size: 9))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .frame(height: 86)
        .background(color.opacity(0.13))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    // MARK: - مناوبتك القادمة (من profile/schedule الفعلية)

    private var nextShiftCard: some View {
        // حشوات المرجع لهذه البطاقة: أعلى 6 / أسفل 14 (وليست EMSCard الموحّدة)
        VStack(alignment: .leading, spacing: 4) {
                // الترويسة: أيقونة تقويم teal + العنوان يسارًا / زر الانتقال يمينًا
                HStack(spacing: 8) {
                    Image(systemName: "calendar")
                        .font(.system(size: 9))
                        .foregroundStyle(EMSTheme.Colors.teal)
                        .frame(width: 17, height: 17)
                        .background(EMSTheme.Colors.teal.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                    Text(vm.nextShift?.isOngoing == true ? "مناوبتك الحالية" : "مناوبتك القادمة")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                    Spacer()
                    Button { tabRouter.selected = .schedule } label: {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                            .frame(width: 25, height: 25)
                            .background(EMSTheme.Colors.navySoft)
                            .clipShape(Circle())
                    }
                    .accessibilityLabel("فتح مناوباتي")
                }

                if let ns = vm.nextShift {
                    Text(vm.arabicDateLabel(ns.date))
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.bottom, 2)

                    HStack(alignment: .top, spacing: 10) {
                        // التفاصيل يسارًا
                        VStack(alignment: .leading, spacing: 8) {
                            if let shift = ns.shiftName {
                                shiftChip(shift)
                            }
                            if let start = ns.start, let end = ns.end {
                                HStack(spacing: 6) {
                                    Image(systemName: "clock")
                                        .font(.system(size: 11))
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                    Text("\(timeLabel(start)) – \(timeLabel(end))")
                                        .font(.system(size: 13).monospacedDigit())
                                        .foregroundStyle(.white)
                                }
                            }
                            HStack(spacing: 18) {
                                if let center = ns.center {
                                    iconLabelValue(icon: "mappin.circle.fill", label: "المركز", value: center)
                                }
                                if let team = ns.teamName {
                                    iconLabelValue(icon: "person.2.fill", label: "الفريق", value: team)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        // فاصل عمودي ثم العد التنازلي يمينًا (أرقام مكشوفة كما في المرجع)
                        Rectangle()
                            .fill(EMSTheme.Colors.divider)
                            .frame(width: 1, height: 64)
                        countdownColumn(ns)
                    }
                } else {
                    Text("لا توجد مناوبة قادمة مسجلة في جدول هذا الشهر")
                        .font(.subheadline)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    /// شريحة الوردية الذهبية (صباحية ☀️ في المرجع — الأيقونة تتبع الاسم الفعلي).
    private func shiftChip(_ shift: String) -> some View {
        let icon = shift.contains("صباح") ? "sun.max.fill"
                 : shift.contains("ليل") ? "moon.stars.fill" : "clock.fill"
        return HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10))
            Text(shift)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(chipText)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(EMSTheme.Colors.warning)
        .clipShape(Capsule())
    }

    private func iconLabelValue(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(EMSTheme.Colors.teal)
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                Text(value)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
    }

    /// العد التنازلي للمناوبة — يوم/ساعة/دقيقة من وقت البدء الفعلي (أو النهاية
    /// أثناء المناوبة الجارية). أيام الجدول المستقبلية بلا أوقات تعرض الأيام فقط.
    @ViewBuilder
    private func countdownColumn(_ ns: HomeViewModel.NextShiftInfo) -> some View {
        VStack(spacing: 5) {
            Text(ns.isOngoing ? "متبقي على نهايتها" : "متبقي على المناوبة")
                .font(.system(size: 9))
                .foregroundStyle(EMSTheme.Colors.textMuted)
            if ns.start != nil || ns.end != nil {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    let remaining = countdownParts(ns, now: context.date)
                    HStack(spacing: 12) {
                        countdownNumber(remaining.days, "يوم")
                        countdownNumber(remaining.hours, "ساعة")
                        countdownNumber(remaining.minutes, "دقيقة")
                    }
                }
            } else {
                // يوم مستقبلي بلا وقت بدء من الخادم — الأيام فقط (لا أرقام مفترضة)
                let days = riyadhDaysUntil(ns.date)
                countdownNumber(days, days == 1 ? "يوم" : "أيام")
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

    /// رقم العد التنازلي مكشوف بلا صندوق — teal غامق كما في المرجع.
    private func countdownNumber(_ value: Int, _ label: String) -> some View {
        VStack(spacing: 1) {
            Text(String(format: "%02d", value))
                .font(.system(size: 20, weight: .bold).monospacedDigit())
                .foregroundStyle(EMSTheme.Colors.teal)
            Text(label)
                .font(.system(size: 8.5))
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
    }

    private func timeLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    // MARK: - الإجراءات السريعة (ترتيب المرجع يسار→يمين: محادثات/طلباتي/جدول/عمليات)

    enum Destination: Hashable {
        case shift, mates, completion, incidents, vehicle, inventory, changes, assignments, operations, requests
    }

    private var quickActionsRow: some View {
        HStack(spacing: 10) {
            quickTile("المحادثات", icon: "text.bubble.fill", color: refPurple) {
                tabRouter.selected = .chat
            }
            if session.permissions.canAccessEmployeePortal {
                NavigationLink(value: Destination.requests) {
                    quickTileLabel("طلباتي", icon: "doc.text.fill", color: EMSTheme.Colors.danger)
                }
                .buttonStyle(.plain)
            }
            if session.permissions.canAccessEmployeePortal {
                quickTile("الجدول", icon: "calendar", color: refBlue) {
                    tabRouter.selected = .schedule
                }
            } else if session.permissions.canViewSchedules {
                quickTile("الجداول", icon: "calendar.badge.clock", color: refBlue) {
                    tabRouter.selected = .scheduleOps
                }
            }
            if session.permissions.canAccessOperations {
                quickTile("العمليات", icon: "point.3.connected.trianglepath.dotted", color: EMSTheme.Colors.emerald) {
                    tabRouter.selected = .operations
                }
            }
        }
    }

    private func quickTile(_ title: String, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) { quickTileLabel(title, icon: icon, color: color) }
            .buttonStyle(.plain)
    }

    /// بلاطة إجراء سريع: خلفية ملوّنة شفافة + أيقونة في دائرة + تسمية (55pt في المرجع).
    private func quickTileLabel(_ title: String, icon: String, color: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(color)
                .frame(width: 26, height: 26)
                .background(color.opacity(0.22))
                .clipShape(Circle())
            Text(title)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 55)
        .background(color.opacity(0.13))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - آخر الأحداث (إشعارات فعلية)

    @ViewBuilder
    private var latestEventsCard: some View {
        if !vm.recentNotifications.isEmpty {
            EMSCard {
                VStack(alignment: .leading, spacing: 12) {
                    // الترويسة: «عرض الكل» يسارًا / العنوان يمينًا (كما في المرجع)
                    HStack {
                        if session.permissions.canAccessEmployeePortal {
                            Button("عرض الكل") { tabRouter.selected = .notifications }
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(EMSTheme.Colors.navySoft)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        Spacer()
                        HStack(spacing: 6) {
                            Image(systemName: "list.bullet")
                                .font(.system(size: 12))
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text("آخر الأحداث")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    }
                    ForEach(vm.recentNotifications) { item in
                        eventRow(item)
                    }
                }
            }
        }
    }

    /// صف حدث: نقطة+وقت يسارًا / نص / مربع أيقونة يمينًا. لون النوع مستنتج
    /// من كلمات الرسالة (mapping عرضي فقط — الخادم يرسل نصًا بلا نوع).
    private func eventRow(_ item: PortalNotificationsDTO.Item) -> some View {
        let style = eventStyle(item.message)
        return HStack(spacing: 10) {
            HStack(spacing: 4) {
                Circle()
                    .fill(style.color)
                    .frame(width: 6.5, height: 6.5)
                if let time = vm.notificationTime(item.createdAt) {
                    Text(time)
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
            Spacer(minLength: 4)
            Text(item.message)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
            Image(systemName: style.icon)
                .font(.system(size: 15))
                .foregroundStyle(style.color)
                .frame(width: 40, height: 40)
                .background(style.color.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private func eventStyle(_ message: String) -> (icon: String, color: Color) {
        if message.contains("بلاغ") || message.contains("حادث") {
            return ("car.fill", EMSTheme.Colors.danger)
        }
        if message.contains("مركبة") || message.contains("صيانة") {
            return ("wrench.fill", EMSTheme.Colors.warning)
        }
        if message.contains("تكميل") || message.contains("حفظ") || message.contains("نموذج") {
            return ("doc.text.fill", EMSTheme.Colors.teal)
        }
        return ("bell.fill", EMSTheme.Colors.teal)
    }
}
