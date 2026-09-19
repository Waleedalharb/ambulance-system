//
//  CompletionOpsView.swift
//  EMSOperations
//
//  مساحة عمل التكميل (§7): قرارات الفرق (مكتمل/ناقص/خارج الخدمة)،
//  أحداث الأشخاص (غياب/تأخر/وصول/تصحيح/إنهاء دعم وتفعيل) — كلها
//  عبر POST /api/shift-completion وخدمات staffing بختم سيرفري.
//  الإجراءات بصلاحية ops.completion فقط؛ القراءة لكل مستخدم مصادق.
//

import SwiftUI

/// طلب تأكيد عام — يعرض alert ثم ينفّذ.
struct ConfirmRequest: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    var destructive: Bool = false
    let run: () async throws -> String?
}

/// طلب إدخال سبب عام — يعرض sheet بحقل نص ثم ينفّذ.
struct ReasonRequest: Identifiable {
    let id = UUID()
    let title: String
    var placeholder: String = "السبب (إلزامي)"
    var requiresReason: Bool = true
    let run: (String) async throws -> String?
}

struct CompletionOpsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = CompletionOpsViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var reason: ReasonRequest?
    @State private var reasonText = ""

    private var canWrite: Bool { session.permissions.canCompleteOps }

    var body: some View {
        Group {
            switch vm.bootState {
            case .loading:
                VStack(spacing: EMSTheme.spacing) {
                    EMSSkeletonCard(lines: 3)
                    EMSSkeletonCard(lines: 5)
                }
                .padding(EMSTheme.pagePadding)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.load() } }
                    .padding(EMSTheme.pagePadding)
            case .loaded:
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .emsPage("التكميل")
        .task { await vm.load() }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
        .sheet(item: $reason) { req in
            reasonSheet(req)
        }
    }

    // MARK: - المحتوى

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if vm.shiftId == nil {
                    EMSEmptyView(icon: "moon.zzz", title: "لا توجد مناوبة نشطة",
                                 detail: "التكميل يتطلب مناوبة نشطة — ابدأ مناوبة من لوحة القيادة أولًا.")
                } else {
                    shiftHeader
                    teamsSection
                    linksSection
                }
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
        .refreshable { await vm.refresh() }
    }

    private var shiftHeader: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: "checklist.checked")
                        .foregroundStyle(EMSTheme.Colors.teal)
                    Text(vm.shiftLabel)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if working { ProgressView().tint(EMSTheme.Colors.teal) }
                }
                if let w = vm.state?.workforce {
                    EMSInfoRow(label: "الكادر", value: "\(w.totalStaff ?? 0) / \(w.totalRequired ?? 0)")
                    EMSInfoRow(label: "فرق جاهزة", value: "\(w.readyTeams ?? 0)")
                    EMSInfoRow(label: "فرق ناقصة", value: "\(w.missingTeams ?? 0)",
                               valueColor: (w.missingTeams ?? 0) > 0 ? EMSTheme.Colors.warning : EMSTheme.Colors.textPrimary)
                    if let rate = w.operationalReadinessRate {
                        EMSInfoRow(label: "جاهزية تشغيلية", value: "\(rate)٪",
                                   valueColor: EMSTheme.StatusTone.normal.color)
                    }
                }
            }
        }
    }

    // MARK: - الفرق

    private var teamsSection: some View {
        let names = vm.state?.sortedTeamNames ?? []
        return VStack(spacing: EMSTheme.spacing) {
            if names.isEmpty {
                EMSEmptyView(icon: "person.3", title: "لا توجد فرق في اشتقاق الجاهزية")
            } else {
                ForEach(names, id: \.self) { name in
                    if let team = vm.state?.teams?[name] {
                        teamCard(name: name, team: team)
                    }
                }
            }
        }
    }

    private func statusTone(_ status: String?) -> EMSTheme.StatusTone {
        switch status {
        case "ready": return .normal
        case "missing": return .monitor
        case "offline": return .danger
        default: return .neutral
        }
    }

    private func statusTitle(_ status: String?) -> String {
        switch status {
        case "ready": return "مكتمل"
        case "missing": return "ناقص"
        case "offline": return "خارج الخدمة"
        default: return "بانتظار القرار"
        }
    }

    private func teamCard(name: String, team: StaffingStateDTO.TeamReadiness) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(name)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    EMSStatusPill(text: statusTitle(team.status), tone: statusTone(team.status))
                }
                EMSInfoRow(label: "الأفراد", value: "\(team.activeCount ?? 0) / \(team.requiredPersonnel ?? 0)")
                if let reason = team.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                if let members = team.members, !members.isEmpty {
                    ForEach(members) { member in
                        memberRow(member, team: name)
                    }
                }
                if let absentees = team.absentees, !absentees.isEmpty {
                    ForEach(absentees) { a in
                        HStack {
                            Image(systemName: "person.fill.xmark")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.danger)
                            Text(a.name ?? "—")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                            Spacer()
                            Text(a.type == "late" ? "تأخر" : "غياب")
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.danger)
                        }
                    }
                }
                if canWrite { decisionButtons(team: name) }
            }
        }
    }

    private func memberRow(_ member: StaffingStateDTO.Member, team: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name ?? "—")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Text(memberSubtitle(member))
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            Spacer()
            if canWrite { memberMenu(member, team: team) }
        }
    }

    private func memberSubtitle(_ m: StaffingStateDTO.Member) -> String {
        var parts: [String] = []
        if let role = m.role {
            parts.append(role == "support" ? "دعم" : role == "activation" ? "تفعيل" : "أساسي")
        }
        if let state = m.state, state != "active" {
            parts.append(state == "absence" ? "غائب" : state == "late" ? "متأخر" : state)
        }
        if let from = m.fromCenter, !from.isEmpty { parts.append("من \(from)") }
        return parts.joined(separator: " · ")
    }

    private func memberMenu(_ m: StaffingStateDTO.Member, team: String) -> some View {
        Menu {
            Button("تسجيل غياب") {
                reason = ReasonRequest(title: "سبب غياب \(m.name ?? "—")") { r in
                    let res = try await vm.sendPersonEvent(type: "absence", employee: m.name ?? "",
                                                           teamId: team, reason: r)
                    return res.message.map { "\($0) — أُلحق \(res.appended ?? 0) حدث" }
                }
            }
            Button("تسجيل تأخر") {
                reason = ReasonRequest(title: "سبب تأخر \(m.name ?? "—")") { r in
                    let res = try await vm.sendPersonEvent(type: "late", employee: m.name ?? "",
                                                           teamId: team, reason: r)
                    return res.message.map { "\($0) — أُلحق \(res.appended ?? 0) حدث" }
                }
            }
            Button("تسجيل وصول") {
                confirm = ConfirmRequest(title: "تسجيل وصول",
                                         message: "تسجيل وصول \(m.name ?? "—")؟ (يُتخطى سيرفريًا إن لم يوجد غياب/تأخر مفتوح)") {
                    let res = try await vm.sendPersonEvent(type: "arrival", employee: m.name ?? "", teamId: team)
                    return res.message.map { "\($0) — أُلحق \(res.appended ?? 0) حدث" }
                }
            }
            Menu("تصحيح الحالة") {
                Button("إلغاء التأخر") { correction("late_void", member: m, team: team) }
                Button("إلغاء الغياب") { correction("absence_void", member: m, team: team) }
                Button("إرجاع الوصول") { correction("arrival_void", member: m, team: team) }
            }
            if m.role == "activation" || m.state == "activation" {
                Button("إنهاء التفعيل") {
                    confirm = ConfirmRequest(title: "إنهاء التفعيل",
                                             message: "إنهاء تفعيل \(m.name ?? "—") وإعادته للحوض؟",
                                             destructive: true) {
                        let res = try await vm.endActivation(employeeName: m.name ?? "", note: nil)
                        return "أُغلق التفعيل — أُلحق \(res.appended ?? 0) حدث"
                    }
                }
            }
            if m.role == "support" || m.state == "assignment" {
                Button("إنهاء الدعم/التكليف") {
                    confirm = ConfirmRequest(title: "إنهاء الدعم",
                                             message: "إنهاء دعم/تكليف \(m.name ?? "—")؟",
                                             destructive: true) {
                        let res = try await vm.sendPersonEvent(type: "support_end",
                                                               employee: m.name ?? "", teamId: team)
                        return res.message.map { "\($0) — أُلحق \(res.appended ?? 0) حدث" }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .foregroundStyle(EMSTheme.Colors.teal)
        }
    }

    private func correction(_ corrects: String, member: StaffingStateDTO.Member, team: String) {
        let titles = ["late_void": "إلغاء التأخر", "absence_void": "إلغاء الغياب", "arrival_void": "إرجاع الوصول"]
        confirm = ConfirmRequest(title: titles[corrects] ?? "تصحيح",
                                 message: "\(titles[corrects] ?? "تصحيح") لـ\(member.name ?? "—")؟ يُوثَّق كتصحيح في سجل الأحداث.") {
            let res = try await vm.sendPersonEvent(type: "correction", employee: member.name ?? "",
                                                   teamId: team, corrects: corrects)
            return res.message.map { "\($0) — أُلحق \(res.appended ?? 0) حدث" }
        }
    }

    private func decisionButtons(team: String) -> some View {
        HStack(spacing: 8) {
            decisionButton("مكتمل", tone: .normal, team: team, status: "ready", needsReason: false)
            decisionButton("ناقص", tone: .monitor, team: team, status: "missing", needsReason: true)
            decisionButton("خارج الخدمة", tone: .danger, team: team, status: "offline", needsReason: true)
        }
    }

    private func decisionButton(_ title: String, tone: EMSTheme.StatusTone,
                                team: String, status: String, needsReason: Bool) -> some View {
        Button {
            if needsReason {
                reason = ReasonRequest(title: "سبب «\(title)» لفريق \(team)") { r in
                    let res = try await vm.setTeamDecision(team: team, status: status, reason: r)
                    return res.message
                }
            } else {
                confirm = ConfirmRequest(title: "قرار فريق",
                                         message: "تعيين فريق \(team) «\(title)»؟ آخر ضغطة تحكم دائمًا.") {
                    let res = try await vm.setTeamDecision(team: team, status: status, reason: nil)
                    return res.message
                }
            }
        } label: {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tone.color)
                .frame(maxWidth: .infinity)
                .frame(height: 34)
                .background(tone.color.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(working)
    }

    // MARK: - روابط الدعم والسجلات

    private var linksSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            NavigationLink {
                CompletionSupportView()
                    .environmentObject(vm)
                    .environmentObject(session)
            } label: {
                linkCard(title: "الدعم والتطوع",
                         subtitle: "حوض الدعم (\(vm.supporters.count)) · تفعيل · متطوعون",
                         icon: "person.badge.plus", tint: EMSTheme.Colors.teal)
            }
            NavigationLink {
                CompletionRecordsView()
                    .environmentObject(vm)
                    .environmentObject(session)
            } label: {
                linkCard(title: "سجلات المناوبة",
                         subtitle: "أحداث (\(vm.events.count)) · غيابات (\(vm.absences.count)) · ملاحظات (\(vm.notes.count))",
                         icon: "doc.text", tint: EMSTheme.Colors.warning)
            }
        }
    }

    private func linkCard(title: String, subtitle: String, icon: String, tint: Color) -> some View {
        EMSCard {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                Spacer()
                Image(systemName: "chevron.left")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
    }

    // MARK: - تنفيذ موحد + ورقة السبب

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

    private func reasonSheet(_ req: ReasonRequest) -> some View {
        NavigationStack {
            VStack(spacing: EMSTheme.spacing) {
                TextField(req.placeholder, text: $reasonText, axis: .vertical)
                    .lineLimit(2...4)
                    .textFieldStyle(.plain)
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                    .padding(12)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                EMSPrimaryButton(title: "تأكيد", isLoading: working,
                                 isDisabled: req.requiresReason && reasonText.trimmingCharacters(in: .whitespaces).isEmpty) {
                    let text = reasonText.trimmingCharacters(in: .whitespaces)
                    reason = nil
                    reasonText = ""
                    execute { try await req.run(text) }
                }
                Spacer()
            }
            .padding(EMSTheme.pagePadding)
            .background(EMSBackground())
            .navigationTitle(req.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") {
                        reason = nil
                        reasonText = ""
                    }
                    .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.large])
    }
}
