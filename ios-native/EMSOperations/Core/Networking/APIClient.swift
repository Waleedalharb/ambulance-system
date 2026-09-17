//
//  APIClient.swift
//  EMSOperations
//
//  طبقة الشبكة الموحدة (قسم 24) — لا URLSession في أي شاشة.
//  - Bearer تلقائي من مزوّد التوكن (SessionStore).
//  - عند 401: محاولة تحديث واحدة عبر /api/auth/refresh ثم إعادة الطلب مرة (D4).
//  - timeout 20 ثانية · لا polling · لا retry عدواني.
//  - فك الأخطاء العربية من جسم الرد {error: "…"}.
//

import Foundation

actor APIClient {
    static let shared = APIClient()

    private let session: URLSession
    /// مزوّد التوكن يُحقن من SessionStore عند الإقلاع (كسر الاعتماد الدائري).
    nonisolated(unsafe) var tokenProvider: (@Sendable () -> String?)?
    /// مُحدّث الجلسة عند 401 — يعيد توكنًا جديدًا أو nil (يُحقن من AuthService).
    nonisolated(unsafe) var refreshHandler: (@Sendable () async -> String?)?

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 40
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg)
    }

    enum Method: String { case get = "GET", post = "POST" }

    // MARK: - Public

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await send(.get, path, query: query, body: nil as String?, authorized: true, retried: false)
    }

    func post<T: Decodable>(_ path: String, body: (some Encodable)? = nil) async throws -> T {
        try await send(.post, path, query: [:], body: body, authorized: true, retried: false)
    }

    /// طلب بلا مصادقة (login/refresh فقط).
    func postPublic<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        try await send(.post, path, query: [:], body: body, authorized: false, retried: false)
    }

    // MARK: - Core

    private func send<T: Decodable, B: Encodable>(
        _ method: Method, _ path: String, query: [String: String],
        body: B?, authorized: Bool, retried: Bool
    ) async throws -> T {
        var comps = URLComponents(url: AppEnvironment.current.baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { comps?.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = comps?.url else { throw APIError.unknown }

        var req = URLRequest(url: url)
        req.httpMethod = method.rawValue
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = try JSONEncoder().encode(body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token = tokenProvider?() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
            AppLogger.network.warning("network error \(AppLogger.redact(e.localizedDescription), privacy: .public)")
            switch e.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                throw APIError.offline
            case .timedOut:
                throw APIError.timeout
            default:
                throw APIError.offline
            }
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }

        switch http.statusCode {
        case 200...299:
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch {
                AppLogger.network.error("decoding failed for \(path, privacy: .public)")
                throw APIError.decoding
            }
        case 401:
            // D4: تحديث واحد ثم إعادة واحدة — غير ذلك الجلسة ميتة
            if authorized, !retried, let refresh = refreshHandler, let newToken = await refresh() {
                _ = newToken
                return try await send(method, path, query: query, body: body, authorized: authorized, retried: true)
            }
            throw APIError.unauthenticated
        case 403:
            throw APIError.forbidden
        case 404:
            if let code = try? JSONDecoder().decode([String: String].self, from: data), code["code"] == "NO_EMPLOYEE" {
                throw APIError.noEmployee
            }
            throw APIError.notFound
        case 400:
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw APIError.badRequest(msg)
        default:
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(http.statusCode)"
            throw APIError.server(msg)
        }
    }
}
