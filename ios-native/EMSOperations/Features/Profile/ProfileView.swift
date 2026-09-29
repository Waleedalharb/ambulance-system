//
//  ProfileView.swift
//  EMSOperations
//
//  «المزيد» (قسم 21): بيانات الموظف + الوصول للمحادثات والطلبات والإدارة
//  + إعدادات الجلسة (Face ID) + تسجيل الخروج.
//  الخروج يمر عبر AuthService → يفصل جهاز Push خادميًا (D8).
//
//  إعادة بناء بصرية (2026-09-28 — اعتماد المرجع البصري للمالك وقراراته
//  الكتابية أ/ب/ج): Dark Navy/Teal · RTL · بطاقات مجمعة بأقسام.
//  الوظائف الموجودة فعليًا فقط — قرار المالك: لا Placeholder ولا «قريبًا»
//  ولا Routes جديدة، فأُخفيت عناصر المرجع التي لا شاشة لها (حسابي المستقلة،
//  تفضيلات الإشعارات، المساعدة والدعم، حول التطبيق) وسهام البطاقات بلا
//  وجهة. «طلباتي والإعلانات» و«مركز الإدارة» (للمخوّل فقط) محفوظتان كما
//  كانتا، ومنطق الأمان والخروج والجلسة لم يُمس إطلاقًا.
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
                headerBlock
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if let p = vm.profile { employeeCard(p) }
                    else if vm.portalUnavailable { accountIdentityCard }
                    commsSection
                    accountSection
                    securityCard
                    logoutCard
                    versionFooter
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("المزيد")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: AdminHubView.AdminModule.self) { module in
            // وجهات مركز الإدارة تُسجَّل هنا في جذر NavigationStack الخاص
            // بـ«المزيد» (إصلاح Navigation — 2026-09-29): التسجيل كان داخل
            // AdminHubView وهي شاشة مدفوعة، وكان مصدر فشل الفتح المتقطع لكل
            // عناصر المركز. البطاقات والروابط والتصميم لم تتغير إطلاقًا.
            AdminHubView.destination(for: module)
        }
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

    // MARK: - الترويسة (لمسة EMS خفيفة كما في المرجع — خط نبض باهت فقط)

    private var headerBlock: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text("المزيد")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Text("خيارات إضافية وإعدادات التطبيق")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            Spacer()
            Image(systemName: "waveform.path.ecg")
                .font(.title)
                .foregroundStyle(EMSTheme.Colors.teal.opacity(0.30))
                .accessibilityHidden(true)
        }
    }

    // MARK: - بطاقة الموظف (البيانات الحقيقية من /api/my/profile — بلا اختراع)

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
                // أعمدة المرجع الثلاثة: الرقم الوظيفي / الفرقة الحالية / المركز —
                // القيمة الغائبة تُعرض «—» كما كان سلوك الشاشة دائمًا (لا قيمة مختلقة).
                HStack(spacing: 8) {
                    infoColumn(value: p.employee.code, label: "الرقم الوظيفي",
                               icon: "person.text.rectangle.fill", tint: EMSTheme.Colors.emerald)
                    infoColumn(value: p.today?.teamName, label: "الفرقة الحالية",
                               icon: "person.2.fill", tint: EMSTheme.Colors.teal)
                    infoColumn(value: p.today?.center, label: "المركز",
                               icon: "mappin.and.ellipse", tint: EMSTheme.Colors.teal)
                }
                if let update = p.lastRosterUpdate {
                    Text("آخر تحديث للجدول: \(update)")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func infoColumn(value: String?, label: String, icon: String, tint: Color) -> some View {
        VStack(spacing: 5) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(tint.opacity(0.14))
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint)
            }
            .frame(width: 30, height: 30)
            Text(value ?? "—")
                .font(.caption.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - بطاقة هوية الحساب (بلا بوابة موظف — توجيه المالك 2026-09-19 بند 1/9)
    // «عدم امتلاك ops.my_portal لا يمنع دخول التطبيق» — حسابي تبقى صفحة
    // عاملة لكل موظفي القطاع: هوية من الجلسة (بلا طلب شبكة) + الأمان + الخروج.

    private var accountIdentityCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(EMSTheme.Colors.teal.opacity(0.18))
                        Image(systemName: "person.badge.shield.checkmark.fill")
                            .foregroundStyle(EMSTheme.Colors.teal)
                    }
                    .frame(width: 52, height: 52)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.currentUser?.name ?? "—")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                        Text(session.permissions.roleLabel ?? session.currentUser?.role ?? "—")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textSecondary)
                    }
                    Spacer()
                }
                Divider().overlay(EMSTheme.Colors.divider)
                if let username = session.currentUser?.username {
                    EMSInfoRow(label: "اسم المستخدم", value: username)
                }
                Text("هذا الحساب غير مرتبط ببوابة الموظف — تُعرض لك الوحدات التشغيلية حسب صلاحياتك.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - مكونات الأقسام (أسلوب المرجع: عنوان قسم + بطاقة مجمعة بصفوف)

    private func sectionHeader(_ title: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.teal)
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(EMSTheme.Colors.textPrimary)
            Spacer()
        }
        .padding(.top, 4)
        .accessibilityAddTraits(.isHeader)
    }

    private func groupedCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    private func rowDivider() -> some View {
        Divider().overlay(EMSTheme.Colors.divider).padding(.horizontal, EMSTheme.cardPadding)
    }

    /// صف قائمة موحد: أيقونة ملونة في مربع + عنوان + وصف + سهم. عرض فقط —
    /// الوجهة تُمرَّر من الخارج وتبقى Routes القائمة كما هي.
    private func menuRowLabel(icon: String, tint: Color, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(tint.opacity(0.16))
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(tint)
            }
            .frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            Spacer()
            Image(systemName: "chevron.left")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
        .padding(.horizontal, EMSTheme.cardPadding)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    // MARK: - التواصل (قرار المالك ب: المحادثات صفًّا يفتح ChatView نفسها)

    private var commsSection: some View {
        VStack(spacing: 8) {
            sectionHeader("التواصل", icon: "bubble.left.and.bubble.right.fill")
            groupedCard {
                NavigationLink {
                    ChatView()
                } label: {
                    menuRowLabel(icon: "bubble.left.and.bubble.right.fill",
                                 tint: EMSTheme.Colors.teal,
                                 title: "المحادثات",
                                 subtitle: "التواصل مع الزملاء")
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - الحساب والإعدادات (الوظائف الموجودة فعليًا فقط — قرار المالك ج)

    private var accountSection: some View {
        let showRequests = !vm.portalUnavailable
        let showAdmin = session.permissions.canAccessAdmin
        return VStack(spacing: 8) {
            sectionHeader("الحساب والإعدادات", icon: "gearshape.fill")
            if showRequests || showAdmin {
                groupedCard {
                    if showRequests {
                        // §23-§25 — لكل مستخدم موثّق (نفس Route القائم)
                        NavigationLink {
                            MyRequestsView()
                        } label: {
                            menuRowLabel(icon: "calendar.badge.clock",
                                         tint: EMSTheme.Colors.danger,
                                         title: "طلباتي والإعلانات",
                                         subtitle: "طلب إجازة · تغيير مناوبة · الإعلانات والإجازات المجدولة")
                        }
                        .buttonStyle(.plain)
                    }
                    if showRequests && showAdmin { rowDivider() }
                    if showAdmin {
                        // §20 — تظهر فقط لحاملي صلاحياتها (نفس Route القائم)
                        NavigationLink {
                            AdminHubView()
                        } label: {
                            menuRowLabel(icon: "shield.lefthalf.filled",
                                         tint: EMSTheme.Colors.teal,
                                         title: "مركز الإدارة",
                                         subtitle: "المستخدمون · الموظفون · الفرق والرموز · الإعدادات")
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - الأمن والخصوصية (المحتوى القائم نفسه داخل الصفحة — قرار المالك بند 7)

    private var securityCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "الأمن والخصوصية", systemImage: "lock.shield")
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

    // MARK: - الخروج (إجراء خطِر ببطاقة مستقلة — المنطق كما هو حرفيًا)

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

    // MARK: - الإصدار (من Bundle الحقيقي — لا قيمة مكتوبة)

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

// MARK: - ViewModel (بلا أي تغيير — نفس المصدر والسلوك المعتمد)

@MainActor
final class ProfileViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var profile: ProfileDTO?
    /// الحساب غير مرتبط ببوابة الموظف (403/NO_EMPLOYEE) — ليس خطأ (بند 1/9).
    @Published var portalUnavailable = false

    private let api = APIClient.shared

    func load() async {
        if profile == nil && !portalUnavailable { state = .loading }
        do {
            profile = try await api.get("/api/my/profile")
            portalUnavailable = false
            state = .loaded
        } catch let e as APIError {
            if e == .forbidden || e == .noEmployee {
                portalUnavailable = true
                state = .loaded
            } else if !RefreshFailurePolicy.keepContent(hasContent: profile != nil || portalUnavailable, message: e.userMessage) {
                state = .failed(e.userMessage)
            }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: profile != nil || portalUnavailable, message: APIError.unknown.userMessage) {
                state = .failed(APIError.unknown.userMessage)
            }
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
            // نجح التغيير — لم تعد كلمة المرور هي الكود، أزل التنبيه الاستشاري
            InitialPasswordAdvisory.clear(for: AuthService.shared.storedUser()?.username)
            done = true
        } catch let e as APIError {
            errorMessage = e.userMessage
        } catch {
            errorMessage = APIError.unknown.userMessage
        }
    }
}
