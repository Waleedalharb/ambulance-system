//
//  SafeCache.swift
//  EMSOperations
//
//  تخزين مؤقت آمن وبسيط (v2 قسم 19/36): JSON في مجلد Caches مع TTL.
//  للعرض دون اتصال فقط — لا توكنات، لا كلمات مرور، لا بيانات حساسة،
//  ولا Offline Database مستقلة لبيانات التشغيل (ممنوع بالمواصفة).
//  مجلد Caches يُطهَّر تلقائيًا من النظام عند الحاجة — مقبول فقدانه.
//

import Foundation

enum SafeCache {
    private static var cacheDir: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("ems-safe-cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private struct Envelope<T: Codable>: Codable {
        let storedAt: Date
        let value: T
    }

    /// يخزن قيمة قابلة للترميز بمفتاح (مثل "profile").
    static func store<T: Codable>(_ value: T, key: String) {
        let envelope = Envelope(storedAt: Date(), value: value)
        guard let data = try? JSONEncoder().encode(envelope) else { return }
        try? data.write(to: cacheDir.appendingPathComponent("\(key).json"), options: .atomic)
    }

    /// يستعيد القيمة إن كانت أحدث من maxAge (ثوانٍ) — غير ذلك nil.
    static func load<T: Codable>(_ type: T.Type, key: String, maxAge: TimeInterval = 3600) -> T? {
        let url = cacheDir.appendingPathComponent("\(key).json")
        guard let data = try? Data(contentsOf: url),
              let envelope = try? JSONDecoder().decode(Envelope<T>.self, from: data),
              Date().timeIntervalSince(envelope.storedAt) <= maxAge
        else { return nil }
        return envelope.value
    }

    /// يستعيد القيمة أيًّا كان عمرها — لحالة «غير متصل» فقط.
    static func loadStale<T: Codable>(_ type: T.Type, key: String) -> T? {
        let url = cacheDir.appendingPathComponent("\(key).json")
        guard let data = try? Data(contentsOf: url),
              let envelope = try? JSONDecoder().decode(Envelope<T>.self, from: data)
        else { return nil }
        return envelope.value
    }

    static func clear() {
        try? FileManager.default.removeItem(at: cacheDir)
    }
}
