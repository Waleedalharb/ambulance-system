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

    enum Method: String { case get = "GET", post = "POST", put = "PUT", delete = "DELETE" }

    // MARK: - Public

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await send(.get, path, query: query, body: nil as String?, authorized: true, retried: false)
    }

    func post<T: Decodable>(_ path: String, body: (some Encodable)? = nil) async throws -> T {
        try await send(.post, path, query: [:], body: body, authorized: true, retried: false)
    }

    /// POST بلا جسم — النوع المعتم في البديل الآخر لا يُستنتج من `= nil`.
    func post<T: Decodable>(_ path: String) async throws -> T {
        try await send(.post, path, query: [:], body: nil as String?, authorized: true, retried: false)
    }

    /// طلب بلا مصادقة (login/refresh فقط).
    func postPublic<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        try await send(.post, path, query: [:], body: body, authorized: false, retried: false)
    }

    /// PUT بنفس قواعد post (تعديل خلية الجدول ونحوها).
    func put<T: Decodable>(_ path: String, body: (some Encodable)? = nil) async throws -> T {
        try await send(.put, path, query: [:], body: body, authorized: true, retried: false)
    }

    /// POST/PUT بترويسات إضافية — قفل رموز الجداول يتطلب x-symbols-unlock
    /// (server.js requireSymbolsUnlock). الترويسة تُمرَّر كما هي؛ لا قيمة
    /// افتراضية ولا تخزين في العميل.
    func post<T: Decodable>(_ path: String, body: (some Encodable)? = nil, headers: [String: String]) async throws -> T {
        try await send(.post, path, query: [:], body: body, authorized: true, retried: false, extraHeaders: headers)
    }

    func put<T: Decodable>(_ path: String, body: (some Encodable)? = nil, headers: [String: String]) async throws -> T {
        try await send(.put, path, query: [:], body: body, authorized: true, retried: false, extraHeaders: headers)
    }

    /// DELETE بلا جسم (حذف سجل جدول ونحوه).
    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await send(.delete, path, query: [:], body: nil as String?, authorized: true, retried: false)
    }

    // MARK: - رفع multipart (ملفات تشغيلية §22 · مرفقات الدردشة §19)

    /// ملف واحد ضمن طلب multipart/form-data.
    struct UploadFile {
        let data: Data
        let filename: String
        let mimeType: String
    }

    /// POST multipart/form-data بنفس قواعد send (Bearer، مهلة، تحديث واحد
    /// عند 401، فك أخطاء {error}). fileField هو اسم الحقل الذي يتوقعه multer
    /// ("files" للتشغيلية، "file" للدردشة)؛ fields حقول نصية إضافية.
    func upload<T: Decodable>(_ path: String, fileField: String, files: [UploadFile],
                              fields: [String: String] = [:]) async throws -> T {
        try await sendUpload(path, fileField: fileField, files: files, fields: fields, retried: false)
    }

    private func sendUpload<T: Decodable>(_ path: String, fileField: String, files: [UploadFile],
                                          fields: [String: String], retried: Bool) async throws -> T {
        guard let url = URLComponents(url: AppEnvironment.current.baseURL.appending(path: path), resolvingAgainstBaseURL: false)?.url else {
            throw APIError.unknown
        }
        let boundary = "EMSBoundary-\(UUID().uuidString)"
        var body = Data()
        for (name, value) in fields {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8))
            body.append(Data("\(value)\r\n".utf8))
        }
        for file in files {
            // الأسماء العربية تُرسل بصيغة RFC 5987 (filename*) مع بديل ASCII —
            // busboy يفك filename* فيحفظ originalname سليمًا.
            let asciiFallback = file.filename.unicodeScalars
                .map { $0.isASCII && $0 != "\"" ? String($0) : "_" }.joined()
            let encoded = file.filename.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? asciiFallback
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(asciiFallback)\"; filename*=UTF-8''\(encoded)\r\n".utf8))
            body.append(Data("Content-Type: \(file.mimeType)\r\n\r\n".utf8))
            body.append(file.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = tokenProvider?() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = body

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
            switch e.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed: throw APIError.offline
            case .timedOut: throw APIError.timeout
            default: throw APIError.offline
            }
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        #if DEBUG
        AppLogger.network.info("POST \(path, privacy: .public) → HTTP \(http.statusCode) (multipart \(files.count) file(s))")
        #endif
        switch http.statusCode {
        case 200...299:
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                AppLogger.network.error("decoding failed for \(path, privacy: .public) (multipart)")
                throw APIError.decoding
            }
        case 401:
            if !retried, let refresh = refreshHandler, let newToken = await refresh() {
                _ = newToken
                return try await sendUpload(path, fileField: fileField, files: files, fields: fields, retried: true)
            }
            throw APIError.unauthenticated
        case 403:
            throw APIError.forbidden
        case 404:
            throw APIError.notFound
        case 400:
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw APIError.badRequest(msg)
        default:
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(http.statusCode)"
            throw APIError.server(msg)
        }
    }

    // MARK: - JSON خام (قوائم حرة الحقول: ملاحظات/غيابات المناوبة)
    // الاستبدال الجماعي لهذه القوائم يقتضي حفظ الحقول غير المعروفة حرفيًا —
    // فكّ DTO انتقائي ثم إعادة ترميز كان سيُسقط حقولًا يملكها الويب.

    /// GET خام — يعيد الكائن المفكوك كما هو (Dictionary/Array).
    func getRaw(_ path: String) async throws -> Any {
        try await sendRaw(.get, path, jsonBody: nil, retried: false)
    }

    /// POST بجسم JSON خام — يعيد الكائن المفكوك كما هو.
    func postRaw(_ path: String, jsonObject: Any) async throws -> Any {
        try await sendRaw(.post, path, jsonBody: jsonObject, retried: false)
    }

    /// PUT بجسم JSON خام (دمج خطط الذروة الحرة الحقول).
    func putRaw(_ path: String, jsonObject: Any) async throws -> Any {
        try await sendRaw(.put, path, jsonBody: jsonObject, retried: false)
    }

    private func sendRaw(_ method: Method, _ path: String, jsonBody: Any?, retried: Bool) async throws -> Any {
        guard let url = URLComponents(url: AppEnvironment.current.baseURL.appending(path: path), resolvingAgainstBaseURL: false)?.url else {
            throw APIError.unknown
        }
        var req = URLRequest(url: url)
        req.httpMethod = method.rawValue
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let jsonBody {
            req.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token = tokenProvider?() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
            switch e.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed: throw APIError.offline
            case .timedOut: throw APIError.timeout
            default: throw APIError.offline
            }
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        #if DEBUG
        AppLogger.network.info("\(method.rawValue, privacy: .public) \(path, privacy: .public) → HTTP \(http.statusCode) (raw)")
        #endif
        switch http.statusCode {
        case 200...299:
            return (try? JSONSerialization.jsonObject(with: data)) ?? [:]
        case 401:
            if !retried, let refresh = refreshHandler, let newToken = await refresh() {
                _ = newToken
                return try await sendRaw(method, path, jsonBody: jsonBody, retried: true)
            }
            throw APIError.unauthenticated
        case 403:
            throw APIError.forbidden
        case 404:
            throw APIError.notFound
        case 400:
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw APIError.badRequest(msg)
        default:
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(http.statusCode)"
            throw APIError.server(msg)
        }
    }

    // MARK: - تنزيل ثنائي (PDF/Excel) — قراءة فقط

    /// ملف منزَّل من الخادم مع بيانات وصفية من الترويسات.
    struct DownloadedFile {
        let data: Data
        let filename: String?
        let mimeType: String?
    }

    /// تنزيل ثنائي بنفس قواعد send (مصادقة، مهلة، تحديث واحد عند 401).
    /// يُستخدم لتصدير PDF الجداول — لا يُفك كـJSON إطلاقًا.
    func download(_ path: String, query: [String: String] = [:]) async throws -> DownloadedFile {
        try await sendDownload(path, query: query, retried: false)
    }

    private func sendDownload(_ path: String, query: [String: String], retried: Bool) async throws -> DownloadedFile {
        var comps = URLComponents(url: AppEnvironment.current.baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { comps?.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = comps?.url else { throw APIError.unknown }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        if let token = tokenProvider?() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError {
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

        #if DEBUG
        AppLogger.network.info("GET \(path, privacy: .public) → HTTP \(http.statusCode) (download \(data.count) bytes)")
        #endif

        switch http.statusCode {
        case 200...299:
            let filename = Self.contentDispositionFilename(http.value(forHTTPHeaderField: "Content-Disposition"))
            return DownloadedFile(data: data, filename: filename, mimeType: http.value(forHTTPHeaderField: "Content-Type"))
        case 401:
            if !retried, let refresh = refreshHandler, let newToken = await refresh() {
                _ = newToken
                return try await sendDownload(path, query: query, retried: true)
            }
            throw APIError.unauthenticated
        case 403:
            throw APIError.forbidden
        case 404:
            throw APIError.notFound
        default:
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "HTTP \(http.statusCode)"
            throw APIError.server(msg)
        }
    }

    /// اسم الملف من Content-Disposition (filename*=UTF-8''… أو filename="…").
    private static func contentDispositionFilename(_ header: String?) -> String? {
        guard let header else { return nil }
        if let range = header.range(of: "filename\\*=UTF-8''", options: .regularExpression) {
            let raw = String(header[range.upperBound...])
            return raw.removingPercentEncoding
        }
        if let range = header.range(of: "filename=\"([^\"]+)\"", options: .regularExpression) {
            return String(header[range.upperBound...]).replacingOccurrences(of: "\"", with: "")
        }
        return nil
    }

    // MARK: - Core

    private func send<T: Decodable, B: Encodable>(
        _ method: Method, _ path: String, query: [String: String],
        body: B?, authorized: Bool, retried: Bool, extraHeaders: [String: String] = [:]
    ) async throws -> T {
        var comps = URLComponents(url: AppEnvironment.current.baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { comps?.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = comps?.url else { throw APIError.unknown }

        var req = URLRequest(url: url)
        req.httpMethod = method.rawValue
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        for (key, value) in extraHeaders { req.setValue(value, forHTTPHeaderField: key) }
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

        #if DEBUG
        AppLogger.network.info("\(method.rawValue, privacy: .public) \(path, privacy: .public) → HTTP \(http.statusCode)")
        #endif

        switch http.statusCode {
        case 200...299:
            do {
                let decoded = try JSONDecoder().decode(T.self, from: data)
                #if DEBUG
                AppLogger.network.info("decode OK \(path, privacy: .public) — \(data.count) bytes")
                #endif
                return decoded
            }
            catch {
                AppLogger.network.error("decoding failed for \(path, privacy: .public)")
                #if DEBUG
                AppLogger.network.error("decode detail \(path, privacy: .public): \(AppLogger.redact(String(describing: error)), privacy: .public)")
                #endif
                throw APIError.decoding
            }
        case 401:
            // D4: تحديث واحد ثم إعادة واحدة — غير ذلك الجلسة ميتة
            if authorized, !retried, let refresh = refreshHandler, let newToken = await refresh() {
                _ = newToken
                return try await send(method, path, query: query, body: body, authorized: authorized, retried: true, extraHeaders: extraHeaders)
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
