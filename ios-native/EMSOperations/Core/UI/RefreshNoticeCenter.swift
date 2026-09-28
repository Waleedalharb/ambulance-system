//
//  RefreshNoticeCenter.swift
//  EMSOperations
//
//  سياسة فشل التحديث المركزية (توجيه المالك 2026-09-19 — بند 7/8):
//  «فشل طلب عابر أثناء Pull-to-Refresh ≠ موت جلسة ≠ شاشة خطأ كاملة».
//  - موت الجلسة (401 بعد فشل التحديث) يعالجه APIClient.authFailureHandler وحده.
//  - الفشل العابر (timeout/offline/5xx) مع وجود محتوى معروض ⇒ يبقى المحتوى
//    كما هو، ويظهر تنبيه عابر أعلى الصفحة يختفي تلقائيًا، وإعادة المحاولة
//    تكون بالسحب مجددًا أو بزر Retry عندما لا يوجد محتوى أصلًا.
//  التنبيه يُعرض مركزيًا من EMSPageModifier — لا تعديل UI في أي شاشة.
//

import SwiftUI

@MainActor
final class RefreshNoticeCenter: ObservableObject {
    static let shared = RefreshNoticeCenter()

    @Published private(set) var message: String?

    private var dismissTask: Task<Void, Never>?

    private init() {}

    /// نشر تنبيه عابر — يستبدل أي تنبيه قائم ويختفي تلقائيًا بعد 4 ثوانٍ.
    func post(_ message: String) {
        dismissTask?.cancel()
        self.message = message
        dismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.message = nil
        }
    }

    func dismiss() {
        dismissTask?.cancel()
        dismissTask = nil
        message = nil
    }
}

/// قرار موحد لكل ViewModels: هل نسقط لحالة فشل كاملة أم نحتفظ بالمحتوى؟
@MainActor
enum RefreshFailurePolicy {
    /// يعيد true عندما وُجد محتوى قائم — نشر التنبيه العابر ولا حالة فشل.
    /// يعيد false عندما لا يوجد محتوى — على الـViewModel الانتقال لـ.failed
    /// (شاشة الخطأ الكاملة مع Retry تبقى متاحة عند الحاجة الفعلية).
    @discardableResult
    static func keepContent(hasContent: Bool, message: String) -> Bool {
        guard hasContent else { return false }
        RefreshNoticeCenter.shared.post(message)
        return true
    }
}

/// شريط التنبيه العابر — هوية داكنة متسقة، نقره يخفيه فورًا.
struct RefreshNoticeBanner: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        Button(action: onDismiss) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.warning)
                Text(message)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Text("اسحب للتحديث")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(EMSTheme.Colors.card.opacity(0.97))
            .clipShape(Capsule())
            .overlay(Capsule().stroke(EMSTheme.Colors.warning.opacity(0.35), lineWidth: 1))
            .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
            .padding(.horizontal, EMSTheme.pagePadding)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("تنبيه تحديث: \(message)")
    }
}
