//
//  BalootService.swift
//  EMSOperations
//
//  طبقة REST لمنصة البلوت — فوق APIClient الموحد (Bearer + تحديث 401).
//  لا منطق قواعد هنا: كل الحسم على الخادم، والعميل يرسل الأفعال فقط.
//
//  المسارات (server.js — كلها Bearer + صلاحية community.*):
//   GET  /api/baloot/tables                    (community.view)
//   POST /api/baloot/tables                    (community.create_activity)
//   GET  /api/baloot/tables/:id                (community.view)
//   POST /api/baloot/tables/:id/sit            (community.join_activity)
//   POST /api/baloot/tables/:id/leave          (community.view)
//   POST /api/baloot/tables/:id/ready          (community.join_activity)
//   POST /api/baloot/tables/:id/close          (community.create_activity)
//   POST /api/baloot/tables/:id/rematch/*      (community.join_activity)
//   GET  /api/baloot/matches/:id/state         (community.view)
//   GET  /api/baloot/matches/:id/options       (community.view)
//   POST /api/baloot/matches/:id/action        (community.join_activity)
//   POST /api/baloot/matches/:id/vote-abort    (community.view)
//   POST /api/baloot/matches/:id/reconnect     (community.view)
//   GET  /api/baloot/ratings                   (community.view)
//   GET/POST /api/community/rooms/:id/messages (view/post) — سالفة الطاولة
//

import Foundation

@MainActor
final class BalootService {
    static let shared = BalootService()
    private let api = APIClient.shared
    private init() {}

    // MARK: - اللوبي والطاولة

    func listTables() async throws -> [BalootLobbyTableDTO] {
        let res: BalootTablesResponse = try await api.get("/api/baloot/tables")
        return res.tables
    }

    func getTable(_ id: Int) async throws -> BalootTableViewResponse {
        try await api.get("/api/baloot/tables/\(id)")
    }

    /// فتح طاولة — الاستجابة صف DB خام (snake_case وبلا seats)،
    /// لذلك نفك المعرّف فقط ثم يُعاد الجلب عبر GET الكامل.
    func createTable() async throws -> Int {
        struct CreatedTable: Decodable { let id: Int }
        struct Res: Decodable { let success: Bool; let table: CreatedTable }
        let res: Res = try await api.post("/api/baloot/tables", body: EmptyBody())
        return res.table.id
    }

    @discardableResult
    func sit(tableId: Int, seat: Int? = nil) async throws -> Int {
        struct Req: Encodable { let seat: Int? }
        struct Res: Decodable { let success: Bool; let tableId: Int; let seat: Int }
        let res: Res = try await api.post("/api/baloot/tables/\(tableId)/sit", body: Req(seat: seat))
        return res.seat
    }

    func leave(tableId: Int) async throws {
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/tables/\(tableId)/leave")
    }

    func ready(tableId: Int) async throws {
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/tables/\(tableId)/ready")
    }

    func closeTable(tableId: Int) async throws {
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/tables/\(tableId)/close")
    }

    func rematchAccept(tableId: Int) async throws {
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/tables/\(tableId)/rematch/accept")
    }

    func rematchDecline(tableId: Int) async throws {
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/tables/\(tableId)/rematch/decline")
    }

    // MARK: - المباراة

    func matchState(matchId: Int) async throws -> BalootMatchStateResponse {
        try await api.get("/api/baloot/matches/\(matchId)/state")
    }

    func options(matchId: Int) async throws -> BalootOptionsResponse {
        try await api.get("/api/baloot/matches/\(matchId)/options")
    }

    /// فعل لعب — actionId إلزامي (Idempotency): UUID لكل ضغطة، وإعادة
    /// الإرسال بنفس المعرّف آمنة (الخادم يخصم المكرر).
    /// الحمولة بأنواعها الحقيقية (مطابقة baloot-app.js حرفيًا):
    ///   BID {kind, trumpSuit?} · PLAY_CARD {card, baloot:Bool} ·
    ///   DECLARE {projects:[{type,suit?,rank?,topRank?}]} · DOUBLE {kind}
    enum ActionPayload: Encodable {
        case bid(kind: String, trumpSuit: String?)
        case playCard(card: String, baloot: Bool)
        case declare(project: BalootProjectOptionDTO)
        case callDouble(kind: String)

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .bid(let kind, let trumpSuit):
                try c.encode(kind, forKey: .kind)
                try c.encodeIfPresent(trumpSuit, forKey: .trumpSuit)
            case .playCard(let card, let baloot):
                try c.encode(card, forKey: .card)
                if baloot { try c.encode(true, forKey: .baloot) }
            case .declare(let project):
                try c.encode([project], forKey: .projects)
            case .callDouble(let kind):
                try c.encode(kind, forKey: .kind)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case kind, trumpSuit, card, baloot, projects
        }
    }

    func sendAction(matchId: Int, actionId: String, type: String, payload: ActionPayload) async throws {
        struct Req: Encodable {
            let actionId: String
            let type: String
            let payload: ActionPayload
        }
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/matches/\(matchId)/action",
                                        body: Req(actionId: actionId, type: type, payload: payload))
    }

    func voteAbort(matchId: Int) async throws {
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/matches/\(matchId)/vote-abort")
    }

    /// عودة صريحة بعد انقطاع (المسار الطبيعي يتم تلقائيًا عبر اشتراك WS).
    func reconnect(matchId: Int) async throws {
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/baloot/matches/\(matchId)/reconnect")
    }

    // MARK: - التصنيف الشرفي

    func ratings() async throws -> [BalootRatingDTO] {
        let res: BalootRatingsResponse = try await api.get("/api/baloot/ratings")
        return res.ratings
    }

    // MARK: - سالفة الطاولة (غرفة دردشة Community)

    func chatMessages(roomId: Int, sinceId: Int = 0, limit: Int = 50) async throws -> BalootChatListResponse {
        try await api.get("/api/community/rooms/\(roomId)/messages",
                          query: ["since_id": String(sinceId), "limit": String(limit)])
    }

    func sendChatMessage(roomId: Int, content: String) async throws {
        struct Req: Encodable { let content: String }
        struct Res: Decodable { let success: Bool }
        let _: Res = try await api.post("/api/community/rooms/\(roomId)/messages", body: Req(content: content))
    }

    /// جسم فارغ للـPOST بلا حقول (إنشاء طاولة).
    private struct EmptyBody: Encodable {}

    /// رسالة الخطأ الأدق للواجهة — balootError في الخادم يعيد {error} العربية
    /// مع 400/409/403، وAPIError.userMessage يُسقطها في حالة .server.
    nonisolated static func errorMessage(_ error: Error) -> String {
        guard let e = error as? APIError else { return "حدث خطأ غير متوقع." }
        switch e {
        case .badRequest(let m), .serverMessage(let m), .server(let m):
            return m.isEmpty || m.hasPrefix("HTTP ") ? e.userMessage : m
        default:
            return e.userMessage
        }
    }
}
