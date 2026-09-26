//
//  BalootSoundService.swift
//  EMSOperations
//
//  أصوات البلوت — خفيفة واحترافية (SystemSound، < 1 ثانية لكل مؤثر):
//   توزيع · وضع ورقة · اختيار/تأكيد · إعلان العقد · فوز لفة ·
//   نهاية صفقة · نهاية مباراة · تنبيه «الدور عليك».
//  بلا موسيقى خلفية. يحترم كتم التطبيق (إعدادات الطاولة) ويُخزَّن في
//  UserDefaults، ويحترم مفتاح الصمت في الجهاز (سلوك SystemSound القياسي).
//

import Foundation
import AudioToolbox

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

    private var soundIDs: [Effect: SystemSoundID] = [:]

    private init() {
        isMuted = UserDefaults.standard.bool(forKey: Self.muteKey)
        for fx in Effect.allCases {
            guard let url = Bundle.main.url(forResource: fx.rawValue, withExtension: "wav") else { continue }
            var sid = SystemSoundID()
            if AudioServicesCreateSystemSoundID(url as CFURL, &sid) == kAudioServicesNoError {
                soundIDs[fx] = sid
            }
        }
    }

    func setMuted(_ muted: Bool) { isMuted = muted }
    func toggleMuted() { isMuted.toggle() }

    func play(_ fx: Effect) {
        guard !isMuted, let sid = soundIDs[fx] else { return }
        AudioServicesPlaySystemSound(sid)
    }
}
