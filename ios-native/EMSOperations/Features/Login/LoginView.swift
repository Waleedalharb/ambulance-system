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
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image("AppLogoMark")
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
            Text("منظومة العمليات الإسعافية")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
            Text("EMS OPERATIONS")
                .font(.system(.caption, design: .monospaced))
                .tracking(3)
                .foregroundStyle(EMSTheme.Colors.teal)
        }
        .accessibilityElement(children: .combine)
    }

    private var form: some View {
        VStack(spacing: 14) {
            EMSCard {
                VStack(spacing: 14) {
                    HStack {
                        Image(systemName: "person.fill")
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        TextField("اسم المستخدم / الرقم الوظيفي", text: $vm.username)
                            .textContentType(.username)
                            .keyboardType(.numberPad)
                            .focused($focus, equals: .username)
                            .foregroundStyle(.white)
                    }
                    Divider().overlay(EMSTheme.Colors.divider)
                    HStack {
                        Image(systemName: "lock.fill")
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        SecureField("كلمة المرور", text: $vm.password)
                            .textContentType(.password)
                            .focused($focus, equals: .password)
                            .foregroundStyle(.white)
                    }
                }
            }

            if let error = vm.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.danger)
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

            Text("نسعى لنحييها")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .padding(.top, 8)
        }
    }
}
