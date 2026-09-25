//
//  RootView.swift
//  EMSOperations
//
//  التوجيه الجذري حسب حالة الجلسة + معالجة Deep Links من الإشعارات.
//

import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var deepLinks: DeepLinkRouter

    var body: some View {
        Group {
            switch session.state {
            case .restoring:
                LaunchView()
            case .unauthenticated:
                LoginView()
            case .authenticated:
                MainTabView()
            }
        }
        .environment(\.layoutDirection, .rightToLeft)
        .onChange(of: deepLinks.pending) { link in
            guard link != nil, session.isAuthenticated else { return }
            // يُستهلك في MainTabView عبر deepLinks.consume()
        }
    }
}

/// شاشة الإقلاع الأصلية — هوية داكنة + الشعار، لا شاشة بيضاء أبدًا (قسم 6).
struct LaunchView: View {
    var body: some View {
        ZStack {
            EMSTheme.Colors.navy.ignoresSafeArea()
            VStack(spacing: 16) {
                Image("AppLogoMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 96, height: 96)
                    .accessibilityHidden(true)
                Text("منظومة العمليات الإسعافية")
                    .font(EMSTheme.titleArabic)
                    .foregroundStyle(.white)
                Text("EMS OPERATIONS")
                    .font(EMSTheme.captionLatin)
                    .tracking(3)
                    .foregroundStyle(EMSTeal)
                ProgressView()
                    .tint(EMSTeal)
                    .padding(.top, 8)
            }
        }
    }
}

/// التبويبات الرئيسية — مبنية على الصلاحيات الفعلية (v2 قسم 6):
/// الرئيسية للجميع · العمليات لحاملي مفاتيح ops.* · الجدول/الإشعارات
/// لحاملي بوابة الموظف · حسابي للجميع. إخفاء التبويب ليس حماية —
/// الخادم يفرض الصلاحية في كل طلب.
struct MainTabView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var deepLinks: DeepLinkRouter
    @State private var selectedTab: AppTab = .home

    enum AppTab: Hashable { case home, operations, scheduleOps, schedule, notifications, baloot, chat, account }

    /// بند 11: بطاقة تفاصيل التمركز المنبثقة من إشعار Push.
    @State private var positioningNotice: PositioningNotice?

    private var showOperations: Bool { session.permissions.canAccessOperations }
    private var showScheduleOps: Bool { session.permissions.canViewSchedules }
    private var showPortalTabs: Bool { session.permissions.canAccessEmployeePortal }
    private var showCommunity: Bool { session.permissions.canAccessCommunity }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { HomeView() }
                .tabItem { Label("الرئيسية", systemImage: "house.fill") }
                .tag(AppTab.home)
            if showOperations {
                NavigationStack { OperationsHomeView() }
                    .tabItem { Label("العمليات", systemImage: "point.3.connected.trianglepath.dotted") }
                    .tag(AppTab.operations)
            }
            if showScheduleOps {
                NavigationStack { ScheduleHubView() }
                    .tabItem { Label("الجداول", systemImage: "calendar.badge.clock") }
                    .tag(AppTab.scheduleOps)
            }
            if showPortalTabs {
                NavigationStack { ScheduleView() }
                    .tabItem { Label("مناوباتي", systemImage: "calendar") }
                    .tag(AppTab.schedule)
                NavigationStack { NotificationsView() }
                    .tabItem { Label("الإشعارات", systemImage: "bell.fill") }
                    .tag(AppTab.notifications)
                    .badge(session.unreadNotifications > 0 ? session.unreadNotifications : 0)
            }
            if showCommunity {
                // اللوبي يملك NavigationStack الخاص به (مسارات الطاولة) — لا تغليف هنا.
                BalootLobbyView()
                    .tabItem { Label("البلوت", systemImage: "suit.spade.fill") }
                    .tag(AppTab.baloot)
            }
            NavigationStack { ChatView() }
                .tabItem { Label("المحادثات", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(AppTab.chat)
            NavigationStack { ProfileView() }
                .tabItem { Label("حسابي", systemImage: "person.crop.circle") }
                .tag(AppTab.account)
        }
        .tint(EMSTeal)
        .onAppear {
            #if DEBUG
            AppLogger.ui.info("MainTabView appeared — operations tab: \(showOperations) · portal tabs: \(showPortalTabs)")
            #endif
        }
        .onChange(of: session.permissions.canAccessOperations) { newValue in
            #if DEBUG
            AppLogger.ui.info("operations tab visibility changed → \(newValue)")
            #endif
        }
        .onChange(of: deepLinks.pending) { link in
            guard let link, session.isAuthenticated else { return }
            switch link.destination {
            case .scheduleChanges:
                if showPortalTabs {
                    deepLinks.requestScheduleChanges = true
                    selectedTab = .schedule
                }
            case .notifications:
                if showPortalTabs { selectedTab = .notifications }
            case .positioning:
                // بند 11: الضغط على إشعار التمركز يفتح بطاقة التفاصيل مباشرة
                // فوق التبويب الحالي — لا نقل لقائمة الإشعارات.
                positioningNotice = PositioningNotice(
                    title: link.title?.isEmpty == false ? link.title! : "تمركز وقت الذروة",
                    message: link.body ?? "")
            }
            deepLinks.pending = nil
        }
        .sheet(item: $positioningNotice) { notice in
            PositioningNoticeView(notice: notice)
        }
    }
}

// أسماء مختصرة للألوان المشتركة
let EMSTeal = EMSTheme.Colors.teal
