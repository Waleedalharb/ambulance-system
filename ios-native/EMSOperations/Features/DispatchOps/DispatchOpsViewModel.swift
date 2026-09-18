//
//  DispatchOpsViewModel.swift
//  EMSOperations
//
//  مخزن البلاغات والتوزيع (§9): ملخص بلاغات المناوبة من CAD/اليدوي +
//  التوزيع والتراجع + إلغاء/استعادة طواقم CAD + البلاغات التفصيلية.
//  كل العدّادات والخطورة تُشتق سيرفريًا (ReportService) وتُعرض كما هي —
//  لا حساب في العميل. الكتابة: ops.dispatch / ops.report_revert /
//  ops.report_detail، والحسم الأمني النهائي على الخادم في كل طلب.
//

import Foundation

@MainActor
final class DispatchOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var summary: CadSummaryDTO?
    @Published private(set) var entries: [ReportEntryDTO] = []
    @Published private(set) var teams: [OpsTeamsDTO.Team] = []

    private let api = APIClient.shared

    /// المراكز ← فرقها من سجل الفرق المرجعي (/api/teams) — المصدر نفسه
    /// الذي تبني منه الواجهة قوائمها، لا قائمة ثابتة في العميل.
    var centers: [String] { Array(Set(teams.compactMap(\.center))).sorted() }

    func units(in center: String) -> [String] {
        teams.filter { $0.center == center && ($0.isActive ?? 1) == 1 }
            .compactMap(\.name)
            .sorted()
    }

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            async let sumCall: CadSummaryDTO = api.get("/api/cad-reports")
            async let entriesCall: ReportEntryListDTO = api.get("/api/report-entry")
            async let teamsCall: OpsTeamsDTO = api.get("/api/teams")
            let (sum, list, teamsRes) = try await (sumCall, entriesCall, teamsCall)
            summary = sum
            entries = list.records ?? []
            teams = teamsRes.teams ?? []
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    // MARK: - التوزيع والتراجع

    /// توزيع بلاغ على فرقة — المناوبة تُحسم سيرفريًا (400 بلا مناوبة نشطة).
    func dispatch(center: String, unit: String, type: String?) async throws {
        let res: DispatchActionResponseDTO = try await api.post("/api/report",
            body: DispatchReportRequest(center: center, unit: unit, type: type))
        if res.success == false { throw APIError.server(res.error ?? "فشل في تسجيل البلاغ") }
        await reload()
    }

    /// التراجع عن آخر بلاغ لمركز/وحدة في المناوبة النشطة.
    func undo(center: String, unit: String) async throws {
        let res: DispatchActionResponseDTO = try await api.post("/api/undo",
            body: UndoReportRequest(center: center, unit: unit))
        if res.success == false { throw APIError.server(res.error ?? "فشل في التراجع") }
        await reload()
    }

    // MARK: - طواقم CAD

    func setCrewCancelled(number: String, unit: String, cancel: Bool, reason: String?) async throws {
        let action = cancel ? "cancel" : "restore"
        let res: DispatchActionResponseDTO = try await api.post(
            "/api/cad-reports/\(number)/crews/\(unit)/\(action)",
            body: CrewCancelRequest(reason: reason))
        if res.success == false { throw APIError.server(res.error ?? "فشل في تحديث مشاركة الفرقة") }
        await reload()
    }

    // MARK: - البلاغات التفصيلية

    func createEntry(_ req: ReportEntryRequest) async throws {
        _ = try await api.postRaw("/api/report-entry", jsonObject: Self.entryJSONObject(req))
        await reload()
    }

    func deleteEntry(_ id: String) async throws {
        let res: DispatchActionResponseDTO = try await api.delete("/api/report-entry/\(id)")
        if res.success == false { throw APIError.server(res.error ?? "فشل في حذف البلاغ") }
        await reload()
    }

    /// ترميز خام يحذف الحقول الفارغة بدل إرسال سلاسل فارغة — يطابق سلوك
    /// النموذج المتقدم في الويب (الحقول الاختيارية تُرسل فارغة هناك لكن
    /// الأنظف ألا نرسلها إطلاقًا؛ الخادم يقبل الكائن الحر).
    private static func entryJSONObject(_ req: ReportEntryRequest) -> [String: Any] {
        var obj: [String: Any] = [
            "type": req.type,
            "center": req.center,
            "unit": req.unit,
            "dispatchTime": req.dispatchTime,
            "arrivalTime": req.arrivalTime
        ]
        if let v = req.reportNumber, !v.isEmpty { obj["reportNumber"] = v }
        if let v = req.location, !v.isEmpty { obj["location"] = v }
        if let v = req.priority, !v.isEmpty { obj["priority"] = v }
        if let v = req.responseTime, !v.isEmpty { obj["responseTime"] = v }
        if let v = req.responseSeconds { obj["responseSeconds"] = v }
        if let v = req.dispatcher, !v.isEmpty { obj["dispatcher"] = v }
        if let v = req.notes, !v.isEmpty { obj["notes"] = v }
        return obj
    }
}
