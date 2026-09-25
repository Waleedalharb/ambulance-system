//
//  BalootModels.swift
//  EMSOperations
//
//  نماذج البلوت (D3-iOS) — فكّ حرفي لاستجابات الخادم فقط.
//  لا قواعد لعب هنا إطلاقًا: الخادم (sa-standard-1.0) هو المصدر الوحيد
//  للحقيقة، والعميل يعرض ما يصله ويرسل الأفعال ليحكم عليها الخادم.
//
//  المصادر المرجعية (الخادم):
//   - services/baloot/baloot-projection.js  (forPlayer/forSpectator/lobbyTable)
//   - services/baloot/baloot-match-service.js (optionsFor)
//   - server.js — مسارات /api/baloot/* ورسائل baloot_* عبر /ws
//

import Foundation

// MARK: - الورقة

/// ورقة بصيغة العرض العربية كما يعيدها الخادم: {code, suit, rank}
/// code حرفان: الزات (S/H/D/C) + الرتبة (7..9,T,J,Q,K,A) — مثل "HA".
struct BalootCardDTO: Decodable, Equatable, Hashable {
    let code: String
    let suit: String?
    let rank: String?

    /// رمز الزات للعرض (♠︎♥︎♦︎♣︎).
    var suitSymbol: String {
        guard let c = code.first else { return "؟" }
        switch c {
        case "S": return "♠︎"
        case "H": return "♥︎"
        case "D": return "♦︎"
        case "C": return "♣︎"
        default: return "؟"
        }
    }

    /// الزات الحمراء (هاص/ديمن) لتمييز اللون بصريًا.
    var isRed: Bool { code.first == "H" || code.first == "D" }

    /// اسم الرتبة المعروض — نعتمد تسمية الخادم ونرجع للحرف عند غيابها.
    var rankLabel: String { rank ?? (code.count > 1 ? String(code.dropFirst()) : code) }
}

// MARK: - اللوبي والطاولة

/// مقعد في بطاقة طاولة اللوبي (projection.lobbyTable).
struct BalootLobbySeatDTO: Decodable, Equatable {
    let seat: Int
    let occupied: Bool
    let name: String?
    let disconnected: Bool?
}

/// بطاقة طاولة في مجلس البلوت.
struct BalootLobbyTableDTO: Decodable, Equatable, Identifiable {
    let id: Int
    let status: String
    let rulesetVersion: String?
    let targetScore: Int?
    let seats: [BalootLobbySeatDTO]
    let createdBy: String?
    let createdAt: String?
    /// roomId يظهر في عرض الطاولة المفرد فقط (سالفة الطاولة).
    let roomId: Int?

    var occupiedCount: Int { seats.filter { $0.occupied }.count }
    var isOpen: Bool { status == "open" }
    var isInMatch: Bool { status == "in_match" }
    var isPostMatch: Bool { status == "post_match" }
}

struct BalootTablesResponse: Decodable {
    let success: Bool
    let tables: [BalootLobbyTableDTO]
}

/// عرض الطاولة المفرد: {success, table, mySeat, activeMatchId, rematch}
struct BalootTableViewResponse: Decodable {
    let success: Bool
    let table: BalootLobbyTableDTO
    let mySeat: Int?
    let activeMatchId: Int?
    let rematch: BalootRematchDTO?
}

/// حالة الريماچ عند post_match: {accepts: [userId]} (قرار: موافقة الأربعة، ورفض واحد يلغي).
struct BalootRematchDTO: Decodable, Equatable {
    let accepts: [String]?
}

// MARK: - حالة المباراة (Projection)

struct BalootScoresDTO: Decodable, Equatable {
    let A: Int
    let B: Int
}

struct BalootSeatInfoDTO: Decodable, Equatable {
    let seat: Int
    let team: String
    let name: String?
}

/// مشروع مكشوف (بعد الحسم فقط — المُعلن قبل الكشف يبقى خاصًا بصاحبه).
struct BalootPublicProjectDTO: Decodable, Equatable {
    let seat: Int
    let type: String
}

struct BalootDeclarationsDTO: Decodable, Equatable {
    let resolved: Bool
    let winnerTeam: String?
    let tieBreak: String?
    let projects: [BalootPublicProjectDTO]?
    /// مقاعد البلوت المثبت.
    let baloot: [Int]?
}

struct BalootContractDTO: Decodable, Equatable {
    let type: String?
    let trumpSuit: String?
    let buyerSeat: Int?
    let viaAshkal: Bool?
}

struct BalootBidDTO: Decodable, Equatable {
    let seat: Int?
    let kind: String
    let trumpSuit: String?
}

struct BalootTrickPlayDTO: Decodable, Equatable {
    let seat: Int
    let card: BalootCardDTO
}

struct BalootLastTrickDTO: Decodable, Equatable {
    let winnerSeat: Int
    let plays: [BalootTrickPlayDTO]
}

/// طور اليد — للاعب تصل myHand، وللمشاهد لا تصل إطلاقًا (A7).
struct BalootHandDTO: Decodable, Equatable {
    let phase: String
    let dealerSeat: Int?
    let biddingTurn: Int?
    let faceUpCard: BalootCardDTO?
    let bids: [BalootBidDTO]?
    let contract: BalootContractDTO?
    /// الدبل — شكل حر من المحرك (kind/multiplier/qahwa…) يُعرض وجوده فقط.
    let double: BalootDoubleDTO?
    let declarations: BalootDeclarationsDTO?
    /// يدي أنا (لاعب فقط) — غائبة تمامًا في projection المشاهد.
    let myHand: [BalootCardDTO]?
    /// عدّادات أيدي الآخرين — مفاتيح نصية "0".."3".
    let handCounts: [String: Int]?
    let currentTrick: [BalootTrickPlayDTO]?
    let tricksCount: Int?
    let lastTrick: BalootLastTrickDTO?
    let turnSeat: Int?
    let mySeat: Int?
}

struct BalootDoubleDTO: Decodable, Equatable {
    let kind: String?
    let multiplier: Int?
    let qahwa: Bool?
}

/// جسم الحالة المشترك بين REST وWS — projection كاملًا.
struct BalootMatchStateDTO: Decodable, Equatable {
    let rulesetVersion: String?
    let targetScore: Int?
    let scores: BalootScoresDTO?
    let handNumber: Int?
    let status: String?
    let winner: String?
    let seq: Int?
    let seats: [BalootSeatInfoDTO]?
    let hand: BalootHandDTO?
}

/// غلاف GET /api/baloot/matches/:id/state
struct BalootMatchStateResponse: Decodable {
    let success: Bool
    let matchId: Int
    let tableId: Int?
    let paused: Bool?
    let status: String?
    let state: BalootMatchStateDTO
}

// MARK: - «خياراتي الآن» (optionsFor) — الواجهة لا تعرف القواعد

struct BalootBidOptionDTO: Decodable, Equatable, Hashable {
    let kind: String
    let trumpSuit: String?
}

struct BalootProjectOptionDTO: Codable, Equatable, Hashable {
    let type: String
    let suit: String?
    let rank: String?
    let topRank: String?
}

struct BalootOptionsResponse: Decodable, Equatable {
    let success: Bool?
    let phase: String
    let status: String
    let paused: Bool
    let mySeat: Int
    let myTurn: Bool
    let bids: [BalootBidOptionDTO]
    /// الأوراق المسموح لعبها فقط (رموز حرفين).
    let cards: [String]
    /// الأوراق التي يجوز معها إعلان بلوت.
    let balootCards: [String]
    let projects: [BalootProjectOptionDTO]
    let doubles: [String]
}

// MARK: - التصنيف الشرفي

/// معرّف مستخدم قد يصل رقمًا أو نصًا (users.id رقمي في بعض المسارات) — فكّ مرن موحّد.
enum BalootFlexibleID {
    static func decode<K: CodingKey>(from container: KeyedDecodingContainer<K>, key: K) -> String {
        if let s = try? container.decode(String.self, forKey: key) { return s }
        if let n = try? container.decode(Int.self, forKey: key) { return String(n) }
        return ""
    }
}

struct BalootRatingDTO: Decodable, Equatable, Identifiable {
    var id: String { userId }
    let userId: String
    let name: String?
    let matches: Int
    let wins: Int
    let losses: Int
    let honorPoints: Int

    enum CodingKeys: String, CodingKey { case userId, name, matches, wins, losses, honorPoints }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = BalootFlexibleID.decode(from: c, key: .userId)
        name = try? c.decode(String.self, forKey: .name)
        matches = (try? c.decode(Int.self, forKey: .matches)) ?? 0
        wins = (try? c.decode(Int.self, forKey: .wins)) ?? 0
        losses = (try? c.decode(Int.self, forKey: .losses)) ?? 0
        honorPoints = (try? c.decode(Int.self, forKey: .honorPoints)) ?? 0
    }
}

struct BalootRatingsResponse: Decodable {
    let success: Bool
    let ratings: [BalootRatingDTO]
}

// MARK: - سالفة الطاولة (غرفة دردشة Community — kind=table)

struct BalootChatAuthorDTO: Decodable, Equatable {
    let userId: String
    let displayName: String

    enum CodingKeys: String, CodingKey { case userId, displayName }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = BalootFlexibleID.decode(from: c, key: .userId)
        displayName = (try? c.decode(String.self, forKey: .displayName)) ?? ""
    }
}

struct BalootChatMessageDTO: Decodable, Equatable, Identifiable {
    let id: Int
    let content: String
    let createdAt: String
    let author: BalootChatAuthorDTO
    let mine: Bool
}

struct BalootChatListResponse: Decodable {
    let success: Bool
    let roomStatus: String?
    let messages: [BalootChatMessageDTO]
    /// أعلى id وصل العميل — سعر المزامنة التالي (since_id).
    let lastId: Int?
}

// MARK: - رسائل WebSocket (baloot_*)

/// رسالة واردة من /ws لمواضيع baloot:* — فكّ موحد ثم توزيع بالنوع.
enum BalootWSMessage: Decodable {
    case subscribed(topic: String, role: String?)
    case error(topic: String?, code: String?, message: String?)
    /// تحديث مباراة: لقطة projection كاملة حسب دور المستلم + أحداث + عداد مشاهدين.
    case match(matchId: Int, seq: Int?, events: [BalootWSEvent], state: BalootMatchStateDTO, paused: Bool, status: String?, spectators: Int?)
    /// حدث طاولة (جلوس/جاهزية/اكتمال…) — يستدعي إعادة جلب عرض الطاولة.
    case table(tableId: Int, events: [BalootWSEvent])
    /// حدث لوبي — يستدعي تحديث قائمة الطاولات.
    case lobby(tableId: Int?, events: [BalootWSEvent])
    case other(String)

    private enum CodingKeys: String, CodingKey {
        case type, topic, role, code, error, matchId, tableId, seq, events, state, paused, status, spectators
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? ""
        switch type {
        case "baloot_subscribed":
            self = .subscribed(topic: (try? c.decode(String.self, forKey: .topic)) ?? "",
                               role: try? c.decode(String.self, forKey: .role))
        case "baloot_error":
            self = .error(topic: try? c.decode(String.self, forKey: .topic),
                          code: try? c.decode(String.self, forKey: .code),
                          message: try? c.decode(String.self, forKey: .error))
        case "baloot_match":
            self = .match(matchId: try c.decode(Int.self, forKey: .matchId),
                          seq: try? c.decode(Int.self, forKey: .seq),
                          events: (try? c.decode([BalootWSEvent].self, forKey: .events)) ?? [],
                          state: try c.decode(BalootMatchStateDTO.self, forKey: .state),
                          paused: (try? c.decode(Bool.self, forKey: .paused)) ?? false,
                          status: try? c.decode(String.self, forKey: .status),
                          spectators: try? c.decode(Int.self, forKey: .spectators))
        case "baloot_table":
            self = .table(tableId: try c.decode(Int.self, forKey: .tableId),
                          events: (try? c.decode([BalootWSEvent].self, forKey: .events)) ?? [])
        case "baloot_lobby":
            self = .lobby(tableId: try? c.decode(Int.self, forKey: .tableId),
                          events: (try? c.decode([BalootWSEvent].self, forKey: .events)) ?? [])
        default:
            self = .other(type)
        }
    }
}

/// حدث خام داخل رسائل البث — حقول حرة (نوع + مقعد/تفاصيل حسب النوع).
struct BalootWSEvent: Decodable, Equatable {
    let type: String
    let seat: Int?
    let team: String?
    let kind: String?
    let contract: BalootContractDTO?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        type = (try? c.decode(String.self, forKey: DynamicKey("type"))) ?? ""
        seat = try? c.decode(Int.self, forKey: DynamicKey("seat"))
        team = try? c.decode(String.self, forKey: DynamicKey("team"))
        kind = try? c.decode(String.self, forKey: DynamicKey("kind"))
        contract = try? c.decode(BalootContractDTO.self, forKey: DynamicKey("contract"))
    }

    struct DynamicKey: CodingKey {
        var stringValue: String
        var intValue: Int?
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.init(stringValue) }
        init?(intValue: Int) { return nil }
    }
}

// MARK: - تسميات العرض العربية (نفس معجم baloot-app.js — لا اختراع)

enum BalootLabels {
    static let project: [String: String] = [
        "sara": "سيرا", "khamsin": "خمسين", "miya": "مية", "arba": "أربعمية"
    ]
    static let double: [String: String] = [
        "dabal": "دبل ×2", "thri": "ثري ×3", "fur": "فور ×4", "qahwa": "قهوة ☕"
    ]
    static let bidKind: [String: String] = [
        "sun": "صن", "pass": "بس", "hokum": "حكم", "ashkal": "أشكل"
    ]
    static let bidHint: [String: String] = [
        "sun": "بلا زات حكم؛ الورق بقوته العادية",
        "hokum": "زات الحكم أقوى من الكل",
        "pass": "مرور بدون شراء",
        "ashkal": "الورقة المكشوفة لشريكك، صن إجباري"
    ]
    static let suitName: [String: String] = [
        "S": "سبيت", "H": "هاص", "D": "ديمن", "C": "شيريا"
    ]
    static let suitSymbol: [String: String] = [
        "S": "♠︎", "H": "♥︎", "D": "♦︎", "C": "♣︎"
    ]

    static func contract(_ c: BalootContractDTO?) -> String {
        guard let c, let type = c.type else { return "—" }
        if type == "sun" { return "صن" }
        let sym = c.trumpSuit.flatMap { suitSymbol[$0] } ?? ""
        let nm = c.trumpSuit.flatMap { suitName[$0] } ?? ""
        return "حكم \(sym) \(nm)".trimmingCharacters(in: .whitespaces)
    }

    /// سطر توجيهي لحدث بث — nil يعني «لا يُعرض» (أحداث داخلية).
    static func eventLine(_ ev: BalootWSEvent, seatName: (Int) -> String) -> String? {
        let n = { (s: Int?) in s.map(seatName) ?? "؟" }
        switch ev.type {
        case "seat_taken": return "\(n(ev.seat)) جلس"
        case "player_ready": return "\(n(ev.seat)) جاهز ✓"
        case "table_full": return "اكتملت الطاولة — تأكيد الجاهزية"
        case "bid": return ev.kind == "pass" ? "\(n(ev.seat)): بس" : nil
        case "bidding_round2": return "بسّ الجميع — جولة ثانية"
        case "redeal": return "بسّ الجميع مرتين — إعادة توزيع"
        case "contract":
            let buyer = ev.contract?.buyerSeat
            return "\(n(buyer)) اشترى \(contract(ev.contract))"
        case "baloot_announced": return "\(n(ev.seat)): بلوت! 🌟"
        case "baloot_confirmed": return "بلوت \(n(ev.seat)) مُثبَت ✓"
        case "hand_end": return "انتهت الصفقة"
        case "match_end": return "انتهت المباراة 🏁"
        case "player_disconnected": return "\(n(ev.seat)) انقطع — بانتظار عودته"
        case "player_reconnected": return "\(n(ev.seat)) عاد ✓"
        case "match_paused": return "المباراة متوقفة مؤقتًا"
        case "match_resumed": return "استؤنفت المباراة"
        case "rematch_offer": return "مباراة ثانية؟ بانتظار موافقة الجميع"
        case "rematch_declined": return "أُلغي الريماچ — انتهت الجلسة"
        default: return nil
        }
    }
}
