//
//  AuthDTO.swift
//  EMSOperations
//
//  نماذج المصادقة — مطابقة حرفية لردود /api/auth/* (API mapping §3).
//

import Foundation

struct LoginRequest: Encodable {
    let username: String
    let password: String
}

struct RefreshRequest: Encodable {
    let refreshToken: String
}

struct AuthUser: Codable, Equatable {
    let id: String?
    let username: String?
    let name: String
    let role: String

    /// id قد يصل رقمًا في بعض الاستجابات — فك مرن.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) }
        else { id = nil }
        username = try? c.decode(String.self, forKey: .username)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        role = (try? c.decode(String.self, forKey: .role)) ?? "user"
    }
}

struct LoginResponse: Decodable {
    let success: Bool
    let accessToken: String
    let refreshToken: String
    let user: AuthUser
}

struct RefreshResponse: Decodable {
    let success: Bool
    let accessToken: String
    let user: AuthUser
}

struct SimpleSuccess: Decodable {
    let success: Bool?
}

// MARK: - /api/auth/me/permissions (permission-service.mePayload — v2 قسم 6)
struct MePermissionsDTO: Decodable {
    let role: String?
    let roleLabel: String?
    let permissions: [String]?
    let permissionsStar: Bool?
    let permissionsGranted: [String]?
    let permissionsRevoked: [String]?

    enum CodingKeys: String, CodingKey {
        case role, permissions
        case roleLabel = "role_label"
        case permissionsStar = "permissions_star"
        case permissionsGranted = "permissions_granted"
        case permissionsRevoked = "permissions_revoked"
    }
}

struct PushRegisterRequest: Encodable {
    let token: String
    let platform: String
    let environment: String
    let appVersion: String?
}

struct PushRegisterResponse: Decodable {
    let success: Bool?
    let registered: Bool?
    let environment: String?
}
