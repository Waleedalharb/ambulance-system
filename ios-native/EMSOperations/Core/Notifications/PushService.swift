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
        #if DEBUG
        AppLogger.push.info("push permission: status=\(Self.statusName(settings.authorizationStatus), privacy: .public) alert=\(Self.settingName(settings.alertSetting), privacy: .public) sound=\(Self.settingName(settings.soundSetting), privacy: .public) badge=\(Self.settingName(settings.badgeSetting), privacy: .public)")
        #endif
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

    #if DEBUG
    private static func statusName(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }

    private static func settingName(_ s: UNNotificationSetting) -> String {
        switch s {
        case .notSupported: return "notSupported"
        case .disabled: return "disabled"
        case .enabled: return "enabled"
        @unknown default: return "unknown"
        }
    }
    #endif

    private func register() async {
        UIApplication.shared.registerForRemoteNotifications()
    }

    // MARK: - AppDelegate hooks

    nonisolated func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        AppLogger.push.info("device token registered (apns, \(deviceToken.count) bytes)")
        #endif
        Task { @MainActor in
            await self.sendToken(token)
        }
    }

    nonisolated func didFailToRegister(error: Error) {
        AppLogger.push.warning("APNs registration failed: \(AppLogger.redact(error.localizedDescription), privacy: .public)")
    }

    /// إبطال ذاكرة «آخر توكن مُرسَل» — تُستدعى عند تسجيل الخروج/تبديل
    /// الحساب حتى يُعاد ربط الجهاز بالمستخدم الجديد (upsert سيرفري).
    func invalidateRegistrationCache() {
        lastSentToken = nil
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
                AppLogger.push.info("device registered with backend (\(AppEnvironment.current.apnsEnvironment, privacy: .public))")
            } else {
                AppLogger.push.warning("device registration rejected by backend")
            }
        } catch let e as APIError {
            // النوع يكشف السبب (404 = الخادم المنشور بلا مسارات Push بعد، 401/403 جلسة/صلاحية)
            AppLogger.push.warning("device token upload failed (\(String(describing: e), privacy: .public)) — will retry next launch")
        } catch {
            AppLogger.push.warning("device token upload failed — will retry next launch")
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// إشعار والتطبيق في المقدمة: نظهره بنر iOS + نحدّث العداد الداخلي.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        #if DEBUG
        let kind = notification.request.content.userInfo["kind"] as? String ?? "—"
        AppLogger.push.info("notification received (kind: \(kind, privacy: .public)) — presenting banner/sound/badge")
        #endif
        return [.banner, .sound, .badge]
    }

    /// الضغط على الإشعار — توجيه مركزي (قسم 18 + بند 11: تمركزات الذروة).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let kind = content.userInfo["kind"] as? String
        #if DEBUG
        AppLogger.push.info("notification tapped (kind: \(kind ?? "—", privacy: .public))")
        #endif
        let title = content.title
        let body = content.body
        Task { @MainActor in
            self.deepLinks?.route(kind: kind, title: title, body: body)
        }
    }
}
