//
//  CompletionView.swift
//  EMSOperations
//
//  التكميل — شاشة تشييك المناوبة الكاملة (العقد v4.2 من shift-check-service.js).
//  السيرفر هو SSOT: كل كتابة تُرسل فورًا وبعدها pull كامل، والمعروض دائمًا
//  هو ما أعاده السيرفر. عند الانقطاع تُدرج العملية في PendingCheckStore
//  (تخزين محلي خاص بهذه الميزة فقط — APIClient لا يُعدَّل) وتُعاد عند عودة
//  الاتصال؛ منع التكرار بمفتاح (sessionId+itemKey) للبنود وعملية واحدة
//  لحقول المركبة لكل جلسة، والسيرفر idempotent أصلًا (UNIQUE+ON CONFLICT).
//  «لا تغيير» والتأكيدات لا تُدرَّج offline — أهليتها سيرفرية لحظية.
//  الحالات الصادقة: no_assignment / not_field_team / noEmployee.
//

import SwiftUI

// MARK: - الشاشة

struct CompletionView: View {
    @StateObject private var vm = CompletionViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 2)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .noAssignment:
                    EMSEmptyView(
                        icon: "calendar.badge.exclamationmark",
                        title: "لا يوجد تكليف ميداني اليوم",
                        detail: "التشييك مرتبط بتكليفك الفعلي في المناوبة الحالية")
                case .notFieldTeam:
                    EMSEmptyView(
                        icon: "person.2.slash",
                        title: "التشييك متاح للفرق الميدانية فقط",
                        detail: "تكليفك الحالي ليس ضمن فرقة ميدانية")
                case .noEmployee:
                    EMSEmptyView(
                        icon: "person.crop.circle.badge.exclamationmark",
                        title: "الحساب غير مرتبط بملف موظف",
                        detail: "راجع إدارة النظام لربط حسابك بملف الموظف")
                case .session:
                    sessionContent
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("التكميل")
        .task { await vm.load() }
        .alert("تم التأكيد", isPresented: $vm.showConfirmed) {
            Button("حسنًا") { Task { await vm.load() } }
        } message: {
            Text("سُجّل تأكيدك بنجاح.")
        }
    }

    // MARK: - محتوى الجلسة

    @ViewBuilder
    private var sessionContent: some View {
        if !vm.pendingOps.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath")
                Text("\(vm.pendingOps.count) تغيير بانتظار الاتصال — سيُرسل تلقائيًا ولا يُعتبر محفوظًا قبل رد الخادم")
                    .font(.caption)
            }
            .foregroundStyle(EMSTheme.Colors.warning)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(EMSTheme.Colors.warning.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }

        if let banner = vm.infoBanner {
            Text(banner)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.warning)
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        headerCard
        openIssuesCard
        vehicleCard
        groupsSection
        noChangeCard
        confirmationsCard

        if let error = vm.actionError {
            Text(error)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: ترويسة الجلسة + الجاهزية

    @ViewBuilder
    private var headerCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    EMSectionHeader(title: "تشييك المناوبة", systemImage: "checklist.checked")
                    Spacer()
                    readinessPill
                }
                if let team = vm.dto?.team {
                    EMSInfoRow(label: "الفرقة", value: team.teamName ?? "—")
                    EMSInfoRow(label: "المركز", value: team.center ?? "—")
                }
                EMSInfoRow(label: "المركبة", value: vm.dto?.vehicle?.displayName ?? "لا مركبة مسندة")
                if let reason = vm.dto?.readinessReason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
                if vm.dto?.session?.status == "completed" {
                    EMSStatusPill(text: "الجلسة مكتملة — التسليم تم", tone: .normal)
                }
            }
        }
    }

    @ViewBuilder
    private var readinessPill: some View {
        switch vm.dto?.readiness {
        case "green":  EMSStatusPill(text: "جاهزة", tone: .normal)
        case "yellow": EMSStatusPill(text: "جاهزة مع ملاحظة", tone: .monitor)
        case "red":    EMSStatusPill(text: "غير جاهزة", tone: .danger)
        default:       EMSStatusPill(text: "لم يُستكمل الفحص", tone: .neutral)
        }
    }

    // MARK: الملاحظات المفتوحة (من فحوصات سابقة — يعيدها السيرفر)

    @ViewBuilder
    private var openIssuesCard: some View {
        if let issues = vm.dto?.openIssues, !issues.isEmpty {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    EMSectionHeader(title: "ملاحظات مفتوحة", systemImage: "exclamationmark.triangle")
                    ForEach(issues) { issue in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(issue.label ?? issue.itemKey ?? "بند")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.white)
                            Text([issue.note, issue.byName].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                        }
                    }
                }
            }
        }
    }

    // MARK: حقول المركبة الثابتة

    @ViewBuilder
    private var vehicleCard: some View {
        if vm.dto?.vehicle != nil {
            EMSCard {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        EMSectionHeader(title: "بيانات المركبة", systemImage: "truck.box")
                        Spacer()
                        if vm.vehicleFieldsPending {
                            Image(systemName: "clock.arrow.circlepath")
                                .foregroundStyle(EMSTheme.Colors.warning)
                        }
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("قراءة العداد")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        EMSNumericField(text: $vm.odometerText, isFocused: $vm.odometerFocused,
                                        placeholder: "كيلومترات")
                    }

                    HStack(spacing: 12) {
                        labeledPicker("الوقود", selection: $vm.fuelLevel,
                                      options: [("", "—"), ("100", "100%"), ("75", "75%"), ("50", "50%"),
                                                ("25", "25%"), ("under25", "أقل من 25%")])
                        labeledPicker("النظافة", selection: $vm.cleanliness,
                                      options: [("", "—"), ("clean", "نظيفة"), ("dirty", "تحتاج تنظيفًا")])
                    }
                    HStack(spacing: 12) {
                        labeledIntPicker("المفتاح الأساسي", selection: $vm.masterKey)
                        labeledIntPicker("شريحة الوقود", selection: $vm.fuelCard)
                    }

                    EMSPrimaryButton(title: "حفظ بيانات المركبة",
                                     isLoading: vm.isSavingVehicle,
                                     isDisabled: !vm.isOpen) {
                        Task { await vm.saveVehicleFields() }
                    }
                }
            }
        }
    }

    private func labeledPicker(_ title: String, selection: Binding<String>,
                               options: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            Picker(title, selection: selection) {
                ForEach(options.indices, id: \.self) { Text(options[$0].1).tag(options[$0].0) }
            }
            .pickerStyle(.menu)
            .tint(.white)
            .disabled(!vm.isOpen)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func labeledIntPicker(_ title: String, selection: Binding<Int?>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            Picker(title, selection: selection) {
                Text("—").tag(Int?.none)
                Text("موجود").tag(Int?.some(1))
                Text("غير موجود").tag(Int?.some(0))
            }
            .pickerStyle(.menu)
            .tint(.white)
            .disabled(!vm.isOpen)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: مجموعات التشييك (ميكانيكي + طبي + الأصول — التجميع من السيرفر)

    @ViewBuilder
    private var groupsSection: some View {
        ForEach(vm.dto?.groups ?? []) { group in
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    EMSectionHeader(
                        title: (group.label ?? "مجموعة") + " · \(checkedCount(group))/\((group.items ?? []).count)",
                        systemImage: group.isAssets == true ? "shippingbox" : "checklist")
                    ForEach(group.items ?? []) { item in
                        itemRow(item)
                        if item.id != group.items?.last?.id {
                            Divider().overlay(EMSTheme.Colors.divider)
                        }
                    }
                }
            }
        }
    }

    private func checkedCount(_ group: CheckSessionDTO.Group) -> Int {
        (group.items ?? []).filter { $0.result != nil || $0.noChange == true }.count
    }

    @ViewBuilder
    private func itemRow(_ item: CheckSessionDTO.Item) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.label ?? item.itemKey ?? "بند")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                    if let qty = item.qtyRequired {
                        Text("المطلوب: \(qty)")
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    if let by = item.checkedByName {
                        Text("سجّله: \(by)")
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                Spacer()
                writeStateIcon(item)
            }

            // الحالات الخمس — الإدخال بالضغط، كل ضغطة كتابة فورية للسيرفر
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(vm.itemStatuses, id: \.self) { status in
                        statusButton(item, status)
                    }
                }
            }

            if vm.displayedStatus(item) != nil && vm.displayedStatus(item) != "complete" {
                if vm.displayedStatus(item) == "shortage" {
                    TextField("الكمية المتوفرة", text: vm.qtyBinding(item))
                        .font(.caption)
                        .foregroundStyle(.white)
                        .onSubmit { Task { await vm.submitNote(item) } }
                }
                TextField("ملاحظة (تُحفظ مع البند)", text: vm.noteBinding(item))
                    .font(.caption)
                    .foregroundStyle(.white)
                    .onSubmit { Task { await vm.submitNote(item) } }
            }
        }
    }

    private func statusButton(_ item: CheckSessionDTO.Item, _ status: String) -> some View {
        let selected = vm.displayedStatus(item) == status
        return Button {
            Task { await vm.selectStatus(item, status) }
        } label: {
            Text(CompletionViewModel.statusLabels[status] ?? status)
                .font(.caption.weight(.medium))
                .foregroundStyle(selected ? .white : EMSTheme.Colors.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(selected ? CompletionViewModel.statusColor(status) : EMSTheme.Colors.navySoft)
                .clipShape(Capsule())
        }
        .disabled(!vm.isOpen)
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func writeStateIcon(_ item: CheckSessionDTO.Item) -> some View {
        if let key = item.itemKey, let ws = vm.itemWriteState[key] {
            switch ws {
            case .saving:
                ProgressView().tint(EMSTheme.Colors.teal).scaleEffect(0.8)
            case .pending:
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(EMSTheme.Colors.warning)
            }
        }
    }

    // MARK: «لا تغيير» — يظهر فقط بأهلية سيرفرية، ولا يُدرَج offline

    @ViewBuilder
    private var noChangeCard: some View {
        if vm.isOpen, let nc = vm.dto?.noChange, nc.eligible == true {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    EMSectionHeader(title: "فحص سريع", systemImage: "checkmark.seal")
                    if let at = nc.lastCheck?.at {
                        Text("آخر فحص مكتمل: \(at)")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textSecondary)
                    }
                    EMSPrimaryButton(title: "✓ لا تغيير عن آخر فحص",
                                     isLoading: vm.isConfirming) {
                        Task { await vm.confirmNoChange() }
                    }
                }
            }
        }
    }

    // MARK: تأكيدات الفريق (استلام/تسليم لكل عضو)

    @ViewBuilder
    private var confirmationsCard: some View {
        if let members = vm.dto?.members, !members.isEmpty {
            EMSCard {
                VStack(alignment: .leading, spacing: 10) {
                    EMSectionHeader(title: "تأكيدات الفريق", systemImage: "person.2.badge.checkmark")
                    ForEach(members) { member in
                        HStack {
                            Text(member.name ?? "—")
                                .font(.subheadline)
                                .foregroundStyle(.white)
                            Spacer()
                            confirmationMark(member, kind: "checkin", label: "استلام")
                            confirmationMark(member, kind: "checkout", label: "تسليم")
                        }
                    }
                    if vm.isOpen {
                        HStack(spacing: 10) {
                            EMSPrimaryButton(title: "تأكيد الاستلام",
                                             isLoading: vm.isConfirming,
                                             isDisabled: vm.iConfirmed("checkin")) {
                                Task { await vm.confirm("checkin") }
                            }
                            EMSPrimaryButton(title: "تأكيد التسليم",
                                             isLoading: vm.isConfirming,
                                             isDisabled: vm.iConfirmed("checkout")) {
                                Task { await vm.confirm("checkout") }
                            }
                        }
                    }
                }
            }
        }
    }

    private func confirmationMark(_ member: CheckSessionDTO.Member, kind: String, label: String) -> some View {
        let done = vm.confirmations(member, kind: kind)
        return HStack(spacing: 4) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? EMSTheme.Colors.emerald : EMSTheme.Colors.textMuted)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textSecondary)
        }
    }
}

// MARK: - حالة كتابة عنصر معلّق

enum CheckWriteState: Equatable {
    case saving
    case pending   // لم يصل الخادم — ليس محفوظًا
}

// MARK: - Pending Store (تخزين محلي خاص بالتشييك فقط)

/// عملية كتابة لم تصل الخادم. منع التكرار بنيوي:
/// البنود بمفتاح (sessionId+itemKey) — الضغطة الأحدث تستبدل الأقدم،
/// وحقول المركبة عملية واحدة لكل جلسة (آخر قيمة تربح) — وهذا نفس
/// منطق السيرفر (UNIQUE(session_id,item_key) + upsert).
struct PendingCheckOp: Codable, Identifiable, Equatable {
    enum Kind: String, Codable { case item, vehicleFields }

    let id: UUID
    let sessionId: Int
    let kind: Kind
    let itemKey: String?
    let statusDetail: String?
    let note: String?
    let qtyAvailable: String?
    let vehicleFields: CheckVehicleFieldsRequest?
    let queuedAt: Date

    init(sessionId: Int, kind: Kind, itemKey: String? = nil, statusDetail: String? = nil,
         note: String? = nil, qtyAvailable: String? = nil,
         vehicleFields: CheckVehicleFieldsRequest? = nil) {
        self.id = UUID()
        self.sessionId = sessionId
        self.kind = kind
        self.itemKey = itemKey
        self.statusDetail = statusDetail
        self.note = note
        self.qtyAvailable = qtyAvailable
        self.vehicleFields = vehicleFields
        self.queuedAt = Date()
    }

    var dedupeKey: String {
        switch kind {
        case .item: return "\(sessionId)|item|\(itemKey ?? "")"
        case .vehicleFields: return "\(sessionId)|vehicleFields"
        }
    }
}

/// ملف JSON في Documents — يبقى بعد إغلاق التطبيق. يُستخدم من MainActor فقط.
final class PendingCheckStore {
    static let shared = PendingCheckStore()

    private let fileURL: URL
    private(set) var ops: [PendingCheckOp] = []

    private convenience init() {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.init(fileURL: dir.appendingPathComponent("pending-check-ops.json"))
    }

    /// منفصل عن shared لاختبارات الوحدات (ملف مؤقت لكل اختبار).
    init(fileURL: URL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode([PendingCheckOp].self, from: data) {
            ops = decoded
        }
    }

    /// الإدراج يستبدل أي عملية معلقة بنفس المفتاح — لا تكرار أبدًا.
    func enqueue(_ op: PendingCheckOp) {
        ops.removeAll { $0.dedupeKey == op.dedupeKey }
        ops.append(op)
        persist()
    }

    func remove(_ op: PendingCheckOp) {
        ops.removeAll { $0.id == op.id }
        persist()
    }

    func opsFor(sessionId: Int) -> [PendingCheckOp] {
        ops.filter { $0.sessionId == sessionId }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(ops) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

// MARK: - ViewModel

@MainActor
final class CompletionViewModel: ObservableObject {
    enum State: Equatable {
        case loading
        case failed(String)
        case noAssignment
        case notFieldTeam
        case noEmployee
        case session
    }

    /// الحالات الخمس كما في check-template.js ITEM_STATUSES — تسميات العرض فقط.
    static let statusLabels: [String: String] = [
        "complete": "سليم", "shortage": "ناقص", "damaged": "تالف",
        "unavailable": "غير متوفر", "follow_up": "يحتاج متابعة"
    ]

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "complete": return EMSTheme.Colors.emerald
        case "shortage": return EMSTheme.Colors.warning
        case "damaged", "unavailable": return EMSTheme.Colors.danger
        default: return EMSTheme.Colors.teal
        }
    }

    @Published private(set) var state: State = .loading
    @Published private(set) var dto: CheckSessionDTO?

    /// الحالة المعروضة محليًا حتى يؤكد السيرفر — تُصفَّر من رد السيرفر عند كل pull.
    @Published private(set) var localStatus: [String: String] = [:]
    @Published var itemWriteState: [String: CheckWriteState] = [:]
    @Published private(set) var pendingOps: [PendingCheckOp] = []
    @Published var actionError: String?
    @Published var infoBanner: String?
    @Published var isConfirming = false
    @Published var showConfirmed = false

    // نموذج حقول المركبة (يُزامَن من السيرفر عند أول تحميل فقط — لا نقطع كتابة المستخدم)
    @Published var odometerText = ""
    @Published var odometerFocused = false
    @Published var fuelLevel = ""
    @Published var cleanliness = ""
    @Published var masterKey: Int?
    @Published var fuelCard: Int?
    @Published var isSavingVehicle = false
    @Published var vehicleFieldsPending = false

    private var notes: [String: String] = [:]
    private var qtys: [String: String] = [:]

    private let api = APIClient.shared
    private let store = PendingCheckStore.shared
    private var formSynced = false

    var isOpen: Bool { dto?.session?.status == "open" }

    /// ترتيب الحالات من السيرفر؛ الاحتياطي ثابت القالب عند غيابه (جلسات قديمة).
    var itemStatuses: [String] {
        dto?.itemStatuses ?? ["complete", "shortage", "damaged", "unavailable", "follow_up"]
    }

    // MARK: تحميل

    func load() async {
        if dto == nil { state = .loading }
        actionError = nil
        infoBanner = nil
        do {
            let fresh: CheckSessionDTO = try await api.get("/api/my/check-session")
            apply(fresh)
            // نجاح القراءة يثبت الاتصال — أرسل المعلقات ثم اسحب الحقيقة السيرفرية
            await flushPending()
        } catch let e as APIError {
            if e == .noEmployee { state = .noEmployee; return }
            if !RefreshFailurePolicy.keepContent(hasContent: dto != nil, message: e.userMessage) {
                state = .failed(e.userMessage)
            }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: dto != nil, message: APIError.unknown.userMessage) {
                state = .failed(APIError.unknown.userMessage)
            }
        }
    }

    /// pull صامت بعد كل كتابة ناجحة — السيرفر هو المرجع النهائي للمعروض.
    private func reloadSilent() async {
        if let fresh: CheckSessionDTO = try? await api.get("/api/my/check-session") {
            apply(fresh)
        }
    }

    private func apply(_ fresh: CheckSessionDTO) {
        dto = fresh
        switch fresh.state {
        case "no_assignment": state = .noAssignment; return
        case "not_field_team": state = .notFieldTeam; return
        default: break
        }
        state = .session
        // الحالة المعروضة = حقيقة السيرفر
        localStatus = [:]
        for item in fresh.items ?? [] {
            guard let key = item.itemKey else { continue }
            if let sd = item.statusDetail { localStatus[key] = sd }
            notes[key] = item.note ?? ""
            qtys[key] = item.qtyAvailable ?? ""
            // البند الذي أكد السيرفر حفظه لم يعد معلقًا
            if itemWriteState[key] == .saving { itemWriteState[key] = nil }
        }
        if let sid = fresh.session?.id {
            pendingOps = store.opsFor(sessionId: sid)
            // البنود المعلقة تبقى موسومة حتى نجاح الإرسال
            for op in pendingOps where op.kind == .item {
                if let key = op.itemKey {
                    itemWriteState[key] = .pending
                    if let sd = op.statusDetail { localStatus[key] = sd }
                }
            }
            vehicleFieldsPending = pendingOps.contains { $0.kind == .vehicleFields }
        }
        if !formSynced {
            formSynced = true
            odometerText = fresh.vehicleFields?.odometer.map(String.init) ?? ""
            fuelLevel = fresh.vehicleFields?.fuelLevel ?? ""
            cleanliness = fresh.vehicleFields?.cleanliness ?? ""
            masterKey = fresh.vehicleFields?.masterKey
            fuelCard = fresh.vehicleFields?.fuelCard
        }
    }

    // MARK: عرض البند

    func displayedStatus(_ item: CheckSessionDTO.Item) -> String? {
        guard let key = item.itemKey else { return nil }
        return localStatus[key] ?? item.statusDetail
    }

    func noteBinding(_ item: CheckSessionDTO.Item) -> Binding<String> {
        Binding(
            get: { self.notes[item.itemKey ?? ""] ?? "" },
            set: { self.notes[item.itemKey ?? ""] = $0 }
        )
    }

    func qtyBinding(_ item: CheckSessionDTO.Item) -> Binding<String> {
        Binding(
            get: { self.qtys[item.itemKey ?? ""] ?? "" },
            set: { self.qtys[item.itemKey ?? ""] = $0 }
        )
    }

    // MARK: كتابة بند — فورية لكل ضغطة

    func selectStatus(_ item: CheckSessionDTO.Item, _ status: String) async {
        guard isOpen, let key = item.itemKey else { return }
        localStatus[key] = status
        await writeItem(key: key, status: status)
    }

    func submitNote(_ item: CheckSessionDTO.Item) async {
        guard isOpen, let key = item.itemKey,
              let status = displayedStatus(item), status != "complete" else { return }
        await writeItem(key: key, status: status)
    }

    private func writeItem(key: String, status: String) async {
        itemWriteState[key] = .saving
        actionError = nil
        let note = notes[key]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let qty = qtys[key]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = CheckItemRequest(
            itemKey: key, statusDetail: status,
            note: (note?.isEmpty == false) ? note : nil,
            qtyAvailable: (status == "shortage" && qty?.isEmpty == false) ? qty : nil)
        do {
            let res: CheckWriteResponse = try await api.post("/api/my/check-session/items", body: body)
            if let warning = res.warning { infoBanner = warning }
            itemWriteState[key] = nil
            await reloadSilent()
        } catch let e as APIError {
            if e == .offline || e == .timeout {
                enqueuePending(kind: .item, itemKey: key, statusDetail: status,
                               note: body.note, qtyAvailable: body.qtyAvailable)
                itemWriteState[key] = .pending
            } else {
                itemWriteState[key] = nil
                actionError = e.userMessage
                await reloadSilent()   // رفض السيرفر = عرض حقيقته
            }
        } catch {
            itemWriteState[key] = nil
            actionError = APIError.unknown.userMessage
        }
    }

    // MARK: حقول المركبة

    func saveVehicleFields() async {
        guard isOpen else { return }
        isSavingVehicle = true
        actionError = nil
        defer { isSavingVehicle = false }
        let body = CheckVehicleFieldsRequest(
            odometer: Int(odometerText.trimmingCharacters(in: .whitespaces)),
            fuelLevel: fuelLevel.isEmpty ? nil : fuelLevel,
            cleanliness: cleanliness.isEmpty ? nil : cleanliness,
            masterKey: masterKey, fuelCard: fuelCard)
        do {
            let _: CheckWriteResponse = try await api.post("/api/my/check-session/vehicle-fields", body: body)
            await reloadSilent()
        } catch let e as APIError {
            if e == .offline || e == .timeout {
                enqueuePending(kind: .vehicleFields, vehicleFields: body)
                vehicleFieldsPending = true
            } else {
                actionError = e.userMessage
            }
        } catch {
            actionError = APIError.unknown.userMessage
        }
    }

    // MARK: «لا تغيير» والتأكيدات — اتصال إلزامي، لا إدراج offline

    func confirmNoChange() async {
        guard isOpen else { return }
        isConfirming = true
        actionError = nil
        defer { isConfirming = false }
        do {
            let _: CheckWriteResponse = try await api.post("/api/my/check-session/no-change")
            await reloadSilent()
        } catch let e as APIError {
            actionError = (e == .offline || e == .timeout)
                ? "تأكيد «لا تغيير» يتطلب اتصالًا بالخادم — أهليته تُفحص لحظيًا."
                : e.userMessage
        } catch {
            actionError = APIError.unknown.userMessage
        }
    }

    func confirm(_ kind: String) async {
        guard isOpen else { return }
        isConfirming = true
        actionError = nil
        defer { isConfirming = false }
        do {
            let _: CheckConfirmResponse = try await api.post(
                "/api/my/check-session/confirm", body: CheckConfirmRequest(kind: kind))
            showConfirmed = true
            await reloadSilent()
        } catch let e as APIError {
            actionError = (e == .offline || e == .timeout)
                ? "التأكيد يتطلب اتصالًا بالخادم."
                : e.userMessage
        } catch {
            actionError = APIError.unknown.userMessage
        }
    }

    // MARK: تأكيدات العرض

    func confirmations(_ member: CheckSessionDTO.Member, kind: String) -> Bool {
        dto?.confirmations?.contains { $0.employeeId == member.id && $0.kind == kind } ?? false
    }

    func iConfirmed(_ kind: String) -> Bool {
        dto?.confirmations?.contains { $0.employeeId == dto?.me?.id && $0.kind == kind } ?? false
    }

    // MARK: Pending queue

    private func enqueuePending(kind: PendingCheckOp.Kind, itemKey: String? = nil,
                                statusDetail: String? = nil, note: String? = nil,
                                qtyAvailable: String? = nil,
                                vehicleFields: CheckVehicleFieldsRequest? = nil) {
        guard let sid = dto?.session?.id else { return }
        store.enqueue(PendingCheckOp(sessionId: sid, kind: kind, itemKey: itemKey,
                                     statusDetail: statusDetail, note: note,
                                     qtyAvailable: qtyAvailable, vehicleFields: vehicleFields))
        pendingOps = store.opsFor(sessionId: sid)
    }

    /// إرسال المعلقات بترتيبها ثم pull كامل. توقف عند أول انقطاع؛
    /// رفض السيرفر (جلسة أُقفلت مثلًا) يُسقط العملية وتظهر حقيقة السيرفر.
    private func flushPending() async {
        guard let sid = dto?.session?.id else { return }
        var flushedAny = false
        for op in store.opsFor(sessionId: sid) {
            do {
                switch op.kind {
                case .item:
                    guard let key = op.itemKey, let status = op.statusDetail else {
                        store.remove(op); continue
                    }
                    let body = CheckItemRequest(itemKey: key, statusDetail: status,
                                                note: op.note, qtyAvailable: op.qtyAvailable)
                    let _: CheckWriteResponse = try await api.post("/api/my/check-session/items", body: body)
                case .vehicleFields:
                    guard let fields = op.vehicleFields else { store.remove(op); continue }
                    let _: CheckWriteResponse = try await api.post("/api/my/check-session/vehicle-fields", body: fields)
                }
                store.remove(op)
                flushedAny = true
            } catch let e as APIError {
                if e == .offline || e == .timeout { break }        // ما زلنا منقطعين
                store.remove(op)                                   // رفض سيرفري صريح
                flushedAny = true
            } catch {
                break
            }
        }
        pendingOps = store.opsFor(sessionId: sid)
        if flushedAny { await reloadSilent() }
    }
}
