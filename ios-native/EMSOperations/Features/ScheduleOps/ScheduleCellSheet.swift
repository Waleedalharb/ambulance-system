//
//  ScheduleCellSheet.swift
//  EMSOperations
//
//  تدفق تحرير الخلية (docs/native-schedule-parity.md):
//  خلية ← تفاصيل ← إجراء حسب الصلاحية ← (تحقق مسبق للإضافة) ← تأكيد
//  ← إرسال ← إعادة تحميل الشهر. من لا يملك المفتاح لا يرى الإجراء؛
//  أخطاء الخادم تُعرض بلفظها؛ لا كتابة بلا اتصال (APIError.offline).
//

import SwiftUI

struct ScheduleCellSheet: View {
    let context: ScheduleCellContext

    @EnvironmentObject private var vm: ScheduleOpsViewModel
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss

    @State private var working = false
    @State private var errorMessage: String?
    @State private var pickedCode = ""
    @State private var showEditConfirm = false
    @State private var showDeleteConfirm = false
    @State private var swapCandidate: RosterMonthDTO.Entry?
    @State private var showSwapConfirm = false
    @State private var conflicts: [RosterValidateResponseDTO.Conflict] = []

    /// مسار الإضافة المعلّق بانتظار تأكيد المستخدم.
    private enum PendingAdd: Identifiable {
        case record(employeeId: Int, date: String, teamId: Int?)
        case cellAssign(employeeCode: String, date: String)
        var id: String {
            switch self {
            case .record(let id, let d, _): return "r-\(id)-\(d)"
            case .cellAssign(let c, let d): return "c-\(c)-\(d)"
            }
        }
    }
    @State private var pendingAdd: PendingAdd?

    private var perms: PermissionStore { session.permissions }

    // MARK: - معطيات السياق

    private var existingEntry: RosterMonthDTO.Entry? {
        if case .existing(let e) = context { return e }
        return nil
    }

    private var emptySlot: (row: ScheduleRosterRow, date: String)? {
        if case .empty(let r, let d) = context { return (r, d) }
        return nil
    }

    private var title: String { existingEntry != nil ? "تفاصيل المناوبة" : "إضافة مناوبة" }

    /// إجراءات متاحة؟ وإلا «عرض فقط».
    private var hasAnyAction: Bool {
        if let e = existingEntry {
            return (perms.canEditScheduleCell && e.employeeCode != nil)
                || (perms.canSwapSchedule && e.id != nil)
                || (perms.canManageScheduleEmployees && e.id != nil)
        }
        return perms.canManageScheduleEmployees || perms.canEditScheduleCell
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    infoCard
                    if !hasAnyAction {
                        readOnlyNote
                    } else if let entry = existingEntry {
                        existingActions(entry)
                    } else if let slot = emptySlot {
                        addActions(slot)
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
            .background(EMSBackground())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { dismiss() }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { seedPickedCode() }
    }

    // MARK: - بطاقة المعلومات

    private var infoCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                if let e = existingEntry {
                    EMSInfoRow(label: "الموظف", value: e.employeeName ?? "—")
                    EMSInfoRow(label: "الرقم الوظيفي", value: e.employeeCode ?? "—")
                    EMSInfoRow(label: "التاريخ", value: e.shiftDate ?? "—")
                    EMSInfoRow(label: "الفريق", value: e.teamName ?? "بدون فريق")
                    EMSInfoRow(label: "الرمز الحالي", value: vm.codeLabel(e.shiftCode))
                } else if let slot = emptySlot {
                    EMSInfoRow(label: "الموظف", value: slot.row.employeeName)
                    EMSInfoRow(label: "الرقم الوظيفي", value: slot.row.employeeCode ?? "—")
                    EMSInfoRow(label: "التاريخ", value: slot.date)
                    EMSInfoRow(label: "الفريق", value: slot.row.teamName)
                }
            }
        }
    }

    private var readOnlyNote: some View {
        EMSCard {
            HStack(spacing: 8) {
                Image(systemName: "eye")
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                Text("عرض فقط — لا تملك إجراءات على هذا السجل.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
    }

    // MARK: - إجراءات السجل القائم

    @ViewBuilder
    private func existingActions(_ entry: RosterMonthDTO.Entry) -> some View {
        if perms.canEditScheduleCell, let code = entry.employeeCode, !code.isEmpty {
            editSection(entry: entry, employeeCode: code)
        }
        if perms.canSwapSchedule, entry.id != nil {
            swapSection(entry: entry)
        }
        if perms.canManageScheduleEmployees, entry.id != nil {
            deleteSection(entry: entry)
        }
    }

    /// تعديل الرمز — PUT /cell (تحقق الرمز سيرفري من shift_codes).
    private func editSection(entry: RosterMonthDTO.Entry, employeeCode: String) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "تعديل الرمز", systemImage: "pencil")
                codePicker
                EMSPrimaryButton(title: "حفظ التعديل", isLoading: working,
                                 isDisabled: pickedCode.isEmpty || pickedCode == entry.shiftCode) {
                    showEditConfirm = true
                }
            }
        }
        .alert("تأكيد التعديل", isPresented: $showEditConfirm) {
            Button("تأكيد") {
                runWrite {
                    try await vm.editCell(employeeCode: employeeCode,
                                          date: entry.shiftDate ?? "",
                                          shiftCode: pickedCode)
                }
            }
            Button("إلغاء", role: .cancel) {}
        } message: {
            Text("تغيير مناوبة \(entry.employeeName ?? "—") يوم \(entry.shiftDate ?? "—") من «\(entry.shiftCode ?? "—")» إلى «\(pickedCode)»؟")
        }
    }

    /// تبديل موظفَي سجلين — ملخص قبل/بعد ثم POST /swap.
    private func swapSection(entry: RosterMonthDTO.Entry) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "تبديل مع سجل آخر", systemImage: "arrow.left.arrow.right")
                if let candidate = swapCandidate {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("سيُتبادل الموظفان بين السجلين:")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        EMSInfoRow(label: "سجلك (\(entry.shiftDate ?? "—") · \(entry.shiftCode ?? "—"))",
                                   value: "\(entry.employeeName ?? "—") ← \(candidate.employeeName ?? "—")")
                        EMSInfoRow(label: "السجل الآخر (\(candidate.shiftDate ?? "—") · \(candidate.shiftCode ?? "—"))",
                                   value: "\(candidate.employeeName ?? "—") ← \(entry.employeeName ?? "—")")
                    }
                    HStack(spacing: 8) {
                        EMSPrimaryButton(title: "تأكيد التبديل", isLoading: working) {
                            showSwapConfirm = true
                        }
                        Button("سجل آخر") { swapCandidate = nil }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                } else {
                    Text("اختر السجل الآخر من جدول \(vm.selectedMonthLabel):")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(vm.roster.filter { $0.id != entry.id && $0.id != nil }) { other in
                                Button {
                                    swapCandidate = other
                                } label: {
                                    HStack {
                                        Text(other.employeeName ?? "—")
                                            .font(.caption.weight(.medium))
                                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                                        Spacer()
                                        Text("\(other.shiftDate ?? "—") · \(other.shiftCode ?? "—")")
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(EMSTheme.Colors.textMuted)
                                    }
                                    .padding(8)
                                    .background(Color.white.opacity(0.05))
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .frame(maxHeight: 180)
                }
            }
        }
        .alert("تأكيد التبديل", isPresented: $showSwapConfirm) {
            Button("تبديل") {
                guard let a = entry.id, let b = swapCandidate?.id else { return }
                runWrite { try await vm.swap(id1: a, id2: b) }
            }
            Button("إلغاء", role: .cancel) {}
        } message: {
            Text("تبديل الموظفين بين السجلين المحددين؟ يُوثَّق الإجراء في سجل التدقيق.")
        }
    }

    /// حذف السجل — confirmationDialog إلزامي.
    private func deleteSection(entry: RosterMonthDTO.Entry) -> some View {
        Button(role: .destructive) {
            showDeleteConfirm = true
        } label: {
            HStack {
                Image(systemName: "trash")
                Text("حذف السجل")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(EMSTheme.Colors.danger)
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(EMSTheme.Colors.danger.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .confirmationDialog("حذف سجل \(entry.employeeName ?? "—") يوم \(entry.shiftDate ?? "—")؟",
                            isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("حذف نهائي", role: .destructive) {
                guard let id = entry.id else { return }
                runWrite { try await vm.deleteEntry(id: id) }
            }
            Button("إلغاء", role: .cancel) {}
        } message: {
            Text("يُحذف السجل من القاعدة ويُوثَّق في سجل التدقيق.")
        }
    }

    // MARK: - إضافة سجل في خانة فارغة

    @ViewBuilder
    private func addActions(_ slot: (row: ScheduleRosterRow, date: String)) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "تعيين الرمز", systemImage: "plus.square")
                codePicker
                if !conflicts.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(conflicts) { c in
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.warning)
                                Text(c.message ?? "تعارض غير معروف")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.warning)
                            }
                        }
                    }
                }
                if perms.canManageScheduleEmployees, let empId = slot.row.employeeId {
                    EMSPrimaryButton(title: "تحقق ثم إضافة", isLoading: working,
                                     isDisabled: pickedCode.isEmpty) {
                        validateThenConfirm(employeeId: empId, date: slot.date, teamId: slot.row.teamId)
                    }
                } else if perms.canEditScheduleCell, let code = slot.row.employeeCode, !code.isEmpty {
                    // PUT /cell يُنشئ السطر إن لم يوجد (upsert سيرفري بفرقة التعيين النشط).
                    EMSPrimaryButton(title: "تعيين الرمز", isLoading: working,
                                     isDisabled: pickedCode.isEmpty) {
                        pendingAdd = .cellAssign(employeeCode: code, date: slot.date)
                    }
                } else {
                    Text("لا يمكن إتمام الإضافة: ينقص الرقم الوظيفي أو صلاحية الإدارة.")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
        .alert("تأكيد الإضافة", isPresented: addConfirmBinding, presenting: pendingAdd) { pending in
            Button("إضافة") {
                switch pending {
                case .record(let empId, let date, let teamId):
                    runWrite {
                        try await vm.addEntry(employeeId: empId, date: date,
                                              shiftCode: pickedCode, teamId: teamId)
                    }
                case .cellAssign(let code, let date):
                    runWrite {
                        try await vm.editCell(employeeCode: code, date: date, shiftCode: pickedCode)
                    }
                }
            }
            Button("إلغاء", role: .cancel) {}
        } message: { pending in
            switch pending {
            case .record(_, let date, _):
                Text("إضافة سجل جديد برمز «\(pickedCode)» يوم \(date)؟")
            case .cellAssign(_, let date):
                Text("تعيين رمز «\(pickedCode)» لهذا الموظف يوم \(date)؟")
            }
        }
    }

    private var addConfirmBinding: Binding<Bool> {
        Binding(get: { pendingAdd != nil }, set: { if !$0 { pendingAdd = nil } })
    }

    /// validate قبل الإضافة فقط — duplicate يطلق على أي سجل موجود سيرفريًا.
    private func validateThenConfirm(employeeId: Int, date: String, teamId: Int?) {
        errorMessage = nil
        conflicts = []
        working = true
        Task {
            do {
                let res = try await vm.validateAdd(employeeId: employeeId, date: date,
                                                   shiftCode: pickedCode, teamId: teamId)
                working = false
                if res.valid == true {
                    pendingAdd = .record(employeeId: employeeId, date: date, teamId: teamId)
                } else {
                    conflicts = res.conflicts ?? []
                    if conflicts.isEmpty { errorMessage = "رفض الخادم التحقق دون سبب معلن." }
                }
            } catch let e as APIError {
                working = false
                errorMessage = e.userMessage
            } catch {
                working = false
                errorMessage = APIError.unknown.userMessage
            }
        }
    }

    // MARK: - مشترك

    private var codePicker: some View {
        Picker("رمز المناوبة", selection: $pickedCode) {
            ForEach(vm.codes) { c in
                Text(c.displayLabel).tag(c.code ?? "")
            }
        }
        .pickerStyle(.menu)
        .tint(EMSTheme.Colors.teal)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func seedPickedCode() {
        if let e = existingEntry {
            pickedCode = e.shiftCode ?? vm.codes.first?.code ?? ""
        } else {
            pickedCode = vm.codes.first?.code ?? ""
        }
    }

    /// كاتب موحد: نجاح → إغلاق (المخزن أعاد تحميل الشهر) · فشل → لفظ الخادم.
    private func runWrite(_ work: @escaping () async throws -> Void) {
        errorMessage = nil
        working = true
        Task {
            do {
                try await work()
                working = false
                dismiss()
            } catch let e as APIError {
                working = false
                errorMessage = e.userMessage
            } catch {
                working = false
                errorMessage = APIError.unknown.userMessage
            }
        }
    }
}
