//
//  AssetDetailViews.swift
//  EMSOperations
//
//  مجال العهد والأصول (§16) — بطاقة الجهاز وجلسة الجرد:
//  · AssetCardView: GET /api/assets/:id (الأصل + الأحداث + الاستبدالات)
//    + نقل/حسم مراجعة/توثيق فقد (assets.manage).
//  · InventorySessionView: GET /api/assets/inventory/sessions/:id
//    + تسجيل نتيجة جهاز/جهاز مكتشف/إرسال (INV_EXEC: assets.inventory|manage)
//    + مراجعة/اعتماد/إعادة فتح (assets.manage).
//

import SwiftUI

// MARK: - بطاقة الجهاز

struct AssetCardView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm: AssetCardViewModel
    @State private var action: ManageAction?

    enum ManageAction: Identifiable {
        case transfer, resolveReview, documentMissing
        var id: Int {
            switch self {
            case .transfer: return 1
            case .resolveReview: return 2
            case .documentMissing: return 3
            }
        }
        var title: String {
            switch self {
            case .transfer: return "نقل العهدة"
            case .resolveReview: return "حسم المراجعة"
            case .documentMissing: return "توثيق الفقد"
            }
        }
    }

    init(assetId: Int, assetCode: String?) {
        _vm = StateObject(wrappedValue: AssetCardViewModel(assetId: assetId, assetCode: assetCode))
    }

    private var canManage: Bool { session.permissions.canAssetsManage }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 5)
                    EMSSkeletonCard(lines: 3)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    content
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage(vm.assetCode ?? "بطاقة الجهاز")
        .task { await vm.load() }
        .sheet(item: $action) { act in
            AssetManageActionSheet(action: act, asset: vm.data?.asset) { fields in
                await vm.perform(act, fields: fields)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let asset = vm.data?.asset {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(asset.assetCode ?? "—")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                        Spacer()
                        EMSStatusPill(
                            text: AssetsDisplay.statusLabel(asset.status, labels: vm.data?.statusLabels),
                            tone: AssetsDisplay.statusTone(asset.status))
                    }
                    EMSInfoRow(label: "النوع", value: asset.typeName ?? "—")
                    if let name = asset.originalName, !name.isEmpty, name != asset.typeName {
                        EMSInfoRow(label: "الاسم الأصلي", value: name)
                    }
                    EMSInfoRow(label: "السيريال", value: asset.serialNumber ?? "—")
                    EMSInfoRow(label: "العهدة", value: asset.teamName ?? "—")
                    if let center = asset.centerName {
                        EMSInfoRow(label: "المركز", value: center)
                    }
                    EMSInfoRow(label: "العهدة", value: asset.custody == "shared" ? "مشتركة" : "حصرية")
                    if (asset.needsReview ?? 0) == 1 {
                        EMSInfoRow(label: "المراجعة", value: "يحتاج مراجعة", valueColor: EMSTheme.Colors.warning)
                    }
                    if let notes = asset.notes, !notes.isEmpty {
                        EMSInfoRow(label: "ملاحظات", value: notes)
                    }
                }
            }

            if canManage {
                EMSCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("إجراءات الإدارة")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        HStack(spacing: 10) {
                            EMSPrimaryButton(title: "نقل", isLoading: vm.isMutating) { action = .transfer }
                            if (asset.needsReview ?? 0) == 1 {
                                EMSPrimaryButton(title: "حسم مراجعة", isLoading: vm.isMutating) { action = .resolveReview }
                            }
                            if asset.status == "missing" {
                                EMSPrimaryButton(title: "توثيق الفقد", isLoading: vm.isMutating) { action = .documentMissing }
                            }
                        }
                        if let msg = vm.infoMessage {
                            Text(msg)
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.emerald)
                        }
                    }
                }
            }

            if let replacements = vm.data?.replacements, !replacements.isEmpty {
                EMSectionHeader(title: "الاستبدالات", systemImage: "arrow.triangle.2.circlepath")
                ForEach(replacements) { r in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            EMSInfoRow(label: "من", value: r.oldAsset?.assetCode ?? "—")
                            EMSInfoRow(label: "إلى", value: r.newAsset?.assetCode ?? "—")
                            if let reason = r.reason, !reason.isEmpty {
                                EMSInfoRow(label: "السبب", value: reason)
                            }
                            if let at = r.createdAt {
                                EMSInfoRow(label: "التاريخ", value: at)
                            }
                        }
                    }
                }
            }

            let events = vm.data?.events ?? []
            if !events.isEmpty {
                EMSectionHeader(title: "سجل الأحداث", systemImage: "clock.arrow.circlepath")
                ForEach(events) { ev in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(TimelineDisplay.eventLabel(ev.eventType))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(EMSTheme.Colors.teal)
                                Spacer()
                                if let at = ev.createdAt {
                                    Text(at)
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            if let reason = ev.reason, !reason.isEmpty {
                                Text(reason)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let by = ev.actorName, !by.isEmpty {
                                Text("بواسطة: \(by)")
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                    }
                }
            }
        }
    }
}

struct AssetManageActionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let action: AssetCardView.ManageAction
    let asset: AssetDTO?
    let onSave: ([String: String]) async -> String?

    @State private var toTeam = ""
    @State private var toCenter = ""
    @State private var note = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("الجهاز") {
                    Text(asset?.assetCode ?? "—")
                }
                if action == .transfer {
                    Section("الوجهة الجديدة") {
                        TextField("الفرقة/الموقع (إلزامي)", text: $toTeam)
                        TextField("المركز (اختياري)", text: $toCenter)
                    }
                }
                Section(action == .transfer ? "سبب النقل (إلزامي)" : "الملاحظة (إلزامية)") {
                    TextEditor(text: $note).frame(minHeight: 90)
                }
                if let error = errorMessage {
                    Section { Text(error).font(.caption).foregroundStyle(EMSTheme.Colors.danger) }
                }
            }
            .navigationTitle(action.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إلغاء") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("تأكيد") {
                        Task {
                            isSaving = true
                            errorMessage = nil
                            var fields = ["note": note.trimmingCharacters(in: .whitespacesAndNewlines)]
                            fields["toTeam"] = toTeam.trimmingCharacters(in: .whitespaces)
                            fields["toCenter"] = toCenter.trimmingCharacters(in: .whitespaces)
                            let result = await onSave(fields)
                            isSaving = false
                            if result != nil { dismiss() } else { errorMessage = "تعذّر التنفيذ — تحقق من الاتصال والصلاحية" }
                        }
                    }
                    .disabled(isSaving || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || (action == .transfer && toTeam.trimmingCharacters(in: .whitespaces).isEmpty))
                }
            }
        }
    }
}

@MainActor
final class AssetCardViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: AssetCardDTO?
    @Published var infoMessage: String?
    @Published var isMutating = false

    let assetId: Int
    let assetCode: String?
    private let api = APIClient.shared

    init(assetId: Int, assetCode: String?) {
        self.assetId = assetId
        self.assetCode = assetCode
    }

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/assets/\(assetId)")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func perform(_ action: AssetCardView.ManageAction, fields: [String: String]) async -> String? {
        guard !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        let note = fields["note"] ?? ""
        do {
            switch action {
            case .transfer:
                let center = fields["toCenter"] ?? ""
                let _: BasicSuccessDTO = try await api.post("/api/assets/\(assetId)/transfer",
                    body: AssetTransferRequestDTO(
                        toTeam: fields["toTeam"] ?? "",
                        toCenter: center.isEmpty ? nil : center,
                        reason: note))
                infoMessage = "تم نقل العهدة"
            case .resolveReview:
                let _: BasicSuccessDTO = try await api.post("/api/assets/\(assetId)/resolve-review",
                    body: AssetResolveReviewRequestDTO(note: note, outcome: nil))
                infoMessage = "تم حسم المراجعة"
            case .documentMissing:
                let _: BasicSuccessDTO = try await api.post("/api/assets/\(assetId)/document-missing",
                    body: AssetDocumentMissingRequestDTO(reason: note))
                infoMessage = "تم توثيق الفقد"
            }
            await load()
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }
}

// MARK: - جلسة الجرد

struct InventorySessionView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm: InventorySessionViewModel
    @State private var recordAsset: AssetDTO?
    @State private var showDiscovered = false

    init(sessionId: Int, teamName: String?) {
        _vm = StateObject(wrappedValue: InventorySessionViewModel(sessionId: sessionId, teamName: teamName))
    }

    private var canExecute: Bool { session.permissions.canAssetsInventory }
    private var canManage: Bool { session.permissions.canAssetsManage }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 3)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    content
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage(vm.teamName ?? "جلسة الجرد")
        .task { await vm.load() }
        .sheet(item: $recordAsset) { asset in
            InventoryItemSheet(asset: asset) { result, reason, serialSeen, locationNote in
                await vm.record(asset: asset, result: result, reason: reason, serialSeen: serialSeen, locationNote: locationNote)
            }
        }
        .sheet(isPresented: $showDiscovered) {
            DiscoveredAssetSheet { typeName, originalName, serial, reason, locationNote in
                await vm.recordDiscovered(typeName: typeName, originalName: originalName, serial: serial, reason: reason, locationNote: locationNote)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let s = vm.data?.session {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(s.teamName ?? "—")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Spacer()
                        EMSStatusPill(
                            text: AssetsDisplay.sessionStatusLabel(s.status),
                            tone: s.status == "approved" ? .normal : (s.status == "submitted" ? .monitor : .action))
                    }
                    if let conductor = s.conductorName {
                        EMSInfoRow(label: "المجرى", value: conductor)
                    }
                    EMSInfoRow(label: "المتوقع", value: "\(vm.data?.expected?.count ?? 0)")
                    EMSInfoRow(label: "المسجل", value: "\(vm.data?.items?.count ?? 0)")
                }
            }

            if let msg = vm.infoMessage {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.emerald)
            }

            // إجراءات التنفيذ (INV_EXEC) — تظهر فقط للجلسة المفتوحة
            if canExecute, s.status == "open" {
                HStack(spacing: 10) {
                    EMSPrimaryButton(title: "جهاز مكتشف", isLoading: vm.isMutating) {
                        showDiscovered = true
                    }
                    EMSPrimaryButton(title: "إرسال للاعتماد", isLoading: vm.isMutating) {
                        Task { _ = await vm.submit() }
                    }
                }
            }

            // إجراءات الإدارة (assets.manage)
            if canManage {
                HStack(spacing: 10) {
                    if s.status == "submitted" {
                        EMSPrimaryButton(title: "اعتماد الجلسة", isLoading: vm.isMutating) {
                            Task { _ = await vm.approve() }
                        }
                    }
                    if s.status == "submitted" || s.status == "approved" {
                        EMSPrimaryButton(title: "إعادة فتح", isLoading: vm.isMutating) {
                            Task { _ = await vm.reopen() }
                        }
                    }
                }
            }

            // النتائج المسجلة
            let items = vm.data?.items ?? []
            if !items.isEmpty {
                EMSectionHeader(title: "النتائج المسجلة", systemImage: "checklist")
                ForEach(items) { item in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(item.assetCode ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(
                                    text: AssetsDisplay.resultLabel(item.result),
                                    tone: item.result == "ok" ? .normal : (item.result == "missing" ? .danger : .monitor))
                            }
                            if let type = item.typeName {
                                EMSInfoRow(label: "النوع", value: type)
                            }
                            if let reason = item.reason, !reason.isEmpty {
                                EMSInfoRow(label: "السبب", value: reason)
                            }
                            if (item.discovered ?? 0) == 1 {
                                EMSInfoRow(label: "الاكتشاف", value: "مكتشف ميدانيًا")
                            }
                        }
                    }
                }
            }

            // الأجهزة المتوقعة — النقر يسجل النتيجة (INV_EXEC وجلسة مفتوحة)
            let expected = vm.data?.expected ?? []
            if !expected.isEmpty {
                EMSectionHeader(title: "الأجهزة المتوقعة", systemImage: "cube")
                ForEach(expected) { asset in
                    EMSCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(asset.assetCode ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                Text(asset.typeName ?? "—")
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                if let serial = asset.serialNumber, !serial.isEmpty {
                                    Text("SN: \(serial)")
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            Spacer()
                            if canExecute, s.status == "open" {
                                Button("تسجيل") { recordAsset = asset }
                                    .font(.caption.weight(.semibold))
                            }
                        }
                    }
                }
            }
        }
    }
}

struct InventoryItemSheet: View {
    @Environment(\.dismiss) private var dismiss
    let asset: AssetDTO
    let onSave: (String, String?, String?, String?) async -> String?

    @State private var result = "ok"
    @State private var reason = ""
    @State private var serialSeen = ""
    @State private var locationNote = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let results = ["ok", "damaged", "missing", "replaced", "needs_review"]

    var body: some View {
        NavigationStack {
            Form {
                Section("الجهاز") {
                    Text(asset.assetCode ?? "—")
                    if let type = asset.typeName { Text(type).font(.caption) }
                }
                Section("النتيجة") {
                    Picker("النتيجة", selection: $result) {
                        ForEach(results, id: \.self) { r in
                            Text(AssetsDisplay.resultLabel(r)).tag(r)
                        }
                    }
                }
                Section("السبب (إلزامي عند الفقد)") {
                    TextEditor(text: $reason).frame(minHeight: 70)
                }
                Section("اختياري") {
                    TextField("السيريال المرئي", text: $serialSeen)
                        .emsNumericInput()
                    TextField("ملاحظة الموقع", text: $locationNote)
                }
                if let error = errorMessage {
                    Section { Text(error).font(.caption).foregroundStyle(EMSTheme.Colors.danger) }
                }
            }
            .navigationTitle("تسجيل نتيجة")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إلغاء") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("حفظ") {
                        Task {
                            isSaving = true
                            errorMessage = nil
                            let r = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                            let sn = serialSeen.trimmingCharacters(in: .whitespaces)
                            let ln = locationNote.trimmingCharacters(in: .whitespaces)
                            let saved = await onSave(
                                result,
                                r.isEmpty ? nil : r,
                                sn.isEmpty ? nil : sn,
                                ln.isEmpty ? nil : ln)
                            isSaving = false
                            if saved != nil { dismiss() } else { errorMessage = "تعذّر الحفظ — الفقد يتطلب سببًا إلزاميًا" }
                        }
                    }
                    .disabled(isSaving || (result == "missing" && reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
        }
    }
}

struct DiscoveredAssetSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (String, String?, String?, String?, String?) async -> String?

    @State private var typeName = ""
    @State private var originalName = ""
    @State private var serial = ""
    @State private var reason = ""
    @State private var locationNote = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("نوع الجهاز (إلزامي)") {
                    TextField("مثال: جهاز صدمات", text: $typeName)
                }
                Section("تفاصيل") {
                    TextField("الاسم الأصلي (اختياري)", text: $originalName)
                    TextField("السيريال (اختياري)", text: $serial)
                        .emsNumericInput()
                    TextField("ملاحظة الموقع (اختياري)", text: $locationNote)
                }
                Section("ملاحظة (اختياري)") {
                    TextEditor(text: $reason).frame(minHeight: 70)
                }
                if let error = errorMessage {
                    Section { Text(error).font(.caption).foregroundStyle(EMSTheme.Colors.danger) }
                }
            }
            .navigationTitle("جهاز مكتشف")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إلغاء") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("تسجيل") {
                        Task {
                            isSaving = true
                            errorMessage = nil
                            let on = originalName.trimmingCharacters(in: .whitespaces)
                            let sn = serial.trimmingCharacters(in: .whitespaces)
                            let rs = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                            let ln = locationNote.trimmingCharacters(in: .whitespaces)
                            let saved = await onSave(
                                typeName.trimmingCharacters(in: .whitespaces),
                                on.isEmpty ? nil : on,
                                sn.isEmpty ? nil : sn,
                                rs.isEmpty ? nil : rs,
                                ln.isEmpty ? nil : ln)
                            isSaving = false
                            if saved != nil { dismiss() } else { errorMessage = "تعذّر التسجيل — تحقق من الاتصال والصلاحية" }
                        }
                    }
                    .disabled(isSaving || typeName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

@MainActor
final class InventorySessionViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: InventorySessionDetailDTO?
    @Published var infoMessage: String?
    @Published var isMutating = false

    let sessionId: Int
    let teamName: String?
    private let api = APIClient.shared

    init(sessionId: Int, teamName: String?) {
        self.sessionId = sessionId
        self.teamName = teamName
    }

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/assets/inventory/sessions/\(sessionId)")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    private func mutate(_ work: () async throws -> String) async -> String? {
        guard !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let message = try await work()
            infoMessage = message
            await load()
            return message
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    func record(asset: AssetDTO, result: String, reason: String?, serialSeen: String?, locationNote: String?) async -> String? {
        await mutate {
            let _: AssetWriteResponseDTO = try await api.post("/api/assets/inventory/sessions/\(sessionId)/items",
                body: InventoryItemRequestDTO(
                    assetId: asset.id, result: result, reason: reason,
                    serialSeen: serialSeen, locationNote: locationNote, discovered: nil))
            return "سُجّلت النتيجة"
        }
    }

    func recordDiscovered(typeName: String, originalName: String?, serial: String?, reason: String?, locationNote: String?) async -> String? {
        await mutate {
            let res: AssetWriteResponseDTO = try await api.post("/api/assets/inventory/sessions/\(sessionId)/discovered",
                body: DiscoveredAssetRequestDTO(
                    typeName: typeName, originalName: originalName, serialNumber: serial,
                    reason: reason, locationNote: locationNote, notes: nil))
            if let warning = res.warning { return warning }
            return "سُجّل الجهاز المكتشف (\(res.assetCode ?? "—"))"
        }
    }

    func submit() async -> String? {
        await mutate {
            let res: AssetWriteResponseDTO = try await api.post("/api/assets/inventory/sessions/\(sessionId)/submit")
            return "أُرسلت الجلسة — \(res.items ?? 0) جهازًا"
        }
    }

    func approve() async -> String? {
        await mutate {
            let _: BasicSuccessDTO = try await api.post("/api/assets/inventory/sessions/\(sessionId)/approve")
            return "اعتُمدت الجلسة"
        }
    }

    func reopen() async -> String? {
        await mutate {
            let _: BasicSuccessDTO = try await api.post("/api/assets/inventory/sessions/\(sessionId)/reopen")
            return "أُعيد فتح الجلسة"
        }
    }
}
