//
//  EMSOperationsApp.swift
//  EMSOperations — Native iOS Client
//
//  نقطة الدخول: الجلسة تُستعاد أولًا، ثم التوجيه عبر RootView.
//  PushService يُهيَّأ مبكرًا (تفويض مركز الإشعارات) لكن تسجيل الجهاز
//  لا يتم إلا بعد المصادقة (شرط المالك — لا ربط قبل الدخول).
//

import SwiftUI

@main
struct EMSOperationsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session = SessionStore()
    @StateObject private var deepLinks = DeepLinkRouter()
    @StateObject private var network = NetworkMonitor()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(deepLinks)
                .environmentObject(network)
                .task { await session.restore() }
                .onAppear { PushService.shared.attach(deepLinks: deepLinks, session: session) }
                // تحديث ذكي عند العودة للمقدمة (قسم 37): صلاحيات فقط —
                // الشاشات تحدّث بياناتها عند الظهور/السحب، لا إعادة تحميل شاملة.
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active, session.isAuthenticated else { return }
                    Task { await session.permissions.load() }
                }
        }
    }
}

/// AppDelegate — مطلوب لخطافات APNs (تسجيل الجهاز) التي لا تغطيها SwiftUI lifecycle.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        PushService.shared.configure()
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushService.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushService.shared.didFailToRegister(error: error)
    }
}
