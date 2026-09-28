//
//  BalootSocket.swift
//  EMSOperations
//
//  عميل WebSocket لمواضيع baloot:* فوق قناة /ws القائمة (الخادم:
//  server.js — اشتراك baloot_subscribe، ولقطة فورية عند الاشتراك).
//
//  مبادئ:
//   - الاشتراك ليس تفويضًا — الخادم يفوّض كل رسالة، واللقطة تصل بحسب الدور.
//   - reconnect بتراجع أسّي (1→2→4→8→15ث) + إعادة اشتراك كل المواضيع
//     بعد الوصل = resync تلقائي (الخادم يرسل لقطة المباراة عند الاشتراك).
//   - ping كل 25ث لإبقاء القناة حية عبر الوسطاء.
//   - لا منطق لعب هنا — فكّ الرسالة وتسليمها للمستمع فقط.
//

import Foundation
import Combine

@MainActor
final class BalootSocket: ObservableObject {

    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        /// إعادة وصل مجدولة — المحاولة القادمة بعد N ثانية.
        case reconnecting(nextInSeconds: Int)
    }

    @Published private(set) var connection: ConnectionState = .disconnected

    /// مستلم الرسائل المفكوكة — يُسند من الـViewModel.
    var onMessage: ((BalootWSMessage) -> Void)?
    /// يُستدعى بعد كل إعادة وصل ناجحة (بعد إعادة الاشتراكات) — للمزامنة الاستباقية.
    var onReconnected: (() -> Void)?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var topics: Set<String> = []
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var backoffSeconds = 1
    private var shouldRun = false
    private var tokenProvider: () -> String?

    init(tokenProvider: @escaping () -> String?) {
        self.tokenProvider = tokenProvider
    }

    // MARK: - دورة الحياة

    /// يبدأ القناة ويبقيها حية حتى stop(). آمن للاستدعاء المتكرر.
    func start() {
        guard !shouldRun else { return }
        shouldRun = true
        connect()
    }

    /// إنهاء نهائي (خروج من شاشة البلوت) — لا إعادة وصل بعده.
    func stop() {
        shouldRun = false
        reconnectTask?.cancel(); reconnectTask = nil
        pingTask?.cancel(); pingTask = nil
        receiveTask?.cancel(); receiveTask = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel(); session = nil
        topics.removeAll()
        connection = .disconnected
    }

    // MARK: - الاشتراكات

    func subscribe(_ topic: String) {
        topics.insert(topic)
        send(["type": "baloot_subscribe", "topic": topic])
    }

    func unsubscribe(_ topic: String) {
        topics.remove(topic)
        send(["type": "baloot_unsubscribe", "topic": topic])
    }

    // MARK: - الاتصال

    private func connect() {
        guard shouldRun else { return }
        guard let token = tokenProvider(), !token.isEmpty else {
            // لا جلسة — لا قناة. stop() سيُستدعى مع الخروج.
            connection = .disconnected
            return
        }
        connection = .connecting

        var comps = URLComponents(url: AppEnvironment.current.baseURL, resolvingAgainstBaseURL: false)
        comps?.scheme = "wss"
        comps?.path = "/ws"
        comps?.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps?.url else { scheduleReconnect(); return }

        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForResource = 60 * 60 // القناة طويلة العمر
        let s = URLSession(configuration: cfg)
        session = s
        let t = s.webSocketTask(with: url)
        task = t
        t.resume()

        receiveTask?.cancel()
        receiveTask = Task { [weak self] in await self?.receiveLoop() }
        startPing()

        // نعدّ الوصل ناجحًا مع أول استقبال ناجح؛ لكن عمليًا resume ثم إرسال
        // الاشتراكات مباشرة كافٍ — الخادم يجيب baloot_subscribed/error.
        connection = .connected
        backoffSeconds = 1
        // إعادة اشتراك كل المواضيع بعد (إعادة) الوصل — اللقطة تأتي من الخادم.
        for topic in topics { send(["type": "baloot_subscribe", "topic": topic]) }
        if topics.isEmpty == false { onReconnected?() }
    }

    private func receiveLoop() async {
        guard let task else { return }
        while shouldRun && !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    handle(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) { handle(text) }
                @unknown default:
                    break
                }
            } catch {
                // انقطاع (شبكة/إغلاق خادم/إلغاء) — أعد الوصل إن كنا نعمل
                if shouldRun && !Task.isCancelled { scheduleReconnect() }
                return
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        do {
            let msg = try JSONDecoder().decode(BalootWSMessage.self, from: data)
            onMessage?(msg)
        } catch {
            // رسالة ليست لنا (أنواع المنصة الأخرى على /ws) — تُتجاهل بصمت
            #if DEBUG
            AppLogger.network.debug("baloot ws: رسالة غير بلوتية أو غير قابلة للفك")
            #endif
        }
    }

    private func send(_ dict: [String: String]) {
        guard connection == .connected, let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor [weak self] in
                guard let self, self.shouldRun else { return }
                self.scheduleReconnect()
            }
        }
    }

    private func startPing() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard !Task.isCancelled else { return }
                self?.task?.sendPing { error in
                    guard error != nil else { return }
                    Task { @MainActor [weak self] in
                        guard let self, self.shouldRun else { return }
                        self.scheduleReconnect()
                    }
                }
            }
        }
    }

    private func scheduleReconnect() {
        guard shouldRun, reconnectTask == nil else { return }
        pingTask?.cancel(); pingTask = nil
        receiveTask?.cancel(); receiveTask = nil
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel(); session = nil

        let wait = backoffSeconds
        backoffSeconds = min(backoffSeconds * 2, 15)
        connection = .reconnecting(nextInSeconds: wait)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000_000)
            guard let self, !Task.isCancelled else { return }
            self.reconnectTask = nil
            self.connect()
        }
    }
}
