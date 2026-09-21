//
//  SessionStore.swift
//  EMSOperations
//
//  حالة الجلسة المركزية (ObservableObject) + حقن مزوّدي APIClient.
//  Face ID يُطلب هنا عند الاستعادة إن فعّله المستخدم (قسم 9).
//

import Foundation
import SwiftUI
import Combine

@MainActor
final class SessionStore: ObservableObject {
    enum State: Equatable {
        case restoring
        case unauthenticated
        case authenticated(AuthUser)
    }

    @Published private(set) var state: State = .restoring
    @Published var unreadNotifications: Int = 0
    /// عند وجود جلسة مخزنة وFace ID مفعّل — نطلب البوابة قبل الدخول.
    @Published var needsBiometricUnlock = false

    /// صلاحيات المستخدم الفعلية — تُبنى عليها الواجهة (v2 قسم 6).
    let permissions = PermissionStore()
    private var cancellables = Set<AnyCancellable>()

    private let auth = AuthService.shared

    init() {
        // حقن مزوّدي APIClient (كسر الاعتماد الدائري)
        APIClient.shared.tokenProvider = { AuthService.shared.storedAccessToken() }
        APIClient.shared.refreshHandler = { await AuthService.shared.refreshAccessToken() }
        // موت الجلسة أثناء التصفح (401 بعد فشل التحديث) → تصفير محلي فوري
        APIClient.shared.authFailureHandler = { [weak self] in await self?.sessionExpired() }
        // جسر إعادة الرسم (خلل 2026-09-20): PermissionStore مخزن متداخل — تغيّر
        // payload فيه لا يُعلم SessionStore، فبقي MainTabView على اللقطة السابقة
        // لتحميل الصلاحيات: تبويب «العمليات» يغيب رغم canAccessOperations=true
        // بينما تظهر بطاقة النبض (HomeView تُعاد بفضل ViewModel خاص بها).
        // الشرط نفسه كان صحيحًا دائمًا — الناقص هو إشعار الواجهة بوصول الصلاحيات.
        permissions.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    var isAuthenticated: Bool {
        if case .authenticated = state { return true }
        return false
    }

    /// المستخدم الحالي (للدردشة وتمييز رسائلي — §19).
    var currentUser: AuthUser? {
        if case .authenticated(let user) = state { return user }
        return nil
    }

    func restore() async {
        if let user = await auth.restore() {
            if BiometricGate.isEnabled && BiometricGate.isAvailable {
                needsBiometricUnlock = true
                let ok = await BiometricGate.unlock()
                needsBiometricUnlock = false
                guard ok else {
                    state = .unauthenticated
                    return
                }
            }
            state = .authenticated(user)
            // الصلاحيات أولًا — الواجهة تُبنى عليها (فشلها لا يكسر الدخول)
            await permissions.load()
            // أول فرصة آمنة لتسجيل جهاز Push (بعد المصادقة — شرط المالك)
            await PushService.shared.requestPermissionAndRegister()
        } else {
            KeychainService.clearSession()
            state = .unauthenticated
        }
    }

    func loginSucceeded(user: AuthUser) async {
        state = .authenticated(user)
        await permissions.load()
        // تبديل حساب على نفس الجهاز: إبطال ذاكرة التوكن حتى يُعاد الربط خادميًا
        PushService.shared.invalidateRegistrationCache()
        await PushService.shared.requestPermissionAndRegister()
    }

    func logout() async {
        // محلي أولًا (توجيه المالك 2026-09-20 بند 5): الخروج يستجيب فورًا
        // حتى لو الخادم غير متاح — النداءات السيرفرية best-effort بـtry?
        // داخل AuthService ولا تمنع التصفير المحلي.
        PushService.shared.invalidateRegistrationCache()
        permissions.reset()
        SafeCache.clear()
        unreadNotifications = 0
        state = .unauthenticated
        await auth.logout()
    }

    /// جلسة ميتة اكتشفها APIClient (401 بعد فشل التحديث) — تصفير محلي بلا نداء
    /// خادم (التوكن أصلًا مرفوض). يعيد المستخدم لشاشة الدخول بدل بطاقات الخطأ.
    func sessionExpired() async {
        guard isAuthenticated else { return }
        KeychainService.clearSession()
        PushService.shared.invalidateRegistrationCache()
        permissions.reset()
        SafeCache.clear()
        unreadNotifications = 0
        state = .unauthenticated
    }
}

// MARK: - تنبيه كلمة المرور الأولية (قرار المالك 2026-09-20 — دخول جميع الموظفين)

/// الحسابات الجديدة تُنشأ بكلمة مرور أولية = الكود الوظيفي. هذا تلميح عرض فقط:
/// يُضبط عند دخول ناجح كتب فيه المستخدم كلمة مرور تطابق اسم المستخدم، ويُزال
/// بعد نجاح تغيير كلمة المرور من «حسابي». لا يُخزَّن أي جزء من كلمة المرور —
/// فقط علم منطقي لكل اسم مستخدم.
enum InitialPasswordAdvisory {
    private static func key(for username: String) -> String { "ems.initialPasswordAdvisory." + username }

    /// يُستدعى بعد نجاح المصادقة — قبل مسح كلمة المرور من الذاكرة.
    static func markIfCode(username: String?, password: String) {
        guard let u = username?.trimmingCharacters(in: .whitespaces), !u.isEmpty, password == u else { return }
        UserDefaults.standard.set(true, forKey: key(for: u))
    }

    static func isPending(for username: String?) -> Bool {
        guard let u = username, !u.isEmpty else { return false }
        return UserDefaults.standard.bool(forKey: key(for: u))
    }

    static func clear(for username: String?) {
        guard let u = username, !u.isEmpty else { return }
        UserDefaults.standard.removeObject(forKey: key(for: u))
    }
}
