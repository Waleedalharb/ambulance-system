//
//  BalootSoundService.swift
//  EMSOperations
//
//  أصوات البلوت — مؤثرات خفيفة حقيقية مربوطة بأحداث المحرك:
//   توزيع · وضع ورقة · اختيار/تمرير · إعلان العقد · فوز لفة ·
//   نهاية صفقة · نهاية مباراة · تنبيه «الدور عليك».
//
//  لماذا AVAudioPlayer وليس SystemSound؟
//   AudioServicesPlaySystemSound يُكمَت تمامًا بمفتاح الصمت الجانبي ويتبع
//   مستوى صوت الرنين — وعلى الأجهزة الحقيقية ظهرت المؤثرات صامتة. هنا نستخدم
//   جلسة .playback مع mixWithOthers: الصوت يعمل دائمًا، والكتم الوحيد هو
//   مفتاح الكتم داخل التطبيق (قائمة الطاولة) — قرار منتج واضح وقابل للتوقع.
//
//  كل مؤثر يُشغَّل مرة واحدة عند الحدث الحقيقي من الخادم (اللقطات تصل
//  بلا أحداث فلا تُعيد تشغيل شيء).
//

import Foundation
import AVFoundation

@MainActor
final class BalootSoundService: ObservableObject {
    static let shared = BalootSoundService()

    enum Effect: String, CaseIterable {
        case deal = "deal"
        case cardPlayed = "card"
        case select = "select"
        case contract = "contract"
        case trick = "trick"
        case handEnd = "hand_end"
        case matchEnd = "match_end"
        case yourTurn = "your_turn"
        // نداءات منطوقة (mp3) — صوت رجالي يعلن الحدث نفسه
        case saySunn = "say_sunn"       // «صن»
        case sayHokum = "say_hokum"     // «حكم»
        case sayPass = "say_pass"       // «بس»
        case sayWela = "say_wela"       // «ولا» — تسجيل رسمي من المالك (Stage 07)
        case sayAshkal = "say_ashkal"   // «أشكل»
        case sayDouble = "say_double"   // «دبل»
        case sayBaloot = "say_baloot"   // «بلوت»
        case saySara = "say_sara"       // «سرا»
        case sayKhamsin = "say_khamsin" // «خمسين»
        case sayMiya = "say_miya"       // «مية»
        case sayArba = "say_arba"       // «أربعمية»
        // Stage 06 — Reference Lock: الأصوات الخمسة المعتمدة من المرجع فقط
        // (one-shot، بلا voiceover ولا loops). الأصول والحالات القديمة أعلاه
        // محفوظة كما هي — تعطيلها يتم عند نقطة النداء لا هنا.
        case refThrow = "ref_throw"       // S01 — بداية رمية الورقة
        case refBid = "ref_bid"           // S02b — صوت مزايدة عام واحد
        case refTrump = "ref_trump"       // S03 — كشف/تأكيد الحكم (بزات فقط)
        case refScore = "ref_score"       // S04 — فتح لوحة الحسبة
        case refAnnounce = "ref_announce" // S06 — إعلان مشروع/بلوت (ستينغر مشترك)
        // Stage 06 — Final Audit: الأصول السبعة الإضافية المعتمدة من المرجع.
        // ربطها عند الأحداث البصرية الفعلية فقط — بلا اختراع وبلا تعميم.
        case refHandStart = "ref_hand_start"   // 0.39 — بداية الصفقة/المؤقت (بعد إغلاق لوحة الحسبة)
        case refBidR1 = "ref_bid_r1"           // 1.71+ — رنين مزايدة الجولة الأولى
        case refRound = "ref_round"            // 6.04/11.01 — سويش انتقال الجولة (باسي)
        case refConfirm = "ref_confirm"        // 15.17 — نغمة ظهور شريط التأكيد
        case refSuitReveal = "ref_suit_reveal" // 16.52 — سويش ظهور شريط «تأكيد حكم»
        case refDeal = "ref_deal"              // 20.90 — فولي استكمال توزيع الورق (الدفعة الثانية)
        case refCollect = "ref_collect"        // 28.62+ — سويش جمع الأكلة (من collectTrick فعليًا)
        // مستخرجة من الـMaster Reference نفسه بإذن المالك (لا اختراع):
        case refGold = "ref_gold"              // 13.16 — «حكم ثاني» الذهبي
        case refProject50 = "ref_project50"    // 26.06 — إعلان الخمسين (هوية أسطع)
        case refBaloot = "ref_baloot"          // 63.91 — إعلان البلوت (هوية مستقلة)

        /// النداءات المنطوقة mp3 والمؤثرات wav.
        var fileExtension: String { rawValue.hasPrefix("say_") ? "mp3" : "wav" }
    }

    private static let muteKey = "baloot.soundMuted"

    @Published private(set) var isMuted: Bool {
        didSet { UserDefaults.standard.set(isMuted, forKey: Self.muteKey) }
    }

    private var players: [Effect: AVAudioPlayer] = [:]
    /// عدد المؤثرات التي وُجدت فعلًا في الحزمة — للتشخيص على الجهاز.
    private(set) var loadedCount = 0

    private init() {
        isMuted = UserDefaults.standard.bool(forKey: Self.muteKey)
        configureSession()
        preload()
    }

    /// جلسة تشغيل مستقلة عن مفتاح الصمت — الكتم من داخل التطبيق فقط.
    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    private func preload() {
        for fx in Effect.allCases {
            guard let url = Bundle.main.url(forResource: fx.rawValue, withExtension: fx.fileExtension),
                  let player = try? AVAudioPlayer(contentsOf: url) else { continue }
            player.prepareToPlay()
            players[fx] = player
        }
        loadedCount = players.count
    }

    func setMuted(_ muted: Bool) { isMuted = muted }
    func toggleMuted() { isMuted.toggle() }

    /// تشغيل مؤثر — يُعيد المؤشر للبداية حتى يعمل مع الأحداث المتتالية السريعة.
    func play(_ fx: Effect) {
        guard !isMuted, let player = players[fx] else { return }
        player.currentTime = 0
        player.play()
    }

    /// Stage 06 — النداءات المنطوقة: جدولة غير حاجبة بعد المؤثر المرجعي
    /// بفواصل مقاسة من الفيديو (0.11–0.64ث). play(atTime:) يجدول على محرك
    /// الصوت نفسه — بلا sleep ولا Task ولا لمس للـMain Thread.
    func play(_ fx: Effect, afterDelay delay: Double) {
        guard !isMuted, let player = players[fx] else { return }
        player.currentTime = 0
        player.play(atTime: player.deviceCurrentTime + delay)
    }

    /// زر «تجربة الصوت» في قائمة الطاولة — يثبت على الجهاز أن القناة تعمل.
    /// يعيد false إذا لم يُحمَّل أي ملف صوت (مشكلة حزمة وليست كتمًا).
    @discardableResult
    func playTest() -> Bool {
        guard loadedCount > 0 else { return false }
        play(.select)
        return true
    }
}
