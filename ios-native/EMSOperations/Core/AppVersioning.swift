//
//  AppVersioning.swift
//  EMSOperations
//
//  منظومة Version Update & Force Update (قرار المالك):
//   · الخادم هو المصدر المركزي الوحيد للسياسة عبر GET /api/app/version —
//     لا منطق إصدارات موزّعًا ولا minimumVersion ثابتًا داخل التطبيق.
//   · البوابة (AppVersionGate) تعمل قبل استعادة الجلسة وقبل أي شاشة —
//     نسخة غير مدعومة = لا دخول ولا جلسة إطلاقًا، ولا تجاوز بالرجوع
//     أو الإغلاق أو إخفاء الشاشة.
//   · force: شاشة حاجزة بلا «لاحقًا» · soft: تنبيه قابل للمتابعة ·
//     فشل الشبكة: رسالة واضحة + Retry، مع تطبيق آخر سياسة معروفة
//     (كاش ≤ 72 ساعة) حتى لا يُستخدم إصدار أصبح ممنوعًا بلا اتصال.
//

import SwiftUI
import UIKit

// MARK: - إعداد المنظومة

enum AppVersioningConfig {
    /// ⚠️ توافقية مرحلة التدشين — أُطفئت بعد تأكيد عمل
    /// GET /api/app/version في Production (HTTP 200):
    ///  · true  = خادم قديم بلا المسار (404) → سماح بالافتراضيات الآمنة.
    ///  · false = 404 يعني أن المسار «اختفى» بعد نشره = خطأ إعداد
    ///    (Configuration Error) يحجب الدخول مع Retry — وليس Allow دائمًا،
    ///    فلا يصبح 404 طريقة لتجاوز التحديث الإجباري.
    static let allowNotFoundUntilEndpointDeployed = false
}

// MARK: - نموذج الاستجابة

/// سياسة الإصدار كما يرجعها GET /api/app/version (فك حرفي بلا منطق).
struct AppVersionInfo: Decodable, Equatable {
    let platform: String
    let latestVersion: String
    let minimumVersion: String
    let forceUpdate: Bool
    let appStoreUrl: String
    let message: String?
}

// MARK: - مقارنة الإصدارات (SemVer رقمية — لا مقارنة نصية)

enum AppVersionComparator {
    /// مكونات رقمية: "2.10.0" → [2, 10, 0]. غير الرقمي = 0.
    static func parts(_ version: String) -> [Int] {
        version.split(separator: ".").map { Int($0.filter { $0.isNumber }) ?? 0 }
    }

    /// مقارنة رقمية مكوّنًا مكوّنًا مع بادئة صفرية — 2.10.0 > 2.9.0 دائمًا.
    static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let pa = parts(a), pb = parts(b)
        let count = max(pa.count, pb.count)
        for i in 0..<count {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x < y ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    static func isLess(_ a: String, than b: String) -> Bool { compare(a, b) == .orderedAscending }
}

// MARK: - قرار الإنفاذ (دالة نقية قابلة للاختبار)

enum AppVersionDecision: Equatable {
    case normal       // installed >= latest
    case softUpdate   // minimum <= installed < latest
    case forceUpdate  // installed < minimum، أو forceUpdate مع وجود أحدث
}

enum AppVersionEnforcement {
    /// القاعدة (قرار المالك §9):
    ///  installed < minimum            → FORCE
    ///  forceUpdate && installed < latest → FORCE
    ///  installed < latest             → SOFT
    ///  installed >= latest            → NORMAL (الأحدث من latest يدخل طبيعي)
    static func decide(installed: String, info: AppVersionInfo) -> AppVersionDecision {
        if AppVersionComparator.isLess(installed, than: info.minimumVersion) { return .forceUpdate }
        if info.forceUpdate, AppVersionComparator.isLess(installed, than: info.latestVersion) { return .forceUpdate }
        if AppVersionComparator.isLess(installed, than: info.latestVersion) { return .softUpdate }
        return .normal
    }
}

// MARK: - الخدمة (جلب + كاش آخر سياسة ناجحة)

enum AppVersionService {
    private static let infoKey = "appVersion.lastInfo"
    private static let dateKey = "appVersion.lastCheckAt"
    /// صلاحية الكاش عند انقطاع الشبكة — بعدها نطلب اتصالًا بدل الدخول الأعمى.
    static let cacheMaxAge: TimeInterval = 72 * 60 * 60

    /// الجلب الحي — مسار عام بلا مصادقة (يفحص قبل تسجيل الدخول).
    static func liveFetch() async throws -> AppVersionInfo {
        try await APIClient.shared.getPublic("/api/app/version", query: ["platform": "ios"])
    }

    static func cache(_ info: AppVersionInfo) {
        let payload: [String: Any] = [
            "platform": info.platform,
            "latestVersion": info.latestVersion,
            "minimumVersion": info.minimumVersion,
            "forceUpdate": info.forceUpdate,
            "appStoreUrl": info.appStoreUrl,
            "message": info.message ?? ""
        ]
        UserDefaults.standard.set(payload, forKey: infoKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: dateKey)
    }

    /// آخر سياسة ناجحة مع وقتها — nil إن لم يسبق نجاح.
    static func cachedInfo() -> (AppVersionInfo, Date)? {
        guard let payload = UserDefaults.standard.dictionary(forKey: infoKey),
              let latest = payload["latestVersion"] as? String,
              let minimum = payload["minimumVersion"] as? String,
              let url = payload["appStoreUrl"] as? String else { return nil }
        let info = AppVersionInfo(
            platform: payload["platform"] as? String ?? "ios",
            latestVersion: latest,
            minimumVersion: minimum,
            forceUpdate: payload["forceUpdate"] as? Bool ?? false,
            appStoreUrl: url,
            message: payload["message"] as? String
        )
        let ts = UserDefaults.standard.double(forKey: dateKey)
        return (info, Date(timeIntervalSince1970: ts))
    }

    static func clearCache() {
        UserDefaults.standard.removeObject(forKey: infoKey)
        UserDefaults.standard.removeObject(forKey: dateKey)
    }
}

// MARK: - البوابة

@MainActor
final class AppVersionGate: ObservableObject {
    enum State: Equatable {
        case checking     // فحص جارٍ — شاشة الإقلاع
        case allowed      // مسموح (normal أو soft — التنبيه عبر showSoftPrompt)
        case forceUpdate  // حاجز كامل — لا دخول إطلاقًا
        case checkFailed  // تعذر التحقق — رسالة + Retry (ليس force تلقائيًا)
        case configurationError // 404 بعد نشر المسار = خطأ إعداد — حجب + Retry
    }

    @Published private(set) var state: State = .checking
    @Published private(set) var info: AppVersionInfo?
    /// تنبيه Soft Update — مرة واحدة لكل latestVersion في كل إقلاع.
    @Published var showSoftPrompt = false

    private let fetch: () async throws -> AppVersionInfo
    private let now: () -> Date
    private var lastCheckAt: Date?
    private var softPromptedVersion: String?
    /// مهلة دنيا بين فحصين متتاليين (عودة المقدمة المتكررة) — لا Loop.
    private let recheckDebounce: TimeInterval
    /// سلوك 404 — من AppVersioningConfig؛ قابل للحقن في الاختبارات.
    private let allowNotFoundFallback: Bool

    init(fetch: @escaping () async throws -> AppVersionInfo = AppVersionService.liveFetch,
         now: @escaping () -> Date = Date.init,
         recheckDebounce: TimeInterval = 10,
         allowNotFoundFallback: Bool = AppVersioningConfig.allowNotFoundUntilEndpointDeployed) {
        self.fetch = fetch
        self.now = now
        self.recheckDebounce = recheckDebounce
        self.allowNotFoundFallback = allowNotFoundFallback
    }

    var allowsEntry: Bool { state == .allowed }

    static var installedVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    /// الفحص الرئيسي — عند الإقلاع وكل عودة للمقدمة (مزالج بـdebounce).
    func check(force: Bool = false) async {
        if !force, let lastCheckAt, now().timeIntervalSince(lastCheckAt) < recheckDebounce { return }
        AppLogger.network.info("version gate: checking against \(AppEnvironment.current.baseURL.absoluteString, privacy: .public)")
        do {
            let fetched = try await fetch()
            info = fetched
            lastCheckAt = now()
            AppVersionService.cache(fetched)
            // لوج تشخيصي (معتمد المالك): القيم الخام + القرار النهائي — بلا بيانات حساسة
            AppLogger.network.info("version gate: installed=\(Self.installedVersion, privacy: .public) latest=\(fetched.latestVersion, privacy: .public) minimum=\(fetched.minimumVersion, privacy: .public) forceUpdate=\(fetched.forceUpdate, privacy: .public) url=\(fetched.appStoreUrl, privacy: .public)")
            apply(installed: Self.installedVersion, info: fetched)
            AppLogger.network.info("version gate decision: \(String(describing: self.state), privacy: .public)")
        } catch {
            if case APIError.notFound = error {
                if allowNotFoundFallback {
                    // توافقية مرحلة التدشين فقط (AppVersioningConfig): خادم
                    // لم يُنشر عليه المسار بعد = لا سياسة مفروضة بعد → دخول
                    // بالافتراضيات الآمنة. يمنع حجب كل المستخدمين إن سبق
                    // التطبيقُ النشرَ الخادمي — ويُلغى فور عمل المسار في Production.
                    AppLogger.network.info("app version endpoint not deployed yet (404) — temporary compat allow")
                    let fallback = AppVersionInfo(platform: "ios",
                                                  latestVersion: Self.installedVersion,
                                                  minimumVersion: "0",
                                                  forceUpdate: false,
                                                  appStoreUrl: "",
                                                  message: nil)
                    info = fallback
                    lastCheckAt = now()
                    state = .allowed
                } else {
                    // السلوك النهائي: المسار منشور — 404 يعني اختفاءه = خطأ
                    // إعداد خادمي، يحجب الدخول مع Retry ولا يُتجاوز إطلاقًا.
                    AppLogger.network.error("app version endpoint returned 404 after deployment — configuration error")
                    lastCheckAt = now()
                    state = .configurationError
                }
                return
            }
            AppLogger.network.warning("app version check failed: \(AppLogger.redact(error.localizedDescription), privacy: .public)")
            // ليس Force تلقائيًا: نطبّق آخر سياسة معروفة ضمن صلاحيتها (نسخة
            // صارت ممنوعة تبقى ممنوعة بلا اتصال)، وإلا رسالة + Retry.
            if let (cached, at) = AppVersionService.cachedInfo(),
               now().timeIntervalSince(at) < AppVersionService.cacheMaxAge {
                AppLogger.network.warning("version gate: applying CACHED policy latest=\(cached.latestVersion, privacy: .public) minimum=\(cached.minimumVersion, privacy: .public) forceUpdate=\(cached.forceUpdate, privacy: .public) cachedAt=\(at.description, privacy: .public)")
                info = cached
                apply(installed: Self.installedVersion, info: cached)
                AppLogger.network.warning("version gate decision from cache: \(String(describing: self.state), privacy: .public)")
            } else {
                AppLogger.network.warning("version gate: no valid cache — checkFailed")
                state = .checkFailed
            }
        }
    }

    private func apply(installed: String, info: AppVersionInfo) {
        switch AppVersionEnforcement.decide(installed: installed, info: info) {
        case .normal:
            state = .allowed
        case .softUpdate:
            state = .allowed
            if softPromptedVersion != info.latestVersion {
                softPromptedVersion = info.latestVersion
                showSoftPrompt = true
            }
        case .forceUpdate:
            state = .forceUpdate
        }
    }

    /// فتح صفحة التطبيق الرسمية في App Store — الرابط من الخادم حصرًا،
    /// ولا يوجد أي رابط App Store داخل ملفات iOS (قرار المالك).
    func openAppStore() {
        guard let raw = info?.appStoreUrl, !raw.isEmpty, let url = URL(string: raw) else { return }
        UIApplication.shared.open(url)
    }
}

// MARK: - عرض تنبيه Soft Update (آلية UIKit — لا سقوط صامت)

/// خلل الجهاز (2026-10-05): `.alert` المربوط بـshowSoftPrompt كان يُطلب
/// عرضه في نفس لحظة تبديل شجرة الواجهة (checking→allowed) واستعادة الجلسة
/// التي تطلق حوار النظام لإذن الإشعارات — فيُسقِطه SwiftUI صامتًا ويدخل
/// المستخدم بلا أي تنبيه رغم أن قرار البوابة softUpdate صحيح (مُعاد إنتاجه
/// على المحاكي بجلسة مسجّلة). العرض هنا عبر UIAlertController مباشرة:
/// present على ViewController داخل النافذة لا يفشل صامتًا، ومع إعادة
/// محاولة محدودة حتى تستقر الشجرة. حوارات النظام (إذن الإشعارات) تظهر
/// فوقه وينكشف التنبيه فور إجابتها — وهذا هو السلوك المطلوب.
/// النصوص والتصميم مطابقان تمامًا للتنبيه المعتمد — التغيير في الآلية فقط.
@MainActor
enum SoftUpdateAlertPresenter {
    private static let maxAttempts = 20
    private static let retryDelay: TimeInterval = 0.75

    static func present(gate: AppVersionGate, attempt: Int = 0) {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first,
              let root = window.rootViewController,
              root.view.window != nil else {
            retry(gate: gate, attempt: attempt)
            return
        }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        // نعرض فوق القمة مهما كانت (حتى لو تنبيه آخر/حوار نظام): التكديس
        // فوق القمة يضمن الظهور — أسوأ البدائل هو السقوط الصامت (خلل الجهاز).
        let latest = gate.info?.latestVersion ?? ""
        let alert = UIAlertController(
            title: "يتوفر تحديث جديد",
            message: "الإصدار \(latest) متاح الآن — نسختك الحالية ما زالت مدعومة ويمكنك متابعة العمل عليها.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "تحديث التطبيق", style: .default) { _ in
            gate.openAppStore()
        })
        alert.addAction(UIAlertAction(title: "متابعة", style: .cancel))
        top.present(alert, animated: true)
        AppLogger.network.info("soft update alert presented (attempt \(attempt, privacy: .public))")
    }

    /// الشجرة لم تستقر بعد (تبديل شاشات/استعادة جلسة) — إعادة محاولة
    /// محدودة بدل السقوط الصامت؛ وإن تعذر كليًا يُعاد الطلب في الإقلاع
    /// القادم لأن softPromptedVersion في الذاكرة فقط.
    private static func retry(gate: AppVersionGate, attempt: Int) {
        guard attempt < maxAttempts else {
            AppLogger.network.warning("soft update alert: presentation not settled — will re-prompt next launch")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay) {
            present(gate: gate, attempt: attempt + 1)
        }
    }
}

// MARK: - شاشة Force Update (حاجزة — بلا تخطٍّ ولا رجوع)

struct ForceUpdateView: View {
    @ObservedObject var gate: AppVersionGate

    var body: some View {
        ZStack {
            EMSTheme.Colors.navy.ignoresSafeArea()
            VStack(spacing: 18) {
                Image("AppLogoMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 88, height: 88)
                    .accessibilityHidden(true)
                Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(EMSTeal)
                Text("تحديث التطبيق مطلوب")
                    .font(EMSTheme.titleArabic)
                    .foregroundStyle(.white)
                Text(gate.info?.message?.isEmpty == false
                     ? gate.info!.message!
                     : "يتوفر إصدار جديد من التطبيق. يجب تحديث التطبيق للمتابعة.")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                if gate.info?.appStoreUrl.isEmpty == false {
                    EMSPrimaryButton(title: "تحديث التطبيق", isLoading: false) {
                        gate.openAppStore()
                    }
                    .padding(.horizontal, 48)
                    .padding(.top, 6)
                } else {
                    // رابط المتجر يُضبط مركزيًا من السيرفر — حتى تهيئته لا
                    // نظهر زرًا ميتًا على شاشة حاجزة.
                    Text("رابط التحديث غير مهيأ بعد — يرجى التواصل مع الدعم.")
                        .font(.callout)
                        .foregroundStyle(.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 6)
                }
            }
        }
        // لا إغلاق ولا سحب ولا رجوع — إعادة الفحص تتم عند العودة للمقدمة.
        .interactiveDismissDisabled()
    }
}

// MARK: - شاشة تعذّر التحقق / خطأ الإعداد (رسالة + Retry، لا Crash)

struct VersionCheckErrorView: View {
    @ObservedObject var gate: AppVersionGate

    /// 404 بعد نشر المسار = خلل إعداد خادمي — نص مختلف عن فشل الشبكة.
    private var isConfigurationError: Bool { gate.state == .configurationError }

    var body: some View {
        ZStack {
            EMSTheme.Colors.navy.ignoresSafeArea()
            VStack(spacing: 18) {
                Image("AppLogoMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 88, height: 88)
                    .accessibilityHidden(true)
                Image(systemName: isConfigurationError ? "exclamationmark.triangle.fill" : "wifi.exclamationmark")
                    .font(.system(size: 40))
                    .foregroundStyle(EMSTeal)
                Text(isConfigurationError ? "خطأ في إعدادات النظام" : "تعذر التحقق من إصدار التطبيق")
                    .font(EMSTheme.titleArabic)
                    .foregroundStyle(.white)
                Text(isConfigurationError
                     ? "خدمة التحقق من الإصدار غير مهيأة حاليًا. يرجى المحاولة لاحقًا أو التواصل مع الدعم."
                     : "يرجى التأكد من اتصال الإنترنت والمحاولة مرة أخرى.")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                EMSPrimaryButton(title: "إعادة المحاولة", isLoading: false) {
                    Task { await gate.check(force: true) }
                }
                .padding(.horizontal, 48)
                .padding(.top, 6)
            }
        }
        .interactiveDismissDisabled()
    }
}
