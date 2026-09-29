//
//  BalootCardFace.swift
//  EMSOperations
//
//  مُصيّر الورقة الواحد — نُقل حرفيًا من BalootTableView (بلا أي تغيير
//  بصري) حتى تتشاركه طبقة الفيزياء مع الشاشة: ورقة كريمية معتمة 100%
//  بحدود وظل، والرتب بأسمائها البلوتية (شايب/بنت/ولد/إكّه).
//

import SwiftUI

/// أحجام الورقة المعتمدة في الشاشة — كما كانت حرفيًا.
enum BalootCardSize {
    case medium, hand
    var dims: (CGFloat, CGFloat) {
        switch self {
        case .medium: return (56, 80) // ورقة المركز واللفة
        case .hand: return (66, 96)   // يد اللاعب — كبيرة ومريحة للمس
        }
    }
    var font: Font {
        switch self {
        case .medium: return .body.weight(.bold)
        case .hand: return .headline.weight(.bold)
        }
    }
}

/// ورقة كريمية معتمة 100% بحدود واضحة وظل — كأنها ورقة حقيقية على اللباد.
/// `dimmed` يخفت ورق اليد الممنوع فقط؛ ورق المركز يبقى معتمًا دائمًا.
struct BalootCardFace: View {
    let card: BalootCardDTO
    let size: BalootCardSize
    var dimmed: Bool = false

    private let cream = Color(red: 0.98, green: 0.965, blue: 0.92)

    var body: some View {
        let (w, h) = size.dims
        VStack(spacing: 2) {
            Text(Self.rankDisplay(card))
                .font(size.font)
            Text(card.suitSymbol)
                .font(size.font)
        }
        .foregroundStyle(card.isRed ? Color(red: 0.78, green: 0.16, blue: 0.16) : Color(red: 0.13, green: 0.13, blue: 0.16))
        .frame(width: w, height: h)
        .background(cream)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(red: 0.35, green: 0.30, blue: 0.22).opacity(0.45), lineWidth: 1)
        )
        .opacity(dimmed ? 0.35 : 1)
        .shadow(color: .black.opacity(0.45), radius: 4, y: 3)
    }

    /// أسماء الرتب البلوتية للعرض — شايب/بنت/ولد/إكّه، والأرقام كما هي (T تعرض 10).
    /// عرض فقط؛ قيمة الورقة الحقيقية (code) لا تُمس وتبقى من الخادم.
    static func rankDisplay(_ card: BalootCardDTO) -> String {
        switch card.rankLabel {
        case "A": return "إكّه"
        case "K": return "شايب"
        case "Q": return "بنت"
        case "J": return "ولد"
        case "T": return "10"
        default: return card.rankLabel
        }
    }
}
