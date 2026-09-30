//
//  BalootTableView.swift
//  EMSOperations
//
//  شاشة الطاولة — «مجلس سعودي فاخر + طاولة بلوت حقيقية + هوية قطاع الجنوب»:
//   أثناء المباراة تصبح الشاشة مشهد مجلس حقيقيًا: الأصل المرسوم (سدو ودلة
//   وفانوس وشنطة إسعاف ولاسلكي وطاولة لباد بإطار خشبي ذهبي — baloot_majlis_bg)
//   هو المسرح، وعناصر اللعب (مقاعد/أوراق/يد) مكونات SwiftUI حقيقية تجلس داخل
//   حدود اللباد المرسوم نفسه عبر feltRect — لا طبقات خضراء ولا إطارات مكررة.
//   صاحب الدور يتوهج بتوهج ذهبي ناعم واحد (vm.activeTurnSeat —
//   مصدر authoritative وحيد). الأوراق كريمية معتمة 100% كأنها ورق حقيقي،
//   والرتب بأسمائها البلوتية (شايب/بنت/ولد/إكّه).
//
//  الواجهة لا تعرف قواعد البلوت — تعرض ما يرسله الخادم وتفعّل ما يعيده
//  /options فقط. لا تغيير في أي منطق لعب أو صوت أو أحداث — UI فقط.
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
    // طبقة الفيزياء (المرحلة 03) — عرض صرف فوق حالة الخادم
    @StateObject private var director = BalootTrickDirector()
    @State private var balootFlashSeen = 0
    @State private var showBalootText = false
    @State private var scorePanelSeen = 0
    @State private var showScorePanel = false
    /// ورقة لعبتُها محليًا بانتظار صدى الخادم — تُخفى من المروحة فورًا
    /// (الاختفاء = بداية الرمي، إصلاح 4/8) وتعود فقط عند إلغاء حوار
    /// البلوت أو رفض الخادم.
    @State private var locallyPlayedCode: String? = nil
    // توزيع الخصوم ظهرًا لأعلى (§5 / المرجع 21.0) — رحلات ظهر أزرق من
    // المركز إلى مقاعدهم فوق عدّادات الخادم، عرض صرف بلا أي منطق لعب.
    @State private var dealBacks: [BalootFlightCard] = []
    @State private var dealBacksHand = 0
    @State private var dealCounts: [Int: Int] = [:]
    @State private var dealGen = 0
    // HUD (المرحلة 04 — v1.1): إعلان العقد الذهبي + انفجار زات الحكم +
    // وضع اختيار الزات (خطوة عرض محلية بلا أي منطق قواعد)
    @State private var showContractText = false
    @State private var showTrumpBurst = false
    @State private var suitPickMode = false

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

    // MARK: - ألوان المشهد (الهوية فوق أصل المجلس المرسوم)

    private let gold = Color(red: 0.82, green: 0.66, blue: 0.32)
    private let podColor = Color(red: 0.05, green: 0.09, blue: 0.08)
    /// أخضر مؤشر الدور وشارة «الموزع» (v1.1 §2 — الحلقة الخضراء من turnSeat).
    private let turnGreen = Color(red: 0.20, green: 0.78, blue: 0.42)

    var body: some View {
        content
            .emsPage("طاولة بلوت #\(tableId)")
            // أثناء المباراة: لا شريط تنقّل ولا Tab Bar — المشهد يملأ الشاشة من
            // أعلى Safe Area إلى أسفلها، والهيدر يصبح Overlay عائمًا فوق المجلس.
            .toolbarBackground(vm.table?.isInMatch == true ? .hidden : .visible, for: .navigationBar)
            .toolbar(vm.table?.isInMatch == true ? .hidden : .visible, for: .navigationBar)
            .toolbar(vm.table?.isInMatch == true ? .hidden : .visible, for: .tabBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 14) {
                        connectionDot
                        // أثناء المباراة تنتقل السوالف والقائمة إلى الشريط السفلي
                        if vm.table?.isInMatch != true {
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

    /// قائمة الطاولة (خارج المباراة — في التولبار).
    private var tableMenu: some View {
        Menu {
            tableMenuItems
        } label: {
            Image(systemName: "ellipsis.circle")
                .foregroundStyle(EMSTheme.Colors.teal)
        }
        .accessibilityLabel("إعدادات الطاولة")
    }

    /// عناصر قائمة الطاولة: الصوت (كتم/تجربة) + الإنهاء الودي أثناء المباراة —
    /// تُستخدم في التولبار خارج المباراة وفي الشريط السفلي داخلها.
    @ViewBuilder
    private var tableMenuItems: some View {
        Button {
            sound.toggleMuted()
        } label: {
            Label(sound.isMuted ? "تشغيل الأصوات" : "كتم الأصوات",
                  systemImage: sound.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
        }
        Button {
            sound.playTest()
        } label: {
            Label(sound.loadedCount > 0 ? "تجربة الصوت" : "الأصوات غير محمّلة (\(sound.loadedCount)/\(BalootSoundService.Effect.allCases.count))",
                  systemImage: "speaker.badge.plus")
        }
        if vm.table?.isInMatch == true, vm.isSeated, vm.matchStatus == "active" {
            Divider()
            Button(role: .destructive) { confirmAbort = true } label: {
                Label("تصويت إنهاء ودي", systemImage: "hand.raised.fill")
            }
        }
    }

    // MARK: - المحتوى حسب طور الطاولة

    @ViewBuilder
    private var content: some View {
        if let table = vm.table, table.isInMatch {
            // أثناء المباراة: الشاشة كلها مشهد المجلس — بلا تمرير وبلا بطاقات.
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

    // MARK: - شاشة المباراة (مشهد المجلس)

    /// المشهد الكامل: الأصل المرسوم هو المسرح، وعناصر اللعب تجلس داخل اللباد
    /// بإحداثيات محسوبة من feltRect، واليد تتراكب على الحافة السفلية للطاولة.
    private func matchScreen(_ table: BalootLobbyTableDTO) -> some View {
        GeometryReader { geo in
            let felt = feltRect(in: geo.size)
            let arena = BalootArenaGeometry(felt: felt)
            ZStack {
                // خلفية المجلس: الأصل المرسوم كما هو — لا إطار ولا لباد مكرر فوقه
                majlisBackdrop

                // ساحة اللعب: اللاعبون والمركز داخل حدود اللباد المرسوم نفسه
                tableArena(felt: felt)

                // HUD علوي كتدفق مرن بعرض الشاشة: هيدر عائم ← شريط النقاط
                // (مع معلومات الجولة وسطه) ← الحالات ← آخر حدث ← اللاعب
                // العلوي أسفلها مباشرة (لا position ثابت — لا قصّ ولا تداخل).
                VStack(spacing: 6) {
                    floatingHeader
                    scoreStrip
                    if let err = vm.actionError {
                        Text(err)
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.danger)
                            .lineLimit(1)
                            .onTapGesture { vm.actionError = nil }
                    }
                    if vm.paused { pausedCapsule }
                    if vm.isSpectator { spectatorCapsule }
                    // (v1.1 / P-H11) lastEventLine أُزيل — المزايدات تظهر
                    // فقاعاتٍ بجانب كل مقعد من hand.bids بدل سطر الأحداث.
                    // اللاعب العلوي أسفل الـHUD بمسافة مريحة — لا تداخل أبدًا
                    seatPod(relative: 2)
                        .padding(.top, 6)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16)
                .padding(.top, 56)

                // اليد والأفعال عند الحافة السفلية للطاولة — تتراكب على الإطار الخشبي
                VStack(spacing: 6) {
                    Spacer()
                    actionChips
                    handFan(felt: felt, containerWidth: geo.size.width)
                }
                .padding(.bottom, max(0, geo.size.height - felt.maxY - 14))

                // الشريط السفلي: كبسولة «يدك» يمينًا · سوالف/صوت/قائمة يسارًا
                VStack {
                    Spacer()
                    bottomBar
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 6)

                // طبقة الفيزياء: كل الأوراق الطائرة فوق المشهد كله (§2/§4/§5)
                BalootFlightOverlay(flights: director.flights)
                    .frame(width: geo.size.width, height: geo.size.height)

                // توزيع الخصوم: أوراق ظهر زرقاء من المركز لمقاعدهم (§5)
                BalootFlightOverlay(flights: dealBacks)
                    .frame(width: geo.size.width, height: geo.size.height)

                // نص «بلوت» الذهبي فوق منطقة اللعب (§7)
                if showBalootText {
                    let balootLifetime = BalootGestureTuning().balootTextLifetime
                    BalootGoldenEventText(text: "بلوت", lifetime: balootLifetime)
                        .position(arena.clusterCenter)
                }

                // إعلان العقد الذهبي فوق يدي (v1.1 §6) — مدة TEMPORARY (P-P8)
                if showContractText, let c = vm.matchState?.hand?.contract {
                    let contractText = BalootLabels.contract(c)
                    let contractLifetime = BalootGestureTuning().balootTextLifetime
                    let contractPos = CGPoint(x: felt.midX, y: felt.maxY - 70)
                    BalootGoldenEventText(text: contractText, lifetime: contractLifetime)
                        .position(contractPos)
                }

                // انفجار زات الحكم الذهبي وسط الطاولة (v1.1 §5) — TEMPORARY (P-P8)
                if showTrumpBurst, let ts = vm.matchState?.hand?.contract?.trumpSuit {
                    let trumpSymbol = BalootLabels.suitSymbol[ts] ?? ""
                    Text(trumpSymbol)
                        .font(.system(size: 96, weight: .heavy))
                        .foregroundStyle(gold)
                        .shadow(color: gold.opacity(0.8), radius: 24)
                        .shadow(color: .black.opacity(0.6), radius: 8, y: 3)
                        .position(arena.clusterCenter)
                }

                // لوحة الحسبة بعد فجوة مسح الطاولة (§8)
                if showScorePanel, let detail = vm.handScore {
                    let panelScores = vm.matchState?.scores
                    BalootScorePanelView(detail: detail, myTeam: myTeam, scores: panelScores) {
                        withAnimation(.easeInOut(duration: 0.25)) { showScorePanel = false }
                    }
                }
            }
            .onAppear {
                syncDirector(arena: arena)
                syncDealBacks(arena: arena)
            }
            .onChange(of: vm.matchState?.hand) { _ in
                syncDirector(arena: arena)
                syncDealBacks(arena: arena)
            }
            .onChange(of: vm.balootFlashToken) { token in
                guard token != balootFlashSeen else { return }
                balootFlashSeen = token
                showBalootText = true
                // إزالة العنصر بعد انتهاء ظهوره (المدة TEMPORARY — P-P8)
                // (تفكيك الحساب لخطوات — إصلاح type-check فقط، نفس المدة حرفيًا)
                let lifetime = BalootGestureTuning().balootTextLifetime
                let delay = lifetime + 0.5
                let nanoseconds = UInt64(delay * 1_000_000_000)
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: nanoseconds)
                    showBalootText = false
                }
            }
            .onChange(of: vm.handScoreToken) { token in
                guard token != scorePanelSeen else { return }
                scorePanelSeen = token
                // فجوة مسح الطاولة ≈1.1ث ثم تظهر اللوحة (§8)
                // (تفكيك الحساب لخطوات — إصلاح type-check فقط، نفس المدة حرفيًا)
                let scorePanelDelay = BalootPhysics.scorePanelDelay
                let scorePanelNanoseconds = UInt64(scorePanelDelay * 1_000_000_000)
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: scorePanelNanoseconds)
                    guard vm.handScore != nil else { return }
                    withAnimation(.easeInOut(duration: 0.3)) { showScorePanel = true }
                }
            }
            .onChange(of: vm.handScore != nil) { hasScore in
                if !hasScore { withAnimation(.easeInOut(duration: 0.25)) { showScorePanel = false } }
            }
            // صدى الخادم: الورقة غادرت يدي فعلًا → أنهِ الإخفاء المحلي
            .onChange(of: vm.matchState?.hand?.myHand) { newHand in
                if let code = locallyPlayedCode,
                   !(newHand?.contains(where: { $0.code == code }) ?? false) {
                    locallyPlayedCode = nil
                }
            }
            // رفض الخادم للعب → أعد إظهار الورقة في المروحة
            .onChange(of: vm.actionError) { err in
                if err != nil { locallyPlayedCode = nil }
            }
            // ظهور العقد (nil→قيمة): إعلان ذهبي فوق يدي + انفجار الزات إن كان حكمًا
            .onChange(of: vm.matchState?.hand?.contract == nil) { isNil in
                guard !isNil else { return }
                showContractText = true
                let burst = vm.matchState?.hand?.contract?.trumpSuit != nil
                if burst { showTrumpBurst = true }
                // (تفكيك الحساب لخطوات — إصلاح type-check فقط، نفس المدة حرفيًا)
                let contractLifetime = BalootGestureTuning().balootTextLifetime
                let contractDelay = contractLifetime + 0.5
                let contractNanoseconds = UInt64(contractDelay * 1_000_000_000)
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: contractNanoseconds)
                    showContractText = false
                }
                if burst {
                    Task { @MainActor in
                        // ⚠️ TEMPORARY (P-P8) — مدة انفجار الزات ≈1.5–2ث مرصودة (0:17.7→0:19.6)
                        try? await Task.sleep(nanoseconds: 1_900_000_000)
                        withAnimation(.easeInOut(duration: 0.3)) { showTrumpBurst = false }
                    }
                }
            }
            // تغيّر مرحلة السوق أو انتهاء دوري → اخرج من وضع اختيار الزات
            .onChange(of: vm.options?.phase) { _ in suitPickMode = false }
            .onChange(of: vm.options?.myTurn) { turn in if turn != true { suitPickMode = false } }
            .onDisappear { director.stop() }
        }
        .ignoresSafeArea()
    }

    /// مزامنة موجّه الأكلة مع حالة الخادم — عرض صرف بلا منطق.
    private func syncDirector(arena: BalootArenaGeometry) {
        let hand = vm.matchState?.hand
        director.sync(currentTrick: hand?.currentTrick,
                      lastTrick: hand?.lastTrick,
                      tricksCount: hand?.tricksCount,
                      handNumber: vm.matchState?.handNumber,
                      mySeat: vm.mySeat,
                      geo: arena)
    }

    /// توزيع الخصوم ظهرًا لأعلى (§5 / المرجع 21.0): مع بداية الصفقة تطير
    /// أوراق زرقاء الظهر من مركز الطاولة إلى مقاعد الخصوم بنفس إيقاع توزيع
    /// يد اللاعب — بلا Flip وبلا Assets جديدة (نفس تدرج miniCardBacks).
    /// عرض صرف فوق عدّادات الخادم (handCounts) — لا يغيّر أي حالة لعب.
    private func syncDealBacks(arena: BalootArenaGeometry) {
        guard let match = vm.matchState, let hand = match.hand,
              let hn = match.handNumber, hn > 0 else { return }
        // صفقة جديدة: صفّر المتتبع
        if hn != dealBacksHand {
            dealBacksHand = hn
            dealCounts = [:]
        }
        // التوزيع يُعرض فقط قبل أول أكلة من الصفقة
        guard (hand.tricksCount ?? 0) == 0, (hand.currentTrick?.isEmpty ?? true) else { return }

        var added = 0
        var seq = dealCounts.values.reduce(0, +)
        for seat in 0..<4 where seat != vm.mySeat {
            let count = hand.handCounts?[String(seat)] ?? 0
            let prev = dealCounts[seat] ?? 0
            guard count > prev else { continue }
            for i in prev..<count {
                let tilt: Double = (i % 2 == 0 ? 1 : -1) * BalootPhysics.dealTilt
                dealBacks.append(BalootFlightCard(
                    // ورقة placeholder — لا تُعرض إطلاقًا (faceDown = ظهر أزرق)
                    card: BalootCardDTO(code: "S7", suit: nil, rank: nil),
                    seat: seat,
                    from: arena.clusterCenter,
                    to: arena.seatOrigin(relative: relativeIndex(of: seat)),
                    fromScale: 1.0, toScale: 1.0,
                    fromAngle: tilt, toAngle: 0,
                    duration: BalootPhysics.dealFlightDuration,
                    delay: Double(seq) * BalootPhysics.dealStagger,
                    fadeOut: true, faceDown: true))
                seq += 1
                added += 1
            }
            dealCounts[seat] = count
        }
        guard added > 0 else { return }
        // نظّف الرحلات بعد اكتمال آخر طيران (آخر تأخير + المدة + هامش)
        let lifetime = Double(seq) * BalootPhysics.dealStagger + BalootPhysics.dealFlightDuration + 0.2
        let lifetimeNanoseconds = UInt64(lifetime * 1_000_000_000)
        dealGen += 1
        let gen = dealGen
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: lifetimeNanoseconds)
            guard gen == dealGen else { return }
            dealBacks = []
        }
    }

    /// فريقي من حالة المباراة — لعرض أعمدة لوحة الحسبة (لنا/لهم).
    private var myTeam: String? {
        vm.matchState?.seats?.first(where: { $0.seat == vm.mySeat })?.team
    }

    /// حدود اللباد المرسوم داخل الصورة (1024×2048) محسوبة على الشاشة مع
    /// scaledToFill — حتى تجلس عناصر اللعب فوق اللباد الحقيقي لا فوق الخشب
    /// أو السدو، على أي مقاس آيفون.
    private func feltRect(in size: CGSize) -> CGRect {
        let imgW: CGFloat = 1024, imgH: CGFloat = 2048
        let scale = max(size.width / imgW, size.height / imgH)
        let drawnW = imgW * scale, drawnH = imgH * scale
        let originX = (size.width - drawnW) / 2
        let originY = (size.height - drawnH) / 2
        // نِسب اللباد داخل الصورة: يسار/يمين/أعلى/أسفل (مقاسة آليًا من الأصل)
        let l: CGFloat = 0.160, r: CGFloat = 0.851, t: CGFloat = 0.313, b: CGFloat = 0.845
        return CGRect(x: originX + l * drawnW,
                      y: originY + t * drawnH,
                      width: (r - l) * drawnW,
                      height: (b - t) * drawnH)
    }

    /// خلفية المجلس السعودي: أصل رسومي حقيقي (سدو/دلة/فانوس/شنطة إسعاف/لاسلكي/
    /// طاولة لباد بإطار خشبي ذهبي) + تظليل علوي وسفلي خفيف يضمن وضوح العناصر.
    private var majlisBackdrop: some View {
        ZStack {
            Image("baloot_majlis_bg")
                .resizable()
                .scaledToFill()
                .ignoresSafeArea()
            LinearGradient(colors: [Color.black.opacity(0.30), .clear, .clear, Color.black.opacity(0.40)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        }
    }

    /// شريط النتيجة حسب المرجع (v1.1 §1): «لهم X : X لنا» بسطر واحد يمينًا —
    /// لهم أحمر / لنا أخضر. لا عناصر إضافية (بقرار المالك في المراجعة
    /// النهائية قبل الرفع). نقاط الصفقة الجارية لا تُعرض — P-H2 PENDING.
    private var scoreStrip: some View {
        let myTeam = vm.matchState?.seats?.first(where: { $0.seat == vm.mySeat })?.team
        let scoreA = vm.matchState?.scores?.A ?? 0
        let scoreB = vm.matchState?.scores?.B ?? 0
        let ours = myTeam == "B" ? scoreB : scoreA
        let theirs = myTeam == "B" ? scoreA : scoreB
        let shownTheirs = myTeam == nil ? scoreB : theirs
        let shownOurs = myTeam == nil ? scoreA : ours
        return HStack {
            // «لهم X : X لنا» — أول عنصر في يمين الشريط في RTL كما في المرجع
            HStack(spacing: 5) {
                Text("لهم")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.danger)
                Text("\(shownTheirs)")
                    .font(.headline.weight(.heavy))
                    .foregroundStyle(EMSTheme.Colors.danger)
                Text(":")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.white.opacity(0.65))
                Text("\(shownOurs)")
                    .font(.headline.weight(.heavy))
                    .foregroundStyle(EMSTheme.Colors.emerald)
                Text("لنا")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.emerald)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 7)
        .background(Color.black.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(gold.opacity(0.3), lineWidth: 1)
        )
        .frame(maxWidth: .infinity)
    }

    /// (أُزيل lastEventLine في المرحلة 04 — v1.1 / P-H11.)

    // MARK: - ساحة الطاولة (المقاعد + المركز داخل اللباد)

    /// اللاعبان الجانبان والمركز داخل اللباد بإحداثياته — الشريك العلوي في
    /// تدفق الـHUD.
    private func tableArena(felt: CGRect) -> some View {
        ZStack {
            centerStage
                .frame(width: felt.width * 0.62, height: felt.height * 0.45)
                .position(x: felt.midX, y: felt.midY - felt.height * 0.03)

            seatPod(relative: 1) // يميني
                .position(x: felt.maxX - 48, y: felt.midY - felt.height * 0.08)

            seatPod(relative: 3) // يساري
                .position(x: felt.minX + 48, y: felt.midY - felt.height * 0.08)
        }
    }

    /// مقعد لاعب (v1.1 §2): أفاتار + اسم + ظهور أوراقه + شارة «الموزع»
    /// الخضراء (dealerSeat) + علامة حكم ذهبية للمشتري (contract) + فقاعة
    /// مزايدته الأخيرة أثناء السوق (hand.bids) — وحلقة خضراء لصاحب الدور
    /// (turnSeat فقط؛ لا عدّ رقمي — P-H4).
    private func seatPod(relative: Int) -> some View {
        let seat = vm.displaySeat(relative: relative)
        let isTurn = vm.activeTurnSeat == seat
        let hand = vm.matchState?.hand
        let count = hand?.handCounts?[String(seat)] ?? 0
        let name = podName(seat)
        return VStack(spacing: 2) {
            seatAvatar(seat: seat, name: name, isTurn: isTurn)
                .overlay(alignment: .top) {
                    bidBubble(seat: seat, hand: hand).offset(y: -28)
                }
            HStack(spacing: 4) {
                Text(name)
                    .font(.caption2.weight(isTurn ? .bold : .medium))
                    .foregroundStyle(isTurn ? turnGreen : Color.white.opacity(0.85))
                    .lineLimit(1)
                // علامة الحكم الذهبية بجانب المشتري طوال الصفقة (v1.1 §5)
                if hand?.contract?.buyerSeat == seat, let ts = hand?.contract?.trumpSuit {
                    let buyerSymbol = BalootLabels.suitSymbol[ts] ?? ""
                    Text(buyerSymbol)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(gold)
                }
            }
            .frame(width: 76)
            // شارة «الموزع» الخضراء (v1.1 §2) — من dealerSeat
            if hand?.dealerSeat == seat {
                Text("الموزع")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(turnGreen)
                    .clipShape(Capsule())
            }
            if count > 0 {
                miniCardBacks(count: count)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: isTurn)
    }

    /// فقاعة مزايدة اللاعب الأخيرة أثناء السوق (v1.1 §3 / P-H11): كريمية
    /// بجانب الأفاتار — من hand.bids الموجودة فعليًا فقط، وتختفي مع بدء
    /// اللعب. التسمية بمعنى الحدث الأصلي فقط — بلا إعادة تسمية حسب الجولة
    /// الجارية (بقرار المالك في المراجعة النهائية).
    @ViewBuilder
    private func bidBubble(seat: Int, hand: BalootHandDTO?) -> some View {
        if let hand, hand.phase.hasPrefix("bidding"),
           let bid = hand.bids?.last(where: { $0.seat == seat }) {
            let bubbleText = bubbleLabel(bid)
            Text(bubbleText)
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color(red: 0.25, green: 0.20, blue: 0.14))
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Color(red: 0.98, green: 0.94, blue: 0.84))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .shadow(color: .black.opacity(0.35), radius: 3, y: 2)
                .fixedSize()
        }
    }

    /// تسمية المزايدة داخل الفقاعة — معنى الحدث كما ورد من الخادم فقط.
    /// ⚠️ Data Gap موثقة: BalootBidDTO لا يحمل round metadata، لذا التمييز
    /// بين «بس/ولا» و«حكم/حكم ثاني» حسب جولة الحدث غير ممكن بلا تخمين —
    /// تُعرض التسمية القياسية دائمًا (PENDING بقرار المالك).
    private func bubbleLabel(_ bid: BalootBidDTO) -> String {
        switch bid.kind {
        case "pass": return "بس"
        case "sun": return "صن"
        case "ashkal": return "أشكل"
        case "hokum":
            let sym = bid.trumpSuit.flatMap { BalootLabels.suitSymbol[$0] } ?? ""
            return "حكم" + (sym.isEmpty ? "" : " \(sym)")
        default: return bid.kind
        }
    }

    /// صورة اللاعب: صورة الموظف إن وُجدت (AsyncImage) وإلا حرف اسمه —
    /// نفس الدائرة والتوهج الذهبي لصاحب الدور في الحالتين. لا حرف فوق الصورة.
    private func seatAvatar(seat: Int, name: String, isTurn: Bool) -> some View {
        ZStack {
            if let url = seatAvatarUrl(seat) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        avatarLetter(name, isTurn: isTurn)
                    }
                }
            } else {
                avatarLetter(name, isTurn: isTurn)
            }
        }
        .frame(width: 46, height: 46)
        .background(podColor.opacity(0.9))
        .clipShape(Circle())
        // حلقة الدور الخضراء (v1.1 §2/P-H4) — من turnSeat فقط، بلا عدّ رقمي
        .overlay(
            Circle()
                .stroke(isTurn ? turnGreen : gold.opacity(0.45), lineWidth: isTurn ? 2.5 : 1.5)
        )
        .shadow(color: isTurn ? turnGreen.opacity(0.55) : .clear, radius: isTurn ? 9 : 0)
    }

    /// حرف الاسم — شكل الـfallback والحالة الحالية حتى يوفر الخادم الصور.
    private func avatarLetter(_ name: String, isTurn: Bool) -> some View {
        Text(String(name.prefix(1)))
            .font(.headline.weight(.bold))
            .foregroundStyle(isTurn ? turnGreen : Color.white.opacity(0.9))
    }

    /// رابط صورة المقعد من حالة المباراة ثم بطاقة اللوبي — المسارات النسبية
    /// تُحوَّل إلى رابط كامل على نفس خادم الـAPI. nil = fallback للحرف.
    private func seatAvatarUrl(_ seat: Int) -> URL? {
        let raw = vm.matchState?.seats?.first(where: { $0.seat == seat })?.avatarUrl
            ?? vm.table?.seats.first(where: { $0.seat == seat })?.avatarUrl
        guard let raw, !raw.isEmpty else { return nil }
        if raw.hasPrefix("http") { return URL(string: raw) }
        return URLComponents(url: AppEnvironment.current.baseURL.appending(path: raw),
                             resolvingAgainstBaseURL: false)?.url
    }

    /// ظهور أوراق زرقاء صغيرة بعدد أوراق اللاعب — كما في جلسات البلوت.
    private func miniCardBacks(count: Int) -> some View {
        let shown = min(count, 8)
        return HStack(spacing: -5) {
            ForEach(0..<shown, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(LinearGradient(colors: [Color(red: 0.15, green: 0.28, blue: 0.60),
                                                  Color(red: 0.08, green: 0.16, blue: 0.38)],
                                         startPoint: .top, endPoint: .bottom))
                    .overlay(
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .stroke(Color.white.opacity(0.25), lineWidth: 0.5)
                    )
                    .frame(width: 10, height: 15)
                    .rotationEffect(.degrees(Double(i - shown / 2) * 5))
                    .zIndex(Double(i))
            }
        }
        .frame(height: 17)
    }

    /// مركز الطاولة: الورقة المكشوفة في السوق، واللفة موزعة باتجاه أصحابها
    /// في اللعب — أوراق معتمة 100% كورق حقيقي. (هوية القطاع منفصلة أسفل
    /// المركز في tableArena حتى لا تغطيها الأوراق.)
    @ViewBuilder
    private var centerStage: some View {
        let hand = vm.matchState?.hand
        ZStack {
            if let hand, hand.phase.hasPrefix("bidding"), let faceUp = hand.faceUpCard {
                VStack(spacing: 4) {
                    Text("الورقة المكشوفة")
                        .font(.caption2)
                        .foregroundStyle(Color.white.opacity(0.6))
                    cardView(faceUp, size: .medium, dimmed: false)
                        .shadow(color: .black.opacity(0.5), radius: 8, y: 4)
                        .transition(.scale(scale: 0.7).combined(with: .opacity))
                }
            } else if !director.settled.isEmpty {
                // عنقود الأكلة (§3): تداخل غير منتظم — انحراف ضيق نحو جهة
                // صاحبها + ميلان استقرار ثابت ±5°–15°، z-order بترتيب اللعب.
                // الوصول/المغادرة عبر طبقة الطيران (الموجّه) لا عبر transitions.
                ForEach(Array(director.settled.enumerated()), id: \.offset) { index, play in
                    cardView(play.card, size: .medium, dimmed: false)
                        .shadow(color: .black.opacity(0.5), radius: 5, y: 3)
                        .rotationEffect(.degrees(BalootPhysics.steadyTilt(card: play.card.code,
                                                                          seat: play.seat,
                                                                          range: BalootPhysics.restTilt)))
                        .offset(BalootArenaGeometry.clusterOffset(relative: relativeIndex(of: play.seat)))
                        .zIndex(Double(index))
                }
            } else if !director.isCollecting, let last = hand?.lastTrick {
                // نص اللفة السابقة يُخفى طوال انتقال الجمع (ورقة رابعة → فجوة
                // التقييم → جمع) حتى يكون الانتقال نظيفًا بلا أي حالة قديمة.
                Text("اللفة السابقة: \(seatShortName(last.winnerSeat))")
                    .font(.caption2)
                    .foregroundStyle(Color.white.opacity(0.55))
            }

            // علامة الحكم الصغيرة تحت المركز طوال الصفقة (v1.1 §5) —
            // من contract.trumpSuit؛ حمراء للزات الحمراء كما في المرجع.
            if hand?.phase == "playing", let ts = hand?.contract?.trumpSuit {
                let centerTrumpSymbol = BalootLabels.suitSymbol[ts] ?? ""
                let centerTrumpTint = suitColor(ts, light: true)
                Text(centerTrumpSymbol)
                    .font(.callout.weight(.bold))
                    .foregroundStyle(centerTrumpTint)
                    .shadow(color: .black.opacity(0.5), radius: 3, y: 1)
                    .offset(y: 62)
            }

            // المشاريع والبلوت أسفل المركز
            VStack {
                Spacer()
                centerBadges(hand)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: hand?.faceUpCard?.code)
    }

    @ViewBuilder
    private func centerBadges(_ hand: BalootHandDTO?) -> some View {
        if let decl = hand?.declarations, decl.resolved, let projects = decl.projects, !projects.isEmpty {
            HStack(spacing: 4) {
                ForEach(Array(projects.enumerated()), id: \.offset) { _, p in
                    let projectWho = seatShortName(p.seat)
                    let projectKind = BalootLabels.project[p.type] ?? p.type
                    Text("\(projectWho): \(projectKind)")
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
            let balootNames = balootSeats.map(seatShortName).joined(separator: "، ")
            Text("🌟 بلوت: \(balootNames)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(gold)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color.black.opacity(0.3))
                .clipShape(Capsule())
                .padding(.bottom, 4)
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
    }

    // MARK: - الهيدر العائم (أثناء المباراة — بديل شريط التنقل المخفي)

    /// الهيدر العائم حسب المرجع: نقطة الاتصال في كبسولة يمينًا، وكبسولة
    /// العنوان (سهم رجوع + «طاولة بلوت #N») يسارًا — عناصر زجاجية فوق المشهد.
    /// (RTL: أول عنصر في HStack يظهر يمينًا.)
    private var floatingHeader: some View {
        HStack(spacing: 10) {
            connectionDot
                .padding(9)
                .background(Color.black.opacity(0.5))
                .clipShape(Circle())
                .overlay(Circle().stroke(gold.opacity(0.35), lineWidth: 1))

            Spacer()

            Button { dismiss() } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.backward")
                        .font(.subheadline.weight(.semibold))
                    Text("طاولة بلوت #\(tableId)")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(Color.white.opacity(0.92))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Color.black.opacity(0.5))
                .clipShape(Capsule())
                .overlay(Capsule().stroke(gold.opacity(0.35), lineWidth: 1))
            }
            .accessibilityLabel("رجوع")
        }
        .padding(.bottom, 2)
    }

    // MARK: - الشريط السفلي (كبسولة اليد + أزرار دائرية)

    /// كبسولة «يدك» يمينًا وأزرار دائرية خفيفة يسارًا بترتيب المرجع
    /// (صوت ← سوالف ← قائمة من اليسار) — HUD راقٍ لا يحجب المجلس.
    /// (RTL: أول عنصر في HStack يظهر يمينًا.)
    private var bottomBar: some View {
        HStack(spacing: 12) {
            handCapsule

            Spacer()

            Menu {
                tableMenuItems
            } label: {
                circleLabel("ellipsis")
            }
            .accessibilityLabel("إعدادات الطاولة")
            if vm.table?.roomId != nil {
                circleButton("bubble.left.and.bubble.right.fill", label: "سالفة الطاولة") { showChat = true }
            }
            circleButton(sound.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                         label: sound.isMuted ? "تشغيل الأصوات" : "كتم الأصوات") { sound.toggleMuted() }
        }
    }

    private func circleButton(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { circleLabel(icon) }
            .accessibilityLabel(label)
    }

    private func circleLabel(_ icon: String) -> some View {
        Image(systemName: icon)
            .font(.subheadline)
            .foregroundStyle(Color.white.opacity(0.9))
            .frame(width: 38, height: 38)
            .background(Color.black.opacity(0.45))
            .clipShape(Circle())
            .overlay(Circle().stroke(gold.opacity(0.25), lineWidth: 1))
    }

    /// كبسولة «يدك» بأيقونة أوراق — تتوهج ذهبيًا عند دوري، و«مشاهدة» للمتفرج.
    private var handCapsule: some View {
        HStack(spacing: 6) {
            if vm.isSpectator {
                Text("👁 مشاهدة")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.85))
            } else {
                Text("يدك")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.85))
                Image(systemName: "rectangle.stack.fill")
                    .font(.caption)
                    .foregroundStyle(Color.white.opacity(0.85))
            }
            if vm.isMyTurnNow {
                Text("دورك 🎯")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(gold)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.black.opacity(0.5))
        .clipShape(Capsule())
        .overlay(Capsule().stroke(vm.isMyTurnNow ? gold : gold.opacity(0.3),
                                  lineWidth: vm.isMyTurnNow ? 1.5 : 1))
        .shadow(color: vm.isMyTurnNow ? gold.opacity(0.4) : .clear, radius: 8)
        .animation(.easeInOut(duration: 0.25), value: vm.isMyTurnNow)
    }

    // MARK: - أفعالي كشرائح فوق اليد (من /options فقط)

    @ViewBuilder
    private var actionChips: some View {
        if let opts = vm.options, vm.isSeated, !vm.paused {
            VStack(spacing: 6) {
                // السوق (v1.1 §4 / P-H12): صف الأزرار الأربعة القياسي —
                // غير المتاح يبقى ظاهرًا رماديًا Disabled بدل الاختفاء،
                // والإتاحة من /options فقط. «حكم» يفتح صف الزوات (خطوة عرض
                // محلية؛ الإرسال يتم بزات عرضها الخادم).
                if opts.myTurn && (opts.phase == "bidding1" || opts.phase == "bidding2") {
                    if suitPickMode {
                        // اختيار زات الحكم (v1.1 §5): الزات غير المعروضة من
                        // الخادم (كزات الورقة المكشوفة) تظهر رمادية معطّلة
                        HStack(spacing: 8) {
                            ForEach(["S", "H", "D", "C"], id: \.self) { s in
                                suitBidButton(s, opts: opts)
                            }
                        }
                        .padding(.horizontal, 6)
                    } else {
                        HStack(spacing: 8) {
                            ForEach(["pass", "ashkal", "hokum", "sun"], id: \.self) { kind in
                                canonicalBidButton(kind, opts: opts)
                            }
                        }
                        .padding(.horizontal, 6)
                    }
                }

                // رقائق مشاريعي المثبتة فوق يدي (v1.1 §9): ثلاث رقائق ثابتة
                // بمعجمنا (سيرا/خمسين/مية) مع عدّاد = عدد مشاريعي المؤكدة من
                // كل نوع — تصفية بيانات خادم (declarations.projects) فقط،
                // لا اشتقاق قواعد. صف الورق المصغّر لكل مشروع لا يُعرض:
                // قوائم الأوراق غير متوفرة في BalootPublicProjectDTO وتحديدها
                // من يدي = اشتقاق قواعد ممنوع (فجوة بيانات موثقة).
                if opts.phase == "playing" {
                    projectChips
                }

                // المشاريع والدبلات أثناء اللعب
                if opts.phase == "playing" && (!opts.projects.isEmpty || !opts.doubles.isEmpty) {
                    HStack(spacing: 6) {
                        ForEach(opts.projects, id: \.self) { p in
                            let projectTitle = BalootLabels.project[p.type] ?? p.type
                            Button(projectTitle) {
                                Task { await vm.declare(p) }
                            }
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 12).frame(height: 32)
                            .background(EMSTheme.Colors.emerald.opacity(0.25))
                            .foregroundStyle(EMSTheme.Colors.emerald)
                            .clipShape(Capsule())
                        }
                        ForEach(opts.doubles, id: \.self) { d in
                            let doubleTitle = BalootLabels.double[d] ?? d
                            Button(doubleTitle) {
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

    /// تدرج ذهبي لأزرار السوق الفعّالة (v1.1 §4).
    private var goldButtonFill: LinearGradient {
        LinearGradient(colors: [Color(red: 0.95, green: 0.78, blue: 0.38),
                                Color(red: 0.78, green: 0.58, blue: 0.20)],
                       startPoint: .top, endPoint: .bottom)
    }

    /// لون الزات — light=true فوق اللباد الداكن (السوداء تصبح بيضاء).
    private func suitColor(_ s: String, light: Bool = false) -> Color {
        if s == "H" || s == "D" { return Color(red: 0.78, green: 0.16, blue: 0.16) }
        return light ? Color.white.opacity(0.9) : Color(red: 0.15, green: 0.13, blue: 0.16)
    }

    /// تسميات صف السوق القياسي حسب الجولة (v1.1 §4).
    private func canonicalBidLabel(_ kind: String, phase: String) -> String {
        let round2 = phase == "bidding2"
        switch kind {
        case "pass": return round2 ? "ولا" : "بس"
        case "ashkal": return "أشكل"
        case "hokum": return round2 ? "حكم ثاني" : "حكم"
        default: return "صن"
        }
    }

    /// زر مزايدة قياسي — ذهبي عند الإتاحة، رمادي معطّل عند عدمها (P-H12).
    @ViewBuilder
    private func canonicalBidButton(_ kind: String, opts: BalootOptionsResponse) -> some View {
        let enabled = kind == "hokum"
            ? opts.bids.contains { $0.kind == "hokum" }
            : opts.bids.contains { $0.kind == kind }
        let bidTitle = canonicalBidLabel(kind, phase: opts.phase)
        let bidTitleColor: Color = enabled ? Color(red: 0.22, green: 0.15, blue: 0.05)
                                           : Color.white.opacity(0.55)
        let bidFill: AnyShapeStyle = enabled ? AnyShapeStyle(goldButtonFill)
                                             : AnyShapeStyle(Color.gray.opacity(0.45))
        let bidStroke: Color = enabled ? gold.opacity(0.6) : Color.white.opacity(0.15)
        Button {
            if kind == "hokum" { suitPickMode = true }
            else { Task { await vm.bid(kind: kind, trumpSuit: nil) } }
        } label: {
            Text(bidTitle)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(bidTitleColor)
                .padding(.horizontal, 16).frame(height: 40)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(bidFill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(bidStroke, lineWidth: 1)
                )
        }
        .disabled(!enabled)
    }

    /// زر زات حكم — فعّال فقط إن عرضه الخادم في /options (v1.1 §5).
    @ViewBuilder
    private func suitBidButton(_ suit: String, opts: BalootOptionsResponse) -> some View {
        let enabled = opts.bids.contains { $0.kind == "hokum" && $0.trumpSuit == suit }
        let suitSymbolText = BalootLabels.suitSymbol[suit] ?? suit
        let suitTint: Color = enabled ? suitColor(suit) : Color.white.opacity(0.4)
        let suitFill: AnyShapeStyle = enabled ? AnyShapeStyle(goldButtonFill)
                                              : AnyShapeStyle(Color.gray.opacity(0.45))
        let suitStroke: Color = enabled ? gold.opacity(0.6) : Color.white.opacity(0.15)
        Button {
            suitPickMode = false
            Task { await vm.bid(kind: "hokum", trumpSuit: suit) }
        } label: {
            Text(suitSymbolText)
                .font(.title3.weight(.bold))
                .foregroundStyle(suitTint)
                .frame(width: 52, height: 40)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(suitFill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(suitStroke, lineWidth: 1)
                )
        }
        .disabled(!enabled)
    }

    /// رقائق مشاريعي المثبتة (سيرا/خمسين/مية) — ذهبية إن لديّ من النوع،
    /// كريمية باهتة إن صفر (v1.1 §9). العدّاد من declarations.projects فقط.
    @ViewBuilder
    private var projectChips: some View {
        let mine = (vm.matchState?.hand?.declarations?.projects ?? [])
            .filter { $0.seat == vm.mySeat }
        HStack(spacing: 6) {
            ForEach(["sara", "khamsin", "miya"], id: \.self) { type in
                let count = mine.filter { $0.type == type }.count
                let chipTitle = BalootLabels.project[type] ?? type
                let chipTextColor: Color = count > 0 ? Color(red: 0.22, green: 0.15, blue: 0.05)
                                                     : Color.black.opacity(0.45)
                let chipFill: AnyShapeStyle = count > 0
                    ? AnyShapeStyle(goldButtonFill)
                    : AnyShapeStyle(Color(red: 0.98, green: 0.94, blue: 0.84).opacity(0.55))
                let chipStroke: Color = count > 0 ? gold.opacity(0.6) : Color.white.opacity(0.15)
                HStack(spacing: 4) {
                    Text(chipTitle)
                    if count > 0 {
                        Text("×\(count)")
                            .foregroundStyle(.white.opacity(0.9))
                    }
                }
                .font(.caption.weight(.bold))
                .foregroundStyle(chipTextColor)
                .padding(.horizontal, 12).frame(height: 28)
                .background(Capsule().fill(chipFill))
                .overlay(Capsule().stroke(chipStroke, lineWidth: 1))
            }
        }
    }

    // MARK: - يدي (مروحة كبيرة أسفل الطاولة)

    @ViewBuilder
    private func handFan(felt: CGRect, containerWidth: CGFloat) -> some View {
        if vm.isSeated, let hand = vm.matchState?.hand, let myHand = hand.myHand {
            let arena = BalootArenaGeometry(felt: felt)
            let spacing = handSpacing(for: myHand.count)
            HStack(spacing: spacing) {
                ForEach(Array(myHand.enumerated()), id: \.offset) { index, card in
                    handCard(card, index: index, total: myHand.count,
                             spacing: spacing, felt: felt,
                             containerWidth: containerWidth, arena: arena)
                }
            }
            .padding(.top, 10)
            // علامة زات الحكم بجانبي عندما أكون المشتري (v1.1 §5)
            .overlay(alignment: .topLeading) {
                if hand.contract?.buyerSeat == vm.mySeat,
                   let ts = hand.contract?.trumpSuit {
                    let myTrumpSymbol = BalootLabels.suitSymbol[ts] ?? ""
                    Text(myTrumpSymbol)
                        .font(.callout.weight(.bold))
                        .foregroundStyle(gold)
                        .shadow(color: gold.opacity(0.6), radius: 6)
                        .offset(x: 6, y: -16)
                }
            }
            // إعادة ترتيب المروحة بعد كل رمية ≈0.3ث (§6)
            .animation(.easeInOut(duration: BalootPhysics.fanReflow), value: myHand.count)
            .confirmationDialog("بلوت مع هذه الورقة؟", isPresented: Binding(
                get: { pendingCard != nil }, set: { if !$0 { pendingCard = nil } }
            ), titleVisibility: .visible) {
                if let card = pendingCard {
                    Button("العب مع بلوت 🌟") { Task { await vm.playCard(card.code, baloot: true) } }
                    Button("العب عادي") { Task { await vm.playCard(card.code, baloot: false) } }
                    // إلغاء الحوار = لم تُلعب الورقة → أعد إظهارها في المروحة
                    Button("إلغاء", role: .cancel) { locallyPlayedCode = nil }
                }
            }
        }
    }

    /// تداخل المروحة: كلما كثرت الأوراق ضاقت المسافة حتى تملأ عرض الشاشة.
    private func handSpacing(for count: Int) -> CGFloat {
        guard count > 1 else { return 0 }
        // عرض الورقة 66 — نجعل المروحة كلها ضمن ~عرض الجهاز
        return count <= 5 ? 8 : (count <= 7 ? -20 : -28)
    }

    /// ورقة في يدي — المظهر القائم حرفيًا + طبقة الفيزياء (سحب/رفع/توزيع).
    /// قابلية اللعب من /options فقط كما كانت؛ الرمية بالسحب أو اللمس تسلك
    /// نفس مسار اللعب القائم (حوار بلوت عند الحاجة) — لا قرار لعب هنا.
    private func handCard(_ card: BalootCardDTO, index: Int, total: Int,
                          spacing: CGFloat, felt: CGRect, containerWidth: CGFloat,
                          arena: BalootArenaGeometry) -> some View {
        let opts = vm.options
        let playing = opts?.phase == "playing" && opts?.myTurn == true
        let allowed = playing && (opts?.cards.contains(card.code) ?? false)
        let canBaloot = allowed && (opts?.balootCards.contains(card.code) ?? false)
        // موضع الورقة في المروحة → إزاحة انطلاق التوزيع من مركز الطاولة
        let cardW: CGFloat = 66
        let slotX = containerWidth / 2 + (CGFloat(index) - CGFloat(total - 1) / 2) * (cardW + spacing)
        let slotY = felt.maxY + 35
        let dealDelta = CGSize(width: arena.clusterCenter.x - slotX,
                               height: arena.clusterCenter.y - slotY)
        return BalootHandCardView(card: card, index: index, total: total,
                                  allowed: allowed, canBaloot: canBaloot, playing: playing,
                                  dealToken: vm.matchState?.handNumber ?? 0,
                                  dealDelta: dealDelta,
                                  hidden: card.code == locallyPlayedCode) { viaBalootDialog in
            // إصلاح 4/8: سجّل موضع الانطلاق الحقيقي داخل المروحة + أخفِ
            // الورقة فورًا — الاختفاء = بداية الرمي، والمروحة تنزلق بالتزامن.
            locallyPlayedCode = card.code
            director.noteMyPlayOrigin(card: card.code,
                                      origin: CGPoint(x: slotX, y: slotY))
            if viaBalootDialog { pendingCard = card }
            else { Task { await vm.playCard(card.code, baloot: false) } }
        }
    }

    // MARK: - بطاقة الورقة

    /// المُصيّر الواحد المشترك مع طبقة الفيزياء — نفس المظهر القائم حرفيًا
    /// (نُقل كما هو إلى Physics/BalootCardFace.swift).
    private func cardView(_ card: BalootCardDTO, size: BalootCardSize, dimmed: Bool) -> some View {
        BalootCardFace(card: card, size: size, dimmed: dimmed)
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
