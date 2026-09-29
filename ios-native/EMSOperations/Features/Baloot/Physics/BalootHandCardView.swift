//
//  BalootHandCardView.swift
//  EMSOperations
//
//  ورقة يد اللاعب — المرحلة 03 (§1/§5/§6):
//   · نفس مظهر الورقة القائم حرفيًا (مروحة/رفع المسموح/توهجه/🌟).
//   · سحب الورقة: تتبع الإصبع + تكبير الرفع ≈1.45× أثناء السحب، وإفلات
//     فوق العتبة = رمية (نفس مسار اللعب القائم)، وإفلات دونها = عودة.
//     ⚠️ كل عتبات الإيماءة TEMPORARY/PENDING (P-P1) في BalootGestureTuning
//     — معزولة هنا ولا تُعتبر مواصفة نهائية.
//   · دخول التوزيع: مع كل صفقة جديدة (dealToken) تطير الورقة من مركز
//     الطاولة إلى موضعها في المروحة (≈0.45ث، ميلان ±10°، تتابع بالفهرس).
//   · tap-to-play القائم يبقى كما هو بجانب السحب (مؤقت — P-P1).
//

import SwiftUI

struct BalootHandCardView: View {
    let card: BalootCardDTO
    let index: Int
    let total: Int
    let allowed: Bool
    let canBaloot: Bool
    let playing: Bool
    /// رقم الصفقة — تغيّره يشغّل دخول التوزيع.
    let dealToken: Int
    /// الإزاحة من موضع الورقة في المروحة إلى مركز الطاولة (نقطة انطلاق التوزيع).
    let dealDelta: CGSize
    /// مسار اللعب القائم حرفيًا: true = الورقة تدعم بلوت (حوار التأكيد)، false = لعب عادي.
    let onPlay: (Bool) -> Void
    /// ورقة لُعبت محليًا بانتظار صدى الخادم — تُخفى حتى لا يُقرأ بقاؤها
    /// ثم طيرانها كحدثين منفصلين (إصلاح 4: الاختفاء = بداية الرمي).
    var hidden: Bool = false

    @State private var drag: CGSize = .zero
    @State private var dragging = false
    @State private var arrived = true
    @State private var seenDeal = -1
    /// اتجاه الواجهة — إحداثيات إيماءة السحب تتأثر به (RTL يقلب X) بينما
    /// .offset مطلق؛ نبطل قلب X فقط عند RTL (إصلاح 1-A — لا Double Inversion).
    @Environment(\.layoutDirection) private var layoutDirection

    /// ⚠️ TEMPORARY (P-P1) — عتبات الإيماءة غير مثبتة؛ معزولة وقابلة للضبط.
    private let tuning = BalootGestureTuning()

    private var fanAngle: Double { Double(index - (total - 1) / 2) * 3.5 }
    private var dealAngle: Double { (index % 2 == 0 ? 1 : -1) * BalootPhysics.dealTilt }

    var body: some View {
        BalootCardFace(card: card, size: .hand, dimmed: playing && !allowed)
            // ميلان المروحة يُصفَّر أثناء الرفع (إصلاح 2 — الورقة تستوي في الإصبع)
            .rotationEffect(.degrees(dragging ? 0 : fanAngle), anchor: .bottom)
            .offset(y: allowed ? -12 : 0)
            .shadow(color: allowed ? EMSTheme.Colors.teal.opacity(0.55) : .clear,
                    radius: allowed ? 10 : 0)
            // دخول التوزيع: من مركز الطاولة إلى موضع المروحة
            .offset(arrived ? .zero : dealDelta)
            .rotationEffect(.degrees(arrived ? 0 : dealAngle), anchor: .bottom)
            // سحب الإصبع: تتبع + تكبير الرفع المرصود
            .offset(drag)
            .scaleEffect(dragging ? BalootPhysics.liftScale : 1)
            .zIndex(dragging ? 100 : 0)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: allowed)
            // رفع تدريجي (تكبير + استواء) بدل القفزة اللحظية — ⚠️ TEMPORARY (إصلاح 2)
            .animation(.easeOut(duration: tuning.liftDuration), value: dragging)
            .onTapGesture {
                guard tuning.tapToPlayEnabled, allowed, !hidden else { return }
                onPlay(canBaloot)
            }
            .gesture(dragGesture)
            .overlay(alignment: .top) {
                if canBaloot {
                    Text("🌟")
                        .font(.caption)
                        .offset(y: -14)
                }
            }
            .opacity(hidden ? 0 : 1)
            .onAppear { seenDeal = dealToken; arrived = true }
            .onChange(of: dealToken) { newValue in
                guard newValue != seenDeal, newValue > 0 else { return }
                seenDeal = newValue
                startDealEntry()
            }
    }

    /// ⚠️ TEMPORARY (P-P1): التتبع/العتبات/الإرجاع كلها قابلة للضبط.
    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: tuning.dragStartThreshold)
            .onChanged { value in
                guard allowed, !hidden else { return }
                dragging = true
                let rawX = value.translation.width * tuning.trackingRatio
                drag = CGSize(
                    // RTL يقلب إشارة X من الإيماءة — نبطلها هنا فقط؛ Y كما هو
                    width: layoutDirection == .rightToLeft ? -rawX : rawX,
                    height: value.translation.height * tuning.trackingRatio
                )
            }
            .onEnded { value in
                guard allowed else { drag = .zero; dragging = false; return }
                dragging = false
                if -value.translation.height > tuning.throwThreshold {
                    // إفلات فوق العتبة = رمية — نفس مسار اللعب القائم
                    drag = .zero
                    onPlay(canBaloot)
                } else {
                    withAnimation(.easeOut(duration: tuning.returnDuration)) {
                        drag = .zero
                    }
                }
            }
    }

    /// طيران ورقة التوزيع من المركز — تُستدعى مرة واحدة لكل صفقة جديدة.
    private func startDealEntry() {
        arrived = false
        let delay = Double(index) * BalootPhysics.dealStagger
        DispatchQueue.main.async {
            withAnimation(BalootPhysics.flightAnimation(BalootPhysics.dealFlightDuration, delay: delay)) {
                arrived = true
            }
        }
    }
}
