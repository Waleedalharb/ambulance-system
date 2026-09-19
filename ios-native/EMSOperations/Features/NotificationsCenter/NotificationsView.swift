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
