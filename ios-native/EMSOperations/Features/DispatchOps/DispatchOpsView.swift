//
//  DispatchOpsView.swift
//  EMSOperations
//
//  شاشة البلاغات والتوزيع (§9): ملخص بلاغات المناوبة + توزيع بلاغ +
//  تراجع + إلغاء/استعادة طواقم CAD + البلاغات التفصيلية (إدخال/حذف).
//  التوزيع يقيس الإجراءات لا عدد البلاغات المفردة بالضرورة — العدّادات
//  كلها مشتقة سيرفريًا وتُعرض كما هي. من لا يملك الصلاحية لا يرى الإجراء.
//

import SwiftUI

struct DispatchOpsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = DispatchOpsViewModel()

    private enum Sheet: Identifiable {
        case dispatch, undo, entryAdd
        var id: Self { self }
    }

    @State private var sheet: Sheet?
    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?
    @State private var reason: ReasonRequest?
    @State private var reasonText = ""

    // حقول التوزيع/التراجع
    @State private var selCenter = ""
    @State private var selUnit = ""
    @State private var selType = ""

    // حقول البلاغ التفصيلي
    @State private var entryNumber = ""
    @State private var entryType = ""
    @State private var entryLocation = ""
    @State private var entryPriority = "عادي"
    @State private var entryCenter = ""
    @State private var entryUnit = ""
    @State private var entryDispatch = ""
    @State private var entryArrival = ""
    @State private var entryDispatcher = ""
    @State private var entryNotes = ""

    static let reportTypes = ["حادث مروري", "حالة مرضية", "حريق", "إصابة",
                              "حالة ولادة", "سقوط", "اختناق", "آخر"]
    static let priorities = ["عادي", "مهم", "عاجل"]

    private var canDispatch: Bool { session.permissions.canDispatch }
    private var canRevert: Bool { session.permissions.canRevertReports }
    private var canDetail: Bool { session.permissions.canReportDetail }

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) {
                    EMSSkeletonCard(lines: 3)
                    EMSSkeletonCard(lines: 5)
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
        .emsPage("البلاغات والتوزيع")
        .task { await vm.load() }
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

    // MARK: - المحتوى

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                summaryCard
                actionsRow
                incidentsSection
                entriesSection
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

    private var summaryCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: "megaphone.fill")
                        .foregroundStyle(EMSTheme.Colors.teal)
                    Text("بلاغات المناوبة النشطة")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let sector = vm.summary?.mapStatus?.sectorStatus {
                        EMSStatusPill(text: sectorStatusTitle(sector), tone: sectorStatusTone(sector))
                    }
                    if working { ProgressView().tint(EMSTheme.Colors.teal) }
                }
                EMSInfoRow(label: "الإجمالي", value: "\(vm.summary?.total ?? 0)")
                EMSInfoRow(label: "النشطة", value: "\(vm.summary?.activeCount ?? 0)")
                EMSInfoRow(label: "يدوية", value: "\(vm.summary?.manualCount ?? 0)")
                if let avg = vm.summary?.responseTime?.arrival?.avg {
                    EMSInfoRow(label: "متوسط الوصول", value: "\(avg) د")
                }
                if let top = vm.summary?.mapStatus?.topDistrict, let name = top.name {
                    EMSInfoRow(label: "أكثر حي ضغطًا", value: "\(name) (\(top.count ?? 0))")
                }
            }
        }
    }

    private var actionsRow: some View {
        HStack(spacing: 8) {
            if canDispatch {
                actionChip("توزيع بلاغ", icon: "paperplane.fill") {
                    selCenter = vm.centers.first ?? ""
                    selUnit = vm.units(in: selCenter).first ?? ""
                    selType = ""
                    sheet = .dispatch
                }
            }
            if canRevert {
                actionChip("تراجع", icon: "arrow.uturn.backward") {
                    selCenter = vm.centers.first ?? ""
                    selUnit = vm.units(in: selCenter).first ?? ""
                    sheet = .undo
                }
            }
            if canDetail {
                actionChip("بلاغ تفصيلي", icon: "doc.badge.plus") {
                    entryNumber = ""; entryType = ""; entryLocation = ""
                    entryPriority = "عادي"
                    entryCenter = vm.centers.first ?? ""
                    entryUnit = vm.units(in: entryCenter).first ?? ""
                    entryDispatch = ""; entryArrival = ""
                    entryDispatcher = ""; entryNotes = ""
                    sheet = .entryAdd
                }
            }
        }
    }

    // MARK: - البلاغات (CAD + يدوي)

    private var incidentsSection: some View {
        let incidents = vm.summary?.incidents ?? []
        return VStack(spacing: EMSTheme.spacing) {
            Text("البلاغات")
                .font(.headline.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if incidents.isEmpty {
                EMSEmptyView(icon: "tray", title: "لا توجد بلاغات في المناوبة النشطة")
            } else {
                ForEach(incidents) { incident in
                    incidentCard(incident)
                }
            }
        }
    }

    private func incidentCard(_ incident: CadSummaryDTO.Incident) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("بلاغ \(incident.number ?? "—")")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let severity = incident.severity {
                        EMSStatusPill(text: severityTitle(severity), tone: severityTone(severity))
                    } else {
                        EMSStatusPill(text: incident.status ?? "منتهٍ", tone: .neutral)
                    }
                }
                if let type = incident.type, !type.isEmpty {
                    EMSInfoRow(label: "النوع", value: type)
                }
                if let address = incident.address, !address.isEmpty {
                    EMSInfoRow(label: "العنوان", value: address)
                }
                if let district = incident.district, !district.isEmpty {
                    EMSInfoRow(label: "الحي", value: district)
                }
                if let best = incident.bestArrivalMin {
                    EMSInfoRow(label: "أسرع وصول", value: "\(best) د",
                               valueColor: EMSTheme.StatusTone.normal.color)
                }
                let crews = incident.crews ?? []
                if !crews.isEmpty {
                    Divider().background(EMSTheme.Colors.divider)
                    ForEach(crews) { crew in
                        crewRow(number: incident.number ?? "", crew: crew)
                    }
                }
            }
        }
    }

    private func crewRow(number: String, crew: CadSummaryDTO.Crew) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(crew.unit ?? "—")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Text(crewStateTitle(crew))
                    .font(.caption2)
                    .foregroundStyle(crew.manualCancelled == true ? EMSTheme.Colors.danger : EMSTheme.Colors.textMuted)
            }
            Spacer()
            if canDispatch, !number.isEmpty, let unit = crew.unit {
                if crew.manualCancelled == true {
                    Button {
                        confirm = ConfirmRequest(title: "استعادة الفرقة",
                            message: "ستُستعاد مشاركة «\(unit)» في البلاغ \(number).",
                            run: { try await vm.setCrewCancelled(number: number, unit: unit, cancel: false, reason: nil); return "تمت الاستعادة" })
                    } label: {
                        Image(systemName: "arrow.uturn.forward.circle")
                            .foregroundStyle(EMSTheme.Colors.teal)
                    }
                    .disabled(working)
                } else {
                    Button {
                        reasonText = ""
                        reason = ReasonRequest(title: "إلغاء تسجيل الفرقة",
                            placeholder: "سبب الإلغاء (اختياري)", requiresReason: false) { text in
                            try await vm.setCrewCancelled(number: number, unit: unit, cancel: true,
                                                          reason: text.isEmpty ? nil : text)
                            return "تم إلغاء تسجيل الفرقة"
                        }
                    } label: {
                        Image(systemName: "xmark.circle")
                            .foregroundStyle(EMSTheme.Colors.danger)
                    }
                    .disabled(working)
                }
            }
        }
    }

    // MARK: - البلاغات التفصيلية

    private var entriesSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            Text("البلاغات التفصيلية")
                .font(.headline.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if vm.entries.isEmpty {
                EMSEmptyView(icon: "doc.text", title: "لا توجد بلاغات تفصيلية في المناوبة النشطة")
            } else {
                ForEach(vm.entries) { entry in
                    entryCard(entry)
                }
            }
        }
    }

    private func entryCard(_ entry: ReportEntryDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(entry.type ?? "بلاغ")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let priority = entry.priority, !priority.isEmpty {
                        EMSStatusPill(text: priority, tone: priority == "عاجل" ? .danger : (priority == "مهم" ? .warning : .neutral))
                    }
                }
                if let n = entry.reportNumber, !n.isEmpty { EMSInfoRow(label: "رقم البلاغ", value: n) }
                if let l = entry.location, !l.isEmpty { EMSInfoRow(label: "الموقع", value: l) }
                EMSInfoRow(label: "الفرقة", value: "\(entry.center ?? "—") · \(entry.unit ?? "—")")
                HStack(spacing: 16) {
                    if let d = entry.dispatchTime, !d.isEmpty { EMSInfoRow(label: "التحرك", value: d) }
                    if let a = entry.arrivalTime, !a.isEmpty { EMSInfoRow(label: "المباشرة", value: a) }
                }
                if let r = entry.responseTime, !r.isEmpty { EMSInfoRow(label: "الاستجابة", value: r) }
                if let n = entry.notes, !n.isEmpty {
                    Text(n)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                if canDetail, let id = entry.serverId {
                    actionChip("حذف", icon: "trash", destructive: true) {
                        confirm = ConfirmRequest(title: "حذف البلاغ",
                            message: "الحذف مسموح لسجلات المناوبة النشطة فقط — سيُحذف نهائيًا.",
                            destructive: true,
                            run: { try await vm.deleteEntry(id); return "تم حذف البلاغ" })
                    }
                }
            }
        }
    }

    // MARK: - النماذج (Sheets)

    @ViewBuilder
    private func sheetContent(_ sheet: Sheet) -> some View {
        switch sheet {
        case .dispatch: dispatchSheet
        case .undo: undoSheet
        case .entryAdd: entrySheet
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

    private func pickerMenu(_ title: String, options: [String], selection: Binding<String>) -> some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button(option) { selection.wrappedValue = option }
            }
        } label: {
            HStack {
                Text(selection.wrappedValue.isEmpty ? title : selection.wrappedValue)
                    .foregroundStyle(selection.wrappedValue.isEmpty ? EMSTheme.Colors.textMuted : EMSTheme.Colors.textPrimary)
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            .padding(12)
            .background(Color.white.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
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
        .presentationDetents([.medium, .large])
    }

    private var dispatchSheet: some View {
        formShell("توزيع بلاغ") {
            pickerMenu("اختر المركز", options: vm.centers, selection: Binding(
                get: { selCenter },
                set: { selCenter = $0; selUnit = vm.units(in: $0).first ?? "" }))
            pickerMenu("اختر الفرقة", options: vm.units(in: selCenter), selection: $selUnit)
            pickerMenu("النوع (اختياري)", options: Self.reportTypes, selection: $selType)
            Text("التوزيع يُسجَّل على المناوبة النشطة بختم سيرفري — إن لم توجد مناوبة نشطة سيرفض الخادم.")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            EMSPrimaryButton(title: "توزيع", isLoading: working,
                             isDisabled: selCenter.isEmpty || selUnit.isEmpty) {
                let center = selCenter, unit = selUnit
                let type = selType.isEmpty ? nil : selType
                self.sheet = nil
                execute {
                    try await vm.dispatch(center: center, unit: unit, type: type)
                    return "تم توزيع البلاغ على «\(unit)»"
                }
            }
        }
    }

    private var undoSheet: some View {
        formShell("التراجع عن بلاغ") {
            pickerMenu("اختر المركز", options: vm.centers, selection: Binding(
                get: { selCenter },
                set: { selCenter = $0; selUnit = vm.units(in: $0).first ?? "" }))
            pickerMenu("اختر الفرقة", options: vm.units(in: selCenter), selection: $selUnit)
            Text("يتراجع عن آخر بلاغ موزّع لهذه الفرقة في المناوبة النشطة فقط.")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            EMSPrimaryButton(title: "تراجع", isLoading: working,
                             isDisabled: selCenter.isEmpty || selUnit.isEmpty) {
                let center = selCenter, unit = selUnit
                self.sheet = nil
                confirm = ConfirmRequest(title: "التراجع عن البلاغ",
                    message: "سيُحذف آخر بلاغ مسجَّل لـ«\(unit)» في المناوبة النشطة.",
                    destructive: true,
                    run: { try await vm.undo(center: center, unit: unit); return "تم التراجع عن البلاغ" })
            }
        }
    }

    private var entrySheet: some View {
        formShell("بلاغ تفصيلي جديد") {
            pickerMenu("نوع البلاغ *", options: Self.reportTypes, selection: $entryType)
            formField("رقم البلاغ (اختياري)", text: $entryNumber)
                .keyboardType(.numberPad)
            formField("الموقع", text: $entryLocation)
            pickerMenu("الأولوية", options: Self.priorities, selection: $entryPriority)
            pickerMenu("المركز *", options: vm.centers, selection: Binding(
                get: { entryCenter },
                set: { entryCenter = $0; entryUnit = vm.units(in: $0).first ?? "" }))
            pickerMenu("الفرقة *", options: vm.units(in: entryCenter), selection: $entryUnit)
            formField("وقت التحرك * (HH:MM)", text: $entryDispatch)
                .keyboardType(.numbersAndPunctuation)
            formField("وقت المباشرة * (HH:MM)", text: $entryArrival)
                .keyboardType(.numbersAndPunctuation)
            formField("المسجّل (اختياري)", text: $entryDispatcher)
            formField("ملاحظات (اختياري)", text: $entryNotes)
            Text("التاريخ والطابع الزمني والمناوبة تُختم سيرفريًا — لا تُرسل من الجهاز.")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            EMSPrimaryButton(title: "حفظ البلاغ", isLoading: working,
                             isDisabled: entryType.isEmpty || entryCenter.isEmpty || entryUnit.isEmpty ||
                                         entryDispatch.isEmpty || entryArrival.isEmpty) {
                let req = ReportEntryRequest(
                    type: entryType, center: entryCenter, unit: entryUnit,
                    dispatchTime: entryDispatch, arrivalTime: entryArrival,
                    reportNumber: entryNumber.isEmpty ? nil : entryNumber,
                    location: entryLocation.isEmpty ? nil : entryLocation,
                    priority: entryPriority,
                    dispatcher: entryDispatcher.isEmpty ? nil : entryDispatcher,
                    notes: entryNotes.isEmpty ? nil : entryNotes)
                self.sheet = nil
                execute {
                    try await vm.createEntry(req)
                    return "تم حفظ البلاغ التفصيلي"
                }
            }
        }
    }

    // MARK: - مكونات صغيرة + تنفيذ موحد

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
        .presentationDetents([.medium])
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

    private func severityTitle(_ severity: String) -> String {
        switch severity {
        case "green": return "مُباشَر"
        case "red": return "متأخر"
        default: return "قيد الانتظار"
        }
    }

    private func severityTone(_ severity: String) -> EMSTheme.StatusTone {
        switch severity {
        case "green": return .normal
        case "red": return .danger
        default: return .warning
        }
    }

    private func sectorStatusTitle(_ status: String) -> String {
        switch status {
        case "green": return "القطاع مستقر"
        case "red": return "ضغط مرتفع"
        default: return "ضغط متوسط"
        }
    }

    private func sectorStatusTone(_ status: String) -> EMSTheme.StatusTone {
        switch status {
        case "green": return .normal
        case "red": return .danger
        default: return .warning
        }
    }

    private func crewStateTitle(_ crew: CadSummaryDTO.Crew) -> String {
        if crew.manualCancelled == true { return "ملغاة يدويًا — مستبعدة من العدّادات" }
        if crew.withdrawn == true { return "مسحوبة" }
        if crew.counted == true { return "مشاركة محتسبة" }
        return "غير محتسبة"
    }
}
