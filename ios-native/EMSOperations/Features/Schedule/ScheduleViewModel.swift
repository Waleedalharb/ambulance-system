//
//  ScheduleViewModel.swift
//  EMSOperations
//
//  «مناوبتي» بالمرجع البصري المعتمد (2026-09-28): نافذة أسبوعين (الأسبوع
//  الحالي + التالي، تبدأ السبت) + رموز المناوبات المعتمدة (/api/shift-codes —
//  GET متاح لأي مستخدم موثّق، server.js:12841) لاشتقاق الأوقات ومدد الساعات
//  للعرض فقط. النافذة قد تعبر الشهر، لذلك تُجلب جداول الأشهر الظاهرة فقط من
//  /api/my/schedule — لا قيم ثابتة ولا مصادر موازية.
//

import Foundation

@MainActor
final class ScheduleViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    /// جداول الأشهر المحمّلة: "yyyy-MM" → الجدول (النافذة قد تغطي شهرين)
    @Published private var months: [String: ScheduleDTO] = [:]
    /// أول يوم (سبت) في نافذة الأسبوعين المعروضة
    @Published var anchor: Date
    /// رموز المناوبات المعتمدة: code → الرمز (الأوقات/الاسم/اللون)
    @Published var codes: [String: ShiftCodesDTO.Code] = [:]

    private let api = APIClient.shared
    private var codesLoaded = false

    /// تصنيف عرضي للمناوبة — يقود لون النقطة والأيقونة في التقويم والقوائم.
    enum ShiftKind {
        case morning, night, vacation, other
    }

    init() {
        anchor = Self.weekStart(of: Date())
    }

    // MARK: - مرجعية الرياض الزمنية

    var riyadhCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        return cal
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let monthKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "yyyy-MM"
        return f
    }()

    /// السبت الذي يبدأ أسبوع التاريخ المعطى (weekday: 1=أحد … 7=سبت).
    static func weekStart(of date: Date) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        let start = cal.startOfDay(for: date)
        let w = cal.component(.weekday, from: start)
        return cal.date(byAdding: .day, value: -(w % 7), to: start) ?? start
    }

    func parseDay(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        return Self.dayFormatter.date(from: String(raw.prefix(10)))
    }

    var todayStr: String { Self.dayFormatter.string(from: Date()) }

    /// أيام النافذة المعروضة: 14 يومًا تبدأ السبت.
    var windowDates: [Date] {
        let cal = riyadhCalendar
        return (0..<14).compactMap { cal.date(byAdding: .day, value: $0, to: anchor) }
    }

    // MARK: - التحميل (الأشهر التي تغطيها النافذة فقط)

    func load() async {
        if months.isEmpty { state = .loading }
        let keys = Array(Set(windowDates.map { Self.monthKeyFormatter.string(from: $0) })).sorted()
        var fetched: [String: ScheduleDTO] = [:]
        var failure: String?
        for key in keys {
            let parts = key.split(separator: "-")
            guard parts.count == 2 else { continue }
            do {
                let dto: ScheduleDTO = try await api.get("/api/my/schedule", query: [
                    "month": String(parts[1]), "year": String(parts[0])
                ])
                fetched[key] = dto
            } catch let e as APIError {
                failure = failure ?? e.userMessage
            } catch {
                failure = failure ?? APIError.unknown.userMessage
            }
        }
        if !fetched.isEmpty {
            months = fetched
            state = .loaded
        } else if let failure,
                  !RefreshFailurePolicy.keepContent(hasContent: !months.isEmpty, message: failure) {
            state = .failed(failure)
        }
        await loadCodesIfNeeded()
    }

    private func loadCodesIfNeeded() async {
        if codesLoaded { return }
        do {
            let res: ShiftCodesDTO = try await api.get("/api/shift-codes")
            var lookup: [String: ShiftCodesDTO.Code] = [:]
            for c in res.codes ?? [] {
                if let code = c.code { lookup[code] = c }
            }
            codes = lookup
            codesLoaded = true
        } catch {
            // فشل الرموز لا يكسر الشاشة — تُعرض الأيام بلا أوقات/ساعات بصدق
        }
    }

    // MARK: - تنقل النافذة (أسبوع للأمام/للخلف — المرجع يعرض أسبوعين)

    func nextMonth() async { shiftWindow(7) }
    func prevMonth() async { shiftWindow(-7) }

    func goToday() async {
        anchor = Self.weekStart(of: Date())
        await load()
    }

    private func shiftWindow(_ days: Int) {
        anchor = riyadhCalendar.date(byAdding: .day, value: days, to: anchor) ?? anchor
        Task { await load() }
    }

    // MARK: - الوصول للأيام

    /// شهر النافذة الرئيسي (شهر يوم السبت الأول) — مرجع الإحصاءات الشهرية.
    private var anchorMonthKey: String { Self.monthKeyFormatter.string(from: anchor) }
    private var anchorSchedule: ScheduleDTO? { months[anchorMonthKey] }

    /// تغطية الشهر الرئيسي (لتنبيه عدم الاكتمال).
    var coverage: String? { anchorSchedule?.coverage }
    var coveredDays: Int? { anchorSchedule?.coveredDays }
    var elapsedDays: Int? { anchorSchedule?.elapsedDays }

    /// كل الأيام المحملة (شهر أو شهرين) مفهرسة بالتاريخ — للتقويم والقوائم.
    var daysByDate: [String: ScheduleDTO.Day] {
        Dictionary(
            months.values.flatMap(\.days).compactMap { d -> (String, ScheduleDTO.Day)? in
                guard let date = d.date else { return nil }
                return (date, d)
            },
            uniquingKeysWith: { first, _ in first })
    }

    func day(for dateStr: String) -> ScheduleDTO.Day? { daysByDate[dateStr] }

    // MARK: - تصنيف المناوبة (اسم الرمز أولًا ثم حرف الرمز — عرض فقط)

    func kind(for day: ScheduleDTO.Day) -> ShiftKind {
        let name = day.shiftName ?? ""
        let code = day.shiftCode ?? ""
        let text = name + " " + code
        if text.contains("إجازة") || text.contains("راحة") { return .vacation }
        if name.contains("ليل") || name.contains("مساء") { return .night }
        if name.contains("صباح") { return .morning }
        // احتياط بحرف الرمز المعتمد: N ليلي · D صباحي · V/WO إجازة
        if code.hasPrefix("V") || code.hasPrefix("WO") { return .vacation }
        if code.hasPrefix("N") || code.hasPrefix("LN") { return .night }
        if code.hasPrefix("D") { return .morning }
        return .other
    }

    // MARK: - أوقات ومدد الرموز (من /api/shift-codes)

    func times(for day: ScheduleDTO.Day) -> (start: String, end: String)? {
        guard let code = day.shiftCode, let c = codes[code],
              let s = c.timeStart, let e = c.timeEnd, !s.isEmpty, !e.isEmpty else { return nil }
        return (String(s.prefix(5)), String(e.prefix(5)))
    }

    private func minutes(_ hhmm: String) -> Int? {
        let parts = hhmm.prefix(5).split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return parts[0] * 60 + parts[1]
    }

    /// مدة الرمز بالساعات — المناوبة العابرة لمنتصف الليل تُحسب +24س (عرض فقط).
    func durationHours(for day: ScheduleDTO.Day) -> Double? {
        guard let t = times(for: day), let s = minutes(t.start), let e = minutes(t.end) else { return nil }
        return Double(e > s ? e - s : e + 1440 - s) / 60.0
    }

    // MARK: - مشتقات الشهر الرئيسي (من الجدول × الرموز — بيانات فعلية)

    var scheduledDays: [ScheduleDTO.Day] {
        (anchorSchedule?.days ?? []).filter { $0.shiftCode != nil }
    }

    var totalShiftDays: Int { scheduledDays.count }

    var monthHours: Double {
        scheduledDays.reduce(0) { $0 + (durationHours(for: $1) ?? 0) }
    }

    var morningCount: Int { scheduledDays.filter { kind(for: $0) == .morning }.count }
    var nightCount: Int { scheduledDays.filter { kind(for: $0) == .night }.count }
    var vacationCount: Int { scheduledDays.filter { kind(for: $0) == .vacation }.count }

    /// المناوبات القادمة: أيام من اليوم فصاعدًا لها رمز — مرتبة زمنيًا
    /// (من كل الأشهر المحملة حتى لا تسقط أيام نهاية الشهر العابرة).
    var upcomingShifts: [ScheduleDTO.Day] {
        daysByDate.values
            .filter { $0.shiftCode != nil && ($0.date ?? "") >= todayStr }
            .sorted { ($0.date ?? "") < ($1.date ?? "") }
    }

    var nextShift: ScheduleDTO.Day? { upcomingShifts.first }

    /// «بعد N يوم» — فرق الأيام بتوقيت الرياض (عرض فقط).
    func daysUntil(_ day: ScheduleDTO.Day) -> Int {
        guard let date = parseDay(day.date) else { return 0 }
        let cal = riyadhCalendar
        let today = cal.startOfDay(for: Date())
        return max(0, cal.dateComponents([.day], from: today, to: date).day ?? 0)
    }

    /// تاريخ بصيغة المرجع «23-09-2026» (أرقام لاتينية ثابتة).
    func dashedDate(_ day: ScheduleDTO.Day) -> String {
        guard let raw = day.date, raw.count >= 10 else { return "—" }
        let y = raw.prefix(4), m = raw.dropFirst(5).prefix(2), d = raw.dropFirst(8).prefix(2)
        return "\(d)-\(m)-\(y)"
    }

    /// اسم اليوم كاملًا: «الثلاثاء».
    func weekdayName(_ dateStr: String?) -> String {
        guard let date = parseDay(dateStr) else { return "—" }
        let names = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]
        let w = riyadhCalendar.component(.weekday, from: date)
        return names[max(0, min(6, w - 1))]
    }

    /// اسم الشهر + السنة للنافذة الحالية: «سبتمبر 2026».
    var monthTitle: String {
        let cal = riyadhCalendar
        let names = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
                     "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]
        let m = cal.component(.month, from: anchor)
        let y = cal.component(.year, from: anchor)
        return "\(names[max(0, min(11, m - 1))]) \(y)"
    }
}
