//
//  SessionStore.swift
//  EMSOperations
//
//  حالة الجلسة المركزية (ObservableObject) + حقن مزوّدي APIClient.
//  Face ID يُطلب هنا عند الاستعادة إن فعّله المستخدم (قسم 9).
//

import Foundation
import SwiftUI

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

    private let auth = AuthService.shared

    init() {
        // حقن مزوّدي APIClient (كسر الاعتماد الدائري)
        APIClient.shared.tokenProvider = { AuthService.shared.storedAccessToken() }
        APIClient.shared.refreshHandler = { await AuthService.shared.refreshAccessToken() }
        // موت الجلسة أثناء التصفح (401 بعد فشل التحديث) → تصفير محلي فوري
        APIClient.shared.authFailureHandler = { [weak self] in await self?.sessionExpired() }
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
        await auth.logout()
        PushService.shared.invalidateRegistrationCache()
        permissions.reset()
        SafeCache.clear()
        unreadNotifications = 0
        state = .unauthenticated
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
