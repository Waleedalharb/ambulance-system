//
//  OpsTimelinesView.swift
//  EMSOperations
//
//  خطوط الأحداث (§14): الكادر / المركبات / المناوبة.
//  القراءة للجميع (authenticate) — إضافة/حذف أحداث المناوبة اليدوية مقيدة
//  بصلاحية ops.completion (canCompleteOps) كما في server.js حرفيًا.
//  عرض الخام كما يصل من الخادم؛ لا حساب ولا اشتقاق في العميل.
//

import SwiftUI

// MARK: - تسميات عرضية خالصة (القيم سيرفرية — التسمية لا تغيّر الدلالة)

enum TimelineDisplay {
    static func eventLabel(_ type: String?) -> String {
        switch type {
        case "late": return "تأخر"
        case "absence": return "غياب"
        case "arrival": return "حضور"
        case "correction": return "تصحيح"
        case "assignment": return "إسناد"
        case "external_support": return "دعم خارجي"
        case "volunteer_support": return "دعم تطوعي"
        case "support_end": return "نهاية دعم"
        case "activation": return "تفعيل"
        case "activation_end": return "نهاية تفعيل"
        case "status": return "حالة"
        case "note": return "ملاحظة"
        default: return type ?? "حدث"
        }
    }

    static func eventTone(_ type: String?) -> EMSTheme.StatusTone {
        switch type {
        case "late", "absence": return .danger
        case "correction": return .monitor
        case "arrival": return .normal
        case "external_support", "volunteer_support", "activation": return .action
        default: return .neutral
        }
    }
}

// MARK: - خط الكادر الزمني

struct StaffingTimelineView: View {
    @StateObject private var vm = StaffingTimelineViewModel()

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
    }

    @ViewBuilder
    private var content: some View {
        let late = vm.data?.lateRecords ?? []
        let coverage = vm.data?.coverageRecords ?? []
        let events = vm.data?.events ?? []

        if late.isEmpty && coverage.isEmpty && events.isEmpty {
            EMSEmptyView(
                icon: "person.3",
                title: "لا توجد أحداث كادر",
                detail: "لم تُسجّل أحداث قوى بشرية في هذه المناوبة")
        } else {
            if !late.isEmpty {
                EMSSectionHeader(title: "سجلات التأخير", systemImage: "clock.badge.exclamationmark")
                ForEach(late) { rec in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(rec.employee ?? "—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(
                                    text: rec.status == "arrived" ? "حضر" : "لم يحضر",
                                    tone: rec.status == "arrived" ? .normal : .danger)
                            }
                            if let job = rec.jobTitle, !job.isEmpty {
                                EMSInfoRow(label: "المسمى", value: job)
                            }
                            if let started = rec.startedAt {
                                EMSInfoRow(label: "البداية", value: started)
                            }
                            if let arrived = rec.arrivedAt {
                                EMSInfoRow(label: "الحضور", value: arrived)
                            }
                            if let mins = rec.durationMinutes {
                                EMSInfoRow(label: "مدة التأخير", value: "\(mins) دقيقة")
                            }
                            if rec.carriedFromShiftId != nil {
                                EMSInfoRow(label: "مرحّل", value: "من المناوبة السابقة")
                            }
                        }
                    }
                }
            }

            if !coverage.isEmpty {
                EMSSectionHeader(title: "سجلات التغطية", systemImage: "person.2.badge.plus")
                ForEach(coverage) { rec in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(rec.employee ?? "—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(
                                    text: rec.coverageTypeLabel ?? rec.coverageType ?? "تغطية",
                                    tone: rec.status == "active" ? .action : .neutral)
                            }
                            if let center = rec.fromCenter, !center.isEmpty {
                                EMSInfoRow(label: "من مركز", value: center)
                            }
                            if let started = rec.startedAt {
                                EMSInfoRow(label: "بدأ", value: started)
                            }
                            if let ended = rec.endedAt {
                                EMSInfoRow(label: "انتهى", value: ended)
                            }
                            if let mins = rec.durationMinutes {
                                EMSInfoRow(label: "المدة", value: "\(mins) دقيقة")
                            }
                            if let by = rec.approvedBy, !by.isEmpty {
                                EMSInfoRow(label: "بواسطة", value: by)
                            }
                        }
                    }
                }
            }

            if !events.isEmpty {
                EMSSectionHeader(title: "السجل الخام", systemImage: "list.bullet.rectangle")
                ForEach(events) { ev in
                    OpEventCard(event: ev)
                }
            }
        }
    }
}

@MainActor
final class StaffingTimelineViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: StaffingTimelineDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/staffing/timeline")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}

// MARK: - خط المركبات الزمني

struct VehiclesTimelineView: View {
    @StateObject private var vm = VehiclesTimelineViewModel()

    var body: some View {
        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 4)
            EMSSkeletonCard(lines: 3)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load() } }
        case .loaded:
            let events = vm.data?.events ?? []
            if events.isEmpty {
                EMSEmptyView(
                    icon: "truck.box",
                    title: "لا توجد أحداث مركبات",
                    detail: "لم تُسجّل أحداث مركبات في هذه المناوبة")
            } else {
                ForEach(events) { ev in
                    OpEventCard(event: ev)
                }
            }
        }
    }
}

@MainActor
final class VehiclesTimelineViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: VehiclesTimelineDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/vehicles/timeline")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}

// MARK: - بطاقة حدث تشغيلي خام (مشتركة بين الكادر والمركبات)

struct OpEventCard: View {
    let event: OpEventDTO

    var body: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    EMSStatusPill(
                        text: TimelineDisplay.eventLabel(event.eventType),
                        tone: TimelineDisplay.eventTone(event.eventType))
                    Spacer()
                    if let at = event.createdAt {
                        Text(at)
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                if let name = event.entityName ?? event.entityId, !name.isEmpty {
                    EMSInfoRow(label: "الكيان", value: name)
                }
                if let status = event.status, !status.isEmpty {
                    EMSInfoRow(label: "الحالة", value: status)
                }
                if let reason = event.reason, !reason.isEmpty {
                    EMSInfoRow(label: "السبب", value: reason)
                }
                if let note = event.note, !note.isEmpty {
                    EMSInfoRow(label: "ملاحظة", value: note)
                }
                if let actor = event.actorName, !actor.isEmpty {
                    EMSInfoRow(label: "بواسطة", value: actor)
                }
            }
        }
    }
}

// MARK: - خط المناوبة الزمني + أحداثها اليدوية

struct ShiftTimelineView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = ShiftTimelineViewModel()
    @State private var showAdd = false
    @State private var pendingDelete: ShiftEventDTO?

    private var canWrite: Bool { session.permissions.canCompleteOps }

    var body: some View {
        Group {
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
        .sheet(isPresented: $showAdd) {
            ShiftEventAddSheet { type, description in
                await vm.addEvent(type: type, description: description)
            }
        }
        .confirmationDialog(
            "حذف هذا الحدث؟",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("حذف", role: .destructive) {
                if let ev = pendingDelete {
                    Task { _ = await vm.deleteEvent(ev) }
                }
                pendingDelete = nil
            }
            Button("إلغاء", role: .cancel) { pendingDelete = nil }
        }
    }

    @ViewBuilder
    private var content: some View {
        if vm.shiftId == nil {
            EMSEmptyView(
                icon: "clock",
                title: "لا توجد مناوبة نشطة",
                detail: "يظهر خط المناوبة الزمني عند وجود مناوبة نشطة")
        } else {
            if let info = vm.infoMessage {
                Text(info)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.emerald)
            }

            EMSSectionHeader(title: "الخط الزمني للمناوبة", systemImage: "clock.arrow.circlepath")
            if vm.timeline.isEmpty {
                EMSEmptyView(
                    icon: "clock",
                    title: "لا توجد أحداث زمنية",
                    detail: "لم تُسجّل أحداث زمنية لهذه المناوبة بعد")
            } else {
                ForEach(vm.timeline) { ev in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(ev.eventTitle ?? "حدث")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer()
                                if let type = ev.eventType {
                                    EMSStatusPill(text: TimelineDisplay.eventLabel(type), tone: TimelineDisplay.eventTone(type))
                                }
                            }
                            if let desc = ev.eventDescription, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: 6) {
                                if let time = ev.eventTime {
                                    Text(time)
                                }
                                if let by = ev.createdByName, !by.isEmpty {
                                    Text("·")
                                    Text(by)
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                    }
                }
            }

            HStack {
                EMSSectionHeader(title: "الأحداث اليدوية", systemImage: "square.and.pencil")
                Spacer()
                if canWrite {
                    Button {
                        showAdd = true
                    } label: {
                        Label("إضافة", systemImage: "plus")
                            .font(.caption.weight(.semibold))
                    }
                }
            }

            if vm.manualEvents.isEmpty {
                EMSEmptyView(
                    icon: "square.and.pencil",
                    title: "لا توجد أحداث يدوية",
                    detail: canWrite ? "يمكنك تسجيل حدث تشغيلي يدوي لهذه المناوبة" : "تسجيل الأحداث يتطلب صلاحية التكميل")
            } else {
                ForEach(vm.manualEvents) { ev in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                EMSStatusPill(
                                    text: TimelineDisplay.eventLabel(ev.type),
                                    tone: TimelineDisplay.eventTone(ev.type))
                                Spacer()
                                if canWrite {
                                    Button(role: .destructive) {
                                        pendingDelete = ev
                                    } label: {
                                        Image(systemName: "trash")
                                            .font(.caption)
                                    }
                                    .disabled(vm.isMutating)
                                }
                            }
                            if let desc = ev.description, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let ts = ev.timestamp {
                                Text(ts)
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

// MARK: - ورقة إضافة حدث يدوي

struct ShiftEventAddSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var type = ""
    @State private var descriptionText = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    let onSave: (String, String) async -> String?

    var body: some View {
        NavigationStack {
            Form {
                Section("نوع الحدث") {
                    TextField("مثال: note", text: $type)
                }
                Section("الوصف") {
                    TextEditor(text: $descriptionText)
                        .frame(minHeight: 100)
                }
                if let error = errorMessage {
                    Section {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.danger)
                    }
                }
            }
            .navigationTitle("إضافة حدث")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("إلغاء") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("حفظ") {
                        Task {
                            isSaving = true
                            errorMessage = nil
                            let result = await onSave(
                                type.trimmingCharacters(in: .whitespaces),
                                descriptionText.trimmingCharacters(in: .whitespacesAndNewlines))
                            isSaving = false
                            if result != nil {
                                dismiss()
                            } else {
                                errorMessage = "تعذّر الحفظ — تحقق من الاتصال والصلاحية"
                            }
                        }
                    }
                    .disabled(isSaving || type.trimmingCharacters(in: .whitespaces).isEmpty || descriptionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

// MARK: - ViewModel خط المناوبة

@MainActor
final class ShiftTimelineViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var shiftId: Int?
    @Published var timeline: [ShiftTimelineEventDTO] = []
    @Published var manualEvents: [ShiftEventDTO] = []
    @Published var infoMessage: String?
    @Published var isMutating = false

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            let current: CurrentShiftDTO = try await api.get("/api/current-shift")
            guard let sid = current.shift?.id else {
                shiftId = nil
                timeline = []
                manualEvents = []
                state = .loaded
                return
            }
            shiftId = sid
            async let timelineReq: ShiftTimelineDTO = api.get("/api/shifts/\(sid)/timeline")
            async let eventsReq: ShiftEventsDTO = api.get("/api/shift-events/\(sid)")
            let (tl, se) = try await (timelineReq, eventsReq)
            timeline = tl.events ?? []
            manualEvents = se.events ?? []
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func addEvent(type: String, description: String) async -> String? {
        guard let sid = shiftId, !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let body = ShiftEventCreateRequestDTO(type: type, description: description, timestamp: nil)
            let _: ShiftEventCreateResponseDTO = try await api.post("/api/shift-events/\(sid)", body: body)
            infoMessage = "تمت إضافة الحدث"
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

    func deleteEvent(_ event: ShiftEventDTO) async -> String? {
        guard let sid = shiftId, !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let _: BasicSuccessDTO = try await api.delete("/api/shift-events/\(sid)/\(event.id)")
            infoMessage = "تم حذف الحدث"
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
