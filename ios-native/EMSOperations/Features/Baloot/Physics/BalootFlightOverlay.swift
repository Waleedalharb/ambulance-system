//
//  BalootFlightOverlay.swift
//  EMSOperations
//
//  طبقة طيران الورق — المرحلة 03:
//   · BalootFlightCard: نموذج رحلة ورقة واحدة (من→إلى، قياس، ميلان).
//   · BalootFlightOverlay: يرسم كل الأوراق الطائرة فوق الساحة.
//   · BalootGoldenEventText: نص «بلوت» الذهبي فوق منطقة اللعب (§7).
//   · BalootPointsPopup: popup النقاط الأخضر الطافي (§4) — جاهز لكنه
//     غير مفعّل: قيمة النقاط غير متاحة من الخادم حاليًا (PENDING).
//
//  الحركة: مسار شبه مستقيم، تصغير تدريجي من حجم الرفع إلى حجم الطاولة،
//  ميلان يقلّ من ميلان الطيران إلى ميلان الاستقرار — بلا Flip وبلا
//  ارتداد، والورقة تطير وجهًا لأعلى دائمًا (§2).
//

import SwiftUI

// MARK: - نموذج الرحلة

struct BalootFlightCard: Identifiable {
    let id = UUID()
    let card: BalootCardDTO
    /// مقعد صاحب الورقة (مطلق) — لاشتقاق الميلان الثابت.
    let seat: Int
    let from: CGPoint
    let to: CGPoint
    let fromScale: CGFloat
    let toScale: CGFloat
    let fromAngle: Double
    let toAngle: Double
    let duration: Double
    let delay: Double
    /// جمع الأكلة: الورقة تختفي عند وصولها لجهة الفائز.
    let fadeOut: Bool
    /// توزيع الخصوم: ورقة ظهرًا لأعلى كما في المرجع (21.0) — لا Flip (§2).
    var faceDown: Bool = false
}

// MARK: - ورقة طائرة واحدة

private struct BalootFlyingCardView: View {
    let flight: BalootFlightCard
    @State private var progress: CGFloat = 0

    /// استيفاء خطي يعمل مع CGFloat (موضع/قياس) وDouble (زاوية) معًا.
    private func lerp<T: BinaryFloatingPoint>(_ a: T, _ b: T) -> T {
        a + (b - a) * T(progress)
    }

    var body: some View {
        Group {
            if flight.faceDown {
                // ظهر «قطاع الجنوب» الرسمي (Stage 07) — المُصيّر المشترك
                BalootCardBack(size: .medium)
            } else {
                BalootCardFace(card: flight.card, size: .medium)
            }
        }
            .scaleEffect(lerp(flight.fromScale, flight.toScale))
            .rotationEffect(.degrees(lerp(flight.fromAngle, flight.toAngle)))
            .opacity(flight.fadeOut ? Double(1 - progress) : 1)
            .position(x: lerp(flight.from.x, flight.to.x),
                      y: lerp(flight.from.y, flight.to.y))
            .onAppear {
                withAnimation(BalootPhysics.flightAnimation(flight.duration, delay: flight.delay)) {
                    progress = 1
                }
            }
            .allowsHitTesting(false)
    }
}

// MARK: - الطبقة العلوية لكل الرحلات

/// تُوضع فوق ساحة الطاولة بنفس الإحداثيات (مرجعها feltRect) — كل ورقة
/// طائرة تُرسم بـ .position المطلق داخل الحاوية، فوق كل عناصر اللعب.
struct BalootFlightOverlay: View {
    let flights: [BalootFlightCard]

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(flights) { flight in
                BalootFlyingCardView(flight: flight)
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - نص «بلوت» الذهبي (§7)

/// يظهر فوق منطقة اللعب مباشرة عند نزول ثانية K/Q حكم — متزامنًا مع
/// هبوط الورقة الثانية. ⚠️ مدة البقاء TEMPORARY (P-P8).
struct BalootGoldenEventText: View {
    let text: String
    let lifetime: Double
    @State private var visible = false

    private let gold = Color(red: 0.82, green: 0.66, blue: 0.32)

    var body: some View {
        Text(text)
            .font(.title.weight(.heavy))
            .foregroundStyle(gold)
            .shadow(color: .black.opacity(0.6), radius: 6, y: 2)
            .opacity(visible ? 1 : 0)
            .scaleEffect(visible ? 1 : 0.8)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.2)) { visible = true }
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: UInt64(lifetime * 1_000_000_000))
                    withAnimation(.easeInOut(duration: 0.25)) { visible = false }
                }
            }
            .allowsHitTesting(false)
    }
}

// MARK: - popup النقاط (§4) — PENDING التفعيل

/// رقم أخضر يطفو للأعلى ويختفي خلال ≈1.0ث فوق منطقة الأكلة.
/// ⚠️ غير مفعّل حاليًا: حدث trick_won الخادمي لا يحمل قيمة النقاط،
/// وحسابها في العميل يخالف قاعدة A7 (الخادم وحده يعرف القواعد).
/// التفعيل ينتظر قرار المالك: تمديد الخادم بقيمة النقاط أو الاكتفاء بلا رقم.
struct BalootPointsPopup: View {
    let text: String
    @State private var progress: CGFloat = 0

    var body: some View {
        Text(text)
            .font(.headline.weight(.heavy))
            .foregroundStyle(Color(red: 0.25, green: 0.75, blue: 0.45))
            .shadow(color: .black.opacity(0.5), radius: 4, y: 2)
            .offset(y: -30 * progress)
            .opacity(Double(1 - progress))
            .onAppear {
                withAnimation(.easeOut(duration: BalootPhysics.pointsPopupLifetime)) {
                    progress = 1
                }
            }
            .allowsHitTesting(false)
    }
}
