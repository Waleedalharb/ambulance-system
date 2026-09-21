//
//  ScheduleRosterGrid.swift
//  EMSOperations
//
//  مكونات مجال الجداول المشتركة: تحويلات التاريخ، لون رمز المناوبة،
//  سياق الخلية، وشبكة «فرق ← موظفون ← أيام» المعاد استخدامها في
//  عرض الشهر/الفريق/المركز. تجميع عرضي فقط — لا اشتقاق منطقي.
//

import SwiftUI

// MARK: - تواريخ API (YYYY-MM-DD — ميلادي بتوقيت الرياض كالخادم)
enum ScheduleDateKit {
    static let apiFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return apiFormatter.date(from: s)
    }

    static func string(_ d: Date) -> String { apiFormatter.string(from: d) }

    /// رقم اليوم من "YYYY-MM-DD".
    static func dayNumber(_ s: String) -> String {
        s.count == 10 ? String(s.suffix(2)) : s
    }
}

// MARK: - لون رمز المناوبة من shift_codes (#RGB / #RRGGBB) — nil إن تعذّر التحليل
enum ScheduleColorParser {
    static func color(_ hex: String?) -> Color? {
        guard var h = hex?.trimmingCharacters(in: .whitespaces), h.hasPrefix("#") else { return nil }
        h.removeFirst()
        var value: UInt64 = 0
        guard Scanner(string: h).scanHexInt64(&value) else { return nil }
        switch h.count {
        case 3:
            return Color(red: Double((value >> 8) & 0xF) / 15.0,
                         green: Double((value >> 4) & 0xF) / 15.0,
                         blue: Double(value & 0xF) / 15.0)
        case 6:
            return Color(red: Double((value >> 16) & 0xFF) / 255.0,
                         green: Double((value >> 8) & 0xFF) / 255.0,
                         blue: Double(value & 0xFF) / 255.0)
        default:
            return nil
        }
    }
}

// MARK: - صف موظف داخل الشبكة (مشتق عرضيًا من سجلات الشهر)
struct ScheduleRosterRow: Identifiable {
    let id: String
    let employeeId: Int?
    let employeeCode: String?
    let employeeName: String
    let teamId: Int?
    let teamName: String
    let byDate: [String: RosterMonthDTO.Entry]
}

// MARK: - سياق الخلية المنقورة — سجل قائم أو خانة فارغة
enum ScheduleCellContext: Identifiable {
    case existing(RosterMonthDTO.Entry)
    case empty(row: ScheduleRosterRow, date: String)

    var id: String {
        switch self {
        case .existing(let e): return "x-\(e.stableId)"
        case .empty(let r, let d): return "e-\(r.id)-\(d)"
        }
    }
}

// MARK: - الشبكة: فرق ← موظفون ← خلايا أيام الشهر (تمرير أفقي موحد)
struct ScheduleRosterGrid: View {
    let entries: [RosterMonthDTO.Entry]
    let days: [String]
    let codes: [ShiftCodesDTO.Code]
    var allowsEmptyTap: Bool = false
    var onSelect: (ScheduleCellContext) -> Void

    private static let nameWidth: CGFloat = 118
    private static let cellSize: CGFloat = 34

    /// فرق بترتيب ورودها في رد الخادم.
    private var teamsOrdered: [String] {
        var seen: [String] = []
        for e in entries {
            let n = e.teamName ?? "بدون فريق"
            if !seen.contains(n) { seen.append(n) }
        }
        return seen
    }

    private func rows(team: String) -> [ScheduleRosterRow] {
        let teamEntries = entries.filter { ($0.teamName ?? "بدون فريق") == team }
        var order: [String] = []
        var info: [String: (employeeId: Int?, employeeCode: String?, employeeName: String, teamId: Int?, teamName: String)] = [:]
        var byDate: [String: [String: RosterMonthDTO.Entry]] = [:]
        for e in teamEntries {
            let key = e.employeeId.map(String.init) ?? "؟\(e.employeeName ?? "")"
            if info[key] == nil {
                order.append(key)
                info[key] = (e.employeeId, e.employeeCode, e.employeeName ?? "—", e.teamId, e.teamName ?? "بدون فريق")
                byDate[key] = [:]
            }
            if let d = e.shiftDate { byDate[key]?[d] = e }
        }
        return order.compactMap { key in
            guard let i = info[key] else { return nil }
            return ScheduleRosterRow(id: key, employeeId: i.employeeId,
                                     employeeCode: i.employeeCode, employeeName: i.employeeName,
                                     teamId: i.teamId, teamName: i.teamName,
                                     byDate: byDate[key] ?? [:])
        }
    }

    private func colorFor(_ code: String?) -> Color {
        guard let c = codes.first(where: { $0.code == code })?.color,
              let parsed = ScheduleColorParser.color(c) else {
            return Color.white.opacity(0.06)
        }
        return parsed.opacity(0.30)
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 6) {
                headerRow
                ForEach(teamsOrdered, id: \.self) { team in
                    teamSection(team)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var headerRow: some View {
        HStack(spacing: 4) {
            Text("الموظف")
                .font(.caption.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .frame(width: Self.nameWidth, alignment: .leading)
            ForEach(days, id: \.self) { d in
                Text(ScheduleDateKit.dayNumber(d))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .frame(width: Self.cellSize)
            }
        }
    }

    private func teamSection(_ team: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "person.3.fill")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text(team)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
            }
            .padding(.top, 6)
            ForEach(rows(team: team)) { row in
                employeeRow(row)
            }
        }
    }

    private func employeeRow(_ row: ScheduleRosterRow) -> some View {
        HStack(spacing: 4) {
            Text(row.employeeName)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: Self.nameWidth, alignment: .leading)
            ForEach(days, id: \.self) { d in
                dayCell(row: row, date: d)
            }
        }
    }

    private func dayCell(row: ScheduleRosterRow, date: String) -> some View {
        let entry = row.byDate[date]
        return Button {
            if let entry { onSelect(.existing(entry)) }
            else if allowsEmptyTap { onSelect(.empty(row: row, date: date)) }
        } label: {
            Text(entry?.shiftCode ?? "—")
                .font(.system(.caption2, design: .monospaced).weight(.semibold))
                .foregroundStyle(entry == nil ? EMSTheme.Colors.textMuted : .white)
                .frame(width: Self.cellSize, height: Self.cellSize)
                .background(colorFor(entry?.shiftCode))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(entry == nil && !allowsEmptyTap)
        .accessibilityLabel("\(row.employeeName) يوم \(date): \(entry?.shiftCode ?? "بدون مناوبة")")
    }
}
