//
//  LoginViewModel.swift
//  EMSOperations
//

import Foundation

@MainActor
final class LoginViewModel: ObservableObject {
    @Published var username = ""
    @Published var password = ""
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var offerBiometric = false

    private let auth = AuthService.shared
    private var lastUser: AuthUser?

    var canSubmit: Bool {
        !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty && !isLoading
    }

    func login(session: SessionStore) async {
        guard canSubmit else { return }
        isLoading = true
        errorMessage = nil
        do {
            let user = try await auth.login(
                username: username.trimmingCharacters(in: .whitespaces),
                password: password)
            lastUser = user
            password = "" // لا نحتفظ بكلمة المرور إطلاقًا (قسم 29)
            // عرض تفعيل Face ID بعد أول دخول ناجح (قسم 9) — اختياري
            if BiometricGate.isAvailable && !BiometricGate.isEnabled {
                offerBiometric = true
            } else {
                await session.loginSucceeded(user: user)
            }
        } catch let e as APIError {
            errorMessage = e.userMessage
        } catch {
            errorMessage = APIError.unknown.userMessage
        }
        isLoading = false
    }

    func enableBiometricAndContinue(session: SessionStore) async {
        BiometricGate.isEnabled = true
        offerBiometric = false
        if let user = lastUser { await session.loginSucceeded(user: user) }
    }

    func skipBiometricAndContinue(session: SessionStore) async {
        offerBiometric = false
        if let user = lastUser { await session.loginSucceeded(user: user) }
    }
}
