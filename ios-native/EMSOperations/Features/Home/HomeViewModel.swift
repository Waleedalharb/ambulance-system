//
//  HomeViewModel.swift
//  EMSOperations
//
//  Operational Home (v2 قسم 7/8): يجمع سياق التشغيل الحالي من الـBackend
//  فقط — لا بيانات مخترعة. يدعم SafeCache للعرض دون اتصال (بيانات عرض
//  غير حساسة فقط، بحد أقصى ساعة للعرض الطازج).
//

import Foundation

@MainActor
final class HomeViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var profile: ProfileDTO?
    @Published var sections: SectionsDTO.Sections?
    @Published var mates: ShiftMatesDTO?
    @Published var recentNotifications: [PortalNotificationsDTO.Item] = []
    @Published var unreadCount = 0
    /// الحساب غير مرتبط ببوابة الموظف (403/NO_EMPLOYEE) — مستخدم عمليات/إدارة بلا بوابة.
    @Published var portalUnavailable = false
    /// نبض العمليات الحي (صلاحيات ops.*) — عدّادات من vehicles/board + staffing/state كما يشتقها الخادم.
    @Published var pulse: OpsPulse?
    /// جدول الشهر الحالي — لاشتقاق «مناوبتك القادمة» عندما لا تكون اليوم.
    @Published var schedule: ScheduleDTO?

    /// لقطة عدّادات النبض — قيم سيرفرية خام، بلا أي حساب في العميل.
    struct OpsPulse: Equatable {
        let activeVehicles: Int?
        let breakdownVehicles: Int?
        let outOfServiceVehicles: Int?
        let readyTeams: Int?
        let requiredTeams: Int?
        let readinessRate: Int?
    }

    /// المناوبة القادمة/الحالية المعروضة في الرئيسية — كلها من بيانات الخادم.
    /// أوقات البدء/الانتهاء متوفرة في /api/my/profile لليوم فقط؛ أيام الجدول
    /// المستقبلية تحمل التاريخ والوردية والفريق والمركز دون أوقات.
    struct NextShiftInfo: Equatable {
        let date: Date
        let start: Date?
        let end: Date?
        let shiftName: String?
        let teamName: String?
        let center: String?
        let isToday: Bool
        let isOngoing: Bool
    }

    private let api = APIClient.shared

    func load(session: SessionStore, force: Bool = false) async {
        if state == .loading && profile != nil && !force { return }
        let hadContent = profile != nil || portalUnavailable
        if !hadContent { state = .loading }
        do {
            async let profileReq: ProfileDTO = api.get("/api/my/profile")
            async let sectionsReq: SectionsDTO = api.get("/api/my/sections")
            async let notifReq: PortalNotificationsDTO = api.get("/api/my/notifications")
            async let matesReq: ShiftMatesDTO = api.get("/api/my/shift-mates")
            let (p, s, n, m) = try await (profileReq, sectionsReq, notifReq, matesReq)
            profile = p
            sections = s.sections
            recentNotifications = Array(n.notifications.prefix(3))
            unreadCount = n.unreadCount ?? 0
            session.unreadNotifications = n.unreadCount ?? 0
            mates = m.available ? m : nil
            SafeCache.store(p, key: "home.profile")
            state = .loaded
        } catch let e as APIError {
            if e == .forbidden || e == .noEmployee {
                // ليس خطأ — حساب بلا بوابة موظف: تعرض الرئيسية نسختها المؤسسية
                portalUnavailable = true
                state = .loaded
            } else if e == .offline || e == .timeout, let cached = SafeCache.loadStale(ProfileDTO.self, key: "home.profile") {
                profile = cached
                state = .loaded
            } else if hadContent {
                state = .loaded // احتفظ بالمحتوى الحالي — الشارة تُعرض من NetworkMonitor
            } else {
                state = .failed(e.userMessage)
            }
        } catch {
            if !hadContent { state = .failed(APIError.unknown.userMessage) }
        }
        // نبض العمليات مستقل — فشله لا يكسر الرئيسية إطلاقًا.
        if session.permissions.canAccessOperations {
            await loadPulse()
        }
        // جدول الشهر لاشتقاق المناوبة القادمة — مستقل ولا يكسر الرئيسية.
        if session.permissions.canAccessEmployeePortal {
            await loadSchedule()
        }
    }

    /// جدول الشهر الحالي (مرجعية الرياض الزمنية — مثل ScheduleViewModel).
    private func loadSchedule() async {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        let now = Date()
        do {
            schedule = try await api.get("/api/my/schedule", query: [
                "month": String(cal.component(.month, from: now)),
                "year": String(cal.component(.year, from: now))
            ])
        } catch {
            schedule = nil // بطاقة المناوبة تسقط على بيانات اليوم فقط
        }
    }

    // MARK: - المناوبة القادمة (اشتقاق عرض فقط — لا منطق تشغيلي)

    /// مرجعية الرياض الزمنية — نفس مرجعية الخادم.
    private var riyadhCalendar: Calendar {
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

    private func parseDay(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        return Self.dayFormatter.date(from: String(raw.prefix(10)))
    }

    private func combine(_ day: Date, _ time: String?) -> Date? {
        guard let time else { return nil }
        let parts = time.prefix(5).split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return riyadhCalendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: day)
    }

    /// المناوبة القادمة: مناوبة اليوم إن كانت قائمة أو قادمة اليوم، وإلا أول
    /// يوم مستقبلي في جدول الشهر له وردية. بلا أي بيانات مخترعة.
    var nextShift: NextShiftInfo? {
        let now = Date()
        if let today = profile?.today, today.shiftCode != nil, let day = parseDay(today.date) {
            let start = combine(day, today.timeStart)
            var end = combine(day, today.timeEnd)
            // مناوبة ليلية تعبر منتصف الليل — النهاية في اليوم التالي
            if let s = start, let e = end, e <= s {
                end = riyadhCalendar.date(byAdding: .day, value: 1, to: e)
            }
            let ongoing = start.map { now >= $0 } ?? false
            let notEnded = end.map { now <= $0 } ?? true
            if notEnded {
                return NextShiftInfo(date: day, start: start, end: end,
                                     shiftName: today.shiftName ?? today.shiftCode,
                                     teamName: today.teamName, center: today.center,
                                     isToday: true, isOngoing: ongoing)
            }
        }
        // أول يوم مستقبلي له وردية في جدول الشهر
        let startOfToday = riyadhCalendar.startOfDay(for: now)
        let future = (schedule?.days ?? [])
            .filter { $0.shiftCode != nil }
            .compactMap { d -> (Date, ScheduleDTO.Day)? in
                guard let date = parseDay(d.date), date > startOfToday else { return nil }
                return (date, d)
            }
            .sorted { $0.0 < $1.0 }
            .first
        if let (date, day) = future {
            return NextShiftInfo(date: date, start: nil, end: nil,
                                 shiftName: day.shiftName ?? day.shiftCode,
                                 teamName: day.teamName, center: day.center,
                                 isToday: false, isOngoing: false)
        }
        return nil
    }

    /// التحية حسب ساعة الرياض.
    var greeting: String {
        let hour = riyadhCalendar.component(.hour, from: Date())
        return (5..<12).contains(hour) ? "صباح الخير" : "مساء الخير"
    }

    /// تنسيق عربي لتاريخ المناوبة: «الثلاثاء 28 سبتمبر 2026».
    func arabicDateLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "ar_SA")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "EEEE d MMMM yyyy"
        return f.string(from: date)
    }

    /// وقت الإشعار «HH:mm» بتوقيت الرياض من createdAt الخادم (ISO8601).
    func notificationTime(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: raw) ?? {
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return plain.date(from: raw)
        }()
        guard let date else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    /// عدّادات حية لبطاقة «نبض العمليات» — قراءة فقط من مسارين قائمين.
    private func loadPulse() async {
        do {
            async let boardReq: VehiclesBoardDTO = api.get("/api/vehicles/board")
            async let staffReq: StaffingStateDTO = api.get("/api/staffing/state")
            let (b, s) = try await (boardReq, staffReq)
            pulse = OpsPulse(
                activeVehicles: b.counters?.active,
                breakdownVehicles: b.counters?.breakdown,
                outOfServiceVehicles: b.counters?.outOfService,
                readyTeams: s.workforce?.readyTeams,
                requiredTeams: s.workforce?.requiredTeams,
                readinessRate: s.workforce?.operationalReadinessRate ?? s.workforce?.readinessRate)
        } catch {
            pulse = nil // تبقى البطاقة بلا عدّادات — لا حالة فشل في الرئيسية بسبب النبض
        }
    }

    // MARK: - مشتقات عرض (من بيانات الخادم فقط)

    /// حالة المناوبة الحالية كما يقررها الخادم عبر shift-mates.
    var shiftStateText: String? {
        guard let me = mates?.me else { return nil }
        if me.onShift == true { return "على المناوبة الآن" }
        if me.state != nil { return me.state }
        return nil
    }

    var teamCount: Int { mates?.team?.count ?? 0 }
    var leadershipCount: Int { mates?.leadership?.count ?? 0 }
    var opsCount: Int { mates?.ops?.count ?? 0 }
}
