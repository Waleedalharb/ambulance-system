//
//  ScheduleEmployeeView.swift
//  EMSOperations
//
//  وجه «موظف»: بحث في دليل الموظفين ثم جدوله للشهر المختار من
//  /api/shift-roster/employee-schedule/:id — بشكل الويب حرفيًا: ملخص
//  عدد كل رمز + شبكة شهرية (رقم اليوم/الرمز/الفريق). نقرة خلية مغطاة
//  تفتح ورقة تعديل الخلية نفسها (مطابقة سجل الروستر بالمعرف والتاريخ)،
//  ورابط لسجل تدقيق ذلك الموظف. الخادم يحجب من لا يملك schedule.view
//  على غيره (403 يُعرض بلفظه).
//

import SwiftUI

struct ScheduleEmployeeView: View {
    @ObservedObject var vm: ScheduleOpsViewModel
    /// نقرة خلية مغطاة تفتح ورقة تعديل الخلية في المركز (نفس مسار وجه الشهر).
    var onSelect: ((ScheduleCellContext) -> Void)? = nil

    @State private var query = ""
    @State private var results: [EmployeeDirectoryDTO.Person] = []
    @State private var searching = false
    @State private var searchError: String?
    @State private var selected: EmployeeDirectoryDTO.Person?
    @State private var schedule: [EmployeeScheduleDTO.Day] = []
    @State private var scheduleState: LoadState = .idle
    @State private var scheduleError: String?

    enum LoadState { case idle, loading, loaded }

    var body: some View {
        VStack(spacing: EMSTheme.spacing) {
            searchCard
            if let selected {
                scheduleCard(for: selected)
            } else if !results.isEmpty {
                resultsCard
            }
        }
    }

    // MARK: - البحث
    private var searchCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "البحث عن موظف", systemImage: "magnifyingglass")
                HStack(spacing: 8) {
                    TextField("الاسم أو الرقم الوظيفي", text: $query)
                        .textFieldStyle(.plain)
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                        .padding(10)
                        .background(Color.white.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .submitLabel(.search)
                        .onSubmit { runSearch() }
                    Button {
                        runSearch()
                    } label: {
                        if searching { ProgressView().tint(.white) }
                        else { Image(systemName: "magnifyingglass").foregroundStyle(.white) }
                    }
                    .frame(width: 44, height: 44)
                    .background(EMSTheme.Colors.teal)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .disabled(searching || query.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let searchError {
                    Text(searchError)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.danger)
                }
            }
        }
    }

    private func runSearch() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        searching = true
        searchError = nil
        selected = nil
        Task {
            do {
                let found = try await vm.searchEmployees(q)
                results = found
                if found.isEmpty { searchError = "لا نتائج مطابقة." }
            } catch let e as APIError {
                searchError = e.userMessage
                results = []
            } catch {
                searchError = APIError.unknown.userMessage
                results = []
            }
            searching = false
        }
    }

    // MARK: - نتائج البحث
    private var resultsCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "النتائج", systemImage: "list.bullet")
                ForEach(results) { person in
                    Button {
                        select(person)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(person.name ?? "—")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                                Text([person.employeeCode, person.jobTitle].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            Spacer()
                            Image(systemName: "chevron.left")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func select(_ person: EmployeeDirectoryDTO.Person) {
        selected = person
        guard let id = person.id else {
            scheduleState = .idle
            scheduleError = "هذا الموظف بلا معرف في الرد."
            return
        }
        scheduleState = .loading
        scheduleError = nil
        Task {
            do {
                schedule = try await vm.employeeSchedule(id)
                scheduleState = .loaded
            } catch let e as APIError {
                scheduleError = e.userMessage
                scheduleState = .idle
            } catch {
                scheduleError = APIError.unknown.userMessage
                scheduleState = .idle
            }
        }
    }

    // MARK: - جدول الموظف — مطابق لشكل الويب: ملخص الرموز + شبكة شهرية
    private func scheduleCard(for person: EmployeeDirectoryDTO.Person) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: "جدول \(person.name ?? "—") — \(vm.selectedMonthLabel)",
                                    systemImage: "person.fill")
                    Spacer()
                    Button("تغيير") {
                        selected = nil
                        schedule = []
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.teal)
                }
                switch scheduleState {
                case .idle:
                    if let scheduleError {
                        Text(scheduleError)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.danger)
                    }
                case .loading:
                    ProgressView().tint(EMSTheme.Colors.teal)
                        .frame(maxWidth: .infinity)
                case .loaded:
                    if schedule.isEmpty {
                        Text("لا توجد مناوبات لهذا الموظف في هذا الشهر.")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    } else {
                        summaryRow
                        monthGrid(for: person)
                        if let id = person.id {
                            NavigationLink {
                                ScheduleHistoryView(initialEmployeeId: id,
                                                    initialEmployeeName: person.name)
                                    .environmentObject(vm)
                            } label: {
                                HStack {
                                    Image(systemName: "clock.arrow.circlepath")
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                    Text("سجل تغييرات هذا الموظف")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                }
                            }
                            .padding(.top, 4)
                        }
                    }
                }
            }
        }
    }

    /// ملخص عدد كل رمز — مثل schedule-summary في الويب حرفيًا.
    private var summaryRow: some View {
        var counts: [String: Int] = [:]
        for d in schedule {
            let code = d.shiftCode ?? d.shiftName ?? "—"
            counts[code, default: 0] += 1
        }
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(counts.sorted(by: { $0.key < $1.key }), id: \.key) { code, count in
                    EMSStatusPill(text: "\(code): \(count)", tone: .neutral)
                }
            }
        }
    }

    private static let weekdays = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"]
    private static let gridColumns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    /// شبكة شهر الموظف — خلية لكل يوم: الرقم + الرمز + الفريق. نقرة الخلية
    /// المغطاة تفتح ورقة التعديل نفسها (تُطابق سجل الروستر المحمّل بالمعرف والتاريخ).
    private func monthGrid(for person: EmployeeDirectoryDTO.Person) -> some View {
        let byDate = Dictionary(
            schedule.compactMap { d -> (String, EmployeeScheduleDTO.Day)? in
                guard let date = d.date else { return nil }
                return (date, d)
            },
            uniquingKeysWith: { first, _ in first })
        let cells = monthCells()

        return VStack(spacing: 6) {
            LazyVGrid(columns: Self.gridColumns, spacing: 4) {
                ForEach(Self.weekdays, id: \.self) { w in
                    Text(w)
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Self.gridColumns, spacing: 4) {
                ForEach(cells, id: \.self) { cell in
                    switch cell {
                    case .blank:
                        Color.clear.frame(height: 54)
                    case .day(let dateStr, let dayNum, let isToday):
                        employeeDayCell(dateStr: dateStr, dayNum: dayNum, isToday: isToday,
                                        info: byDate[dateStr], person: person)
                    }
                }
            }
        }
    }

    private func employeeDayCell(dateStr: String, dayNum: Int, isToday: Bool,
                                 info: EmployeeScheduleDTO.Day?, person: EmployeeDirectoryDTO.Person) -> some View {
        VStack(spacing: 2) {
            Text("\(dayNum)")
                .font(.caption.weight(isToday ? .bold : .regular))
                .foregroundStyle(isToday ? EMSTheme.Colors.navy : .white)
            if let code = info?.shiftCode {
                Text(code)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(EMSTheme.Colors.teal)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            if let team = info?.teamName {
                Text(team)
                    .font(.system(size: 8))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 54)
        .background(isToday ? EMSTheme.Colors.teal : (info?.shiftCode != nil ? Color.white.opacity(0.07) : Color.clear))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            // التعديل بنفس ورقة الخلية — فقط عند وجود سجل roster مطابق
            guard let pid = person.id,
                  let entry = vm.roster.first(where: { $0.employeeId == pid && $0.shiftDate == dateStr })
            else { return }
            onSelect?(.existing(entry))
        }
        .accessibilityLabel("\(dateStr) \(info?.shiftName ?? info?.shiftCode ?? "بلا مناوبة")")
    }

    private enum EmpCell: Hashable {
        case blank(UUID = UUID())
        case day(String, Int, Bool)
    }

    /// خلايا شهر المركز المختار: فراغات المحاذاة (الأحد أولًا) ثم الأيام.
    private func monthCells() -> [EmpCell] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        var comps = DateComponents(); comps.year = vm.selectedYear; comps.month = vm.selectedMonthNumber; comps.day = 1
        guard let first = cal.date(from: comps),
              let range = cal.range(of: .day, in: .month, for: first) else { return [] }
        let lead = cal.component(.weekday, from: first) - 1
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = cal.timeZone
        let todayStr = fmt.string(from: Date())

        var cells: [EmpCell] = (0..<lead).map { _ in .blank() }
        for d in range {
            var dc = DateComponents(); dc.year = vm.selectedYear; dc.month = vm.selectedMonthNumber; dc.day = d
            guard let date = cal.date(from: dc) else { continue }
            let ds = fmt.string(from: date)
            cells.append(.day(ds, d, ds == todayStr))
        }
        return cells
    }
}
