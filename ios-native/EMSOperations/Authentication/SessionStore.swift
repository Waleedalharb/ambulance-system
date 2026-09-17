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

    private let auth = AuthService.shared

    init() {
        // حقن مزوّدي APIClient (كسر الاعتماد الدائري)
        APIClient.shared.tokenProvider = { AuthService.shared.storedAccessToken() }
        APIClient.shared.refreshHandler = { await AuthService.shared.refreshAccessToken() }
    }

    var isAuthenticated: Bool {
        if case .authenticated = state { return true }
        return false
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
            // أول فرصة آمنة لتسجيل جهاز Push (بعد المصادقة — شرط المالك)
            await PushService.shared.requestPermissionAndRegister()
        } else {
            KeychainService.clearSession()
            state = .unauthenticated
        }
    }

    func loginSucceeded(user: AuthUser) async {
        state = .authenticated(user)
        await PushService.shared.requestPermissionAndRegister()
    }

    func logout() async {
        await auth.logout()
        unreadNotifications = 0
        state = .unauthenticated
    }
}
