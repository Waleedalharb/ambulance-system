//
//  VehicleHistoryView.swift
//  EMSOperations
//
//  تاريخ المركبة (§10): GET /api/vehicles/:id/history ←
//  VehicleEventsService.getVehicleHistory — الحالة الحالية المشتقة
//  سيرفريًا + خط الأحداث عبر المناوبات (createdAtRiyadh للعرض —
//  TIME-POLICY). قراءة فقط.
//

import SwiftUI

struct VehicleHistoryView: View {
    let vehicleId: String
    @StateObject private var vm = VehicleHistoryViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 3)
                    EMSSkeletonCard(lines: 5)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(vehicleId: vehicleId, showLoading: true) } }
                case .loaded:
                    content
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load(vehicleId: vehicleId) }
        .emsPage("تاريخ المركبة")
        .task { await vm.load(vehicleId: vehicleId) }
    }

    @ViewBuilder
    private var content: some View {
        if let info = vm.data?.vehicle {
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Image(systemName: "truck.box.fill")
                            .foregroundStyle(EMSTheme.Colors.teal)
                        Text(info.name ?? "مركبة")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                        Spacer()
                        if let status = vm.data?.current?.status {
                            EMSStatusPill(text: statusLabel(status), tone: statusTone(status))
                        }
                    }
                    if let plate = info.plateNumber { EMSInfoRow(label: "اللوحة", value: plate) }
                    if let type = info.vehicleType { EMSInfoRow(label: "النوع", value: type) }
                    if let year = info.modelYear { EMSInfoRow(label: "الموديل", value: "\(year)") }
                    if let designation = info.designation { EMSInfoRow(label: "التعيين", value: designation) }
                    if let team = vm.data?.current?.teamName { EMSInfoRow(label: "الفريق الحالي", value: team) }
                    if let since = vm.data?.current?.since { EMSInfoRow(label: "منذ", value: since) }
                    if let notes = info.notes, !notes.isEmpty {
                        Text(notes)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
            }
        }

        let events = vm.data?.events ?? []
        if events.isEmpty {
            EMSEmptyView(icon: "clock", title: "لا توجد أحداث مسجلة لهذه المركبة")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "الأحداث عبر المناوبات")
                ForEach(events.reversed()) { event in
                    eventCard(event)
                }
            }
        }
    }

    private func eventCard(_ event: VehicleHistoryDTO.Event) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(eventTitle(event))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let when = event.createdAtRiyadh {
                        Text(when)
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                if let team = event.teamName {
                    EMSInfoRow(label: "الفريق", value: team)
                }
                if let shiftDate = event.shiftDate {
                    EMSInfoRow(label: "المناوبة", value: "\(shiftDate) \(event.shiftType ?? "")")
                }
                if let reason = event.reason, !reason.isEmpty {
                    EMSInfoRow(label: "السبب", value: reason)
                }
                if let note = event.note, !note.isEmpty {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                if let actor = event.actorName, !actor.isEmpty {
                    Text("بواسطة \(actor)")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    private func eventTitle(_ event: VehicleHistoryDTO.Event) -> String {
        switch event.eventType {
        case "status_change": return "تغيير حالة ← \(statusLabel(event.status ?? ""))"
        case "assignment": return "إسناد"
        case "assignment_end": return "إنهاء إسناد"
        case "support_open": return "إرسال دعمًا"
        case "support_close": return "إنهاء دعم"
        case "workshop_in": return "دخول الورشة"
        case "workshop_out": return "خروج من الورشة"
        case "note": return "ملاحظة"
        case "correction": return "تصحيح"
        default: return event.eventType ?? "حدث"
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "active": return "عاملة"
        case "reserve": return "احتياط"
        case "breakdown": return "متعطلة"
        case "out_of_service": return "خارج الخدمة"
        default: return status
        }
    }

    private func statusTone(_ status: String) -> EMSTheme.StatusTone {
        switch status {
        case "active": return .normal
        case "reserve": return .action
        case "breakdown": return .monitor
        case "out_of_service": return .danger
        default: return .neutral
        }
    }
}

@MainActor
final class VehicleHistoryViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var data: VehicleHistoryDTO?

    private let api = APIClient.shared

    func load(vehicleId: String, showLoading: Bool = false) async {
        if showLoading || data == nil { state = .loading }
        do {
            data = try await api.get("/api/vehicles/\(vehicleId)/history")
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }
}
