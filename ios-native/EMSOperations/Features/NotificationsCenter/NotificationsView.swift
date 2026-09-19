//
//  NotificationsView.swift
//  EMSOperations
//
//  «إشعاراتي» (قسم 17): قراءة عند الفتح + تأكيد مستقل
//  (فتح الإشعار ≠ تأكيده — نفس دلالة الخادم).
//

import SwiftUI

struct NotificationsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = NotificationsViewModel()
    /// بند 11: بطاقة تفاصيل التمركز عند فتح إشعار تمركز من القائمة.
    @State private var noticeSheet: PositioningNotice?

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(session: session) } }
                case .loaded:
                    if vm.items.isEmpty {
                        EMSEmptyView(icon: "bell.slash", title: "لا توجد إشعارات")
                    } else {
                        ForEach(vm.items) { item in
                            notificationCard(item)
                        }
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load(session: session) }
        .emsPage("إشعاراتي")
        .task { await vm.load(session: session) }
        .sheet(item: $noticeSheet) { notice in
            PositioningNoticeView(notice: notice)
        }
    }

    private func notificationCard(_ n: PortalNotificationsDTO.Item) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    if !n.isRead {
                        Circle().fill(EMSTheme.Colors.teal).frame(width: 8, height: 8)
                    }
                    Text(n.createdAt ?? "")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Spacer()
                    if n.isAcked {
                        EMSStatusPill(text: "مؤكَّد", tone: .normal)
                    } else if n.isRead {
                        EMSStatusPill(text: "مقروء", tone: .neutral)
                    }
                }
                Text(n.message)
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 16) {
                    if !n.isRead {
                        Button {
                            Task { await vm.markRead(n, session: session) }
                        } label: {
                            Label("ختم القراءة", systemImage: "envelope.open")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                        }
                    }
                    if !n.isAcked {
                        Button {
                            Task { await vm.markAck(n, session: session) }
                        } label: {
                            Label("تأكيد الاستلام", systemImage: "checkmark.seal")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(EMSTheme.Colors.emerald)
                        }
                    }
                }
                // بند 11: إشعار تمركز يحمل بطاقة تفاصيل منظمة
                if n.message.contains("[تمركز #") {
                    Button {
                        noticeSheet = PositioningNotice(title: "تمركز وقت الذروة", message: n.message)
                    } label: {
                        Label("عرض تفاصيل التمركز", systemImage: "mappin.and.ellipse")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.teal)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

@MainActor
final class NotificationsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var items: [PortalNotificationsDTO.Item] = []

    private let api = APIClient.shared

    func load(session: SessionStore) async {
        if items.isEmpty { state = .loading }
        do {
            let res: PortalNotificationsDTO = try await api.get("/api/my/notifications")
            items = res.notifications
            session.unreadNotifications = res.unreadCount ?? 0
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: !items.isEmpty, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: !items.isEmpty, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func markRead(_ n: PortalNotificationsDTO.Item, session: SessionStore) async {
        do {
            let _: MarkStatusResponse = try await api.post("/api/my/notifications/\(n.id)/read", body: Optional<String>.none)
            await load(session: session)
        } catch { /* تبقى الحالة — إعادة المحاولة متاحة */ }
    }

    func markAck(_ n: PortalNotificationsDTO.Item, session: SessionStore) async {
        do {
            let _: MarkStatusResponse = try await api.post("/api/my/notifications/\(n.id)/ack", body: Optional<String>.none)
            await load(session: session)
        } catch { /* نفس الاعتبار */ }
    }
}

// MARK: - بند 11 (اعتماد المالك 2026-09-20): بطاقة تفاصيل تمركز وقت الذروة

/// حمولة البطاقة — من Push (DeepLinkRouter) أو من إشعار داخلي في القائمة.
struct PositioningNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

/// بطاقة «تفاصيل التمركز»: تعرض سطور الرسالة الموسومة (الفرقة/الموقع/البداية/…)
/// كصفوف منظمة، وتخفي مُعرّف التمركز الداخلي [تمركز #id]. عرض فقط — بلا منطق.
struct PositioningNoticeView: View {
    @Environment(\.dismiss) private var dismiss
    let notice: PositioningNotice

    private struct Row: Identifiable {
        let id = UUID()
        let label: String   // فارغ = سطر حر (الجملة الافتتاحية)
        let value: String
    }

    private var rows: [Row] {
        notice.message.components(separatedBy: "\n").compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { return nil }
            if line.hasPrefix("["), line.hasSuffix("]") { return nil } // مُعرّف داخلي
            if let sep = line.firstIndex(of: ":") {
                let label = String(line[..<sep]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: sep)...]).trimmingCharacters(in: .whitespaces)
                if !label.isEmpty, !value.isEmpty, label.count <= 12 {
                    return Row(label: label, value: value)
                }
            }
            return Row(label: "", value: line)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                EMSCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Image(systemName: "mappin.and.ellipse")
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(notice.title)
                                .font(.headline.weight(.bold))
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                        }
                        .padding(.bottom, 4)
                        ForEach(rows) { row in
                            if row.label.isEmpty {
                                Text(row.value)
                                    .font(.subheadline)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            } else {
                                EMSInfoRow(label: row.label, value: row.value)
                            }
                        }
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage(notice.title)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { dismiss() }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }
}
