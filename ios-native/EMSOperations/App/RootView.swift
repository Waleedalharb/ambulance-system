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
        .onChange(of: deepLinks.pending) { _, link in
            guard link != nil, session.state == .authenticated else { return }
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
                    .font(EMSTypography.titleArabic)
                    .foregroundStyle(.white)
                Text("EMS OPERATIONS")
                    .font(EMSTypography.captionLatin)
                    .tracking(3)
                    .foregroundStyle(EMSTeal)
                ProgressView()
                    .tint(EMSTeal)
                    .padding(.top, 8)
            }
        }
    }
}

/// التبويبات الرئيسية — الرئيسية · مناوبتي · الجدول · الإشعارات · حسابي (قسم 32).
struct MainTabView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var deepLinks: DeepLinkRouter
    @State private var selectedTab: AppTab = .home

    enum AppTab: Hashable { case home, shift, schedule, notifications, account }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { HomeView() }
                .tabItem { Label("الرئيسية", systemImage: "house.fill") }
                .tag(AppTab.home)
            NavigationStack { CurrentShiftView() }
                .tabItem { Label("مناوبتي", systemImage: "clock.badge.checkmark") }
                .tag(AppTab.shift)
            NavigationStack { ScheduleView() }
                .tabItem { Label("الجدول", systemImage: "calendar") }
                .tag(AppTab.schedule)
            NavigationStack { NotificationsView() }
                .tabItem { Label("الإشعارات", systemImage: "bell.fill") }
                .tag(AppTab.notifications)
                .badge(session.unreadNotifications > 0 ? session.unreadNotifications : 0)
            NavigationStack { ProfileView() }
                .tabItem { Label("حسابي", systemImage: "person.crop.circle") }
                .tag(AppTab.account)
        }
        .tint(EMSTeal)
        .onChange(of: deepLinks.pending) { _, link in
            guard let link, session.state == .authenticated else { return }
            switch link.destination {
            case .scheduleChanges:
                deepLinks.requestScheduleChanges = true
                selectedTab = .schedule
            case .notifications:
                selectedTab = .notifications
            }
            deepLinks.pending = nil
        }
    }
}

// أسماء مختصرة للألوان المشتركة
let EMSTeal = EMSTheme.Colors.teal
