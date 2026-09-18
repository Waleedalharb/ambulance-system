//
//  AdminPermissionsView.swift
//  EMSOperations
//
//  إدارة الصلاحيات الفردية (§2): قائمة المستخدمين وعدّادات استثناءاتهم
//  (GET /api/permissions/users) ← تفاصيل مستخدم (user/:id) ← منح/سحب/إعادة
//  (grant/revoke/clear). كلها admin.users_manage سيرفريًا، ومنع تعديل
//  الحساب الذاتي يُفرض على الخادم (SELF_MODIFY_DENIED) — يظهر بلفظه.
//

import SwiftUI

struct AdminPermissionsView: View {
    @StateObject private var vm = AdminPermissionsViewModel()

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
                    EMSCard {
                        HStack(spacing: 12) {
                            Image(systemName: "person.badge.key.fill")
                                .font(.title2)
                                .foregroundStyle(EMSTheme.Colors.teal)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("الصلاحيات الفردية")
                                    .font(.headline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Text("منح/سحب فوق الدور الافتراضي — الحسم النهائي على الخادم")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            Spacer()
                        }
                    }
                    ForEach(vm.users) { u in
                        NavigationLink(value: u.id) {
                            EMSCard {
                                HStack(spacing: 12) {
                                    Image(systemName: "person.fill")
                                        .font(.title3)
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                        .frame(width: 28)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(u.name ?? u.username ?? "—")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.white)
                                        Text(u.roleLabel ?? u.role ?? "—")
                                            .font(.caption)
                                            .foregroundStyle(EMSTheme.Colors.textMuted)
                                    }
                                    Spacer()
                                    let g = u.overrides?.grants ?? 0
                                    let r = u.overrides?.revokes ?? 0
                                    if g > 0 { EMSStatusPill(text: "+\(g)", tone: .normal) }
                                    if r > 0 { EMSStatusPill(text: "-\(r)", tone: .danger) }
                                    Image(systemName: "chevron.left")
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("الصلاحيات الفردية")
        .task { await vm.load() }
        .refreshable { await vm.load() }
        .navigationDestination(for: String.self) { userId in
            AdminUserPermissionsDetailView(userId: userId, catalog: vm.catalog)
        }
    }
}

// MARK: - تفاصيل مستخدم: الكتالوج مجمعًا بالنطاق
private struct AdminUserPermissionsDetailView: View {
    let userId: String
    let catalog: [String: PermissionMetaDTO]
    @StateObject private var vm = AdminUserPermissionsViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(userId: userId) } }
                case .loaded:
                    if let d = vm.detail {
                        summaryCard(d)
                        ForEach(vm.groupedDomains, id: \.self) { domain in
                            domainSection(domain, detail: d)
                        }
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage(vm.detail?.user?.name ?? "صلاحيات المستخدم")
        .task { await vm.load(userId: userId) }
        .alert("خطأ", isPresented: $vm.showError) {
            Button("حسنًا", role: .cancel) {}
        } message: {
            Text(vm.actionError)
        }
    }

    private func summaryCard(_ d: PermUserDetailDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 6) {
                EMSInfoRow(label: "الدور", value: d.roleLabel ?? d.role ?? "—")
                if d.permissionsStar == true {
                    EMSInfoRow(label: "النطاق", value: "صلاحية شاملة (*) — لا حاجة لمنح فردي")
                } else {
                    EMSInfoRow(label: "الفعلية", value: "\(d.permissions?.count ?? 0) مفتاحًا")
                    EMSInfoRow(label: "منح فردية", value: "\(d.permissionsGranted?.count ?? 0)")
                    EMSInfoRow(label: "سحوبات فردية", value: "\(d.permissionsRevoked?.count ?? 0)")
                }
            }
        }
    }

    private func domainSection(_ domain: String, detail d: PermUserDetailDTO) -> some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: domain, systemImage: "folder.fill")
            EMSCard {
                VStack(spacing: 0) {
                    ForEach(vm.keys(for: domain), id: \.self) { key in
                        permissionRow(key, detail: d)
                        if key != vm.keys(for: domain).last {
                            Divider().overlay(EMSTheme.Colors.divider)
                        }
                    }
                }
            }
        }
    }

    private func permissionRow(_ key: String, detail d: PermUserDetailDTO) -> some View {
        let granted = d.permissionsGranted?.contains(key) == true
        let revoked = d.permissionsRevoked?.contains(key) == true
        let overridden = d.overriddenKeys.contains(key)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(catalog[key]?.label ?? key)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                    Text(key)
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                Spacer()
                if granted { EMSStatusPill(text: "منحة", tone: .normal) }
                if revoked { EMSStatusPill(text: "مسحوبة", tone: .danger) }
            }
            HStack(spacing: 12) {
                if !granted {
                    Button("منح") { Task { await vm.act(userId: userId, key: key, action: .grant) } }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.emerald)
                }
                if !revoked {
                    Button("سحب") { Task { await vm.act(userId: userId, key: key, action: .revoke) } }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.danger)
                }
                if overridden {
                    Button("إعادة للافتراضي") { Task { await vm.act(userId: userId, key: key, action: .clear) } }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
                Spacer()
            }
            .disabled(vm.actingKey != nil)
        }
        .padding(.vertical, 8)
    }
}

// MARK: - ViewModels
@MainActor
final class AdminPermissionsViewModel: ObservableObject {
    enum LoadState { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var users: [PermUserRowDTO] = []
    @Published var catalog: [String: PermissionMetaDTO] = [:]

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            async let usersReq: PermUsersResponseDTO = api.get("/api/permissions/users")
            async let catReq: PermissionsCatalogDTO = api.get("/api/permissions/catalog")
            users = (try await usersReq).users ?? []
            catalog = (try await catReq).permissions ?? [:]
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}

@MainActor
final class AdminUserPermissionsViewModel: ObservableObject {
    enum LoadState { case loading, loaded, failed(String) }
    enum PermAction { case grant, revoke, clear
        var path: String {
            switch self {
            case .grant: return "/api/permissions/grant"
            case .revoke: return "/api/permissions/revoke"
            case .clear: return "/api/permissions/clear"
            }
        }
    }

    @Published var state: LoadState = .loading
    @Published var detail: PermUserDetailDTO? = nil
    @Published var catalog: [String: PermissionMetaDTO] = [:]
    @Published var actingKey: String? = nil
    @Published var showError = false
    @Published var actionError = ""

    private let api = APIClient.shared

    /// نطاقات الكتالوج مرتبة أبجديًا — ترتيب عرض فقط.
    var groupedDomains: [String] {
        Set(catalog.values.compactMap { $0.domain }).sorted()
    }
    func keys(for domain: String) -> [String] {
        catalog.filter { $0.value.domain == domain }.map { $0.key }.sorted()
    }

    func load(userId: String) async {
        state = .loading
        do {
            async let dReq: PermUserDetailDTO = api.get("/api/permissions/user/\(userId)")
            async let catReq: PermissionsCatalogDTO = api.get("/api/permissions/catalog")
            detail = try await dReq
            catalog = (try await catReq).permissions ?? [:]
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func act(userId: String, key: String, action: PermAction) async {
        actingKey = key
        defer { actingKey = nil }
        do {
            let _: BasicSuccessDTO = try await api.post(
                action.path, body: PermActionBody(user_id: userId, permission: key))
            await load(userId: userId)
        } catch let e as APIError {
            // منع التعديل الذاتي ونحوه يصل برسالته السيرفرية كما هي.
            actionError = e.userMessage
            showError = true
        } catch {
            actionError = APIError.unknown.userMessage
            showError = true
        }
    }
}
