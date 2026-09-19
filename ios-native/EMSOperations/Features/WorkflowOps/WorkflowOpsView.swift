//
//  WorkflowOpsView.swift
//  EMSOperations
//
//  سير العمل الرسمي (§13): نسخ المناوبة + إعداد مسودة + تحرير حقول
//  المشرف + اعتماد + إعادة إصدار + مشاركة PDF المعتمدة. الصلاحيات:
//  workflow.view للعرض · workflow.manage للإعداد/التحرير/إعادة الإصدار ·
//  workflow.approve للاعتماد. من لا يملك الصلاحية لا يرى الإجراء.
//

import SwiftUI

struct WorkflowOpsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = WorkflowOpsViewModel()

    @State private var detail: WorkflowVersionDTO?
    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var reason: ReasonRequest?
    @State private var reasonText = ""
    @State private var shareItems: [Any]?

    // حقول المشرف (تحرير المسودة)
    @State private var fSummary = ""
    @State private var fNotes = ""
    @State private var fEvents = ""
    @State private var fIssues = ""
    @State private var fRecommendations = ""
    @State private var fReviewedBy: Set<String> = []

    private var canView: Bool { session.permissions.canViewWorkflow }
    private var canManage: Bool { session.permissions.canManageWorkflow }
    private var canApprove: Bool { session.permissions.canApproveWorkflow }

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) {
                    EMSSkeletonCard(lines: 3)
                    EMSSkeletonCard(lines: 4)
                }
                .padding(EMSTheme.pagePadding)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.reload(showLoading: true) } }
                    .padding(EMSTheme.pagePadding)
            case .loaded:
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .emsPage("سير العمل")
        .task { await vm.load() }
        .sheet(item: $detail) { detailSheet($0) }
        .sheet(item: $reason) { req in reasonSheet(req) }
        .sheet(isPresented: Binding(get: { shareItems != nil }, set: { if !$0 { shareItems = nil } })) {
            if let shareItems { ActivityShareSheet(items: shareItems) }
        }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
    }

    // MARK: - المحتوى

    @ViewBuilder
    private var content: some View {
        if vm.shiftId == nil {
            EMSEmptyView(icon: "moon.zzz", title: "لا توجد مناوبة نشطة",
                         detail: "سير العمل مرتبط بالمناوبة النشطة — ابدأ مناوبة أولًا.")
        } else {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    headerCard
                    versionsSection
                    if let infoMessage {
                        Text(infoMessage)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.emerald)
                            .multilineTextAlignment(.center)
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.danger)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .refreshable { await vm.reload() }
        }
    }

    private var headerCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: "checkmark.doc.fill")
                        .foregroundStyle(EMSTheme.Colors.teal)
                    Text(vm.shiftLabel ?? "المناوبة النشطة")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if working { ProgressView().tint(EMSTheme.Colors.teal) }
                }
                if let status = vm.shiftStatus {
                    EMSInfoRow(label: "الحالة", value: status)
                }
                if canManage, !vm.versions.contains(where: { $0.status == "draft" }) {
                    EMSPrimaryButton(title: "إعداد سير العمل", isLoading: working) {
                        confirm = ConfirmRequest(title: "إعداد سير العمل",
                            message: "ستُنشأ مسودة بسحب لقطة المناوبة الحالية (أو تُعاد المسودة المفتوحة إن وجدت).",
                            run: { try await vm.prepare(); return "تم إعداد سير العمل" })
                    }
                }
            }
        }
    }

    private var versionsSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            if vm.versions.isEmpty {
                EMSEmptyView(icon: "doc", title: "لا توجد نسخ سير عمل لهذه المناوبة")
            } else {
                ForEach(vm.versions) { version in
                    versionCard(version)
                }
            }
        }
    }

    private func versionCard(_ version: WorkflowVersionDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("نسخة #\(version.versionNo ?? 0)")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    EMSStatusPill(text: version.statusTitle, tone: statusTone(version.status))
                }
                if let ref = version.refNo, !ref.isEmpty {
                    EMSInfoRow(label: "المرجع", value: ref)
                }
                if let by = version.createdByName { EMSInfoRow(label: "أعدّها", value: by) }
                if let by = version.approvedByName { EMSInfoRow(label: "اعتمدها", value: by) }
                if let reason = version.reissueReason, !reason.isEmpty {
                    EMSInfoRow(label: "سبب إعادة الإصدار", value: reason)
                }
                if canView {
                    Button {
                        fSummary = version.fields["summary"] ?? ""
                        fNotes = version.fields["operationalNotes"] ?? ""
                        fEvents = version.fields["keyEvents"] ?? ""
                        fIssues = version.fields["issues"] ?? ""
                        fRecommendations = version.fields["recommendations"] ?? ""
                        fReviewedBy = Set((version.fields["reviewedBy"] ?? "").split(separator: "،").map { String($0) })
                        detail = version
                    } label: {
                        Label("فتح النسخة", systemImage: "doc.text.magnifyingglass")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(EMSTheme.Colors.teal)
                    .disabled(working)
                }
            }
        }
    }

    // MARK: - تفاصيل النسخة

    private func detailSheet(_ version: WorkflowVersionDTO) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    if version.status == "draft", canManage {
                        editableFields(version)
                    } else {
                        readOnlyFields(version)
                    }
                    actionsRow(version)
                }
                .padding(EMSTheme.pagePadding)
            }
            .background(EMSBackground())
            .navigationTitle("نسخة #\(version.versionNo ?? 0) — \(version.statusTitle)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { detail = nil }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func fieldEditor(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textMuted)
            TextField(label, text: text, axis: .vertical)
                .lineLimit(2...5)
                .textFieldStyle(.plain)
                .foregroundStyle(EMSTheme.Colors.textPrimary)
                .padding(12)
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private func editableFields(_ version: WorkflowVersionDTO) -> some View {
        VStack(spacing: EMSTheme.spacing) {
            fieldEditor("الملخص", text: $fSummary)
            fieldEditor("ملاحظات تشغيلية", text: $fNotes)
            fieldEditor("أبرز الأحداث", text: $fEvents)
            fieldEditor("المشكلات", text: $fIssues)
            fieldEditor("التوصيات", text: $fRecommendations)
            VStack(alignment: .leading, spacing: 6) {
                Text("راجعها")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                ForEach(WorkflowFieldsRequest.reviewerOptions, id: \.self) { option in
                    Button {
                        if fReviewedBy.contains(option) { fReviewedBy.remove(option) }
                        else { fReviewedBy.insert(option) }
                    } label: {
                        HStack {
                            Image(systemName: fReviewedBy.contains(option) ? "checkmark.square.fill" : "square")
                                .foregroundStyle(fReviewedBy.contains(option) ? EMSTheme.Colors.teal : EMSTheme.Colors.textMuted)
                            Text(option)
                                .font(.subheadline)
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            EMSPrimaryButton(title: "حفظ الحقول", isLoading: working) {
                guard let id = version.id else { return }
                let fields = WorkflowFieldsRequest(
                    summary: fSummary, operationalNotes: fNotes, keyEvents: fEvents,
                    issues: fIssues, recommendations: fRecommendations,
                    reviewedBy: Array(fReviewedBy).sorted())
                detail = nil
                execute {
                    try await vm.updateFields(id: id, fields)
                    return "تم حفظ حقول سير العمل"
                }
            }
        }
    }

    private func readOnlyFields(_ version: WorkflowVersionDTO) -> some View {
        let fields = version.fields
        let order: [(String, String)] = [
            ("summary", "الملخص"), ("operationalNotes", "ملاحظات تشغيلية"),
            ("keyEvents", "أبرز الأحداث"), ("issues", "المشكلات"),
            ("recommendations", "التوصيات"), ("reviewedBy", "راجعها")
        ]
        return EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(order.enumerated()), id: \.offset) { _, pair in
                    if let value = fields[pair.0], !value.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pair.1)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(value)
                                .font(.subheadline)
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if fields.isEmpty {
                    Text("لا توجد حقول محفوظة في هذه النسخة")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    private func actionsRow(_ version: WorkflowVersionDTO) -> some View {
        HStack(spacing: 8) {
            if version.status == "draft", canApprove, let id = version.id {
                Button {
                    detail = nil
                    confirm = ConfirmRequest(title: "اعتماد سير العمل",
                        message: "الاعتماد يقفل النسخة ويولّد المرجع والبصمة وPDF — لا يمكن التراجع عنه.",
                        run: { try await vm.approve(id: id); return "تم اعتماد سير العمل" })
                } label: {
                    Label("اعتماد", systemImage: "checkmark.seal.fill")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(EMSTheme.Colors.emerald)
                .disabled(working)
            }
            if version.status == "approved", canManage, let id = version.id {
                Button {
                    detail = nil
                    reasonText = ""
                    reason = ReasonRequest(title: "إعادة إصدار",
                        placeholder: "سبب إعادة الإصدار (اختياري)", requiresReason: false) { text in
                        try await vm.reissue(id: id, reason: text.isEmpty ? nil : text)
                        return "تمت إعادة الإصدار — أُنشئت مسودة جديدة"
                    }
                } label: {
                    Label("إعادة إصدار", systemImage: "arrow.clockwise.doc")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(EMSTheme.Colors.warning)
                .disabled(working)
            }
            if version.status == "approved" || version.status == "sent", canView, let id = version.id {
                Button {
                    detail = nil
                    execute {
                        let file = try await vm.downloadPdf(id: id)
                        let url = FileManager.default.temporaryDirectory
                            .appendingPathComponent(file.filename ?? "workflow-\(id).pdf")
                        try file.data.write(to: url, options: .atomic)
                        await MainActor.run { shareItems = [url] }
                        return nil
                    }
                } label: {
                    Label("PDF", systemImage: "doc.richtext")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(EMSTheme.Colors.teal)
                .disabled(working)
            }
        }
    }

    private func reasonSheet(_ req: ReasonRequest) -> some View {
        NavigationStack {
            VStack(spacing: EMSTheme.spacing) {
                TextField(req.placeholder, text: $reasonText, axis: .vertical)
                    .lineLimit(2...4)
                    .textFieldStyle(.plain)
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                    .padding(12)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                EMSPrimaryButton(title: "تأكيد", isLoading: working,
                                 isDisabled: req.requiresReason && reasonText.trimmingCharacters(in: .whitespaces).isEmpty) {
                    let text = reasonText.trimmingCharacters(in: .whitespaces)
                    reason = nil
                    reasonText = ""
                    execute { try await req.run(text) }
                }
                Spacer()
            }
            .padding(EMSTheme.pagePadding)
            .background(EMSBackground())
            .navigationTitle(req.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { reason = nil; reasonText = "" }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func statusTone(_ status: String?) -> EMSTheme.StatusTone {
        switch status {
        case "approved": return .normal
        case "sent": return .action
        case "draft": return .monitor
        default: return .neutral
        }
    }

    private func execute(_ work: @escaping () async throws -> String?) {
        errorMessage = nil
        working = true
        Task {
            do { infoMessage = try await work() }
            catch let e as APIError { errorMessage = e.userMessage }
            catch { errorMessage = APIError.unknown.userMessage }
            working = false
        }
    }
}
