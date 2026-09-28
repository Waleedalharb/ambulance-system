//
//  NotificationsView.swift
//  EMSOperations
//
//  «إشعاراتي» (قسم 17): قراءة عند الفتح + تأكيد مستقل
//  (فتح الإشعار ≠ تأكيده — نفس دلالة الخادم).
//
//  إعادة بناء بصرية (2026-09-28 — اعتماد المرجع البصري للمالك):
//  Dark Navy/Teal · RTL كامل · فلاتر حسب التصنيف الحقيقي · تجميع بالأيام
//  (بتوقيت الرياض) · بطاقة تمركز مميزة · حالات مقروء/غير مقروء واضحة.
//  واجهة فقط: لا تغيير في DTO ولا API ولا منطق الإشعارات/التمركز —
//  كل قيمة معروضة مصدرها الحمولة الفعلية، والحقل الغائب لا يظهر.
//  ملاحظة انحراف موثقة عن المرجع: زر «حذف الكل» (أيقونة السلة) أُسقط
//  لأن الخادم لا يملك مسار حذف/مسح للإشعارات — لا إجراء وهمي.
//

import SwiftUI

// MARK: - التصنيفات (مبنية على تمييزات حقيقية في البيانات فقط)

/// فلاتر الصفحة. التصنيف لا يستخدم مطابقة نصية واسعة:
/// - التمركز: isPositioning (type=positioning من الحمولة المهيكلة).
/// - مهم: تمركز أولويته ضمن القيم الحرجة الواردة فعلًا من نموذج الخطة.
/// - المناوبات: إشعارات سجل الجدول (source=log — منتَجها الوحيد shift_change).
/// - الطلبات: إشعارات شخصية بعناوين الخادم الثابتة حرفيًا (مطابقة تامة).
private enum NoticeFilter: CaseIterable, Identifiable {
    case all, urgent, shifts, requests, positioning

    var id: Self { self }

    var title: String {
        switch self {
        case .all: return "الكل"
        case .urgent: return "مهم"
        case .shifts: return "المناوبات"
        case .requests: return "الطلبات"
        case .positioning: return "التمركز"
        }
    }

    var icon: String {
        switch self {
        case .all: return "square.grid.2x2.fill"
        case .urgent: return "exclamationmark.triangle.fill"
        case .shifts: return "calendar"
        case .requests: return "doc.text.fill"
        case .positioning: return "mappin.and.ellipse"
        }
    }

    /// لون مميز للأيقونة داخل الشريحة غير النشطة (teal للنشطة).
    var tint: Color {
        switch self {
        case .urgent: return EMSTheme.Colors.danger
        case .positioning: return EMSTheme.Colors.teal
        case .requests: return NoticePalette.requests
        case .shifts: return NoticePalette.shifts
        case .all: return EMSTheme.Colors.textSecondary
        }
    }

    /// عناوين إشعارات نتائج الطلبات كما يكتبها الخادم حرفيًا
    /// (server.js — مراجعة طلبات الإجازة وتغيير المناوبة). مطابقة تامة فقط.
    private static let requestTitles: Set<String> = [
        "تمت الموافقة على طلب الإجازة",
        "تم رفض طلب الإجازة",
        "تمت الموافقة على طلب تغيير المناوبة",
        "تم رفض طلب تغيير المناوبة",
        "تم إلغاء طلب تغيير المناوبة"
    ]

    /// أولويات تستوجب تصنيف «مهم» — القيم كما ترد من نموذج خطة الذروة فعلًا.
    private static let urgentPriorities: Set<String> = ["high", "urgent", "important", "critical", "عالية", "حرجة", "مهم"]

    static func isUrgent(_ n: PortalNotificationsDTO.Item) -> Bool {
        guard let p = n.data?.priority else { return false }
        return urgentPriorities.contains(p) || urgentPriorities.contains(p.lowercased())
    }

    static func isRequest(_ n: PortalNotificationsDTO.Item) -> Bool {
        guard n.isPersonal, let t = n.title else { return false }
        return requestTitles.contains(t)
    }

    func matches(_ n: PortalNotificationsDTO.Item) -> Bool {
        switch self {
        case .all: return true
        case .urgent: return Self.isUrgent(n)
        case .positioning: return n.isPositioning
        case .requests: return Self.isRequest(n)
        case .shifts: return !n.isPersonal && !n.isPositioning
        }
    }

    func count(in items: [PortalNotificationsDTO.Item]) -> Int {
        items.filter { matches($0) }.count
    }
}

/// نوع بصري للبطاقة — مشتق من نفس التمييزات الحقيقية أعلاه.
private enum NoticeKind {
    case positioning, shifts, requests, general

    static func of(_ n: PortalNotificationsDTO.Item) -> NoticeKind {
        if n.isPositioning { return .positioning }
        if NoticeFilter.isRequest(n) { return .requests }
        if !n.isPersonal { return .shifts }
        return .general
    }

    var icon: String {
        switch self {
        case .positioning: return "mappin.and.ellipse"
        case .shifts: return "calendar"
        case .requests: return "doc.text.fill"
        case .general: return "megaphone.fill"
        }
    }

    var tint: Color {
        switch self {
        case .positioning: return EMSTheme.Colors.teal
        case .shifts: return NoticePalette.shifts
        case .requests: return NoticePalette.requests
        case .general: return EMSTheme.Colors.textMuted
        }
    }
}

/// ألوان مساندة محلية لهذه الشاشة فقط (أزرق المناوبات/بنفسجي الطلبات من
/// المرجع البصري) — لا تُضاف لـEMSTheme حتى لا تمس الشاشات الأخرى.
private enum NoticePalette {
    static let shifts = Color(red: 0.42, green: 0.62, blue: 0.95)
    static let requests = Color(red: 0.68, green: 0.56, blue: 0.95)
}

// MARK: - الشاشة

struct NotificationsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = NotificationsViewModel()
    /// بند 11: بطاقة تفاصيل التمركز عند فتح إشعار تمركز من القائمة.
    @State private var noticeSheet: PositioningNotice?
    @State private var filter: NoticeFilter = .all

    private var filteredItems: [PortalNotificationsDTO.Item] {
        vm.items.filter { filter.matches($0) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                headerBlock
                if !vm.items.isEmpty { filterRow }
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(session: session) } }
                case .loaded:
                    loadedContent
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load(session: session) }
        .emsPage("إشعاراتي")
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load(session: session) }
        .sheet(item: $noticeSheet) { notice in
            PositioningNoticeView(notice: notice)
        }
    }

    // MARK: الترويسة (العنوان البصري داخل الصفحة — شريط التنقل يبقى inline)

    private var headerBlock: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text("الإشعارات")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                Text("كل ما يخصك من تنبيهات وتحديثات")
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            Spacer()
            if vm.items.contains(where: { !$0.isRead }) {
                // عداد غير المقروء — من البيانات الفعلية المحملة
                Text(verbatim: "\(vm.items.filter { !$0.isRead }.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(EMSTheme.Colors.teal)
                    .clipShape(Capsule())
                    .accessibilityLabel("إشعارات غير مقروءة")
            }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: صف الفلاتر (الأعداد من العناصر الفعلية المحملة)

    private var filterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(NoticeFilter.allCases) { f in
                    filterChip(f)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func filterChip(_ f: NoticeFilter) -> some View {
        let active = filter == f
        return Button {
            withAnimation(.easeInOut(duration: 0.18)) { filter = f }
        } label: {
            HStack(spacing: 5) {
                Text(verbatim: "\(f.count(in: vm.items))")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(active ? .white : f.tint)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(active ? Color.white.opacity(0.22) : f.tint.opacity(0.16))
                    .clipShape(Capsule())
                Text(f.title)
                    .font(.caption.weight(.semibold))
                Image(systemName: f.icon)
                    .font(.caption2)
            }
            .foregroundStyle(active ? .white : EMSTheme.Colors.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(active ? EMSTheme.Colors.teal : EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(active ? EMSTheme.Colors.teal : EMSTheme.Colors.divider, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(f.title)، \(f.count(in: vm.items))")
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    // MARK: المحتوى المحمَّل — تجميع بالأيام (بتوقيت الرياض)

    @ViewBuilder
    private var loadedContent: some View {
        if vm.items.isEmpty {
            EMSEmptyView(icon: "bell.slash", title: "لا توجد إشعارات",
                         detail: "ستظهر هنا التنبيهات والتحديثات فور وصولها")
        } else if filteredItems.isEmpty {
            EMSEmptyView(icon: filter.icon, title: "لا توجد إشعارات في «\(filter.title)»",
                         detail: "جرّب تصنيفًا آخر من الأعلى")
        } else {
            LazyVStack(alignment: .leading, spacing: EMSTheme.spacing) {
                ForEach(Self.groupByDay(filteredItems)) { group in
                    dayHeader(group)
                    ForEach(group.items) { item in
                        noticeCard(item)
                    }
                }
                endFooter
            }
        }
    }

    private func dayHeader(_ group: DayGroup) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(group.title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(EMSTheme.Colors.textPrimary)
            Text(group.subtitle)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 6)
        .accessibilityAddTraits(.isHeader)
    }

    /// خاتمة القائمة وفق المرجع — تظهر فقط عند وجود عناصر.
    private var endFooter: some View {
        VStack(spacing: 8) {
            Image(systemName: "bell.fill")
                .font(.title3)
                .foregroundStyle(EMSTheme.Colors.teal)
                .frame(width: 46, height: 46)
                .background(EMSTheme.Colors.teal.opacity(0.12))
                .clipShape(Circle())
            Text("لا توجد إشعارات أخرى")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textSecondary)
            Text("ستظهر هنا أي تنبيهات جديدة عند توفرها")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
        .accessibilityElement(children: .combine)
    }

    // MARK: بطاقة الإشعار الموحدة

    private func noticeCard(_ n: PortalNotificationsDTO.Item) -> some View {
        Group {
            if n.isPositioning {
                // بطاقة التمركز: الضغط يفتح بطاقة التفاصيل (بند 11/التدشين)
                Button {
                    noticeSheet = PositioningNotice(title: n.title ?? "مهمة تمركز", message: n.message, data: n.data)
                } label: {
                    cardBody(n)
                }
                .buttonStyle(.plain)
            } else {
                cardBody(n)
            }
        }
        .opacity(n.isRead ? 0.68 : 1) // تمييز بصري قاطع: مقروء باهت / غير مقروء كامل
    }

    private func cardBody(_ n: PortalNotificationsDTO.Item) -> some View {
        let kind = NoticeKind.of(n)
        return HStack(alignment: .top, spacing: 10) {
            // أيقونة النوع في مربع مدور ملون
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(kind.tint.opacity(0.16))
                Image(systemName: kind.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(kind.tint)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 6) {
                // العنوان (من الخادم) + شارة «مهم» عند أولوية التمركز الحرجة
                if let title = n.title, !title.isEmpty {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(EMSTheme.Colors.textPrimary)
                        if NoticeFilter.isUrgent(n) {
                            Text("مهم")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(EMSTheme.Colors.danger)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(EMSTheme.Colors.danger.opacity(0.15))
                                .clipShape(Capsule())
                        }
                        if n.isAcked && !n.isPersonal {
                            EMSStatusPill(text: "مؤكَّد", tone: .normal)
                        }
                    }
                }

                // نص الإشعار كما ورد — النصوص الطويلة تُعرض كاملة بلا قص
                Text(cardMessage(n))
                    .font(n.title == nil ? .subheadline.weight(.medium) : .caption)
                    .foregroundStyle(n.title == nil ? EMSTheme.Colors.textPrimary : EMSTheme.Colors.textSecondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                // سطر التمركز المهيكل: الفترة/الفريق من data_json (لا من تفسير النص)
                if n.isPositioning { positioningMetaRow(n) }

                // الإجراءات القائمة (بلا تغيير وظيفي): ختم القراءة/تأكيد الاستلام
                actionsRow(n)
            }

            Spacer(minLength: 0)

            // الوقت + نقطة غير المقروء + سهم التفاصيل للتمركز
            VStack(alignment: .trailing, spacing: 6) {
                HStack(spacing: 5) {
                    if !n.isRead {
                        Circle().fill(EMSTheme.Colors.emerald).frame(width: 7, height: 7)
                    }
                    Text(verbatim: NoticeTime.hhmm(n.createdAt) ?? "")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                if n.isPositioning {
                    Image(systemName: "chevron.left")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .frame(maxHeight: .infinity, alignment: .center)
                }
            }
        }
        .padding(EMSTheme.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous)
                .stroke(n.isPositioning ? EMSTheme.Colors.teal.opacity(0.55) : Color.clear,
                        lineWidth: 1.2)
        )
        .accessibilityElement(children: .combine)
    }

    /// نص البطاقة: للتمركز تُعرض الجملة الافتتاحية فقط — أسطر «الفترة/الفريق/
    /// البداية/النهاية» معروضة مهيكلة في سطر الميتا وبطاقة التفاصيل، فإظهارها
    /// هنا تكرار بصري. مُعرّف [تمركز #..] الداخلي لا يظهر إطلاقًا.
    private func cardMessage(_ n: PortalNotificationsDTO.Item) -> String {
        if n.isPositioning {
            return n.message.components(separatedBy: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .first { !$0.isEmpty && !($0.hasPrefix("[") && $0.hasSuffix("]")) && !$0.contains(":") }
                ?? n.message.components(separatedBy: "\n")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .first { !$0.isEmpty && !($0.hasPrefix("[") && $0.hasSuffix("]")) }
                ?? ""
        }
        return n.message
    }

    private func positioningMetaRow(_ n: PortalNotificationsDTO.Item) -> some View {
        let period: String? = {
            guard let st = NoticeTime.hhmm(n.data?.start_time),
                  let et = NoticeTime.hhmm(n.data?.end_time) else { return nil }
            return "\(st) – \(et)"
        }()
        return HStack(spacing: 14) {
            if let period {
                Label("الفترة: \(period)", systemImage: "clock")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.teal)
            }
            if let team = n.data?.team, !team.isEmpty {
                Label("الفريق: \(team)", systemImage: "person.2")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textSecondary)
            }
        }
    }

    @ViewBuilder
    private func actionsRow(_ n: PortalNotificationsDTO.Item) -> some View {
        HStack(spacing: 16) {
            if !n.isRead {
                Button {
                    Task { await vm.markRead(n, session: session) }
                } label: {
                    Label("ختم القراءة", systemImage: "envelope.open")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
            if !n.isAcked {
                Button {
                    Task { await vm.markAck(n, session: session) }
                } label: {
                    Label("تأكيد الاستلام", systemImage: "checkmark.seal")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.emerald)
                }
            }
            // توافق قديم (بند 11): إشعار سجل يحمل مُعرّف تمركز نصيًا
            if !n.isPositioning && n.message.contains("[تمركز #") {
                Button {
                    noticeSheet = PositioningNotice(title: "تمركز وقت الذروة", message: n.message)
                } label: {
                    Label("عرض تفاصيل التمركز", systemImage: "mappin.and.ellipse")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
    }

    // MARK: تجميع الأيام

    private struct DayGroup: Identifiable {
        let id: String      // مفتاح اليوم yyyy-MM-dd (الرياض) أو "undated"
        let title: String   // اليوم / أمس / اسم اليوم / «سابقة»
        let subtitle: String
        let items: [PortalNotificationsDTO.Item]
    }

    private static func groupByDay(_ items: [PortalNotificationsDTO.Item]) -> [DayGroup] {
        var order: [String] = []
        var buckets: [String: [PortalNotificationsDTO.Item]] = [:]
        for item in items {
            let key = NoticeTime.dayKey(item.createdAt) ?? "undated"
            if buckets[key] == nil { order.append(key); buckets[key] = [] }
            buckets[key]?.append(item)
        }
        return order.map { key in
            DayGroup(id: key,
                     title: NoticeTime.dayTitle(key),
                     subtitle: NoticeTime.daySubtitle(key),
                     items: buckets[key] ?? [])
        }
    }
}

// MARK: - وقت الرياض (أرقام لاتينية دائمًا — توجيه المالك)

/// تنسيقات زمنية مشتركة لشاشة الإشعارات وبطاقة التفاصيل.
/// الأرقام لاتينية عبر en_US_POSIX، والتحويل لتوقيت الرياض صريح.
private enum NoticeTime {
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()
    /// created_at من SQLite (CURRENT_TIMESTAMP) = «yyyy-MM-dd HH:mm:ss» UTC.
    private static let sqliteParser: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()
    private static let hhmmFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "HH:mm"
        return f
    }()
    private static let dayKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let weekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ar_SA") // اسم اليوم عربي — لا أرقام هنا
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "EEEE"
        return f
    }()
    private static let fullFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "HH:mm · yyyy-MM-dd"
        return f
    }()
    private static let riyadhCalendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Riyadh")!
        return c
    }()

    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return isoFrac.date(from: s) ?? isoPlain.date(from: s) ?? sqliteParser.date(from: s)
    }

    /// HH:MM بتوقيت الرياض — يعيد nil عند غياب القيمة (لا وقت مُخترع).
    static func hhmm(_ s: String?) -> String? {
        guard let d = parse(s) else { return nil }
        return hhmmFormatter.string(from: d)
    }

    /// «HH:MM · yyyy-MM-dd» بتوقيت الرياض — لبطاقة التفاصيل.
    static func full(_ s: String?) -> String? {
        guard let d = parse(s) else { return nil }
        return fullFormatter.string(from: d)
    }

    static func dayKey(_ s: String?) -> String? {
        guard let d = parse(s) else { return nil }
        return dayKeyFormatter.string(from: d)
    }

    /// «اليوم»/«أمس»/اسم اليوم — من مفتاح اليوم بتوقيت الرياض.
    static func dayTitle(_ key: String) -> String {
        guard key != "undated", let day = dayKeyFormatter.date(from: key) else { return "سابقة" }
        if riyadhCalendar.isDateInToday(day) { return "اليوم" }
        if riyadhCalendar.isDateInYesterday(day) { return "أمس" }
        return weekdayFormatter.string(from: day)
    }

    /// «الاثنين 2026-09-28» — اسم اليوم عربي + تاريخ بأرقام لاتينية.
    static func daySubtitle(_ key: String) -> String {
        guard key != "undated", let day = dayKeyFormatter.date(from: key) else { return "" }
        return "\(weekdayFormatter.string(from: day)) \(key)"
    }
}

// MARK: - ViewModel (بلا أي تغيير وظيفي — نفس النداءات والسلوك المعتمد)

@MainActor
final class NotificationsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var items: [PortalNotificationsDTO.Item] = []

    private let api = APIClient.shared

    func load(session: SessionStore) async {
        if items.isEmpty { state = .loading }
        do {
            let res: PortalNotificationsDTO = try await api.get("/api/my/notifications")
            items = res.notifications
            session.unreadNotifications = res.unreadCount ?? 0
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: !items.isEmpty, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: !items.isEmpty, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    func markRead(_ n: PortalNotificationsDTO.Item, session: SessionStore) async {
        do {
            if n.isPersonal {
                // تدشين «التمركز»: ختم قراءة الإشعار الشخصي عبر مفتاح المصدر
                // الإضافي — الخادم يتحقق أن الإشعار لصاحب الحساب حصرًا.
                let _: MarkStatusResponse = try await api.post("/api/my/notifications/\(n.id)/read", query: ["source": "personal"])
            } else {
                let _: MarkStatusResponse = try await api.post("/api/my/notifications/\(n.id)/read", body: Optional<String>.none)
            }
            await load(session: session)
        } catch { /* تبقى الحالة — إعادة المحاولة متاحة */ }
    }

    func markAck(_ n: PortalNotificationsDTO.Item, session: SessionStore) async {
        do {
            let _: MarkStatusResponse = try await api.post("/api/my/notifications/\(n.id)/ack", body: Optional<String>.none)
            await load(session: session)
        } catch { /* نفس الاعتبار */ }
    }
}

// MARK: - بند 11 (اعتماد المالك 2026-09-20): بطاقة تفاصيل تمركز وقت الذروة

/// حمولة البطاقة — من Push (DeepLinkRouter) أو من إشعار داخلي في القائمة.
/// data اختيارية إضافية (تدشين «التمركز» 2026-09-28): تُمرَّر من القائمة حيث
/// تتوفر الحمولة المهيكلة، وتبقى nil في مسار الـPush فيُستخدم تفسير السطور.
struct PositioningNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    var data: PortalNotificationsDTO.Item.PositioningData? = nil
}

/// بطاقة «تفاصيل التمركز»: مع الحمولة المهيكلة تعرض صفوفًا منظمة من الحقول
/// الفعلية (الحالة/الفرقة/المركز/الموقع/البداية/النهاية/الأولوية)، وبلاها
/// تفسّر سطور الرسالة كما كانت. عرض فقط — بلا منطق وبلا API جديد.
struct PositioningNoticeView: View {
    @Environment(\.dismiss) private var dismiss
    let notice: PositioningNotice

    private struct Row: Identifiable {
        let id = UUID()
        let label: String   // فارغ = سطر حر (الجملة الافتتاحية)
        let value: String
    }

    /// تسمية الحالة من kind الفعلي (created/updated/ended — قيم الخادم حرفيًا).
    private static func kindLabel(_ kind: String?) -> String? {
        switch kind {
        case "created": return "مهمة جديدة"
        case "updated": return "محدَّثة"
        case "ended": return "ملغاة"
        default: return nil
        }
    }

    private var rows: [Row] {
        if let d = notice.data {
            // الحقول المهيكلة أولًا — الحقل الغائب لا يظهر ولا يُخترع
            var out: [Row] = []
            if let k = Self.kindLabel(d.kind) { out.append(Row(label: "الحالة", value: k)) }
            if let t = d.team, !t.isEmpty { out.append(Row(label: "الفرقة", value: t)) }
            if let c = d.center, !c.isEmpty { out.append(Row(label: "المركز", value: c)) }
            if let l = d.location, !l.isEmpty, l != d.center { out.append(Row(label: "الموقع", value: l)) }
            if let s = NoticeTime.full(d.start_time) { out.append(Row(label: "البداية", value: s)) }
            if let e = NoticeTime.full(d.end_time) { out.append(Row(label: "النهاية", value: e)) }
            if let p = d.priority, !p.isEmpty { out.append(Row(label: "الأولوية", value: p)) }
            // الجملة الافتتاحية من الرسالة (أول سطر حر) تُعرض نصًا حرًا
            if let lead = notice.message.components(separatedBy: "\n")
                .map({ $0.trimmingCharacters(in: .whitespaces) })
                .first(where: { !$0.isEmpty && !($0.hasPrefix("[") && $0.hasSuffix("]")) && !$0.contains(":") }) {
                out.insert(Row(label: "", value: lead), at: 0)
            }
            return out
        }
        // مسار الـPush (بلا حمولة): تفسير سطور الرسالة الموسومة كما كان معتمدًا
        return notice.message.components(separatedBy: "\n").compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { return nil }
            if line.hasPrefix("["), line.hasSuffix("]") { return nil } // مُعرّف داخلي
            if let sep = line.firstIndex(of: ":") {
                let label = String(line[..<sep]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: sep)...]).trimmingCharacters(in: .whitespaces)
                if !label.isEmpty, !value.isEmpty, label.count <= 12 {
                    return Row(label: label, value: value)
                }
            }
            return Row(label: "", value: line)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                EMSCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Image(systemName: "mappin.and.ellipse")
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(notice.title)
                                .font(.headline.weight(.bold))
                                .foregroundStyle(EMSTheme.Colors.textPrimary)
                            if NoticeFilter.isUrgent(notice) {
                                Text("مهم")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(EMSTheme.Colors.danger)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 2)
                                    .background(EMSTheme.Colors.danger.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                        }
                        .padding(.bottom, 4)
                        ForEach(rows) { row in
                            if row.label.isEmpty {
                                Text(row.value)
                                    .font(.subheadline)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            } else {
                                EMSInfoRow(label: row.label, value: row.value)
                            }
                        }
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .emsPage(notice.title)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { dismiss() }.tint(EMSTheme.Colors.teal)
                }
            }
        }
    }
}

/// فحص «مهم» لحمولة البطاقة (تعمل من القائمة ومن مسار الـPush بلا حمولة).
private extension NoticeFilter {
    static func isUrgent(_ notice: PositioningNotice) -> Bool {
        guard let p = notice.data?.priority else { return false }
        return urgentPriorities.contains(p) || urgentPriorities.contains(p.lowercased())
    }
}
