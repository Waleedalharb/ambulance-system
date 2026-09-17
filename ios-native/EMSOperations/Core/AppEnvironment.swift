//
//  AppEnvironment.swift
//  EMSOperations
//
//  البيئات (قسم 25): الإنتاج ثابت، والتبديل للتطوير فقط عبر إعداد مخفي
//  (DEBUG builds فقط). لا secrets هنا إطلاقًا — مجرد عناوين عامة.
//

import Foundation

enum AppEnvironment: String, CaseIterable {
    case development
    case production

    var baseURL: URL {
        switch self {
        case .production: return URL(string: "https://emsoperations.online")!
        case .development: return URL(string: "http://localhost:3000")!
        }
    }

    var displayName: String { self == .production ? "Production" : "Development" }

    /// بيئة APNs المطابقة لعمود push_devices.environment (قرار D7).
    var apnsEnvironment: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }

    /// البيئة الفعلية: Production دائمًا في نسخ الإصدار؛ في DEBUG يمكن
    /// تجاوزها محليًا من إعدادات المطور داخل التطبيق.
    static var current: AppEnvironment {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "debug_use_dev_server") { return .development }
        #endif
        return .production
    }
}
