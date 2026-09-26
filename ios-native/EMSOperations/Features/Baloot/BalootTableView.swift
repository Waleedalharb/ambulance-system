//
//  BalootTableView.swift
//  EMSOperations
//
//  شاشة الطاولة — «أنا جالس على طاولة بلوت» وليست لوحة معلومات:
//   أثناء المباراة تصبح الشاشة كلها الطاولة: لباد يملأ الشاشة بإطار ذهبي،
//   اللاعبون حولها (الشريك مقابلك، الخصمان يمينك ويسارك)، الأوراق الملعوبة
//   تظهر في المركز باتجاه صاحبها، يدك مروحة كبيرة أسفل الشاشة، النقاط
//   شريط رفيع أنيق داخل الإطار، ومؤشر الدور توهّج ذهبي واحد لا يضيء
//   إلا مقعدًا واحدًا (vm.activeTurnSeat — مصدر authoritative وحيد).
//
//  الواجهة لا تعرف قواعد البلوت — تعرض ما يرسله الخادم وتفعّل ما يعيده
//  /options فقط. الممنوع غير قابل للضغط أصلًا. الصوت من BalootSoundService
//  (AVAudioPlayer — يعمل دائمًا، والكتم من قائمة الطاولة فقط).
//

import SwiftUI

struct BalootTableView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var vm: BalootTableViewModel
    /// القناة يملكها اللوبي وتبقى حية داخل الطاولة — نراقبها هنا للعرض فقط.
    @ObservedObject private var socket: BalootSocket
    @ObservedObject private var sound = BalootSoundService.shared
    @State private var showChat = false
    @State private var chatDraft = ""
    @State private var confirmLeave = false
    @State private var confirmClose = false
    @State private var confirmAbort = false
    @State private var pendingCard: BalootCardDTO?

    private let tableId: Int

    init(tableId: Int, socket: BalootSocket) {
        self.tableId = tableId
        self._socket = ObservedObject(wrappedValue: socket)
        _vm = StateObject(wrappedValue: BalootTableViewModel(tableId: tableId, socket: socket))
    }

    /// هل وافقتُ على الريماچ؟ (معرّفي من الجلسة)
    private var iAcceptedRematch: Bool {
        guard let myId = session.currentUser?.id else { return false }
        return vm.rematch?.accepts?.contains(myId) ?? false
    }

    // MARK: - ألوان الطاولة (هوية المنصة + لباد البلوت)

    private let feltTop = Color(red: 0.10, green: 0.34, blue: 0.23)
    private let feltBottom = Color(red: 0.03, green: 0.15, blue: 0.10)
    private let gold = Color(red: 0.82, green: 0.66, blue: 0.32)
    private let podColor = Color(red: 0.03, green: 0.11, blue: 0.08)

    var body: some View {
        content
            .emsPage("طاولة بلوت #\(tableId)")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 14) {
                        connectionDot
                        if vm.table?.roomId != nil {
                            Button { showChat = true } label: {
                                Image(systemName: "bubble.left.and.bubble.right.fill")
                                    .foregroundStyle(EMSTheme.Colors.teal)
                            }
                            .accessibilityLabel("سالفة الطاولة")
                        }
                        tableMenu
                    }
                }
            }
            .onAppear { vm.start() }
            .onDisappear { vm.stop() }
            .sheet(isPresented: $showChat, onDismiss: { vm.closeChat() }) {
                chatSheet.onAppear { vm.openChat() }
            }
            .confirmationDialog("مغادرة الطاولة؟", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("مغادرة", role: .destructive) {
                    Task { if await vm.leave() { dismiss() } }
                }
                Button("إلغاء", role: .cancel) {}
            }
            .confirmationDialog("إغلاق الطاولة للجميع؟", isPresented: $confirmClose, titleVisibility: .visible) {
                Button("إغلاق الطاولة", role: .destructive) { Task { if await vm.closeTable() { dismiss() } } }
                Button("إلغاء", role: .cancel) {}
            }
            .confirmationDialog("تصويت إنهاء ودي؟", isPresented: $confirmAbort, titleVisibility: .visible) {
                Button("صوّت للإنهاء", role: .destructive) { Task { await vm.voteAbort() } }
                Button("إلغاء", role: .cancel) {}
            } message: {
                Text("تنتهي المباراة وديًا إذا وافق اثنان من الثلاثة المتبقين.")
            }
    }

    /// قائمة الطاولة: الصوت (كتم/تجربة) + الإنهاء الودي أثناء المباراة.
    private var tableMenu: some View {
        Menu {
            Button {
                sound.toggleMuted()
            } label: {
                Label(sound.isMuted ? "تشغيل الأصوات" : "كتم الأصوات",
                      systemImage: sound.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
            }
            Button {
                sound.playTest()
            } label: {
                Label(sound.loadedCount > 0 ? "تجربة الصوت" : "الأصوات غير محمّلة (\(sound.loadedCount)/8)",
                      systemImage: "speaker.badge.plus")
            }
            if vm.table?.isInMatch == true, vm.isSeated, vm.matchStatus == "active" {
                Divider()
                Button(role: .destructive) { confirmAbort = true } label: {
                    Label("تصويت إنهاء ودي", systemImage: "hand.raised.fill")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .foregroundStyle(EMSTheme.Colors.teal)
        }
        .accessibilityLabel("إعدادات الطاولة")
    }

    // MARK: - المحتوى حسب طور الطاولة

    @ViewBuilder
    private var content: some View {
        if let table = vm.table, table.isInMatch {
            // أثناء المباراة: الشاشة كلها هي الطاولة — بلا تمرير وبلا بطاقات.
            matchScreen(table)
        } else {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    if let err = vm.actionError {
                        EMSErrorView(message: err) { vm.actionError = nil }
                    }
                    if let table = vm.table {
                        switch table.status {
                        case "open", "ready_check":
                            waitingSection(table)
                        case "post_match":
                            postMatchSection(table)
                        default:
                            EMSEmptyView(icon: "xmark.circle", title: "الطاولة مغلقة")
                        }
                        feedSection
                    } else if vm.actionError == nil {
                        EMSSkeletonCard()
                        EMSSkeletonCard(lines: 2)
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .refreshable { await vm.reloadTable() }
        }
    }

    // MARK: - طور الانتظار (جلوس/جاهزية)

    @ViewBuilder
    private func waitingSection(_ table: BalootLobbyTableDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    EMSectionHeader(title: "المقاعد الأربعة", systemImage: "person.3.sequence.fill")
                    Spacer()
                    Text("\(table.occupiedCount)/4")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }

                HStack(spacing: 8) {
                    ForEach(table.seats, id: \.seat) { seat in
                        waitingSeatChip(seat)
                    }
                }

                if table.status == "ready_check" {
                    Text("اكتملت الطاولة — أكّد جاهزيتك لتبدأ الصفقة الأولى")
                        .font(EMSTheme.captionArabic)
                        .foregroundStyle(EMSTheme.Colors.warning)
                }

                // إجراءاتي
                VStack(spacing: 8) {
                    if !vm.isSeated && table.isOpen && session.permissions.canJoinCommunityActivity {
                        EMSPrimaryButton(title: "اجلس على الطاولة", isLoading: vm.busy) {
                            Task { await vm.sit() }
                        }
                    }
                    if vm.isSeated && table.status == "ready_check" {
                        EMSPrimaryButton(title: "✋ أنا جاهز — ابدأ", isLoading: vm.busy) {
                            Task { await vm.ready() }
                        }
                    }
                    HStack(spacing: 8) {
                        if vm.isSeated {
                            Button("مغادرة") { confirmLeave = true }
                                .font(.subheadline.weight(.medium))
                                .frame(maxWidth: .infinity).frame(height: 38)
                                .background(EMSTheme.Colors.navySoft)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        if isTableCreator(table) && table.isOpen && session.permissions.canCreateCommunityActivity {
                            Button("إغلاق الطاولة") { confirmClose = true }
                                .font(.subheadline.weight(.medium))
                                .frame(maxWidth: .infinity).frame(height: 38)
                                .background(EMSTheme.Colors.danger.opacity(0.15))
                                .foregroundStyle(EMSTheme.Colors.danger)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                }
            }
        }
    }

    private func waitingSeatChip(_ seat: BalootLobbySeatDTO) -> some View {
        VStack(spacing: 6) {
            Image(systemName: seat.occupied ? "person.fill.checkmark" : "person.badge.plus")
                .foregroundStyle(seat.occupied ? EMSTheme.Colors.emerald : EMSTheme.Colors.textMuted)
            Text(seat.occupied ? (seat.name ?? "لاعب") : "فارغ")
                .font(.caption2)
                .foregroundStyle(seat.occupied ? EMSTheme.Colors.textPrimary : EMSTheme.Colors.textMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if seat.occupied, let mySeat = vm.mySeat, mySeat == seat.seat {
                Text("أنت")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.teal)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color.white.opacity(seat.occupied ? 0.07 : 0.03))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func isTableCreator(_ table: BalootLobbyTableDTO) -> Bool {
        guard let me = session.currentUser else { return false }
        return table.createdBy == me.id
    }

    // MARK: - شاشة المباراة (الشاشة = الطاولة)

    private func matchScreen(_ table: BalootLobbyTableDTO) -> some View {
        VStack(spacing: 0) {
            scoreStrip
            if let err = vm.actionError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.danger)
                    .lineLimit(1)
                    .padding(.top, 2)
                    .onTapGesture { vm.actionError = nil }
            }
            if vm.paused { pausedCapsule }
            if vm.isSpectator { spectatorCapsule }
            lastEventLine
            tableArena
                .frame(maxHeight: .infinity)
            meBar
            actionChips
            handFan
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(colors: [feltTop, feltBottom], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        )
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(gold.opacity(0.55), lineWidth: 2)
                .padding(6)
                .ignoresSafeArea(.keyboard)
        )
    }

    /// شريط النقاط الرفيع داخل إطار الطاولة: لنا/لهم + العقد والصفقة + المشاهدون.
    private var scoreStrip: some View {
        let myTeam = vm.matchState?.seats?.first(where: { $0.seat == vm.mySeat })?.team
        let scoreA = vm.matchState?.scores?.A ?? 0
        let scoreB = vm.matchState?.scores?.B ?? 0
        let ours = myTeam == "B" ? scoreB : scoreA
        let theirs = myTeam == "B" ? scoreA : scoreB
        return HStack(spacing: 10) {
            HStack(spacing: 4) {
                Text(myTeam == nil ? "A" : "لنا")
                    .font(.caption2)
                Text("\(myTeam == nil ? scoreA : ours)")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(EMSTheme.Colors.emerald)

            Spacer()

            VStack(spacing: 0) {
                if let c = vm.matchState?.hand?.contract {
                    Text(BalootLabels.contract(c) + (vm.matchState?.hand?.double != nil ? " ×\(vm.matchState?.hand?.double?.multiplier ?? 2)" : ""))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(gold)
                }
                Text("صفقة \(vm.matchState?.handNumber ?? 1) · الهدف \(vm.matchState?.targetScore ?? 152)")
                    .font(.caption2)
                    .foregroundStyle(Color.white.opacity(0.55))
            }

            Spacer()

            HStack(spacing: 4) {
                Text("\(myTeam == nil ? scoreB : theirs)")
                    .font(.subheadline.weight(.bold))
                Text(myTeam == nil ? "B" : "لهم")
                    .font(.caption2)
            }
            .foregroundStyle(EMSTheme.Colors.danger)

            if vm.spectators > 0 {
                Text("👁 \(vm.spectators)")
                    .font(.caption2)
                    .foregroundStyle(Color.white.opacity(0.55))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.black.opacity(0.22))
        .clipShape(Capsule())
        .padding(.top, 4)
    }

    /// آخر حدث بسطر واحد خفيف — السجل الكامل في طور ما قبل/بعد المباراة.
    @ViewBuilder
    private var lastEventLine: some View {
        if let line = vm.feedLines.last {
            Text(line)
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.6))
                .lineLimit(1)
                .padding(.top, 4)
                .id(line) // انتقال ناعم مع كل حدث جديد
                .transition(.opacity)
        }
    }

    // MARK: - ساحة الطاولة (المقاعد + المركز)

    /// اللاعبون حول اللباد: الشريك أعلى، يميني ويساري على الجانبين، والمركز للأوراق.
    private var tableArena: some View {
        ZStack {
            centerStage

            VStack {
                seatPod(relative: 2) // الشريك مقابلي
                Spacer()
            }

            HStack {
                seatPod(relative: 1) // يميني (RTL: أول عنصر يظهر يمينًا)
                Spacer()
                seatPod(relative: 3) // يساري
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
    }

    /// مقعد لاعب: صورة رمزية بحرف اسمه + اسم قصير + عدّاد أوراقه،
    /// وتوهّج ذهبي واحد لصاحب الدور (لا يضيء مقعدان أبدًا).
    private func seatPod(relative: Int) -> some View {
        let seat = vm.displaySeat(relative: relative)
        let isTurn = vm.activeTurnSeat == seat
        let count = vm.matchState?.hand?.handCounts?[String(seat)] ?? 0
        let isMe = seat == vm.mySeat
        let name = podName(seat)
        return VStack(spacing: 3) {
            ZStack {
                Circle()
                    .fill(podColor.opacity(0.95))
                    .frame(width: 46, height: 46)
                    .overlay(
                        Circle()
                            .stroke(isTurn ? gold : gold.opacity(0.25), lineWidth: isTurn ? 2.5 : 1)
                    )
                    .shadow(color: isTurn ? gold.opacity(0.6) : .clear, radius: isTurn ? 12 : 0)
                Text(String(name.prefix(1)))
                    .font(.title3.weight(.bold))
                    .foregroundStyle(isTurn ? gold : Color.white.opacity(0.9))
            }
            Text(isMe ? "أنت" : name)
                .font(.caption2.weight(isTurn ? .bold : .medium))
                .foregroundStyle(isTurn ? gold : Color.white.opacity(0.85))
                .lineLimit(1)
                .frame(width: 74)
            if count > 0 {
                miniCardBacks(count: count)
            }
        }
        .padding(.vertical, 4)
        .animation(.easeInOut(duration: 0.3), value: isTurn)
    }

    /// ظهور أوراق صغيرة بعدد أوراق اللاعب (بديل مرئي عن العدد الرقمي).
    private func miniCardBacks(count: Int) -> some View {
        let shown = min(count, 8)
        return HStack(spacing: -5) {
            ForEach(0..<shown, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(LinearGradient(colors: [Color(red: 0.16, green: 0.24, blue: 0.45),
                                                  Color(red: 0.10, green: 0.15, blue: 0.30)],
                                         startPoint: .top, endPoint: .bottom))
                    .overlay(
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .stroke(gold.opacity(0.5), lineWidth: 0.5)
                    )
                    .frame(width: 10, height: 15)
                    .rotationEffect(.degrees(Double(i - shown / 2) * 5))
                    .zIndex(Double(i))
            }
        }
        .frame(height: 17)
    }

    /// مركز الطاولة: الورقة المكشوفة في السوق، واللفة موزعة باتجاه أصحابها في اللعب.
    @ViewBuilder
    private var centerStage: some View {
        let hand = vm.matchState?.hand
        ZStack {
            // زخرفة اللباد الخافتة
            Image(systemName: "suit.spade.fill")
                .font(.system(size: 90))
                .foregroundStyle(Color.white.opacity(0.05))

            if let hand, hand.phase.hasPrefix("bidding"), let faceUp = hand.faceUpCard {
                VStack(spacing: 4) {
                    Text("الورقة المكشوفة")
                        .font(.caption2)
                        .foregroundStyle(Color.white.opacity(0.6))
                    cardView(faceUp, size: .medium, enabled: false)
                        .shadow(color: .black.opacity(0.4), radius: 6, y: 3)
                        .transition(.scale.combined(with: .opacity))
                }
            } else if let trick = hand?.currentTrick, !trick.isEmpty {
                // كل ورقة تنزاح نحو جهة صاحبها — كما على طاولة حقيقية
                ForEach(trick, id: \.seat) { play in
                    cardView(play.card, size: .medium, enabled: false)
                        .shadow(color: .black.opacity(0.4), radius: 4, y: 2)
                        .offset(trickOffset(for: play.seat))
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            } else if let last = hand?.lastTrick {
                Text("اللفة السابقة: \(seatShortName(last.winnerSeat))")
                    .font(.caption2)
                    .foregroundStyle(Color.white.opacity(0.55))
            }

            // المشاريع والبلوت أسفل المركز
            VStack {
                Spacer()
                centerBadges(hand)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.75), value: hand?.currentTrick?.count)
        .animation(.easeInOut(duration: 0.25), value: hand?.faceUpCard?.code)
    }

    @ViewBuilder
    private func centerBadges(_ hand: BalootHandDTO?) -> some View {
        if let decl = hand?.declarations, decl.resolved, let projects = decl.projects, !projects.isEmpty {
            HStack(spacing: 4) {
                ForEach(Array(projects.enumerated()), id: \.offset) { _, p in
                    Text("\(seatShortName(p.seat)): \(BalootLabels.project[p.type] ?? p.type)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.emerald)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.black.opacity(0.3))
                        .clipShape(Capsule())
                }
            }
            .padding(.bottom, 4)
        }
        if let balootSeats = hand?.declarations?.baloot, !balootSeats.isEmpty {
            Text("🌟 بلوت: \(balootSeats.map(seatShortName).joined(separator: "، "))")
                .font(.caption2.weight(.bold))
                .foregroundStyle(gold)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color.black.opacity(0.3))
                .clipShape(Capsule())
                .padding(.bottom, 4)
        }
    }

    /// إزاحة ورقة اللفة نحو جهة صاحبها مني (0=أسفل/أنا، 1=يمين، 2=أعلى/شريك، 3=يسار).
    private func trickOffset(for seat: Int) -> CGSize {
        switch relativeIndex(of: seat) {
        case 0: return CGSize(width: 0, height: 52)
        case 1: return CGSize(width: 62, height: 0)
        case 2: return CGSize(width: 0, height: -52)
        default: return CGSize(width: -62, height: 0)
        }
    }

    /// المقعد النسبي لأي مقعد مطلق حولي؛ للمشاهد المقاعد المطلقة نفسها.
    private func relativeIndex(of seat: Int) -> Int {
        guard let my = vm.mySeat else { return seat }
        return (seat - my + 4) % 4
    }

    private var pausedCapsule: some View {
        HStack(spacing: 8) {
            Image(systemName: "pause.circle.fill")
                .foregroundStyle(EMSTheme.Colors.warning)
            Text("متوقفة — انقطع لاعب وبانتظار عودته")
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.85))
            if vm.isSeated {
                Button("أنا عدت") { Task { await vm.reconnectNow() } }
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.teal)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(Color.black.opacity(0.35))
        .clipShape(Capsule())
        .padding(.top, 4)
    }

    private var spectatorCapsule: some View {
        HStack(spacing: 6) {
            Image(systemName: "eye.fill")
                .foregroundStyle(EMSTheme.Colors.teal)
            Text("تشاهد المباراة — لا ترى الأيدي ولا تلعب")
                .font(.caption2)
                .foregroundStyle(Color.white.opacity(0.8))
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(Color.black.opacity(0.3))
        .clipShape(Capsule())
        .padding(.top, 4)
    }

    // MARK: - شريط «أنا» فوق اليد

    private var meBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(podColor)
                .frame(width: 22, height: 22)
                .overlay(Circle().stroke(vm.isMyTurnNow ? gold : gold.opacity(0.3), lineWidth: 1.5))
                .overlay(
                    Text(vm.isSpectator ? "👁" : String(podName(vm.mySeat ?? 0).prefix(1)))
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.white.opacity(0.9))
                )
            Text(vm.isSpectator ? "مشاهدة" : "يدك")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.white.opacity(0.85))
            if vm.isMyTurnNow {
                Text("دورك 🎯")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(gold)
                    .shadow(color: gold.opacity(0.5), radius: 6)
            }
            Spacer()
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 2)
        .animation(.easeInOut(duration: 0.25), value: vm.isMyTurnNow)
    }

    // MARK: - أفعالي كشرائح فوق اليد (من /options فقط)

    @ViewBuilder
    private var actionChips: some View {
        if let opts = vm.options, vm.isSeated, !vm.paused {
            VStack(spacing: 6) {
                // السوق — شرائح أفقية
                if opts.myTurn && (opts.phase == "bidding1" || opts.phase == "bidding2") && !opts.bids.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(opts.bids, id: \.self) { bid in
                                Button {
                                    Task { await vm.bid(kind: bid.kind, trumpSuit: bid.trumpSuit) }
                                } label: {
                                    Text(bidLabel(bid))
                                        .font(.subheadline.weight(.bold))
                                        .padding(.horizontal, 16).frame(height: 40)
                                        .background(bid.kind == "pass" ? Color.black.opacity(0.35) : EMSTheme.Colors.teal)
                                        .foregroundStyle(.white)
                                        .clipShape(Capsule())
                                        .overlay(Capsule().stroke(gold.opacity(bid.kind == "pass" ? 0.3 : 0), lineWidth: 1))
                                }
                            }
                        }
                        .padding(.horizontal, 6)
                    }
                }

                // المشاريع والدبلات أثناء اللعب
                if opts.phase == "playing" && (!opts.projects.isEmpty || !opts.doubles.isEmpty) {
                    HStack(spacing: 6) {
                        ForEach(opts.projects, id: \.self) { p in
                            Button(BalootLabels.project[p.type] ?? p.type) {
                                Task { await vm.declare(p) }
                            }
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 12).frame(height: 32)
                            .background(EMSTheme.Colors.emerald.opacity(0.25))
                            .foregroundStyle(EMSTheme.Colors.emerald)
                            .clipShape(Capsule())
                        }
                        ForEach(opts.doubles, id: \.self) { d in
                            Button(BalootLabels.double[d] ?? d) {
                                Task { await vm.callDouble(d) }
                            }
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 12).frame(height: 32)
                            .background(EMSTheme.Colors.warning.opacity(0.22))
                            .foregroundStyle(EMSTheme.Colors.warning)
                            .clipShape(Capsule())
                        }
                    }
                }
            }
            .padding(.bottom, 2)
        }
    }

    private func bidLabel(_ bid: BalootBidOptionDTO) -> String {
        if bid.kind == "hokum", let s = bid.trumpSuit {
            return "حكم \(BalootLabels.suitSymbol[s] ?? "")"
        }
        return BalootLabels.bidKind[bid.kind] ?? bid.kind
    }

    // MARK: - يدي (مروحة كبيرة أسفل الطاولة)

    @ViewBuilder
    private var handFan: some View {
        if vm.isSeated, let hand = vm.matchState?.hand, let myHand = hand.myHand {
            HStack(spacing: handSpacing(for: myHand.count)) {
                ForEach(Array(myHand.enumerated()), id: \.offset) { index, card in
                    cardButton(card, index: index, total: myHand.count)
                }
            }
            .padding(.top, 10)
            .padding(.bottom, 6)
            .confirmationDialog("بلوت مع هذه الورقة؟", isPresented: Binding(
                get: { pendingCard != nil }, set: { if !$0 { pendingCard = nil } }
            ), titleVisibility: .visible) {
                if let card = pendingCard {
                    Button("العب مع بلوت 🌟") { Task { await vm.playCard(card.code, baloot: true) } }
                    Button("العب عادي") { Task { await vm.playCard(card.code, baloot: false) } }
                    Button("إلغاء", role: .cancel) {}
                }
            }
        }
    }

    /// تداخل المروحة: كلما كثرت الأوراق ضاقت المسافة حتى تملأ عرض الشاشة.
    private func handSpacing(for count: Int) -> CGFloat {
        guard count > 1 else { return 0 }
        // عرض الورقة 64 — نجعل المروحة كلها ضمن ~عرض الجهاز
        return count <= 5 ? 8 : (count <= 7 ? -18 : -26)
    }

    /// ورقة في يدي — قابلة للضغط فقط إن سمح الخادم؛ المسموح مرفوع ومتوهج.
    private func cardButton(_ card: BalootCardDTO, index: Int, total: Int) -> some View {
        let opts = vm.options
        let playing = opts?.phase == "playing" && opts?.myTurn == true
        let allowed = playing && (opts?.cards.contains(card.code) ?? false)
        let canBaloot = allowed && (opts?.balootCards.contains(card.code) ?? false)
        let fanAngle = Double(index - (total - 1) / 2) * 2.5
        return Button {
            if canBaloot { pendingCard = card }
            else if allowed { Task { await vm.playCard(card.code, baloot: false) } }
        } label: {
            cardView(card, size: .hand, enabled: allowed || !playing)
                .rotationEffect(.degrees(fanAngle), anchor: .bottom)
                .offset(y: allowed ? -12 : 0)
                .shadow(color: allowed ? EMSTheme.Colors.teal.opacity(0.55) : .clear,
                        radius: allowed ? 10 : 0)
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: allowed)
        }
        .disabled(!allowed)
        .overlay(alignment: .top) {
            if canBaloot {
                Text("🌟")
                    .font(.caption)
                    .offset(y: -14)
            }
        }
    }

    // MARK: - بطاقة الورقة

    private enum CardSize {
        case medium, hand
        var dims: (CGFloat, CGFloat) {
            switch self {
            case .medium: return (56, 80) // ورقة المركز واللفة
            case .hand: return (64, 94)   // يد اللاعب — كبيرة ومريحة للمس
            }
        }
        var font: Font {
            switch self {
            case .medium: return .body.weight(.bold)
            case .hand: return .title3.weight(.bold)
            }
        }
    }

    private func cardView(_ card: BalootCardDTO, size: CardSize, enabled: Bool) -> some View {
        let (w, h) = size.dims
        return VStack(spacing: 1) {
            Text(card.rankLabel)
                .font(size.font)
            Text(card.suitSymbol)
                .font(size.font)
        }
        .foregroundStyle(card.isRed ? Color(red: 0.85, green: 0.22, blue: 0.22) : Color.black)
        .frame(width: w, height: h)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.black.opacity(0.2), lineWidth: 0.5))
        .opacity(enabled ? 1 : 0.35)
        .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
    }

    // MARK: - أسماء مختصرة

    /// اسم المقعد للعرض — «أنت» لمقعدي، وإلا اسم اللاعب من حالة المباراة/الطاولة.
    private func seatShortName(_ seat: Int) -> String {
        if seat == vm.mySeat { return "أنت" }
        if let s = vm.matchState?.seats?.first(where: { $0.seat == seat }),
           let name = s.name, !name.isEmpty {
            return name
        }
        if let t = vm.table, let row = t.seats.first(where: { $0.seat == seat }), row.occupied {
            return row.name ?? "لاعب"
        }
        return "مقعد \(seat + 1)"
    }

    /// اسم قصير جدًا للمقاعد حول الطاولة — الكلمة الأولى فقط حتى لا تتداخل.
    private func podName(_ seat: Int) -> String {
        let full = seatShortName(seat)
        if full == "أنت" { return full }
        if let first = full.split(separator: " ").first {
            return String(first.prefix(10))
        }
        return full
    }

    // MARK: - النهاية والريماچ

    @ViewBuilder
    private func postMatchSection(_ table: BalootLobbyTableDTO) -> some View {
        EMSCard {
            VStack(spacing: 12) {
                Image(systemName: "flag.checkered")
                    .font(.title)
                    .foregroundStyle(EMSTheme.Colors.warning)
                Text("انتهت المباراة")
                    .font(EMSTheme.titleArabic)
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                if let winner = vm.matchState?.winner {
                    Text(winner == "A" ? "🏆 فريق A" : "🏆 فريق B")
                        .font(EMSTheme.headlineArabic)
                        .foregroundStyle(EMSTheme.Colors.emerald)
                }
                if let s = vm.matchState?.scores {
                    Text("النتيجة النهائية: A ‏\(s.A)‏ — B ‏\(s.B)")
                        .font(.subheadline)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }

                if vm.isSeated && session.permissions.canJoinCommunityActivity {
                    Text("مباراة ثانية؟ تبدأ فقط بموافقة الأربعة — رفض واحد يلغيها")
                        .font(EMSTheme.captionArabic)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .multilineTextAlignment(.center)
                    if vm.rematch != nil {
                        let accepts = vm.rematch?.accepts?.count ?? 0
                        Text("وافق \(accepts) من 4")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.teal)
                    }
                    HStack(spacing: 8) {
                        EMSPrimaryButton(title: iAcceptedRematch ? "✓ وافقت" : "🃏 مباراة ثانية",
                                         isLoading: vm.busy, isDisabled: iAcceptedRematch) {
                            Task { await vm.rematchAccept() }
                        }
                        Button("لا، كفى") { Task { await vm.rematchDecline() } }
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity).frame(height: 50)
                            .background(EMSTheme.Colors.danger.opacity(0.15))
                            .foregroundStyle(EMSTheme.Colors.danger)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                }
            }
        }
    }

    // MARK: - موجز الأحداث

    private var feedSection: some View {
        Group {
            if !vm.feedLines.isEmpty {
                EMSCard {
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(vm.feedLines.suffix(12).enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(EMSTheme.captionArabic)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(.top, 6)
                    } label: {
                        Text("آخر الأحداث (\(vm.feedLines.count))")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    .tint(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    // MARK: - سالفة الطاولة

    private var chatSheet: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(vm.chatMessages) { msg in
                                chatBubble(msg)
                                    .id(msg.id)
                            }
                        }
                        .padding(EMSTheme.pagePadding)
                    }
                    .onChange(of: vm.chatMessages.count) { _ in
                        if let last = vm.chatMessages.last {
                            withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                }
                HStack(spacing: 8) {
                    TextField("اكتب رسالتك…", text: $chatDraft, axis: .vertical)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(EMSTheme.Colors.navySoft)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button {
                        let text = chatDraft
                        chatDraft = ""
                        Task { await vm.sendChat(text) }
                    } label: {
                        Image(systemName: "paperplane.fill")
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(EMSTheme.Colors.teal)
                            .clipShape(Circle())
                    }
                    .disabled(chatDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(EMSTheme.pagePadding)
            }
            .background(EMSBackground())
            .navigationTitle("سالفة الطاولة")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(EMSTheme.Colors.navy, for: .navigationBar)
        }
    }

    private func chatBubble(_ msg: BalootChatMessageDTO) -> some View {
        HStack {
            if msg.mine { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 3) {
                if !msg.mine {
                    Text(msg.author.displayName)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
                Text(msg.content)
                    .font(EMSTheme.bodyArabic)
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(msg.mine ? EMSTheme.Colors.teal.opacity(0.25) : EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if !msg.mine { Spacer(minLength: 40) }
        }
    }

    // MARK: - مؤشر الاتصال

    private var connectionDot: some View {
        Group {
            switch socket.connection {
            case .connected:
                Circle().fill(EMSTheme.Colors.emerald).frame(width: 9, height: 9)
            case .connecting:
                ProgressView().controlSize(.mini)
            default:
                Circle().fill(EMSTheme.Colors.danger).frame(width: 9, height: 9)
            }
        }
        .accessibilityLabel("حالة الاتصال")
    }
}
