//
//  CompletionRecordsView.swift
//  EMSOperations
//
//  سجلات المناوبة (§7): أحداث (type/description) · غيابات (استبدال
//  جماعي يحفظ الحقول) · ملاحظات (text/category/priority/resolved —
//  نفس عقد الويب حرفيًا). الإضافة والحذف بصلاحية ops.completion.
//

import SwiftUI

struct CompletionRecordsView: View {
    @EnvironmentObject private var vm: CompletionOpsViewModel
    @EnvironmentObject private var session: SessionStore

    @State private var tab: RecordsTab = .events
    @State private var working = false
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    // إضافة حدث
    @State private var showAddEvent = false
    @State private var eventType = ""
    @State private var eventDescription = ""
    // إضافة غياب
    @State private var showAddAbsence = false
    @State private var absenceName = ""
    @State private var absenceReason = ""
    // إضافة ملاحظة
    @State private var showAddNote = false
    @State private var noteText = ""
    @State private var noteCategory = "general"
    @State private var notePriority = "normal"

    enum RecordsTab: String, CaseIterable, Identifiable {
        case events, absences, notes
        var id: String { rawValue }
        var title: String {
            switch self {
            case .events: return "أحداث"
            case .absences: return "غيابات"
            case .notes: return "ملاحظات"
            }
        }
    }

    private var canWrite: Bool { session.permissions.canCompleteOps }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                Picker("السجل", selection: $tab) {
                    ForEach(RecordsTab.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)

                switch tab {
                case .events: eventsSection
                case .absences: absencesSection
                case .notes: notesSection
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
        .emsPage("سجلات المناوبة")
        .refreshable { await vm.refresh() }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
        .sheet(isPresented: $showAddEvent) { addEventSheet }
        .sheet(isPresented: $showAddAbsence) { addAbsenceSheet }
        .sheet(isPresented: $showAddNote) { addNoteSheet }
    }

    // MARK: - الأحداث

    private var eventsSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: "أحداث المناوبة (\(vm.events.count))", systemImage: "bolt.fill")
                    Spacer()
                    if canWrite {
                        Button { showAddEvent = true } label: {
                            Image(systemName: "plus.circle.fill")
                                .foregroundStyle(EMSTheme.Colors.teal)
                        }
                    }
                }
                if vm.events.isEmpty {
                    Text("لا أحداث مسجلة.")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                } else {
                    ForEach(vm.events) { e in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    EMSStatusPill(text: e.type ?? "—", tone: .action)
                                    Text(e.timestamp ?? "")
                                        .font(.system(.caption2, design: .monospaced))
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                                Text(e.description ?? "—")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                            Spacer()
                            if canWrite {
                                Button {
                                    confirm = ConfirmRequest(title: "حذف حدث",
                                                             message: "حذف هذا الحدث؟",
                                                             destructive: true) {
                                        try await vm.deleteEvent(e.id)
                                        return "حُذف الحدث"
                                    }
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.danger)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - الغيابات

    private var absencesSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: "الغيابات (\(vm.absences.count))", systemImage: "person.fill.xmark")
                    Spacer()
                    if canWrite {
                        Button { showAddAbsence = true } label: {
                            Image(systemName: "plus.circle.fill")
                                .foregroundStyle(EMSTheme.Colors.teal)
                        }
                    }
                }
                if vm.absences.isEmpty {
                    Text("لا غيابات مسجلة.")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                } else {
                    ForEach(vm.absences) { a in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(a.title)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                                if let sub = a.subtitle {
                                    Text(sub)
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            Spacer()
                            if canWrite {
                                Button {
                                    confirm = ConfirmRequest(title: "حذف غياب",
                                                             message: "حذف غياب \(a.title)؟",
                                                             destructive: true) {
                                        try await vm.deleteAbsence(a.id)
                                        return "حُذف الغياب"
                                    }
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.danger)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - الملاحظات

    private func priorityTone(_ p: String?) -> EMSTheme.StatusTone {
        switch p {
        case "urgent": return .danger
        case "important": return .monitor
        default: return .action
        }
    }

    private static let categoryLabels: [String: String] = [
        "operational": "تشغيلية", "administrative": "إدارية",
        "emergency": "طارئة", "general": "عامة"
    ]

    private var notesSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: "الملاحظات (\(vm.notes.count))", systemImage: "note.text")
                    Spacer()
                    if canWrite {
                        Button { showAddNote = true } label: {
                            Image(systemName: "plus.circle.fill")
                                .foregroundStyle(EMSTheme.Colors.teal)
                        }
                    }
                }
                if vm.notes.isEmpty {
                    Text("لا ملاحظات مسجلة.")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                } else {
                    ForEach(vm.notes) { n in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    EMSStatusPill(text: Self.categoryLabels[n.category ?? ""] ?? (n.category ?? "عامة"),
                                                  tone: priorityTone(n.priority))
                                    if let t = n.time {
                                        Text(t)
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(EMSTheme.Colors.textMuted)
                                    }
                                }
                                Text(n.title)
                                    .font(.caption)
                                    .strikethrough(n.resolved == true)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                            Spacer()
                            if canWrite {
                                Button {
                                    execute {
                                        try await vm.toggleNoteResolved(n.id)
                                        return nil
                                    }
                                } label: {
                                    Image(systemName: n.resolved == true ? "arrow.uturn.backward.circle" : "checkmark.circle")
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.emerald)
                                }
                                .buttonStyle(.plain)
                                Button {
                                    confirm = ConfirmRequest(title: "حذف ملاحظة",
                                                             message: "حذف هذه الملاحظة؟",
                                                             destructive: true) {
                                        try await vm.deleteNote(n.id)
                                        return "حُذفت الملاحظة"
                                    }
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.danger)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - أوراق الإضافة

    private var addEventSheet: some View {
        recordSheet(title: "إضافة حدث", isPresented: $showAddEvent) {
            VStack(spacing: EMSTheme.spacing) {
                sheetField("النوع (مثال: logistics / note)", text: $eventType)
                sheetField("الوصف", text: $eventDescription, multiline: true)
                EMSPrimaryButton(title: "حفظ الحدث", isLoading: working,
                                 isDisabled: eventType.trimmingCharacters(in: .whitespaces).isEmpty
                                    || eventDescription.trimmingCharacters(in: .whitespaces).isEmpty) {
                    let t = eventType.trimmingCharacters(in: .whitespaces)
                    let d = eventDescription.trimmingCharacters(in: .whitespaces)
                    showAddEvent = false
                    eventType = ""; eventDescription = ""
                    execute {
                        try await vm.addEvent(type: t, description: d)
                        return "حُفظ الحدث"
                    }
                }
            }
        }
    }

    private var addAbsenceSheet: some View {
        recordSheet(title: "إضافة غياب", isPresented: $showAddAbsence) {
            VStack(spacing: EMSTheme.spacing) {
                sheetField("اسم الموظف", text: $absenceName)
                sheetField("السبب", text: $absenceReason)
                EMSPrimaryButton(title: "حفظ الغياب", isLoading: working,
                                 isDisabled: absenceName.trimmingCharacters(in: .whitespaces).isEmpty) {
                    let n = absenceName.trimmingCharacters(in: .whitespaces)
                    let r = absenceReason.trimmingCharacters(in: .whitespaces)
                    showAddAbsence = false
                    absenceName = ""; absenceReason = ""
                    execute {
                        try await vm.addAbsence(name: n, reason: r.isEmpty ? nil : r)
                        return "حُفظ الغياب"
                    }
                }
            }
        }
    }

    private var addNoteSheet: some View {
        recordSheet(title: "إضافة ملاحظة", isPresented: $showAddNote) {
            VStack(spacing: EMSTheme.spacing) {
                sheetField("نص الملاحظة", text: $noteText, multiline: true)
                Picker("التصنيف", selection: $noteCategory) {
                    Text("عامة").tag("general")
                    Text("تشغيلية").tag("operational")
                    Text("إدارية").tag("administrative")
                    Text("طارئة").tag("emergency")
                }
                .pickerStyle(.segmented)
                Picker("الأولوية", selection: $notePriority) {
                    Text("عادية").tag("normal")
                    Text("مهمة").tag("important")
                    Text("عاجلة").tag("urgent")
                }
                .pickerStyle(.segmented)
                EMSPrimaryButton(title: "حفظ الملاحظة", isLoading: working,
                                 isDisabled: noteText.trimmingCharacters(in: .whitespaces).isEmpty) {
                    let t = noteText.trimmingCharacters(in: .whitespaces)
                    let c = noteCategory
                    let p = notePriority
                    showAddNote = false
                    noteText = ""
                    execute {
                        try await vm.addNote(text: t, category: c, priority: p)
                        return "حُفظت الملاحظة"
                    }
                }
            }
        }
    }

    private func recordSheet<Content: View>(title: String, isPresented: Binding<Bool>,
                                            @ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            ScrollView {
                content()
                    .padding(EMSTheme.pagePadding)
            }
            .background(EMSBackground())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { isPresented.wrappedValue = false }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func sheetField(_ placeholder: String, text: Binding<String>, multiline: Bool = false) -> some View {
        Group {
            if multiline {
                TextField(placeholder, text: text, axis: .vertical)
                    .lineLimit(2...5)
            } else {
                TextField(placeholder, text: text)
            }
        }
        .textFieldStyle(.plain)
        .foregroundStyle(EMSTheme.Colors.textPrimary)
        .padding(12)
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func execute(_ work: @escaping () async throws -> String?) {
        errorMessage = nil
        working = true
        Task {
            do { _ = try await work() }
            catch let e as APIError { errorMessage = e.userMessage }
            catch { errorMessage = APIError.unknown.userMessage }
            working = false
        }
    }
}
