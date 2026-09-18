//
//  ArchiveOpsView.swift
//  EMSOperations
//
//  الأرشيف (§15): قائمة المناوبات المؤرشفة بفلاتر سيرفرية + التحقق من
//  سلامة الأرشيف (خمسة فحوصات سيرفرية) + سجل الأرشفة + إجراءات مقيدة:
//  أرشفة/إعادة أرشفة (admin) واستعادة (admin/director).
//  القراءة متاحة لكل مستخدم مصادَق (المسارات authenticate فقط) —
//  الشاشة داخل غرفة العمليات. من لا يملك الدور لا يرى زر الإجراء.
//

import SwiftUI

struct ArchiveOpsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = ArchiveOpsViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var logShiftId: Int?
    @State private var expandedVerifyId: Int?

    private var isAdmin: Bool { session.permissions.isAdmin }
    private var canRestore: Bool { session.permissions.isAdminOrDirector }

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
        .emsPage("الأرشيف")
        .task { await vm.load() }
        .sheet(isPresented: Binding(get: { logShiftId != nil }, set: { if !$0 { logShiftId = nil } })) {
            if let id = logShiftId { logSheet(shiftId: id) }
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

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                filtersCard
                if vm.shifts.isEmpty {
                    EMSEmptyView(icon: "archivebox", title: "لا توجد مناوبات",
                                 detail: "لا توجد مناوبات مطابقة للفلاتر الحالية.")
                } else {
                    summaryCard
                    ForEach(vm.shifts) { shift in shiftCard(shift) }
                    paginationCard
                }
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

    // MARK: - الفلاتر

    private var filtersCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSSectionHeader(title: "تصفية الأرشيف", systemImage: "line.3.horizontal.decrease.circle")
                HStack(spacing: 8) {
                    TextField("من تاريخ (YYYY-MM-DD)", text: $vm.dateFrom)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                    TextField("إلى تاريخ", text: $vm.dateTo)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                }
                HStack(spacing: 8) {
                    TextField("نوع المناوبة (اختياري)", text: $vm.shiftType)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                    Picker("الحالة", selection: $vm.status) {
                        Text("كل الحالات").tag("")
                        Text("نشطة").tag("active")
                        Text("مؤرشفة").tag("archived")
                        Text("بانتظار التسليم").tag("pending_handover")
                    }
                    .pickerStyle(.menu)
                    .font(.caption)
                }
                EMSPrimaryButton(title: "تطبيق الفلاتر") {
                    Task { await vm.applyFilters() }
                }
            }
        }
    }

    private var summaryCard: some View {
        EMSCard {
            HStack {
                Image(systemName: "archivebox.fill")
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text("الإجمالي: \(vm.total) مناوبة")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                if working { ProgressView().tint(EMSTheme.Colors.teal) }
            }
        }
    }

    // MARK: - بطاقة المناوبة

    @ViewBuilder
    private func shiftCard(_ shift: ArchiveShiftDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(shift.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    EMSStatusPill(text: shift.statusTitle,
                                  tone: shift.isArchived ? .neutral : .normal)
                }
                EMSInfoRow(label: "التاريخ", value: [shift.shiftDate, shift.shiftDay].compactMap { $0 }.joined(separator: " · "))
                if let type = shift.shiftType, !type.isEmpty {
                    EMSInfoRow(label: "النوع", value: type)
                }
                EMSInfoRow(label: "البلاغات", value: "\(shift.totalReports ?? 0)")
                if let archivedAt = shift.archivedAt, !archivedAt.isEmpty {
                    EMSInfoRow(label: "تاريخ الأرشفة", value: archivedAt)
                }
                if let notes = shift.generalNotes, !notes.isEmpty {
                    EMSInfoRow(label: "ملاحظات", value: notes)
                }

                Divider().overlay(EMSTheme.Colors.divider)

                // قراءة: تحقق + سجل — متاحة لكل مستخدم مصادَق
                HStack(spacing: 10) {
                    Button {
                        if expandedVerifyId == shift.id {
                            expandedVerifyId = nil
                        } else {
                            expandedVerifyId = shift.id
                            if vm.verifications[shift.id] == nil {
                                Task {
                                    do { try await vm.verify(shiftId: shift.id) }
                                    catch let e as APIError { errorMessage = e.userMessage }
                                    catch { errorMessage = APIError.unknown.userMessage }
                                }
                            }
                        }
                    } label: {
                        Label("التحقق من السلامة", systemImage: "checkmark.shield")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(EMSTheme.Colors.teal)
                    .disabled(vm.verifyingIds.contains(shift.id))

                    Button {
                        logShiftId = shift.id
                        Task {
                            do { try await vm.loadLogs(shiftId: shift.id) }
                            catch let e as APIError { errorMessage = e.userMessage }
                            catch { errorMessage = APIError.unknown.userMessage }
                        }
                    } label: {
                        Label("سجل الأرشفة", systemImage: "list.bullet.rectangle")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(EMSTheme.Colors.teal)
                }

                if expandedVerifyId == shift.id {
                    verifySection(shift.id)
                }

                // كتابة: مقيدة بالدور — من لا يملك الدور لا يرى الزر
                if isAdmin || (canRestore && shift.isArchived) {
                    Divider().overlay(EMSTheme.Colors.divider)
                    HStack(spacing: 10) {
                        if isAdmin, !shift.isArchived {
                            Button("أرشفة") {
                                confirm = ConfirmRequest(title: "أرشفة المناوبة",
                                    message: "ستُؤرشف «\(shift.displayName)» وتُختم. لا يمكن التراجع من التطبيق.",
                                    destructive: true) {
                                    try await vm.archive(shiftId: shift.id, reason: nil)
                                    return "تمت أرشفة المناوبة"
                                }
                            }
                            .buttonStyle(.bordered)
                            .tint(EMSTheme.Colors.danger)
                            .font(.caption)
                        }
                        if isAdmin, shift.isArchived {
                            Button("إعادة الأرشفة") {
                                confirm = ConfirmRequest(title: "إعادة الأرشفة",
                                    message: "ستُعاد أرشفة «\(shift.displayName)» بوضع strict مع تحقق كامل.",
                                    destructive: false) {
                                    try await vm.rearchive(shiftId: shift.id)
                                    return "تمت إعادة الأرشفة بنجاح"
                                }
                            }
                            .buttonStyle(.bordered)
                            .tint(EMSTheme.Colors.teal)
                            .font(.caption)
                        }
                        if canRestore, shift.isArchived {
                            Button("استعادة") {
                                confirm = ConfirmRequest(title: "استعادة المناوبة",
                                    message: "الاستعادة تبدأ مناوبة جديدة وتُبقي «\(shift.displayName)» مؤرشفة (سلوك الخادم).",
                                    destructive: false) {
                                    try await vm.restore(shiftId: shift.id)
                                    return "بدأت مناوبة جديدة (القديمة تبقى مؤرشفة)"
                                }
                            }
                            .buttonStyle(.bordered)
                            .tint(EMSTheme.Colors.emerald)
                            .font(.caption)
                        }
                    }
                }
            }
        }
    }

    // MARK: - فحوصات السلامة

    @ViewBuilder
    private func verifySection(_ shiftId: Int) -> some View {
        if vm.verifyingIds.contains(shiftId) {
            HStack(spacing: 8) {
                ProgressView().tint(EMSTheme.Colors.teal)
                Text("جارٍ التحقق…")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        } else if let res = vm.verifications[shiftId] {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: (res.passed ?? false) ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle((res.passed ?? false) ? EMSTheme.Colors.emerald : EMSTheme.Colors.danger)
                    Text((res.passed ?? false) ? "الأرشيف سليم" : "الأرشيف غير سليم")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                }
                // الفحوصات الخمسة السيرفرية — المفاتيح من ShiftIntegrityChecker
                ForEach(Self.checkOrder, id: \.self) { key in
                    if let check = res.checks?[key] {
                        checkRow(title: Self.checkTitles[key] ?? key, check: check)
                    }
                }
            }
            .padding(8)
            .background(EMSTheme.Colors.navySoft)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func checkRow(title: String, check: ArchiveCheckDTO) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: (check.passed ?? false) ? "checkmark.circle" : "xmark.circle")
                    .font(.caption2)
                    .foregroundStyle((check.passed ?? false) ? EMSTheme.Colors.emerald : EMSTheme.Colors.danger)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
            }
            if let issues = check.issues, !issues.isEmpty {
                ForEach(issues, id: \.self) { issue in
                    Text(issue)
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.danger)
                }
            }
            if let error = check.error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.danger)
            }
        }
    }

    private static let checkOrder = ["hashMatch", "dataLinkage", "fileIntegrity", "dataCompleteness", "noDuplicates"]
    private static let checkTitles: [String: String] = [
        "hashMatch": "تطابق البصمة (Hash)",
        "dataLinkage": "ارتباط البيانات",
        "fileIntegrity": "سلامة الملفات",
        "dataCompleteness": "اكتمال البيانات",
        "noDuplicates": "عدم التكرار"
    ]

    // MARK: - سجل الأرشفة

    private func logSheet(shiftId: Int) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    if vm.loadingLogIds.contains(shiftId) {
                        EMSSkeletonCard(lines: 4)
                    } else if let entries = vm.logs[shiftId], !entries.isEmpty {
                        ForEach(entries, id: \.stableId) { entry in
                            EMSCard {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(entry.operationTitle)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                                        Spacer()
                                        if let ts = entry.timestamp {
                                            Text(ts)
                                                .font(.caption2)
                                                .foregroundStyle(EMSTheme.Colors.textMuted)
                                        }
                                    }
                                    if let summary = entry.details?.summary {
                                        Text(summary)
                                            .font(.caption)
                                            .foregroundStyle(EMSTheme.Colors.textMuted)
                                    }
                                    if let name = entry.user?.name {
                                        EMSInfoRow(label: "بواسطة", value: name)
                                    }
                                }
                            }
                        }
                    } else {
                        EMSEmptyView(icon: "list.bullet.rectangle", title: "لا يوجد سجل",
                                     detail: "لا توجد عمليات أرشفة مسجلة لهذه المناوبة.")
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage("سجل الأرشفة — مناوبة #\(shiftId)")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { logShiftId = nil }
                        .tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    // MARK: - التصفح بين الصفحات

    private var paginationCard: some View {
        EMSCard {
            HStack {
                Button {
                    Task { await vm.goToPage(vm.page - 1) }
                } label: {
                    Image(systemName: "chevron.right")
                }
                .disabled(vm.page <= 1)
                Spacer()
                Text("صفحة \(vm.page) من \(vm.totalPages)")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                Spacer()
                Button {
                    Task { await vm.goToPage(vm.page + 1) }
                } label: {
                    Image(systemName: "chevron.left")
                }
                .disabled(vm.page >= vm.totalPages)
            }
            .tint(EMSTheme.Colors.teal)
        }
    }

    // MARK: - تنفيذ الإجراءات

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
