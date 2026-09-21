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
        /// بند 11: إشعار تمركز وقت الذروة — يفتح بطاقة تفاصيل التمركز مباشرة.
        case positioning
    }

    struct Link: Equatable {
        let destination: Destination
        let title: String?
        let body: String?
        let id = UUID()
        static func == (a: Link, b: Link) -> Bool { a.id == b.id }
    }

    @Published var pending: Link?
    /// طلب عرض «سجل تغييرات جدولي» داخل تبويب الجدول.
    @Published var requestScheduleChanges = false

    func route(kind: String?, title: String? = nil, body: String? = nil) {
        switch kind {
        case "schedule_change":
            pending = Link(destination: .scheduleChanges, title: nil, body: nil)
        case "positioning":
            pending = Link(destination: .positioning, title: title, body: body)
        default:
            pending = Link(destination: .notifications, title: nil, body: nil)
        }
    }
}
