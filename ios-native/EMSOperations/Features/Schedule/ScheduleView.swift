//
//  ScheduleView.swift
//  EMSOperations
//
//  «الجدول» (قسم 13): شبكة شهرية Native — تنقل سابق/التالي/اليوم،
//  تمييز اليوم والمناوبات. Deep Link «تغيير جدول» يفتح سجل التغييرات.
//

import SwiftUI

struct ScheduleView: View {
    @EnvironmentObject private var deepLinks: DeepLinkRouter
    @StateObject private var vm = ScheduleViewModel()

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 7)
    private let weekdays = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"]

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                monthNavigator
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 5)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if let s = vm.schedule {
                        coverageLine(s)
                        calendarGrid(s)
                        NavigationLink {
                            ScheduleChangesView()
                        } label: {
                            EMSCard {
                                HStack {
                                    Image(systemName: "arrow.triangle.2.circlepath")
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                    Text("سجل تغييرات جدولي")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.white)
                                    Spacer()
                                    Image(systemName: "chevron.left")
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("الجدول")
        .task { await vm.load() }
        // Deep Link من إشعار «تغيير جدول» (قسم 18)
        .navigationDestination(isPresented: $deepLinks.requestScheduleChanges) {
            ScheduleChangesView()
        }
    }

    // MARK: - التنقل بين الأشهر

    private var monthNavigator: some View {
        EMSCard {
            HStack {
                Button { Task { await vm.prevMonth() } } label: {
                    Image(systemName: "chevron.right").frame(width: 36, height: 36)
                }
                Spacer()
                VStack(spacing: 2) {
                    Text("\(monthName(vm.month)) \(String(vm.year))")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                    Button("اليوم") { Task { await vm.goToday() } }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
                Spacer()
                Button { Task { await vm.nextMonth() } } label: {
                    Image(systemName: "chevron.left").frame(width: 36, height: 36)
                }
            }
            .foregroundStyle(EMSTheme.Colors.textSecondary)
        }
    }

    private func coverageLine(_ s: ScheduleDTO) -> some View {
        HStack(spacing: 8) {
            if s.coverage == "partial" {
                EMSStatusPill(text: "تغطية جزئية \(s.coveredDays ?? 0)/\(s.elapsedDays ?? 0)", tone: .monitor)
            } else if s.coverage == "complete" {
                EMSStatusPill(text: "تغطية مكتملة", tone: .normal)
            } else if s.coverage == "none" {
                // نفس لفظ الويب عند غياب بيانات الشهر
                EMSStatusPill(text: "لا تتوفر بيانات جدول لهذا الشهر", tone: .monitor)
            }
            Spacer()
            if let upd = s.lastUpdate {
                Text("آخر تحديث: \(upd)")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
    }

    // MARK: - الشبكة

    private func calendarGrid(_ s: ScheduleDTO) -> some View {
        // تسامحًا مع أي تكرار يوم من الخادم — يُحتفظ بأول إدخال بدل الانهيار
        let daysByDate = Dictionary(
            s.days.compactMap { d -> (String, ScheduleDTO.Day)? in
                guard let date = d.date else { return nil }
                return (date, d)
            },
            uniquingKeysWith: { first, _ in first })
        let cells = monthCells(schedule: s)

        return EMSCard {
            VStack(spacing: 8) {
                LazyVGrid(columns: columns, spacing: 6) {
                    ForEach(weekdays, id: \.self) { w in
                        Text(w)
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                            .frame(maxWidth: .infinity)
                    }
                }
                LazyVGrid(columns: columns, spacing: 6) {
                    ForEach(cells, id: \.self) { cell in
                        switch cell {
                        case .blank:
                            Color.clear.frame(height: 64)
                        case .day(let dateStr, let dayNum, let isToday):
                            dayCell(dateStr: dateStr, dayNum: dayNum, isToday: isToday,
                                    info: daysByDate[dateStr])
                        }
                    }
                }
            }
        }
    }

    private enum Cell: Hashable {
        case blank(UUID = UUID())
        case day(String, Int, Bool)
    }

    private func dayCell(dateStr: String, dayNum: Int, isToday: Bool, info: ScheduleDTO.Day?) -> some View {
        VStack(spacing: 2) {
            Text("\(dayNum)")
                .font(.caption.weight(isToday ? .bold : .regular))
                .foregroundStyle(isToday ? EMSTheme.Colors.navy : .white)
            if let code = info?.shiftCode {
                Text(code)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(isToday ? EMSTheme.Colors.navy : EMSTheme.Colors.teal)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            // الوردية بالاسم الرسمي من قاموس الرموز (دوام 12 صباحاً…) — مواصفة المالك
            if let name = info?.shiftName, name != info?.shiftCode {
                Text(name)
                    .font(.system(size: 8))
                    .foregroundStyle(isToday ? EMSTheme.Colors.navy.opacity(0.8) : EMSTheme.Colors.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            // الفريق · المركز عند توفره في بيانات الجدولة
            let place = [info?.teamName, info?.center].compactMap { $0 }.filter { !$0.isEmpty }
                .reduce(into: [String]()) { acc, v in if !acc.contains(v) { acc.append(v) } }
                .joined(separator: " · ")
            if !place.isEmpty {
                Text(place)
                    .font(.system(size: 8))
                    .foregroundStyle(isToday ? EMSTheme.Colors.navy.opacity(0.8) : EMSTheme.Colors.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 64)
        .background(isToday ? EMSTheme.Colors.teal : (info?.shiftCode != nil ? Color.white.opacity(0.07) : Color.clear))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityLabel("\(dateStr) \(info?.shiftName ?? "")")
    }

    /// خلايا الشهر: فراغات المحاذاة (الأحد أولًا) ثم الأيام.
    private func monthCells(schedule s: ScheduleDTO) -> [Cell] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        var comps = DateComponents(); comps.year = s.year; comps.month = s.month; comps.day = 1
        guard let first = cal.date(from: comps),
              let range = cal.range(of: .day, in: .month, for: first) else { return [] }
        // weekday: 1=أحد … 7=سبت — الأحد أول العمود
        let lead = cal.component(.weekday, from: first) - 1
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = cal.timeZone
        let todayStr = fmt.string(from: Date())

        var cells: [Cell] = (0..<lead).map { _ in .blank() }
        for d in range {
            var dc = DateComponents(); dc.year = s.year; dc.month = s.month; dc.day = d
            guard let date = cal.date(from: dc) else { continue }
            let ds = fmt.string(from: date)
            cells.append(.day(ds, d, ds == todayStr))
        }
        return cells
    }

    private func monthName(_ m: Int) -> String {
        ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
         "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"][max(0, min(11, m - 1))]
    }
}
