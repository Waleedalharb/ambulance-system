//
//  AdminNotificationsView.swift
//  EMSOperations
//
//  إشعارات النظام (§5): إرسال إشعار موجه (admin/director —
//  server.js:12233 عبر NotificationLog) + سجل الإرسال مع تعقّب الحالة
//  (server.js:12260 — pending/sent/delivered/read/acknowledged).
//  إشعارات الموظف الشخصية في NotificationsView — هذه شاشة الإدارة.
//

import SwiftUI

struct AdminNotificationsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = AdminNotificationsViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?

    // إرسال
    @State private var sRecipient = ""
    @State private var sMessage = ""
    @State private var sType = "system"

    private var canSend: Bool { session.permissions.isAdminOrDirector }

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) { EMSSkeletonCard(lines: 4); EMSSkeletonCard(lines: 4) }
                    .padding(EMSTheme.pagePadding)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.reload(showLoading: true) } }
                    .padding(EMSTheme.pagePadding)
            case .loaded:
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .emsPage("إشعارات النظام")
        .task { await vm.load() }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if canSend { sendCard }
                inboxSection
                filtersCard
                if vm.entries.isEmpty {
                    EMSEmptyView(icon: "bell.badge", title: "السجل فارغ",
                                 detail: "لا توجد إشعارات مرسلة مطابقة.")
                } else {
                    ForEach(vm.entries, id: \.stableId) { entry in entryCard(entry) }
                }
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

    // MARK: - الإرسال (admin/director)

    private var sendCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "إرسال إشعار", systemImage: "paperplane.fill")
                TextField("معرّف المستلم (رقم الموظف)", text: $sRecipient)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.numberPad)
                    .emsNumericInput()
                Picker("النوع", selection: $sType) {
                    // القيم الثلاث المسموحة في CHECK — db.js:890
                    Text("تغيير مناوبة").tag("shift_change")
                    Text("نظام").tag("system")
                    Text("تنبيه").tag("alert")
                }
                .pickerStyle(.segmented)
                TextField("نص الرسالة", text: $sMessage, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...4)
                EMSPrimaryButton(title: "إرسال", isLoading: working,
                                 isDisabled: sRecipient.trimmingCharacters(in: .whitespaces).isEmpty
                                    || sMessage.trimmingCharacters(in: .whitespaces).isEmpty) {
                    working = true
                    infoMessage = nil
                    errorMessage = nil
                    Task {
                        do {
                            try await vm.send(recipientId: Int(sRecipient.trimmingCharacters(in: .whitespaces)) ?? 0,
                                              message: sMessage.trimmingCharacters(in: .whitespaces),
                                              type: sType)
                            infoMessage = "تم إرسال الإشعار"
                            sRecipient = ""; sMessage = ""
                        } catch let e as APIError {
                            errorMessage = e.userMessage
                        } catch {
                            errorMessage = APIError.unknown.userMessage
                        }
                        working = false
                    }
                }
            }
        }
    }

    // MARK: - الوارد (Inbox المستخدم الحالي — 2026-09-29)

    /// إشعارات المستخدم الحالي من GET /api/notifications — تهبط هنا إشعارات
    /// طلبات الموظفين (leave.submitted / shift_change.submitted) لحاملي
    /// requests.review. مصدر مستقل عن سجل الإرسال أدناه ولا يغيّر شيئًا فيه.
    private var inboxSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "الوارد", systemImage: "tray.and.arrow.down.fill")
                if vm.inbox.isEmpty {
                    Text("لا توجد إشعارات واردة.")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                } else {
                    ForEach(vm.inbox, id: \.stableId) { item in inboxRow(item) }
                }
            }
        }
    }

    private func inboxRow(_ item: AdminInboxItemDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(item.title ?? "إشعار")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                EMSStatusPill(text: item.typeTitle, tone: item.typeTone)
            }
            if let message = item.message, !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Text(item.isRead ? "مقروء" : "غير مقروء")
                    .font(.caption2)
                    .foregroundStyle(item.isRead ? EMSTheme.Colors.textMuted : EMSTheme.Colors.teal)
                if let at = item.createdAt {
                    Text(at).font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - الفلاتر والسجل

    private var filtersCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "سجل الإرسال", systemImage: "list.bullet.rectangle")
                HStack(spacing: 8) {
                    Picker("الحالة", selection: $vm.statusFilter) {
                        Text("كل الحالات").tag("")
                        Text("معلّق").tag("pending")
                        Text("مرسل").tag("sent")
                        Text("مسلَّم").tag("delivered")
                        Text("مقروء").tag("read")
                        Text("فشل").tag("failed")
                    }
                    .pickerStyle(.menu)
                    .font(.caption)
                    Spacer()
                    Button("تطبيق") { Task { await vm.reload(showLoading: true) } }
                        .font(.caption.weight(.semibold))
                        .tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private func entryCard(_ entry: NotificationLogEntryDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(entry.recipientName ?? "مستلم #\(entry.recipientId ?? 0)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    EMSStatusPill(text: entry.statusTitle, tone: entry.statusTone)
                }
                Text(entry.message ?? "")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    if let type = entry.notificationType {
                        Text(type).font(.caption2).foregroundStyle(EMSTheme.Colors.teal)
                    }
                    if let at = entry.sentAt ?? entry.createdAt {
                        Text(at).font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                // تعقّب التسليم: delivered/opened/acknowledged
                if entry.deliveredAt != nil || entry.openedAt != nil {
                    HStack(spacing: 10) {
                        if let d = entry.deliveredAt { Text("سُلّم: \(d)").font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted) }
                        if let o = entry.openedAt { Text("فُتح: \(o)").font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted) }
                    }
                }
                if let err = entry.errorMessage, !err.isEmpty {
                    Text(err).font(.caption2).foregroundStyle(EMSTheme.Colors.danger)
                }
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class AdminNotificationsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var entries: [NotificationLogEntryDTO] = []
    @Published private(set) var inbox: [AdminInboxItemDTO] = []
    @Published var statusFilter = ""

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        // الوارد: جلب مستقل — فشله لا يكسر سجل الإرسال ولا يُخفي محتواه
        if let res: AdminInboxResponseDTO = try? await api.get("/api/notifications") {
            inbox = res.notifications ?? []
        }
        var query: [String: String] = ["limit": "50"]
        if !statusFilter.isEmpty { query["status"] = statusFilter }
        do {
            let res: NotificationLogResponseDTO = try await api.get("/api/notifications/log", query: query)
            entries = res.notifications ?? []
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func send(recipientId: Int, message: String, type: String) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/notifications/send",
            body: NotificationSendRequestDTO(recipientId: recipientId, message: message, type: type))
        if res.success == false { throw APIError.server(res.error ?? "فشل في إرسال الإشعار") }
        await reload()
    }
}
