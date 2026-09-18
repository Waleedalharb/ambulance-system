//
//  ScheduleOpsViewModel.swift
//  EMSOperations
//
//  مخزن مجال الجداول المشترك (docs/native-schedule-parity.md):
//  الشهور + شبكة الشهر + الإحصاءات + المرجعيات (فرق/رموز/موظفون)
//  وكل عمليات الكتابة. لا حساب ولا اشتقاق في العميل — القرار للخادم
//  دائمًا؛ كل كتابة ناجحة تُعيد تحميل الشهر حتى يبقى العرض مطابقًا للقاعدة.
//

import Foundation

@MainActor
final class ScheduleOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var bootState: LoadState = .loading
    @Published private(set) var rosterState: LoadState = .loading
    @Published private(set) var months: [String] = []          // "YYYY-MM" تصاعديًا
    @Published private(set) var roster: [RosterMonthDTO.Entry] = []
    @Published private(set) var stats: RosterStatsDTO?
    @Published private(set) var teams: [OpsTeamsDTO.Team] = []
    @Published private(set) var codes: [ShiftCodesDTO.Code] = []
    @Published private(set) var employees: [EmployeeDirectoryDTO.Person] = []
    @Published var selectedMonth: String = ""                  // "YYYY-MM"

    private let api = APIClient.shared

    static let monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
                             "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]

    // MARK: - مشتقات الشهر المختار

    var selectedYear: Int { Int(selectedMonth.prefix(4)) ?? 0 }
    var selectedMonthNumber: Int { Int(selectedMonth.suffix(2)) ?? 0 }

    var selectedMonthLabel: String { monthLabel(selectedMonth) }

    func monthLabel(_ m: String) -> String {
        guard m.count == 7, let y = Int(m.prefix(4)), let mo = Int(m.suffix(2)), (1...12).contains(mo) else {
            return m.isEmpty ? "—" : m
        }
        return "\(Self.monthNames[mo - 1]) \(y)"
    }

    /// أيام الشهر المختار بصيغة YYYY-MM-DD (ميلادي — نفس مرجعية الخادم الزمنية).
    var monthDays: [String] {
        guard selectedYear > 0, (1...12).contains(selectedMonthNumber) else { return [] }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        var comps = DateComponents()
        comps.year = selectedYear
        comps.month = selectedMonthNumber
        comps.day = 1
        guard let first = cal.date(from: comps),
              let range = cal.range(of: .day, in: .month, for: first) else { return [] }
        return range.map { String(format: "%04d-%02d-%02d", selectedYear, selectedMonthNumber, $0) }
    }

    // MARK: - التحميل

    /// إقلاع واحد: الشهور + المرجعيات ثم محتوى أحدث شهر. يُعاد فقط بعد فشل.
    func load() async {
        if case .loaded = bootState { return }
        bootState = .loading
        do {
            async let monthsCall: RosterMonthsDTO = api.get("/api/shift-roster/months")
            async let teamsCall: OpsTeamsDTO = api.get("/api/teams")
            async let codesCall: ShiftCodesDTO = api.get("/api/shift-codes")
            async let employeesCall: EmployeeDirectoryDTO = api.get("/api/employees")
            let (m, t, c, e) = try await (monthsCall, teamsCall, codesCall, employeesCall)
            months = m.months ?? []
            teams = (t.teams ?? [])
                .filter { ($0.isActive ?? 1) == 1 }
                .sorted { ($0.sortOrder ?? 0) < ($1.sortOrder ?? 0) }
            codes = (c.codes ?? []).filter { ($0.status ?? "active") != "inactive" }
            employees = (e.employees ?? []).filter { ($0.isActive ?? 1) == 1 }
            guard let latest = months.last else {
                // لا جداول في القاعدة بعد — الشاشات تعرض حالة الفراغ الصادقة.
                bootState = .loaded
                rosterState = .loaded
                return
            }
            selectedMonth = latest
            bootState = .loaded
            await reloadMonth()
        } catch let err as APIError {
            bootState = .failed(err.userMessage)
        } catch {
            bootState = .failed(APIError.unknown.userMessage)
        }
    }

    func reloadMonth(silent: Bool = false) async {
        guard !selectedMonth.isEmpty, selectedYear > 0, selectedMonthNumber > 0 else {
            rosterState = .loaded
            return
        }
        if !silent { rosterState = .loading }
        do {
            let q = ["month": String(selectedMonthNumber), "year": String(selectedYear)]
            async let rosterCall: RosterMonthDTO = api.get("/api/shift-roster", query: q)
            async let statsCall: RosterStatsDTO = api.get("/api/shift-roster/stats", query: q)
            let (r, s) = try await (rosterCall, statsCall)
            roster = r.roster ?? []
            stats = s
            rosterState = .loaded
        } catch let err as APIError {
            rosterState = .failed(err.userMessage)
        } catch {
            rosterState = .failed(APIError.unknown.userMessage)
        }
    }

    func selectMonth(_ m: String) async {
        guard m != selectedMonth else { return }
        selectedMonth = m
        await reloadMonth()
    }

    // MARK: - مشتقات عرضية من شبكة الشهر (لا اشتقاق منطقي — تجميع فقط)

    /// أسماء الفرق بترتيب ورودها في رد الخادم (المرتب أصلًا: تاريخ، فريق، موظف).
    var teamNamesInRoster: [String] {
        var seen: [String] = []
        for e in roster {
            let n = e.teamName ?? "بدون فريق"
            if !seen.contains(n) { seen.append(n) }
        }
        return seen
    }

    func entries(team: String) -> [RosterMonthDTO.Entry] {
        roster.filter { ($0.teamName ?? "بدون فريق") == team }
    }

    func entries(date: String) -> [RosterMonthDTO.Entry] {
        roster.filter { $0.shiftDate == date }
    }

    /// سجلات مركز: يُربط اسم الفريق في السجل بمركزه من سجل الفرق المرجعي.
    func entries(center: String) -> [RosterMonthDTO.Entry] {
        let teamNames = Set(teams.filter { ($0.center ?? "") == center }.compactMap { $0.name })
        return roster.filter { teamNames.contains($0.teamName ?? "") }
    }

    var centers: [String] {
        var seen: [String] = []
        for t in teams {
            let c = (t.center ?? "").trimmingCharacters(in: .whitespaces)
            if !c.isEmpty, !seen.contains(c) { seen.append(c) }
        }
        return seen
    }

    func employeeName(_ id: Int?) -> String {
        guard let id else { return "—" }
        return employees.first(where: { $0.id == id })?.name ?? "موظف #\(id)"
    }

    func teamName(_ id: Int?) -> String {
        guard let id else { return "—" }
        return teams.first(where: { $0.teamId == id })?.name ?? "فريق #\(id)"
    }

    func codeLabel(_ code: String?) -> String {
        guard let code else { return "—" }
        return codes.first(where: { $0.code == code })?.displayLabel ?? code
    }

    func codeColor(_ code: String?) -> String? {
        guard let code else { return nil }
        return codes.first(where: { $0.code == code })?.color
    }

    // MARK: - الكتابة (كل دالة تعيد تحميل الشهر بعد النجاح)

    /// PUT /api/shift-roster/cell — تعديل/إنشاء خلية يوم واحد (upsert سيرفري).
    func editCell(employeeCode: String, date: String, shiftCode: String) async throws {
        let _: RosterCellResponseDTO = try await api.put("/api/shift-roster/cell",
            body: RosterCellUpdateRequest(employeeCode: employeeCode, date: date, shiftCode: shiftCode))
        await reloadMonth(silent: true)
    }

    /// POST /api/shift-roster — إضافة سجل جديد.
    func addEntry(employeeId: Int, date: String, shiftCode: String, teamId: Int?) async throws {
        let y = Int(date.prefix(4)) ?? selectedYear
        let m = Int(date.dropFirst(5).prefix(2)) ?? selectedMonthNumber
        let _: RosterGenericResponseDTO = try await api.post("/api/shift-roster",
            body: RosterAddRequest(employee_id: employeeId, shift_date: date, shift_code: shiftCode,
                                   month: m, year: y, team_id: teamId))
        await reloadMonth(silent: true)
    }

    /// DELETE /api/shift-roster/:id — حذف سجل.
    func deleteEntry(id: Int) async throws {
        let _: RosterGenericResponseDTO = try await api.delete("/api/shift-roster/\(id)")
        await reloadMonth(silent: true)
    }

    /// POST /api/shift-roster/swap — تبديل موظفَي سجلين (معاملة سيرفرية).
    func swap(id1: Int, id2: Int) async throws {
        let _: RosterSwapResponseDTO = try await api.post("/api/shift-roster/swap",
            body: RosterSwapRequest(roster_id_1: id1, roster_id_2: id2))
        await reloadMonth(silent: true)
    }

    /// POST /api/shift-roster/validate — قبل الإضافة فقط (duplicate يطلق على الموجود).
    func validateAdd(employeeId: Int, date: String, shiftCode: String, teamId: Int?) async throws -> RosterValidateResponseDTO {
        try await api.post("/api/shift-roster/validate",
            body: RosterValidateRequest(changes: [
                .init(employee_id: employeeId, shift_date: date, shift_code: shiftCode, team_id: teamId)
            ]))
    }

    /// POST /api/shift-roster/export — يعيد البيانات سطريًا (نشاركها كـJSON).
    func exportJson() async throws -> RosterExportResponseDTO {
        try await api.post("/api/shift-roster/export",
            body: RosterExportRequest(format: "json", month: selectedMonthNumber, year: selectedYear))
    }

    /// GET /api/schedule/pdf — PDF ثنائي حسب مركز أو فئة (A-D).
    func downloadPdf(center: String?, group: String?) async throws -> APIClient.DownloadedFile {
        var q = ["month": selectedMonth]
        if let center { q["center"] = center }
        if let group { q["group"] = group }
        return try await api.download("/api/schedule/pdf", query: q)
    }

    /// POST /api/shift-schedule/generate — يحذف مولّد الشهر السابق ويعيد بناءه (admin/director).
    func generate(mode: String) async throws -> ScheduleGenerateResponseDTO {
        let res: ScheduleGenerateResponseDTO = try await api.post("/api/shift-schedule/generate",
            body: ScheduleGenerateRequest(year: selectedYear, month: selectedMonthNumber, mode: mode))
        await reloadMonth(silent: true)
        return res
    }

    /// POST /api/shift-roster/clear — مسح مدى زمني (موثق بتدقيق delete سيرفري).
    func clearRange(start: String, end: String) async throws -> RosterGenericResponseDTO {
        struct ClearRangeRequest: Encodable { let startDate: String; let endDate: String }
        let res: RosterGenericResponseDTO = try await api.post("/api/shift-roster/clear",
            body: ClearRangeRequest(startDate: start, endDate: end))
        await reloadMonth(silent: true)
        return res
    }

    /// POST /api/shift-roster/clear-all — مسح كامل؛ يُعيد تحميل قائمة الشهور بعده.
    func clearAll() async throws -> RosterGenericResponseDTO {
        let res: RosterGenericResponseDTO = try await api.post("/api/shift-roster/clear-all")
        let m: RosterMonthsDTO = try await api.get("/api/shift-roster/months")
        months = m.months ?? []
        selectedMonth = months.last ?? ""
        roster = []
        stats = nil
        if selectedMonth.isEmpty { rosterState = .loaded } else { await reloadMonth(silent: true) }
        return res
    }

    // MARK: - مسودات/تراجع/تدقيق/بحث (قراءات للشاشات المتقدمة)

    func loadDrafts() async throws -> [RosterDraftsDTO.Draft] {
        let res: RosterDraftsDTO = try await api.get("/api/shift-roster/drafts")
        return res.drafts ?? []
    }

    /// undo سيرفري: يعلّم آخر مسودة «متراجعًا عنها» ويعيدها للعميل — إعادة
    /// التطبيق الفعلية تتم عبر bulk-update بعد تأكيد المستخدم (ليس تراجعًا سيرفريًا).
    func undoDraft() async throws -> RosterDraftActionResponseDTO {
        try await api.post("/api/shift-roster/undo")
    }

    func redoDraft() async throws -> RosterDraftActionResponseDTO {
        try await api.post("/api/shift-roster/redo")
    }

    func applyBulk(changes: [RosterBulkUpdateRequest.Change]) async throws -> RosterBulkResponseDTO {
        let res: RosterBulkResponseDTO = try await api.post("/api/shift-roster/bulk-update",
            body: RosterBulkUpdateRequest(changes: changes))
        await reloadMonth(silent: true)
        return res
    }

    /// فكّ محتوى مسودة إلى تغييرات قابلة لإعادة التطبيق — nil إن تعذّر الفكّ.
    static func decodeDraftChanges(_ json: String?) -> [RosterBulkUpdateRequest.Change]? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        if let arr = try? JSONDecoder().decode([RosterBulkUpdateRequest.Change].self, from: data), !arr.isEmpty {
            return arr
        }
        if let wrapped = try? JSONDecoder().decode(RosterBulkUpdateRequest.self, from: data), !wrapped.changes.isEmpty {
            return wrapped.changes
        }
        return nil
    }

    func audit(employeeId: Int?, dateFrom: String?, dateTo: String?) async throws -> [RosterAuditLogDTO.Entry] {
        var q = ["limit": "100"]
        if let employeeId { q["employee_id"] = String(employeeId) }
        if let dateFrom, let dateTo { q["date_from"] = dateFrom; q["date_to"] = dateTo }
        let res: RosterAuditLogDTO = try await api.get("/api/shift-roster/audit-log", query: q)
        return res.entries ?? []
    }

    func searchEmployees(_ q: String) async throws -> [EmployeeDirectoryDTO.Person] {
        let res: EmployeeDirectoryDTO = try await api.get("/api/employees/search", query: ["q": q])
        return res.results ?? []
    }

    func employeeSchedule(_ id: Int) async throws -> [EmployeeScheduleDTO.Day] {
        let res: EmployeeScheduleDTO = try await api.get(
            "/api/shift-roster/employee-schedule/\(id)",
            query: ["month": String(selectedMonthNumber), "year": String(selectedYear)])
        return res.schedule ?? []
    }
}
