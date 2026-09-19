//
//  LoginView.swift
//  EMSOperations
//
//  دخول Native بالكامل (قسم 7) — هوية داكنة، بلا متصفح مضمّن.
//

import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = LoginViewModel()
    @FocusState private var focus: Field?
    @State private var showForgot = false
    @State private var showPassword = false

    enum Field { case username, password }

    var body: some View {
        ZStack {
            EMSBackground()
            ScrollView {
                VStack(spacing: 24) {
                    header
                    form
                }
                .padding(.horizontal, 24)
                .padding(.top, 64)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .alert("تفعيل \(BiometricGate.biometryName)؟", isPresented: $vm.offerBiometric) {
            Button("تفعيل") { Task { await vm.enableBiometricAndContinue(session: session) } }
            Button("لاحقًا", role: .cancel) { Task { await vm.skipBiometricAndContinue(session: session) } }
        } message: {
            Text("استخدم \(BiometricGate.biometryName) لفتح جلستك بسرعة وأمان في المرات القادمة.")
        }
        .sheet(isPresented: $showForgot) {
            NavigationStack { ForgotPasswordView() }
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image("AppLogoMark")
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
            Text("منظومة العمليات الإسعافية")
                .font(.title3.weight(.bold))
                .foregroundColor(.white)
            Text("EMS OPERATIONS")
                .font(.system(.caption, design: .monospaced))
                .tracking(3)
                .foregroundColor(EMSTheme.Colors.teal)
        }
        .accessibilityElement(children: .combine)
    }

    private var form: some View {
        VStack(spacing: 14) {
            EMSCard {
                VStack(spacing: 14) {
                    HStack {
                        Image(systemName: "person.fill")
                            .foregroundColor(EMSTheme.Colors.textMuted)
                        TextField("", text: $vm.username, prompt: Text("اسم المستخدم / الرقم الوظيفي").foregroundColor(EMSTheme.Colors.textMuted))
                            .textContentType(.username)
                            .keyboardType(.numberPad)
                            .focused($focus, equals: .username)
                            .foregroundColor(.white)
                            .tint(EMSTheme.Colors.teal)
                            .multilineTextAlignment(.leading)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Color.white.opacity(0.07))
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    Divider().overlay(EMSTheme.Colors.divider)
                    HStack {
                        Image(systemName: "lock.fill")
                            .foregroundColor(EMSTheme.Colors.textMuted)
                        Group {
                            if showPassword {
                                TextField("", text: $vm.password, prompt: Text("كلمة المرور").foregroundColor(EMSTheme.Colors.textMuted))
                                    .textContentType(.password)
                            } else {
                                SecureField("", text: $vm.password, prompt: Text("كلمة المرور").foregroundColor(EMSTheme.Colors.textMuted))
                                    .textContentType(.password)
                            }
                        }
                        .focused($focus, equals: .password)
                        .foregroundColor(.white)
                        .tint(EMSTheme.Colors.teal)
                        .multilineTextAlignment(.leading)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color.white.opacity(0.07))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        // إظهار/إخفاء كلمة المرور — مخفية افتراضيًا
                        Button {
                            showPassword.toggle()
                        } label: {
                            Image(systemName: showPassword ? "eye.slash.fill" : "eye.fill")
                                .foregroundColor(EMSTheme.Colors.textMuted)
                                .frame(width: 34, height: 34)
                        }
                        .accessibilityLabel(showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور")
                    }
                }
            }

            if let error = vm.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(EMSTheme.Colors.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            EMSPrimaryButton(
                title: "تسجيل الدخول",
                isLoading: vm.isLoading,
                isDisabled: !vm.canSubmit
            ) {
                focus = nil
                Task { await vm.login(session: session) }
            }

            Button("نسيت كلمة المرور؟") { showForgot = true }
                .font(.caption)
                .foregroundColor(EMSTheme.Colors.teal)

            Text("نسعى لنحييها")
                .font(.caption)
                .foregroundColor(EMSTheme.Colors.textMuted)
                .padding(.top, 8)
        }
    }
}
