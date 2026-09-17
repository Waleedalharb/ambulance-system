//
//  BiometricGate.swift
//  EMSOperations
//
//  Face ID (قسم 9 / D3): لا يستبدل مصادقة الخادم — بوابة لإعادة فتح
//  الجلسة المخزنة. العلم في UserDefaults (غير حساس)، التوكنات في Keychain.
//

import Foundation
import LocalAuthentication

enum BiometricGate {
    private static let enabledKey = "biometric_unlock_enabled"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    static var isAvailable: Bool {
        var err: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
    }

    static var biometryName: String {
        let ctx = LAContext()
        var err: NSError?
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        return ctx.biometryType == .faceID ? "Face ID" : "Touch ID"
    }

    /// تقييم البوابة — ينجح بالبصمة أو (عند السماح) برمز الجهاز.
    static func unlock(reason: String = "افتح جلستك في EMS Operations") async -> Bool {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "إلغاء"
        do {
            return try await ctx.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason)
        } catch {
            AppLogger.auth.info("biometric unlock failed/cancelled")
            return false
        }
    }
}
