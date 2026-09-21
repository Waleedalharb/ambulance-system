//
//  ShiftLifecycleView.swift
//  EMSOperations
//
//  دورة المناوبة (§8): بدء (shift.lifecycle) · إنهاء بملاحظات تسليم
//  (shift.lifecycle) · اعتماد التسليم (shift.approve) · طوارئ
//  (أرشفة قسرية admin/director · حذف وتعديل admin فقط).
//  الأرشفة الرسمية والتحقق في موديول الأرشيف (§15) — لا تكرار هنا.
//  الحالة تُقرأ من /api/current-shift (المصدر السيرفري الوحيد).
//

import SwiftUI

struct ShiftLifecycleView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = ShiftLifecycleViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var showEndSheet = false
    @State private var editTarget: EmergencyShiftDTO?

    @State private var startType = ""
    @State private var handoverNotes = ""
    @State private var eType = ""
    @State private var eDate = ""

    private var canLifecycle: Bool { session.permissions.canShiftLifecycle }
    private var canApprove: Bool { session.permissions.canShiftApprove }
    private var isDirectorPlus: Bool { session.permissions.isAdminOrDirector }
    private var isAdmin: Bool { session.permissions.isAdmin }

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) { EMSSkeletonCard(lines: 3); EMSSkeletonCard(lines: 4) }
                    .padding(EMSTheme.pagePadding)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.reload(showLoading: true) } }
                    .padding(EMSTheme.pagePadding)
            case .loaded:
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .emsPage("دورة المناوبة")
        .task { await vm.load() }
        .sheet(isPresented: $showEndSheet) { endSheet }
        .sheet(item: $editTarget) { shift in editSheet(shift) }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
    }

    // MARK: - المحتوى

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                currentShiftCard
                if isDirectorPlus { emergencySection }
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

    // MARK: - المناوبة الحالية

    @ViewBuilder
    private var currentShiftCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: "المناوبة الحالية", systemImage: "clock.arrow.circlepath")
                    Spacer()
                    if let status = vm.currentShift?.shift?.status {
                        EMSStatusPill(text: statusTitle(status),
                                      tone: status == "active" ? .normal : (status == "pending_handover" ? .monitor : .neutral))
                    }
                }
                if let shift = vm.currentShift?.shift, shift.id != nil {
                    EMSInfoRow(label: "النوع", value: shift.type ?? "—")
                    EMSInfoRow(label: "التاريخ", value: shift.date ?? "—")
                    lifecycleActions(shift)
                } else {
                    Text("لا توجد مناوبة نشطة حاليًا")
                        .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
                    if let prep = vm.currentShift?.prepShift {
                        EMSInfoRow(label: "القادمة", value: [prep.type, prep.date].compactMap { $0 }.joined(separator: " · "))
                    }
                    if canLifecycle { startSection }
                }
            }
        }
    }

    @ViewBuilder
    private func lifecycleActions(_ shift: CurrentShiftDTO.Shift) -> some View {
        if canLifecycle || canApprove {
            Divider().overlay(EMSTheme.Colors.divider)
            HStack(spacing: 12) {
                if canLifecycle, shift.status == "active" {
                    Button("إنهاء المناوبة") {
                        handoverNotes = ""
                        showEndSheet = true
                    }
                    .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.warning)
                }
                if canApprove, shift.status == "pending_handover" {
                    Button("اعتماد التسليم") {
                        confirm = ConfirmRequest(title: "اعتماد التسليم",
                            message: "اعتماد تسليم المناوبة #\(shift.id ?? 0) — ستُختم وتُؤرشف نهائيًا.",
                            destructive: false) {
                            try await vm.approveHandover(shiftId: shift.id ?? 0)
                            return "تم اعتماد التسليم وأرشفة المناوبة"
                        }
                    }
                    .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.emerald)
                }
            }
        }
    }

    private var startSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().overlay(EMSTheme.Colors.divider)
            Text("بدء مناوبة جديدة")
                .font(.caption.weight(.semibold)).foregroundStyle(EMSTheme.Colors.textSecondary)
            TextField("نوع المناوبة (فارغ = افتراضي الخادم)", text: $startType)
                .textFieldStyle(.roundedBorder).font(.caption)
            EMSPrimaryButton(title: "بدء المناوبة", isLoading: working) {
                confirm = ConfirmRequest(title: "بدء مناوبة",
                    message: "بدء مناوبة جديدة الآن؟",
                    destructive: false) {
                    try await vm.startShift(type: startType.trimmingCharacters(in: .whitespaces))
                    return "بدأت المناوبة"
                }
            }
        }
    }

    private var endSheet: some View {
        NavigationStack {
            VStack(spacing: EMSTheme.spacing) {
                EMSCard {
                    VStack(alignment: .leading, spacing: 10) {
                        EMSectionHeader(title: "إنهاء المناوبة", systemImage: "flag.checkered")
                        Text("الإنهاء ينقل المناوبة إلى «بانتظار التسليم» — الاعتماد يتم بصلاحية shift.approve.")
                            .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
                        TextField("ملاحظات التسليم (اختياري)", text: $handoverNotes, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(3...5)
                        EMSPrimaryButton(title: "إنهاء", isLoading: working) {
                            execute {
                                try await vm.endShift(notes: handoverNotes.trimmingCharacters(in: .whitespaces))
                                await MainActor.run { showEndSheet = false }
                                return "أُنهيت المناوبة — بانتظار اعتماد التسليم"
                            }
                        }
                    }
                }
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                }
            }
            .padding(EMSTheme.pagePadding)
            .emsPage("إنهاء المناوبة")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { showEndSheet = false }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    // MARK: - الطوارئ (admin/director)

    private var emergencySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            EMSectionHeader(title: "طوارئ المناوبات", systemImage: "exclamationmark.triangle.fill")
            Text("إجراءات قسرية على المناوبات النشطة/المعلّقة — تُسجَّل وتُستخدم للتنظيف فقط.")
                .font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
            if vm.emergencyShifts.isEmpty {
                Text("لا توجد مناوبات نشطة أو بانتظار التسليم")
                    .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
            } else {
                ForEach(vm.emergencyShifts, id: \.stableId) { shift in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(shift.displayName)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                                Spacer()
                                EMSStatusPill(text: statusTitle(shift.status ?? ""),
                                              tone: shift.status == "active" ? .normal : .monitor)
                            }
                            EMSInfoRow(label: "التاريخ", value: shift.shiftDate ?? "—")
                            if let type = shift.shiftType { EMSInfoRow(label: "النوع", value: type) }
                            Divider().overlay(EMSTheme.Colors.divider)
                            HStack(spacing: 12) {
                                Button("أرشفة قسرية") {
                                    confirm = ConfirmRequest(title: "أرشفة قسرية",
                                        message: "أرشفة «\(shift.displayName)» قسريًا — بلا لقطة ولا تحقق (مسار طوارئ).",
                                        destructive: true) {
                                        try await vm.emergencyArchive(shiftId: shift.stableId)
                                        return "أُرشفت المناوبة قسريًا"
                                    }
                                }
                                .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.warning)
                                if isAdmin {
                                    Button("تعديل") {
                                        eType = shift.shiftType ?? ""
                                        eDate = shift.shiftDate ?? ""
                                        editTarget = shift
                                    }
                                    .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                                    Button("حذف") {
                                        confirm = ConfirmRequest(title: "حذف المناوبة",
                                            message: "حذف «\(shift.displayName)» نهائيًا من قاعدة البيانات؟ لا يمكن التراجع.",
                                            destructive: true) {
                                            try await vm.emergencyDelete(shiftId: shift.stableId)
                                            return "حُذفت المناوبة"
                                        }
                                    }
                                    .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.danger)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func editSheet(_ shift: EmergencyShiftDTO) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: "تعديل قسري — \(shift.displayName)",
                                             systemImage: "pencil.circle")
                            TextField("نوع المناوبة", text: $eType).textFieldStyle(.roundedBorder)
                            TextField("التاريخ (YYYY-MM-DD)", text: $eDate).textFieldStyle(.roundedBorder)
                                .emsNumericInput()
                            EMSPrimaryButton(title: "حفظ التعديل", isLoading: working,
                                             isDisabled: eType.trimmingCharacters(in: .whitespaces).isEmpty
                                                && eDate.trimmingCharacters(in: .whitespaces).isEmpty) {
                                execute {
                                    try await vm.emergencyEdit(shiftId: shift.stableId,
                                                               type: eType.trimmingCharacters(in: .whitespaces),
                                                               date: eDate.trimmingCharacters(in: .whitespaces))
                                    await MainActor.run { editTarget = nil }
                                    return "تم تعديل المناوبة"
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
            .emsPage("تعديل قسري")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { editTarget = nil }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private func statusTitle(_ status: String) -> String {
        switch status {
        case "active": return "نشطة"
        case "pending_handover": return "بانتظار التسليم"
        case "archived": return "مؤرشفة"
        default: return status
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
final class ShiftLifecycleViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var currentShift: CurrentShiftDTO?
    @Published private(set) var emergencyShifts: [EmergencyShiftDTO] = []

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            currentShift = try await api.get("/api/current-shift")
            // الطوارئ admin/director فقط — 403 لغيرهم لا يسقط الشاشة
            if let res: EmergencyShiftsResponseDTO = try? await api.get("/api/emergency/active-shifts") {
                emergencyShifts = res.shifts ?? []
            }
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    // MARK: - دورة الحياة (الحسم سيرفري عبر ShiftService)

    func startShift(type: String) async throws {
        let res: ShiftLifecycleResultDTO = try await api.post("/api/start-new-shift",
            body: StartShiftRequestDTO(shiftType: type.isEmpty ? nil : type))
        if res.success == false { throw APIError.server(res.error ?? "فشل في بدء المناوبة") }
        await reload()
    }

    func endShift(notes: String) async throws {
        guard let id = currentShift?.shift?.id else { throw APIError.server("لا توجد مناوبة نشطة") }
        let res: ShiftLifecycleResultDTO = try await api.post("/api/shift/\(id)/end",
            body: EndShiftRequestDTO(handoverNotes: notes.isEmpty ? nil : notes))
        if res.success == false { throw APIError.server(res.error ?? "فشل في إنهاء المناوبة") }
        await reload()
    }

    func approveHandover(shiftId: Int) async throws {
        let res: ShiftLifecycleResultDTO = try await api.post("/api/shift/\(shiftId)/handover-approve")
        if res.success == false { throw APIError.server(res.error ?? "فشل في اعتماد التسليم") }
        await reload()
    }

    // MARK: - الطوارئ

    func emergencyArchive(shiftId: Int) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/emergency/archive-shift",
                                                             body: EmergencyShiftRequestDTO(shiftId: shiftId))
        if res.success == false { throw APIError.server(res.error ?? "فشلت الأرشفة القسرية") }
        await reload()
    }

    func emergencyDelete(shiftId: Int) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/emergency/delete-shift",
                                                             body: EmergencyShiftRequestDTO(shiftId: shiftId))
        if res.success == false { throw APIError.server(res.error ?? "فشل الحذف") }
        await reload()
    }

    func emergencyEdit(shiftId: Int, type: String, date: String) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/emergency/edit-shift",
            body: EmergencyShiftRequestDTO(shiftId: shiftId,
                                           shiftType: type.isEmpty ? nil : type,
                                           shiftDate: date.isEmpty ? nil : date))
        if res.success == false { throw APIError.server(res.error ?? "فشل التعديل") }
        await reload()
    }
}
