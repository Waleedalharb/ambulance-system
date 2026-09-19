//
//  APIError.swift
//  EMSOperations
//
//  أخطاء موحدة مفهومة للمستخدم (قسم 28) — لا stack traces في الواجهة.
//

import Foundation

enum APIError: Error, Equatable {
    case unauthenticated          // 401 — الجلسة انتهت
    case forbidden                // 403 — بلا صلاحية ops.my_portal
    case noEmployee               // 404 + code NO_EMPLOYEE
    case notFound
    case badRequest(String)       // 400 برسالة الخادم
    case server(String)           // 5xx
    case serverMessage(String)    // خطأ برسالة الخادم نفسها (مثل 404 «لا بيانات جدول»)
    case offline                  // انقطاع شبكة
    case timeout
    case decoding                 // شكل رد غير متوقع
    case unknown

    /// رسالة عربية واضحة للمستخدم النهائي.
    var userMessage: String {
        switch self {
        case .unauthenticated: return "انتهت الجلسة — سجّل الدخول من جديد."
        case .forbidden: return "لا تملك صلاحية بوابة الموظف. راجع إدارة النظام."
        case .noEmployee: return "هذا الحساب غير مرتبط بملف موظف. راجع إدارة النظام."
        case .notFound: return "العنصر غير موجود."
        case .badRequest(let m): return m.isEmpty ? "بيانات غير مكتملة." : m
        case .server: return "خطأ في الخادم — حاول لاحقًا."
        case .serverMessage(let m): return m
        case .offline: return "تعذر الاتصال بالخادم — تحقق من اتصال الإنترنت وحاول مرة أخرى."
        case .timeout: return "استغرق الطلب وقتًا طويلًا — حاول مرة أخرى."
        case .decoding: return "رد غير متوقع من الخادم."
        case .unknown: return "حدث خطأ غير متوقع."
        }
    }
}
