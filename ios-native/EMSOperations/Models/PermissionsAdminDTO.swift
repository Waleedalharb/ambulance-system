//
//  PermissionsAdminDTO.swift
//  EMSOperations
//
//  نماذج إدارة الصلاحيات الفردية (§2) — مطابقة لمعالجات server.js
//  (permissions/*) وconfig/permissions.js وpermission-service.js.
//  كلها admin.users_manage سيرفريًا؛ منع تعديل الحساب الذاتي على الخادم.
//

import Foundation

// MARK: - GET /api/permissions/catalog → {success, permissions: {key: {label, domain}}, roles: {role: label}}
struct PermissionMetaDTO: Decodable {
    let label: String?
    let domain: String?
}

struct PermissionsCatalogDTO: Decodable {
    let success: Bool?
    let permissions: [String: PermissionMetaDTO]?
    let roles: [String: String]?
}

// MARK: - GET /api/permissions/users → {success, users[]}
struct PermUserRowDTO: Decodable, Identifiable {
    let id: String
    let username: String?
    let name: String?
    let role: String?
    let roleLabel: String?
    let isActive: Bool?
    let overrides: OverridesCount?

    struct OverridesCount: Decodable {
        let grants: Int?
        let revokes: Int?
    }

    private enum CodingKeys: String, CodingKey {
        case id, username, name, role, isActive, overrides
        case roleLabel = "role_label"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) }
        else { id = UUID().uuidString }
        username = try? c.decode(String.self, forKey: .username)
        name = try? c.decode(String.self, forKey: .name)
        role = try? c.decode(String.self, forKey: .role)
        roleLabel = try? c.decode(String.self, forKey: .roleLabel)
        isActive = try? c.decode(Bool.self, forKey: .isActive)
        overrides = try? c.decode(OverridesCount.self, forKey: .overrides)
    }
}

struct PermUsersResponseDTO: Decodable {
    let success: Bool?
    let users: [PermUserRowDTO]?
}

// MARK: - GET /api/permissions/user/:userId
/// {success, user, ...mePayload (permission-service.js:130), overrides[]}
struct PermOverrideRowDTO: Decodable, Identifiable {
    let id: Int?
    let userId: String?
    let permission: String?
    let granted: Int?          // SQLite 1/0

    private enum CodingKeys: String, CodingKey {
        case id, granted
        case userId = "user_id"
        case permission
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decode(Int.self, forKey: .id)
        // user_id قد يخزَّن نصًا أو رقمًا حسب مصدر المستخدم — فك مرن.
        if let s = try? c.decode(String.self, forKey: .userId) { userId = s }
        else if let n = try? c.decode(Int.self, forKey: .userId) { userId = String(n) }
        else { userId = nil }
        permission = try? c.decode(String.self, forKey: .permission)
        granted = try? c.decode(Int.self, forKey: .granted)
    }
}

struct PermUserDetailDTO: Decodable {
    let success: Bool?
    let user: UserRef?
    let role: String?
    let roleLabel: String?
    let permissions: [String]?
    let permissionsStar: Bool?
    let permissionsGranted: [String]?
    let permissionsRevoked: [String]?
    let overrides: [PermOverrideRowDTO]?

    struct UserRef: Decodable {
        let id: String?
        let name: String?
        let role: String?

        private enum CodingKeys: String, CodingKey { case id, name, role }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let s = try? c.decode(String.self, forKey: .id) { id = s }
            else if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) }
            else { id = nil }
            name = try? c.decode(String.self, forKey: .name)
            role = try? c.decode(String.self, forKey: .role)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case success, user, role, permissions, overrides
        case roleLabel = "role_label"
        case permissionsStar = "permissions_star"
        case permissionsGranted = "permissions_granted"
        case permissionsRevoked = "permissions_revoked"
    }

    /// مفاتيح عليها استثناء صريح (منح أو سحب) — لتمييزها عن افتراضي الدور.
    var overriddenKeys: Set<String> {
        Set((overrides ?? []).compactMap { $0.permission })
    }
}

// MARK: - جسم منح/سحب/إعادة — grant/revoke/clear (user_id نصي: id أو username)
struct PermActionBody: Encodable {
    let user_id: String
    let permission: String
}
