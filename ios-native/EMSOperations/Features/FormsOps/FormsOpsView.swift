//
//  FormsOpsView.swift
//  EMSOperations
//
//  النماذج التشغيلية (§12): حوادث / تصعيدات / حالات إلكترونية / تقارير
//  يومية / مناوبات كبار المسعفين. الإنشاء والحذف بصلاحية ops.forms.
//  الأنواع المرتبطة ببلاغ CAD (حادث/تصعيد/حالة إلكترونية) تتطلب البحث
//  والتحقق أولًا — نفس قاعدة الويب: «لا حفظ بدون بلاغ متحقق من CAD».
//

import SwiftUI

struct FormsOpsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = FormsOpsViewModel()

    @State private var selectedType: OpsFormType = .incident
    @State private var showAdd = false
    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var confirm: ConfirmRequest?

    // بحث CAD
    @State private var lookupNumber = ""
    @State private var lookupResult: IncidentLookupDTO?
    @State private var lookupLoading = false
    @State private var lookupError: String?
    @State private var lookupUnit = ""

    // حقول الحادث
    @State private var incType = ""
    @State private var incDateTime = ""
    @State private var incLocation = ""
    @State private var incCenter = ""
    @State private var incPatient = ""
    @State private var incAge = ""
    @State private var incGender = ""
    @State private var incDescription = ""
    @State private var incActions = ""

    // حقول التصعيد
    @State private var escEventType = ""
    @State private var escDateTime = ""
    @State private var escLocation = ""
    @State private var escInjuries = ""
    @State private var escDeaths = ""
    @State private var escAgencies: Set<String> = []
    @State private var escDetails = ""

    // حقول الحالة الإلكترونية
    @State private var ecDateTime = ""
    @State private var ecLocation = ""
    @State private var ecAge = ""
    @State private var ecGender = ""
    @State private var ecHospital = ""
    @State private var ecOutcome = ""
    @State private var ecNotes = ""

    // حقول التقرير اليومي
    @State private var drNumber = ""
    @State private var drDate = ""
    @State private var drTeams = ""
    @State private var drAir = ""
    @State private var drBorder = ""
    @State private var drPaths: Set<String> = []
    @State private var drFormFill = ""
    @State private var drSummary = ""

    // حقول مناوبة الكبار
    @State private var srWorking = ""
    @State private var srBroken = ""
    @State private var srReserve = ""
    @State private var srOverlap = ""
    @State private var srAreas: Set<String> = []
    @State private var srNotes = ""
    @State private var srAsstName = ""
    @State private var srAsstDate = ""
    @State private var srChiefName = ""
    @State private var srChiefDate = ""
    @State private var srCmdrName = ""
    @State private var srCmdrDate = ""

    static let incidentTypes = ["تصادم مروري", "دهس", "انقلاب مركبة", "حريق", "غرق",
                                "سقوط من ارتفاع", "إصابة عمل", "عنف", "حالة طبية طارئة", "أخرى"]
    static let genders = ["ذكر", "أنثى"]
    static let agencies = ["وزارة الصحة", "الإسعاف الجوي", "الدفاع المدني", "الدوريات الأمنية",
                           "أمن الطرق", "المرور", "أمانة الرياض (شرشورة)", "الهلال الأحمر"]
    static let outcomes = ["ROSC تم الإنعاش بنجاح", "تم النقل للمستشفى", "متوفى"]
    static let dailyPaths = ["مسار السكتات الدماغية", "مسار الجلطات القلبية", "مسار الإصابات الخطيرة",
                             "مسار الحالات التنفسية", "مسار الحالات العصبية", "مسار الحالات النفسية",
                             "مسار الحالات التوليدية", "مسار الحالات المعدية"]
    static let seniorAreas = ["الشفاء", "عكاظ", "الدار البيضاء", "الإسكان", "المنصورة"]

    private var canWrite: Bool { session.permissions.canForms }

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) {
                    EMSSkeletonCard(lines: 3)
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
        .emsPage("النماذج التشغيلية")
        .task { await vm.load() }
        .sheet(isPresented: $showAdd) { addSheet(for: selectedType) }
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
                Picker("النوع", selection: $selectedType) {
                    ForEach(OpsFormType.allCases) { type in
                        Text(type.title).tag(type)
                    }
                }
                .pickerStyle(.segmented)

                HStack {
                    Text("\(vm.records(of: selectedType).count) سجل")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Spacer()
                    if working { ProgressView().tint(EMSTheme.Colors.teal) }
                    if canWrite {
                        Button {
                            resetAddState()
                            showAdd = true
                        } label: {
                            Label("إضافة", systemImage: "plus")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .tint(EMSTheme.Colors.teal)
                    }
                }

                let items = vm.records(of: selectedType)
                if items.isEmpty {
                    EMSEmptyView(icon: "doc.text", title: "لا توجد سجلات في «\(selectedType.title)»")
                } else {
                    ForEach(items) { item in
                        recordCard(item)
                    }
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
    }

    private func recordCard(_ item: FormRecordItem) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(item.title)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if canWrite {
                        Button {
                            let type = selectedType, id = item.id
                            confirm = ConfirmRequest(title: "حذف السجل",
                                message: "سيُحذف هذا السجل نهائيًا.",
                                destructive: true,
                                run: { try await vm.remove(type, id: id); return "تم حذف السجل" })
                        } label: {
                            Image(systemName: "trash")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.danger)
                        }
                        .disabled(working)
                    }
                }
                ForEach(Array(item.rows.enumerated()), id: \.offset) { _, row in
                    EMSInfoRow(label: row.label, value: row.value)
                }
            }
        }
    }

    // MARK: - نماذج الإضافة

    @ViewBuilder
    private func addSheet(for type: OpsFormType) -> some View {
        switch type {
        case .incident: lookupSheet(kind: .incident)
        case .escalation: lookupSheet(kind: .escalation)
        case .eCase: lookupSheet(kind: .eCase)
        case .dailyReport: dailySheet
        case .seniorShift: seniorSheet
        }
    }

    private func resetAddState() {
        lookupNumber = ""; lookupResult = nil; lookupError = nil; lookupUnit = ""
        incType = ""; incDateTime = ""; incLocation = ""; incCenter = ""
        incPatient = ""; incAge = ""; incGender = ""; incDescription = ""; incActions = ""
        escEventType = ""; escDateTime = ""; escLocation = ""; escInjuries = ""
        escDeaths = ""; escAgencies = []; escDetails = ""
        ecDateTime = ""; ecLocation = ""; ecAge = ""; ecGender = ""
        ecHospital = ""; ecOutcome = ""; ecNotes = ""
        drNumber = ""; drDate = ""; drTeams = ""; drAir = ""; drBorder = ""
        drPaths = []; drFormFill = ""; drSummary = ""
        srWorking = ""; srBroken = ""; srReserve = ""; srOverlap = ""; srAreas = []
        srNotes = ""; srAsstName = ""; srAsstDate = ""
        srChiefName = ""; srChiefDate = ""; srCmdrName = ""; srCmdrDate = ""
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

    private func chipsRow(_ options: [String], selected: Binding<Set<String>>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(options, id: \.self) { option in
                Button {
                    if selected.wrappedValue.contains(option) { selected.wrappedValue.remove(option) }
                    else { selected.wrappedValue.insert(option) }
                } label: {
                    HStack {
                        Image(systemName: selected.wrappedValue.contains(option) ? "checkmark.square.fill" : "square")
                            .foregroundStyle(selected.wrappedValue.contains(option) ? EMSTheme.Colors.teal : EMSTheme.Colors.textMuted)
                        Text(option)
                            .font(.subheadline)
                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
            }
        }
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
                    Button("إلغاء") { showAdd = false }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - نماذج CAD (بحث → تحقق → حقول)

    private func lookupSheet(kind: OpsFormType) -> some View {
        formShell("إضافة — \(kind.title)") {
            // الخطوة 1: البحث والتحقق (إلزامي — قاعدة الويب)
            HStack(spacing: 8) {
                formField("رقم بلاغ CAD", text: $lookupNumber)
                    .keyboardType(.numberPad)
                Button {
                    lookupError = nil
                    lookupLoading = true
                    Task {
                        defer { lookupLoading = false }
                        do {
                            let res = try await vm.lookup(number: lookupNumber.trimmingCharacters(in: .whitespaces))
                            if res.found == true {
                                lookupResult = res
                                lookupUnit = res.units?.first(where: { $0.counted == true })?.unit
                                    ?? res.units?.first?.unit ?? ""
                                // تعبئة أولية من بيانات CAD (قابلة للتعديل — مثل الويب)
                                if incLocation.isEmpty { incLocation = res.incident?.address ?? "" }
                                if escLocation.isEmpty { escLocation = res.incident?.address ?? "" }
                                if ecLocation.isEmpty { ecLocation = res.incident?.address ?? "" }
                                if incDescription.isEmpty { incDescription = res.incident?.description ?? "" }
                            } else {
                                lookupResult = nil
                                lookupError = "البلاغ غير موجود"
                            }
                        } catch let e as APIError {
                            lookupResult = nil
                            lookupError = e.userMessage
                        } catch {
                            lookupResult = nil
                            lookupError = APIError.unknown.userMessage
                        }
                    }
                } label: {
                    if lookupLoading { ProgressView().tint(EMSTheme.Colors.teal) }
                    else { Text("بحث") }
                }
                .buttonStyle(.bordered)
                .tint(EMSTheme.Colors.teal)
                .disabled(lookupNumber.trimmingCharacters(in: .whitespaces).isEmpty || lookupLoading)
            }
            if let lookupError {
                Text(lookupError)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.danger)
            }

            if let result = lookupResult {
                lookupCard(result)
                lookupUnitPicker(result)
                switch kind {
                case .incident: incidentFields(result)
                case .escalation: escalationFields(result)
                case .eCase: eCaseFields(result)
                default: EmptyView()
                }
            } else {
                Text("ابحث عن البلاغ وتحقق منه أولًا — لا حفظ بدون بلاغ متحقق من CAD.")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private func lookupCard(_ result: IncidentLookupDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(EMSTheme.Colors.emerald)
                    Text("بلاغ \(result.number ?? "—") — متحقق منه")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                }
                if let type = result.incident?.type { EMSInfoRow(label: "النوع", value: type) }
                if let address = result.incident?.address { EMSInfoRow(label: "العنوان", value: address) }
                if let created = result.incident?.cadCreatedAtRaw { EMSInfoRow(label: "الإنشاء", value: created) }
                if let best = result.bestArrivalMin { EMSInfoRow(label: "أسرع وصول", value: "\(best) د") }
                if result.timeCompleteness?.state != "complete" {
                    Text("⚠️ البيانات الزمنية ناقصة — أكمل الحقول يدويًا")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.warning)
                }
            }
        }
    }

    private func lookupUnitPicker(_ result: IncidentLookupDTO) -> some View {
        pickerMenu("الفرقة التي باشرت فعليًا *",
                   options: (result.units ?? []).compactMap(\.unit),
                   selection: $lookupUnit)
    }

    private func incidentFields(_ result: IncidentLookupDTO) -> some View {
        Group {
            pickerMenu("نوع الحادث *", options: Self.incidentTypes, selection: $incType)
            formField("التاريخ والوقت (yyyy-MM-dd HH:mm)", text: $incDateTime)
                .keyboardType(.numbersAndPunctuation)
            formField("الموقع", text: $incLocation)
            formField("المركز", text: $incCenter)
            formField("اسم المريض", text: $incPatient)
            formField("العمر", text: $incAge)
                .keyboardType(.numberPad)
            pickerMenu("الجنس", options: Self.genders, selection: $incGender)
            formField("الوصف", text: $incDescription)
            formField("الإجراءات", text: $incActions)
            EMSPrimaryButton(title: "حفظ بلاغ الحادث", isLoading: working,
                             isDisabled: lookupUnit.isEmpty || incType.isEmpty) {
                let number = result.number ?? ""
                let unit = lookupUnit
                var record: [String: Any] = [
                    "reportNumber": number, "incidentNumber": number,
                    "incidentUnit": unit, "unit": unit, "type": incType
                ]
                if !incDateTime.isEmpty { record["dateTime"] = incDateTime }
                record["location"] = incLocation
                record["center"] = incCenter
                record["patientName"] = incPatient
                record["age"] = incAge
                record["gender"] = incGender
                record["description"] = incDescription
                record["actions"] = incActions
                if let cad = result.incident?.description { record["cadDescription"] = cad }
                showAdd = false
                execute {
                    try await vm.submit(.incident, record: record)
                    return "تم حفظ بلاغ الحادث"
                }
            }
        }
    }

    private func escalationFields(_ result: IncidentLookupDTO) -> some View {
        Group {
            formField("نوع الحدث *", text: $escEventType)
            formField("التاريخ والوقت (yyyy-MM-dd HH:mm)", text: $escDateTime)
                .keyboardType(.numbersAndPunctuation)
            formField("الموقع", text: $escLocation)
            HStack(spacing: 8) {
                formField("الإصابات", text: $escInjuries).keyboardType(.numberPad)
                formField("الوفيات", text: $escDeaths).keyboardType(.numberPad)
            }
            chipsRow(Self.agencies, selected: $escAgencies)
            formField("التفاصيل", text: $escDetails)
            EMSPrimaryButton(title: "حفظ بلاغ التصعيد", isLoading: working,
                             isDisabled: escEventType.trimmingCharacters(in: .whitespaces).isEmpty) {
                let number = result.number ?? ""
                var record: [String: Any] = [
                    "reportNumber": number, "incidentNumber": number,
                    "eventType": escEventType.trimmingCharacters(in: .whitespaces),
                    "injuries": Int(escInjuries) ?? 0,
                    "deaths": Int(escDeaths) ?? 0,
                    "agencies": Array(escAgencies).sorted()
                ]
                if !escDateTime.isEmpty { record["dateTime"] = escDateTime }
                record["location"] = escLocation
                record["details"] = escDetails
                if let cad = result.incident?.description { record["cadDescription"] = cad }
                showAdd = false
                execute {
                    try await vm.submit(.escalation, record: record)
                    return "تم حفظ بلاغ التصعيد"
                }
            }
        }
    }

    private func eCaseFields(_ result: IncidentLookupDTO) -> some View {
        Group {
            formField("التاريخ والوقت (yyyy-MM-dd HH:mm)", text: $ecDateTime)
                .keyboardType(.numbersAndPunctuation)
            formField("الموقع", text: $ecLocation)
            HStack(spacing: 8) {
                formField("العمر", text: $ecAge).keyboardType(.numberPad)
                pickerMenu("الجنس", options: Self.genders, selection: $ecGender)
            }
            formField("المستشفى", text: $ecHospital)
            pickerMenu("النتيجة", options: Self.outcomes, selection: $ecOutcome)
            formField("ملاحظات", text: $ecNotes)
            EMSPrimaryButton(title: "حفظ الحالة الإلكترونية", isLoading: working,
                             isDisabled: lookupUnit.isEmpty) {
                let number = result.number ?? ""
                let unit = lookupUnit
                var record: [String: Any] = [
                    "reportNumber": number, "incidentNumber": number,
                    "incidentUnit": unit, "unit": unit
                ]
                if !ecDateTime.isEmpty { record["dateTime"] = ecDateTime }
                record["location"] = ecLocation
                record["age"] = ecAge
                record["gender"] = ecGender
                // وقت الاستجابة من CAD المركزي — لا يُعاد حسابه في العميل (قاعدة الويب L-lookup)
                if let best = result.bestArrivalMin {
                    record["responseTime"] = best
                    record["responseTimeSource"] = "cad-central"
                } else {
                    record["responseTime"] = NSNull()
                    record["responseTimeSource"] = "cad-unavailable"
                }
                record["hospital"] = ecHospital
                record["outcome"] = ecOutcome
                record["notes"] = ecNotes
                showAdd = false
                execute {
                    try await vm.submit(.eCase, record: record)
                    return "تم حفظ الحالة الإلكترونية"
                }
            }
        }
    }

    // MARK: - التقرير اليومي

    private var dailySheet: some View {
        formShell("تقرير يومي جديد") {
            formField("رقم التقرير *", text: $drNumber)
            formField("التاريخ * (yyyy-MM-dd)", text: $drDate)
                .keyboardType(.numbersAndPunctuation)
            HStack(spacing: 8) {
                formField("فرق الاستجابة", text: $drTeams).keyboardType(.numberPad)
                formField("الإسعاف الجوي", text: $drAir).keyboardType(.numberPad)
            }
            formField("بلاغات الحدود", text: $drBorder)
            chipsRow(Self.dailyPaths, selected: $drPaths)
            formField("تعبئة النماذج", text: $drFormFill)
            formField("الملخص", text: $drSummary)
            EMSPrimaryButton(title: "حفظ التقرير", isLoading: working,
                             isDisabled: drNumber.trimmingCharacters(in: .whitespaces).isEmpty ||
                                         drDate.trimmingCharacters(in: .whitespaces).isEmpty) {
                let record: [String: Any] = [
                    "reportNumber": drNumber.trimmingCharacters(in: .whitespaces),
                    "date": drDate.trimmingCharacters(in: .whitespaces),
                    "responseTeams": Int(drTeams) ?? 0,
                    "air": Int(drAir) ?? 0,
                    "borderReports": drBorder,
                    "paths": Array(drPaths).sorted(),
                    "formFill": drFormFill,
                    "summary": drSummary
                ]
                showAdd = false
                execute {
                    try await vm.submit(.dailyReport, record: record)
                    return "تم حفظ التقرير اليومي"
                }
            }
        }
    }

    // MARK: - مناوبة كبار المسعفين

    private var seniorSheet: some View {
        formShell("مناوبة كبار المسعفين") {
            HStack(spacing: 8) {
                formField("سيارات عاملة", text: $srWorking).keyboardType(.numberPad)
                formField("متعطلة", text: $srBroken).keyboardType(.numberPad)
            }
            HStack(spacing: 8) {
                formField("احتياط", text: $srReserve).keyboardType(.numberPad)
                formField("فرق أوفرلاب", text: $srOverlap).keyboardType(.numberPad)
            }
            chipsRow(Self.seniorAreas, selected: $srAreas)
            formField("ملاحظات", text: $srNotes)
            officerFields(title: "مساعد كبير المسعفين *", name: $srAsstName, date: $srAsstDate)
            officerFields(title: "كبير المسعفين *", name: $srChiefName, date: $srChiefDate)
            officerFields(title: "قائد القطاع", name: $srCmdrName, date: $srCmdrDate)
            EMSPrimaryButton(title: "حفظ المناوبة", isLoading: working,
                             isDisabled: srAsstName.trimmingCharacters(in: .whitespaces).isEmpty ||
                                         srChiefName.trimmingCharacters(in: .whitespaces).isEmpty) {
                let record: [String: Any] = [
                    "workingCars": srWorking.isEmpty ? "0" : srWorking,
                    "brokenCars": srBroken.isEmpty ? "0" : srBroken,
                    "reserveCars": srReserve.isEmpty ? "0" : srReserve,
                    "overlapTeams": srOverlap.isEmpty ? "0" : srOverlap,
                    "overlapAreas": Array(srAreas).sorted(),
                    "notes": srNotes,
                    "asstName": srAsstName.trimmingCharacters(in: .whitespaces),
                    "asstSign": "",
                    "asstDate": srAsstDate,
                    "chiefName": srChiefName.trimmingCharacters(in: .whitespaces),
                    "chiefSign": "",
                    "chiefDate": srChiefDate,
                    "cmdrName": srCmdrName.trimmingCharacters(in: .whitespaces),
                    "cmdrSign": "",
                    "cmdrDate": srCmdrDate
                ]
                showAdd = false
                execute {
                    try await vm.submit(.seniorShift, record: record)
                    return "تم حفظ مناوبة كبار المسعفين"
                }
            }
        }
    }

    private func officerFields(title: String, name: Binding<String>, date: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textMuted)
            formField("الاسم", text: name)
            formField("التاريخ (yyyy-MM-dd)", text: date)
                .keyboardType(.numbersAndPunctuation)
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
