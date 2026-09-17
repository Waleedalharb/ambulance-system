//
//  NetworkMonitor.swift
//  EMSOperations
//
//  مراقبة حالة الشبكة (v2 قسم 19): Online/Offline/Poor.
//  لا شاشة بيضاء أبدًا — الشاشات تعرض شارة الحالة وآخر بيانات محفوظة.
//

import Foundation
import Network

@MainActor
final class NetworkMonitor: ObservableObject {
    enum State: Equatable {
        case online
        case poor       // اتصال مقيّد/مكلف (خلوي ضعيف أو محدود)
        case offline
    }

    @Published private(set) var state: State = .online

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "online.emsoperations.app.network")

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                switch path.status {
                case .satisfied:
                    self.state = (path.isExpensive || path.isConstrained) ? .poor : .online
                default:
                    self.state = .offline
                }
            }
        }
        monitor.start(queue: queue)
    }

    deinit { monitor.cancel() }

    var isOffline: Bool { state == .offline }

    /// وصف عربي مختصر للشارة.
    var bannerText: String? {
        switch state {
        case .online: return nil
        case .poor: return "اتصال ضعيف — قد تتأخر البيانات"
        case .offline: return "غير متصل — تعرض آخر بيانات محفوظة"
        }
    }
}
