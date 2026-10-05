//
//  BalootTrickDirector.swift
//  EMSOperations
//
//  موجّه عرض الأكلة — المرحلة 03 (§2/§3/§4).
//
//  طبقة عرض صرفة فوق حالة الخادم: لا تعرف قاعدة واحدة ولا تغيّر أي
//  منطق. مهمتها ترجمة تيار الحالة إلى تسلسل الحركة المرصود في المرجع:
//
//   1) كل ورقة جديدة في currentTrick تطير من جهة صاحبها إلى العنقود
//      (≈0.4ث، ميلان طيران → ميلان استقرار، تصغير من حجم الرفع).
//   2) عند حسم الأكلة: الخادم يصفّي currentTrick فورًا (الورقة الرابعة
//      لا تظهر فيه أبدًا) — نقدّمها من lastTrick، ثم فجوة تقييم
//      ≈0.9ث، ثم تصغر الأوراق وتطير مجتمعة لجهة الفائز (≈0.5ث)
//      وتختفي عند وصولها.
//   3) أي desync (عودة اتصال/لقطة) = مزامنة صارمة فورية بلا حركة.
//
//  popup النقاط: جاهز في طبقة الطيران لكنه غير مفعّل — قيمة النقاط لا
//  تصل من الخادم (PENDING بقرار المالك)، وحسابها عميليًا يخالف A7.
//

import Foundation
import Combine

@MainActor
final class BalootTrickDirector: ObservableObject {

    // MARK: - الحالة المعروضة

    /// أوراق الأكلة المستقرة في العنقود (هبطت) — تُرسم في centerStage.
    @Published private(set) var settled: [BalootTrickPlayDTO] = []
    /// كل الأوراق الطائرة حاليًا (رمي + جمع) — تُرسم في BalootFlightOverlay.
    @Published private(set) var flights: [BalootFlightCard] = []

    // MARK: - داخلية

    /// رموز الأوراق المقدَّمة (مستقرة + طائرة) بترتيب اللعب — منع التكرار.
    private var presentedCodes: [String] = []
    /// عدد الأكلات المحسومة التي عولجت عرضيًا (من hand.tricksCount).
    private var processedTricks = 0
    private var seenHand = 0
    /// انتقال أكلة جارٍ (ورقة رابعة → فجوة تقييم → جمع) — تنظيف الانتقال:
    /// طوال هذه الفترة لا يظهر أي نص/حالة قديمة مكان العنقود.
    @Published private(set) var isCollecting = false
    private var tasks: [Task<Void, Never>] = []
    /// موضع انطلاق ورقتي الحقيقي داخل المروحة (slotX/slotY) — تُسجَّل من
    /// الشاشة لحظة اللعب وتُستهلك عند عرض الرمية الواردة (§2: من الـFan).
    private var myPlayOrigins: [String: CGPoint] = [:]

    private struct SyncInput {
        var currentTrick: [BalootTrickPlayDTO]?
        var lastTrick: BalootLastTrickDTO?
        var tricksCount: Int?
        var mySeat: Int?
        var geo: BalootArenaGeometry
    }
    private var lastSync: SyncInput?

    // MARK: - المزامنة من حالة الخادم

    func sync(currentTrick: [BalootTrickPlayDTO]?,
              lastTrick: BalootLastTrickDTO?,
              tricksCount: Int?,
              handNumber: Int?,
              mySeat: Int?,
              geo: BalootArenaGeometry) {
        let hn = handNumber ?? 0
        if hn != seenHand {
            seenHand = hn
            hardReset()
            processedTricks = tricksCount ?? 0
            // دخول متأخر وسط أكلة أو بداية صفقة: لقطة فورية بلا طيران
            hardSync(currentTrick ?? [])
        }
        let input = SyncInput(currentTrick: currentTrick, lastTrick: lastTrick,
                              tricksCount: tricksCount, mySeat: mySeat, geo: geo)
        lastSync = input

        let trick = currentTrick ?? []
        let done = tricksCount ?? 0

        // (2) أكلة محسومة جديدة — الخادم صفّى currentTrick فور الحسم
        if done > processedTricks, let last = lastTrick, !isCollecting {
            processedTricks = done
            presentCompletedTrick(last, input: input)
            return
        }

        guard !isCollecting else { return }

        // (1) أوراق جديدة في الأكلة الجارية تطير للعنقود
        for play in trick where !presentedCodes.contains(play.card.code) {
            presentInbound(play, input: input)
        }

        // (3) desync: الخادم عند أوراق أقل مما نعرض بلا حدث إكمال معروف
        if trick.count < presentedCodes.count {
            hardSync(trick)
        }
    }

    /// إيقاف كل الحركة (مغادرة الشاشة).
    func stop() {
        hardReset()
        lastSync = nil
    }

    /// تسجيل موضع ورقتي داخل المروحة لحظة لعبها — حتى تنطلق الرمية من
    /// موضعها الحقيقي وليس من أسفل الساحة (§2/§3).
    func noteMyPlayOrigin(card: String, origin: CGPoint) {
        myPlayOrigins[card] = origin
    }

    // MARK: - عرض ورقة واردة (رمية لاعب/خصم)

    private func presentInbound(_ play: BalootTrickPlayDTO, input: SyncInput) {
        let rel = relative(play.seat, mySeat: input.mySeat)
        // ورقتي: تنطلق من موضعها الحقيقي في المروحة إن سُجِّل، وإلا
        // (عودة اتصال/متفرج) من موضع مقعدي الافتراضي — ورق الخصوم كما كان.
        let origin: CGPoint = (rel == 0)
            ? (myPlayOrigins.removeValue(forKey: play.card.code) ?? input.geo.seatOrigin(relative: rel))
            : input.geo.seatOrigin(relative: rel)
        let flight = BalootFlightCard(
            card: play.card, seat: play.seat,
            from: origin,
            to: input.geo.clusterSlot(relative: rel),
            // ورقتي تغادر اليد مكبّرة (§1)؛ ورق الخصوم يطير بحجم الطاولة
            fromScale: rel == 0 ? BalootPhysics.liftScale : 1.0,
            toScale: 1.0,
            fromAngle: BalootPhysics.steadyTilt(card: play.card.code, seat: play.seat,
                                                range: BalootPhysics.flightTilt),
            toAngle: BalootPhysics.steadyTilt(card: play.card.code, seat: play.seat,
                                              range: BalootPhysics.restTilt),
            duration: BalootPhysics.flightDuration, delay: 0, fadeOut: false
        )
        flights.append(flight)
        presentedCodes.append(play.card.code)
        after(flight.duration) { [weak self] in
            guard let self else { return }
            self.flights.removeAll { $0.id == flight.id }
            // تبقى مستقرة في العنقود طوال فجوة التقييم حتى لحظة الجمع
            if !self.settled.contains(where: { $0.card.code == play.card.code }) {
                self.settled.append(play)
            }
        }
    }

    // MARK: - عرض الأكلة المحسومة (الورقة الأخيرة + الجمع)

    private func presentCompletedTrick(_ last: BalootLastTrickDTO, input: SyncInput) {
        isCollecting = true
        // قدّم ما لم يُقدَّم من أوراقها (عادة الورقة الرابعة فقط)
        for play in last.plays where !presentedCodes.contains(play.card.code) {
            presentInbound(play, input: input)
        }

        // فجوة التقييم تبدأ بعد هبوط آخر ورقة (§4: ≈0.8–1.0ث)
        let landing = BalootPhysics.flightDuration
        after(landing + BalootPhysics.collectPause) { [weak self] in
            guard let self, self.isCollecting else { return }
            self.collectTrick(last, input: input)
        }
    }

    /// الأوراق الأربع تصغر وتطير مجتمعة لجهة الفائز وتختفي عند وصولها (§4).
    private func collectTrick(_ last: BalootLastTrickDTO, input: SyncInput) {
        // Stage 06 (D7) — سويش جمع الأكلة (28.62+) يُشغَّل هنا عند بدء الحركة
        // البصرية فعليًا، لا عند وصول trick_won الذي يسبق الجمع بـ≈1.3ث.
        BalootSoundService.shared.play(.refCollect)
        let winnerRel = relative(last.winnerSeat, mySeat: input.mySeat)
        let target = input.geo.seatOrigin(relative: winnerRel)
        settled = []
        for play in last.plays {
            let rel = relative(play.seat, mySeat: input.mySeat)
            let flight = BalootFlightCard(
                card: play.card, seat: play.seat,
                from: input.geo.clusterSlot(relative: rel),
                to: target,
                fromScale: 1.0, toScale: BalootPhysics.collectScale,
                fromAngle: BalootPhysics.steadyTilt(card: play.card.code, seat: play.seat,
                                                    range: BalootPhysics.restTilt),
                toAngle: 0,
                duration: BalootPhysics.collectDuration, delay: 0, fadeOut: true
            )
            flights.append(flight)
        }
        after(BalootPhysics.collectDuration) { [weak self] in
            guard let self else { return }
            self.flights.removeAll()
            self.presentedCodes.removeAll()
            self.isCollecting = false
            // أوراق الأكلة التالية قد تكون وصلت أثناء الجمع — قدّمها الآن
            if let pending = self.lastSync {
                self.sync(currentTrick: pending.currentTrick, lastTrick: pending.lastTrick,
                          tricksCount: pending.tricksCount, handNumber: self.seenHand,
                          mySeat: pending.mySeat, geo: pending.geo)
            }
        }
    }

    // MARK: - أدوات

    private func relative(_ seat: Int, mySeat: Int?) -> Int {
        guard let mySeat else { return seat }
        return (seat - mySeat + 4) % 4
    }

    private func hardReset() {
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
        settled = []
        flights = []
        presentedCodes = []
        myPlayOrigins = [:]
        isCollecting = false
    }

    /// لقطة فورية بلا حركة — للعودة من انقطاع أو أي desync.
    private func hardSync(_ trick: [BalootTrickPlayDTO]) {
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
        flights = []
        settled = trick
        presentedCodes = trick.map { $0.card.code }
        isCollecting = false
    }

    private func after(_ seconds: Double, work: @escaping @MainActor () -> Void) {
        let task = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            work()
        }
        tasks.append(task)
    }
}
