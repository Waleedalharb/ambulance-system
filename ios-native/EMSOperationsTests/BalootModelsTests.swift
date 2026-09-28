//
//  BalootModelsTests.swift
//  EMSOperationsTests
//
//  اختبارات فك DTOs البلوت مقابل العقود الفعلية للخادم
//  (server.js + baloot-projection.js + baloot-match-service.js).
//  لا شبكة — JSON خام فقط.
//

import XCTest
@testable import EMSOperations

final class BalootModelsTests: XCTestCase {

    private let decoder = JSONDecoder()

    // MARK: - بطاقات اللوبي (projection.lobbyTable — camelCase)

    func testLobbyTableDecodes() throws {
        let json = #"""
        {"success": true, "councilId": 1, "tables": [{
            "id": 7, "status": "open", "rulesetVersion": "sa-standard-1.0",
            "targetScore": 152, "createdBy": "6182", "createdAt": "2026-09-25 10:00:00",
            "seats": [
                {"seat": 0, "occupied": true, "name": "مشعل", "disconnected": false},
                {"seat": 1, "occupied": false, "name": null},
                {"seat": 2, "occupied": false, "name": null},
                {"seat": 3, "occupied": false, "name": null}
            ]
        }]}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootTablesResponse.self, from: json)
        XCTAssertTrue(res.success)
        XCTAssertEqual(res.tables.count, 1)
        let t = res.tables[0]
        XCTAssertEqual(t.id, 7)
        XCTAssertTrue(t.isOpen)
        XCTAssertFalse(t.isInMatch)
        XCTAssertEqual(t.occupiedCount, 1)
        XCTAssertEqual(t.targetScore, 152)
        XCTAssertEqual(t.seats[0].name, "مشعل")
        XCTAssertNil(t.seats[1].name)
    }

    // MARK: - عرض الطاولة المفرد (GET /tables/:id)

    func testTableViewDecodes() throws {
        let json = #"""
        {"success": true,
         "table": {"id": 3, "status": "in_match", "rulesetVersion": "sa-standard-1.0",
                   "targetScore": 152, "roomId": 9,
                   "seats": [{"seat": 0, "occupied": true, "name": "أ"}]},
         "mySeat": 0, "activeMatchId": 12,
         "rematch": null}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootTableViewResponse.self, from: json)
        XCTAssertEqual(res.table.id, 3)
        XCTAssertEqual(res.table.roomId, 9)
        XCTAssertEqual(res.mySeat, 0)
        XCTAssertEqual(res.activeMatchId, 12)
        XCTAssertNil(res.rematch)
        XCTAssertTrue(res.table.isInMatch)
    }

    func testRematchAcceptsDecode() throws {
        let json = #"""
        {"success": true,
         "table": {"id": 3, "status": "post_match", "seats": []},
         "mySeat": 2, "activeMatchId": null,
         "rematch": {"accepts": ["6182", "4252"], "matchId": 12}}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootTableViewResponse.self, from: json)
        XCTAssertTrue(res.table.isPostMatch)
        XCTAssertEqual(res.rematch?.accepts, ["6182", "4252"])
    }

    // MARK: - حالة المباراة: لاعب يرى يده، مشاهد بلا أيدٍ (A7)

    func testPlayerStateHasMyHand() throws {
        let json = #"""
        {"success": true, "matchId": 12, "tableId": 3, "paused": false, "status": "active",
         "state": {
            "rulesetVersion": "sa-standard-1.0", "targetScore": 152,
            "scores": {"A": 26, "B": 18}, "handNumber": 2, "status": "active", "seq": 40,
            "seats": [{"seat": 0, "team": "A", "name": "مشعل"}],
            "hand": {"phase": "playing", "dealerSeat": 3, "turnSeat": 0, "mySeat": 0,
                     "myHand": [{"code": "SA", "suit": "سباتي", "rank": "آس"},
                                {"code": "HK", "suit": "قلوب", "rank": "ملك"}],
                     "handCounts": {"0": 6, "1": 7, "2": 7, "3": 7},
                     "currentTrick": [{"seat": 2, "card": {"code": "D9"}}],
                     "tricksCount": 1}
         }}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootMatchStateResponse.self, from: json)
        XCTAssertEqual(res.matchId, 12)
        let hand = try XCTUnwrap(res.state.hand)
        XCTAssertEqual(hand.phase, "playing")
        XCTAssertEqual(hand.myHand?.count, 2)
        XCTAssertEqual(hand.myHand?[0].code, "SA")
        XCTAssertEqual(hand.myHand?[0].rankLabel, "آس")
        XCTAssertFalse(hand.myHand?[0].isRed ?? true)
        XCTAssertEqual(hand.myHand?[1].isRed, true)
        XCTAssertEqual(hand.handCounts?["1"], 7)
        XCTAssertEqual(hand.currentTrick?.first?.seat, 2)
        XCTAssertEqual(res.state.scores?.A, 26)
    }

    func testSpectatorStateHasNoHands() throws {
        let json = #"""
        {"success": true, "matchId": 12, "tableId": 3, "paused": false, "status": "active",
         "state": {
            "scores": {"A": 0, "B": 0}, "status": "active", "seq": 1,
            "seats": [{"seat": 0, "team": "A", "name": "مشعل"}],
            "hand": {"phase": "playing", "turnSeat": 1,
                     "handCounts": {"0": 8, "1": 8, "2": 8, "3": 8},
                     "currentTrick": []}
         }}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootMatchStateResponse.self, from: json)
        let hand = try XCTUnwrap(res.state.hand)
        XCTAssertNil(hand.myHand, "المشاهد لا يرى أي يد إطلاقًا")
        XCTAssertNil(hand.mySeat)
    }

    // MARK: - «خياراتي الآن» (optionsFor)

    func testOptionsDecode() throws {
        let json = #"""
        {"success": true, "matchId": 12, "phase": "bidding1", "status": "active",
         "paused": false, "mySeat": 0, "myTurn": true,
         "bids": [{"kind": "pass"}, {"kind": "sun"},
                  {"kind": "hokum", "trumpSuit": "S"}],
         "cards": [], "balootCards": [], "projects": [], "doubles": []}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootOptionsResponse.self, from: json)
        XCTAssertTrue(res.myTurn)
        XCTAssertEqual(res.bids.count, 3)
        XCTAssertEqual(res.bids[2].trumpSuit, "S")
    }

    func testOptionsPlayingDecode() throws {
        let json = #"""
        {"success": true, "matchId": 12, "phase": "playing", "status": "active",
         "paused": false, "mySeat": 1, "myTurn": true, "bids": [],
         "cards": ["SQ", "HA"], "balootCards": ["HA"],
         "projects": [{"type": "sara", "suit": "H", "topRank": "K"}],
         "doubles": ["dabal"]}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootOptionsResponse.self, from: json)
        XCTAssertEqual(res.cards, ["SQ", "HA"])
        XCTAssertEqual(res.balootCards, ["HA"])
        XCTAssertEqual(res.projects.first?.type, "sara")
        XCTAssertEqual(res.doubles, ["dabal"])
    }

    // MARK: - رسائل WebSocket

    func testWSMatchMessageDecodes() throws {
        let json = #"""
        {"type": "baloot_match", "topic": "baloot:match:12", "matchId": 12,
         "seq": 41, "events": [{"type": "card_played", "seat": 2}],
         "state": {"scores": {"A": 10, "B": 0}, "status": "active", "seq": 41,
                   "hand": {"phase": "playing", "myHand": []}},
         "paused": false, "status": "active", "spectators": 3}
        """#.data(using: .utf8)!
        let msg = try decoder.decode(BalootWSMessage.self, from: json)
        guard case .match(let matchId, let seq, let events, let state, let paused, _, let spectators) = msg else {
            return XCTFail("expected .match")
        }
        XCTAssertEqual(matchId, 12)
        XCTAssertEqual(seq, 41)
        XCTAssertEqual(events.first?.type, "card_played")
        XCTAssertEqual(state.scores?.A, 10)
        XCTAssertFalse(paused)
        XCTAssertEqual(spectators, 3)
    }

    func testWSTableAndLobbyAndControlMessages() throws {
        let table = try decoder.decode(BalootWSMessage.self, from:
            #"{"type":"baloot_table","topic":"baloot:table:3","tableId":3,"events":[{"type":"seat_taken","seat":1}]}"#
                .data(using: .utf8)!)
        guard case .table(let tableId, let events) = table else { return XCTFail("expected .table") }
        XCTAssertEqual(tableId, 3)
        XCTAssertEqual(events.first?.seat, 1)

        let lobby = try decoder.decode(BalootWSMessage.self, from:
            #"{"type":"baloot_lobby","topic":"baloot:lobby","tableId":3,"events":[]}"#
                .data(using: .utf8)!)
        guard case .lobby(let ltid, _) = lobby else { return XCTFail("expected .lobby") }
        XCTAssertEqual(ltid, 3)

        let sub = try decoder.decode(BalootWSMessage.self, from:
            #"{"type":"baloot_subscribed","topic":"baloot:match:12","role":"player"}"#
                .data(using: .utf8)!)
        guard case .subscribed(let topic, let role) = sub else { return XCTFail("expected .subscribed") }
        XCTAssertEqual(topic, "baloot:match:12")
        XCTAssertEqual(role, "player")

        let err = try decoder.decode(BalootWSMessage.self, from:
            #"{"type":"baloot_error","topic":"baloot:match:99","code":"PERMISSION_DENIED","error":"لا يمكن الاشتراك"}"#
                .data(using: .utf8)!)
        guard case .error(_, let code, _) = err else { return XCTFail("expected .error") }
        XCTAssertEqual(code, "PERMISSION_DENIED")

        let other = try decoder.decode(BalootWSMessage.self, from:
            #"{"type":"pong"}"#.data(using: .utf8)!)
        guard case .other(let t) = other else { return XCTFail("expected .other") }
        XCTAssertEqual(t, "pong")
    }

    // MARK: - التصنيف الشرفي — userId قد يصل رقمًا

    func testRatingsDecodeNumericUserId() throws {
        let json = #"""
        {"success": true, "ratings": [
            {"userId": 6182, "name": "مشعل", "matches": 4, "wins": 3, "losses": 1, "honorPoints": 9},
            {"userId": "4252", "name": null, "matches": 1, "wins": 0, "losses": 1, "honorPoints": 0}
        ]}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootRatingsResponse.self, from: json)
        XCTAssertEqual(res.ratings[0].userId, "6182")
        XCTAssertEqual(res.ratings[0].honorPoints, 9)
        XCTAssertEqual(res.ratings[1].userId, "4252")
        XCTAssertNil(res.ratings[1].name)
    }

    // MARK: - سالفة الطاولة — author.userId قد يصل رقمًا

    func testChatMessagesDecode() throws {
        let json = #"""
        {"success": true, "roomStatus": "open", "lastId": 55,
         "messages": [
            {"id": 54, "content": "هلا", "createdAt": "2026-09-25 10:01:00",
             "author": {"userId": 6182, "displayName": "مشعل"}, "mine": true},
            {"id": 55, "content": "أهلين", "createdAt": "2026-09-25 10:01:10",
             "author": {"userId": "4252", "displayName": "سعود"}, "mine": false}
        ]}
        """#.data(using: .utf8)!
        let res = try decoder.decode(BalootChatListResponse.self, from: json)
        XCTAssertEqual(res.roomStatus, "open")
        XCTAssertEqual(res.lastId, 55)
        XCTAssertEqual(res.messages.count, 2)
        XCTAssertEqual(res.messages[0].author.userId, "6182")
        XCTAssertTrue(res.messages[0].mine)
        XCTAssertEqual(res.messages[1].author.displayName, "سعود")
    }

    // MARK: - ترميز أفعال اللعب (يطابق baloot-app.js حرفيًا)

    func testActionPayloadEncoding() throws {
        let enc = JSONEncoder()

        let bid = try enc.encode(BalootService.ActionPayload.bid(kind: "hokum", trumpSuit: "S"))
        let bidObj = try XCTUnwrap(JSONSerialization.jsonObject(with: bid) as? [String: Any])
        XCTAssertEqual(bidObj["kind"] as? String, "hokum")
        XCTAssertEqual(bidObj["trumpSuit"] as? String, "S")

        let play = try enc.encode(BalootService.ActionPayload.playCard(card: "HA", baloot: true))
        let playObj = try XCTUnwrap(JSONSerialization.jsonObject(with: play) as? [String: Any])
        XCTAssertEqual(playObj["card"] as? String, "HA")
        XCTAssertEqual(playObj["baloot"] as? Bool, true)

        // بلا بلوت: الحقل يُحذف كليًا (وليس "false" — المحرك يفحص !!action.baloot)
        let plain = try enc.encode(BalootService.ActionPayload.playCard(card: "SQ", baloot: false))
        let plainObj = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: Any])
        XCTAssertNil(plainObj["baloot"])

        let project = BalootProjectOptionDTO(type: "sara", suit: "H", rank: nil, topRank: "K")
        let declare = try enc.encode(BalootService.ActionPayload.declare(project: project))
        let declObj = try XCTUnwrap(JSONSerialization.jsonObject(with: declare) as? [String: Any])
        let projects = try XCTUnwrap(declObj["projects"] as? [[String: Any]])
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0]["type"] as? String, "sara")
        XCTAssertEqual(projects[0]["topRank"] as? String, "K")

        let dbl = try enc.encode(BalootService.ActionPayload.callDouble(kind: "dabal"))
        let dblObj = try XCTUnwrap(JSONSerialization.jsonObject(with: dbl) as? [String: Any])
        XCTAssertEqual(dblObj["kind"] as? String, "dabal")
    }
}
