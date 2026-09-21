//
//  PositioningOpsView.swift
//  EMSOperations
//
//  شاشة التمركز والذروة (§11): مواقع الوحدات حسب المركز + خطط الذروة
//  (عقد حر يُدار خامًا في الـViewModel) + مهام الذروة وتنبيهاتها.
//  الكتابة بصلاحية ops.deployments؛ حذف المهام مقيد سيرفريًا بـadmin/director
//  (isAdminOrDirector — من لا يملك الدور لا يرى الزر إطلاقًا).
//

import SwiftUI

struct PositioningOpsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = PositioningOpsViewModel()

    private enum Sheet: Identifiable {
        case unitLocation
        case planAdd
        case planEdit(PeakPlanItem)
        case missionAdd
        var id: String {
            switch self {
            case .unitLocation: return "unitLocation"
            case .planAdd: return "planAdd"
            case .planEdit(let p): return "planEdit-\(p.id)"
            case .missionAdd: return "missionAdd"
            }
        }
    }

    @State private var sheet: Sheet?
    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?

    // حقول تمركز الوحدة
    @State private var locCenter = ""
    @State private var locUnit = ""
    @State private var locLat = ""
    @State private var locLng = ""
    @State private var locAddress = ""

    // حقول خطة الذروة
    @State private var planTitle = ""
    @State private var planLocation = ""
    @State private var planUnit = ""
    @State private var planStart = Date()
    @State private var planEnd = Date().addingTimeInterval(3600)
    @State private var planNotes = ""

    // حقول مهمة الذروة
    @State private var missionLocation = ""
    @State private var missionUnit = ""
    @State private var missionStart = ""
    @State private var missionEnd = ""
    @State private var missionPriority = "عادية"
    @State private var missionNotes = ""

    private var canDeploy: Bool { session.permissions.canDeployOps }
    private var canDeleteMission: Bool { session.permissions.isAdminOrDirector }

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) {
                    EMSSkeletonCard(lines: 3)
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 4)
                }
                .padding(EMSTheme.pagePadding)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.reload(showLoading: true) } }
                    .padding(EMSTheme.pagePadding)
            case .loaded:
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .emsPage("التمركز والذروة")
        .task { await vm.load() }
        .sheet(item: $sheet) { sheetContent($0) }
        .alert(item: $confirm) { req in
            Alert(title: Text(req.title), message: Text(req.message),
                  primaryButton: req.destructive
                    ? .destructive(Text("تأكيد")) { execute(req.run) }
                    : .default(Text("تأكيد")) { execute(req.run) },
                  secondaryButton: .cancel(Text("إلغاء")))
        }
    }

    // MARK: - المحتوى

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                unitLocationsSection
                peakPlansSection
                peakMissionsSection
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
    }

    // MARK: - تمركز الوحدات

    private var unitLocationsSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            HStack {
                Text("تمركز الوحدات")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                if canDeploy {
                    Button {
                        locCenter = vm.centers.first ?? ""
                        locUnit = ""; locLat = ""; locLng = ""; locAddress = ""
                        sheet = .unitLocation
                    } label: {
                        Label("تمركز / تعديل", systemImage: "mappin.and.ellipse")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(EMSTheme.Colors.teal)
                }
            }
            if vm.centers.isEmpty {
                EMSEmptyView(icon: "mappin.slash", title: "لا توجد مواقع وحدات مسجلة")
            } else {
                ForEach(vm.centers, id: \.self) { center in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(center)
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                            let units = (vm.locations[center] ?? [:]).keys.sorted()
                            ForEach(units, id: \.self) { unit in
                                unitRow(center: center, unit: unit)
                                if unit != units.last {
                                    Divider().background(EMSTheme.Colors.divider)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func unitRow(center: String, unit: String) -> some View {
        let coords = vm.locations[center]?[unit] ?? []
        let coordText = coords.count >= 2
            ? String(format: "%.5f, %.5f", coords[0], coords[1])
            : "—"
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(unit)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                Text(coordText)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            if let address = vm.addresses[unit], !address.isEmpty {
                Text(address)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
    }

    // MARK: - خطط الذروة

    private var peakPlansSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            HStack {
                Text("خطط الذروة")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                if canDeploy {
                    Button {
                        planTitle = ""; planLocation = ""; planUnit = ""; planNotes = ""
                        planStart = Date()
                        planEnd = Date().addingTimeInterval(3600)
                        sheet = .planAdd
                    } label: {
                        Label("إضافة خطة", systemImage: "plus")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(EMSTheme.Colors.teal)
                }
            }
            if vm.plans.isEmpty {
                EMSEmptyView(icon: "calendar.badge.clock", title: "لا توجد خطط ذروة")
            } else {
                ForEach(vm.plans) { plan in
                    planCard(plan)
                }
            }
        }
    }

    private func planCard(_ plan: PeakPlanItem) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(plan.title)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let status = plan.status, !status.isEmpty {
                        EMSStatusPill(text: status, tone: plan.arrivalTime != nil ? .normal : .neutral)
                    }
                }
                if let location = plan.location, !location.isEmpty {
                    EMSInfoRow(label: "الموقع", value: location)
                }
                if let unit = plan.unit, !unit.isEmpty {
                    EMSInfoRow(label: "الوحدة", value: unit)
                }
                if let start = plan.startTime, !start.isEmpty {
                    EMSInfoRow(label: "البداية", value: start)
                }
                if let end = plan.endTime, !end.isEmpty {
                    EMSInfoRow(label: "النهاية", value: end)
                }
                if let arrival = plan.arrivalTime, !arrival.isEmpty {
                    EMSInfoRow(label: "الوصول", value: arrival, valueColor: EMSTheme.Colors.emerald)
                }
                if let departure = plan.departureTime, !departure.isEmpty {
                    EMSInfoRow(label: "المغادرة", value: departure, valueColor: EMSTheme.Colors.textMuted)
                }
                if canDeploy {
                    HStack(spacing: 8) {
                        if plan.arrivalTime == nil {
                            actionChip("تسجيل الوصول", icon: "checkmark.circle") {
                                confirm = ConfirmRequest(title: "تسجيل الوصول",
                                    message: "سيُختم وقت الوصول من ساعة الخادم الآن.",
                                    run: { try await vm.stampPlan(id: plan.id, key: "arrivalTime"); return "تم تسجيل الوصول" })
                            }
                        } else if plan.departureTime == nil {
                            actionChip("تسجيل المغادرة", icon: "arrow.right.circle") {
                                confirm = ConfirmRequest(title: "تسجيل المغادرة",
                                    message: "سيُختم وقت المغادرة من ساعة الخادم الآن.",
                                    run: { try await vm.stampPlan(id: plan.id, key: "departureTime"); return "تم تسجيل المغادرة" })
                            }
                        }
                        actionChip("تعديل", icon: "pencil") {
                            planTitle = plan.title
                            planLocation = plan.location ?? ""
                            planUnit = plan.unit ?? ""
                            planNotes = plan.notes ?? ""
                            sheet = .planEdit(plan)
                        }
                        actionChip("حذف", icon: "trash", destructive: true) {
                            confirm = ConfirmRequest(title: "حذف الخطة",
                                message: "سيتم حذف «\(plan.title)» نهائيًا.",
                                destructive: true,
                                run: { try await vm.deletePlan(id: plan.id); return "تم حذف الخطة" })
                        }
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    // MARK: - مهام الذروة والتنبيهات

    private var peakMissionsSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            HStack {
                Text("مهام الذروة")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                if canDeploy {
                    Button {
                        missionLocation = ""; missionUnit = ""; missionStart = ""
                        missionEnd = ""; missionPriority = "عادية"; missionNotes = ""
                        sheet = .missionAdd
                    } label: {
                        Label("إضافة مهمة", systemImage: "plus")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(EMSTheme.Colors.teal)
                }
            }

            let activeAlerts = vm.alerts.filter { ($0.status ?? "") != "resolved" }
            if !activeAlerts.isEmpty {
                ForEach(activeAlerts) { alert in
                    alertCard(alert)
                }
            }

            if vm.missions.isEmpty {
                EMSEmptyView(icon: "bolt.badge.clock", title: "لا توجد مهام ذروة")
            } else {
                ForEach(vm.missions) { mission in
                    missionCard(mission)
                }
            }
        }
    }

    private func alertCard(_ alert: PeakDataDTO.Alert) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(EMSTheme.Colors.warning)
                    Text(alert.title ?? "تنبيه ذروة")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let priority = alert.priority, !priority.isEmpty {
                        EMSStatusPill(text: priority, tone: priority == "عالية" ? .danger : .neutral)
                    }
                }
                if let details = alert.details, !details.isEmpty {
                    Text(details)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                if let location = alert.location, !location.isEmpty {
                    EMSInfoRow(label: "الموقع", value: location)
                }
                if let unit = alert.unit, !unit.isEmpty {
                    EMSInfoRow(label: "الوحدة", value: unit)
                }
                if canDeploy, let alertId = alert.id {
                    actionChip("تم التنفيذ", icon: "checkmark.seal") {
                        confirm = ConfirmRequest(title: "تنفيذ التنبيه",
                            message: "سيتم تعليم هذا التنبيه كمنفَّذ.",
                            run: { try await vm.resolveAlert(alertId); return "تم تنفيذ التنبيه" })
                    }
                }
            }
        }
    }

    private func missionCard(_ mission: PeakDataDTO.Mission) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(mission.location ?? "مهمة ذروة")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let priority = mission.priority, !priority.isEmpty {
                        EMSStatusPill(text: priority, tone: priority == "عالية" ? .danger : .neutral)
                    }
                }
                if let unit = mission.unit, !unit.isEmpty {
                    EMSInfoRow(label: "الوحدة", value: unit)
                }
                HStack(spacing: 16) {
                    if let start = mission.startTime, !start.isEmpty {
                        EMSInfoRow(label: "من", value: start)
                    }
                    if let end = mission.endTime, !end.isEmpty {
                        EMSInfoRow(label: "إلى", value: end)
                    }
                }
                if let notes = mission.notes, !notes.isEmpty {
                    Text(notes)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                if canDeleteMission, let id = mission.id {
                    actionChip("حذف المهمة", icon: "trash", destructive: true) {
                        confirm = ConfirmRequest(title: "حذف المهمة",
                            message: "حذف مهام الذروة مقيد بالإدارة/القيادة — سيتم الحذف نهائيًا.",
                            destructive: true,
                            run: { try await vm.deleteMission(id); return "تم حذف المهمة" })
                    }
                }
            }
        }
    }

    // MARK: - مكونات صغيرة

    private func actionChip(_ title: String, icon: String, destructive: Bool = false,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold))
        }
        .buttonStyle(.bordered)
        .tint(destructive ? EMSTheme.Colors.danger : EMSTheme.Colors.teal)
        .disabled(working)
    }

    // MARK: - النماذج (Sheets)

    @ViewBuilder
    private func sheetContent(_ sheet: Sheet) -> some View {
        switch sheet {
        case .unitLocation: unitLocationSheet
        case .planAdd: planSheet(editing: nil)
        case .planEdit(let plan): planSheet(editing: plan)
        case .missionAdd: missionSheet
        }
    }

    private func formField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .foregroundStyle(EMSTheme.Colors.textPrimary)
            .padding(12)
            .background(Color.white.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
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

    private var unitLocationSheet: some View {
        formShell("تمركز وحدة") {
            if vm.centers.isEmpty {
                formField("المركز", text: $locCenter)
            } else {
                Menu {
                    ForEach(vm.centers, id: \.self) { center in
                        Button(center) { locCenter = center }
                    }
                } label: {
                    HStack {
                        Text(locCenter.isEmpty ? "اختر المركز" : locCenter)
                            .foregroundStyle(locCenter.isEmpty ? EMSTheme.Colors.textMuted : EMSTheme.Colors.textPrimary)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    .padding(12)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
            formField("الوحدة", text: $locUnit)
            formField("خط العرض (lat)", text: $locLat)
                .keyboardType(.numbersAndPunctuation)
            formField("خط الطول (lng)", text: $locLng)
                .keyboardType(.numbersAndPunctuation)
            formField("العنوان (اختياري)", text: $locAddress)
            EMSPrimaryButton(title: "حفظ التمركز", isLoading: working, isDisabled: !unitLocationValid) {
                guard let lat = Double(locLat), let lng = Double(locLng) else { return }
                let center = locCenter.trimmingCharacters(in: .whitespaces)
                let unit = locUnit.trimmingCharacters(in: .whitespaces)
                let address = locAddress.trimmingCharacters(in: .whitespaces)
                self.sheet = nil
                execute {
                    try await vm.setUnitLocation(center: center, unit: unit, lat: lat, lng: lng,
                                                 address: address.isEmpty ? nil : address)
                    return "تم حفظ تمركز الوحدة"
                }
            }
        }
    }

    private var unitLocationValid: Bool {
        !locCenter.trimmingCharacters(in: .whitespaces).isEmpty &&
        !locUnit.trimmingCharacters(in: .whitespaces).isEmpty &&
        Double(locLat) != nil && Double(locLng) != nil
    }

    private func planSheet(editing plan: PeakPlanItem?) -> some View {
        formShell(plan == nil ? "إضافة خطة ذروة" : "تعديل خطة ذروة") {
            formField("عنوان الخطة", text: $planTitle)
            formField("الموقع", text: $planLocation)
            formField("الوحدة (اختياري)", text: $planUnit)
            if plan == nil {
                DatePicker("البداية", selection: $planStart, displayedComponents: [.date, .hourAndMinute])
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                    .tint(EMSTheme.Colors.teal)
                DatePicker("النهاية", selection: $planEnd, displayedComponents: [.date, .hourAndMinute])
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                    .tint(EMSTheme.Colors.teal)
            }
            formField("ملاحظات (اختياري)", text: $planNotes)
            EMSPrimaryButton(title: plan == nil ? "إضافة" : "حفظ", isLoading: working,
                             isDisabled: planTitle.trimmingCharacters(in: .whitespaces).isEmpty ||
                                         planLocation.trimmingCharacters(in: .whitespaces).isEmpty) {
                let title = planTitle.trimmingCharacters(in: .whitespaces)
                let location = planLocation.trimmingCharacters(in: .whitespaces)
                let unit = planUnit.trimmingCharacters(in: .whitespaces)
                let notes = planNotes.trimmingCharacters(in: .whitespaces)
                let start = planStart, end = planEnd
                self.sheet = nil
                execute {
                    if let plan {
                        try await vm.updatePlan(id: plan.id, title: title, location: location,
                                                notes: notes.isEmpty ? nil : notes)
                        return "تم حفظ الخطة"
                    }
                    try await vm.createPlan(title: title, location: location,
                                            unit: unit.isEmpty ? nil : unit,
                                            start: start, end: end,
                                            notes: notes.isEmpty ? nil : notes)
                    return "تمت إضافة الخطة"
                }
            }
        }
    }

    private var missionSheet: some View {
        formShell("إضافة مهمة ذروة") {
            formField("الموقع", text: $missionLocation)
            formField("الوحدة", text: $missionUnit)
            formField("وقت البداية (HH:MM)", text: $missionStart)
                .keyboardType(.numbersAndPunctuation)
            formField("وقت النهاية (HH:MM)", text: $missionEnd)
                .keyboardType(.numbersAndPunctuation)
            Picker("الأولوية", selection: $missionPriority) {
                Text("عادية").tag("عادية")
                Text("عالية").tag("عالية")
            }
            .pickerStyle(.segmented)
            formField("ملاحظات (اختياري)", text: $missionNotes)
            EMSPrimaryButton(title: "إضافة المهمة", isLoading: working,
                             isDisabled: missionLocation.trimmingCharacters(in: .whitespaces).isEmpty ||
                                         missionUnit.trimmingCharacters(in: .whitespaces).isEmpty ||
                                         missionStart.isEmpty || missionEnd.isEmpty) {
                let location = missionLocation.trimmingCharacters(in: .whitespaces)
                let unit = missionUnit.trimmingCharacters(in: .whitespaces)
                let start = missionStart, end = missionEnd, priority = missionPriority
                let notes = missionNotes.trimmingCharacters(in: .whitespaces)
                self.sheet = nil
                execute {
                    try await vm.createMission(location: location, unit: unit,
                                               startTime: start, endTime: end,
                                               priority: priority,
                                               notes: notes.isEmpty ? nil : notes)
                    return "تمت إضافة المهمة"
                }
            }
        }
    }

    // MARK: - تنفيذ موحد

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
