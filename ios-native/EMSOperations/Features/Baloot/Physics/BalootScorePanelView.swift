//
//  BalootScorePanelView.swift
//  EMSOperations
//
//  لوحة الحسبة — المرحلة 03 (§8):
//   · تظهر بعد فجوة ≈1.1ث من مسح الطاولة (scorePanelDelay).
//   · الخلفية تُعتَّم خلفها، وجزيئات لمعان ذهبية حول أطرافها عند الظهور.
//   · تبقى ثابتة؛ الإغلاق: بداية صفقة جديدة (يمسحها الـViewModel) أو
//     لمس الخلفية — ⚠️ آلية الإغلاق TEMPORARY (P-P7: زر/تلقائي غير محسوم).
//
//  المحتوى من حدث hand_scored الخادمي فقط (raw/المشاريع/البلوت/delta) —
//  بلا أي حساب عميلي (A7).
//  ⚠️ صف «الأرض» غير معروض: الخادم يضمّن مكافأة آخر أكلة داخل raw ولا
//  يفصلها بحقل مستقل، وفصلها عميليًا يخالف A7 — PENDING بقرار المالك.
//  التصميم النهائي للوحة (تخطيط المرجع الكامل) يُستكمل في مرحلة HUD (04).
//

import SwiftUI

struct BalootScorePanelView: View {
    let detail: BalootHandScoreDetailDTO
    /// فريقي ("A"/"B") — nil للمشاهد (تُعرض A/B كما في شريط النقاط).
    let myTeam: String?
    let onDismiss: () -> Void

    private let gold = Color(red: 0.82, green: 0.66, blue: 0.32)
    private let cream = Color(red: 0.98, green: 0.965, blue: 0.92)

    private var oursKey: String { myTeam == "B" ? "B" : "A" }
    private var theirsKey: String { myTeam == "B" ? "A" : "B" }
    private var oursLabel: String { myTeam == nil ? "A" : "لنا" }
    private var theirsLabel: String { myTeam == nil ? "B" : "لهم" }

    private func points(_ p: BalootTeamPointsDTO?, _ key: String) -> Int {
        key == "A" ? (p?.A ?? 0) : (p?.B ?? 0)
    }

    private func projectPoints(_ key: String) -> Int {
        (detail.projects ?? [])
            .filter { $0.team == key }
            .reduce(0) { $0 + ($1.multiplied ?? $1.base ?? 0) }
    }

    var body: some View {
        ZStack {
            // تعتيم الخلفية — لمسها يغلق اللوحة (TEMPORARY P-P7)
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .onTapGesture { onDismiss() }

            ZStack {
                panel
                BalootSparkleBurst()
            }
        }
        .transition(.opacity)
    }

    private var panel: some View {
        VStack(spacing: 10) {
            Text("حسبة الصفقة")
                .font(.headline.weight(.bold))
                .foregroundStyle(gold)

            scoreRow("الأكلات", ours: points(detail.raw, oursKey), theirs: points(detail.raw, theirsKey))
            scoreRow("المشاريع", ours: projectPoints(oursKey), theirs: projectPoints(theirsKey))
            if (detail.balootPts?.A ?? 0) + (detail.balootPts?.B ?? 0) > 0 {
                scoreRow("البلوت", ours: points(detail.balootPts, oursKey), theirs: points(detail.balootPts, theirsKey))
            }
            scoreRow("النقاط", ours: points(detail.delta, oursKey), theirs: points(detail.delta, theirsKey), highlight: true)

            if let note = detail.note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(Color(red: 0.35, green: 0.30, blue: 0.22).opacity(0.8))
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 20)
        .frame(maxWidth: 340)
        .background(cream)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(gold, lineWidth: 2)
        )
        .shadow(color: .black.opacity(0.5), radius: 18, y: 8)
        .onTapGesture { /* اللوحة نفسها لا تُغلق باللمس — الخلفية فقط */ }
    }

    private func scoreRow(_ title: String, ours: Int, theirs: Int, highlight: Bool = false) -> some View {
        HStack {
            Text("\(theirs)")
                .font(highlight ? .title3.weight(.heavy) : .subheadline.weight(.bold))
                .foregroundStyle(Color(red: 0.78, green: 0.16, blue: 0.16))
                .frame(width: 56)
            Spacer()
            Text(title)
                .font(highlight ? .subheadline.weight(.heavy) : .subheadline)
                .foregroundStyle(Color(red: 0.20, green: 0.17, blue: 0.13))
            Spacer()
            Text("\(ours)")
                .font(highlight ? .title3.weight(.heavy) : .subheadline.weight(.bold))
                .foregroundStyle(Color(red: 0.16, green: 0.55, blue: 0.35))
                .frame(width: 56)
        }
        .padding(.vertical, highlight ? 6 : 2)
        .padding(.horizontal, highlight ? 10 : 0)
        .background(highlight ? gold.opacity(0.25) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

// MARK: - جزيئات اللمعان الذهبية (§8)

/// دفقة لمعان قصيرة حول أطراف اللوحة عند ظهورها — مواضع ثابتة مشتقة
/// (لا عشوائية متغيرة بين الإطارات)، تتلاشى خلال ≈0.9ث.
struct BalootSparkleBurst: View {
    @State private var progress: CGFloat = 0

    /// (x، y) نسبيًا حول اللوحة + تأخير + حجم — قيم ثابتة.
    private let particles: [(x: CGFloat, y: CGFloat, delay: Double, size: CGFloat)] = [
        (-0.55, -0.42, 0.00, 6), (0.52, -0.48, 0.08, 5), (-0.48, 0.44, 0.05, 5),
        (0.55, 0.40, 0.12, 6), (-0.30, -0.52, 0.15, 4), (0.30, 0.52, 0.03, 4),
        (-0.58, 0.05, 0.18, 4), (0.58, -0.08, 0.10, 4)
    ]

    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(0..<particles.count, id: \.self) { i in
                    let p = particles[i]
                    Circle()
                        .fill(Color(red: 0.90, green: 0.76, blue: 0.40))
                        .frame(width: p.size, height: p.size)
                        .opacity(Double(max(0, 1 - progress)))
                        .scaleEffect(0.6 + progress * 0.8)
                        .position(x: geo.size.width / 2 + p.x * geo.size.width,
                                  y: geo.size.height / 2 + p.y * geo.size.height)
                        .animation(BalootPhysics.flightAnimation(0.9, delay: p.delay), value: progress)
                }
            }
        }
        .frame(maxWidth: 380, maxHeight: 320)
        .onAppear { progress = 1 }
        .allowsHitTesting(false)
    }
}
