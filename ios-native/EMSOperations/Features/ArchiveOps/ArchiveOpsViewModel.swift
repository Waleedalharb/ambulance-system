//
//  ArchiveOpsViewModel.swift
//  EMSOperations
//
//  مخزن مجال الأرشيف (§15): قائمة المناوبات بفلاتر سيرفرية
//  (date_from/date_to/shift_type/status/sort) + تحقق من سلامة الأرشيف +
//  سجل الأرشفة + إجراءات admin (أرشفة/استعادة/إعادة أرشفة).
//  لا منطق أعمال هنا — الحسم كله سيرفري.
//

import Foundation

@MainActor
final class ArchiveOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var shifts: [ArchiveShiftDTO] = []
    @Published private(set) var total = 0
    @Published private(set) var page = 1
    @Published private(set) var totalPages = 1

    // الفلاتر (تُرسل كما هي — التصفية سيرفرية في server.js:2894)
    @Published var dateFrom = ""   // YYYY-MM-DD
    @Published var dateTo = ""
    @Published var shiftType = ""
    @Published var status = ""     // "" الكل | active | archived

    // التحقق من السلامة — لكل مناوبة عند الطلب
    @Published private(set) var verifications: [Int: VerifyArchiveResponseDTO] = [:]
    @Published private(set) var verifyingIds: Set<Int> = []

    // سجل الأرشفة — لكل مناوبة عند الطلب
    @Published private(set) var logs: [Int: [ArchiveLogEntryDTO]] = [:]
    @Published private(set) var loadingLogIds: Set<Int> = []

    private let api = APIClient.shared
    private static let pageLimit = 20

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        var query: [String: String] = [
            "page": "\(page)",
            "limit": "\(Self.pageLimit)",
            "sort": "date_desc"
        ]
        if !dateFrom.isEmpty { query["date_from"] = dateFrom }
        if !dateTo.isEmpty { query["date_to"] = dateTo }
        if !shiftType.isEmpty { query["shift_type"] = shiftType }
        if !status.isEmpty { query["status"] = status }
        do {
            let res: ArchiveListResponseDTO = try await api.get("/api/shifts/archive", query: query)
            shifts = res.shifts ?? []
            total = res.total ?? shifts.count
            totalPages = max(res.totalPages ?? 1, 1)
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    /// تطبيق الفلاتر يعيد إلى الصفحة الأولى.
    func applyFilters() async {
        page = 1
        await reload(showLoading: true)
    }

    func goToPage(_ newPage: Int) async {
        guard newPage >= 1, newPage <= totalPages, newPage != page else { return }
        page = newPage
        await reload(showLoading: true)
    }

    // MARK: - التحقق من سلامة الأرشيف (قراءة — authenticate فقط)

    func verify(shiftId: Int) async throws {
        verifyingIds.insert(shiftId)
        defer { verifyingIds.remove(shiftId) }
        let res: VerifyArchiveResponseDTO = try await api.get("/api/shifts/\(shiftId)/verify-archive")
        verifications[shiftId] = res
    }

    // MARK: - سجل الأرشفة (قراءة — authenticate فقط)

    func loadLogs(shiftId: Int) async throws {
        loadingLogIds.insert(shiftId)
        defer { loadingLogIds.remove(shiftId) }
        let res: ArchiveLogResponseDTO = try await api.get("/api/shifts/\(shiftId)/archive-log")
        logs[shiftId] = res.logs ?? []
    }

    // MARK: - إجراءات الكتابة (الحسم سيرفري)

    /// أرشفة مباشرة — admin فقط (server.js:3517).
    func archive(shiftId: Int, reason: String?) async throws {
        let res: ArchiveActionResponseDTO = try await api.post("/api/shift/\(shiftId)/archive",
                                                               body: ArchiveRequestDTO(reason: reason))
        if res.success == false { throw APIError.server(res.error ?? "فشل في أرشفة المناوبة") }
        await reload()
    }

    /// استعادة — admin+director (server.js:3545). الاستعادة تبدأ مناوبة جديدة
    /// وتُبقي القديمة مؤرشفة (سلوك ShiftService.startShift سيرفريًا).
    func restore(shiftId: Int) async throws {
        let res: ArchiveActionResponseDTO = try await api.post("/api/shift/\(shiftId)/restore")
        if res.success == false { throw APIError.server(res.error ?? "فشل في استعادة المناوبة") }
        await reload()
    }

    /// إعادة أرشفة strict — admin فقط (server.js:15074).
    func rearchive(shiftId: Int) async throws {
        let res: ArchiveActionResponseDTO = try await api.post("/api/shifts/\(shiftId)/rearchive")
        if res.success == false { throw APIError.server(res.error ?? "فشلت إعادة الأرشفة") }
        await reload()
    }
}
