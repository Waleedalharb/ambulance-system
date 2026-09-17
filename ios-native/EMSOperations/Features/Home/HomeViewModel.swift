//
//  HomeViewModel.swift
//  EMSOperations
//

import Foundation

@MainActor
final class HomeViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var profile: ProfileDTO?
    @Published var sections: SectionsDTO.Sections?
    @Published var unreadCount = 0
    @Published var isOffline = false

    private let api = APIClient.shared

    func load(session: SessionStore) async {
        state = .loading
        isOffline = false
        do {
            async let profileReq: ProfileDTO = api.get("/api/my/profile")
            async let sectionsReq: SectionsDTO = api.get("/api/my/sections")
            async let notifReq: PortalNotificationsDTO = api.get("/api/my/notifications")
            let (p, s, n) = try await (profileReq, sectionsReq, notifReq)
            profile = p
            sections = s.sections
            unreadCount = n.unreadCount ?? 0
            session.unreadNotifications = n.unreadCount ?? 0
            state = .loaded
        } catch let e as APIError {
            if e == .offline {
                isOffline = true
                state = profile != nil ? .loaded : .failed(e.userMessage)
            } else {
                state = .failed(e.userMessage)
            }
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
