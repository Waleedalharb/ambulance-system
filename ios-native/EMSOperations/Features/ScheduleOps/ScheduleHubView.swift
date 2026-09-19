//
//  ScheduleHubView.swift
//  EMSOperations
//
//  مركز مجال الجداول (docs/native-schedule-parity.md): منتقي الشهر +
//  خمسة أوجه عرض (شهر/يوم/فريق/موظف/مركز) + إحصاءات الشهر + روابط
//  سجل التغييرات والعمليات المتقدمة. لا منطق أعمال — عرض وتوجيه فقط.
//

import SwiftUI

struct ScheduleHubView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = ScheduleOpsViewModel()
    @State private var mode: HubMode = .month
    @State private var cellContext: ScheduleCellContext?
    @State private var officialExists = false
    @State private var downloadingOfficial = false
    @State private var shareItems: [Any] = []

    enum HubMode: String, CaseIterable, Identifiable {
        case month, day, team, employee, center
        var id: String { rawValue }
        var title: String {
            switch self {
            case .month: return "شهر"
            case .day: return "يوم"
            case .team: return "فريق"
            case .employee: return "موظف"
            case .center: return "مركز"
            }
        }
    }

    private var canWrite: Bool {
        let p = session.permissions
        return p.canEditScheduleCell || p.canManageScheduleEmployees || p.canSwapSchedule
            || p.canBulkUpdateSchedule || p.canExportSchedule || p.canClearSchedule
            || p.canGenerateSchedule
    }

    private var allowsEmptyTap: Bool {
        session.permissions.canEditScheduleCell || session.permissions.canManageScheduleEmployees
    }

    var body: some View {
        Group {
            switch vm.bootState {
            case .loading:
                VStack(spacing: EMSTheme.spacing) {
                    EMSSkeletonCard(lines: 3)
                    EMSSkeletonCard(lines: 6)
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
        .emsPage("الجداول")
        .task {
            await vm.load()
            await checkOfficialTable()
        }
        .sheet(item: $cellContext) { ctx in
            ScheduleCellSheet(context: ctx)
                .environmentObject(vm)
                .environmentObject(session)
        }
        .sheet(isPresented: .init(
            get: { !shareItems.isEmpty },
            set: { if !$0 { shareItems = [] } }
        )) {
            ActivityShareSheet(items: shareItems)
        }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                if vm.months.isEmpty {
                    EMSEmptyView(icon: "calendar", title: "لا توجد جداول بعد",
                                 detail: "لم يُسجَّل أي شهر في جدول المناوبات حتى الآن.")
                } else {
                    monthPicker
                    modePicker
                    if let stats = vm.stats { statsCard(stats) }
                    activeView
                    linksSection
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.reloadMonth() }
    }

    // MARK: - منتقي الشهر (أحدث شهر أولًا)
    private var monthPicker: some View {
        Menu {
            ForEach(vm.months.reversed(), id: \.self) { m in
                Button {
                    Task { await vm.selectMonth(m) }
                } label: {
                    if m == vm.selectedMonth {
                        Label(vm.monthLabel(m), systemImage: "checkmark")
                    } else {
                        Text(vm.monthLabel(m))
                    }
                }
            }
        } label: {
            HStack {
                Image(systemName: "calendar")
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text(vm.selectedMonthLabel)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            .padding(EMSTheme.cardPadding)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
        }
        .accessibilityLabel("اختيار الشهر — الحالي \(vm.selectedMonthLabel)")
    }

    private var modePicker: some View {
        Picker("وجه العرض", selection: $mode) {
            ForEach(HubMode.allCases) { m in
                Text(m.title).tag(m)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: - إحصاءات الشهر (من الخادم حرفيًا)
    private func statsCard(_ s: RosterStatsDTO) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "إحصاءات \(vm.selectedMonthLabel)", systemImage: "chart.bar.fill")
                EMSInfoRow(label: "إجمالي المناوبات", value: s.totalShifts.map(String.init) ?? "—")
                EMSInfoRow(label: "الموظفون المجدولون", value: s.employeesCount.map(String.init) ?? "—")
                EMSInfoRow(label: "تعارضات (موظف/يوم مكرر)",
                           value: s.conflictsCount.map(String.init) ?? "—",
                           valueColor: (s.conflictsCount ?? 0) > 0 ? EMSTheme.Colors.warning : EMSTheme.Colors.textPrimary)
                if let breakdown = s.shiftCodeBreakdown, !breakdown.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(breakdown.sorted(by: { $0.key < $1.key }), id: \.key) { code, count in
                                EMSStatusPill(text: "\(code): \(count)", tone: .neutral)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - وجه العرض النشط
    @ViewBuilder
    private var activeView: some View {
        switch mode {
        case .month:
            ScheduleMonthView(vm: vm, allowsEmptyTap: allowsEmptyTap) { cellContext = $0 }
        case .day:
            ScheduleDayView(vm: vm) { cellContext = $0 }
        case .team:
            ScheduleTeamView(vm: vm, centerMode: false, allowsEmptyTap: allowsEmptyTap) { cellContext = $0 }
        case .employee:
            ScheduleEmployeeView(vm: vm) { cellContext = $0 }
        case .center:
            ScheduleTeamView(vm: vm, centerMode: true, allowsEmptyTap: allowsEmptyTap) { cellContext = $0 }
        }
    }

    // MARK: - روابط السجل والعمليات المتقدمة
    private var linksSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            if officialExists {
                Button {
                    Task { await downloadOfficialTable() }
                } label: {
                    linkCard(title: "الجدول الشهري الرسمي",
                             subtitle: downloadingOfficial ? "جارٍ التنزيل…" : "ملف Excel المعتمد — يُستورد من الويب ويُقرأ هنا",
                             icon: "tablecells.badge.ellipsis", tint: EMSTheme.Colors.emerald)
                }
                .buttonStyle(.plain)
                .disabled(downloadingOfficial)
            }
            NavigationLink {
                ScheduleHistoryView()
                    .environmentObject(vm)
            } label: {
                linkCard(title: "سجل التغييرات", subtitle: "قبل/بعد كل تعديل على الجدول",
                         icon: "clock.arrow.circlepath", tint: EMSTheme.Colors.teal)
            }
            if canWrite {
                NavigationLink {
                    ScheduleAdvancedView()
                        .environmentObject(vm)
                        .environmentObject(session)
                } label: {
                    linkCard(title: "عمليات متقدمة", subtitle: "تصدير · مسودات · توليد · مسح — حسب صلاحياتك",
                             icon: "slider.horizontal.3", tint: EMSTheme.Colors.warning)
                }
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

    // MARK: - الجدول الشهري الرسمي (قراءة فقط — الاستيراد Web-only بقرار المالك)

    private func checkOfficialTable() async {
        let res: MonthlyTableCheckDTO? = try? await APIClient.shared.get("/api/check-monthly-table")
        officialExists = res?.exists == true
    }

    private func downloadOfficialTable() async {
        guard !downloadingOfficial else { return }
        downloadingOfficial = true
        defer { downloadingOfficial = false }
        if let file = try? await APIClient.shared.download("/api/get-monthly-table") {
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(file.filename ?? "monthly-table.xlsx")
            try? file.data.write(to: url, options: .atomic)
            shareItems = [url]
        }
    }
}
