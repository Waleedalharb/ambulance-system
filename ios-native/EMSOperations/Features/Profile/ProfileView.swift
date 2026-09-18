//
//  ProfileView.swift
//  EMSOperations
//
//  ملفي (قسم 21): بيانات الموظف + إعدادات الجلسة (Face ID) + تسجيل الخروج.
//  الخروج يمر عبر AuthService → يفصل جهاز Push خادميًا (D8).
//

import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = ProfileViewModel()
    @State private var showLogoutConfirm = false
    @State private var faceIDOn = BiometricGate.isEnabled
    @State private var showChangePassword = false

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if let p = vm.profile { employeeCard(p) }
                    requestsCard
                    if session.permissions.canAccessAdmin { adminCard }
                    securityCard
                    logoutCard
                    versionFooter
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("ملفي")
        .task { await vm.load() }
        .confirmationDialog(
            "تسجيل الخروج",
            isPresented: $showLogoutConfirm,
            titleVisibility: .visible
        ) {
            Button("تسجيل الخروج", role: .destructive) {
                Task { await session.logout() }
            }
            Button("إلغاء", role: .cancel) {}
        } message: {
            Text("سيُفصل هذا الجهاز من الإشعارات وتحتاج اسم المستخدم وكلمة المرور للدخول مجددًا.")
        }
        .sheet(isPresented: $showChangePassword) {
            NavigationStack { ChangePasswordSheet() }
        }
    }

    // MARK: - بطاقة الموظف

    private func employeeCard(_ p: ProfileDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(EMSTheme.Colors.teal.opacity(0.18))
                        Image(systemName: "person.fill")
                            .foregroundStyle(EMSTheme.Colors.teal)
                    }
                    .frame(width: 52, height: 52)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(p.employee.name)
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                        Text(p.employee.jobTitle ?? "—")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textSecondary)
                    }
                    Spacer()
                }
                Divider().overlay(EMSTheme.Colors.divider)
                EMSInfoRow(label: "الرقم الوظيفي", value: p.employee.code ?? "—")
                if let today = p.today {
                    EMSInfoRow(label: "الفرقة الحالية", value: today.teamName ?? "—")
                    EMSInfoRow(label: "المركز", value: today.center ?? "—")
                }
                if let update = p.lastRosterUpdate {
                    EMSInfoRow(label: "آخر تحديث للجدول", value: update)
                }
            }
        }
    }

    // MARK: - طلباتي والإعلانات (§23-§25 — لكل مستخدم موثّق)

    private var requestsCard: some View {
        NavigationLink {
            MyRequestsView()
        } label: {
            EMSCard {
                HStack(spacing: 12) {
                    Image(systemName: "calendar.badge.clock")
                        .font(.title3)
                        .foregroundStyle(EMSTheme.Colors.teal)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("طلباتي والإعلانات")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Text("طلب إجازة · تغيير مناوبة · الإعلانات والإجازات المجدولة")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    Spacer()
                    Image(systemName: "chevron.left")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - الإدارة (§20 — تظهر فقط لحاملي صلاحياتها)

    private var adminCard: some View {
        NavigationLink {
            AdminHubView()
        } label: {
            EMSCard {
                HStack(spacing: 12) {
                    Image(systemName: "shield.lefthalf.filled")
                        .font(.title3)
                        .foregroundStyle(EMSTheme.Colors.teal)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("مركز الإدارة")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Text("المستخدمون · الموظفون · الفرق والرموز · الإعدادات")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    Spacer()
                    Image(systemName: "chevron.left")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - الأمان

    private var securityCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "الأمان", systemImage: "lock.shield")
                if BiometricGate.isAvailable {
                    Toggle(isOn: $faceIDOn) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("فتح التطبيق بـ \(BiometricGate.biometryName)")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.white)
                            Text("يُطلب عند فتح التطبيق بجلسة محفوظة")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                    }
                    .tint(EMSTheme.Colors.teal)
                    .onChange(of: faceIDOn) { newValue in
                        BiometricGate.isEnabled = newValue
                    }
                } else {
                    Text("\(BiometricGate.biometryName) غير متاح على هذا الجهاز")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                Divider().overlay(EMSTheme.Colors.divider)
                Button { showChangePassword = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "key.fill")
                            .foregroundStyle(EMSTheme.Colors.teal)
                        Text("تغيير كلمة المرور")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                        Spacer()
                        Image(systemName: "chevron.left")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - الخروج

    private var logoutCard: some View {
        Button { showLogoutConfirm = true } label: {
            HStack {
                Spacer()
                Image(systemName: "rectangle.portrait.and.arrow.right")
                Text("تسجيل الخروج")
                    .font(.body.weight(.semibold))
                Spacer()
            }
            .foregroundStyle(EMSTheme.Colors.danger)
            .frame(height: 50)
            .background(EMSTheme.Colors.danger.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var versionFooter: some View {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return Text("EMS Operations · إصدار \(version) (\(build))")
            .font(.caption2)
            .foregroundStyle(EMSTheme.Colors.textMuted)
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
    }
}

// MARK: - ViewModel

@MainActor
final class ProfileViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var profile: ProfileDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            profile = try await api.get("/api/my/profile")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}


// MARK: - ورقة تغيير كلمة المرور (§1 — POST /api/auth/change-password، جلسة قائمة)

private struct ChangePasswordSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new_ = ""
    @State private var confirm = ""
    @State private var working = false
    @State private var errorMessage: String? = nil
    @State private var done = false

    private var canSubmit: Bool {
        !current.isEmpty && !new_.isEmpty && new_ == confirm
    }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if done {
                    EMSCard {
                        VStack(spacing: 12) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.largeTitle)
                                .foregroundStyle(EMSTheme.Colors.emerald)
                            Text("تم تغيير كلمة المرور بنجاح")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                            EMSPrimaryButton(title: "إغلاق") { dismiss() }
                        }
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    EMSCard {
                        VStack(spacing: 12) {
                            HStack {
                                Image(systemName: "lock.fill")
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                SecureField("كلمة المرور الحالية", text: $current)
                                    .textContentType(.password)
                                    .foregroundStyle(.white)
                            }
                            Divider().overlay(EMSTheme.Colors.divider)
                            HStack {
                                Image(systemName: "key.fill")
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                SecureField("كلمة المرور الجديدة", text: $new_)
                                    .textContentType(.newPassword)
                                    .foregroundStyle(.white)
                            }
                            Divider().overlay(EMSTheme.Colors.divider)
                            HStack {
                                Image(systemName: "key.fill")
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                SecureField("تأكيد كلمة المرور الجديدة", text: $confirm)
                                    .textContentType(.newPassword)
                                    .foregroundStyle(.white)
                            }
                        }
                    }
                    if let error = errorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    EMSPrimaryButton(title: "حفظ", isLoading: working, isDisabled: !canSubmit) {
                        Task { await submit() }
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("تغيير كلمة المرور")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("إلغاء") { dismiss() }
            }
        }
    }

    private func submit() async {
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            let _: BasicSuccessDTO = try await APIClient.shared.post(
                "/api/auth/change-password",
                body: ChangePasswordBody(currentPassword: current, newPassword: new_))
            done = true
        } catch let e as APIError {
            errorMessage = e.userMessage
        } catch {
            errorMessage = APIError.unknown.userMessage
        }
    }
}
