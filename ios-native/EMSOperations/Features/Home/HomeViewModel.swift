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
