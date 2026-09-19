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
                EMSectionHeader(title: "الأسابيع الأخيرة", systemImage: "calendar")
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
                EMSectionHeader(title: "توزيع المراكز", systemImage: "mappin.and.ellipse")
                EMSCard {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(centers.prefix(8)) { c in
                            EMSInfoRow(label: c.center ?? "—", value: "\(c.count ?? 0)")
                        }
                    }
                }
            }

            if let recent = d.recentShifts, !recent.isEmpty {
                EMSectionHeader(title: "أحدث المناوبات", systemImage: "clock")
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
                EMSectionHeader(title: "العمليات (تحكم عملياتي/تنسيق استجابة)", systemImage: "headphones")
                if ops.isEmpty {
                    EMSEmptyView(icon: "person", title: "لا موظفين", detail: "لا موظفون مصنفون في العمليات")
                } else {
                    ForEach(ops) { emp in ContributionEmployeeCard(emp: emp) }
                }
            }

            if let field = d.groups?.fieldLeadership {
                EMSectionHeader(title: "القيادة الميدانية (كبير/مساعد كبير مسعفين)", systemImage: "star.leadinghalf.filled")
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

// MARK: - نشاط الفرق (مطابقة الويب crew-achievement-board.js حرفيًا)

struct CrewActivitySegment: View {
    @StateObject private var vm = CrewActivityViewModel()
    @State private var period = "current_shift"

    private let periods: [(String, String)] = [
        ("current_shift", "الحالية"),
        ("today", "اليوم"),
        ("week", "أسبوع"),
        ("month", "شهر")
    ]
    /// مؤهل الفترة كما في الويب (PERIODS[].qualifier)
    private var periodQualifier: String {
        switch period {
        case "today": return "اليوم"
        case "week": return "هذا الأسبوع"
        case "month": return "هذا الشهر"
        default: return "مباشرة"
        }
    }
    private var isLongPeriod: Bool { period == "week" || period == "month" }

    /// جمع البلاغات كما في المخطط المعتمد: 3..10 «بلاغات»، وإلا «بلاغ»
    private func pluralReports(_ n: Int) -> String {
        (3...10).contains(n) ? "بلاغات" : "بلاغ"
    }

    private func medal(_ rank: Int) -> String {
        switch rank {
        case 1: return "🥇"
        case 2: return "🥈"
        case 3: return "🥉"
        default: return "\(rank)."
        }
    }

    /// '2026-08-18' ← «18 أغسطس» (تاريخ مجرد، بلا تحويل ساعات)
    private func formatShiftDate(_ ymd: String?) -> String {
        guard let ymd = ymd else { return "—" }
        let parts = ymd.split(separator: "-")
        guard parts.count >= 3,
              let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d) else { return ymd }
        let months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
                      "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]
        return "\(d) \(months[m - 1])"
    }

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
        case .noActiveShift:
            // 404 من الخادم (current_shift بلا مناوبة نشطة) — حالة صادقة وليست خطأ
            EMSEmptyView(icon: "moon.zzz", title: "لا توجد مناوبة نشطة",
                         detail: "يبدأ السباق مع المناوبة القادمة")
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load(period: period) } }
        case .loaded:
            let standings = vm.data?.standings ?? []
            if standings.isEmpty {
                EMSEmptyView(icon: "flag.checkered", title: "السباق لم يبدأ",
                             detail: "أول بلاغ يصنع المتصدر 🚑")
            } else {
                Text("الأكثر نشاطًا")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(standings) { s in
                    standingCard(s)
                }
            }
        }

        Color.clear.frame(height: 0)
            .task { await vm.load(period: period) }
    }

    @ViewBuilder
    private func standingCard(_ s: CrewActivityDTO.Standing) -> some View {
        // قاعدة الأسماء (تعديل المالك — مطابقة الويب):
        // current_shift/today ← members؛ week/month ← shifts[0].members (أحدث مناوبة)
        // + سطر «مناوبة <تاريخها>»، وحقل members المجمّع لا يُعرض إطلاقًا في week/month.
        let latest = isLongPeriod ? s.shifts?.first : nil
        let names = isLongPeriod ? latest?.members : s.members
        let incomplete = isLongPeriod ? (latest?.membersIncomplete ?? false) : (s.membersIncomplete ?? false)
        let count = s.reportsCount ?? 0
        let rank = s.rank ?? 0

        EMSCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Text(medal(rank))
                        .font(.headline)
                        .frame(width: 34, alignment: .leading)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(s.team ?? "—")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        if let center = s.center {
                            Text("📍 \(center)")
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text("🚑 \(count) \(pluralReports(count)) \(periodQualifier)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                        if let rate = s.activityRatePerHour {
                            Text("⚡ \(rate, specifier: "%.2f") بلاغ/ساعة")
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        } else {
                            Text("⚡ —")
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                    }
                }

                // الطاقم: تعذّر إثبات التشكيل ← رسالة صادقة بلا تخمين
                if incomplete && (names?.isEmpty ?? true) {
                    Text("⚠️ بيانات طاقم المناوبة غير مكتملة")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.warning)
                } else if let names = names, !names.isEmpty {
                    Text("👥 طاقم المناوبة")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    ForEach(names, id: \.self) { name in
                        Text("👤 \(name)")
                            .font(.caption)
                            .foregroundStyle(.white)
                    }
                }

                if isLongPeriod, let latest = latest {
                    Text("🕐 مناوبة \(formatShiftDate(latest.shiftDate))")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                } else if !isLongPeriod, rank == 1 {
                    Text("✨ طاقم هذه المناوبة")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
    }
}

@MainActor
final class CrewActivityViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, noActiveShift, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: CrewActivityDTO?
    private let api = APIClient.shared

    func load(period: String) async {
        state = .loading
        do {
            data = try await api.get("/api/crew-performance/activity",
                query: ["scope": "south", "period": period, "top": "5"])
            state = .loaded
        } catch APIError.notFound {
            // الخادم يرمي 404 فقط عند current_shift بلا مناوبة نشطة — حالة صادقة وليست خطأ
            data = nil
            state = .noActiveShift
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
