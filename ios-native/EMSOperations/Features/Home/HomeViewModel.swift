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

    /// لقطة عدّادات النبض — قيم سيرفرية خام، بلا أي حساب في العميل.
    struct OpsPulse: Equatable {
        let activeVehicles: Int?
        let breakdownVehicles: Int?
        let outOfServiceVehicles: Int?
        let readyTeams: Int?
        let requiredTeams: Int?
        let readinessRate: Int?
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
