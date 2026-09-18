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
