//
//  IndicatorsOpsView.swift
//  EMSOperations
//
//  مجال المؤشرات والتحليلات (§21): لوحة التشغيل + مؤشر المساهمة الشهري
//  (indicators.contribution — مع التحفظات السيرفرية ظاهرة دائمًا) + نشاط الفرق.
//  كلها قراءات؛ الترتيب الأبجدي داخل فئات المساهمة يأتي من الخادم
//  (ليس ترتيب أداء — قرار المالك) ويُعرض كما يصل.
//

import SwiftUI

struct IndicatorsOpsView: View {
    @State private var segment: Segment = .dashboard

    enum Segment: String, CaseIterable, Identifiable {
        case dashboard, contribution, crews
        var id: String { rawValue }
        var title: String {
            switch self {
            case .dashboard: return "اللوحة"
            case .contribution: return "المساهمة"
            case .crews: return "نشاط الفرق"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                Picker("القسم", selection: $segment) {
                    ForEach(Segment.allCases) { s in
                        Text(s.title).tag(s)
                    }
                }
                .pickerStyle(.segmented)

                switch segment {
                case .dashboard: IndicatorsDashboardSegment()
                case .contribution: ContributionSegment()
                case .crews: CrewActivitySegment()
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("المؤشرات")
    }
}

// MARK: - لوحة التشغيل

struct IndicatorsDashboardSegment: View {
    @StateObject private var vm = IndicatorsDashboardViewModel()

    var body: some View {
        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 4)
            EMSSkeletonCard(lines: 3)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load() } }
        case .loaded:
            content
        }
        Color.clear.frame(height: 0)
            .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let d = vm.data, let stats = d.shiftStats {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("إحصاءات المناوبات")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    EMSInfoRow(label: "إجمالي المناوبات", value: "\(stats.totalShifts ?? 0)")
                    EMSInfoRow(label: "إجمالي البلاغات", value: "\(stats.totalReports ?? 0)")
                    EMSInfoRow(label: "متوسط البلاغات/مناوبة", value: "\(stats.avgReportsPerShift ?? 0)")
                    EMSInfoRow(label: "مناوبات اليوم", value: "\(stats.todayShifts ?? 0)")
                    EMSInfoRow(label: "الأعلى/الأدنى", value: "\(stats.maxReports ?? 0) / \(stats.minReports ?? 0)")
                }
            }

            if let types = d.shiftTypes, !types.isEmpty {
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("توزيع أنواع المناوبات")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        ForEach(types.sorted(by: { $0.key < $1.key }), id: \.key) { type, count in
                            EMSInfoRow(label: type, value: "\(count)")
                        }
                    }
                }
            }

            if let weekly = d.weekly, !weekly.isEmpty {
                EMSSectionHeader(title: "الأسابيع الأخيرة", systemImage: "calendar")
                ForEach(weekly.prefix(6)) { w in
                    EMSCard {
                        HStack {
                            Text(w.weekStart ?? "—")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white)
                            Spacer()
                            Text("مناوبات: \(w.shiftCount ?? 0) · بلاغات: \(w.reports ?? 0) · متوسط: \(w.avg ?? 0)")
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                        }
                    }
                }
            }

            if let centers = d.centerDistribution, !centers.isEmpty {
                EMSSectionHeader(title: "توزيع المراكز", systemImage: "mappin.and.ellipse")
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(centers.prefix(8)) { c in
                            EMSInfoRow(label: c.center ?? "—", value: "\(c.count ?? 0)")
                        }
                    }
                }
            }

            if let recent = d.recentShifts, !recent.isEmpty {
                EMSSectionHeader(title: "أحدث المناوبات", systemImage: "clock")
                ForEach(recent.prefix(10)) { s in
                    EMSCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(s.name ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                Text("\(s.date ?? "—") · \(s.type ?? "—")")
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            Spacer()
                            Text("\(s.totalReports ?? 0) بلاغ")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                        }
                    }
                }
            }
        }
    }
}

@MainActor
final class IndicatorsDashboardViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: IndicatorsDashboardDTO?
    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/indicators/dashboard")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}

// MARK: - مؤشر المساهمة الشهري (indicators.contribution)

struct ContributionSegment: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = ContributionViewModel()
    @State private var year = 0
    @State private var month = 0

    var body: some View {
        if !session.permissions.canViewIndicators {
            EMSEmptyView(
                icon: "lock",
                title: "صلاحية غير متاحة",
                detail: "مؤشر المساهمة يتطلب صلاحية indicators.contribution")
        } else {
            HStack(spacing: 10) {
                Picker("الشهر", selection: $month) {
                    ForEach(1...12, id: \.self) { Text("\($0)").tag($0) }
                }
                Picker("السنة", selection: $year) {
                    ForEach(2025...2030, id: \.self) { Text("\($0)").tag($0) }
                }
                Button("عرض") { Task { await vm.load(year: year, month: month) } }
                    .font(.caption.weight(.semibold))
                    .disabled(year == 0 || month == 0)
            }

            switch vm.state {
            case .loading:
                EMSSkeletonCard(lines: 4)
                EMSSkeletonCard(lines: 3)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.load(year: nil, month: nil) } }
            case .loaded:
                content
            }
        }

        Color.clear.frame(height: 0)
            .task {
                // التهيئة من تاريخ الجهاز للاختيار الأولي فقط — الخادم يحسم
                // الافتراضي من تاريخ الرياض عند غياب المعاملين (server.js:5036)
                let now = Date()
                let cal = Calendar.current
                year = cal.component(.year, from: now)
                month = cal.component(.month, from: now)
                await vm.load(year: nil, month: nil)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let d = vm.data {
            // التحفظات السيرفرية — تُعرض دائمًا وبنصها كما يصل (شرط الاعتماد)
            if let caveats = d.caveats, !caveats.isEmpty {
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("تحفظات القراءة", systemImage: "exclamationmark.triangle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.warning)
                        ForEach(caveats, id: \.self) { c in
                            Text("• \(c)")
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }

            if let range = d.range {
                Text("الفترة: \(range.from ?? "—") ← \(range.to ?? "—") · وُلّد: \(d.generatedAt ?? "—")")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }

            if let ops = d.groups?.operations {
                EMSSectionHeader(title: "العمليات (تحكم عملياتي/تنسيق استجابة)", systemImage: "headphones")
                if ops.isEmpty {
                    EMSEmptyView(icon: "person", title: "لا موظفين", detail: "لا موظفون مصنفون في العمليات")
                } else {
                    ForEach(ops) { emp in ContributionEmployeeCard(emp: emp) }
                }
            }

            if let field = d.groups?.fieldLeadership {
                EMSSectionHeader(title: "القيادة الميدانية (كبير/مساعد كبير مسعفين)", systemImage: "star.leadinghalf.filled")
                if field.isEmpty {
                    EMSEmptyView(icon: "person", title: "لا موظفين", detail: "لا موظفون مصنفون في القيادة الميدانية")
                } else {
                    ForEach(field) { emp in ContributionEmployeeCard(emp: emp) }
                }
            }

            if let unmatched = d.unmatchedJobTitles, !unmatched.isEmpty {
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("مسميات غير مصنفة — تُراجع يدويًا", systemImage: "questionmark.circle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(EMSTheme.Colors.warning)
                        ForEach(unmatched) { u in
                            EMSInfoRow(label: u.jobTitle ?? "(فارغ)", value: "\(u.count ?? 0)")
                        }
                    }
                }
            }
        }
    }
}

struct ContributionEmployeeCard: View {
    let emp: ContributionDTO.Employee
    @State private var expanded = false

    var body: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(emp.name ?? "—")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Text(emp.jobTitle ?? "—")
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text("\(emp.totalWorks ?? 0)")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(EMSTheme.Colors.teal)
                        Text("إجمالي الأعمال")
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                HStack(spacing: 10) {
                    Text("ساعات: \(Int(emp.scheduledHours ?? 0))")
                    Text("مناوبات: \(emp.shifts ?? 0)")
                    if (emp.uncountedRosterDays ?? 0) > 0 {
                        Text("أيام بلا اشتقاق: \(emp.uncountedRosterDays ?? 0)")
                            .foregroundStyle(EMSTheme.Colors.warning)
                    }
                }
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textSecondary)

                DisclosureGroup("تفصيل المؤشرات", isExpanded: $expanded) {
                    worksDetail
                        .padding(.top, 6)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textSecondary)
            }
        }
    }

    @ViewBuilder
    private var worksDetail: some View {
        if let w = emp.works {
            VStack(alignment: .leading, spacing: 6) {
                row("التكميل", w.completions)
                row("إجراءات توزيع البلاغات", w.dispatchActions)
                row("البلاغات (سجل الواجهة)", w.reports)
                row("التراجع عن البلاغات", w.dispatchUndo)
                row("بلاغات تفصيلية", w.detailedReports)
                row("التمركزات", w.positioning?.total)
                row("تسجيل خروج الفرق", w.signouts)
                row("النماذج", w.forms?.total)
                row("أحداث القوى البشرية", w.staffingEvents)
                row("أحداث المركبات", w.vehicleEvents)
                row("الأحداث اللوجستية", w.logisticsEvents)
                row("أحداث المراكز", w.centerEvents)
                row("إجراءات سير العمل", w.workflowActions?.total)
                row("تعديلات الجداول", w.scheduleEdits)
                row("دورة المناوبة", w.shiftLifecycle)
                row("رفع الملفات", w.docs)
                row("الإعلانات", w.announcements)
                row("معالجة التنبيهات", w.alertsAcked)
            }
        }
    }

    private func row(_ label: String, _ value: Int?) -> some View {
        EMSInfoRow(label: label, value: "\(value ?? 0)")
    }
}

@MainActor
final class ContributionViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: ContributionDTO?
    private let api = APIClient.shared

    func load(year: Int?, month: Int?) async {
        state = .loading
        do {
            var query: [String: String] = [:]
            if let year { query["year"] = "\(year)" }
            if let month { query["month"] = "\(month)" }
            data = try await api.get("/api/indicators/contribution", query: query)
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}

// MARK: - نشاط الفرق

struct CrewActivitySegment: View {
    @StateObject private var vm = CrewActivityViewModel()
    @State private var period = "current_shift"

    private let periods: [(String, String)] = [
        ("current_shift", "المناوبة الحالية"),
        ("today", "اليوم"),
        ("week", "الأسبوع"),
        ("month", "الشهر")
    ]

    var body: some View {
        Picker("الفترة", selection: $period) {
            ForEach(periods, id: \.0) { Text($0.1).tag($0.0) }
        }
        .pickerStyle(.segmented)
        .onChange(of: period) { newValue in
            Task { await vm.load(period: newValue) }
        }

        // التحفظ السيرفري: الترتيب نشاط فقط وليس تقييم أداء
        if let note = vm.data?.meta?.note {
            Text(note)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.warning)
                .fixedSize(horizontal: false, vertical: true)
        }

        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 3)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load(period: period) } }
        case .loaded:
            let standings = vm.data?.standings ?? []
            if standings.isEmpty {
                EMSEmptyView(icon: "person.3", title: "لا فرق", detail: "لا فرق نشطة في هذه الفترة")
            } else {
                ForEach(standings) { s in
                    EMSCard {
                        HStack(spacing: 12) {
                            Text("#\(s.rank ?? 0)")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(EMSTheme.Colors.teal)
                                .frame(width: 34)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(s.team ?? "—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                if let center = s.center {
                                    Text(center)
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 3) {
                                Text("\(s.reportsCount ?? 0) بلاغ")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.white)
                                if let members = s.members {
                                    Text("\(members) عضو")
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                        }
                    }
                }
            }
        }

        Color.clear.frame(height: 0)
            .task { await vm.load(period: period) }
    }
}

@MainActor
final class CrewActivityViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: CrewActivityDTO?
    private let api = APIClient.shared

    func load(period: String) async {
        state = .loading
        do {
            data = try await api.get("/api/crew-performance/activity",
                query: ["scope": "south", "period": period, "top": "5"])
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
