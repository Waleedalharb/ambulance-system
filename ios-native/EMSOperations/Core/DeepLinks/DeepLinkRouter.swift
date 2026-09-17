//
//  DeepLinkRouter.swift
//  EMSOperations
//
//  توجيه مركزي للإشعارات (D6): data.kind → وجهة.
//  schedule_change → سجل تغييرات جدولي · غيره → إشعاراتي (قسم 18).
//

import Foundation

@MainActor
final class DeepLinkRouter: ObservableObject {
    enum Destination {
        case scheduleChanges
        case notifications
    }

    struct Link: Equatable {
        let destination: Destination
        let id = UUID()
        static func == (a: Link, b: Link) -> Bool { a.id == b.id }
    }

    @Published var pending: Link?
    /// طلب عرض «سجل تغييرات جدولي» داخل تبويب الجدول.
    @Published var requestScheduleChanges = false

    func route(kind: String?) {
        switch kind {
        case "schedule_change":
            pending = Link(destination: .scheduleChanges)
        default:
            pending = Link(destination: .notifications)
        }
    }
}
