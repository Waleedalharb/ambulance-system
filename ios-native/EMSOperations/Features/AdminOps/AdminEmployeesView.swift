//
//  AdminEmployeesView.swift
//  EMSOperations
//
//  إدارة الموظفين (§20): قائمة/بحث + إضافة/تعديل (admin) + توثيق/إلغاء
//  توثيق الجوال (admin — بتأكيد مسؤولية صريح) + تحديث الجوال والنمط
//  والنقل (admin/director). الحقول المعروضة تتبع أعمدة الخادم
//  (employeeColumnsFor) — عمود الجوال لا يصل أصلًا لمن لا يملك صلاحيته.
//

import SwiftUI

struct AdminEmployeesView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = AdminEmployeesViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var editTarget: AdminEmployeeDTO?
    @State private var actionSheet: AdminEmployeeDTO?

    // نموذج إضافة/تعديل
    @State private var fCode = ""
    @State private var fName = ""
    @State private var fTitle = ""
    @State private var fSymbol = ""

    // إجراءات admin/director
    @State private var fPhone = ""
    @State private var fPattern = ""
    @State private var fTransferTeamId = ""
    @State private var fTransferScope = "day"
    @State private var fTransferDate = ""

    private var isAdmin: Bool { session.permissions.isAdmin }
    private var isDirectorPlus: Bool { session.permissions.isAdminOrDirector }

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
        .emsPage("الموظفون")
        .task { await vm.load() }
        .sheet(item: $editTarget) { emp in editSheet(emp) }
        .sheet(item: $actionSheet) { emp in actionsSheet(emp) }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
    }

    // MARK: - المحتوى

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                EMSCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            TextField("بحث بالاسم أو الكود الوظيفي…", text: $vm.query)
                                .textFieldStyle(.roundedBorder)
                                .font(.subheadline)
                            Button { Task { await vm.search() } } label: {
                                Image(systemName: "magnifyingglass")
                                    .frame(width: 40, height: 32)
                                    .background(EMSTheme.Colors.teal)
                                    .foregroundStyle(.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        if vm.isSearching {
                            Button("عرض الكل") { vm.clearSearch() }
                                .font(.caption.weight(.semibold))
                                .tint(EMSTheme.Colors.teal)
                        }
                    }
                }

                if isAdmin {
                    EMSPrimaryButton(title: "إضافة موظف", isLoading: working) {
                        fCode = ""; fName = ""; fTitle = ""; fSymbol = ""
                        editTarget = AdminEmployeeDTO(id: nil, employeeCode: nil, name: nil, jobTitle: nil,
                                                      symbol: nil, isActive: nil, patternCode: nil, createdAt: nil,
                                                      phone: nil, phoneVerified: nil, phoneVerifiedAt: nil,
                                                      phoneVerifiedBy: nil)
                    }
                }

                if vm.employees.isEmpty {
                    EMSEmptyView(icon: "person.2", title: "لا نتائج",
                                 detail: vm.isSearching ? "لا نتائج مطابقة للبحث." : "لا يوجد موظفون.")
                } else {
                    ForEach(vm.employees, id: \.stableId) { emp in employeeCard(emp) }
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

    @ViewBuilder
    private func employeeCard(_ emp: AdminEmployeeDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(emp.name ?? "—")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if !emp.active {
                        EMSStatusPill(text: "غير نشط", tone: .neutral)
                    }
                }
                if let code = emp.employeeCode { EMSInfoRow(label: "الكود الوظيفي", value: code) }
                if let title = emp.jobTitle, !title.isEmpty { EMSInfoRow(label: "المسمى", value: title) }
                if let symbol = emp.symbol, !symbol.isEmpty { EMSInfoRow(label: "الرمز", value: symbol) }
                if let pattern = emp.patternCode, !pattern.isEmpty { EMSInfoRow(label: "النمط", value: pattern) }
                if let phone = emp.phone, !phone.isEmpty {
                    EMSInfoRow(label: "الجوال",
                               value: emp.verified ? "\(phone) ✓" : phone,
                               valueColor: emp.verified ? EMSTheme.Colors.emerald : EMSTheme.Colors.textPrimary)
                }
                if isAdmin || isDirectorPlus {
                    Divider().overlay(EMSTheme.Colors.divider)
                    HStack(spacing: 12) {
                        if isAdmin {
                            Button("تعديل") {
                                fCode = emp.employeeCode ?? ""
                                fName = emp.name ?? ""
                                fTitle = emp.jobTitle ?? ""
                                fSymbol = emp.symbol ?? ""
                                editTarget = emp
                            }
                            .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                        }
                        if isDirectorPlus {
                            Button("إجراءات…") { actionSheet = emp }
                                .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                        }
                    }
                }
            }
        }
    }

    // MARK: - إضافة/تعديل (admin)

    private func editSheet(_ emp: AdminEmployeeDTO) -> some View {
        let isNew = emp.id == nil
        return NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: isNew ? "إضافة موظف" : "تعديل موظف",
                                             systemImage: "person.fill.badge.plus")
                            if isNew {
                                TextField("الكود الوظيفي", text: $fCode)
                                    .textFieldStyle(.roundedBorder)
                            }
                            TextField("الاسم", text: $fName).textFieldStyle(.roundedBorder)
                            TextField("المسمى الوظيفي", text: $fTitle).textFieldStyle(.roundedBorder)
                            TextField("الرمز", text: $fSymbol).textFieldStyle(.roundedBorder)
                            EMSPrimaryButton(title: isNew ? "إضافة" : "حفظ", isLoading: working,
                                             isDisabled: fName.trimmingCharacters(in: .whitespaces).isEmpty
                                                || (isNew && fCode.trimmingCharacters(in: .whitespaces).isEmpty)) {
                                execute {
                                    if isNew {
                                        try await vm.create(code: fCode, name: fName, title: fTitle, symbol: fSymbol)
                                        await MainActor.run { editTarget = nil }
                                        return "تمت إضافة الموظف"
                                    } else {
                                        try await vm.update(id: emp.id ?? 0, name: fName, title: fTitle, symbol: fSymbol)
                                        await MainActor.run { editTarget = nil }
                                        return "تم حفظ التعديل"
                                    }
                                }
                            }
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage(isNew ? "إضافة موظف" : "تعديل موظف")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { editTarget = nil }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    // MARK: - إجراءات admin/director (جوال/نمط/نقل/توثيق)

    private func actionsSheet(_ emp: AdminEmployeeDTO) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    // توثيق الجوال — admin فقط وبتأكيد مسؤولية صريح
                    if isAdmin {
                        EMSCard {
                            VStack(alignment: .leading, spacing: 8) {
                                EMSectionHeader(title: "توثيق الجوال", systemImage: "checkmark.shield")
                                if emp.verified {
                                    // نص الموثِّق يُحضَّر محليًا — بلا interpolation متداخل (Swift compile).
                                    let verifiedByText: String = {
                                        guard let by = emp.phoneVerifiedBy, !by.isEmpty else { return "" }
                                        return " بواسطة \(by)"
                                    }()
                                    Text("الجوال موثق\(verifiedByText)")
                                        .font(.caption).foregroundStyle(EMSTheme.Colors.emerald)
                                    Button("إلغاء التوثيق") {
                                        confirm = ConfirmRequest(title: "إلغاء توثيق الجوال",
                                            message: "إلغاء توثيق جوال «\(emp.name ?? "—")»؟ يُسجَّل في التدقيق.",
                                            destructive: true) {
                                            try await vm.unverifyPhone(id: emp.id ?? 0)
                                            await MainActor.run { actionSheet = nil }
                                            return "أُلغي التوثيق"
                                        }
                                    }
                                    .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.danger)
                                } else {
                                    Text("التوثيق شرط لاستعادة كلمة المرور — فعل مسؤول يُسجَّل مع IP والقيمة السابقة.")
                                        .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
                                    Button("توثيق الجوال — أتحمل المسؤولية") {
                                        confirm = ConfirmRequest(title: "توثيق الجوال",
                                            message: "أؤكد أنني تحققت من أن الرقم يعود للموظف، وأتحمل مسؤولية اعتماده.",
                                            destructive: false) {
                                            try await vm.verifyPhone(id: emp.id ?? 0)
                                            await MainActor.run { actionSheet = nil }
                                            return "تم توثيق الجوال"
                                        }
                                    }
                                    .font(.caption.weight(.semibold)).tint(EMSTheme.Colors.teal)
                                }
                            }
                        }
                    }

                    // تحديث الجوال — admin/director
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            EMSectionHeader(title: "تحديث الجوال", systemImage: "phone")
                            TextField("رقم الجوال (أرقام فقط 9-15)", text: $fPhone)
                                .textFieldStyle(.roundedBorder)
                                .keyboardType(.phonePad)
                            EMSPrimaryButton(title: "حفظ الجوال", isLoading: working) {
                                execute {
                                    try await vm.updatePhone(code: emp.employeeCode ?? "", phone: fPhone)
                                    await MainActor.run { actionSheet = nil }
                                    return "تم تحديث الجوال"
                                }
                            }
                        }
                    }

                    // تعيين النمط — admin/director
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            EMSectionHeader(title: "نمط المناوبة", systemImage: "repeat")
                            TextField("كود النمط (فارغ = فك الربط)", text: $fPattern)
                                .textFieldStyle(.roundedBorder)
                            EMSPrimaryButton(title: "حفظ النمط", isLoading: working) {
                                execute {
                                    try await vm.setPattern(code: emp.employeeCode ?? "",
                                                            pattern: fPattern.trimmingCharacters(in: .whitespaces))
                                    await MainActor.run { actionSheet = nil }
                                    return "تم حفظ النمط"
                                }
                            }
                        }
                    }

                    // النقل — admin/director
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            EMSectionHeader(title: "نقل الموظف", systemImage: "arrow.left.arrow.right")
                            TextField("معرّف الفرقة المستهدفة (رقم)", text: $fTransferTeamId)
                                .textFieldStyle(.roundedBorder)
                                .keyboardType(.numberPad)
                            Picker("النطاق", selection: $fTransferScope) {
                                Text("يوم واحد").tag("day")
                                Text("من تاريخ فصاعدًا").tag("from-date")
                            }
                            .pickerStyle(.segmented)
                            TextField("التاريخ (YYYY-MM-DD)", text: $fTransferDate)
                                .textFieldStyle(.roundedBorder)
                            EMSPrimaryButton(title: "تنفيذ النقل", isLoading: working,
                                             isDisabled: Int(fTransferTeamId) == nil || fTransferDate.count != 10) {
                                execute {
                                    try await vm.transfer(code: emp.employeeCode ?? "",
                                                          teamId: Int(fTransferTeamId) ?? 0,
                                                          scope: fTransferScope, date: fTransferDate)
                                    await MainActor.run { actionSheet = nil }
                                    return "تم تنفيذ النقل"
                                }
                            }
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage("إجراءات — \(emp.name ?? "")")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { actionSheet = nil }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private func execute(_ work: @escaping () async throws -> String?) {
        working = true
        infoMessage = nil
        errorMessage = nil
        Task {
            do { infoMessage = try await work() }
            catch let e as APIError { errorMessage = e.userMessage }
            catch { errorMessage = APIError.unknown.userMessage }
            working = false
        }
    }
}

// MARK: - ViewModel

@MainActor
final class AdminEmployeesViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var employees: [AdminEmployeeDTO] = []
    @Published private(set) var isSearching = false
    @Published var query = ""

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            let res: AdminEmployeesResponseDTO = try await api.get("/api/employees")
            employees = res.employees ?? []
            isSearching = false
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    /// بحث سيرفري (server.js:11163 — LIKE على الاسم/الكود، نشطون فقط، حد 15).
    func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { await reload(); return }
        do {
            let res: AdminEmployeeSearchDTO = try await api.get("/api/employees/search", query: ["q": q])
            employees = res.results ?? []
            isSearching = true
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func clearSearch() {
        query = ""
        Task { await reload() }
    }

    // MARK: - الكتابة (الحسم سيرفري)

    func create(code: String, name: String, title: String, symbol: String) async throws {
        let body = CreateEmployeeRequestDTO(
            employeeCode: code.trimmingCharacters(in: .whitespaces),
            name: name.trimmingCharacters(in: .whitespaces),
            jobTitle: title.isEmpty ? nil : title,
            symbol: symbol.isEmpty ? nil : symbol)
        let res: AdminActionResponseDTO = try await api.post("/api/employees", body: body)
        if res.success == false { throw APIError.server(res.error ?? "فشل في إضافة الموظف") }
        await reload()
    }

    func update(id: Int, name: String, title: String, symbol: String) async throws {
        let body = UpdateEmployeeRequestDTO(name: name.trimmingCharacters(in: .whitespaces),
                                            jobTitle: title.isEmpty ? nil : title,
                                            symbol: symbol.isEmpty ? nil : symbol)
        let res: AdminActionResponseDTO = try await api.put("/api/employees/\(id)", body: body)
        if res.success == false { throw APIError.server(res.error ?? "فشل في تحديث الموظف") }
        await reload()
    }

    func verifyPhone(id: Int) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/employees/\(id)/verify-phone",
                                                             body: VerifyPhoneRequestDTO(confirmResponsibility: true))
        if res.success == false { throw APIError.server(res.error ?? "فشل في توثيق الجوال") }
        await reload()
    }

    func unverifyPhone(id: Int) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/employees/\(id)/unverify-phone")
        if res.success == false { throw APIError.server(res.error ?? "فشل في إلغاء التوثيق") }
        await reload()
    }

    func updatePhone(code: String, phone: String) async throws {
        let res: AdminActionResponseDTO = try await api.put("/api/employees/\(code)/phone",
                                                            body: UpdatePhoneRequestDTO(phone: phone))
        if res.success == false { throw APIError.server(res.error ?? "فشل في تحديث الجوال") }
        await reload()
    }

    func setPattern(code: String, pattern: String) async throws {
        let res: AdminActionResponseDTO = try await api.put("/api/employees/\(code)/pattern",
                                                            body: SetPatternRequestDTO(patternCode: pattern.isEmpty ? nil : pattern))
        if res.success == false { throw APIError.server(res.error ?? "فشل في تعيين النمط") }
        await reload()
    }

    func transfer(code: String, teamId: Int, scope: String, date: String) async throws {
        let res: AdminActionResponseDTO = try await api.post("/api/employees/\(code)/transfer",
            body: TransferEmployeeRequestDTO(teamId: teamId, scope: scope, date: date))
        if res.success == false { throw APIError.server(res.error ?? "فشل في نقل الموظف") }
        await reload()
    }
}
