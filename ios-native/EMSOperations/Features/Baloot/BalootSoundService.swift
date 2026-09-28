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
import UIKit

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
        case sayAshkal = "say_ashkal"   // «أشكل»
        case sayDouble = "say_double"   // «دبل»
        case sayBaloot = "say_baloot"   // «بلوت»
        case saySara = "say_sara"       // «سرا»
        case sayKhamsin = "say_khamsin" // «خمسين»
        case sayMiya = "say_miya"       // «مية»
        case sayArba = "say_arba"       // «أربعمية»

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
    /// مراقبات النظام التي تُبقي الجلسة حية (مقاطعة/خلفية/تغيير مخرج الصوت).
    private var observers: [NSObjectProtocol] = []

    private init() {
        isMuted = UserDefaults.standard.bool(forKey: Self.muteKey)
        configureSession()
        preload()
        observeSessionLifecycle()
    }

    /// جلسة تشغيل مستقلة عن مفتاح الصمت — الكتم من داخل التطبيق فقط.
    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    /// الجلسة كانت تُهيَّأ مرة واحدة عند الإقلاع فقط، فإذا عطّلها النظام
    /// (خروج للخلفية، مكالمة/منبّه/Siri، فصل سماعة) ماتت كل الأصوات صامتًا
    /// حتى إعادة تشغيل التطبيق — رغم أن isMuted تبقى false. هنا نعيد
    /// تفعيلها عند انتهاء المقاطعة وعند العودة للواجهة وعند تغيير المخرج.
    private func observeSessionLifecycle() {
        let center = NotificationCenter.default
        let interrupt = center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let info = note.userInfo,
                  let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            Task { @MainActor in self?.configureSession() }
        }
        let foreground = center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.configureSession() }
        }
        let routeChange = center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let info = note.userInfo,
                  let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            Task { @MainActor in self?.configureSession() }
        }
        observers = [interrupt, foreground, routeChange]
    }

    /// تفعيل دفاعي قبل التشغيل — setActive على جلسة نشطة لا يفعل شيئًا.
    private func ensureSessionActive() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
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
        ensureSessionActive()
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
