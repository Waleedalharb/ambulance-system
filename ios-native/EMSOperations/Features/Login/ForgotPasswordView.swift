//
//  ForgotPasswordView.swift
//  EMSOperations
//
//  استعادة كلمة المرور (§1 — auth-reset-service.js): ثلاث خطوات على
//  مسارات عامة بمحدّد معدل أصرم. الرد الأول موحّد لا يكشف وجود الحساب؛
//  الرمز يصل للجوال الموثّق سيرفريًا؛ رمز الاستعادة مرة واحدة/10 دقائق.
//  لا يُقبل رقم جوال من العميل إطلاقًا — identifier فقط.
//

import SwiftUI

struct ForgotPasswordView: View {
    @StateObject private var vm = ForgotPasswordViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                EMSCard {
                    HStack(spacing: 12) {
                        Image(systemName: "lock.rotation")
                            .font(.title2)
                            .foregroundStyle(EMSTheme.Colors.teal)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("استعادة كلمة المرور")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(.white)
                            Text("يُرسل الرمز إلى الجوال الموثّق في ملفك — إن وُجد")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                    }
                }

                if let error = vm.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                switch vm.step {
                case .identifier: identifierStep
                case .code: codeStep
                case .newPassword: newPasswordStep
                case .done: doneStep
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("استعادة كلمة المرور")
    }

    // MARK: - الخطوة 1: المعرّف
    private var identifierStep: some View {
        EMSCard {
            VStack(spacing: 12) {
                HStack {
                    Image(systemName: "person.fill")
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    TextField("اسم المستخدم / الرقم الوظيفي", text: $vm.identifier)
                        .keyboardType(.numberPad)
                        .foregroundStyle(.white)
                }
                EMSPrimaryButton(
                    title: "إرسال الرمز",
                    isLoading: vm.working,
                    isDisabled: vm.identifier.trimmingCharacters(in: .whitespaces).isEmpty
                ) { Task { await vm.requestCode() } }
            }
        }
    }

    // MARK: - الخطوة 2: الرمز
    private var codeStep: some View {
        EMSCard {
            VStack(spacing: 12) {
                Text(vm.uniformMessage)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    Image(systemName: "number")
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    TextField("الرمز المرسل إلى جوالك", text: $vm.code)
                        .keyboardType(.numberPad)
                        .foregroundStyle(.white)
                }
                EMSPrimaryButton(
                    title: "تحقق من الرمز",
                    isLoading: vm.working,
                    isDisabled: vm.code.trimmingCharacters(in: .whitespaces).isEmpty
                ) { Task { await vm.verifyCode() } }
                Button("إعادة إدخال المعرّف") { vm.step = .identifier }
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.teal)
            }
        }
    }

    // MARK: - الخطوة 3: كلمة المرور الجديدة
    private var newPasswordStep: some View {
        EMSCard {
            VStack(spacing: 12) {
                Text("الرمز صحيح — صالح لعشر دقائق ولمرة واحدة.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    SecureField("كلمة المرور الجديدة", text: $vm.newPassword)
                        .textContentType(.newPassword)
                        .foregroundStyle(.white)
                }
                Divider().overlay(EMSTheme.Colors.divider)
                HStack {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    SecureField("تأكيد كلمة المرور", text: $vm.confirmPassword)
                        .textContentType(.newPassword)
                        .foregroundStyle(.white)
                }
                EMSPrimaryButton(
                    title: "تعيين كلمة المرور",
                    isLoading: vm.working,
                    isDisabled: !vm.canReset
                ) { Task { await vm.resetPassword() } }
            }
        }
    }

    // MARK: - تم
    private var doneStep: some View {
        EMSCard {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(EMSTheme.Colors.emerald)
                Text("تم تغيير كلمة المرور بنجاح")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Text("أُبطلت كل الجلسات السابقة — سجّل الدخول بكلمة المرور الجديدة.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .multilineTextAlignment(.center)
                EMSPrimaryButton(title: "العودة لتسجيل الدخول") { dismiss() }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

// MARK: - ViewModel
@MainActor
final class ForgotPasswordViewModel: ObservableObject {
    enum Step { case identifier, code, newPassword, done }

    @Published var step: Step = .identifier
    @Published var identifier = ""
    @Published var code = ""
    @Published var newPassword = ""
    @Published var confirmPassword = ""
    @Published var working = false
    @Published var errorMessage: String? = nil
    @Published var uniformMessage = ""

    private var resetToken: String? = nil
    private let api = APIClient.shared

    var canReset: Bool {
        !newPassword.isEmpty && newPassword == confirmPassword && resetToken != nil
    }

    func requestCode() async {
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            let res: ForgotPasswordResponseDTO = try await api.postPublic(
                "/api/auth/forgot-password",
                body: ForgotPasswordBody(identifier: identifier.trimmingCharacters(in: .whitespaces)))
            uniformMessage = res.message ?? "إن كان الحساب مسجلًا وموثقًا فسيصله رمز"
            step = .code
        } catch let e as APIError {
            errorMessage = e.userMessage
        } catch {
            errorMessage = APIError.unknown.userMessage
        }
    }

    func verifyCode() async {
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            let res: VerifyResetCodeResponseDTO = try await api.postPublic(
                "/api/auth/verify-reset-code",
                body: VerifyResetCodeBody(
                    identifier: identifier.trimmingCharacters(in: .whitespaces),
                    code: code.trimmingCharacters(in: .whitespaces)))
            guard let token = res.resetToken else { throw APIError.decoding }
            resetToken = token
            step = .newPassword
        } catch let e as APIError {
            errorMessage = e.userMessage
        } catch {
            errorMessage = APIError.unknown.userMessage
        }
    }

    func resetPassword() async {
        guard let token = resetToken else { return }
        working = true
        errorMessage = nil
        defer { working = false }
        do {
            let _: BasicSuccessDTO = try await api.postPublic(
                "/api/auth/reset-password",
                body: ResetPasswordBody(token: token, newPassword: newPassword))
            step = .done
        } catch let e as APIError {
            errorMessage = e.userMessage
        } catch {
            errorMessage = APIError.unknown.userMessage
        }
    }
}
