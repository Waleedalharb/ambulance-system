//
//  BalootPhysics.swift
//  EMSOperations
//
//  طبقة الفيزياء — المرحلة 03 (REFERENCE LOCK).
//  كل ثابت هنا مرصود من المقطع المرجعي إطارًا بإطار وموثّق في
//  baloot-reference/03-physics-specification.md — لا تُغيَّر أي قيمة
//  معتمدة بلا موافقة صريحة من المالك.
//
//  القسم الأخير (BalootGestureTuning) معزول ويحمل قيمًا TEMPORARY/PENDING
//  لتفاصيل إيماءة الإصبع (P-P1) — ليست مواصفة نهائية حتى تُثبَّت.
//

import SwiftUI

// MARK: - الثوابت المعتمدة (Locked)

enum BalootPhysics {

    // §2 — طيران الورقة إلى المركز (Throw/Flight)
    /// مدة الطيران ≈0.4ث — (25.0→25.4 / 26.2→26.6 / 53.8→54.6).
    static let flightDuration: Double = 0.40
    /// تكبير الورقة أثناء الرفع ≈1.4×–1.5× — (Q♦@53.8 / 7♥@45.2).
    static let liftScale: CGFloat = 1.45
    /// ميلان الطيران ±15°–25° — (7♠≈−25°@25.0 / 10♠≈+15°@26.2).
    static let flightTilt: ClosedRange<Double> = 15...25
    /// ميلان الاستقرار داخل عنقود الأكلة ±5°–15° (§3 — كل لقطات الأكلات).
    static let restTilt: ClosedRange<Double> = 5...15

    // §4 — جمع الأكلة (Trick Collect)
    /// فجوة التقييم بعد رابع ورقة ≈0.8–1.0ث — (27.8→28.6).
    static let collectPause: Double = 0.90
    /// مدة طيران الجمع نحو الفائز ≈0.4–0.6ث — (28.6 / 41.4 / 71.6).
    static let collectDuration: Double = 0.50
    /// قياس ورقة الجمع أثناء طيرانها نحو الفائز (مُصغّرة — 41.4 / 71.6).
    static let collectScale: CGFloat = 0.55
    /// عمر popup النقاط ≈1.0ث (طفو للأعلى + اختفاء).
    /// ملاحظة: القيمة الرقمية للنقاط غير متاحة من الخادم حاليًا — PENDING.
    static let pointsPopupLifetime: Double = 1.0

    // §5 — استكمال التوزيع (Deal Completion Flight)
    /// طيران ورقة التوزيع ≈0.4–0.5ث — (21.0→21.8).
    static let dealFlightDuration: Double = 0.45
    /// ميلان ورقة التوزيع أثناء الطيران ±10° — (21.0).
    static let dealTilt: Double = 10
    /// تتابع ظهور أوراق التوزيع (ورقة/ورقتان بالتناوب) — قيمة عرضية
    /// مشتقة من إيقاع 21.0→21.8، ليست زمنًا مقروءًا بدقة.
    static let dealStagger: Double = 0.10

    // §6 — إعادة ترتيب المروحة (Fan Reflow) ≈0.2–0.4ث.
    static let fanReflow: Double = 0.30

    // §8 — نهاية اليد
    /// فجوة مسح الطاولة → ظهور لوحة الحسبة ≈1.0–1.2ث — (72.0→73.2).
    static let scorePanelDelay: Double = 1.10

    // MARK: أدوات مشتقة

    /// ⚠️ TEMPORARY (P-P2) — منحنى التوقيت الدقيق (easing) غير محسوم من
    /// المرجع (دقة 5fps لا تكفي). easeInOut قيمة تقنية مؤقتة قابلة للضبط،
    /// وليست مواصفة نهائية.
    static func flightAnimation(_ duration: Double, delay: Double = 0) -> Animation {
        .easeInOut(duration: duration).delay(delay)
    }

    /// ميلان ثابت مشتق من هوية الورقة والمقعد داخل النطاق المرصود —
    /// «عشوائية محكومة بجهة اللاعب» (§3): لا قيم متغيرة بين الإطارات،
    /// ونفس الورقة تهبط دائمًا بنفس الميلان داخل الأكلة الواحدة.
    /// ⚠️ القيمة بالدرجات داخل النطاق — الدقة ±5° (P-P6).
    static func steadyTilt(card: String, seat: Int, range: ClosedRange<Double>) -> Double {
        var h = 0
        for u in card.unicodeScalars { h = (h &* 31 &+ Int(u.value)) & 0x7fffffff }
        h = (h &+ seat &* 97) & 0x7fffffff
        let t = Double(h % 1000) / 1000.0
        let mag = range.lowerBound + t * (range.upperBound - range.lowerBound)
        return (h % 2 == 0 ? 1 : -1) * mag
    }
}

// MARK: - هندسة الساحة (مواقع مرجعية محسوبة من اللباد)

/// مواقع انطلاق/هبوط الأوراق داخل اللباد المرسوم — تُبنى على feltRect نفسه
/// المستخدم في شاشة الطاولة حتى لا تتغير أي مواقع قائمة.
struct BalootArenaGeometry {
    let felt: CGRect

    /// مركز عنقود الأكلة — نفس موضع centerStage القائم.
    var clusterCenter: CGPoint {
        CGPoint(x: felt.midX, y: felt.midY - felt.height * 0.03)
    }

    /// نقطة انطلاق الورقة من جهة لاعب (0=أنا أسفل، 1=يمين، 2=شريك أعلى، 3=يسار).
    /// جانبيا الطاولة = مواضع seatPod القائمة نفسها؛ الأسفل/الأعلى على حافة اللباد.
    func seatOrigin(relative: Int) -> CGPoint {
        switch relative {
        case 0: return CGPoint(x: felt.midX, y: felt.maxY + 30)
        case 1: return CGPoint(x: felt.maxX - 48, y: felt.midY - felt.height * 0.08)
        case 2: return CGPoint(x: felt.midX, y: felt.minY + 10)
        default: return CGPoint(x: felt.minX + 48, y: felt.midY - felt.height * 0.08)
        }
    }

    /// موضع ورقة داخل عنقود الأكلة (§3): عنقود متداخل غير منتظم — انحراف
    /// ضيق نحو جهة صاحبها (وليس توزيعًا محوريًا متباعدًا).
    func clusterSlot(relative: Int) -> CGPoint {
        let c = clusterCenter
        let d = Self.clusterDeviation
        switch relative {
        case 0: return CGPoint(x: c.x, y: c.y + d)
        case 1: return CGPoint(x: c.x + d, y: c.y)
        case 2: return CGPoint(x: c.x, y: c.y - d)
        default: return CGPoint(x: c.x - d, y: c.y)
        }
    }

    /// مقدار الانحراف من مركز العنقود نحو جهة الصاحب (pt).
    static let clusterDeviation: CGFloat = 26

    /// نفس الانحراف كإزاحة نسبية من مركز centerStage — لرسم الأوراق المستقرة.
    static func clusterOffset(relative: Int) -> CGSize {
        let d = clusterDeviation
        switch relative {
        case 0: return CGSize(width: 0, height: d)
        case 1: return CGSize(width: d, height: 0)
        case 2: return CGSize(width: 0, height: -d)
        default: return CGSize(width: -d, height: 0)
        }
    }
}

// MARK: - ⚠️⚠️ TEMPORARY / PENDING (P-P1) — معزول عن باقي الفيزياء

/// تفاصيل إيماءة الإصبع غير محسومة من المرجع (تسجيل شاشة بلا إصبع ظاهر).
/// كل قيمة هنا مؤقتة وقابلة للضبط ولا تُعتبر مواصفة نهائية حتى يثبتها
/// المالك: عتبة بدء السحب، عتبة اعتبار الحركة رمية، التتبع 1:1، سلوك
/// الإرجاع، وtap-to-play.
struct BalootGestureTuning {
    /// نسبة تتبع الورقة للإصبع — 1:1 افتراض مؤقت (P-P1).
    var trackingRatio: CGFloat = 1.0
    /// مسافة بدء اعتبار الحركة سحبًا (pt) — مؤقت (P-P1).
    var dragStartThreshold: CGFloat = 8
    /// ارتفاع الإفلات الذي تُعتبر معه الحركة رمية (pt) — مؤقت (P-P1).
    var throwThreshold: CGFloat = 120
    /// مدة عودة الورقة لمكانها عند إفلات دون العتبة (ث) — مؤقت (P-P1).
    var returnDuration: Double = 0.25
    /// بقاء tap-to-play بجانب السحب — مؤقت (P-P1).
    var tapToPlayEnabled = true
    /// مدة بقاء نص «بلوت» الذهبي (ث) — مؤقت (P-P8).
    var balootTextLifetime: Double = 0.90
}
