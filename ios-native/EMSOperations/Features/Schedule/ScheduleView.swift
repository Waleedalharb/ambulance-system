//
//  ScheduleView.swift
//  EMSOperations
//
//  «مناوبتي» بالمرجع البصري المعتمد (2026-09-28) — واجهة فقط:
//  بطاقة المناوبة القادمة + عدّاد، إجمالي الساعات/الأيام، تقويم نافذة
//  أسبوعين (السبت يمينًا)، المناوبات القادمة، وإحصاءات الشهر.
//  كل الأرقام من بيانات الخادم (/api/my/schedule × /api/shift-codes) —
//  لا منطق جديد ولا مصادر موازية. Deep Link «تغيير جدول» محفوظ كما هو.
//
//  الاتجاه (توجيه المالك 2026-09-28): الشاشة RTL طبيعية بالكامل —
//  ترتيب العناصر والمحاذاة والأسهم عربية، مع بقاء الأرقام والتواريخ
//  والأوقات لاتينية مقروءة (verbatim / سلاسل رقمية لا تنقلب).
//  ترتيب أبناء كل HStack مكتوب بترتيب القراءة العربية (الأول = الأيمن).
//

import SwiftUI

struct ScheduleView: View {
    @EnvironmentObject private var deepLinks: DeepLinkRouter
    @StateObject private var vm = ScheduleViewModel()

    // ألوان المرجع المحلية (أزرق/بنفسجي) — بقية الألوان من EMSTheme
    private let refBlue = Color(red: 0.36, green: 0.62, blue: 0.98)
    private let refPurple = Color(red: 0.67, green: 0.45, blue: 0.95)

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)
    // ترويسة الأسبوع بترتيب القراءة العربية: السبت يمينًا … الجمعة يسارًا
    private let weekdayHeaders = ["سبت", "أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة"]

    var body: some View {
        ScrollView {
            VStack(spacing: 9) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 5)
                    EMSSkeletonCard(lines: 4)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    nextShiftCard
                    statsRow
                    if let cov = vm.coverage, cov != "complete" {
                        coverageNotice(cov)
                    }
                    calendarCard
                    upcomingCard
                    // «الجدول المرن» (معتمد 2026-10-08) — قسم مستقل بـVM خاص،
                    // أسفل «المناوبات القادمة» مباشرة؛ لا يمس أقسام الجدول الرسمي.
                    SupplementarySectionView()
                    monthStatsSection
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 6)
            .padding(.bottom, 12)
        }
        .refreshable { await vm.load() }
        .emsPage("مناوبتي")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // navigationBarLeading تحت RTL العام = يمين الشاشة (كما في المرجع)
            ToolbarItem(placement: .navigationBarLeading) {
                NavigationLink {
                    ScheduleChangesView()
                } label: {
                    Image(systemName: "calendar")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                        .frame(width: 32, height: 32)
                        .background(EMSTheme.Colors.navySoft)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
            }
        }
        .task { await vm.load() }
        // Deep Link من إشعار «تغيير جدول» (قسم 18) — محفوظ كما هو
        .navigationDestination(isPresented: $deepLinks.requestScheduleChanges) {
            ScheduleChangesView()
        }
    }

    // MARK: - بطاقة المناوبة القادمة

    private var nextShiftCard: some View {
        ZStack {
            RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous)
                .fill(EMSTheme.Colors.card)
            if let next = vm.nextShift {
                HStack(spacing: 0) {
                    // الصورة يمين البطاقة (الأول في الترتيب = الأيمن تحت RTL).
                    // نفس أصل home_hero المعتمد — بلا صورة جديدة وبلا تعديل على
                    // الأصل. الارتفاع هو البُعد الحاكم (155pt من 1184px) فلا قصّ
                    // علوي/سفلي إطلاقًا؛ الفيض أفقي فقط. النافذة المطلوبة هي يمين
                    // المشهد (برج المملكة + الإسعاف كاملًا) — ولأن alignment يتبع
                    // اتجاه الواجهة (trailing = يسار بصريًا تحت RTL!) نثبّت LTR
                    // على الصورة وحدها ليبقى .trailing = اليمين البصري دائمًا.
                    Image("home_hero")
                        .resizable()
                        .scaledToFill()
                        .frame(width: 150, height: 155, alignment: .trailing)
                        .clipped()
                        .environment(\.layoutDirection, .leftToRight)
                        .overlay(countdownPanel(next))
                    nextShiftContent(next)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                HStack(spacing: 10) {
                    Image(systemName: "calendar.badge.exclamationmark")
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Text("لا توجد مناوبة قادمة مسجلة في جدول هذا الشهر.")
                        .font(.subheadline)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: 155)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    private func nextShiftContent(_ day: ScheduleDTO.Day) -> some View {
        // alignment: .leading تحت RTL = محاذاة يمين عربية طبيعية
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: "calendar")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.teal)
                    .frame(width: 26, height: 26)
                    .background(EMSTheme.Colors.teal.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text("مناوبتك القادمة")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Image(systemName: "chevron.left")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.teal)
            }
            HStack(spacing: 6) {
                Text(verbatim: vm.dashedDate(day))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                Text(vm.weekdayName(day.date))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                Image(systemName: vm.kind(for: day) == .night ? "moon.fill" : "sun.max.fill")
                    .font(.caption)
                    .foregroundStyle(vm.kind(for: day) == .night ? refBlue : EMSTheme.Colors.warning)
            }
            if let t = vm.times(for: day) {
                // البداية يمينًا ثم الانتهاء يسارًا — ترتيب القراءة العربية (كالمرجع)
                HStack(spacing: 7) {
                    timeTile(time: t.start, label: "وقت البداية", icon: "clock.fill", tint: EMSTheme.Colors.emerald)
                    timeTile(time: t.end, label: "وقت الانتهاء", icon: "clock.fill", tint: EMSTheme.Colors.danger)
                }
            }
            // الفريق يمينًا ثم المركز يسارًا — كما في المرجع
            HStack(spacing: 7) {
                placeTile(text: day.teamName ?? "—", label: "الفريق", icon: "person.2.fill", tint: refBlue)
                placeTile(text: day.center ?? "—", label: "المركز", icon: "mappin.circle.fill", tint: EMSTheme.Colors.warning)
            }
        }
    }

    private func timeTile(time: String, label: String, icon: String, tint: Color) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: time)
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(.white)
                Text(label)
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(EMSTheme.Colors.navySoft)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func placeTile(text: String, label: String, icon: String, tint: Color) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(text)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(label)
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(EMSTheme.Colors.navySoft)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    /// لوحة العدّاد teal الشفافة فوق الصورة: «بعد N يوم · H ساعات» (بيانات فعلية)
    private func countdownPanel(_ day: ScheduleDTO.Day) -> some View {
        let parts = countdownParts(for: day)
        return VStack(spacing: 2) {
            Text("بعد")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white.opacity(0.9))
            Text(verbatim: "\(parts.days)")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(.white)
            Text(dayWord(parts.days))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white.opacity(0.9))
            if parts.hours > 0 {
                Text(verbatim: "\(parts.hours)")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                Text("ساعات")
                    .font(.system(size: 9))
                    .foregroundStyle(.white.opacity(0.9))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(EMSTheme.Colors.teal.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(10)
    }

    private func countdownParts(for day: ScheduleDTO.Day) -> (days: Int, hours: Int) {
        let cal = vm.riyadhCalendar
        guard let date = vm.parseDay(day.date) else { return (0, 0) }
        var start = date
        if let t = vm.times(for: day) {
            let p = t.start.split(separator: ":").compactMap { Int($0) }
            if p.count == 2 {
                start = cal.date(bySettingHour: p[0], minute: p[1], second: 0, of: date) ?? date
            }
        }
        let totalHours = max(0, Int(start.timeIntervalSince(Date()) / 3600))
        return (totalHours / 24, totalHours % 24)
    }

    private func dayWord(_ n: Int) -> String {
        if n == 1 { return "يوم" }
        if n == 2 { return "يومان" }
        if (3...10).contains(n) { return "أيام" }
        return "يوم"
    }

    // MARK: - بطاقتا الإحصاء (ساعات الشهر / أيام المناوبات)

    private var statsRow: some View {
        // المرجع: «إجمالي أيام المناوبات» يمينًا · «إجمالي ساعات الشهر» يسارًا
        HStack(spacing: 9) {
            statCard(
                title: "إجمالي أيام المناوبات",
                value: "\(vm.totalShiftDays)",
                unit: "يوم",
                subtitle: vm.monthTitle,
                icon: "calendar.badge.clock",
                chartIcon: "chart.line.uptrend.xyaxis",
                tint: EMSTheme.Colors.teal
            )
            statCard(
                title: "إجمالي ساعات الشهر",
                value: hoursText(vm.monthHours),
                unit: "ساعة",
                subtitle: vm.monthTitle,
                icon: "hourglass",
                chartIcon: "chart.bar.fill",
                tint: refPurple
            )
        }
    }

    private func statCard(title: String, value: String, unit: String, subtitle: String,
                          icon: String, chartIcon: String, tint: Color) -> some View {
        // الأيقونة يمينًا (أول عنصر RTL) · النص · أيقونة الرسم يسارًا — كالمرجع
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(verbatim: value)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.white)
                    Text(unit)
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
                Text(subtitle)
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            Spacer(minLength: 2)
            Image(systemName: chartIcon)
                .font(.caption)
                .foregroundStyle(tint.opacity(0.8))
        }
        .padding(10)
        .frame(maxWidth: .infinity)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    private func hoursText(_ hours: Double) -> String {
        if hours == hours.rounded() { return "\(Int(hours))" }
        return String(format: "%.1f", hours)
    }

    // MARK: - تنبيه التغطية (يظهر فقط عند عدم اكتمال تغطية الشهر — صدق بيانات)

    private func coverageNotice(_ coverage: String) -> some View {
        HStack(spacing: 8) {
            if coverage == "partial" {
                EMSStatusPill(text: "تغطية جزئية \(vm.coveredDays ?? 0)/\(vm.elapsedDays ?? 0)", tone: .monitor)
            } else {
                EMSStatusPill(text: "لا تتوفر بيانات جدول لهذا الشهر", tone: .monitor)
            }
            Spacer()
        }
    }

    // MARK: - تقويم نافذة الأسبوعين

    private var calendarCard: some View {
        VStack(spacing: 10) {
            // الترويسة (RTL): الأسهم ثم الشهر يمينًا · «اليوم» يسارًا — كالمرجع
            HStack(spacing: 8) {
                Button { Task { await vm.prevMonth() } } label: {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                        .frame(width: 28, height: 28)
                        .background(EMSTheme.Colors.navySoft)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                Button { Task { await vm.nextMonth() } } label: {
                    Image(systemName: "chevron.left")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                        .frame(width: 28, height: 28)
                        .background(EMSTheme.Colors.navySoft)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                Text(vm.monthTitle)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                Spacer()
                Button { Task { await vm.goToday() } } label: {
                    Text("اليوم")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(EMSTheme.Colors.navySoft)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            // ترويسة الأسبوع (السبت يمينًا)
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(weekdayHeaders, id: \.self) { w in
                    Text(w)
                        .font(.system(size: 9))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(windowCells(), id: \.self) { cell in
                    switch cell {
                    case .blank:
                        Color.clear.frame(height: 42)
                    case .day(let dateStr, let dayNum, let isToday):
                        dayCell(dateStr: dateStr, dayNum: dayNum, isToday: isToday)
                    }
                }
            }
            // وسيلة الإيضاح (RTL: صباح يمينًا … مهمة أخرى يسارًا)
            HStack(spacing: 12) {
                Spacer()
                legendDot("صباح", color: EMSTheme.Colors.emerald)
                legendDot("ليل", color: refBlue)
                legendDot("إجازة", color: EMSTheme.Colors.warning)
                legendDot("مهمة أخرى", color: refPurple)
                Spacer()
            }
            .padding(.top, 2)
        }
        .padding(12)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    private func legendDot(_ label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
    }

    private enum Cell: Hashable {
        case blank(UUID = UUID())
        case day(String, Int, Bool)
    }

    /// خلايا النافذة — صفّان فقط كما في المرجع (الأسبوع الحالي + التالي).
    /// windowDates مرتبة سبت→جمعة، وتحت RTL تنسيق الشبكة يمين→يسار طبيعيًا
    /// فيقع السبت يمينًا دون أي عكس يدوي.
    private func windowCells() -> [Cell] {
        let cal = vm.riyadhCalendar
        let dates = vm.windowDates
        guard dates.count == 14 else { return [] }
        var cells: [Cell] = []
        for week in 0..<2 {
            let slice = Array(dates[(week * 7)..<(week * 7 + 7)])
            for date in slice {
                let ds = Self.cellFormatter.string(from: date)
                cells.append(.day(ds, cal.component(.day, from: date), ds == vm.todayStr))
            }
        }
        return cells
    }

    private static let cellFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private func dayCell(dateStr: String, dayNum: Int, isToday: Bool) -> some View {
        let info = vm.day(for: dateStr)
        let kind = info.map { vm.kind(for: $0) }
        return VStack(spacing: 3) {
            Text(verbatim: "\(dayNum)")
                .font(.subheadline.weight(isToday ? .bold : .regular))
                .foregroundStyle(isToday ? EMSTheme.Colors.navy : .white)
            Circle()
                .fill(kind.map { dotColor($0) } ?? Color.clear)
                .frame(width: 5, height: 5)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 42)
        .background(isToday ? EMSTheme.Colors.teal : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityLabel("\(dateStr) \(info?.shiftName ?? "")")
    }

    private func dotColor(_ kind: ScheduleViewModel.ShiftKind) -> Color {
        switch kind {
        case .morning: return EMSTheme.Colors.emerald
        case .night: return refBlue
        case .vacation: return EMSTheme.Colors.warning
        case .other: return refPurple
        }
    }

    // MARK: - المناوبات القادمة

    private var upcomingCard: some View {
        let rows = Array(vm.upcomingShifts.prefix(4))
        return VStack(spacing: 8) {
            // الترويسة (RTL): العنوان يمينًا · «عرض الكل» يسارًا — كالمرجع
            HStack {
                Text("المناوبات القادمة")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                Spacer()
                NavigationLink {
                    UpcomingShiftsListView()
                } label: {
                    HStack(spacing: 3) {
                        Text("عرض الكل")
                            .font(.caption.weight(.semibold))
                        Image(systemName: "chevron.left")
                            .font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(EMSTheme.Colors.teal)
                }
                .buttonStyle(.plain)
            }
            if rows.isEmpty {
                Text("لا توجد مناوبات قادمة مسجلة.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 10)
            } else {
                VStack(spacing: 0) {
                    ForEach(rows, id: \.date) { day in
                        upcomingRow(day)
                        if day.date != rows.last?.date {
                            Divider().background(EMSTheme.Colors.divider)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    /// صف مناوبة (RTL): الفريق/المركز يمينًا · فاصل · اليوم والتاريخ والوقت ·
    /// «بعد N» يسارًا · سهم التقدم أقصى اليسار.
    private func upcomingRow(_ day: ScheduleDTO.Day) -> some View {
        HStack(spacing: 10) {
            // يمينًا: الفريق والمركز (الأيقونة عند الحافة اليمنى)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(refBlue)
                    Text(day.teamName ?? "—")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
                HStack(spacing: 4) {
                    Image(systemName: "mappin.circle.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(refBlue)
                    Text(day.center ?? "—")
                        .font(.system(size: 10))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .lineLimit(1)
                }
            }
            Rectangle()
                .fill(EMSTheme.Colors.divider)
                .frame(width: 1, height: 30)
            // وسطًا: اليوم والتاريخ ثم الوقت
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text("\(vm.weekdayName(day.date)) \(vm.dashedDate(day))")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                    Image(systemName: vm.kind(for: day) == .night ? "moon.fill" : "sun.max.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(vm.kind(for: day) == .night ? refBlue : EMSTheme.Colors.warning)
                }
                if let t = vm.times(for: day) {
                    Text(verbatim: "\(t.start) - \(t.end)")
                        .font(.system(size: 10).monospacedDigit())
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // يسارًا: العدّ التنازلي
            VStack(spacing: 1) {
                Text("بعد")
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                Text(dayWord(vm.daysUntil(day)))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.teal)
            }
            Image(systemName: "chevron.left")
                .font(.caption2.weight(.bold))
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
        .padding(.vertical, 8)
    }

    // MARK: - إحصاءات الشهر

    private var monthStatsSection: some View {
        VStack(spacing: 8) {
            HStack {
                Text("إحصاءات الشهر")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                Spacer()
            }
            // المرجع: «إجمالي الأيام» يمينًا … «إجازات» يسارًا
            HStack(spacing: 8) {
                monthStatTile(value: vm.totalShiftDays, label: "إجمالي الأيام", icon: "calendar", tint: EMSTheme.Colors.teal)
                monthStatTile(value: vm.morningCount, label: "مناوبات صباحية", icon: "sun.max.fill", tint: EMSTheme.Colors.warning)
                monthStatTile(value: vm.nightCount, label: "مناوبات ليلية", icon: "moon.fill", tint: refBlue)
                monthStatTile(value: vm.vacationCount, label: "إجازات", icon: "airplane", tint: refPurple)
            }
        }
    }

    private func monthStatTile(value: Int, label: String, icon: String, tint: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(tint)
            Text(verbatim: "\(value)")
                .font(.headline.weight(.bold))
                .foregroundStyle(.white)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(tint.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - قائمة «عرض الكل»: كل المناوبات القادمة (نفس بيانات الشاشة — عرض فقط)

private struct UpcomingShiftsListView: View {
    @StateObject private var vm = ScheduleViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                switch vm.state {
                case .loading:
                    // حالة تحميل صادقة بدل بطاقة فارغة منهارة (مساحة سوداء)
                    EMSSkeletonCard(lines: 4)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if vm.upcomingShifts.isEmpty {
                        Text("لا توجد مناوبات قادمة مسجلة.")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                            .padding(.vertical, 20)
                    } else {
                        ForEach(vm.upcomingShifts, id: \.date) { day in
                        // RTL: الفريق/المركز يمينًا · التاريخ والوقت · «بعد N» يسارًا
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(day.teamName ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                Text(day.center ?? "—")
                                    .font(.system(size: 10))
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                    .lineLimit(1)
                            }
                            Spacer()
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(vm.weekdayName(day.date)) \(vm.dashedDate(day))")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.white)
                                    .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                                if let t = vm.times(for: day) {
                                    Text(verbatim: "\(t.start) - \(t.end)")
                                        .font(.system(size: 10).monospacedDigit())
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            VStack(spacing: 1) {
                                Text("بعد")
                                    .font(.system(size: 9))
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                Text("\(vm.daysUntil(day))")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(EMSTheme.Colors.teal)
                                    .environment(\.locale, Locale(identifier: "en_US_POSIX"))
                            }
                            .frame(width: 40)
                        }
                        .padding(.vertical, 9)
                        if day.date != vm.upcomingShifts.last?.date {
                            Divider().background(EMSTheme.Colors.divider)
                        }
                    }
                    }
                }
            }
            .padding(12)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("المناوبات القادمة")
        .task { await vm.load() }
    }
}
