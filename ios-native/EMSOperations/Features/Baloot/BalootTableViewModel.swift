//
//  BalootTableViewModel.swift
//  EMSOperations
//
//  شاشة الطاولة — الحالة الحية كاملة من الخادم:
//   · عرض الطاولة (مقاعد/جاهزية/ريماچ) عبر REST + baloot:table:<id>
//   · حالة المباراة (projection حسب الدور) عبر baloot:match:<id>
//   · «خياراتي الآن» من /options — الواجهة لا تعرف القواعد (A7)
//   · سالفة الطاولة عبر غرفة Community المرتبطة (roomId)
//   · reconnect/resync: الاشتراك نفسه يعيد اللقطة، واشتراك اللاعب
//     في موضوع المباراة يُسجِّل عودته خادميًا تلقائيًا.
//

import Foundation
import Combine

@MainActor
final class BalootTableViewModel: ObservableObject {

    // MARK: - الحالة المعروضة

    @Published private(set) var table: BalootLobbyTableDTO?
    @Published private(set) var mySeat: Int?
    @Published private(set) var activeMatchId: Int?
    @Published private(set) var rematch: BalootRematchDTO?

    @Published private(set) var matchState: BalootMatchStateDTO?
    @Published private(set) var paused = false
    @Published private(set) var matchStatus: String?
    @Published private(set) var spectators = 0

    @Published private(set) var options: BalootOptionsResponse?
    @Published private(set) var feedLines: [String] = []

    @Published private(set) var chatMessages: [BalootChatMessageDTO] = []
    @Published var actionError: String?
    @Published private(set) var busy = false

    let tableId: Int
    private let socket: BalootSocket
    private let service = BalootService.shared
    private var optionsTask: Task<Void, Never>?
    private var chatPollTask: Task<Void, Never>?
    private var chatLastId = 0
    private var chatOpen = false
    private var subscribedMatchId: Int?

    init(tableId: Int, socket: BalootSocket) {
        self.tableId = tableId
        self.socket = socket
    }

    // MARK: - دورة الحياة

    func start() {
        // القناة تُدار من اللوبي (start/stop هناك) — هنا نضيف مستمعنا ونركّب المواضيع.
        socket.onMessage = { [weak self] msg in self?.handle(msg) }
        socket.onReconnected = { [weak self] in self?.resync() }
        if socket.connection == .disconnected { socket.start() }
        socket.subscribe("baloot:table:\(tableId)")
        Task { await reloadTable() }
    }

    func stop() {
        optionsTask?.cancel(); optionsTask = nil
        chatPollTask?.cancel(); chatPollTask = nil
        socket.unsubscribe("baloot:table:\(tableId)")
        if let mid = subscribedMatchId { socket.unsubscribe("baloot:match:\(mid)") }
        subscribedMatchId = nil
    }

    /// إعادة مزامنة استباقية بعد إعادة وصل القناة.
    private func resync() {
        socket.subscribe("baloot:table:\(tableId)")
        if let mid = activeMatchId {
            socket.subscribe("baloot:match:\(mid)") // لقطة فورية + تسجيل عودة اللاعب خادميًا
            subscribedMatchId = mid
        }
        Task { await reloadTable() }
    }

    // MARK: - تحميل

    func reloadTable() async {
        do {
            actionError = nil
            let res = try await service.getTable(tableId)
            table = res.table
            mySeat = res.mySeat
            rematch = res.rematch
            if let mid = res.activeMatchId {
                if activeMatchId != mid { activeMatchId = mid }
                ensureMatchSubscription(mid)
                // لقطة REST فورية — لا ننتظر البث
                if matchState == nil {
                    let st = try await service.matchState(matchId: mid)
                    applyMatch(st.state, paused: st.paused ?? false, status: st.status, spectators: nil)
                }
            }
        } catch {
            actionError = BalootService.errorMessage(error)
        }
    }

    private func ensureMatchSubscription(_ matchId: Int) {
        guard subscribedMatchId != matchId else { return }
        if let old = subscribedMatchId { socket.unsubscribe("baloot:match:\(old)") }
        subscribedMatchId = matchId
        socket.subscribe("baloot:match:\(matchId)")
    }

    // MARK: - رسائل WS

    private func handle(_ msg: BalootWSMessage) {
        switch msg {
        case .table(let id, let events):
            guard id == tableId else { return }
            appendFeed(events)
            // حدث طاولة ← أعد جلب العرض (اكتمال/جاهزية/ريماچ/بدء مباراة)
            Task { await reloadTable() }
        case .match(let mid, _, let events, let state, let paused, let status, let spectators):
            guard mid == activeMatchId else { return }
            applyMatch(state, paused: paused, status: status, spectators: spectators)
            appendFeed(events)
            refreshOptionsIfNeeded()
        case .error(_, let code, let message):
            if let code, let message { appendFeedLine("تنبيه: \(message) (\(code))") }
        case .subscribed:
            break
        default:
            break
        }
    }

    private func applyMatch(_ state: BalootMatchStateDTO, paused: Bool, status: String?, spectators: Int?) {
        matchState = state
        self.paused = paused
        if let status { matchStatus = status }
        if let spectators { self.spectators = spectators }
    }

    /// الخيارات تُجلب عند تغيّر الحالة وأنا جالس — الخادم يحسم ماذا يمكنني.
    private func refreshOptionsIfNeeded() {
        guard let mid = activeMatchId, mySeat != nil, matchStatus == "active" else {
            options = nil
            return
        }
        optionsTask?.cancel()
        optionsTask = Task {
            do {
                let o = try await service.options(matchId: mid)
                guard !Task.isCancelled else { return }
                options = o
            } catch {
                // فشل الخيارات لا يكسر العرض — تُعاد مع الرسالة التالية
            }
        }
    }

    // MARK: - موجز الأحداث

    private func seatName(_ seat: Int) -> String {
        if let s = matchState?.seats?.first(where: { $0.seat == seat }), let name = s.name {
            return seat == mySeat ? "أنت" : name
        }
        if let t = table, let row = t.seats.first(where: { $0.seat == seat }), row.occupied {
            return seat == mySeat ? "أنت" : (row.name ?? "لاعب")
        }
        return "مقعد \(seat + 1)"
    }

    private func appendFeed(_ events: [BalootWSEvent]) {
        for ev in events {
            if let line = BalootLabels.eventLine(ev, seatName: seatName) {
                appendFeedLine(line)
            }
        }
    }

    private func appendFeedLine(_ line: String) {
        feedLines.append(line)
        if feedLines.count > 30 { feedLines.removeFirst(feedLines.count - 30) }
    }

    // MARK: - إجراءات اللوبي/الطاولة

    func sit() async {
        await run { _ = try await service.sit(tableId: tableId); await reloadTable() }
    }

    func leave() async -> Bool {
        var ok = false
        await run { try await service.leave(tableId: tableId); ok = true }
        return ok
    }

    func ready() async {
        await run { try await service.ready(tableId: tableId); await reloadTable() }
    }

    func closeTable() async -> Bool {
        var ok = false
        await run { try await service.closeTable(tableId: tableId); ok = true }
        return ok
    }

    func rematchAccept() async {
        await run { try await service.rematchAccept(tableId: tableId); await reloadTable() }
    }

    func rematchDecline() async {
        await run { try await service.rematchDecline(tableId: tableId); await reloadTable() }
    }

    func reconnectNow() async {
        guard let mid = activeMatchId else { return }
        await run { try await service.reconnect(matchId: mid) }
    }

    func voteAbort() async {
        guard let mid = activeMatchId else { return }
        await run { try await service.voteAbort(matchId: mid) }
    }

    // MARK: - أفعال اللعب (الخادم يحكم — A7)

    func bid(kind: String, trumpSuit: String? = nil) async {
        await sendAction(type: "BID", payload: .bid(kind: kind, trumpSuit: trumpSuit))
    }

    func playCard(_ code: String, baloot: Bool) async {
        await sendAction(type: "PLAY_CARD", payload: .playCard(card: code, baloot: baloot))
    }

    func declare(_ project: BalootProjectOptionDTO) async {
        await sendAction(type: "DECLARE", payload: .declare(project: project))
    }

    func callDouble(_ kind: String) async {
        await sendAction(type: "DOUBLE", payload: .callDouble(kind: kind))
    }

    private func sendAction(type: String, payload: BalootService.ActionPayload) async {
        guard let mid = activeMatchId else { return }
        await run {
            try await service.sendAction(matchId: mid, actionId: UUID().uuidString, type: type, payload: payload)
        }
        // التحديث يصل عبر البث؛ ونعيد الخيارات احتياطًا
        refreshOptionsIfNeeded()
    }

    // MARK: - سالفة الطاولة

    func openChat() {
        chatOpen = true
        chatLastId = 0
        chatMessages = []
        pollChat()
        chatPollTask?.cancel()
        chatPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard !Task.isCancelled else { return }
                self?.pollChat()
            }
        }
    }

    func closeChat() {
        chatOpen = false
        chatPollTask?.cancel(); chatPollTask = nil
    }

    private func pollChat() {
        guard chatOpen, let roomId = table?.roomId else { return }
        Task {
            do {
                let res = try await service.chatMessages(roomId: roomId, sinceId: chatLastId)
                // الخادم يعيد الأحدث أولًا — نعكسها للعرض الزمني
                let fresh = res.messages.reversed()
                if chatLastId == 0 {
                    chatMessages = Array(fresh)
                } else {
                    chatMessages.append(contentsOf: fresh)
                }
                if let last = res.lastId, last > chatLastId { chatLastId = last }
            } catch {
                // سكوت — تُعاد المحاولة مع النبضة التالية
            }
        }
    }

    func sendChat(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let roomId = table?.roomId else { return }
        do {
            try await service.sendChatMessage(roomId: roomId, content: trimmed)
            pollChat()
        } catch {
            actionError = BalootService.errorMessage(error)
        }
    }

    // MARK: - أدوات

    private func run(_ work: () async throws -> Void) async {
        busy = true
        actionError = nil
        do { try await work() } catch { actionError = BalootService.errorMessage(error) }
        busy = false
    }

    // MARK: - مشتقات العرض

    var isSeated: Bool { mySeat != nil }
    var isSpectator: Bool { !isSeated }

    /// المقعد النسبي: 0=أنا، 1=يمين، 2=شريكي (مقابل)، 3=يسار.
    func absoluteSeat(relative: Int) -> Int? {
        guard let mySeat else { return nil }
        return (mySeat + relative) % 4
    }
}
