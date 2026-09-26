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
            guard let url = Bundle.main.url(forResource: fx.rawValue, withExtension: "wav"),
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

    /// زر «تجربة الصوت» في قائمة الطاولة — يثبت على الجهاز أن القناة تعمل.
    /// يعيد false إذا لم يُحمَّل أي ملف صوت (مشكلة حزمة وليست كتمًا).
    @discardableResult
    func playTest() -> Bool {
        guard loadedCount > 0 else { return false }
        play(.select)
        return true
    }
}
