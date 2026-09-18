//
//  SignoutsOpsView.swift
//  EMSOperations
//
//  خروج الفرق (§26 — signouts): اقتراح التشكيلة من آخر تسليم معتمد
//  (GET /api/signouts/suggest) · تسجيل خروج (POST /api/signouts —
//  ops.team_exit) · سجل تسجيلات المناوبة النشطة (GET /api/signouts).
//  append-only: إعادة التسجيل تصحيح يبقي الأثر — لا UPDATE. الخادم يختم
//  المناوبة والتاريخ والمستخدم؛ الواجهة ترسل الفرقة والأسماء والملاحظات فقط.
//

import SwiftUI

struct SignoutsOpsView: View {
    @StateObject private var vm = SignoutsOpsViewModel()
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if session.permissions.canTeamExit { recordSection }
                    logSection
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("خروج الفرق")
        .task { await vm.load() }
        .refreshable { await vm.load() }
        .alert("تم", isPresented: $vm.showSuccess) {
            Button("حسنًا", role: .cancel) {}
        } message: {
            Text("سُجّل خروج الفرقة — إعادة التسجيل تُنشئ حدثًا تصحيحيًا جديدًا ولا تمحو السابق.")
        }
    }

    // MARK: - تسجيل الخروج (ops.team_exit)
    private var recordSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSSectionHeader(title: "تسجيل خروج فرقة", systemImage: "rectangle.portrait.and.arrow.right")

            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("الفرقة")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(vm.teamNames, id: \.self) { name in
                                Button {
                                    Task { await vm.selectTeam(name) }
                                } label: {
                                    Text(name)
                                        .font(.caption.weight(.semibold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(vm.selectedTeam == name
                                                    ? EMSTheme.Colors.teal.opacity(0.25)
                                                    : EMSTheme.Colors.card)
                                        .foregroundStyle(vm.selectedTeam == name
                                                         ? EMSTheme.Colors.teal : .white)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if vm.loadingSuggest {
                        ProgressView().tint(EMSTheme.Colors.teal)
                    } else if !vm.suggestedMembers.isEmpty {
                        Text(vm.suggestSourceText)
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        // المقترح قابل للتعديل — التسجيل يوثّق من أنهى المناوبة فعلًا.
                        ForEach(vm.suggestedMembers, id: \.self) { member in
                            Button {
                                vm.toggleMember(member)
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: vm.checkedMembers.contains(member)
                                          ? "checkmark.square.fill" : "square")
                                        .foregroundStyle(vm.checkedMembers.contains(member)
                                                         ? EMSTheme.Colors.teal
                                                         : EMSTheme.Colors.textMuted)
                                    Text(member)
                                        .font(.subheadline)
                                        .foregroundStyle(.white)
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    } else if vm.selectedTeam != nil {
                        Text("لا يوجد اقتراح — أدخل الأسماء يدويًا في الملاحظات أو راجع التشكيلة.")
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }

                    TextField("ملاحظات (اختياري)", text: $vm.notes)
                        .textFieldStyle(.roundedBorder)

                    EMSPrimaryButton(
                        title: "تسجيل الخروج",
                        isLoading: vm.submitting,
                        isDisabled: !vm.canSubmit
                    ) { Task { await vm.record() } }
                }
            }
        }
    }

    // MARK: - سجل تسجيلات المناوبة النشطة
    private var logSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSSectionHeader(title: "تسجيلات المناوبة النشطة", systemImage: "list.clipboard.fill")
            if vm.signouts.isEmpty {
                EMSEmptyView(icon: "rectangle.portrait.and.arrow.right",
                             title: "لا توجد تسجيلات خروج في المناوبة النشطة")
            } else {
                ForEach(vm.signouts) { s in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(s.team ?? "—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                EMSStatusPill(text: "خروج مسجل", tone: .normal)
                            }
                            if let members = s.members, !members.isEmpty {
                                EMSInfoRow(label: "الأفراد", value: members.joined(separator: "، "))
                            }
                            if let notes = s.notes, !notes.isEmpty {
                                EMSInfoRow(label: "ملاحظات", value: notes)
                            }
                            EMSInfoRow(label: "سجّله", value: s.recordedByName ?? "—")
                            EMSInfoRow(label: "الوقت", value: s.createdAt ?? "—")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

// MARK: - ViewModel
@MainActor
final class SignoutsOpsViewModel: ObservableObject {
    enum LoadState { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var teamNames: [String] = []
    @Published var signouts: [SignoutDTO] = []

    @Published var selectedTeam: String? = nil
    @Published var suggestedMembers: [String] = []
    @Published var checkedMembers: Set<String> = []
    @Published var suggestSourceText = ""
    @Published var loadingSuggest = false
    @Published var notes = ""
    @Published var submitting = false
    @Published var showSuccess = false

    private let api = APIClient.shared

    var canSubmit: Bool {
        selectedTeam != nil && !checkedMembers.isEmpty && !submitting
    }

    func load() async {
        state = .loading
        do {
            async let teamsReq: OpsTeamsDTO = api.get("/api/teams")
            async let signoutsReq: SignoutListResponseDTO = api.get("/api/signouts")
            let t = try await teamsReq
            teamNames = (t.teams ?? []).compactMap { $0.name }
            signouts = (try await signoutsReq).signouts ?? []
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func selectTeam(_ name: String) async {
        selectedTeam = name
        loadingSuggest = true
        defer { loadingSuggest = false }
        do {
            let s: SignoutSuggestDTO = try await api.get(
                "/api/signouts/suggest", query: ["team": name])
            suggestedMembers = s.members ?? []
            checkedMembers = Set(suggestedMembers)
            suggestSourceText = s.sourceText
        } catch {
            suggestedMembers = []
            checkedMembers = []
            suggestSourceText = ""
        }
    }

    func toggleMember(_ member: String) {
        if checkedMembers.contains(member) { checkedMembers.remove(member) }
        else { checkedMembers.insert(member) }
    }

    func record() async {
        guard let team = selectedTeam else { return }
        submitting = true
        defer { submitting = false }
        do {
            // ترتيب الأسماء كما في الاقتراح — ترتيب عرض فقط.
            let members = suggestedMembers.filter { checkedMembers.contains($0) }
                + checkedMembers.filter { !suggestedMembers.contains($0) }.sorted()
            let body = SignoutRecordBody(
                team: team,
                members: members,
                notes: notes.trimmingCharacters(in: .whitespaces).isEmpty ? nil : notes,
                createdAt: nil)
            let res: BasicSuccessDTO = try await api.post("/api/signouts", body: body)
            if res.success == false { throw APIError.server("فشل تسجيل الخروج") }
            notes = ""
            showSuccess = true
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
