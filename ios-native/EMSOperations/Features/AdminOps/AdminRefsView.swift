//
//  AdminRefsView.swift
//  EMSOperations
//
//  المراجع التشغيلية (§20): الفرق + رموز المناوبات + أنماط المناوبة —
//  CRUD كامل مقيد بدور admin (server.js:11303/11361/12700).
//

import SwiftUI

struct AdminRefsView: View {
    @StateObject private var vm = AdminRefsViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?

    // فريق
    @State private var editingTeam: AdminTeamDTO?
    @State private var showTeamSheet = false
    @State private var tName = ""
    @State private var tCenter = ""
    @State private var tType = ""
    @State private var tSort = ""

    // رمز مناوبة
    @State private var editingCode: ShiftCodeDTO?
    @State private var showCodeSheet = false
    @State private var cCode = ""
    @State private var cName = ""
    @State private var cStart = ""
    @State private var cEnd = ""
    @State private var cStatus = "دوام"

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) { EMSSkeletonCard(lines: 4); EMSSkeletonCard(lines: 4) }
                    .padding(EMSTheme.pagePadding)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.reload(showLoading: true) } }
                    .padding(EMSTheme.pagePadding)
            case .loaded:
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .emsPage("الفرق والرموز")
        .task { await vm.load() }
        .sheet(isPresented: $showTeamSheet) { teamSheet }
        .sheet(isPresented: $showCodeSheet) { codeSheet }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                teamsSection
                codesSection
                patternsSection
                if let infoMessage {
                    Text(infoMessage).font(.caption).foregroundStyle(EMSTheme.Colors.emerald)
                        .multilineTextAlignment(.center)
                }
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.reload() }
    }

    // MARK: - الفرق

    private var teamsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            EMSectionHeader(title: "الفرق", systemImage: "person.3.fill")
            EMSPrimaryButton(title: "إضافة فريق") {
                editingTeam = nil
                tName = ""; tCenter = ""; tType = ""; tSort = ""
                showTeamSheet = true
            }
            ForEach(vm.teams) { team in
                EMSCard {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(team.name ?? "—")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                            Spacer()
                            EMSStatusPill(text: team.active ? "نشط" : "معطّل",
                                          tone: team.active ? .normal : .neutral)
                        }
                        if let center = team.center { EMSInfoRow(label: "المركز", value: center) }
                        if let type = team.teamType, !type.isEmpty { EMSInfoRow(label: "النوع", value: type) }
                        HStack(spacing: 12) {
                            Button("تعديل") {
                                editingTeam = team
                                tName = team.name ?? ""
                                tCenter = team.center ?? ""
                                tType = team.teamType ?? ""
                                tSort = team.sortOrder.map { String($0) } ?? ""
                                showTeamSheet = true
                            }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                            Button("حذف") {
                                confirm = ConfirmRequest(title: "حذف الفريق",
                                    message: "حذف «\(team.name ?? "—")» نهائيًا؟ التعيينات المرتبطة قد تتأثر.",
                                    destructive: true) {
                                    try await vm.deleteTeam(id: team.id ?? 0)
                                    return "حُذف الفريق"
                                }
                            }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.danger)
                        }
                    }
                }
            }
        }
    }

    private var teamSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: editingTeam == nil ? "إضافة فريق" : "تعديل فريق",
                                             systemImage: "person.3.fill")
                            TextField("اسم الفريق", text: $tName).textFieldStyle(.roundedBorder)
                            TextField("المركز", text: $tCenter).textFieldStyle(.roundedBorder)
                            TextField("النوع (اختياري)", text: $tType).textFieldStyle(.roundedBorder)
                            TextField("ترتيب العرض (رقم)", text: $tSort)
                                .textFieldStyle(.roundedBorder).keyboardType(.numberPad)
                                .emsNumericInput()
                            EMSPrimaryButton(title: editingTeam == nil ? "إضافة" : "حفظ", isLoading: working,
                                             isDisabled: tName.trimmingCharacters(in: .whitespaces).isEmpty
                                                || tCenter.trimmingCharacters(in: .whitespaces).isEmpty) {
                                execute {
                                    if let team = editingTeam {
                                        try await vm.updateTeam(id: team.id ?? 0, name: tName, center: tCenter,
                                                                type: tType, sort: Int(tSort), active: team.active)
                                        await MainActor.run { showTeamSheet = false }
                                        return "تم حفظ الفريق"
                                    } else {
                                        try await vm.createTeam(name: tName, center: tCenter,
                                                                type: tType, sort: Int(tSort))
                                        await MainActor.run { showTeamSheet = false }
                                        return "أُضيف الفريق"
                                    }
                                }
                            }
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage(editingTeam == nil ? "إضافة فريق" : "تعديل فريق")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { showTeamSheet = false }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    // MARK: - رموز المناوبات

    private var codesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            EMSectionHeader(title: "رموز المناوبات", systemImage: "tag.fill")
            EMSPrimaryButton(title: "إضافة رمز") {
                editingCode = nil
                cCode = ""; cName = ""; cStart = ""; cEnd = ""; cStatus = "دوام"
                showCodeSheet = true
            }
            ForEach(vm.shiftCodes) { code in
                EMSCard {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(code.code ?? "—")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(code.name ?? "")
                                .font(.subheadline)
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                            Spacer()
                            if let status = code.status {
                                EMSStatusPill(text: status, tone: status == "دوام" ? .normal : .neutral)
                            }
                        }
                        if code.timeStart != nil || code.timeEnd != nil {
                            EMSInfoRow(label: "الوقت",
                                       value: [code.timeStart, code.timeEnd].compactMap { $0 }.joined(separator: " – "))
                        }
                        HStack(spacing: 12) {
                            Button("تعديل") {
                                editingCode = code
                                cCode = code.code ?? ""
                                cName = code.name ?? ""
                                cStart = code.timeStart ?? ""
                                cEnd = code.timeEnd ?? ""
                                cStatus = code.status ?? "دوام"
                                showCodeSheet = true
                            }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                            Button("حذف") {
                                confirm = ConfirmRequest(title: "حذف الرمز",
                                    message: "حذف رمز «\(code.code ?? "—")» نهائيًا؟",
                                    destructive: true) {
                                    try await vm.deleteCode(id: code.id ?? 0)
                                    return "حُذف الرمز"
                                }
                            }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.danger)
                        }
                    }
                }
            }
        }
    }

    private var codeSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: editingCode == nil ? "إضافة رمز" : "تعديل رمز",
                                             systemImage: "tag.fill")
                            TextField("الرمز (مثل: M1)", text: $cCode).textFieldStyle(.roundedBorder)
                                .emsNumericInput()
                            TextField("الاسم", text: $cName).textFieldStyle(.roundedBorder)
                            HStack(spacing: 8) {
                                TextField("البداية HH:MM", text: $cStart).textFieldStyle(.roundedBorder)
                                    .emsNumericInput()
                                TextField("النهاية HH:MM", text: $cEnd).textFieldStyle(.roundedBorder)
                                    .emsNumericInput()
                            }
                            TextField("الحالة", text: $cStatus).textFieldStyle(.roundedBorder)
                            EMSPrimaryButton(title: editingCode == nil ? "إضافة" : "حفظ", isLoading: working,
                                             isDisabled: cCode.trimmingCharacters(in: .whitespaces).isEmpty
                                                || cName.trimmingCharacters(in: .whitespaces).isEmpty) {
                                execute {
                                    if let code = editingCode {
                                        try await vm.updateCode(id: code.id ?? 0, code: cCode, name: cName,
                                                                start: cStart, end: cEnd, status: cStatus)
                                        await MainActor.run { showCodeSheet = false }
                                        return "تم حفظ الرمز"
                                    } else {
                                        try await vm.createCode(code: cCode, name: cName,
                                                                start: cStart, end: cEnd, status: cStatus)
                                        await MainActor.run { showCodeSheet = false }
                                        return "أُضيف الرمز"
                                    }
                                }
                            }
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage(editingCode == nil ? "إضافة رمز" : "تعديل رمز")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { showCodeSheet = false }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    // MARK: - أنماط المناوبة

    private var patternsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            EMSectionHeader(title: "أنماط المناوبة", systemImage: "repeat")
            if vm.patterns.isEmpty {
                Text("لا توجد أنماط معرفة")
                    .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
            } else {
                ForEach(vm.patterns, id: \.code) { pattern in
                    EMSCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(pattern.code ?? "—")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(EMSTheme.Colors.teal)
                                Text(pattern.name ?? "")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                            Spacer()
                            Button(pattern.active ? "تعطيل" : "تفعيل") {
                                confirm = ConfirmRequest(title: pattern.active ? "تعطيل النمط" : "تفعيل النمط",
                                    message: "\(pattern.active ? "تعطيل" : "تفعيل") نمط «\(pattern.code ?? "—")»؟ لا يمس الرموز ولا الجدول.",
                                    destructive: pattern.active) {
                                    try await vm.togglePattern(code: pattern.code ?? "",
                                                               name: pattern.name, active: !pattern.active)
                                    return "تم تحديث النمط"
                                }
                            }
                            .font(.caption.weight(.semibold))
                            .tint(pattern.active ? EMSTheme.Colors.danger : EMSTheme.Colors.emerald)
                        }
                    }
                }
            }
        }
    }

    private func execute(_ work: @escaping () async throws -> String?) {
        working = true
        infoMessage = nil
        errorMessage = nil
        Task {
            do { infoMessage = try await work() }
            catch let e as APIError { errorMessage = e.userMessage }
            catch { errorMessage = APIError.unknown.userMessage }
            working = false
        }
    }
}

// MARK: - ViewModel

@MainActor
final class AdminRefsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var teams: [AdminTeamDTO] = []
    @Published private(set) var shiftCodes: [ShiftCodeDTO] = []
    @Published private(set) var patterns: [ShiftPatternDTO] = []

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            async let t: AdminTeamsResponseDTO = api.get("/api/teams")
            async let c: ShiftCodesResponseDTO = api.get("/api/shift-codes")
            async let p: ShiftPatternsResponseDTO = api.get("/api/shift-patterns")
            let (teamsRes, codesRes, patternsRes) = try await (t, c, p)
            teams = teamsRes.teams ?? []
            shiftCodes = codesRes.codes ?? []
            patterns = patternsRes.patterns ?? []
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func createTeam(name: String, center: String, type: String, sort: Int?) async throws {
        let body = TeamRequestDTO(name: name, center: center,
                                  teamType: type.isEmpty ? nil : type, sortOrder: sort, isActive: nil)
        let res: AdminActionResponseDTO = try await api.post("/api/teams", body: body)
        if res.success == false { throw APIError.server(res.error ?? "فشل في إضافة الفريق") }
        await reload()
    }

    func updateTeam(id: Int, name: String, center: String, type: String, sort: Int?, active: Bool) async throws {
        let body = TeamRequestDTO(name: name, center: center,
                                  teamType: type.isEmpty ? nil : type, sortOrder: sort, isActive: active)
        let res: AdminActionResponseDTO = try await api.put("/api/teams/\(id)", body: body)
        if res.success == false { throw APIError.server(res.error ?? "فشل في تحديث الفريق") }
        await reload()
    }

    func deleteTeam(id: Int) async throws {
        let res: AdminActionResponseDTO = try await api.delete("/api/teams/\(id)")
        if res.success == false { throw APIError.server(res.error ?? "فشل في حذف الفريق") }
        await reload()
    }

    func createCode(code: String, name: String, start: String, end: String, status: String) async throws {
        let body = ShiftCodeRequestDTO(code: code, name: name,
                                       timeStart: start.isEmpty ? nil : start,
                                       timeEnd: end.isEmpty ? nil : end,
                                       color: nil, status: status.isEmpty ? nil : status)
        let res: AdminActionResponseDTO = try await api.post("/api/shift-codes", body: body)
        if res.success == false { throw APIError.server(res.error ?? "فشل في إضافة الرمز") }
        await reload()
    }

    func updateCode(id: Int, code: String, name: String, start: String, end: String, status: String) async throws {
        let body = ShiftCodeRequestDTO(code: code, name: name,
                                       timeStart: start.isEmpty ? nil : start,
                                       timeEnd: end.isEmpty ? nil : end,
                                       color: nil, status: status.isEmpty ? nil : status)
        let res: AdminActionResponseDTO = try await api.put("/api/shift-codes/\(id)", body: body)
        if res.success == false { throw APIError.server(res.error ?? "فشل في تحديث الرمز") }
        await reload()
    }

    func deleteCode(id: Int) async throws {
        let res: AdminActionResponseDTO = try await api.delete("/api/shift-codes/\(id)")
        if res.success == false { throw APIError.server(res.error ?? "فشل في حذف الرمز") }
        await reload()
    }

    func togglePattern(code: String, name: String?, active: Bool) async throws {
        let body = ShiftPatternRequestDTO(name: name, isActive: active)
        let res: AdminActionResponseDTO = try await api.put("/api/shift-patterns/\(code)", body: body)
        if res.success == false { throw APIError.server(res.error ?? "فشل في تحديث النمط") }
        await reload()
    }
}
