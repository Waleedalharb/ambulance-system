//
//  BalootTableView.swift
//  EMSOperations
//
//  شاشة الطاولة — تجربة «أنا جالس على طاولة بلوت» وليست لوحة معلومات:
//   طاولة لباد مركزية بإطار ذهبي · اللاعبون حولها (الشريك مقابلك) ·
//   مؤشر دور واحد authoritative (لا يضيء إلا مقعدًا واحدًا) · يد كبيرة
//   مريحة للمس · السوق والمشاريع والدبلات من /options فقط · النهاية
//   والريماچ · المشاهدة بلا أيدٍ · سالفة الطاولة · أصوات خفيفة تُكتم
//   من قائمة الإعدادات.
//
//  الواجهة لا تعرف قواعد البلوت — تعرض ما يرسله الخادم وتفعّل ما يعيده
//  /options فقط. الممنوع غير قابل للضغط أصلًا.
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

    private let feltTop = Color(red: 0.09, green: 0.30, blue: 0.20)
    private let feltBottom = Color(red: 0.04, green: 0.18, blue: 0.12)
    private let feltRim = Color(red: 0.78, green: 0.62, blue: 0.28) // إطار ذهبي هادئ
    private let podColor = Color(red: 0.03, green: 0.12, blue: 0.09)

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
                        Menu {
                            Button {
                                sound.toggleMuted()
                            } label: {
                                Label(sound.isMuted ? "تشغيل الأصوات" : "كتم الأصوات",
                                      systemImage: sound.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(EMSTheme.Colors.teal)
                        }
                        .accessibilityLabel("إعدادات الطاولة")
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

    // MARK: - المحتوى حسب طور الطاولة

    @ViewBuilder
    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if let err = vm.actionError {
                    EMSErrorView(message: err) { vm.actionError = nil }
                }

                if let table = vm.table {
                    switch table.status {
                    case "open", "ready_check":
                        waitingSection(table)
                    case "in_match":
                        matchSection(table)
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

    // MARK: - طور اللعب

    @ViewBuilder
    private func matchSection(_ table: BalootLobbyTableDTO) -> some View {
        VStack(spacing: EMSTheme.spacing) {
            scoresBar
            feltTable
            if vm.paused { pausedBanner }
            if vm.isSpectator { spectatorNote }
            actionsSection
            myHandSection
        }
    }

    /// شريط النقاط: فريقنا/فريقهم حسب مقعدي (المشاهد يرى A/B) + العقد والصفقة.
    private var scoresBar: some View {
        let myTeam = vm.matchState?.seats?.first(where: { $0.seat == vm.mySeat })?.team
        let scoreA = vm.matchState?.scores?.A ?? 0
        let scoreB = vm.matchState?.scores?.B ?? 0
        let ours = myTeam == "B" ? scoreB : scoreA
        let theirs = myTeam == "B" ? scoreA : scoreB
        return EMSCard {
            HStack {
                scoreChip(title: myTeam == nil ? "فريق A" : "لنا",
                          score: myTeam == nil ? scoreA : ours,
                          color: EMSTheme.Colors.emerald)
                Spacer()
                VStack(spacing: 2) {
                    if let c = vm.matchState?.hand?.contract {
                        Text(BalootLabels.contract(c))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.teal)
                    }
                    Text("صفقة \(vm.matchState?.handNumber ?? 1) · الهدف \(vm.matchState?.targetScore ?? 152)")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    if vm.matchState?.hand?.double != nil {
                        Text("دبل نشط ×\(vm.matchState?.hand?.double?.multiplier ?? 2)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(EMSTheme.Colors.warning)
                    }
                }
                Spacer()
                scoreChip(title: myTeam == nil ? "فريق B" : "لهم",
                          score: myTeam == nil ? scoreB : theirs,
                          color: EMSTheme.Colors.danger)
            }
            .overlay(alignment: .bottom) {
                if vm.spectators > 0 {
                    Text("👁 \(vm.spectators)")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .offset(y: 18)
                }
            }
        }
    }

    private func scoreChip(title: String, score: Int, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            Text("\(score)")
                .font(.title2.weight(.bold))
                .foregroundStyle(color)
        }
    }

    // MARK: - الطاولة (اللباد المركزي)

    /// طاولة اللباد: الشريك أعلى، الخصمان يمين/يسار، أنا أسفل — والوسط للّفة.
    private var feltTable: some View {
        VStack(spacing: 6) {
            seatPod(relative: 2) // الشريك مقابلي
            HStack(alignment: .center, spacing: 4) {
                seatPod(relative: 1) // يميني (RTL: أول عنصر يمين)
                    .frame(width: 86)
                centerStage
                    .frame(maxWidth: .infinity)
                seatPod(relative: 3) // يساري
                    .frame(width: 86)
            }
            seatPod(relative: 0) // أنا (أو المقعد 0 للمشاهد)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 14)
        .background(
            LinearGradient(colors: [feltTop, feltBottom], startPoint: .top, endPoint: .bottom)
        )
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(feltRim.opacity(0.8), lineWidth: 3)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(feltRim.opacity(0.25), lineWidth: 1)
                .padding(6)
        )
        .shadow(color: .black.opacity(0.45), radius: 12, y: 6)
    }

    /// مقعد لاعب حول الطاولة — الاسم + مروحة ظهور الأوراق + توهّج الدور.
    /// مؤشر الدور من vm.activeTurnSeat فقط (مصدر واحد — لا يضيء مقعدان أبدًا).
    private func seatPod(relative: Int) -> some View {
        let seat = vm.displaySeat(relative: relative)
        let isTurn = vm.activeTurnSeat == seat
        let count = vm.matchState?.hand?.handCounts?[String(seat)] ?? 0
        let disconnected = vm.matchState?.hand == nil ? false : false // الانقطاع يظهر عبر بانر الإيقاف
        let name = seatShortName(seat)
        return VStack(spacing: 4) {
            Text(name)
                .font(.caption.weight(isTurn ? .bold : .semibold))
                .foregroundStyle(isTurn ? EMSTheme.Colors.warning : EMSTheme.Colors.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
            if relative != 0 || vm.isSpectator {
                cardBackFan(count: count)
            }
            if isTurn {
                Text("الدور عليه")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.warning)
            }
            if disconnected {
                Text("منقطع")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.danger)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(podColor.opacity(isTurn ? 0.95 : 0.75))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(isTurn ? EMSTheme.Colors.warning : feltRim.opacity(0.25),
                        lineWidth: isTurn ? 2 : 1)
        )
        .shadow(color: isTurn ? EMSTheme.Colors.warning.opacity(0.45) : .clear,
                radius: isTurn ? 10 : 0)
        .animation(.easeInOut(duration: 0.3), value: isTurn)
    }

    /// مروحة ظهور أوراق صغيرة بعدد أوراق اللاعب.
    private func cardBackFan(count: Int) -> some View {
        let shown = min(count, 8)
        return HStack(spacing: -6) {
            ForEach(0..<shown, id: \.self) { i in
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(LinearGradient(colors: [Color(red: 0.16, green: 0.24, blue: 0.45),
                                                  Color(red: 0.10, green: 0.15, blue: 0.30)],
                                         startPoint: .top, endPoint: .bottom))
                    .overlay(
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .stroke(feltRim.opacity(0.5), lineWidth: 0.5)
                    )
                    .frame(width: 14, height: 20)
                    .rotationEffect(.degrees(Double(i - shown / 2) * 4))
                    .zIndex(Double(i))
            }
        }
        .frame(height: 24)
    }

    /// وسط الطاولة: الورقة المكشوفة أثناء السوق، واللفة الحالية أثناء اللعب.
    @ViewBuilder
    private var centerStage: some View {
        let hand = vm.matchState?.hand
        VStack(spacing: 6) {
            if let hand, hand.phase.hasPrefix("bidding"), let faceUp = hand.faceUpCard {
                Text("الورقة المكشوفة")
                    .font(.caption2)
                    .foregroundStyle(Color.white.opacity(0.6))
                cardView(faceUp, size: .medium, enabled: false)
                    .shadow(color: .black.opacity(0.4), radius: 6, y: 3)
            } else if let trick = hand?.currentTrick, !trick.isEmpty {
                HStack(spacing: 10) {
                    ForEach(trick, id: \.seat) { play in
                        VStack(spacing: 3) {
                            cardView(play.card, size: .small, enabled: false)
                                .rotationEffect(.degrees(playAngle(for: play.seat)))
                                .shadow(color: .black.opacity(0.4), radius: 4, y: 2)
                            Text(seatShortName(play.seat))
                                .font(.caption2)
                                .foregroundStyle(Color.white.opacity(0.65))
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                    }
                }
                .padding(.vertical, 4)
            } else {
                Image(systemName: "suit.spade.fill")
                    .font(.largeTitle)
                    .foregroundStyle(Color.white.opacity(0.12))
            }
            if let last = hand?.lastTrick, hand?.currentTrick?.isEmpty != false {
                Text("اللفة السابقة: \(seatShortName(last.winnerSeat))")
                    .font(.caption2)
                    .foregroundStyle(Color.white.opacity(0.6))
            }
            // المشاريع المكشوفة بعد الحسم
            if let decl = hand?.declarations, decl.resolved, let projects = decl.projects, !projects.isEmpty {
                HStack(spacing: 4) {
                    ForEach(Array(projects.enumerated()), id: \.offset) { _, p in
                        Text("\(seatShortName(p.seat)): \(BalootLabels.project[p.type] ?? p.type)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.emerald)
                    }
                }
            }
            if let balootSeats = hand?.declarations?.baloot, !balootSeats.isEmpty {
                Text("🌟 بلوت مثبت: \(balootSeats.map(seatShortName).joined(separator: "، "))")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.warning)
            }
        }
        .frame(minHeight: 110)
        .frame(maxWidth: .infinity)
        .background(Color.black.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(feltRim.opacity(0.2), lineWidth: 1)
        )
    }

    /// ميلان بصري بسيط لورقة اللفة حسب جهة مقعد صاحبها مني.
    private func playAngle(for seat: Int) -> Double {
        guard let mySeat = vm.mySeat else { return [0, -6, 0, 6][seat % 4] }
        let rel = (seat - mySeat + 4) % 4
        return [0, -8, 0, 8][rel]
    }

    private var pausedBanner: some View {
        EMSCard {
            HStack(spacing: 10) {
                Image(systemName: "pause.circle.fill")
                    .foregroundStyle(EMSTheme.Colors.warning)
                Text("المباراة متوقفة — انقطع لاعب وبانتظار عودته أو استبداله")
                    .font(EMSTheme.captionArabic)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                Spacer()
                if vm.isSeated {
                    Button("أنا عدت") { Task { await vm.reconnectNow() } }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
    }

    private var spectatorNote: some View {
        EMSCard {
            HStack(spacing: 10) {
                Image(systemName: "eye.fill")
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text("تشاهد هذه الطاولة — لا ترى أيدي اللاعبين ولا تستطيع اللعب")
                    .font(EMSTheme.captionArabic)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                Spacer()
            }
        }
    }

    // MARK: - أفعالي (من /options فقط)

    @ViewBuilder
    private var actionsSection: some View {
        if let opts = vm.options, vm.isSeated, !vm.paused {
            VStack(spacing: 8) {
                // السوق
                if opts.myTurn && (opts.phase == "bidding1" || opts.phase == "bidding2") && !opts.bids.isEmpty {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("دورك في السوق")
                                .font(EMSTheme.headlineArabic)
                                .foregroundStyle(EMSTheme.Colors.warning)
                            ForEach(opts.bids, id: \.self) { bid in
                                Button {
                                    Task { await vm.bid(kind: bid.kind, trumpSuit: bid.trumpSuit) }
                                } label: {
                                    HStack {
                                        Text(bidLabel(bid))
                                            .font(.body.weight(.semibold))
                                        Spacer()
                                        if let hint = BalootLabels.bidHint[bid.kind] {
                                            Text(hint)
                                                .font(.caption2)
                                                .foregroundStyle(EMSTheme.Colors.textMuted)
                                        }
                                    }
                                    .padding(.horizontal, 14).frame(height: 44)
                                    .background(bid.kind == "pass" ? EMSTheme.Colors.navySoft : EMSTheme.Colors.teal.opacity(0.85))
                                    .foregroundStyle(.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                }
                            }
                        }
                    }
                }

                // المشاريع والدبلات (أثناء اللعب)
                if opts.phase == "playing" && (!opts.projects.isEmpty || !opts.doubles.isEmpty) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            if !opts.projects.isEmpty {
                                Text("عندك مشروع؟ أعلنه قبل أول ورقة لك")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(EMSTheme.Colors.emerald)
                                HStack(spacing: 6) {
                                    ForEach(opts.projects, id: \.self) { p in
                                        Button(BalootLabels.project[p.type] ?? p.type) {
                                            Task { await vm.declare(p) }
                                        }
                                        .font(.caption.weight(.bold))
                                        .padding(.horizontal, 12).frame(height: 34)
                                        .background(EMSTheme.Colors.emerald.opacity(0.2))
                                        .foregroundStyle(EMSTheme.Colors.emerald)
                                        .clipShape(Capsule())
                                    }
                                }
                            }
                            if !opts.doubles.isEmpty {
                                HStack(spacing: 6) {
                                    ForEach(opts.doubles, id: \.self) { d in
                                        Button(BalootLabels.double[d] ?? d) {
                                            Task { await vm.callDouble(d) }
                                        }
                                        .font(.caption.weight(.bold))
                                        .padding(.horizontal, 12).frame(height: 34)
                                        .background(EMSTheme.Colors.warning.opacity(0.18))
                                        .foregroundStyle(EMSTheme.Colors.warning)
                                        .clipShape(Capsule())
                                    }
                                }
                            }
                        }
                    }
                }

                // دوري في اللعب — توجيه واضح (من نفس مصدر الدور الواحد)
                if vm.isMyTurnNow, opts.phase == "playing" {
                    Text("🎯 دورك — اضغط ورقة من يدك بالأسفل")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.warning)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(EMSTheme.Colors.warning.opacity(0.10))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                // إنهاء ودي
                if vm.matchStatus == "active" {
                    Button("تصويت إنهاء ودي") { confirmAbort = true }
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    private func bidLabel(_ bid: BalootBidOptionDTO) -> String {
        if bid.kind == "hokum", let s = bid.trumpSuit {
            return "حكم \(BalootLabels.suitSymbol[s] ?? "") \(BalootLabels.suitName[s] ?? "")"
        }
        return BalootLabels.bidKind[bid.kind] ?? bid.kind
    }

    // MARK: - يدي

    @ViewBuilder
    private var myHandSection: some View {
        if vm.isSeated, let hand = vm.matchState?.hand, let myHand = hand.myHand {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("يدك (\(myHand.count))")
                        .font(EMSTheme.headlineArabic)
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if vm.isMyTurnNow, hand.phase == "playing" {
                        Text("دورك")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(EMSTheme.Colors.warning)
                    }
                }
                .padding(.horizontal, 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(myHand, id: \.code) { card in
                            cardButton(card)
                        }
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 4)
                }
            }
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

    /// ورقة قابلة للضغط فقط إن كانت ضمن خيارات الخادم — الممنوع معطّل بصريًا.
    private func cardButton(_ card: BalootCardDTO) -> some View {
        let opts = vm.options
        let playing = opts?.phase == "playing" && opts?.myTurn == true
        let allowed = playing && (opts?.cards.contains(card.code) ?? false)
        let canBaloot = allowed && (opts?.balootCards.contains(card.code) ?? false)
        return Button {
            if canBaloot { pendingCard = card }
            else if allowed { Task { await vm.playCard(card.code, baloot: false) } }
        } label: {
            cardView(card, size: .large, enabled: allowed || !playing)
                .offset(y: allowed ? -8 : 0)
                .shadow(color: allowed ? EMSTheme.Colors.teal.opacity(0.5) : .clear,
                        radius: allowed ? 8 : 0)
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: allowed)
        }
        .disabled(!allowed)
        .overlay(alignment: .top) {
            if canBaloot {
                Text("🌟")
                    .font(.caption)
                    .offset(y: -12)
            }
        }
    }

    // MARK: - بطاقة الورقة

    private enum CardSize { case small, medium, large
        var dims: (CGFloat, CGFloat) {
            switch self {
            case .small: return (42, 60)
            case .medium: return (54, 78)
            case .large: return (62, 90) // كبيرة ومريحة للمس
            }
        }
        var font: Font {
            switch self {
            case .small: return .subheadline.weight(.bold)
            case .medium: return .body.weight(.bold)
            case .large: return .title3.weight(.bold)
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
