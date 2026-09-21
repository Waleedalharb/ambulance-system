//
//  AppLogger.swift
//  EMSOperations
//
//  تسجيل تشخيصي عبر OSLog بفئات (قسم 28). ممنوع تسريب توكنات/كلمات
//  مرور — المرشّح يطمس الأنماط الشائعة قبل الطبع (قسم 29).
//

import Foundation
import OSLog

enum AppLogger {
    static let auth = Logger(subsystem: "online.emsoperations.app", category: "auth")
    static let network = Logger(subsystem: "online.emsoperations.app", category: "network")
    static let push = Logger(subsystem: "online.emsoperations.app", category: "push")
    static let ui = Logger(subsystem: "online.emsoperations.app", category: "ui")

    /// طمس حسّاس: توكنات JWT وكلمات مرور وتوكنات أجهزة (64+ hex).
    static func redact(_ text: String) -> String {
        var out = text
        let patterns = [
            #"(eyJ[A-Za-z0-9_\-\.]{10,})"#,         // JWT
            #"([A-Fa-f0-9]{64,})"#,                  // device tokens / hashes
            #"(?i)(password[\"'\s:=]+)[^\"'\s,}]+"#  // password=… (يبقي المفتاح، يطمس القيمة)
        ]
        for p in patterns {
            if let rx = try? NSRegularExpression(pattern: p) {
                out = rx.stringByReplacingMatches(
                    in: out, range: NSRange(out.startIndex..., in: out),
                    withTemplate: "•••")
            }
        }
        return out
    }
}
