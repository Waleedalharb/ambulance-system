//
//  OpsVehiclesView.swift
//  EMSOperations
//
//  المركبات (§10): لوحة الأسطول من GET /api/vehicles/board + الإسناد
//  والتبديل والدعم وتغيير الحالة (ops.vehicles) + تاريخ المركبة + السجل
//  المرجعي (admin — authorize(['admin']) سيرفريًا). قانون append-only:
//  لا حذف؛ الإنهاء/التبديل أحداث تُغلق المفتوح بختم سيرفري.
//

import SwiftUI

struct OpsVehiclesView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = OpsVehiclesViewModel()

    private enum Sheet: Identifiable {
        case status(VehiclesBoardDTO.Vehicle)
        case assign(VehiclesBoardDTO.Vehicle)
        case switchTeam(VehiclesBoardDTO.Vehicle)
        case support(VehiclesBoardDTO.Vehicle)
        var id: String {
            switch self {
            case .status(let v): return "status-\(v.id)"
            case .assign(let v): return "assign-\(v.id)"
            case .switchTeam(let v): return "switch-\(v.id)"
            case .support(let v): return "support-\(v.id)"
            }
        }
    }

    @State private var sheet: Sheet?
    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var reason: ReasonRequest?
    @State private var reasonText = ""

    // حقول النماذج
    @State private var newStatus = "active"
    @State private var statusReason = ""
    @State private var actionNote = ""
    @State private var targetTeamId: Int?

    private var canOps: Bool { session.permissions.canVehicleOps }
    private var isAdmin: Bool { session.permissions.isAdmin }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 3)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(showLoading: true) } }
                case .loaded:
                    content
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
        .refreshable { await vm.reload() }
        .emsPage("المركبات")
        .task { await vm.load() }
        .navigationDestination(for: String.self) { value in
            if value == "registry" {
                VehicleRegistryView()
            } else {
                VehicleHistoryView(vehicleId: value)
            }
        }
        .sheet(item: $sheet) { sheetContent($0) }
        .sheet(item: $reason) { req in reasonSheet(req) }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
    }

    @ViewBuilder
    private var content: some View {
        if let counters = vm.data?.counters {
            countersCard(counters)
        }
        if isAdmin {
            NavigationLink(value: "registry") {
                EMSCard {
                    HStack(spacing: 12) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .foregroundStyle(EMSTheme.Colors.teal)
                        Text("السجل المرجعي للمركبات")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                        Spacer()
                        Image(systemName: "chevron.left")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
        }
        assignedSection
        supportSection
        unassignedSection
    }

    // MARK: - العدّادات (من الخادم كما هي)

    private func countersCard(_ c: VehiclesBoardDTO.Counters) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "حالة الأسطول", systemImage: "truck.box.fill")
                HStack(spacing: 14) {
                    counter(c.active, "عاملة", EMSTheme.Colors.emerald)
                    counter(c.reserve, "احتياط", EMSTheme.Colors.teal)
                    counter(c.breakdown, "متعطلة", EMSTheme.Colors.warning)
                    counter(c.outOfService, "خارج الخدمة", EMSTheme.Colors.danger)
                    Spacer()
                    if working { ProgressView().tint(EMSTheme.Colors.teal) }
                }
            }
        }
    }

    private func counter(_ value: Int?, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value ?? 0)")
                .font(.title3.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
    }

    // MARK: - المعيّنة

    @ViewBuilder
    private var assignedSection: some View {
        let list = vm.data?.vehicles ?? []
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "المعيّنة للفرق")
                ForEach(list) { v in
                    vehicleCard(v, assigned: true)
                }
            }
        }
    }

    private func vehicleCard(_ v: VehiclesBoardDTO.Vehicle, assigned: Bool) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: assigned ? "truck.box.fill" : "truck.box")
                        .foregroundStyle(assigned ? EMSTheme.Colors.teal : EMSTheme.Colors.textMuted)
                    Text(v.displayName)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white)
                    Spacer()
                    if let status = v.status {
                        EMSStatusPill(text: vm.statusLabel(status), tone: vm.statusTone(status))
                    } else {
                        EMSStatusPill(text: "بلا حالة", tone: .neutral)
                    }
                }
                if v.inWorkshop == true {
                    EMSStatusPill(text: "في الورشة", tone: .monitor)
                }
                if let teamId = v.teamId, let name = vm.teamName(teamId) {
                    EMSInfoRow(label: "الفريق", value: name)
                }
                if let reason = v.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 8) {
                    if let vid = v.vehicleId {
                        NavigationLink(value: vid) {
                            Label("التاريخ", systemImage: "clock.arrow.circlepath")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .tint(EMSTheme.Colors.teal)

                        if canOps {
                            vehicleActions(v, vehicleId: vid)
                        }
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    @ViewBuilder
    private func vehicleActions(_ v: VehiclesBoardDTO.Vehicle, vehicleId: String) -> some View {
        Menu {
            Button {
                newStatus = v.status ?? "active"
                statusReason = ""; actionNote = ""
                sheet = .status(v)
            } label: { Label("تغيير الحالة", systemImage: "wrench.and.screwdriver") }

            if v.teamId == nil {
                Button {
                    actionNote = ""; targetTeamId = vm.teams.first?.teamId
                    sheet = .assign(v)
                } label: { Label("إسناد لفريق", systemImage: "person.badge.plus") }
            } else {
                Button {
                    actionNote = ""
                    confirm = ConfirmRequest(title: "إنهاء الإسناد",
                        message: "سيُغلق إسناد «\(v.displayName)» بختم سيرفري.",
                        run: { try await vm.endAssignment(vehicleId: vehicleId, note: nil); return "تم إنهاء الإسناد" })
                } label: { Label("إنهاء الإسناد", systemImage: "person.badge.minus") }
                Button {
                    actionNote = ""; targetTeamId = vm.teams.first?.teamId
                    sheet = .switchTeam(v)
                } label: { Label("تبديل الفريق", systemImage: "arrow.triangle.2.circlepath") }
                if v.supportingTeamId == nil {
                    Button {
                        actionNote = ""; targetTeamId = vm.teams.first?.teamId
                        sheet = .support(v)
                    } label: { Label("إرسال دعمًا", systemImage: "arrowshape.turn.up.right") }
                } else {
                    Button {
                        actionNote = ""
                        confirm = ConfirmRequest(title: "إنهاء الدعم",
                            message: "سيُغلق دعم «\(v.displayName)» ويعود لفريقه الأصلي.",
                            run: { try await vm.endSupport(vehicleId: vehicleId, note: nil); return "تم إنهاء الدعم" })
                    } label: { Label("إنهاء الدعم", systemImage: "arrowshape.turn.up.left") }
                }
            }
        } label: {
            Label("إجراءات", systemImage: "ellipsis.circle")
                .font(.caption.weight(.semibold))
        }
        .buttonStyle(.bordered)
        .tint(EMSTheme.Colors.teal)
        .disabled(working)
    }

    // MARK: - الدعم المفتوح (مركبة تدعم فريقًا آخر)

    @ViewBuilder
    private var supportSection: some View {
        let list = vm.data?.support ?? []
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "الدعم المفتوح")
                ForEach(list) { s in
                    // نص فريق الدعم يُحضَّر محليًا — بلا interpolation متداخل (Swift compile).
                    let supportTeamText: String = {
                        if let targetId = s.targetTeamId {
                            if let resolved = vm.teamName(targetId), !resolved.isEmpty { return resolved }
                            return "فريق رقم \(targetId)"
                        }
                        return "—"
                    }()
                    EMSCard {
                        HStack(spacing: 10) {
                            Image(systemName: "arrow.triangle.swap")
                                .foregroundStyle(EMSTheme.Colors.teal)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(s.name ?? s.vehicleId ?? "مركبة")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Text("تدعم \(supportTeamText)")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    // MARK: - غير المعيّنة

    @ViewBuilder
    private var unassignedSection: some View {
        let list = vm.data?.unassigned ?? []
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "غير المعيّنة")
                ForEach(list) { v in
                    vehicleCard(v, assigned: false)
                }
            }
        }
    }

    // MARK: - النماذج (Sheets)

    @ViewBuilder
    private func sheetContent(_ sheet: Sheet) -> some View {
        switch sheet {
        case .status(let v): statusSheet(v)
        case .assign(let v): teamPickSheet(v, title: "إسناد لفريق", button: "إسناد") { vid, tid, note in
            try await vm.assign(vehicleId: vid, teamId: tid, note: note)
            return "تم إسناد المركبة"
        }
        case .switchTeam(let v): teamPickSheet(v, title: "تبديل الفريق", button: "تبديل") { vid, tid, note in
            try await vm.switchAssignment(vehicleId: vid, teamId: tid, note: note)
            return "تم تبديل المركبة"
        }
        case .support(let v): teamPickSheet(v, title: "إرسال دعمًا", button: "إرسال") { vid, tid, note in
            try await vm.support(vehicleId: vid, targetTeamId: tid, note: note)
            return "تم إرسال المركبة دعمًا"
        }
        }
    }

    private var reasonNeeded: Bool { newStatus == "breakdown" || newStatus == "out_of_service" }

    private func statusSheet(_ v: VehiclesBoardDTO.Vehicle) -> some View {
        formShell("حالة «\(v.displayName)»") {
            Picker("الحالة", selection: $newStatus) {
                Text("عاملة").tag("active")
                Text("احتياط").tag("reserve")
                Text("متعطلة").tag("breakdown")
                Text("خارج الخدمة").tag("out_of_service")
            }
            .pickerStyle(.segmented)
            if reasonNeeded {
                TextField("السبب (إلزامي)", text: $statusReason, axis: .vertical)
                    .lineLimit(2...4)
                    .textFieldStyle(.plain)
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                    .padding(12)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            TextField("ملاحظة (اختياري)", text: $actionNote)
                .textFieldStyle(.plain)
                .foregroundStyle(EMSTheme.Colors.textPrimary)
                .padding(12)
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            EMSPrimaryButton(title: "تسجيل الحالة", isLoading: working,
                             isDisabled: reasonNeeded && statusReason.trimmingCharacters(in: .whitespaces).isEmpty) {
                guard let vid = v.vehicleId else { return }
                let status = newStatus
                let reasonText = statusReason.trimmingCharacters(in: .whitespaces)
                let note = actionNote.trimmingCharacters(in: .whitespaces)
                self.sheet = nil
                execute {
                    try await vm.setStatus(vehicleId: vid, status: status,
                                           reason: reasonText.isEmpty ? nil : reasonText,
                                           note: note.isEmpty ? nil : note)
                    return "تم تسجيل حالة المركبة"
                }
            }
        }
    }

    private func teamPickSheet(_ v: VehiclesBoardDTO.Vehicle, title: String, button: String,
                               run: @escaping (String, Int, String?) async throws -> String) -> some View {
        formShell("\(title) — \(v.displayName)") {
            Menu {
                ForEach(vm.teams) { team in
                    Button(team.name ?? "فريق \(team.teamId ?? 0)") { targetTeamId = team.teamId }
                }
            } label: {
                HStack {
                    Text(targetTeamId.flatMap { vm.teamName($0) } ?? "اختر الفريق")
                        .foregroundStyle(targetTeamId == nil ? EMSTheme.Colors.textMuted : EMSTheme.Colors.textPrimary)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                .padding(12)
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            TextField("ملاحظة (اختياري)", text: $actionNote)
                .textFieldStyle(.plain)
                .foregroundStyle(EMSTheme.Colors.textPrimary)
                .padding(12)
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            EMSPrimaryButton(title: button, isLoading: working, isDisabled: targetTeamId == nil) {
                guard let vid = v.vehicleId, let tid = targetTeamId else { return }
                let note = actionNote.trimmingCharacters(in: .whitespaces)
                self.sheet = nil
                execute { try await run(vid, tid, note.isEmpty ? nil : note) }
            }
        }
    }

    private func formShell<Content: View>(_ title: String,
                                          @ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) { content() }
                    .padding(EMSTheme.pagePadding)
            }
            .background(EMSBackground())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { self.sheet = nil }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.large])
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
                    Button("إلغاء") { reason = nil; reasonText = "" }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.large])
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

// MARK: - ViewModel

@MainActor
final class OpsVehiclesViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: VehiclesBoardDTO?
    @Published private(set) var teams: [OpsTeamsDTO.Team] = []

    private let api = APIClient.shared

    func load(showLoading: Bool = true) async {
        if showLoading { state = .loading }
        await reload()
    }

    func reload() async {
        do {
            async let boardCall: VehiclesBoardDTO = api.get("/api/vehicles/board")
            async let teamsCall: OpsTeamsDTO = api.get("/api/teams")
            let (board, teamsRes) = try await (boardCall, teamsCall)
            data = board
            teams = (teamsRes.teams ?? []).filter { ($0.isActive ?? 1) == 1 }
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: data != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func teamName(_ teamId: Int) -> String? {
        teams.first { $0.teamId == teamId }?.name
    }

    // MARK: - الكتابات (ops.vehicles — الحسم النهائي سيرفري)

    func setStatus(vehicleId: String, status: String, reason: String?, note: String?) async throws {
        let res: VehicleActionResponseDTO = try await api.post("/api/vehicles/events",
            body: VehicleStatusEventRequest(vehicleId: vehicleId, status: status, reason: reason, note: note))
        if res.success == false { throw APIError.server(res.error ?? "فشل في حفظ حالة المركبة") }
        await reload()
    }

    func assign(vehicleId: String, teamId: Int, note: String?) async throws {
        let res: VehicleActionResponseDTO = try await api.post("/api/vehicles/assignment",
            body: VehicleAssignmentRequest(vehicleId: vehicleId, teamId: teamId, note: note))
        if res.success == false { throw APIError.server(res.error ?? "فشل في تعيين المركبة") }
        await reload()
    }

    func endAssignment(vehicleId: String, note: String?) async throws {
        let res: VehicleActionResponseDTO = try await api.post("/api/vehicles/assignment/end",
            body: VehicleActionNoteRequest(vehicleId: vehicleId, note: note))
        if res.success == false { throw APIError.server(res.error ?? "فشل في إنهاء التعيين") }
        await reload()
    }

    func switchAssignment(vehicleId: String, teamId: Int, note: String?) async throws {
        let res: VehicleActionResponseDTO = try await api.post("/api/vehicles/assignment/switch",
            body: VehicleAssignmentRequest(vehicleId: vehicleId, teamId: teamId, note: note))
        if res.success == false { throw APIError.server(res.error ?? "فشل في نقل المركبة") }
        await reload()
    }

    func support(vehicleId: String, targetTeamId: Int, note: String?) async throws {
        let res: VehicleActionResponseDTO = try await api.post("/api/vehicles/support",
            body: VehicleSupportRequest(vehicleId: vehicleId, targetTeamId: targetTeamId, note: note))
        if res.success == false { throw APIError.server(res.error ?? "فشل في إرسال الدعم") }
        await reload()
    }

    func endSupport(vehicleId: String, note: String?) async throws {
        let res: VehicleActionResponseDTO = try await api.post("/api/vehicles/support/end",
            body: VehicleActionNoteRequest(vehicleId: vehicleId, note: note))
        if res.success == false { throw APIError.server(res.error ?? "فشل في إنهاء الدعم") }
        await reload()
    }

    // MARK: - عرض الحالات (القيم سيرفرية — التسمية عرضية فقط)

    func statusLabel(_ status: String) -> String {
        switch status {
        case "active": return "عاملة"
        case "reserve": return "احتياط"
        case "breakdown": return "متعطلة"
        case "out_of_service": return "خارج الخدمة"
        default: return status
        }
    }

    func statusTone(_ status: String) -> EMSTheme.StatusTone {
        switch status {
        case "active": return .normal
        case "reserve": return .action
        case "breakdown": return .monitor
        case "out_of_service": return .danger
        default: return .neutral
        }
    }
}
