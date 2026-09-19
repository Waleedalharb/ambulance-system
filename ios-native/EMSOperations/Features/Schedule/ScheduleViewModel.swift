//
//  ScheduleViewModel.swift
//  EMSOperations
//

import Foundation

@MainActor
final class ScheduleViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var schedule: ScheduleDTO?
    @Published var month: Int
    @Published var year: Int

    private let api = APIClient.shared

    init() {
        // شهر الرياض الحالي — نفس مرجعية الخادم الزمنية
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        let now = Date()
        month = cal.component(.month, from: now)
        year = cal.component(.year, from: now)
    }

    func load() async {
        if schedule == nil { state = .loading }
        do {
            schedule = try await api.get("/api/my/schedule", query: [
                "month": String(month), "year": String(year)
            ])
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: schedule != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: schedule != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func nextMonth() async { shift(1) }
    func prevMonth() async { shift(-1) }

    func goToday() async {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        month = cal.component(.month, from: Date())
        year = cal.component(.year, from: Date())
        await load()
    }

    private func shift(_ delta: Int) {
        var m = month + delta
        var y = year
        if m > 12 { m = 1; y += 1 }
        if m < 1 { m = 12; y -= 1 }
        month = m; year = y
        Task { await load() }
    }
}
