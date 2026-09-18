//
//  CompletionSupportView.swift
//  EMSOperations
//
//  الدعم والتطوع (§7): حوض الدعم المتاح من الخادم (المجدولون غير
//  المنشغلين + متطوعو الحوض) — تفعيل لفريق (activation) أو إسناد دعم
//  خارجي (external_support بفريق هدف). إضافة متطوع بصلاحية
//  ops.volunteers من مرشحي الخادم (النشطون − المجدولون للعمل الفعلي).
//

import SwiftUI

struct CompletionSupportView: View {
    @EnvironmentObject private var vm: CompletionOpsViewModel
    @EnvironmentObject private var session: SessionStore

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var assignTarget: SupportPoolDTO.Supporter?
    @State private var volunteerQuery = ""
    @State private var candidates: [VolunteerCandidatesDTO.Candidate] = []
    @State private var searching = false
    @State private var volunteerNote = ""

    private var canWrite: Bool { session.permissions.canCompleteOps }
    private var canVolunteer: Bool { session.permissions.canVolunteers }
    private var teamNames: [String] { vm.state?.sortedTeamNames ?? [] }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                poolSection
                if canVolunteer { volunteerSection }
                if let infoMessage {
                    Text(infoMessage)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.emerald)
                        .multilineTextAlignment(.center)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.danger)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("الدعم والتطوع")
        .refreshable { await vm.refresh() }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
        .sheet(item: $assignTarget) { supporter in
            assignSheet(supporter)
        }
    }

    // MARK: - حوض الدعم

    private var poolSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "الدعم المتاح (\(vm.supporters.count))", systemImage: "person.2.fill")
                if vm.supporters.isEmpty {
                    Text("لا قوى متاحة للدعم في هذه المناوبة.")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                } else {
                    ForEach(vm.supporters) { s in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(s.name ?? "—")
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                                    if s.volunteer == true {
                                        EMSStatusPill(text: "متطوع", tone: .monitor)
                                    }
                                }
                                Text([s.jobTitle, s.team ?? s.sourceUnit, s.shiftCode]
                                        .compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            Spacer()
                            if canWrite {
                                Button {
                                    assignTarget = s
                                } label: {
                                    Text("إسناد")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 6)
                                        .background(EMSTheme.Colors.teal.opacity(0.12))
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                                .disabled(working || teamNames.isEmpty)
                            }
                        }
                    }
                }
            }
        }
    }

    /// ورقة الإسناد: اختيار الفريق ثم تفعيل (activation) أو دعم خارجي.
    private func assignSheet(_ s: SupportPoolDTO.Supporter) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            EMSInfoRow(label: "الموظف", value: s.name ?? "—")
                            if let code = s.shiftCode {
                                EMSInfoRow(label: "رمز اليوم", value: code)
                            }
                        }
                    }
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            EMSectionHeader(title: "اختر الفريق الهدف", systemImage: "person.3")
                            ForEach(teamNames, id: \.self) { team in
                                HStack(spacing: 8) {
                                    Text(team)
                                        .font(.subheadline)
                                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                                    Spacer()
                                    Button("تفعيل") {
                                        let name = s.name ?? ""
                                        assignTarget = nil
                                        confirm = ConfirmRequest(title: "تفعيل",
                                                                 message: "تفعيل \(name) ضمن فريق \(team)؟") {
                                            let res = try await vm.activate(employeeName: name, teamName: team, note: nil)
                                            return "تم التفعيل — أُلحق \(res.appended ?? 0) حدث"
                                        }
                                    }
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(EMSTheme.Colors.emerald)
                                    Button("دعم خارجي") {
                                        let name = s.name ?? ""
                                        assignTarget = nil
                                        confirm = ConfirmRequest(title: "دعم خارجي",
                                                                 message: "إسناد \(name) دعمًا خارجيًا لفريق \(team)؟") {
                                            let res = try await vm.sendPersonEvent(type: "external_support",
                                                                                   employee: name, teamId: team)
                                            return res.message.map { "\($0) — أُلحق \(res.appended ?? 0) حدث" }
                                        }
                                    }
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(EMSTheme.Colors.teal)
                                }
                            }
                        }
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .background(EMSBackground())
            .navigationTitle("إسناد دعم")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { assignTarget = nil }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - التطوع

    private var volunteerSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "إضافة متطوع", systemImage: "hand.raised.fill")
                HStack(spacing: 8) {
                    TextField("ابحث بالاسم أو الرقم الوظيفي", text: $volunteerQuery)
                        .textFieldStyle(.plain)
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                        .padding(10)
                        .background(Color.white.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .submitLabel(.search)
                        .onSubmit { runSearch() }
                    Button {
                        runSearch()
                    } label: {
                        if searching { ProgressView().tint(.white) }
                        else { Image(systemName: "magnifyingglass").foregroundStyle(.white) }
                    }
                    .frame(width: 40, height: 40)
                    .background(EMSTheme.Colors.teal)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .disabled(searching || volunteerQuery.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ForEach(candidates) { c in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.name ?? "—")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                            Text([c.employeeCode, c.jobTitle, c.dayCode].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                        Button("تطوع") {
                            confirm = ConfirmRequest(title: "تسجيل تطوع",
                                                     message: "إضافة \(c.name ?? "—") إلى حوض الدعم كمتطوع؟") {
                                let res = try await vm.addVolunteer(name: c.name, code: c.employeeCode, note: nil)
                                return "سُجل التطوع — أُلحق \(res.appended ?? 0) حدث"
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.emerald)
                        .disabled(working)
                    }
                }
                Text("المرشحون من الخادم: النشطون غير المجدولين للعمل الفعلي اليوم ولا مشغّل مفتوح عليهم.")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
    }

    private func runSearch() {
        let q = volunteerQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true
        Task {
            candidates = (try? await vm.searchVolunteers(q)) ?? []
            searching = false
        }
    }

    private func execute(_ work: @escaping () async throws -> String?) {
        errorMessage = nil
        working = true
        Task {
            do { infoMessage = try await work() }
            catch let e as APIError { errorMessage = e.userMessage }
            catch { errorMessage = APIError.unknown.userMessage }
            working = false
        }
    }
}
