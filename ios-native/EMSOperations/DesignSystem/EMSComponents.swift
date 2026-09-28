//
//  EMSComponents.swift
//  EMSOperations
//
//  مكونات موحدة: بطاقة، زر، شارة حالة، وحالات التحميل/الخطأ/الفراغ
//  (قسم 27 — لا شاشة بيضاء أبدًا).
//

import SwiftUI
import UIKit

// MARK: - بطاقة
struct EMSCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }

    var body: some View {
        content
            .padding(EMSTheme.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }
}

// MARK: - عنوان قسم
struct EMSectionHeader: View {
    let title: String
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .foregroundStyle(EMSTheme.Colors.teal)
            }
            Text(title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textPrimary)
            Spacer()
        }
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - زر رئيسي
struct EMSPrimaryButton: View {
    let title: String
    var isLoading = false
    var isDisabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if isLoading { ProgressView().tint(.white) }
                else {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(isDisabled ? EMSTheme.Colors.teal.opacity(0.4) : EMSTheme.Colors.teal)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .disabled(isDisabled || isLoading)
    }
}

// MARK: - شارة حالة
struct EMSStatusPill: View {
    let text: String
    let tone: EMSTheme.StatusTone

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(tone.color).frame(width: 8, height: 8)
            Text(text)
                .font(.caption.weight(.medium))
                .foregroundStyle(tone.color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(tone.color.opacity(0.14))
        .clipShape(Capsule())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - صف معلومة
struct EMSInfoRow: View {
    let label: String
    let value: String
    var valueColor: Color = EMSTheme.Colors.textPrimary

    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
        }
    }
}

// MARK: - هيكل تحميل (Skeleton)
struct EMSSkeletonCard: View {
    var lines: Int = 3
    @State private var phase: CGFloat = 0

    var body: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(0..<lines, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.white.opacity(0.10))
                        .frame(height: 14)
                        .frame(maxWidth: i == 0 ? 180 : .infinity)
                }
            }
        }
        .opacity(0.7 + 0.3 * sin(phase))
        .onAppear {
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { phase = .pi }
        }
        .accessibilityLabel("جارٍ التحميل")
    }
}

// MARK: - حالة خطأ + إعادة
struct EMSErrorView: View {
    let message: String
    var retry: (() -> Void)? = nil

    var body: some View {
        EMSCard {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.title2)
                    .foregroundStyle(EMSTheme.Colors.warning)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                    .multilineTextAlignment(.center)
                if let retry {
                    Button("إعادة المحاولة", action: retry)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }
}

// MARK: - حالة فراغ
struct EMSEmptyView: View {
    let icon: String
    let title: String
    var detail: String? = nil

    var body: some View {
        EMSCard {
            VStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }
}

// MARK: - خلفية الصفحة
struct EMSBackground: View {
    var body: some View {
        EMSTheme.Colors.navy.ignoresSafeArea()
    }
}

/// معدِّل موحد لصفحات المحتوى (خلفية + حاشية + عنوان شريط)
/// + شريط التنبيه العابر لفشل التحديث (توجيه المالك 2026-09-19 بند 7) —
/// يظهر فوق أي صفحة تستخدم emsPage بلا أي تعديل في الشاشات.
struct EMSPageModifier: ViewModifier {
    let title: String
    @ObservedObject private var notice = RefreshNoticeCenter.shared
    func body(content: Content) -> some View {
        content
            .background(EMSBackground())
            .overlay(alignment: .top) {
                if let message = notice.message {
                    RefreshNoticeBanner(message: message) { notice.dismiss() }
                        .padding(.top, 6)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.25), value: notice.message)
            .navigationTitle(title)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(EMSTheme.Colors.navy, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

extension View {
    func emsPage(_ title: String) -> some View { modifier(EMSPageModifier(title: title)) }

    /// الحقول الرقمية/الأكواد/التواريخ/الجوال (توجيه المالك 2026-09-20 — بند 2):
    /// سلوك LTR مستقر داخل واجهة RTL — لا تختفي الأرقام ولا ينقلب تموضع
    /// المؤشر، مع بقاء التصميم العربي حولها كما هو.
    func emsNumericInput() -> some View {
        environment(\.layoutDirection, .leftToRight)
            .multilineTextAlignment(.leading)
    }
}

// MARK: - حقل رقمي UIKit (تجربة محصورة في LoginView — اعتماد المالك 2026-09-20)
/// ثلاث نسخ SwiftUI (بيئة LTR / محاذاة leading / طبيعي) فشلت على الجهاز بنفس
/// التوقيع: الـcaret ينجذب للجهة المعاكسة أثناء التحرير والنص يُقصّ خارج الرؤية.
/// السبب أن SwiftUI TextField في iOS 16 لا يضبط طبقة UITextField الحية تحت
/// RTL المفروض — فهذا الـwrapper يضبط الحقل الحقيقي صراحة: محاذاة يمين +
/// دلالة RTL + numberPad + ألوان ثابتة، والقيمة/المؤشر لا يُعاد رسمهما
/// أثناء الكتابة (updateUIView لا يلمس النص إلا عند اختلاف خارجي).
/// لا تعميم على النماذج قبل نجاح اختبار A/B/C/D على الجهاز.
struct EMSNumericField: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var placeholder: String = ""

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, isFocused: $isFocused) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.textAlignment = .right
        field.semanticContentAttribute = .forceRightToLeft
        field.keyboardType = .numberPad
        field.textColor = .white
        field.tintColor = UIColor(EMSTheme.Colors.teal)
        field.attributedPlaceholder = NSAttributedString(
            string: placeholder,
            attributes: [.foregroundColor: UIColor(EMSTheme.Colors.textMuted)])
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.textContentType = .username
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.editingChanged(_:)),
                        for: .editingChanged)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.required, for: .vertical)
        return field
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        if uiView.text != text { uiView.text = text }
        if isFocused, !uiView.isFirstResponder { uiView.becomeFirstResponder() }
        else if !isFocused, uiView.isFirstResponder { uiView.resignFirstResponder() }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        let text: Binding<String>
        let isFocused: Binding<Bool>
        init(text: Binding<String>, isFocused: Binding<Bool>) {
            self.text = text
            self.isFocused = isFocused
        }
        @objc func editingChanged(_ sender: UITextField) { text.wrappedValue = sender.text ?? "" }
        func textFieldDidBeginEditing(_ textField: UITextField) { isFocused.wrappedValue = true }
        func textFieldDidEndEditing(_ textField: UITextField) { isFocused.wrappedValue = false }
    }
}

// MARK: - أزرار التواصل المشتركة (اعتماد المالك 2026-09-20)
/// اتصال/رسالة لأي شخص يصل رقمه من الخادم. بوابة staff.phone_view مطبقة
/// خادميًا في كل المسارات (زملائي/التكميل/الحوض/المرشحون): الخادم لا يرسل
/// phone إلا للمخوَّل، فالعميل يعرض الأزرار عند وجود الرقم فقط ولا يتجاوز
/// ذلك أبدًا. 📞 اتصال iPhone · 💬 تطبيق الرسائل (قرار المالك — لا Chat).
struct EMSContactButtons: View {
    let phone: String

    var body: some View {
        let digits = phone.filter(\.isNumber)
        HStack(spacing: 12) {
            if let tel = URL(string: "tel://\(digits)"), !digits.isEmpty {
                Link(destination: tel) {
                    Image(systemName: "phone.fill")
                        .foregroundStyle(EMSTheme.Colors.emerald)
                        .frame(width: 34, height: 34)
                        .background(EMSTheme.Colors.emerald.opacity(0.14))
                        .clipShape(Circle())
                }
                .accessibilityLabel("اتصال")
            }
            if let sms = URL(string: "sms:\(digits)"), !digits.isEmpty {
                Link(destination: sms) {
                    Image(systemName: "message.fill")
                        .foregroundStyle(EMSTheme.Colors.teal)
                        .frame(width: 34, height: 34)
                        .background(EMSTheme.Colors.teal.opacity(0.14))
                        .clipShape(Circle())
                }
                .accessibilityLabel("رسالة")
            }
        }
    }
}
