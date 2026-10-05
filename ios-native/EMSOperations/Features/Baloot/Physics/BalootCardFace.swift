//
//  BalootCardFace.swift
//  EMSOperations
//
//  مُصيّر الورقة الواحد — يتشاركه مشهد الطاولة مع طبقة الفيزياء.
//
//  Real Card Faces (قرار المالك 2026-10-05 — «REAL PLAYING CARD LOOK»):
//  وجوه الأوراق الـ32 (7–A × أربع زات) رسومات ورق لعب تقليدية حقيقية
//  مطبوعة — فهارس زوايا قياسية (السفلية مقلوبة 180°)، توزيع Pips
//  تقليدي للأرقام، A بكبشة مركزية (وA♠ المزخرفة)، وCourt Cards
//  مزدوجة الرأس J/Q/K بألوانها وتفاصيلها التقليدية.
//
//  المصدر والترخيص: مجموعة Vector Playing Cards (Chris Aguilar) —
//  Public Domain، عبر مستودع hayeah/playing-cards-assets (معالجة
//  iOS Assets بإزالة الإطار الخارجي). لا رسم مخترع ولا SF Symbols
//  ولا Emoji — الأصول bitmap كما في الورق الحقيقي.
//
//  التعديل بصري صرف (قرار المالك §8): لا مساس بـGame State ولا
//  Card Model ولا Deck/Deal/Turn/Scoring ولا Rules ولا Networking —
//  التوقيع العام للمكوّن (BalootCardFace(card:size:dimmed:)) كما هو.
//
//  وفي نفس الملف BalootCardBack: ظهر الورقة الرسمي «قطاع الجنوب» —
//  أخضر عميق بنقشة معينات سدو وإطار ذهبي، بلا أي Asset جديد (رسوم كودية).
//

import SwiftUI
import UIKit

/// أحجام الورقة المعتمدة في الشاشة — نسبة أقرب للورق الحقيقي (63×88مم ≈ 0.71).
enum BalootCardSize {
    case medium, hand
    var dims: (CGFloat, CGFloat) {
        switch self {
        case .medium: return (58, 82)  // ورقة المركز واللفة
        case .hand: return (70, 100)   // يد اللاعب — كبيرة ومريحة للمس
        }
    }
    var cornerRadius: CGFloat {
        switch self {
        case .medium: return 6
        case .hand: return 7
        }
    }
}

// MARK: - وجه الورقة (رسمة ورق حقيقي)

/// وجه الورقة الحقيقي المطبوع من كتالوج الأصول (baloot_card_<code>) —
/// لا عناصر UI مرسومة: الورقة تبدو كأنها ورقة لعب فعلية على اللباد.
/// `dimmed` يخفت ورق اليد الممنوع فقط.
struct BalootCardFace: View {
    let card: BalootCardDTO
    let size: BalootCardSize
    var dimmed: Bool = false

    /// اسم الأصل — code الخادمي حرفان (S/H/D/C + 7..9,T,J,Q,K,A) يطابق
    /// تسمية الصور المضمّنة حرفيًا (baloot_card_HA … baloot_card_S7).
    private var assetName: String { "baloot_card_\(card.code)" }

    var body: some View {
        let (w, h) = size.dims
        ZStack {
            // جسم الورقة — أصول الوجوه حبرٌ على شفافية (بلا خلفية مضمّنة)،
            // فالورق الأبيض العاجي الخفيف يُبنى هنا كورق اللعب الحقيقي.
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .fill(Color(red: 0.998, green: 0.995, blue: 0.988))
            if UIImage(named: assetName) != nil {
                // الوجه المطبوع كاملًا — بلا قص ولا فراغات: تمدد بسيط
                // (0.687→0.70 ≈ 1.8%) لا يُدرك على رسمة الورق ويحفظ
                // كل العناصر (الفهارس والـPips والشخصيات) كاملة.
                Image(assetName)
                    .resizable()
                    .frame(width: w, height: h)
            } else {
                // سقوط بصري آمن لا منطق فيه — أصل مفقود لا يحدث عمليًا
                // (الأصول الـ32 مضمّنة في الحزمة).
                BalootCardBack(size: size)
            }
        }
        .frame(width: w, height: h)
        .clipShape(RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous))
        .opacity(dimmed ? 0.35 : 1)
        // ظل خفيف واقعي — إحساس ورقة مرفوعة عن اللباد بلا ثقل بصري.
        .shadow(color: .black.opacity(0.32), radius: 3, y: 2)
    }
}

// MARK: - ظهر الورقة «قطاع الجنوب»

/// ظهر الورقة الرسمي (Stage 07 — قرار المالك): أخضر عميق من هوية اللباد،
/// نقشة معينات سدو خفيفة، إطار ذهبي داخلي، وشارة «قطاع الجنوب» في
/// الوسط — بلا شعار الهلال الأحمر وبلا أي Asset جديد (رسوم كودية).
/// يُستخدم في توزيع الخصوم وكل ظهر ورق كامل الحجم.
struct BalootCardBack: View {
    let size: BalootCardSize

    private let gold = Color(red: 0.82, green: 0.66, blue: 0.32)

    var body: some View {
        let (w, h) = size.dims
        ZStack {
            // القاعدة: أخضر عميق متدرج
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .fill(LinearGradient(colors: [Color(red: 0.09, green: 0.27, blue: 0.18),
                                              Color(red: 0.045, green: 0.15, blue: 0.11)],
                                     startPoint: .top, endPoint: .bottom))
            // نقشة معينات سدو (خطوط مائلة متقاطعة بذهب خافت)
            Canvas { ctx, canvasSize in
                let step: CGFloat = 11
                var path = Path()
                var x: CGFloat = -canvasSize.height
                while x < canvasSize.width + canvasSize.height {
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x + canvasSize.height, y: canvasSize.height))
                    path.move(to: CGPoint(x: x, y: canvasSize.height))
                    path.addLine(to: CGPoint(x: x + canvasSize.height, y: 0))
                    x += step
                }
                ctx.stroke(path, with: .color(gold.opacity(0.15)), lineWidth: 0.75)
            }
            .padding(3)
            .clipShape(RoundedRectangle(cornerRadius: size.cornerRadius - 2, style: .continuous))
            // الإطار الذهبي الداخلي
            RoundedRectangle(cornerRadius: size.cornerRadius - 2, style: .continuous)
                .stroke(gold.opacity(0.55), lineWidth: 1)
                .padding(2.5)
            // شعار قطاع الجنوب الرسمي في منتصف الظهر (قرار المالك — الشعار
            // كما أُرسل: بلا إعادة رسم ولا تغيير ألوان ولا عناصر إضافية) —
            // يحل محل شارة النص «قطاع الجنوب» السابقة
            Image("baloot_sector_logo")
                .resizable()
                .scaledToFit()
                .frame(width: w * 0.66)
        }
        .frame(width: w, height: h)
        .overlay(
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .stroke(Color.white.opacity(0.22), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.45), radius: 4, y: 3)
    }
}
