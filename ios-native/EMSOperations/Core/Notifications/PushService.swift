//
//  PushService.swift
//  EMSOperations
//
//  APNs Native (قسم 15-16) — التسجيل بعد المصادقة فقط، والتوكن يُربط
//  خادميًا من جلسة Bearer (لا معرّف مستخدم من العميل).
//  التوجيه عند الضغط عبر DeepLinkRouter (قسم 18).
//

import Foundation
import UIKit
import UserNotifications

@MainActor
final class PushService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushService()

    private weak var deepLinks: DeepLinkRouter?
    private weak var session: SessionStore?
    private var lastSentToken: String?

    private override init() { super.init() }

    nonisolated func configure() {
        Task { @MainActor in
            UNUserNotificationCenter.current().delegate = self
        }
    }

    func attach(deepLinks: DeepLinkRouter, session: SessionStore) {
        self.deepLinks = deepLinks
        self.session = session
    }

    // MARK: - Registration (بعد الدخول فقط)

    func requestPermissionAndRegister() async {
        guard session?.isAuthenticated == true else {
            AppLogger.push.info("skip push registration — not authenticated")
            return
        }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                if granted { await register() } else {
                    AppLogger.push.info("push permission denied by user")
                }
            } catch {
                AppLogger.push.warning("push permission request failed")
            }
        case .authorized, .provisional, .ephemeral:
            await register()
        case .denied:
            AppLogger.push.info("push permission previously denied")
        @unknown default:
            break
        }
    }

    private func register() async {
        UIApplication.shared.registerForRemoteNotifications()
    }

    // MARK: - AppDelegate hooks

    nonisolated func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            await self.sendToken(token)
        }
    }

    nonisolated func didFailToRegister(error: Error) {
        AppLogger.push.warning("APNs registration failed: \(AppLogger.redact(error.localizedDescription), privacy: .public)")
    }

    private func sendToken(_ token: String) async {
        guard session?.isAuthenticated == true else { return }
        guard token != lastSentToken else { return } // token refresh لا يكرر الإرسال
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        do {
            let res: PushRegisterResponse = try await APIClient.shared.post(
                "/api/my/push/register",
                body: PushRegisterRequest(
                    token: token,
                    platform: "ios",
                    environment: AppEnvironment.current.apnsEnvironment,
                    appVersion: version))
            if res.success == true {
                lastSentToken = token
                AppLogger.push.info("device registered (\(AppEnvironment.current.apnsEnvironment, privacy: .public))")
            }
        } catch {
            AppLogger.push.warning("device token upload failed — will retry next launch")
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// إشعار والتطبيق في المقدمة: نظهره بنر iOS + نحدّث العداد الداخلي.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        return [.banner, .sound, .badge]
    }

    /// الضغط على الإشعار — توجيه مركزي (قسم 18).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let data = response.notification.request.content.userInfo
        let kind = data["kind"] as? String
        Task { @MainActor in
            self.deepLinks?.route(kind: kind)
        }
    }
}
