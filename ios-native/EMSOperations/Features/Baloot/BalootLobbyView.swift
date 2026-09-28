//
//  BalootLobbyView.swift
//  EMSOperations
//
//  مجلس البلوت 🃏 — الطاولات المفتوحة والجارية، فتح طاولة، الجلوس،
//  المشاهدة، والتصنيف الشرفي. الدخول مبوّب بصلاحية community.view
//  (الإخفاء ليس حماية — الخادم يفرض الصلاحية في كل طلب).
//

import SwiftUI

struct BalootLobbyView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm: BalootLobbyViewModel
    /// مسار التنقل داخل تبويب البلوت: معرّف طاولة.
    @State private var path: [Int] = []
    @State private var busy = false

    init() {
        // التوكن من Keychain عبر AuthService — نفس مزوّد APIClient.
        _vm = StateObject(wrappedValue: BalootLobbyViewModel(tokenProvider: { AuthService.shared.storedAccessToken() }))
    }

    var body: some View {
        // يملك تبويب البلوت NavigationStack الخاص به — التنقل للطاولة برمجي
        // (بعد نجاح الجلوس/الإنشاء) ولا يعمل بدون مسار مربوط.
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    headerCard
                    if let err = vm.actionError {
                        EMSErrorView(message: err) { vm.actionError = nil }
                    }
                    switch vm.state {
                    case .idle, .loading:
                        EMSSkeletonCard()
                        EMSSkeletonCard(lines: 2)
                    case .failed(let msg):
                        EMSErrorView(message: msg) { Task { await vm.load() } }
                    case .ready:
                        tablesSection
                        ratingsSection
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .refreshable { await vm.load() }
            .navigationDestination(for: Int.self) { tableId in
                BalootTableView(tableId: tableId, socket: vm.socket)
            }
            .emsPage("مجلس البلوت")
            .onAppear { vm.start() }
            .onDisappear {
                // القناة تبقى حية داخل شاشة الطاولة (path غير فارغ = دفعنا شاشة) —
                // وتُوقف فقط عند مغادرة المجلس فعليًا (تبديل تبويب/رجوع).
                if path.isEmpty { vm.stop() }
            }
        }
    }

    // MARK: - الترويسة وفتح طاولة

    private var headerCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "مجلس البلوت", systemImage: "suit.spade.fill")
                Text("طاولات زملاء القطاع — اجلس والعب أو تفرّج. سيرفر المنصة هو الحكم الوحيد، ولا علاقة للمناوبة هنا.")
                    .font(EMSTheme.captionArabic)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                if session.permissions.canCreateCommunityActivity {
                    EMSPrimaryButton(title: busy ? "" : "🃏 افتح طاولة جديدة", isLoading: busy) {
                        busy = true
                        Task {
                            if let id = await vm.createTable() {
                                // الفاتح يجلس مباشرة ثم ينتقل للطاولة
                                _ = await vm.sit(tableId: id)
                                path.append(id)
                            }
                            busy = false
                        }
                    }
                }
            }
        }
    }

    // MARK: - الطاولات

    private var tablesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            EMSectionHeader(title: "الطاولات", systemImage: "rectangle.on.rectangle.angled")
            if vm.tables.isEmpty {
                EMSEmptyView(icon: "suit.spade", title: "لا طاولات حاليًا",
                             detail: session.permissions.canCreateCommunityActivity
                                ? "كن أول من يفتح طاولة 🃏" : "انتظر زميلًا يفتح طاولة")
            } else {
                ForEach(vm.tables) { table in
                    tableCard(table)
                }
            }
        }
    }

    private func tableCard(_ table: BalootLobbyTableDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("طاولة #\(table.id)")
                        .font(EMSTheme.headlineArabic)
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    statusPill(table)
                }

                // المقاعد الأربعة — حالة كل مقعد بلمحة
                HStack(spacing: 8) {
                    ForEach(table.seats, id: \.seat) { seat in
                        seatChip(seat)
                    }
                }

                HStack(spacing: 8) {
                    if table.isOpen && session.permissions.canJoinCommunityActivity {
                        Button {
                            Task {
                                if await vm.sit(tableId: table.id) { path.append(table.id) }
                            }
                        } label: {
                            Label("اجلس (\(table.occupiedCount)/4)", systemImage: "chair.fill")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 40)
                                .background(EMSTheme.Colors.teal)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                    Button {
                        path.append(table.id)
                    } label: {
                        Label(table.isInMatch ? "شاهد اللعب" : "افتح الطاولة",
                              systemImage: table.isInMatch ? "eye.fill" : "arrow.left.circle")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .background(EMSTheme.Colors.navySoft)
                            .foregroundStyle(EMSTheme.Colors.teal)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
            }
        }
    }

    private func seatChip(_ seat: BalootLobbySeatDTO) -> some View {
        VStack(spacing: 4) {
            Image(systemName: seat.occupied ? "person.fill" : "person")
                .font(.caption)
                .foregroundStyle(seat.occupied ? EMSTheme.Colors.emerald : EMSTheme.Colors.textMuted)
            Text(seat.occupied ? (seat.name ?? "لاعب") : "فارغ")
                .font(.caption2)
                .foregroundStyle(seat.occupied ? EMSTheme.Colors.textSecondary : EMSTheme.Colors.textMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color.white.opacity(seat.occupied ? 0.06 : 0.03))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            if seat.disconnected == true {
                RoundedRectangle(cornerRadius: 10).stroke(EMSTheme.Colors.warning, lineWidth: 1)
            }
        }
    }

    private func statusPill(_ table: BalootLobbyTableDTO) -> some View {
        switch table.status {
        case "open": return EMSStatusPill(text: "تنتظر لاعبين", tone: .normal)
        case "ready_check": return EMSStatusPill(text: "تأكيد الجاهزية", tone: .monitor)
        case "in_match": return EMSStatusPill(text: "تلعب الآن", tone: .action)
        case "post_match": return EMSStatusPill(text: "انتهت — ريماچ؟", tone: .monitor)
        default: return EMSStatusPill(text: table.status, tone: .neutral)
        }
    }

    // MARK: - التصنيف الشرفي

    private var ratingsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            EMSectionHeader(title: "النقاط الشرفية", systemImage: "trophy.fill")
            if vm.ratings.isEmpty {
                EMSEmptyView(icon: "trophy", title: "لا نتائج بعد", detail: "أول مباراة تُسجَّل هنا")
            } else {
                EMSCard {
                    VStack(spacing: 8) {
                        ForEach(Array(vm.ratings.prefix(10).enumerated()), id: \.element.id) { idx, r in
                            HStack {
                                Text("\(idx + 1)")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(idx == 0 ? EMSTheme.Colors.warning : EMSTheme.Colors.textMuted)
                                    .frame(width: 22)
                                Text(r.name ?? "لاعب")
                                    .font(.subheadline)
                                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                                Spacer()
                                Text("\(r.wins) فوز / \(r.losses) خسارة")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                Text("\(r.honorPoints)")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(EMSTheme.Colors.teal)
                            }
                            if idx < min(vm.ratings.count, 10) - 1 {
                                Divider().background(EMSTheme.Colors.divider)
                            }
                        }
                    }
                }
            }
        }
    }
}
