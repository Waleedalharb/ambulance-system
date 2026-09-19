//
//  MyRequestsView.swift
//  EMSOperations
//
//  طلباتي والإعلانات (§23/§24/§25 — جانب الموظف):
//  الإعلانات (قراءة للجميع) · طلبات إجازتي (تقديم/قائمة/إلغاء قيد المراجعة)
//  · طلب تغيير مناوبة (تقديم فقط — القائمة مقيدة سيرفريًا بـadmin/director)
//  · الإجازات المجدولة للتحكم والتنسيق (قراءة).
//  لا منطق أعمال هنا — الاعتماد والحد الأقصى والتداخل كلها على الخادم،
//  وأخطاء الخادم تُعرض بلفظها.
//

import SwiftUI

struct MyRequestsView: View {
    @StateObject private var vm = MyRequestsViewModel()
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(isAdminDirector: session.permissions.isAdminOrDirector) } }
                case .loaded:
                    announcementsSection
                    leaveSection
                    shiftChangeSection
                    if vm.canViewVacations { vacationsSection }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("طلباتي والإعلانات")
        .task { await vm.load(isAdminDirector: session.permissions.isAdminOrDirector) }
        .refreshable { await vm.load(isAdminDirector: session.permissions.isAdminOrDirector) }
        .alert("تم", isPresented: $vm.showSuccess) {
            Button("حسنًا", role: .cancel) {}
        } message: {
            Text(vm.successMessage)
        }
    }

    // MARK: - الإعلانات (قراءة)
    private var announcementsSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "الإعلانات", systemImage: "megaphone.fill")
            if vm.announcements.isEmpty {
                EMSEmptyView(icon: "megaphone", title: "لا توجد إعلانات حاليًا")
            } else {
                ForEach(vm.announcements) { a in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                if a.pinned == true {
                                    Image(systemName: "pin.fill")
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                }
                                Text(a.title ?? "إعلان")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                if a.urgent == true {
                                    EMSStatusPill(text: "عاجل", tone: .danger)
                                }
                            }
                            if let body = a.body, !body.isEmpty {
                                Text(body)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if let date = a.date, !date.isEmpty {
                                Text(date)
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // MARK: - طلبات الإجازة
    private var leaveSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "طلبات إجازتي", systemImage: "calendar.badge.clock")

            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("تقديم طلب إجازة")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    Text("الاعتماد والحد الأقصى للإجازات المتزامنة يُحسمان على الخادم — يظهر رفض الخادم بلفظه.")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Picker("نوع الإجازة", selection: $vm.leaveType) {
                        ForEach(MyRequestsViewModel.leaveTypes, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    DatePicker("من", selection: $vm.leaveStartDate, displayedComponents: .date)
                        .foregroundStyle(.white)
                    DatePicker("إلى", selection: $vm.leaveEndDate, in: vm.leaveStartDate..., displayedComponents: .date)
                        .foregroundStyle(.white)
                    TextField("السبب (اختياري)", text: $vm.leaveReason)
                        .textFieldStyle(.roundedBorder)
                    EMSPrimaryButton(
                        title: "إرسال طلب الإجازة",
                        isLoading: vm.submittingLeave,
                        isDisabled: !vm.canSubmitLeave
                    ) { Task { await vm.submitLeave() } }
                }
            }

            if vm.myLeaveRequests.isEmpty {
                EMSEmptyView(icon: "calendar", title: "لا توجد طلبات إجازة مسجلة")
            } else {
                ForEach(vm.myLeaveRequests) { req in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(req.type ?? "إجازة")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(text: req.statusLabel, tone: req.statusTone)
                            }
                            EMSInfoRow(label: "الفترة", value: "\(req.startDate ?? "—") → \(req.endDate ?? "—")")
                            if let reason = req.reason, !reason.isEmpty {
                                EMSInfoRow(label: "السبب", value: reason)
                            }
                            if req.isPending {
                                Button(role: .destructive) {
                                    Task { await vm.deleteLeave(req) }
                                } label: {
                                    Label("إلغاء الطلب", systemImage: "trash")
                                        .font(.caption.weight(.semibold))
                                }
                                .disabled(vm.deletingLeaveId == req.id)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    // MARK: - طلب تغيير المناوبة (تقديم فقط للموظف)
    private var shiftChangeSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "طلب تغيير مناوبة", systemImage: "arrow.triangle.2.circlepath")
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("يُرسل الطلب للإدارة للمراجعة — نتيجته تظهر في «تغييرات جدولي» بعد الاعتماد.")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    TextField("تاريخ المناوبة (yyyy-MM-dd)", text: $vm.scDate)
                        .textFieldStyle(.roundedBorder)
                    HStack(spacing: 8) {
                        TextField("الرمز الحالي", text: $vm.scOldCode)
                            .textFieldStyle(.roundedBorder)
                        TextField("الرمز المقترح", text: $vm.scProposedCode)
                            .textFieldStyle(.roundedBorder)
                    }
                    TextField("السبب (اختياري)", text: $vm.scReason)
                        .textFieldStyle(.roundedBorder)
                    EMSPrimaryButton(
                        title: "إرسال طلب التغيير",
                        isLoading: vm.submittingShiftChange,
                        isDisabled: !vm.canSubmitShiftChange
                    ) { Task { await vm.submitShiftChange() } }
                }
            }
        }
    }

    // MARK: - الإجازات المجدولة (قراءة)
    private var vacationsSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "إجازات التحكم والتنسيق المجدولة", systemImage: "calendar.badge.checkmark")
            if vm.vacations.isEmpty {
                EMSEmptyView(icon: "calendar", title: "لا توجد إجازات مجدولة")
            } else {
                EMSCard {
                    VStack(spacing: 0) {
                        ForEach(vm.vacations) { v in
                            VStack(spacing: 4) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(v.name ?? "—")
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(.white)
                                        Text([v.role, v.code.map { "كود: \($0)" }].compactMap { $0 }.joined(separator: " · "))
                                            .font(.caption2)
                                            .foregroundStyle(EMSTheme.Colors.textMuted)
                                    }
                                    Spacer()
                                    Text(v.hasVacation ? "\(v.vacationStart ?? "") → \(v.vacationEnd ?? "")" : "لا توجد إجازة")
                                        .font(.caption)
                                        .foregroundStyle(v.hasVacation ? EMSTheme.Colors.warning : EMSTheme.Colors.textMuted)
                                }
                                .padding(.vertical, 8)
                                if v.id != vm.vacations.last?.id {
                                    Divider().overlay(EMSTheme.Colors.divider)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - ViewModel
@MainActor
final class MyRequestsViewModel: ObservableObject {
    enum LoadState { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var announcements: [AnnouncementDTO] = []
    @Published var myLeaveRequests: [LeaveRequestDTO] = []
    @Published var vacations: [VacationEntryDTO] = []
    /// إجازات التحكم والتنسيق تخص طاقم العمليات — لا تُجلب أصلًا للموظف الميداني
    /// (عزل المصدر: الويب يعرضها في لوحة العمليات فقط، وبوابة الموظف لا تعرضها).
    @Published var canViewVacations = false

    /// من تُعرض لهم إجازات التحكم والتنسيق: طاقم العمليات نفسه + القيادة الميدانية.
    private static let vacationsViewerTitles: Set<String> = [
        "تحكم عملياتي", "تنسيق الاستجابة", "كبير مسعفين", "مساعد كبير المسعفين"
    ]

    // نماذج الإدخال
    /// الأنواع المقبولة سيرفريًا حصرًا — CHECK constraint في leave_requests
    /// (type IN ('إجازة','مرضية','استثنائية')) — نص حر = رفض 500.
    static let leaveTypes = ["إجازة", "مرضية", "استثنائية"]
    @Published var leaveType = "إجازة"
    @Published var leaveStartDate = Date()
    @Published var leaveEndDate = Date()
    @Published var leaveReason = ""
    @Published var scDate = ""
    @Published var scOldCode = ""
    @Published var scProposedCode = ""
    @Published var scReason = ""

    /// صيغة التاريخ للعقد السيرفري (yyyy-MM-dd ميلادية أرقام لاتينية — POSIX إجباري).
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    @Published var submittingLeave = false
    @Published var submittingShiftChange = false
    @Published var deletingLeaveId: Int? = nil
    @Published var showSuccess = false
    @Published var successMessage = ""

    private let api = APIClient.shared
    private var myEmployeeId: Int?
    private var isAdminDirector = false

    var canSubmitLeave: Bool {
        Self.leaveTypes.contains(leaveType)
            && Calendar.current.compare(leaveEndDate, to: leaveStartDate, toGranularity: .day) != .orderedAscending
    }
    var canSubmitShiftChange: Bool {
        !scDate.trimmingCharacters(in: .whitespaces).isEmpty
            && !scProposedCode.trimmingCharacters(in: .whitespaces).isEmpty
    }

    func load(isAdminDirector: Bool = false) async {
        // يُحفظ لإعادات التحميل الداخلية بعد الإرسال/الإلغاء
        if isAdminDirector { self.isAdminDirector = true }
        state = .loading
        do {
            // معرف الموظف من ملفي — المصدر الوحيد لربط الطلبات بصاحبها.
            let profile: ProfileDTO = try await api.get("/api/my/profile")
            myEmployeeId = profile.employee.id
            canViewVacations = self.isAdminDirector
                || Self.vacationsViewerTitles.contains(profile.employee.jobTitle ?? "")

            async let annReq: AnnouncementsResponseDTO = api.get("/api/announcements")
            let ann = try await annReq
            announcements = ann.data ?? []

            // العزل من المصدر: الموظف الميداني لا يجلب إجازات العمليات إطلاقًا
            if canViewVacations {
                vacations = (try? await api.get("/api/vacations")) ?? []
            } else {
                vacations = []
            }

            if let empId = myEmployeeId {
                let lr: LeaveRequestsResponseDTO = try await api.get(
                    "/api/leave-requests", query: ["employee_id": String(empId)])
                myLeaveRequests = lr.requests ?? []
            } else {
                myLeaveRequests = []
            }
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func submitLeave() async {
        guard let empId = myEmployeeId else {
            state = .failed("تعذر تحديد هوية الموظف — أعد تحميل الصفحة")
            return
        }
        submittingLeave = true
        defer { submittingLeave = false }
        do {
            let body = LeaveRequestBody(
                employee_id: empId,
                start_date: Self.isoDay.string(from: leaveStartDate),
                end_date: Self.isoDay.string(from: leaveEndDate),
                type: leaveType,
                reason: leaveReason.trimmingCharacters(in: .whitespaces).isEmpty ? nil : leaveReason)
            let res: BasicSuccessDTO = try await api.post("/api/leave-requests", body: body)
            if res.success == false { throw APIError.server("فشل تقديم الطلب") }
            leaveType = "إجازة"; leaveStartDate = Date(); leaveEndDate = Date(); leaveReason = ""
            successMessage = "تم إرسال طلب الإجازة — بانتظار اعتماد الإدارة"
            showSuccess = true
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func deleteLeave(_ req: LeaveRequestDTO) async {
        deletingLeaveId = req.id
        defer { deletingLeaveId = nil }
        do {
            let res: BasicSuccessDTO = try await api.delete("/api/leave-requests/\(req.id)")
            if res.success == false { throw APIError.server("فشل إلغاء الطلب") }
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func submitShiftChange() async {
        guard let empId = myEmployeeId else {
            state = .failed("تعذر تحديد هوية الموظف — أعد تحميل الصفحة")
            return
        }
        submittingShiftChange = true
        defer { submittingShiftChange = false }
        do {
            let body = ShiftChangeRequestBody(
                employee_id: empId,
                shift_date: scDate.trimmingCharacters(in: .whitespaces),
                proposed_shift_code: scProposedCode.trimmingCharacters(in: .whitespaces),
                old_shift_code: scOldCode.trimmingCharacters(in: .whitespaces).isEmpty ? nil : scOldCode,
                team_id: nil,
                reason: scReason.trimmingCharacters(in: .whitespaces).isEmpty ? nil : scReason)
            let res: BasicSuccessDTO = try await api.post("/api/shift-change-request", body: body)
            if res.success == false { throw APIError.server("فشل إرسال الطلب") }
            scDate = ""; scOldCode = ""; scProposedCode = ""; scReason = ""
            successMessage = "تم إرسال طلب تغيير المناوبة للإدارة"
            showSuccess = true
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
