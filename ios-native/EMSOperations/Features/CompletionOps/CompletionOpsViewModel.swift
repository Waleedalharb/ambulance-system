//
//  CompletionOpsViewModel.swift
//  EMSOperations
//
//  مخزن مجال التكميل العملياتي (§7): المناوبة النشطة + حالة الجاهزية
//  + حوض الدعم + سجلات المناوبة، وكل الكتابات (قرارات الفرق، أحداث
//  الأشخاص، تفعيل/إنهاء، تطوع، سجلات). الختم سيرفري دائمًا (OV-S6-01):
//  نرسل type/date من المناوبة النشطة والخادم يصحح عند الاختلاف.
//  الغيابات/الملاحظات قوائم حرة الحقول — تُدار خامًا (getRaw/postRaw)
//  حفاظًا على حقول الويب (category/priority/resolved…) عند الاستبدال.
//

import Foundation

/// عنصر عرض لقائمة خام (غياب/ملاحظة) — يُشتق تسامحًا من مفاتيح متعددة.
struct CompletionRecordItem: Identifiable {
    let id: String
    let title: String
    let subtitle: String?
    let time: String?
    let resolved: Bool?
    let priority: String?
    let category: String?
}

@MainActor
final class CompletionOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var bootState: LoadState = .loading
    @Published private(set) var shift: CurrentShiftDTO.Shift?
    @Published private(set) var state: StaffingStateDTO?
    @Published private(set) var supporters: [SupportPoolDTO.Supporter] = []
    @Published private(set) var events: [ShiftEventDTO] = []
    @Published private(set) var absences: [CompletionRecordItem] = []
    @Published private(set) var notes: [CompletionRecordItem] = []
    @Published private(set) var recordsState: LoadState = .loading

    private let api = APIClient.shared
    /// النسخ الخام للاستبدال الجماعي — تحفظ الحقول غير المعروفة حرفيًا.
    private var absencesRaw: [[String: Any]] = []
    private var notesRaw: [[String: Any]] = []

    var shiftId: Int? { shift?.id }
    var shiftLabel: String {
        guard let s = shift, s.id != nil else { return "لا توجد مناوبة نشطة" }
        return "\(s.type ?? "—") · \(s.date ?? "—")"
    }

    // MARK: - التحميل

    func load() async {
        if case .loaded = bootState { return }
        bootState = .loading
        do {
            let cur: CurrentShiftDTO = try await api.get("/api/smart-operator/current-shift")
            shift = cur.shift
            guard let id = cur.shift?.id else {
                // لا مناوبة نشطة — حالة فراغ صادقة (التكميل يتطلب مناوبة سيرفريًا)
                bootState = .loaded
                recordsState = .loaded
                return
            }
            try await reloadAll(shiftId: id)
            bootState = .loaded
            recordsState = .loaded
        } catch let e as APIError {
            bootState = .failed(e.userMessage)
        } catch {
            bootState = .failed(APIError.unknown.userMessage)
        }
    }

    func refresh() async {
        guard let id = shiftId else { return }
        try? await reloadAll(shiftId: id)
    }

    private func reloadAll(shiftId: Int) async throws {
        async let stateCall: StaffingStateDTO = api.get("/api/staffing/state", query: ["shift_id": String(shiftId)])
        async let poolCall: SupportPoolDTO = api.get("/api/staffing/available-support", query: ["shift_id": String(shiftId)])
        async let eventsCall: ShiftEventsDTO = api.get("/api/shift-events/\(shiftId)")
        let (st, pool, ev) = try await (stateCall, poolCall, eventsCall)
        state = st
        supporters = pool.supporters ?? []
        events = ev.events ?? []
        await reloadRecords(shiftId: shiftId)
    }

    private func reloadRecords(shiftId: Int) async {
        if let raw = try? await api.getRaw("/api/shift-absences/\(shiftId)") as? [String: Any],
           let list = raw["absences"] as? [[String: Any]] {
            absencesRaw = list
            absences = list.map { absenceItem($0) }
        }
        if let raw = try? await api.getRaw("/api/shift-notes/\(shiftId)") as? [String: Any],
           let list = raw["notes"] as? [[String: Any]] {
            notesRaw = list
            notes = list.map { noteItem($0) }
        }
    }

    // MARK: - إسقاط القوائم الخام للعرض (مفاتيح متسامحة)

    private func firstString(_ dict: [String: Any], _ keys: [String]) -> String? {
        for k in keys {
            if let v = dict[k] as? String, !v.isEmpty { return v }
            if let v = dict[k] as? Int { return String(v) }
        }
        return nil
    }

    private func absenceItem(_ d: [String: Any]) -> CompletionRecordItem {
        CompletionRecordItem(
            id: firstString(d, ["id"]) ?? UUID().uuidString,
            title: firstString(d, ["name", "employee", "person"]) ?? "—",
            subtitle: firstString(d, ["reason"]),
            time: firstString(d, ["timestamp", "createdAt", "created_at"]),
            resolved: nil, priority: nil, category: nil)
    }

    private func noteItem(_ d: [String: Any]) -> CompletionRecordItem {
        CompletionRecordItem(
            id: firstString(d, ["id"]) ?? UUID().uuidString,
            title: firstString(d, ["text", "note", "content", "message"]) ?? "—",
            subtitle: firstString(d, ["author", "by", "createdBy"]),
            time: firstString(d, ["timestamp", "createdAt", "created_at"]),
            resolved: d["resolved"] as? Bool,
            priority: firstString(d, ["priority"]),
            category: firstString(d, ["category"]))
    }

    // MARK: - قرارات الفرق وأحداث الأشخاص (POST /api/shift-completion)

    /// يرسل حدثًا/أحداث شخص عبر عقد VA — يعيد رسالة الخادم وعدد الملحق.
    @discardableResult
    private func sendPersonEvents(_ events: [PersonEventRequest]) async throws -> CompletionSaveResponseDTO {
        guard let s = shift, let type = s.type, let date = s.date else {
            throw APIError.badRequest("لا توجد مناوبة نشطة — ابدأ مناوبة أولًا")
        }
        let res: CompletionSaveResponseDTO = try await api.post("/api/shift-completion",
            body: CompletionEventsRequest(shiftType: type, shiftDate: date, events: events))
        await refresh()
        return res
    }

    /// قرار حالة فريق: ready | missing | offline (جدول قرار مستقل — آخر ضغطة تحكم).
    func setTeamDecision(team: String, status: String, reason: String?) async throws -> CompletionSaveResponseDTO {
        try await sendPersonEvents([PersonEventRequest(type: status, teamId: team, reason: reason)])
    }

    /// حدث شخص: absence/late (سبب إلزامي) · arrival · support_end · correction.
    func sendPersonEvent(type: String, employee: String, teamId: String?,
                         reason: String? = nil, corrects: String? = nil,
                         arrivalAt: String? = nil) async throws -> CompletionSaveResponseDTO {
        try await sendPersonEvents([PersonEventRequest(type: type, employeeName: employee,
                                                       teamId: teamId, reason: reason,
                                                       corrects: corrects, arrivalAt: arrivalAt)])
    }

    // MARK: - التفعيل والتطوع (خدمات staffing المستقلة)

    func activate(employeeName: String, teamName: String, note: String?) async throws -> StaffingActionResponseDTO {
        let res: StaffingActionResponseDTO = try await api.post("/api/staffing/activation",
            body: StaffingActivationRequest(employeeName: employeeName, teamName: teamName, note: note))
        await refresh()
        return res
    }

    func endActivation(employeeName: String, note: String?) async throws -> StaffingActionResponseDTO {
        let res: StaffingActionResponseDTO = try await api.post("/api/staffing/activation/end",
            body: StaffingActivationEndRequest(employeeName: employeeName, note: note))
        await refresh()
        return res
    }

    func addVolunteer(name: String?, code: String?, note: String?) async throws -> StaffingActionResponseDTO {
        let res: StaffingActionResponseDTO = try await api.post("/api/staffing/volunteer",
            body: StaffingVolunteerRequest(employeeCode: code, employeeName: name, note: note))
        await refresh()
        return res
    }

    func searchVolunteers(_ q: String) async throws -> [VolunteerCandidatesDTO.Candidate] {
        guard let id = shiftId else { return [] }
        let res: VolunteerCandidatesDTO = try await api.get("/api/staffing/volunteer-candidates",
                                                            query: ["shift_id": String(id), "q": q])
        return res.candidates ?? []
    }

    // MARK: - سجلات المناوبة (أحداث/غيابات/ملاحظات)

    func addEvent(type: String, description: String) async throws {
        guard let id = shiftId else { return }
        let _: ShiftRecordActionResponseDTO = try await api.post("/api/shift-events/\(id)",
            body: ShiftEventCreateRequest(type: type, description: description))
        await refresh()
    }

    func deleteEvent(_ eventId: String) async throws {
        guard let id = shiftId else { return }
        let _: ShiftRecordActionResponseDTO = try await api.delete("/api/shift-events/\(id)/\(eventId)")
        await refresh()
    }

    /// إضافة غياب عبر الاستبدال الجماعي — النسخة الخام تحفظ حقول السجلات القائمة.
    func addAbsence(name: String, reason: String?) async throws {
        guard let id = shiftId else { return }
        var newEntry: [String: Any] = ["name": name]
        if let reason, !reason.isEmpty { newEntry["reason"] = reason }
        var payload = absencesRaw
        payload.append(newEntry)
        _ = try await api.postRaw("/api/shift-absences/\(id)", jsonObject: ["absences": payload])
        await reloadRecords(shiftId: id)
        await refresh()
    }

    func deleteAbsence(_ absenceId: String) async throws {
        guard let id = shiftId else { return }
        let _: ShiftRecordActionResponseDTO = try await api.delete("/api/shift-absences/\(id)/\(absenceId)")
        await reloadRecords(shiftId: id)
        await refresh()
    }

    /// إضافة ملاحظة بحقول الويب نفسها (text/category/priority/timestamp/resolved).
    func addNote(text: String, category: String, priority: String) async throws {
        guard let id = shiftId else { return }
        let newEntry: [String: Any] = [
            "text": text,
            "category": category,
            "priority": priority,
            "resolved": false,
            "timestamp": ISO8601DateFormatter().string(from: Date())
        ]
        var payload = notesRaw
        payload.append(newEntry)
        _ = try await api.postRaw("/api/shift-notes/\(id)", jsonObject: ["notes": payload])
        await reloadRecords(shiftId: id)
    }

    /// قلب resolved لملاحظة — استبدال جماعي بالنسخة الخام (نفس سلوك الويب).
    func toggleNoteResolved(_ noteId: String) async throws {
        guard let id = shiftId else { return }
        var payload = notesRaw
        for (i, n) in payload.enumerated() {
            let nid = (n["id"] as? String) ?? (n["id"] as? Int).map(String.init)
            if nid == noteId {
                var m = n
                m["resolved"] = !(n["resolved"] as? Bool ?? false)
                payload[i] = m
                break
            }
        }
        _ = try await api.postRaw("/api/shift-notes/\(id)", jsonObject: ["notes": payload])
        await reloadRecords(shiftId: id)
    }

    func deleteNote(_ noteId: String) async throws {
        guard let id = shiftId else { return }
        let _: ShiftRecordActionResponseDTO = try await api.delete("/api/shift-notes/\(id)/\(noteId)")
        await reloadRecords(shiftId: id)
    }
}
