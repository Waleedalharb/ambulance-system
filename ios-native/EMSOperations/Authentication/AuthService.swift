//
//  AuthService.swift
//  EMSOperations
//
//  مصادقة Native فوق Backend القائم (قسم 8) — لا نظام دخول جديد.
//  التوكنات في Keychain؛ التحديث عند 401 عبر /api/auth/refresh.
//

import Foundation

actor AuthService {
    static let shared = AuthService()
    private let api = APIClient.shared

    private init() {}

    // MARK: - Login

    func login(username: String, password: String) async throws -> AuthUser {
        let res: LoginResponse = try await api.postPublic(
            "/api/auth/login",
            body: LoginRequest(username: username, password: password))
        persist(access: res.accessToken, refresh: res.refreshToken, user: res.user)
        AppLogger.auth.info("login ok for user id=\(res.user.id ?? "?", privacy: .public)")
        return res.user
    }

    // MARK: - Restore

    /// يعيد المستخدم إن كانت الجلسة حية (أو قابلة للتحديث)، وإلا nil.
    func restore() async -> AuthUser? {
        guard KeychainService.read(.accessToken) != nil else { return nil }
        do {
            // تحقق حي بأخف مسار موثق — profile (يتضمن منطق 401/refresh في APIClient)
            let _: ProfileDTO = try await api.get("/api/my/profile")
            return storedUser()
        } catch APIError.unauthenticated {
            return nil
        } catch {
            // انقطاع شبكة مع جلسة مخزنة: ندخل بالجلسة ونعتمد حالة Offline في الواجهة
            return storedUser()
        }
    }

    // MARK: - Refresh (يُحقن في APIClient)

    /// يعيد accessToken جديدًا أو nil عند فشل التحديث (جلسة ميتة).
    func refreshAccessToken() async -> String? {
        guard let refresh = KeychainService.read(.refreshToken) else { return nil }
        do {
            let res: RefreshResponse = try await api.postPublic(
                "/api/auth/refresh", body: RefreshRequest(refreshToken: refresh))
            _ = KeychainService.save(res.accessToken, for: .accessToken)
            _ = try? KeychainService.save(String(data: JSONEncoder().encode(res.user), encoding: .utf8) ?? "", for: .userJSON)
            return res.accessToken
        } catch {
            AppLogger.auth.warning("refresh failed — session dead")
            return nil
        }
    }

    // MARK: - Logout

    /// فصل الجهاز (بذل قصوى) ← إبطال خادمي ← مسح محلي. لا يرمي أبدًا.
    func logout() async {
        struct Empty: Encodable {}
        try? await { let _: SimpleSuccess = try await api.post("/api/my/push/unregister", body: Optional<Empty>.none) }()
        try? await { let _: SimpleSuccess = try await api.post("/api/auth/logout", body: Optional<Empty>.none) }()
        KeychainService.clearSession()
        AppLogger.auth.info("logout complete")
    }

    // MARK: - Stored

    func storedUser() -> AuthUser? {
        guard let json = KeychainService.read(.userJSON),
              let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(AuthUser.self, from: data)
    }

    func storedAccessToken() -> String? { KeychainService.read(.accessToken) }

    private func persist(access: String, refresh: String, user: AuthUser) {
        _ = KeychainService.save(access, for: .accessToken)
        _ = KeychainService.save(refresh, for: .refreshToken)
        if let data = try? JSONEncoder().encode(user), let json = String(data: data, encoding: .utf8) {
            _ = KeychainService.save(json, for: .userJSON)
        }
    }
}
