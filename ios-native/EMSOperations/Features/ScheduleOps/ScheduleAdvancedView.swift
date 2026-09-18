//
//  ScheduleAdvancedView.swift
//  EMSOperations
//
//  العمليات المتقدمة للجداول (docs/native-schedule-parity.md) — كل قسم
//  يظهر بصلاحيته فقط: تصدير PDF/JSON · مسودات وتراجع/إعادة · توليد ذكي
//  (admin/director) · مسح بالمدى/كامل بتأكيد مزدوج. كل كتابة تعيد تحميل
//  الشهر، وأخطاء الخادم تُعرض بلفظها.
//

import SwiftUI
import UIKit

/// مشاركة ملفات عبر ورقة النظام (PDF/JSON المصدَّرة).
struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

struct ScheduleAdvancedView: View {
    @EnvironmentObject private var vm: ScheduleOpsViewModel
    @EnvironmentObject private var session: SessionStore

    // تصدير PDF
    @State private var pdfMode: PdfMode = .center
    @State private var pdfCenter = ""
    @State private var pdfGroup = "A"
    // مشاركة
    @State private var shareItems: [Any]?
    // نتائج/أخطاء عامة
    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    // JSON
    @State private var jsonRows = 0
    @State private var jsonFileURL: URL?
    // مسودات
    @State private var drafts: [RosterDraftsDTO.Draft] = []
    @State private var draftsLoaded = false
    @State private var draftToApply: (title: String, changes: [RosterBulkUpdateRequest.Change])?
    @State private var draftRawContent: String?
    // توليد
    @State private var genMode = "normal"
    @State private var showGenerateConfirm = false
    @State private var genResult: ScheduleGenerateResponseDTO?
    // مسح
    @State private var clearFrom = Date()
    @State private var clearTo = Date()
    @State private var clearStep: ClearStep?
    @State private var clearMessage: String?

    enum PdfMode: String, CaseIterable, Identifiable {
        case center, group
        var id: String { rawValue }
        var title: String { self == .center ? "مركز" : "فئة (A-D)" }
    }

    enum ClearStep: Identifiable {
        case rangeFirst, rangeFinal, allFirst, allFinal
        var id: Int {
            switch self {
            case .rangeFirst: return 1
            case .rangeFinal: return 2
            case .allFirst: return 3
            case .allFinal: return 4
            }
        }
    }

    private var perms: PermissionStore { session.permissions }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if perms.canExportSchedule { exportPdfSection }
                if perms.canExportSchedule { exportJsonSection }
                if perms.canBulkUpdateSchedule { draftsSection }
                if perms.canGenerateSchedule { generateSection }
                if perms.canClearSchedule { clearSection }
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
        .emsPage("عمليات متقدمة")
        .sheet(isPresented: shareBinding) {
            if let items = shareItems {
                ActivityShareSheet(items: items)
            }
        }
        .alert("إعادة تطبيق مسودة", isPresented: draftApplyBinding) {
            Button("تطبيق \(draftToApply?.changes.count ?? 0) تغييرًا") {
                if let changes = draftToApply?.changes { applyDraft(changes) }
            }
            Button("إلغاء", role: .cancel) {}
        } message: {
            Text(draftToApply?.title ?? "")
        }
    }

    private var shareBinding: Binding<Bool> {
        Binding(get: { shareItems != nil }, set: { if !$0 { shareItems = nil } })
    }

    private var draftApplyBinding: Binding<Bool> {
        Binding(get: { draftToApply != nil }, set: { if !$0 { draftToApply = nil } })
    }

    // MARK: - تصدير PDF (مركز أو فئة — GET /api/schedule/pdf)

    private var exportPdfSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "تصدير PDF — \(vm.selectedMonthLabel)", systemImage: "doc.richtext")
                Picker("النوع", selection: $pdfMode) {
                    ForEach(PdfMode.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                if pdfMode == .center {
                    if vm.centers.isEmpty {
                        Text("لا توجد مراكز مسجلة في سجل الفرق.")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    } else {
                        Menu {
                            ForEach(vm.centers, id: \.self) { c in
                                Button(c) { pdfCenter = c }
                            }
                        } label: {
                            selectorLabel(pdfCenter.isEmpty ? "اختر مركزًا" : pdfCenter, icon: "building.2")
                        }
                    }
                } else {
                    Picker("الفئة", selection: $pdfGroup) {
                        ForEach(["A", "B", "C", "D"], id: \.self) { Text("فئة \($0)").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                EMSPrimaryButton(title: "توليد ومشاركة PDF", isLoading: working,
                                 isDisabled: pdfMode == .center && pdfCenter.isEmpty) {
                    runPdfExport()
                }
                Text("404 من الخادم تعني: لا بيانات جدول لهذا المركز/الفئة في هذا الشهر.")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .onAppear {
            if pdfCenter.isEmpty { pdfCenter = vm.centers.first ?? "" }
        }
    }

    private func runPdfExport() {
        errorMessage = nil
        infoMessage = nil
        working = true
        Task {
            do {
                let file = try await vm.downloadPdf(center: pdfMode == .center ? pdfCenter : nil,
                                                    group: pdfMode == .group ? pdfGroup : nil)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent(file.filename ?? "schedule-\(vm.selectedMonth).pdf")
                try file.data.write(to: url, options: .atomic)
                shareItems = [url]
                infoMessage = "تم توليد PDF (\(file.data.count / 1024) كيلوبايت)."
            } catch let e as APIError {
                errorMessage = e.userMessage
            } catch {
                errorMessage = APIError.unknown.userMessage
            }
            working = false
        }
    }

    // MARK: - تصدير JSON (POST /api/shift-roster/export — البيانات سطريًا)

    private var exportJsonSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "تصدير JSON — \(vm.selectedMonthLabel)", systemImage: "curlybraces")
                EMSPrimaryButton(title: "جلب البيانات", isLoading: working) {
                    runJsonExport()
                }
                if jsonRows > 0 {
                    EMSInfoRow(label: "عدد الصفوف", value: String(jsonRows))
                    if jsonFileURL != nil {
                        Button {
                            if let url = jsonFileURL { shareItems = [url] }
                        } label: {
                            HStack {
                                Image(systemName: "square.and.arrow.up")
                                Text("مشاركة ملف JSON")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .foregroundStyle(EMSTheme.Colors.teal)
                        }
                    }
                }
            }
        }
    }

    private func runJsonExport() {
        errorMessage = nil
        infoMessage = nil
        working = true
        Task {
            do {
                let res = try await vm.exportJson()
                let rows = res.data ?? []
                jsonRows = rows.count
                let payload = try JSONEncoder().encode(rows)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("shift-roster-\(vm.selectedMonth).json")
                try payload.write(to: url, options: .atomic)
                jsonFileURL = url
                infoMessage = "تم جلب \(rows.count) سجلًا من الخادم."
            } catch let e as APIError {
                errorMessage = e.userMessage
            } catch {
                errorMessage = APIError.unknown.userMessage
            }
            working = false
        }
    }

    // MARK: - المسودات والتراجع/الإعادة (schedule.bulk_update)

    private var draftsSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "المسودات والتراجع", systemImage: "doc.on.doc")
                HStack(spacing: 8) {
                    Button {
                        runDraftAction(undo: true)
                    } label: {
                        Label("تراجع", systemImage: "arrow.uturn.backward")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.warning)
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .background(EMSTheme.Colors.warning.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    Button {
                        runDraftAction(undo: false)
                    } label: {
                        Label("إعادة", systemImage: "arrow.uturn.forward")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.teal)
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .background(EMSTheme.Colors.teal.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
                .disabled(working)
                if draftsLoaded {
                    if drafts.isEmpty {
                        Text("لا مسودات محفوظة لحسابك.")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    } else {
                        ForEach(drafts.prefix(10)) { d in
                            HStack {
                                EMSStatusPill(text: d.operationType ?? "—",
                                              tone: d.isPending ? .monitor : .neutral)
                                Spacer()
                                Text(d.createdAt ?? "—")
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                    }
                }
                if let draftRawContent {
                    Text("محتوى المسودة (تعذّر تطبيقه تلقائيًا — راجعه على منصة الويب):")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.warning)
                    Text(draftRawContent)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .lineLimit(6)
                }
            }
        }
        .task {
            drafts = (try? await vm.loadDrafts()) ?? []
            draftsLoaded = true
        }
    }

    /// undo/redo سيرفيان يعيدان المسودة للعميل — إعادة التطبيق عبر bulk-update
    /// بعد تأكيد يعرض عدد التغييرات؛ تعذّر الفكّ → عرض المحتوى نصيًا بلا تطبيق.
    private func runDraftAction(undo: Bool) {
        errorMessage = nil
        infoMessage = nil
        draftRawContent = nil
        working = true
        Task {
            do {
                let res = undo ? try await vm.undoDraft() : try await vm.redoDraft()
                working = false
                infoMessage = res.message
                if let changes = ScheduleOpsViewModel.decodeDraftChanges(res.draft?.draftDataJson) {
                    draftToApply = ("المسودة \(res.draft?.id.map(String.init) ?? "؟") — نوع العملية: \(res.draft?.operationType ?? "—")", changes)
                } else if let raw = res.draft?.draftDataJson, !raw.isEmpty {
                    draftRawContent = raw
                }
                drafts = (try? await vm.loadDrafts()) ?? drafts
            } catch let e as APIError {
                working = false
                errorMessage = e.userMessage
            } catch {
                working = false
                errorMessage = APIError.unknown.userMessage
            }
        }
    }

    private func applyDraft(_ changes: [RosterBulkUpdateRequest.Change]) {
        errorMessage = nil
        working = true
        Task {
            do {
                let res = try await vm.applyBulk(changes: changes)
                infoMessage = "تم تطبيق \(res.updated ?? changes.count) تغييرًا."
                if let conflicts = res.conflicts, !conflicts.isEmpty {
                    errorMessage = "تعارضات: \(conflicts.compactMap { $0.message }.joined(separator: " · "))"
                }
            } catch let e as APIError {
                errorMessage = e.userMessage
            } catch {
                errorMessage = APIError.unknown.userMessage
            }
            working = false
        }
    }

    // MARK: - التوليد الذكي (admin/director — POST /api/shift-schedule/generate)

    private var generateSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "التوليد الذكي — \(vm.selectedMonthLabel)", systemImage: "wand.and.stars")
                Picker("الوضع", selection: $genMode) {
                    Text("عادي").tag("normal")
                    Text("بديل").tag("alternative")
                }
                .pickerStyle(.segmented)
                EMSPrimaryButton(title: "توليد الجدول", isLoading: working) {
                    showGenerateConfirm = true
                }
                Text("يحذف الجدول المولّد السابق لهذا الشهر ويعيد بناءه — لا يمس الإدخالات اليدوية الأخرى.")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                if let genResult {
                    EMSInfoRow(label: "سجلات مولّدة", value: genResult.schedule?.count.map(String.init) ?? "—")
                    if let alerts = genResult.alerts, !alerts.isEmpty {
                        Text("تنبيهات التوليد:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.warning)
                        ForEach(alerts.prefix(10)) { a in
                            Text("• \(a.alertDate ?? "—"): \(a.message ?? a.alertType ?? "—")")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                        }
                    }
                }
            }
        }
        .alert("تأكيد التوليد", isPresented: $showGenerateConfirm) {
            Button("توليد", role: .destructive) {
                errorMessage = nil
                working = true
                Task {
                    do {
                        genResult = try await vm.generate(mode: genMode)
                        infoMessage = "اكتمل التوليد بنجاح."
                    } catch let e as APIError {
                        errorMessage = e.userMessage
                    } catch {
                        errorMessage = APIError.unknown.userMessage
                    }
                    working = false
                }
            }
            Button("إلغاء", role: .cancel) {}
        } message: {
            Text("سيُحذف الجدول المولّد الحالي لـ\(vm.selectedMonthLabel) ويُعاد بناؤه بوضع «\(genMode == "normal" ? "عادي" : "بديل")». متابعة؟")
        }
    }

    // MARK: - المسح (schedule.clear — تأكيد مزدوج إلزامي)

    private var clearSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "مسح بيانات الجدول", systemImage: "trash")
                DatePicker("من", selection: $clearFrom, displayedComponents: .date)
                    .tint(EMSTheme.Colors.teal)
                DatePicker("إلى", selection: $clearTo, displayedComponents: .date)
                    .tint(EMSTheme.Colors.teal)
                Button(role: .destructive) {
                    clearStep = .rangeFirst
                } label: {
                    Text("مسح المدى المحدد")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.danger)
                        .frame(maxWidth: .infinity)
                        .frame(height: 42)
                        .background(EMSTheme.Colors.danger.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(clearFrom > clearTo || working)
                Button(role: .destructive) {
                    clearStep = .allFirst
                } label: {
                    Text("مسح الجدول كاملًا")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 42)
                        .background(EMSTheme.Colors.danger)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(working)
                if let clearMessage {
                    Text(clearMessage)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.warning)
                }
            }
        }
        .confirmationDialog("تأكيد أول", isPresented: clearDialogBinding, presenting: clearStep) { step in
            switch step {
            case .rangeFirst:
                Button("متابعة نحو التأكيد النهائي", role: .destructive) { clearStep = .rangeFinal }
            case .rangeFinal:
                Button("مسح المدى نهائيًا", role: .destructive) { runClear(range: true) }
            case .allFirst:
                Button("متابعة نحو التأكيد النهائي", role: .destructive) { clearStep = .allFinal }
            case .allFinal:
                Button("مسح كل الجدول نهائيًا", role: .destructive) { runClear(range: false) }
            }
            Button("إلغاء", role: .cancel) {}
        } message: { step in
            switch step {
            case .rangeFirst:
                Text("مسح سجلات \(ScheduleDateKit.string(clearFrom)) ← \(ScheduleDateKit.string(clearTo))؟ يُوثَّق كل حذف في سجل التدقيق.")
            case .rangeFinal:
                Text("تأكيد نهائي: لا رجوع تلقائي عن المسح. متابعة؟")
            case .allFirst:
                Text("مسح كل سجلات جدول المناوبات من القاعدة؟ إجراء شديد الحساسية.")
            case .allFinal:
                Text("تأكيد نهائي: سيُمسح الجدول بالكامل. متابعة؟")
            }
        }
    }

    private var clearDialogBinding: Binding<Bool> {
        Binding(get: { clearStep != nil }, set: { if !$0 { clearStep = nil } })
    }

    private func runClear(range: Bool) {
        clearStep = nil
        errorMessage = nil
        infoMessage = nil
        clearMessage = nil
        working = true
        Task {
            do {
                if range {
                    let res = try await vm.clearRange(start: ScheduleDateKit.string(clearFrom),
                                                      end: ScheduleDateKit.string(clearTo))
                    clearMessage = res.message ?? "تم مسح المدى."
                } else {
                    let res = try await vm.clearAll()
                    clearMessage = res.message ?? "تم مسح الجدول كاملًا."
                }
            } catch let e as APIError {
                errorMessage = e.userMessage
            } catch {
                errorMessage = APIError.unknown.userMessage
            }
            working = false
        }
    }

    private func selectorLabel(_ text: String, icon: String) -> some View {
        HStack {
            Image(systemName: icon)
                .foregroundStyle(EMSTheme.Colors.teal)
            Text(text)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textPrimary)
            Spacer()
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
        .padding(10)
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
