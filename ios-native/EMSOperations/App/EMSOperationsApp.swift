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
    /// بوابة الإصدار (Force/Soft Update) — تحرس الدخول قبل أي جلسة أو شاشة.
    @StateObject private var versionGate = AppVersionGate()
    @Environment(\.scenePhase) private var scenePhase
    /// استعادة الجلسة مرة واحدة فقط بعد أول سماح من البوابة.
    @State private var sessionRestoreStarted = false

    var body: some Scene {
        WindowGroup {
            Group {
                switch versionGate.state {
                case .checking:
                    LaunchView()
                case .forceUpdate:
                    // حاجز كامل — بلا تخطٍّ ولا رجوع ولا أي جزء من النظام
                    ForceUpdateView(gate: versionGate)
                case .checkFailed:
                    // شبكة/خادم — رسالة مفهومة + Retry (ليس force تلقائيًا)
                    VersionCheckErrorView(gate: versionGate)
                case .configurationError:
                    // 404 بعد نشر المسار = خلل إعداد — حجب + Retry ولا تجاوز
                    VersionCheckErrorView(gate: versionGate)
                case .allowed:
                    RootView()
                }
            }
            .environmentObject(session)
            .environmentObject(deepLinks)
            .environmentObject(network)
            .environment(\.layoutDirection, .rightToLeft)
            // هوية داكنة إلزامية (توجيه المالك 2026-09-20 بند 1): بلا هذا
            // السطر تتبع الحقول الافتراضية/الكيبورد/التنبيهات وضع الجهاز —
            // وعلى الوضع الفاتح يصير النص داكنًا على خلفيتنا الداكنة.
            .preferredColorScheme(.dark)
            // بوابة الإصدار أولًا — الجلسة تُستعاد فقط بعد السماح بالدخول،
            // فلا تُنشأ جلسة فعّالة لنسخة غير مدعومة (حتى المحفوظة مسبقًا).
            .task { await versionGate.check() }
            .onChange(of: versionGate.allowsEntry) { allowed in
                if allowed, !sessionRestoreStarted {
                    sessionRestoreStarted = true
                    Task { await session.restore() }
                }
            }
            .onAppear { PushService.shared.attach(deepLinks: deepLinks, session: session) }
            // تحديث ذكي عند العودة للمقدمة (قسم 37): صلاحيات فقط —
            // الشاشات تحدّث بياناتها عند الظهور/السحب، لا إعادة تحميل شاملة.
            .onChange(of: scenePhase) { phase in
                guard phase == .active else { return }
                // إعادة فحص الإصدار عند كل عودة للمقدمة: رجوع من App Store
                // أو تشديد السياسة من السيرفر — مزالج بمهلة داخل البوابة.
                Task { await versionGate.check() }
                guard versionGate.allowsEntry, session.isAuthenticated else { return }
                Task { await session.permissions.load() }
            }
            // Soft Update: تنبيه غير حاجب — تحديث الآن أو متابعة بالنسخة
            // الحالية (ما زالت مدعومة). مرة واحدة لكل إصدار في كل إقلاع.
            // العرض عبر SoftUpdateAlertPresenter (UIKit) وليس .alert:
            // ربط SwiftUI كان يُسقَط صامتًا أثناء استعادة الجلسة (خلل الجهاز).
            .onChange(of: versionGate.showSoftPrompt) { pending in
                guard pending else { return }
                versionGate.showSoftPrompt = false
                SoftUpdateAlertPresenter.present(gate: versionGate)
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
