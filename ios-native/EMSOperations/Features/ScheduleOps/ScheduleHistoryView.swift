//
//  ScheduleHistoryView.swift
//  EMSOperations
//
//  سجل تدقيق الجدول من /api/shift-roster/audit-log — قبل/بعد
//  سيرفري (رمز وفريق)، نوع التغيير، المنفّذ، والسبب. فلاتر:
//  الأحدث / موظف محدد / فترة زمنية. أسماء الموظفين والفرق تُربط
//  عرضيًا من المرجعيات المحمّلة (السجل لا يحملها) — «موظف #id» عند الغياب.
//

import SwiftUI

struct ScheduleHistoryView: View {
    var initialEmployeeId: Int? = nil
    var initialEmployeeName: String? = nil

    @EnvironmentObject private var vm: ScheduleOpsViewModel

    @State private var filter: Filter = .latest
    @State private var state: LoadState = .idle
    @State private var entries: [RosterAuditLogDTO.Entry] = []
    @State private var query = ""
    @State private var results: [EmployeeDirectoryDTO.Person] = []
    @State private var searching = false
    @State private var employee: (id: Int, name: String)?
    @State private var fromDate = Date()
    @State private var toDate = Date()

    enum Filter: String, CaseIterable, Identifiable {
        case latest, employee, range
        var id: String { rawValue }
        var title: String {
            switch self {
            case .latest: return "الأحدث"
            case .employee: return "موظف"
            case .range: return "فترة"
            }
        }
    }

    enum LoadState { case idle, loading, loaded, failed(String) }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                filterPicker
                switch filter {
                case .latest:
                    EmptyView()
                case .employee:
                    employeeFilter
                case .range:
                    rangeFilter
                }
                content
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("سجل التغييرات")
        .task { boot() }
        .onChange(of: filter) { newValue in
            if newValue == .latest { reload() }
        }
    }

    // MARK: - الإقلاع والتحميل

    private func boot() {
        guard case .idle = state else { return }
        if let id = initialEmployeeId {
            employee = (id, initialEmployeeName ?? vm.employeeName(id))
            filter = .employee
        }
        reload()
    }

    private func reload() {
        state = .loading
        Task {
            do {
                switch filter {
                case .latest:
                    entries = try await vm.audit(employeeId: nil, dateFrom: nil, dateTo: nil)
                case .employee:
                    guard let emp = employee else { state = .loaded; entries = []; return }
                    entries = try await vm.audit(employeeId: emp.id, dateFrom: nil, dateTo: nil)
                case .range:
                    let f = ScheduleDateKit.string(fromDate)
                    let t = ScheduleDateKit.string(toDate)
                    entries = try await vm.audit(employeeId: nil, dateFrom: f, dateTo: t)
                }
                state = .loaded
            } catch let e as APIError {
                state = .failed(e.userMessage)
            } catch {
                state = .failed(APIError.unknown.userMessage)
            }
        }
    }

    // MARK: - الفلاتر

    private var filterPicker: some View {
        Picker("الفلتر", selection: $filter) {
            ForEach(Filter.allCases) { f in
                Text(f.title).tag(f)
            }
        }
        .pickerStyle(.segmented)
    }

    private var employeeFilter: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                if let emp = employee {
                    HStack {
                        Text(emp.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                        Spacer()
                        Button("تغيير") {
                            employee = nil
                            entries = []
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                    }
                } else {
                    HStack(spacing: 8) {
                        TextField("ابحث عن موظف", text: $query)
                            .textFieldStyle(.plain)
                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                            .padding(10)
                            .background(Color.white.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .submitLabel(.search)
                            .onSubmit { runSearch() }
                        Button {
                            runSearch()
                        } label: {
                            if searching { ProgressView().tint(.white) }
                            else { Image(systemName: "magnifyingglass").foregroundStyle(.white) }
                        }
                        .frame(width: 40, height: 40)
                        .background(EMSTheme.Colors.teal)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .disabled(searching || query.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    ForEach(results) { person in
                        Button {
                            guard let id = person.id else { return }
                            employee = (id, person.name ?? "موظف #\(id)")
                            results = []
                            reload()
                        } label: {
                            HStack {
                                Text(person.name ?? "—")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                                Spacer()
                                Text(person.employeeCode ?? "")
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func runSearch() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true
        Task {
            results = (try? await vm.searchEmployees(q)) ?? []
            searching = false
        }
    }

    private var rangeFilter: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                DatePicker("من", selection: $fromDate, displayedComponents: .date)
                    .tint(EMSTheme.Colors.teal)
                DatePicker("إلى", selection: $toDate, displayedComponents: .date)
                    .tint(EMSTheme.Colors.teal)
                EMSPrimaryButton(title: "عرض الفترة", isLoading: isLoading,
                                 isDisabled: fromDate > toDate) {
                    reload()
                }
            }
        }
    }

    private var isLoading: Bool {
        if case .loading = state { return true }
        return false
    }

    // MARK: - المحتوى

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle:
            EmptyView()
        case .loading:
            EMSSkeletonCard(lines: 5)
        case .failed(let message):
            EMSErrorView(message: message) { reload() }
        case .loaded:
            if entries.isEmpty {
                EMSEmptyView(icon: "clock", title: "لا توجد تغييرات مسجلة")
            } else {
                ForEach(entries) { entry in
                    entryCard(entry)
                }
            }
        }
    }

    private static let typeTitles: [String: String] = [
        "edit": "تعديل", "swap": "تبديل", "bulk": "جماعي", "delete": "حذف", "add": "إضافة"
    ]

    private static let typeTones: [String: EMSTheme.StatusTone] = [
        "edit": .action, "swap": .monitor, "bulk": .monitor, "delete": .danger, "add": .normal
    ]

    private func entryCard(_ e: RosterAuditLogDTO.Entry) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    EMSStatusPill(text: Self.typeTitles[e.changeType ?? ""] ?? (e.changeType ?? "—"),
                                  tone: Self.typeTones[e.changeType ?? ""] ?? .neutral)
                    Spacer()
                    Text(e.shiftDate ?? "—")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
                Text(vm.employeeName(e.employeeId))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                HStack(spacing: 6) {
                    Text("الرمز:")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Text("\(e.oldShiftCode ?? "—") ← \(e.newShiftCode ?? "—")")
                        .font(.system(.caption.weight(.semibold), design: .monospaced))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                }
                if e.oldTeamId != e.newTeamId {
                    HStack(spacing: 6) {
                        Text("الفريق:")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        Text("\(vm.teamName(e.oldTeamId)) ← \(vm.teamName(e.newTeamId))")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(EMSTheme.Colors.textSecondary)
                    }
                }
                if let reason = e.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                HStack {
                    Text(e.changedByName ?? e.changedBy ?? "—")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Spacer()
                    Text(e.createdAt ?? "—")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }
}
