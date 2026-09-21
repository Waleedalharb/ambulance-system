//
//  AdminSymbolsView.swift
//  EMSOperations
//
//  رموز الجداول (§20): السجل المركزي + القفل السري المستقل +
//  سجل التعديلات — كلها بمفتاح symbols.manage (server.js:11426+).
//  القفل: unlock يرجع توكن 15 دقيقة يُمرَّر في ترويسة x-symbols-unlock
//  لكل كتابة؛ لا يُخزَّن خارج الجلسة الحالية. ضبط الرمز السري الأول
//  متاح من حساب يحمل المفتاح (server.js:11484).
//

import SwiftUI

struct AdminSymbolsView: View {
    @StateObject private var vm = AdminSymbolsViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var showUnlock = false
    @State private var showSecret = false
    @State private var showAudit = false
    @State private var showAdd = false

    @State private var secretInput = ""
    @State private var secCurrent = ""
    @State private var secNext = ""
    @State private var secConfirm = ""
    @State private var sCode = ""
    @State private var sType = ""
    @State private var sName = ""

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
        .emsPage("رموز الجداول")
        .task { await vm.load() }
        .sheet(isPresented: $showUnlock) { unlockSheet }
        .sheet(isPresented: $showSecret) { secretSheet }
        .sheet(isPresented: $showAudit) { auditSheet }
        .sheet(isPresented: $showAdd) { addSheet }
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
                lockCard
                if vm.isUnlocked {
                    EMSPrimaryButton(title: "إضافة رمز", isLoading: working) {
                        sCode = ""; sType = ""; sName = ""
                        showAdd = true
                    }
                }
                symbolsList
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

    // MARK: - القفل

    private var lockCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: "قفل الإدارة", systemImage: "lock.shield")
                    Spacer()
                    EMSStatusPill(text: vm.isUnlocked ? "مفتوح" : "مقفل",
                                  tone: vm.isUnlocked ? .normal : .monitor)
                }
                if vm.secretConfigured == false {
                    Text("لم يُضبط رمز إدارة الأكواد بعد — اضبطه أولًا لتفعيل الكتابة.")
                        .font(.caption).foregroundStyle(EMSTheme.Colors.warning)
                    Button("ضبط الرمز السري") { showSecret = true }
                        .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                } else {
                    HStack(spacing: 12) {
                        if vm.isUnlocked {
                            Button("قفل الآن") {
                                execute {
                                    try await vm.lock()
                                    return "تم قفل الإدارة"
                                }
                            }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.danger)
                        } else {
                            Button("فتح القفل") {
                                secretInput = ""
                                showUnlock = true
                            }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                        }
                        Button("تغيير الرمز السري") { showSecret = true }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                        Button("سجل التعديلات") { showAudit = true }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                    }
                }
            }
        }
    }

    private var unlockSheet: some View {
        NavigationStack {
            VStack(spacing: EMSTheme.spacing) {
                EMSCard {
                    VStack(alignment: .leading, spacing: 10) {
                        EMSectionHeader(title: "فتح قفل الإدارة", systemImage: "lock.open")
                        Text("الرمز السري المستقل — الجلسة المفتوحة تدوم 15 دقيقة وتُبطل عند تغيير الرمز.")
                            .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
                        SecureField("الرمز السري", text: $secretInput)
                            .textFieldStyle(.roundedBorder)
                        EMSPrimaryButton(title: "فتح", isLoading: working,
                                         isDisabled: secretInput.isEmpty) {
                            execute {
                                try await vm.unlock(secret: secretInput)
                                await MainActor.run { showUnlock = false; secretInput = "" }
                                return "فُتح القفل — يمكنك الآن الإضافة والتعديل"
                            }
                        }
                    }
                }
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                }
            }
            .padding(EMSTheme.pagePadding)
            .emsPage("فتح القفل")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { showUnlock = false }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private var secretSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: "الرمز السري لإدارة الأكواد", systemImage: "key.fill")
                            Text("6 أحرف على الأقل. تغييره يُبطل كل الجلسات المفتوحة.")
                                .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
                            if vm.secretConfigured == true {
                                SecureField("الرمز الحالي", text: $secCurrent)
                                    .textFieldStyle(.roundedBorder)
                            }
                            SecureField("الرمز الجديد", text: $secNext)
                                .textFieldStyle(.roundedBorder)
                            SecureField("تأكيد الرمز الجديد", text: $secConfirm)
                                .textFieldStyle(.roundedBorder)
                            EMSPrimaryButton(title: "حفظ الرمز", isLoading: working,
                                             isDisabled: secNext.count < 6 || secNext != secConfirm) {
                                execute {
                                    try await vm.setSecret(current: secCurrent.isEmpty ? nil : secCurrent,
                                                           next: secNext, confirm: secConfirm)
                                    await MainActor.run {
                                        showSecret = false
                                        secCurrent = ""; secNext = ""; secConfirm = ""
                                    }
                                    return "تم حفظ الرمز السري"
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
            .emsPage("الرمز السري")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { showSecret = false }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    // MARK: - السجل

    private var symbolsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            EMSectionHeader(title: "السجل المركزي (\(vm.symbols.count))")
            ForEach(vm.symbols, id: \.stableId) { symbol in
                EMSCard {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(symbol.code ?? "—")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(symbol.name ?? "")
                                .font(.subheadline)
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                            Spacer()
                            if let status = symbol.status {
                                EMSStatusPill(text: status, tone: status == "active" ? .normal : .neutral)
                            }
                        }
                        HStack(spacing: 12) {
                            if let type = symbol.symbolType {
                                Text(type).font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            if let source = symbol.source {
                                Text(source).font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            if let hours = symbol.hours {
                                Text("\(hours, specifier: "%.1f")س").font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                        if vm.isUnlocked, let id = symbol.id {
                            HStack(spacing: 12) {
                                Button(symbol.status == "active" ? "إيقاف" : "تفعيل") {
                                    let target = symbol.status == "active" ? "disabled" : "active"
                                    confirm = ConfirmRequest(title: "تغيير حالة الرمز",
                                        message: "تغيير حالة «\(symbol.code ?? "—")» إلى \(target == "active" ? "نشط" : "موقوف")؟",
                                        destructive: target != "active") {
                                        try await vm.setStatus(id: id, status: target)
                                        return "تم تحديث الحالة"
                                    }
                                }
                                .font(.caption.weight(.semibold))
                                .tint(symbol.status == "active" ? EMSTheme.Colors.danger : EMSTheme.Colors.emerald)
                            }
                        }
                    }
                }
            }
        }
    }

    private var auditSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    if vm.auditLog.isEmpty {
                        EMSEmptyView(icon: "doc.text.magnifyingglass", title: "لا سجل",
                                     detail: "لا توجد تعديلات مسجلة على الرموز.")
                    } else {
                        ForEach(vm.auditLog, id: \.id) { entry in
                            EMSCard {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(entry.action ?? "—")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                                        Spacer()
                                        if let at = entry.createdAt {
                                            Text(at).font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                                        }
                                    }
                                    if let code = entry.code {
                                        Text("الرمز: \(code)").font(.caption2).foregroundStyle(EMSTheme.Colors.teal)
                                    }
                                    if let actor = entry.actorName {
                                        Text("بواسطة: \(actor)").font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage("سجل تعديلات الرموز")
            .task { await vm.loadAudit() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { showAudit = false }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private var addSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: "إضافة رمز", systemImage: "plus.square")
                            TextField("الكود", text: $sCode).textFieldStyle(.roundedBorder)
                                .emsNumericInput()
                            TextField("النوع (مثل: day_code / employee_symbol)", text: $sType)
                                .textFieldStyle(.roundedBorder)
                            TextField("الاسم (اختياري)", text: $sName).textFieldStyle(.roundedBorder)
                            EMSPrimaryButton(title: "إضافة", isLoading: working,
                                             isDisabled: sCode.trimmingCharacters(in: .whitespaces).isEmpty
                                                || sType.trimmingCharacters(in: .whitespaces).isEmpty) {
                                execute {
                                    try await vm.addSymbol(code: sCode, type: sType, name: sName)
                                    await MainActor.run { showAdd = false }
                                    return "أُضيف الرمز"
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
            .emsPage("إضافة رمز")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { showAdd = false }.tint(EMSTheme.Colors.teal)
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
final class AdminSymbolsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var symbols: [SymbolEntryDTO] = []
    @Published private(set) var secretConfigured: Bool?
    @Published private(set) var auditLog: [SymbolAuditEntryDTO] = []

    /// توكن القفل — ذاكرة الجلسة فقط (15 دقيقة سيرفريًا)، لا يُخزَّن.
    @Published private(set) var unlockToken: String?

    var isUnlocked: Bool { unlockToken != nil }

    private let api = APIClient.shared
    private var unlockHeaders: [String: String] {
        guard let token = unlockToken else { return [:] }
        return ["x-symbols-unlock": token]
    }

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            let res: SymbolsRegistryResponseDTO = try await api.get("/api/schedule-symbols")
            symbols = res.symbols ?? []
            secretConfigured = res.secretConfigured
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func loadAudit() async {
        if let res: SymbolAuditResponseDTO = try? await api.get("/api/schedule-symbols/audit") {
            auditLog = res.log ?? []
        }
    }

    func unlock(secret: String) async throws {
        let res: SymbolUnlockResponseDTO = try await api.post("/api/schedule-symbols/unlock",
                                                              body: SymbolUnlockRequestDTO(secret: secret))
        guard res.success == true, let token = res.unlockToken else {
            throw APIError.server("فشل في فتح القفل")
        }
        unlockToken = token
    }

    func lock() async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/schedule-symbols/lock",
                                                             body: EmptyBodyDTO(),
                                                             headers: unlockHeaders)
        if res.success == false { throw APIError.server(res.error ?? "فشل في القفل") }
        unlockToken = nil
    }

    func setSecret(current: String?, next: String, confirm: String) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/schedule-symbols/secret",
            body: SymbolSecretRequestDTO(current: current, next: next, confirm: confirm))
        if res.success == false { throw APIError.server(res.error ?? "فشل في حفظ الرمز السري") }
        unlockToken = nil // الخادم يُبطل كل الجلسات المفتوحة عند تغيير الرمز
        await reload()
    }

    func addSymbol(code: String, type: String, name: String) async throws {
        guard isUnlocked else { throw APIError.server("افتح قفل الإدارة أولًا") }
        let body = SymbolCreateRequestDTO(code: code.trimmingCharacters(in: .whitespaces),
                                          symbolType: type.trimmingCharacters(in: .whitespaces),
                                          name: name.isEmpty ? nil : name)
        let res: AdminActionResponseDTO = try await api.post("/api/schedule-symbols",
                                                             body: body, headers: unlockHeaders)
        if res.success == false { throw APIError.server(res.error ?? "فشل في إضافة الرمز") }
        await reload()
    }

    func setStatus(id: Int, status: String) async throws {
        guard isUnlocked else { throw APIError.server("افتح قفل الإدارة أولًا") }
        let res: AdminActionResponseDTO = try await api.post("/api/schedule-symbols/\(id)/status",
                                                             body: SymbolStatusRequestDTO(status: status),
                                                             headers: unlockHeaders)
        if res.success == false { throw APIError.server(res.error ?? "فشل في تحديث الحالة") }
        await reload()
    }
}
