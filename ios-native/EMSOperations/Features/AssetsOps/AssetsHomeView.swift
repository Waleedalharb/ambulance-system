//
//  AssetsHomeView.swift
//  EMSOperations
//
//  مجال العهد والأصول (§16) — الشاشة الرئيسية بأربعة أقسام:
//  لوحة (/api/assets/dashboard) · السجل (/api/assets بحث) · الفروقات
//  (/api/assets/discrepancies + إجراءات الحسم assets.manage) · الجرد
//  (/api/assets/inventory/cycles + إنشاء/تفعيل/إغلاق assets.manage).
//  كل الإجراءات مقيدة بنفس مفاتيح server.js؛ لا منطق أعمال في العميل.
//

import SwiftUI

// MARK: - تسميات عرضية (القيم سيرفرية؛ الخادم يرسل status_labels ونستخدمها أولًا)

enum AssetsDisplay {
    static func statusLabel(_ status: String?, labels: [String: String]?) -> String {
        if let s = status, let l = labels?[s] { return l }
        return status ?? "—"
    }

    static func statusTone(_ status: String?) -> EMSTheme.StatusTone {
        switch status {
        case "working": return .normal
        case "damaged": return .monitor
        case "missing": return .danger
        case "replaced", "recalled", "out_of_service": return .neutral
        default: return .neutral
        }
    }

    static func sessionStatusLabel(_ status: String?) -> String {
        switch status {
        case "open": return "مفتوحة"
        case "submitted": return "مُرسلة"
        case "approved": return "معتمدة"
        default: return status ?? "—"
        }
    }

    static func cycleStatusLabel(_ status: String?) -> String {
        switch status {
        case "draft": return "مسودة"
        case "active": return "نشطة"
        case "closed": return "مغلقة"
        default: return status ?? "—"
        }
    }

    static func resultLabel(_ result: String?) -> String {
        switch result {
        case "ok": return "سليم"
        case "damaged": return "متعطل"
        case "missing": return "مفقود"
        case "replaced": return "مستبدل"
        case "needs_review": return "يحتاج مراجعة"
        default: return result ?? "—"
        }
    }
}

// MARK: - الشاشة الرئيسية

struct AssetsHomeView: View {
    @State private var segment: Segment = .dashboard

    enum Segment: String, CaseIterable, Identifiable {
        case dashboard, registry, discrepancies, inventory
        var id: String { rawValue }
        var title: String {
            switch self {
            case .dashboard: return "اللوحة"
            case .registry: return "السجل"
            case .discrepancies: return "الفروقات"
            case .inventory: return "الجرد"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                Picker("القسم", selection: $segment) {
                    ForEach(Segment.allCases) { s in
                        Text(s.title).tag(s)
                    }
                }
                .pickerStyle(.segmented)

                switch segment {
                case .dashboard: AssetsDashboardSegment()
                case .registry: AssetsRegistrySegment()
                case .discrepancies: DiscrepanciesSegment()
                case .inventory: InventoryCyclesSegment()
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("العهد والأصول")
    }
}

// MARK: - قسم اللوحة

struct AssetsDashboardSegment: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = AssetsDashboardViewModel()

    var body: some View {
        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 4)
            EMSSkeletonCard(lines: 3)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load() } }
        case .loaded:
            content
        }
        if session.permissions.canAssetsManage {
            ImportStagingCard()
        }
        Color.clear.frame(height: 0)
            .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let d = vm.data {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("الإجماليات")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    EMSInfoRow(label: "إجمالي الأصول", value: "\(d.total ?? 0)")
                    EMSInfoRow(label: "يحتاج مراجعة", value: "\(d.needsReview ?? 0)")
                    EMSInfoRow(label: "بلا سيريال", value: "\(d.noSerial ?? 0)")
                    EMSInfoRow(label: "عهدة مشتركة", value: "\(d.shared ?? 0)")
                    EMSInfoRow(label: "استبدالات", value: "\(d.replacements ?? 0)")
                }
            }

            if let cycle = d.activeCycle {
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("دورة الجرد النشطة")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        EMSInfoRow(label: "الدورة", value: cycle.cycle?.label ?? "—")
                        EMSInfoRow(label: "الجلسات", value: "\(cycle.total ?? 0)")
                        EMSInfoRow(label: "مُرسلة", value: "\(cycle.submitted ?? 0)")
                        EMSInfoRow(label: "معتمدة", value: "\(cycle.approved ?? 0)")
                    }
                }
            } else if let last = d.lastCycle {
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("آخر دورة جرد")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        EMSInfoRow(label: "الدورة", value: last.label ?? "—")
                        EMSInfoRow(label: "الحالة", value: AssetsDisplay.cycleStatusLabel(last.status))
                        if let closed = last.closedAt {
                            EMSInfoRow(label: "أُغلقت", value: closed)
                        }
                    }
                }
            }

            if let byStatus = d.byStatus, !byStatus.isEmpty {
                EMSectionHeader(title: "حسب الحالة", systemImage: "chart.bar.fill")
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(byStatus, id: \.status) { row in
                            EMSInfoRow(
                                label: AssetsDisplay.statusLabel(row.status, labels: d.statusLabels),
                                value: "\(row.c ?? 0)")
                        }
                    }
                }
            }

            if let events = d.recentEvents, !events.isEmpty {
                EMSectionHeader(title: "أحدث الأحداث", systemImage: "clock.arrow.circlepath")
                ForEach(events.prefix(10)) { ev in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(ev.assetCode ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                Text(TimelineDisplay.eventLabel(ev.eventType))
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.teal)
                            }
                            if let reason = ev.reason, !reason.isEmpty {
                                Text(reason)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: 6) {
                                if let at = ev.createdAt { Text(at) }
                                if let by = ev.actorName, !by.isEmpty { Text("·"); Text(by) }
                            }
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                    }
                }
            }
        }
    }
}

@MainActor
final class AssetsDashboardViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: AssetsDashboardDTO?
    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/assets/dashboard")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}

// MARK: - بطاقة الاستيراد (assets.manage)

struct ImportStagingCard: View {
    @StateObject private var vm = ImportStagingViewModel()

    var body: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("استيراد الأصول")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Text("الدفعة تُولَّد من ملف الحمولة على الخادم، وتُعتمد بمعاملة واحدة موثقة.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                if let p = vm.preview, let batch = p.batch, batch > 0 {
                    EMSInfoRow(label: "الدفعة الحالية", value: "#\(batch)")
                    EMSInfoRow(label: "الصفوف", value: "\(p.total ?? 0)")
                } else {
                    Text("لا توجد دفعة حالية")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }

                if let msg = vm.infoMessage {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.emerald)
                }

                HStack(spacing: 10) {
                    EMSPrimaryButton(title: "توليد دفعة", isLoading: vm.isMutating) {
                        Task { _ = await vm.stage() }
                    }
                    EMSPrimaryButton(title: "اعتماد الدفعة", isLoading: vm.isMutating) {
                        Task { _ = await vm.approve() }
                    }
                }
            }
        }
        .task { await vm.load() }
    }
}

@MainActor
final class ImportStagingViewModel: ObservableObject {
    @Published var preview: AssetImportPreviewDTO?
    @Published var infoMessage: String?
    @Published var isMutating = false
    private let api = APIClient.shared

    func load() async {
        do {
            preview = try await api.get("/api/assets/import/preview")
        } catch {
            preview = nil
        }
    }

    func stage() async -> String? {
        guard !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let res: AssetWriteResponseDTO = try await api.post("/api/assets/import/stage")
            infoMessage = "تولّدت الدفعة #\(res.batch ?? 0)"
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

    func approve() async -> String? {
        guard !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let res: AssetWriteResponseDTO = try await api.post("/api/assets/import/approve")
            infoMessage = "اعتُمدت الدفعة — أُنشئ \(res.created ?? 0) أصلًا"
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

// MARK: - قسم السجل (بحث + قائمة)

struct AssetsRegistrySegment: View {
    @StateObject private var vm = AssetsRegistryViewModel()
    @State private var search = ""

    var body: some View {
        HStack(spacing: 8) {
            TextField("بحث بالكود أو السيريال أو الاسم", text: $search)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await vm.load(q: search) } }
            Button("بحث") { Task { await vm.load(q: search) } }
                .font(.caption.weight(.semibold))
        }

        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 4)
            EMSSkeletonCard(lines: 3)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load(q: search) } }
        case .loaded:
            let rows = vm.data?.rows ?? []
            if rows.isEmpty {
                EMSEmptyView(icon: "cube", title: "لا نتائج", detail: "لا أصول مطابقة للبحث الحالي")
            } else {
                if let total = vm.data?.total {
                    Text("الإجمالي: \(total)")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                ForEach(rows) { asset in
                    NavigationLink {
                        AssetCardView(assetId: asset.id, assetCode: asset.assetCode)
                    } label: {
                        EMSCard {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(asset.assetCode ?? "—")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.white)
                                    Text([asset.typeName, asset.teamName].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                                }
                                Spacer()
                                if (asset.needsReview ?? 0) == 1 {
                                    EMSStatusPill(text: "مراجعة", tone: .monitor)
                                }
                                EMSStatusPill(
                                    text: AssetsDisplay.statusLabel(asset.status, labels: vm.data?.statusLabels),
                                    tone: AssetsDisplay.statusTone(asset.status))
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }

        Color.clear.frame(height: 0)
            .task { await vm.load(q: "") }
    }
}

@MainActor
final class AssetsRegistryViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: AssetsListDTO?
    private let api = APIClient.shared

    func load(q: String) async {
        state = .loading
        do {
            var query: [String: String] = ["limit": "200"]
            let trimmed = q.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { query["q"] = trimmed }
            data = try await api.get("/api/assets", query: query)
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}

// MARK: - قسم الفروقات (+ إجراءات الحسم assets.manage)

struct DiscrepanciesSegment: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = DiscrepanciesViewModel()
    @State private var actionCase: DiscrepancyCaseDTO?

    private var canManage: Bool { session.permissions.canAssetsManage }

    var body: some View {
        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 4)
            EMSSkeletonCard(lines: 3)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load() } }
        case .loaded:
            let cases = vm.data?.cases ?? []
            if cases.isEmpty {
                EMSEmptyView(icon: "checkmark.shield", title: "لا فروقات", detail: "لا حالات تحتاج انتباهك حاليًا")
            } else {
                ForEach(cases) { c in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                EMSStatusPill(
                                    text: vm.categoryLabel(c.category),
                                    tone: c.priority == "high" ? .danger : .monitor)
                                Spacer()
                                Text(c.assetCode ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                            }
                            if let explanation = c.explanation, !explanation.isEmpty {
                                Text(explanation)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let team = c.teamName {
                                EMSInfoRow(label: "العهدة", value: team)
                            }
                            if let raised = c.raisedAt {
                                EMSInfoRow(label: "ظهر منذ", value: raised)
                            }
                            if canManage, let action = c.suggestedAction {
                                EMSPrimaryButton(
                                    title: vm.actionLabel(action),
                                    isLoading: vm.isMutating
                                ) {
                                    actionCase = c
                                }
                            }
                        }
                    }
                }
            }
        }

        Color.clear.frame(height: 0)
            .task { await vm.load() }
            .sheet(item: $actionCase) { c in
                DiscrepancyActionSheet(discrepancyCase: c, labels: vm.data?.statusLabels) { note in
                    await vm.resolve(c, note: note)
                }
            }
    }
}

struct DiscrepancyActionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let discrepancyCase: DiscrepancyCaseDTO
    let labels: [String: String]?
    let onResolve: (String) async -> String?

    @State private var note = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("الحالة") {
                    Text(discrepancyCase.assetCode ?? "—")
                    if let explanation = discrepancyCase.explanation {
                        Text(explanation).font(.caption)
                    }
                }
                Section("ملاحظة الحسم (إلزامية)") {
                    TextEditor(text: $note).frame(minHeight: 90)
                }
                if let error = errorMessage {
                    Section { Text(error).font(.caption).foregroundStyle(EMSTheme.Colors.danger) }
                }
            }
            .navigationTitle("حسم الفرق")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إلغاء") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("تأكيد") {
                        Task {
                            isSaving = true
                            errorMessage = nil
                            let result = await onResolve(note.trimmingCharacters(in: .whitespacesAndNewlines))
                            isSaving = false
                            if result != nil { dismiss() } else { errorMessage = "تعذّر الحسم — تحقق من الاتصال والصلاحية" }
                        }
                    }
                    .disabled(isSaving || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

@MainActor
final class DiscrepanciesViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: DiscrepanciesDTO?
    @Published var isMutating = false
    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/assets/discrepancies")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func categoryLabel(_ category: String?) -> String {
        if let c = category, let l = data?.categoryLabels?[c] { return l }
        return category ?? "فرق"
    }

    func actionLabel(_ action: String) -> String {
        data?.actionLabels?[action] ?? action
    }

    /// الحسم حسب الإجراء المقترح سيرفريًا — نفس مسارات server.js حرفيًا.
    func resolve(_ c: DiscrepancyCaseDTO, note: String) async -> String? {
        guard !isMutating, !note.isEmpty else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            switch c.suggestedAction {
            case "document_missing":
                guard let id = c.assetId else { return nil }
                let _: BasicSuccessDTO = try await api.post("/api/assets/\(id)/document-missing",
                    body: AssetDocumentMissingRequestDTO(reason: note))
            case "transfer":
                guard let id = c.assetId else { return nil }
                let _: BasicSuccessDTO = try await api.post("/api/assets/\(id)/transfer",
                    body: AssetTransferRequestDTO(toTeam: c.foundTeam ?? c.teamName ?? "", toCenter: nil, reason: note))
            case "review_group":
                guard let serial = c.serialNumber else { return nil }
                let _: AssetWriteResponseDTO = try await api.post("/api/assets/resolve-serial-group",
                    body: SerialGroupResolveRequestDTO(serial: serial, note: note))
            default:
                guard let id = c.assetId else { return nil }
                let _: BasicSuccessDTO = try await api.post("/api/assets/\(id)/resolve-review",
                    body: AssetResolveReviewRequestDTO(note: note, outcome: nil))
            }
            await load()
            return "تم الحسم"
        } catch {
            return nil
        }
    }
}

// MARK: - قسم الجرد (دورات + جلسات)

struct InventoryCyclesSegment: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = InventoryCyclesViewModel()
    @State private var showCreate = false

    private var canManage: Bool { session.permissions.canAssetsManage }

    var body: some View {
        if canManage {
            EMSPrimaryButton(title: "إنشاء دورة جرد", isLoading: vm.isMutating) {
                showCreate = true
            }
        }
        if let msg = vm.infoMessage {
            Text(msg)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.emerald)
        }

        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 4)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load() } }
        case .loaded:
            let cycles = vm.data?.cycles ?? []
            if cycles.isEmpty {
                EMSEmptyView(icon: "checklist", title: "لا دورات جرد", detail: "أنشئ أول دورة جرد من هنا")
            } else {
                ForEach(cycles) { cycle in
                    cycleCard(cycle)
                }
            }
        }

        Color.clear.frame(height: 0)
            .task { await vm.load() }
            .sheet(isPresented: $showCreate) {
                CycleCreateSheet { label, start, end in
                    await vm.create(label: label, periodStart: start, periodEnd: end)
                }
            }
    }

    @ViewBuilder
    private func cycleCard(_ cycle: InventoryCycleDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(cycle.label ?? "دورة #\(cycle.id ?? 0)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    Spacer()
                    EMSStatusPill(
                        text: AssetsDisplay.cycleStatusLabel(cycle.status),
                        tone: cycle.status == "active" ? .action : .neutral)
                }
                HStack(spacing: 10) {
                    Text("الجلسات: \(cycle.sessionsTotal ?? 0)")
                    Text("مُرسلة: \(cycle.sessionsSubmitted ?? 0)")
                    Text("معتمدة: \(cycle.sessionsApproved ?? 0)")
                }
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)

                if canManage {
                    HStack(spacing: 10) {
                        if cycle.status == "draft" {
                            EMSPrimaryButton(title: "تفعيل", isLoading: vm.isMutating) {
                                Task { _ = await vm.activate(cycle) }
                            }
                        }
                        if cycle.status == "active" {
                            EMSPrimaryButton(title: "إغلاق", isLoading: vm.isMutating) {
                                Task { _ = await vm.close(cycle) }
                            }
                        }
                    }
                }

                if let sessions = cycle.sessions, !sessions.isEmpty {
                    Divider().overlay(EMSTheme.Colors.divider)
                    ForEach(sessions) { s in
                        NavigationLink {
                            InventorySessionView(sessionId: s.id ?? 0, teamName: s.teamName)
                        } label: {
                            HStack {
                                Text(s.teamName ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(
                                    text: AssetsDisplay.sessionStatusLabel(s.status),
                                    tone: s.status == "approved" ? .normal : (s.status == "submitted" ? .monitor : .action))
                                Image(systemName: "chevron.left")
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

struct CycleCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreate: (String, String?, String?) async -> String?

    @State private var label = ""
    @State private var start = ""
    @State private var end = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("اسم الدورة (إلزامي)") {
                    TextField("مثال: جرد الربع الثالث 2026", text: $label)
                }
                Section("الفترة (اختياري — YYYY-MM-DD)") {
                    TextField("من", text: $start)
                    TextField("إلى", text: $end)
                }
                if let error = errorMessage {
                    Section { Text(error).font(.caption).foregroundStyle(EMSTheme.Colors.danger) }
                }
            }
            .navigationTitle("دورة جرد جديدة")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إلغاء") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("إنشاء") {
                        Task {
                            isSaving = true
                            errorMessage = nil
                            let s = start.trimmingCharacters(in: .whitespaces)
                            let e = end.trimmingCharacters(in: .whitespaces)
                            let result = await onCreate(
                                label.trimmingCharacters(in: .whitespaces),
                                s.isEmpty ? nil : s,
                                e.isEmpty ? nil : e)
                            isSaving = false
                            if result != nil { dismiss() } else { errorMessage = "تعذّر الإنشاء — تحقق من الاتصال والصلاحية" }
                        }
                    }
                    .disabled(isSaving || label.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

@MainActor
final class InventoryCyclesViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: InventoryCyclesDTO?
    @Published var infoMessage: String?
    @Published var isMutating = false
    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/assets/inventory/cycles")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func create(label: String, periodStart: String?, periodEnd: String?) async -> String? {
        guard !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let res: AssetWriteResponseDTO = try await api.post("/api/assets/inventory/cycles",
                body: InventoryCycleCreateRequestDTO(label: label, periodStart: periodStart, periodEnd: periodEnd))
            infoMessage = "أُنشئت الدورة #\(res.id ?? 0)"
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

    func activate(_ cycle: InventoryCycleDTO) async -> String? {
        guard !isMutating, let id = cycle.id else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let res: AssetWriteResponseDTO = try await api.post("/api/assets/inventory/cycles/\(id)/activate")
            infoMessage = "فُعّلت الدورة — \(res.sessions ?? 0) جلسة فرق"
            await load()
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            await load()
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    func close(_ cycle: InventoryCycleDTO) async -> String? {
        guard !isMutating, let id = cycle.id else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let _: BasicSuccessDTO = try await api.post("/api/assets/inventory/cycles/\(id)/close")
            infoMessage = "أُغلقت الدورة"
            await load()
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            await load()
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }
}
