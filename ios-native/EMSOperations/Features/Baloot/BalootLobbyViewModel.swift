//
//  BalootLobbyViewModel.swift
//  EMSOperations
//
//  مجلس البلوت — قائمة الطاولات الحية (REST + تحديث لحظي عبر baloot:lobby)
//  والتصنيف الشرفي. لا قواعد لعب هنا — عرض وإجراءات مسارات فقط.
//

import Foundation
import Combine

@MainActor
final class BalootLobbyViewModel: ObservableObject {

    enum LoadState: Equatable {
        case idle, loading, ready, failed(String)
    }

    @Published private(set) var tables: [BalootLobbyTableDTO] = []
    @Published private(set) var ratings: [BalootRatingDTO] = []
    @Published private(set) var state: LoadState = .idle
    @Published var actionError: String?

    let socket: BalootSocket
    private let service = BalootService.shared
    private var refreshTask: Task<Void, Never>?

    init(tokenProvider: @escaping () -> String?) {
        socket = BalootSocket(tokenProvider: tokenProvider)
    }

    func start() {
        // القناة مشتركة مع شاشة الطاولة — نستعيد مستمعنا في كل ظهور
        // (شاشة الطاولة تستبدله أثناء وجودها ونسترجعه عند العودة).
        socket.onMessage = { [weak self] msg in self?.handle(msg) }
        socket.onReconnected = nil
        socket.start()
        socket.subscribe("baloot:lobby")
        if state == .idle { Task { await load() } }
    }

    func stop() {
        refreshTask?.cancel(); refreshTask = nil
        socket.stop()
    }

    func load() async {
        if tables.isEmpty { state = .loading }
        do {
            async let t = service.listTables()
            async let r = service.ratings()
            let (tables, ratings) = try await (t, r)
            self.tables = tables.sorted { $0.id > $1.id }
            self.ratings = ratings
            state = .ready
        } catch {
            state = tables.isEmpty ? .failed(BalootService.errorMessage(error)) : state
        }
    }

    /// تحديث خفيف عند أحداث اللوبي — مُرجأ قليلًا لدمج الأحداث المتتابعة.
    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    private func handle(_ msg: BalootWSMessage) {
        if case .lobby = msg { scheduleRefresh() }
    }

    // MARK: - الإجراءات

    /// فتح طاولة جديدة — يعيد معرّفها للانتقال إليها (الجلوس خطوة صريحة بعدها).
    func createTable() async -> Int? {
        do {
            actionError = nil
            let tableId = try await service.createTable()
            await load()
            return tableId
        } catch {
            actionError = BalootService.errorMessage(error)
            return nil
        }
    }

    /// الجلوس في أول مقعد حر — يعيد true عند النجاح للانتقال للطاولة.
    func sit(tableId: Int) async -> Bool {
        do {
            actionError = nil
            _ = try await service.sit(tableId: tableId)
            return true
        } catch {
            actionError = BalootService.errorMessage(error)
            return false
        }
    }
}
