//
//  RequestsAdminView.swift
//  EMSOperations
//
//  مراجعة الطلبات والإعلانات (§23/§24/§25 — جانب الإدارة admin/director):
//  اعتماد/رفض طلبات الإجازة · مراجعة طلبات تغيير المناوبة (قبول/رفض/إلغاء)
//  · إدارة الإعلانات (إضافة/حذف — admin فقط سيرفريًا).
//  الحسم النهائي على الخادم؛ أخطاء الخادم تُعرض بلفظها.
//

import SwiftUI

struct RequestsAdminView: View {
    @StateObject private var vm = RequestsAdminViewModel()
    @EnvironmentObject private var session: SessionStore
    @State private var showAddAnnouncement = false

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    leaveSection
                    shiftChangeSection
                    announcementsSection
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("مراجعة الطلبات")
        .task { await vm.load() }
        .refreshable { await vm.load() }
        .sheet(isPresented: $showAddAnnouncement) {
            AnnouncementAddSheet(vm: vm)
        }
    }

    // MARK: - طلبات الإجازة
    private var leaveSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "طلبات الإجازة", systemImage: "calendar.badge.clock")
            if vm.leaveRequests.isEmpty {
                EMSEmptyView(icon: "calendar", title: "لا توجد طلبات إجازة")
            } else {
                ForEach(vm.leaveRequests) { req in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(req.employeeName ?? "موظف #\(req.employeeId ?? 0)")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(text: req.statusLabel, tone: req.statusTone)
                            }
                            EMSInfoRow(label: "النوع", value: req.type ?? "إجازة")
                            EMSInfoRow(label: "الفترة", value: "\(req.startDate ?? "—") → \(req.endDate ?? "—")")
                            if let reason = req.reason, !reason.isEmpty {
                                EMSInfoRow(label: "السبب", value: reason)
                            }
                            if req.isPending {
                                HStack(spacing: 10) {
                                    Button {
                                        Task { await vm.reviewLeave(req, status: "approved") }
                                    } label: {
                                        Label("اعتماد", systemImage: "checkmark.circle.fill")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(EMSTheme.Colors.emerald)
                                    }
                                    Button {
                                        Task { await vm.reviewLeave(req, status: "denied") }
                                    } label: {
                                        Label("رفض", systemImage: "xmark.circle.fill")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(EMSTheme.Colors.danger)
                                    }
                                    Spacer()
                                }
                                .disabled(vm.reviewingId != nil)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // MARK: - طلبات تغيير المناوبة
    private var shiftChangeSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "طلبات تغيير المناوبة", systemImage: "arrow.triangle.2.circlepath")
            if vm.shiftChangeRequests.isEmpty {
                EMSEmptyView(icon: "arrow.triangle.2.circlepath", title: "لا توجد طلبات تغيير")
            } else {
                ForEach(vm.shiftChangeRequests) { req in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(req.requestedByName ?? req.requestedBy ?? "—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(text: req.statusLabel, tone: req.statusTone)
                            }
                            EMSInfoRow(label: "التاريخ", value: req.shiftDate ?? "—")
                            EMSInfoRow(label: "التغيير", value: "\(req.oldShiftCode ?? "—") → \(req.proposedShiftCode ?? "—")")
                            if let reason = req.reason, !reason.isEmpty {
                                EMSInfoRow(label: "السبب", value: reason)
                            }
                            if req.isPending {
                                HStack(spacing: 10) {
                                    Button {
                                        Task { await vm.reviewShiftChange(req, status: "approved") }
                                    } label: {
                                        Label("قبول", systemImage: "checkmark.circle.fill")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(EMSTheme.Colors.emerald)
                                    }
                                    Button {
                                        Task { await vm.reviewShiftChange(req, status: "denied") }
                                    } label: {
                                        Label("رفض", systemImage: "xmark.circle.fill")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(EMSTheme.Colors.danger)
                                    }
                                    Spacer()
                                }
                                .disabled(vm.reviewingId != nil)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // MARK: - الإعلانات (إضافة/حذف — admin فقط)
    private var announcementsSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "الإعلانات", systemImage: "megaphone.fill")
            if session.permissions.isAdmin {
                EMSPrimaryButton(title: "إضافة إعلان جديد") { showAddAnnouncement = true }
            }
            if vm.announcements.isEmpty {
                EMSEmptyView(icon: "megaphone", title: "لا توجد إعلانات")
            } else {
                ForEach(vm.announcements) { a in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                Text(a.title ?? "إعلان")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                if a.urgent == true {
                                    EMSStatusPill(text: "عاجل", tone: .danger)
                                }
                                if a.pinned == true {
                                    EMSStatusPill(text: "مثبت", tone: .action)
                                }
                            }
                            if let body = a.body, !body.isEmpty {
                                Text(body)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            HStack {
                                Text(a.date ?? "")
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                Spacer()
                                if session.permissions.isAdmin {
                                    Button(role: .destructive) {
                                        Task { await vm.deleteAnnouncement(a) }
                                    } label: {
                                        Label("حذف", systemImage: "trash")
                                            .font(.caption.weight(.semibold))
                                    }
                                    .disabled(vm.deletingAnnouncementId == a.id)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

// MARK: - ورقة إضافة إعلان
private struct AnnouncementAddSheet: View {
    @ObservedObject var vm: RequestsAdminViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var body_ = ""
    @State private var pinned = false
    @State private var urgent = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("عنوان الإعلان", text: $title)
                TextField("نص الإعلان", text: $body_, axis: .vertical)
                    .lineLimit(3...8)
                Toggle("مثبت", isOn: $pinned)
                Toggle("عاجل", isOn: $urgent)
            }
            .navigationTitle("إعلان جديد")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("إلغاء") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("نشر") {
                        Task {
                            let ok = await vm.addAnnouncement(
                                title: title, body: body_, pinned: pinned, urgent: urgent)
                            if ok { dismiss() }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty
                              || body_.trimmingCharacters(in: .whitespaces).isEmpty
                              || vm.submittingAnnouncement)
                }
            }
        }
    }
}

// MARK: - ViewModel
@MainActor
final class RequestsAdminViewModel: ObservableObject {
    enum LoadState { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var leaveRequests: [LeaveRequestDTO] = []
    @Published var shiftChangeRequests: [ShiftChangeRequestDTO] = []
    @Published var announcements: [AnnouncementDTO] = []
    @Published var reviewingId: Int? = nil
    @Published var deletingAnnouncementId: String? = nil
    @Published var submittingAnnouncement = false

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            // المعلَّقة أولًا — الأولوية التشغيلية لما ينتظر قرار الإدارة.
            async let pendingLeave: LeaveRequestsResponseDTO = api.get(
                "/api/leave-requests", query: ["status": "pending"])
            async let allLeave: LeaveRequestsResponseDTO = api.get("/api/leave-requests")
            async let scReq: ShiftChangeListResponseDTO = api.get("/api/shift-change-request")
            async let annReq: AnnouncementsResponseDTO = api.get("/api/announcements")

            let pending = try await pendingLeave
            let all = try await allLeave
            let pendingIds = Set((pending.requests ?? []).map { $0.id })
            // المعلَّقة أولًا ثم الباقي — ترتيب عرض فقط، لا حالة محسوبة.
            leaveRequests = (pending.requests ?? []) + (all.requests ?? []).filter { !pendingIds.contains($0.id) }

            shiftChangeRequests = (try await scReq).requests ?? []
            announcements = (try await annReq).data ?? []
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func reviewLeave(_ req: LeaveRequestDTO, status: String) async {
        reviewingId = req.id
        defer { reviewingId = nil }
        do {
            let _: BasicSuccessDTO = try await api.post(
                "/api/leave-requests/\(req.id)/approve", body: LeaveApproveBody(status: status))
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func reviewShiftChange(_ req: ShiftChangeRequestDTO, status: String) async {
        reviewingId = req.id
        defer { reviewingId = nil }
        do {
            let _: BasicSuccessDTO = try await api.post(
                "/api/shift-change-request/\(req.id)/review", body: ShiftChangeReviewBody(status: status))
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func addAnnouncement(title: String, body: String, pinned: Bool, urgent: Bool) async -> Bool {
        submittingAnnouncement = true
        defer { submittingAnnouncement = false }
        do {
            let _: BasicSuccessDTO = try await api.post(
                "/api/announcements/add",
                body: AnnouncementAddBody(
                    title: title.trimmingCharacters(in: .whitespaces),
                    body: body.trimmingCharacters(in: .whitespaces),
                    pinned: pinned, urgent: urgent))
            await load()
            return true
        } catch let e as APIError {
            state = .failed(e.userMessage)
            return false
        } catch {
            state = .failed(APIError.unknown.userMessage)
            return false
        }
    }

    func deleteAnnouncement(_ a: AnnouncementDTO) async {
        deletingAnnouncementId = a.id
        defer { deletingAnnouncementId = nil }
        do {
            let _: BasicSuccessDTO = try await api.delete("/api/announcements/\(a.id)")
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
