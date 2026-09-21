//
//  AdminUsersView.swift
//  EMSOperations
//
//  المستخدمون والأدوار (§20): قائمة الحسابات (admin) + تغيير الدور +
//  إنشاء حساب موظف (admin.users_manage). قيود الخادم معروضة كما هي:
//  عقد الهوية (username = الكود الوظيفي)، حاجز التعديل الذاتي، وكلمة
//  المرور الأولية = الكود الوظيفي (قرار المالك 2026-09-20 — للحسابات
//  الجديدة فقط، ويغيّرها الموظف بنفسه من «حسابي» بعد أول دخول).
//

import SwiftUI

struct AdminUsersView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = AdminUsersViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var showCreate = false
    @State private var tempPassword: String?

    // إنشاء حساب
    @State private var cCode = ""
    @State private var cName = ""
    @State private var cRole = "viewer"

    private var canManage: Bool { session.permissions.canManageUsers }

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
        .emsPage("المستخدمون")
        .task { await vm.load() }
        .sheet(isPresented: $showCreate) { createSheet }
        .alert("تم إنشاء الحساب", isPresented: Binding(get: { tempPassword != nil }, set: { if !$0 { tempPassword = nil } })) {
            Button("تم", role: .cancel) {}
        } message: {
            Text("كلمة المرور الأولية = كود الموظف (\(tempPassword ?? "")) — يدخل بها الموظف أول مرة، ثم يغيّرها بنفسه من تبويب «حسابي».")
        }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if canManage {
                    EMSPrimaryButton(title: "إنشاء حساب موظف", isLoading: working) {
                        showCreate = true
                    }
                }
                ForEach(vm.users, id: \.stableId) { user in userCard(user) }
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
    private func userCard(_ user: AdminUserDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(user.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    EMSStatusPill(text: AdminRoles.label(user.role ?? "—"),
                                  tone: (user.isActive ?? true) ? .action : .neutral)
                }
                if let username = user.username {
                    EMSInfoRow(label: "اسم المستخدم", value: username)
                }
                if canManage {
                    Divider().overlay(EMSTheme.Colors.divider)
                    Menu {
                        ForEach(AdminRoles.all, id: \.self) { role in
                            Button(AdminRoles.label(role)) {
                                confirm = ConfirmRequest(title: "تغيير الدور",
                                    message: "تغيير دور «\(user.displayName)» إلى \(AdminRoles.label(role)) — تُبطل جلساته فورًا.",
                                    destructive: false) {
                                    let res = try await vm.changeRole(userId: user.stableId, role: role)
                                    return res.message ?? "تم تغيير الدور إلى \(res.roleLabel ?? AdminRoles.label(role)) · أُبطلت \(res.sessionsRevoked ?? 0) جلسة"
                                }
                            }
                        }
                    } label: {
                        Label("تغيير الدور", systemImage: "person.badge.key")
                            .font(.caption.weight(.semibold))
                    }
                    .tint(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private var createSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 10) {
                            EMSectionHeader(title: "حساب موظف جديد", systemImage: "person.badge.plus")
                            Text("عقد الهوية: اسم المستخدم يساوي الكود الوظيفي، ويجب أن يكون ملف الموظف موجودًا ونشطًا. كلمة المرور تُولَّد خادميًا.")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                            TextField("الكود الوظيفي (= اسم المستخدم)", text: $cCode)
                                .textFieldStyle(.roundedBorder)
                                .emsNumericInput()
                            TextField("الاسم", text: $cName)
                                .textFieldStyle(.roundedBorder)
                            Picker("الدور", selection: $cRole) {
                                ForEach(AdminRoles.all, id: \.self) { Text(AdminRoles.label($0)).tag($0) }
                            }
                            .pickerStyle(.menu)
                            EMSPrimaryButton(title: "إنشاء الحساب", isLoading: working,
                                             isDisabled: cCode.trimmingCharacters(in: .whitespaces).isEmpty
                                                || cName.trimmingCharacters(in: .whitespaces).isEmpty) {
                                execute {
                                    let res = try await vm.createUser(code: cCode, name: cName, role: cRole)
                                    await MainActor.run {
                                        tempPassword = res.tempPassword
                                        showCreate = false
                                        cCode = ""; cName = ""; cRole = "viewer"
                                    }
                                    return nil
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
            .emsPage("إنشاء حساب")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { showCreate = false }.tint(EMSTheme.Colors.teal)
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
final class AdminUsersViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var users: [AdminUserDTO] = []

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            let res: AdminUsersResponseDTO = try await api.get("/api/users")
            users = res.users ?? []
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func changeRole(userId: String, role: String) async throws -> RoleChangeResponseDTO {
        let res: RoleChangeResponseDTO = try await api.post("/api/users/\(userId)/role",
                                                            body: RoleChangeRequestDTO(role: role))
        if res.success == false { throw APIError.server("فشل في تغيير الدور") }
        await reload()
        return res
    }

    func createUser(code: String, name: String, role: String) async throws -> CreateUserResponseDTO {
        let res: CreateUserResponseDTO = try await api.post("/api/users",
            body: CreateUserRequestDTO(username: code.trimmingCharacters(in: .whitespaces),
                                       name: name.trimmingCharacters(in: .whitespaces),
                                       role: role, employeeCode: code.trimmingCharacters(in: .whitespaces)))
        if res.success == false { throw APIError.server("فشل في إنشاء الحساب") }
        await reload()
        return res
    }
}
