//
//  OperationsHomeView.swift
//  EMSOperations
//
//  وحدة العمليات بالمرجع البصري المعتمد (بروتوكول التطابق البكسلي 2026-09-28):
//  ترويسة «العمليات» + آخر تحديث ← بطاقة الوضع التشغيلي (نبض الخادم:
//  vehicles/board + staffing/state) ← خريطة توزيع الفرق (OpsMapViewModel
//  القائم: ops/centers + staffing/state + cad-reports) ← آخر الأحداث
//  (/api/timeline) ← إجراءات سريعة ← شبكة جميع العمليات (12 وحدة) +
//  «عرض الكل» يفتح قائمة الوحدات الـ18 (قرار المالك 2026-09-28).
//  تسمية «التمركز والذروة» تُبقى كما في النظام (قرار المالك — المرجع كتبها «الندوة»).
//  كل البيانات سيرفرية — لا أرقام ثابتة. عرض فقط: لا تغيير في أي ربط أو منطق.
//

import SwiftUI
import MapKit

struct OperationsHomeView: View {
    enum OpsModule: Hashable, Identifiable {
        case teams, readiness, completion, vehicles, events, decisionCenter, map, positioning, dispatch, forms, workflow, archive, lifecycle, assets, hospitals, indicators, signouts, files
        case allModules
        var id: Self { self }

        var title: String {
            switch self {
            case .teams: return "الفرق"
            case .readiness: return "الجاهزية"
            case .completion: return "التكميل"
            case .vehicles: return "المركبات"
            case .events: return "الأحداث التشغيلية"
            case .decisionCenter: return "مركز القرار"
            case .map: return "الخريطة"
            case .positioning: return "التمركز والذروة"
            case .dispatch: return "البلاغات والتوزيع"
            case .forms: return "النماذج التشغيلية"
            case .workflow: return "سير العمل"
            case .archive: return "الأرشيف"
            case .lifecycle: return "دورة المناوبة"
            case .assets: return "العهد والأصول"
            case .hospitals: return "المستشفيات"
            case .indicators: return "المؤشرات"
            case .signouts: return "خروج الفرق"
            case .files: return "الملفات"
            case .allModules: return "جميع العمليات"
            }
        }
        var icon: String {
            switch self {
            case .teams: return "person.3.fill"
            case .readiness: return "checkmark.shield.fill"
            case .completion: return "person.crop.circle.badge.checkmark"
            case .vehicles: return "truck.box.fill"
            case .events: return "bolt.fill"
            case .decisionCenter: return "scope"
            case .map: return "map.fill"
            case .positioning: return "mappin.circle.fill"
            case .dispatch: return "cross.case.fill"
            case .forms: return "doc.text.fill"
            case .workflow: return "gearshape.fill"
            case .archive: return "archivebox.fill"
            case .lifecycle: return "clock.arrow.circlepath"
            case .assets: return "cube.fill"
            case .hospitals: return "building.2.fill"
            case .indicators: return "chart.bar.fill"
            case .signouts: return "rectangle.portrait.and.arrow.right"
            case .files: return "folder.fill"
            case .allModules: return "square.grid.2x2.fill"
            }
        }
        var detail: String {
            switch self {
            case .teams: return "الفرقة ← المركز ← المركبة ← الجاهزية ← المناوبة"
            case .readiness: return "استعداد الفرق والتكميلات الحالية"
            case .completion: return "قرارات الفرق · أحداث الأشخاص · الدعم والتطوع · السجلات"
            case .vehicles: return "متاحة · مُسندة · خارج الخدمة · الأحداث الميكانيكية"
            case .events: return "الأحداث التشغيلية المهمة أولًا بأول"
            case .decisionCenter: return "ما الذي يحدث؟ وما الإجراء المتاح؟ — حسب صلاحياتك"
            case .map: return "المراكز والفرق والمركبات على الخريطة"
            case .positioning: return "مواقع الوحدات · خطط الذروة · المهام والتنبيهات"
            case .dispatch: return "توزيع وتراجع · طواقم CAD · بلاغات تفصيلية"
            case .forms: return "حوادث · تصعيدات · حالات إلكترونية · تقارير يومية · مناوبات كبار"
            case .workflow: return "إعداد · تحرير · اعتماد · إعادة إصدار · PDF"
            case .archive: return "المناوبات المؤرشفة · التحقق من السلامة · السجل"
            case .lifecycle: return "بدء · إنهاء · اعتماد التسليم · طوارئ"
            case .assets: return "سجل الأصول · دورات الجرد · الفروقات · نقل العهدة"
            case .hospitals: return "مراقبة النقل والبقاء · التنبيهات · السجل"
            case .indicators: return "لوحة التشغيل · مؤشر المساهمة الشهري · نشاط الفرق"
            case .signouts: return "اقتراح التشكيلة · تسجيل الخروج · سجل المناوبة"
            case .files: return "الملفات التشغيلية · المستندات · تنزيل وحذف"
            case .allModules: return ""
            }
        }
    }

    /// كل الوحدات الـ18 — تظهر في قائمة «عرض الكل» فقط (قرار المالك).
    private static let allModules: [OpsModule] = [.lifecycle, .dispatch, .teams, .readiness, .completion, .vehicles, .events, .decisionCenter, .map, .positioning, .forms, .workflow, .archive, .assets, .hospitals, .indicators, .signouts, .files]

    /// شبكة المرجع الـ12 — بالترتيب المنطقي RTL (أول عنصر يُرسم يمينًا):
    /// صف1: الأحداث/المركبات/التكميل/الجاهزية · صف2: الأرشيف/سير العمل/النماذج/التمركز · صف3: مركز القرار/المؤشرات/المستشفيات/العهد
    private static let gridModules: [OpsModule] = [.events, .vehicles, .completion, .readiness, .archive, .workflow, .forms, .positioning, .decisionCenter, .indicators, .hospitals, .assets]

    @StateObject private var vm = OpsHomeViewModel()
    @StateObject private var eventsVM = OpsEventsViewModel()
    @StateObject private var mapVM = OpsMapViewModel()

    private let pagePad: CGFloat = 18
    private let cardGap: CGFloat = 9
    private let refBlue = Color(red: 0.36, green: 0.62, blue: 0.98)
    private let refPurple = Color(red: 0.67, green: 0.45, blue: 0.95)
    private let refSlate = Color(red: 0.60, green: 0.66, blue: 0.78)
    private let refBrown = Color(red: 0.85, green: 0.60, blue: 0.30)

    var body: some View {
        ScrollView {
            VStack(spacing: cardGap) {
                operationalStatusCard
                mapCard
                latestEventsCard
                quickActionsSection
                allOpsSection
            }
            .padding(.horizontal, pagePad)
            .padding(.top, 6)
        }
        .refreshable { await reloadAll() }
        .emsPage("العمليات")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // آخر تحديث + زر التحديث — يمين الترويسة (navigationBarLeading في RTL)
            ToolbarItem(placement: .navigationBarLeading) {
                HStack(spacing: 6) {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text("آخر تحديث")
                            .font(.system(size: 8))
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        Text(lastUpdatedLabel)
                            .font(.system(size: 11, weight: .bold).monospacedDigit())
                            .foregroundStyle(.white)
                    }
                    Button { Task { await reloadAll() } } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(EMSTheme.Colors.teal)
                            .frame(width: 26, height: 26)
                            .background(EMSTheme.Colors.navySoft)
                            .clipShape(Circle())
                    }
                    .accessibilityLabel("تحديث")
                }
            }
        }
        .onAppear {
            #if DEBUG
            AppLogger.ui.info("OperationsHomeView LIVE-DATA build appeared — 18 modules wired to Backend APIs")
            #endif
        }
        .navigationDestination(for: OpsModule.self) { module in
            switch module {
            case .teams: OpsTeamsView()
            case .readiness: OpsReadinessView()
            case .completion: CompletionOpsView()
            case .vehicles: OpsVehiclesView()
            case .events: OpsEventsView()
            case .decisionCenter: DecisionCenterView()
            case .map: OpsMapView()
            case .positioning: PositioningOpsView()
            case .dispatch: DispatchOpsView()
            case .forms: FormsOpsView()
            case .workflow: WorkflowOpsView()
            case .archive: ArchiveOpsView()
            case .lifecycle: ShiftLifecycleView()
            case .assets: AssetsHomeView()
            case .hospitals: HospitalsOpsView()
            case .indicators: IndicatorsOpsView()
            case .signouts: SignoutsOpsView()
            case .files: FilesOpsView()
            case .allModules: AllOpsModulesView(modules: Self.allModules)
            }
        }
        .task {
            await vm.load()
            await eventsVM.load()
            await mapVM.load()
        }
    }

    private func reloadAll() async {
        await vm.load(force: true)
        await eventsVM.load()
        await mapVM.reload()
    }

    private var lastUpdatedLabel: String {
        guard let d = vm.lastUpdated else { return "—" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    // MARK: - بطاقة الوضع التشغيلي (عداد يسار / عنوان وسط / مستقر يمين)

    @ViewBuilder
    private var operationalStatusCard: some View {
        if let pulse = vm.pulse {
            VStack(spacing: 8) {
                HStack(alignment: .center, spacing: 12) {
                    // المرجع: شارة «مستقر» أقصى اليمين (leading في RTL)
                    stablePill(pulse)
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(EMSTheme.Colors.emerald)
                                .frame(width: 9, height: 9)
                            Text("الوضع التشغيلي الآن")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        Text(pulseSubtitle(pulse))
                            .font(.system(size: 10))
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    readinessGauge(pulse.readinessRate)
                }
                // بلاطات المرجع: محتوى مُوسّط — أيقونة/رقم/تسمية (يمين→يسار: مركبات/فرق/متابعة/خارج)
                HStack(spacing: 10) {
                    opsTile(value: pulse.activeVehicles, total: vehiclesTotal(pulse),
                            label: "المركبات الجاهزة", icon: "cross.case.fill", color: EMSTheme.Colors.emerald)
                    opsTile(value: pulse.readyTeams, total: pulse.requiredTeams,
                            label: "الفرق العاملة", icon: "person.3.fill", color: refBlue)
                    opsTile(value: pulse.breakdownVehicles, total: nil,
                            label: "تحتاج متابعة", icon: "exclamationmark.triangle.fill", color: EMSTheme.Colors.warning)
                    opsTile(value: pulse.outOfServiceVehicles, total: nil,
                            label: "خارج الخدمة", icon: "wrench.fill", color: EMSTheme.Colors.danger)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 7)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
        }
    }

    /// شارة الحالة — مشتقة من عدّادات الخادم (صفر مشاكل = مستقر) وتفتح الجاهزية.
    private func stablePill(_ pulse: OpsHomeViewModel.Pulse) -> some View {
        let issues = (pulse.outOfServiceVehicles ?? 0) + (pulse.breakdownVehicles ?? 0)
        let stable = issues == 0
        return NavigationLink(value: OpsModule.readiness) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .bold))
                Text(stable ? "مستقر" : "يحتاج متابعة")
                    .font(.system(size: 12, weight: .semibold))
                Image(systemName: "waveform.path.ecg")
                    .font(.system(size: 11))
            }
            .foregroundStyle(stable ? EMSTheme.Colors.teal : EMSTheme.Colors.warning)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background((stable ? EMSTheme.Colors.teal : EMSTheme.Colors.warning).opacity(0.15))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func pulseSubtitle(_ pulse: OpsHomeViewModel.Pulse) -> String {
        let issues = (pulse.outOfServiceVehicles ?? 0) + (pulse.breakdownVehicles ?? 0)
        return issues == 0 ? "جميع الأنظمة تعمل بشكل طبيعي" : "يوجد \(issues) ما يحتاج متابعة"
    }

    private func vehiclesTotal(_ pulse: OpsHomeViewModel.Pulse) -> Int? {
        guard let a = pulse.activeVehicles else { return nil }
        return a + (pulse.breakdownVehicles ?? 0) + (pulse.outOfServiceVehicles ?? 0)
    }

    private func readinessGauge(_ rate: Int?) -> some View {
        ZStack {
            Circle()
                .stroke(EMSTheme.Colors.navySoft, lineWidth: 6.5)
            if let rate {
                Circle()
                    .trim(from: 0, to: CGFloat(max(0, min(100, rate))) / 100)
                    .stroke(EMSTheme.Colors.teal, style: StrokeStyle(lineWidth: 6.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 0) {
                Text(verbatim: rate.map { "\($0)%" } ?? "—")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                Text("الجاهزية")
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .frame(width: 70, height: 70)
        .accessibilityElement(children: .combine)
    }

    private func opsTile(value: Int?, total: Int?, label: String, icon: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(color)
            Text(value.map(String.init) ?? "—")
                .font(.system(size: 19, weight: .bold))
                .foregroundStyle(.white)
            Text(label)
                .font(.system(size: 9.5))
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let total {
                Text("من \(total)")
                    .font(.system(size: 8.5))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 76)
        .background(color.opacity(0.13))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    // MARK: - خريطة توزيع الفرق (OpsMapViewModel القائم — عرض مصغّر قراءة فقط)

    private var mapCard: some View {
        VStack(spacing: 8) {
            HStack {
                Image(systemName: "mappin.circle.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text("توزيع الفرق على الخريطة")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                Spacer()
                NavigationLink(value: OpsModule.map) {
                    HStack(spacing: 4) {
                        Image(systemName: "map.fill")
                            .font(.system(size: 10))
                        Text("عرض الخريطة")
                            .font(.system(size: 11, weight: .semibold))
                        Image(systemName: "chevron.left")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .foregroundStyle(EMSTheme.Colors.teal)
                }
                .buttonStyle(.plain)
            }

            Group {
                if mapVM.pins.isEmpty {
                    // حالة صادقة: لا إحداثيات/فشل — بلا خريطة مختلقة
                    HStack(spacing: 8) {
                        Image(systemName: "map")
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        Text(mapVM.state == .loading ? "جاري تحميل الخريطة…" : "لا تتوفر إحداثيات مراكز حاليًا")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 118)
                    .background(EMSTheme.Colors.navySoft.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    Map(coordinateRegion: .constant(mapVM.region),
                        interactionModes: [],
                        annotationItems: mapVM.pins) { pin in
                        MapAnnotation(coordinate: pin.coordinate) {
                            VStack(spacing: 1) {
                                Image(systemName: pin.kind == .center ? "cross.case.fill" : "truck.pickup.side.fill")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.white)
                                    .padding(5)
                                    .background(miniPinColor(pin.severity))
                                    .clipShape(Circle())
                                Text(pin.name)
                                    .font(.system(size: 8, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(EMSTheme.Colors.navy.opacity(0.85))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    .frame(height: 118)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(EMSTheme.Colors.divider, lineWidth: 1))
                    // الخريطة المصغرة قراءة فقط — الانتقال عبر زر «عرض الخريطة»
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
    }

    private func miniPinColor(_ severity: OpsMapSeverity) -> Color {
        switch severity {
        case .green: return EMSTheme.Colors.emerald
        case .yellow: return EMSTheme.Colors.warning
        case .red: return EMSTheme.Colors.danger
        case .none: return EMSTheme.Colors.teal
        }
    }

    // MARK: - آخر الأحداث (/api/timeline — أحدث 3)

    @ViewBuilder
    private var latestEventsCard: some View {
        let items = Array((eventsVM.data?.data ?? []).prefix(3))
        if !items.isEmpty {
            VStack(spacing: 10) {
                HStack {
                    Image(systemName: "list.bullet")
                        .font(.system(size: 12))
                        .foregroundStyle(EMSTheme.Colors.teal)
                    Text("آخر الأحداث")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                    Spacer()
                    NavigationLink(value: OpsModule.events) {
                        HStack(spacing: 4) {
                            Text("عرض الكل")
                                .font(.system(size: 11, weight: .semibold))
                            Image(systemName: "chevron.left")
                                .font(.system(size: 9, weight: .bold))
                        }
                        .foregroundStyle(EMSTheme.Colors.teal)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(eventsVM.tone(for: item.type).color)
                            .frame(width: 7, height: 7)
                            .padding(.top, 5)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title ?? "حدث")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            if let desc = item.desc, !desc.isEmpty {
                                Text(desc)
                                    .font(.system(size: 10))
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                    .lineLimit(1)
                            }
                            Text(relativeTimeLabel(date: item.date, time: item.time))
                                .font(.system(size: 9))
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(EMSTheme.Colors.card)
            .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
        }
    }

    /// «منذ X دقيقة» من تاريخ/وقت الخادم بتوقيت الرياض — عند تعذّر التحليل
    /// يُعرض وقت الخادم كما هو (لا قيمة مختلقة).
    private func relativeTimeLabel(date: String?, time: String?) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        let df = DateFormatter()
        df.calendar = cal
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = cal.timeZone
        df.dateFormat = "yyyy-MM-dd HH:mm"
        let raw = "\(date ?? "") \(time ?? "")".trimmingCharacters(in: .whitespaces)
        guard let then = df.date(from: raw) else {
            return [date, time].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
        let mins = max(0, Int(Date().timeIntervalSince(then)) / 60)
        if mins < 60 { return mins <= 1 ? "منذ دقيقة" : "منذ \(mins) دقيقة" }
        let hours = mins / 60
        if hours < 24 { return hours == 1 ? "منذ ساعة" : "منذ \(hours) ساعة" }
        let days = hours / 24
        return days == 1 ? "منذ يوم" : "منذ \(days) أيام"
    }

    // MARK: - إجراءات سريعة (يمين→يسار: دورة المناوبة/الفرق/البلاغات والتوزيع/الخريطة)

    private var quickActionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text("إجراءات سريعة")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
            }
            HStack(spacing: 10) {
                quickTile(.lifecycle, color: EMSTheme.Colors.warning)
                quickTile(.teams, color: refBlue)
                quickTile(.dispatch, color: EMSTheme.Colors.danger)
                quickTile(.map, color: EMSTheme.Colors.teal)
            }
        }
    }

    private func quickTile(_ module: OpsModule, color: Color) -> some View {
        NavigationLink(value: module) {
            ZStack {
                VStack(spacing: 3) {
                    Image(systemName: module.icon)
                        .font(.system(size: 15))
                        .foregroundStyle(color)
                    Text(module.title)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity)
                HStack {
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .padding(.trailing, 8)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(color.opacity(0.13))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - جميع العمليات (شبكة الـ12 + عرض الكل)

    private var allOpsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "square.grid.2x2.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(EMSTheme.Colors.teal)
                Text("جميع العمليات")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
                Spacer()
                NavigationLink(value: OpsModule.allModules) {
                    HStack(spacing: 4) {
                        Text("عرض الكل")
                            .font(.system(size: 11, weight: .semibold))
                        Image(systemName: "chevron.left")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .foregroundStyle(EMSTheme.Colors.teal)
                }
                .buttonStyle(.plain)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 4), spacing: 10) {
                ForEach(Self.gridModules) { module in
                    gridTile(module)
                }
            }
        }
    }

    private func gridTile(_ module: OpsModule) -> some View {
        NavigationLink(value: module) {
            ZStack {
                VStack(spacing: 2) {
                    Image(systemName: module.icon)
                        .font(.system(size: 14))
                        .foregroundStyle(gridColor(module))
                    Text(module.title)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }
                .frame(maxWidth: .infinity)
                HStack {
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .padding(.trailing, 6)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(EMSTheme.Colors.navySoft.opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    /// ألوان أيقونات الشبكة حسب المرجع — دلالة عرضية فقط.
    private func gridColor(_ module: OpsModule) -> Color {
        switch module {
        case .events: return EMSTheme.Colors.warning
        case .vehicles: return refSlate
        case .completion: return refPurple
        case .readiness: return EMSTheme.Colors.emerald
        case .archive: return refBrown
        case .workflow: return refSlate
        case .forms: return refBlue
        case .positioning: return refPurple
        case .decisionCenter: return EMSTheme.Colors.teal
        case .indicators: return EMSTheme.Colors.emerald
        case .hospitals: return refBlue
        case .assets: return refBlue
        default: return EMSTheme.Colors.teal
        }
    }
}

// MARK: - قائمة «عرض الكل» — الوحدات الـ18 بتصميم القائمة القائم (خارج نطاق المرجع)

private struct AllOpsModulesView: View {
    let modules: [OperationsHomeView.OpsModule]

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                ForEach(modules) { module in
                    NavigationLink(value: module) {
                        EMSCard {
                            HStack(spacing: 12) {
                                Image(systemName: module.icon)
                                    .font(.title3)
                                    .foregroundStyle(EMSTheme.Colors.teal)
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(module.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.white)
                                    Text(module.detail)
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                        .lineLimit(2)
                                }
                                Spacer()
                                Image(systemName: "chevron.left")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("جميع العمليات")
    }
}

// MARK: - ViewModel نبض شاشة العمليات (قراءة فقط — نفس مساري الرئيسية)

@MainActor
final class OpsHomeViewModel: ObservableObject {
    /// لقطة عدّادات النبض — قيم سيرفرية خام، بلا أي حساب في العميل.
    struct Pulse: Equatable {
        let activeVehicles: Int?
        let breakdownVehicles: Int?
        let outOfServiceVehicles: Int?
        let readyTeams: Int?
        let requiredTeams: Int?
        let readinessRate: Int?
    }

    @Published var pulse: Pulse?
    @Published var lastUpdated: Date?

    private let api = APIClient.shared

    func load(force: Bool = false) async {
        if pulse != nil && !force { return }
        do {
            async let boardReq: VehiclesBoardDTO = api.get("/api/vehicles/board")
            async let staffReq: StaffingStateDTO = api.get("/api/staffing/state")
            let (b, s) = try await (boardReq, staffReq)
            pulse = Pulse(
                activeVehicles: b.counters?.active,
                breakdownVehicles: b.counters?.breakdown,
                outOfServiceVehicles: b.counters?.outOfService,
                readyTeams: s.workforce?.readyTeams,
                requiredTeams: s.workforce?.requiredTeams,
                readinessRate: s.workforce?.operationalReadinessRate ?? s.workforce?.readinessRate)
            lastUpdated = Date()
        } catch {
            // فشل النبض لا يكسر الشاشة — تبقى البطاقة مخفية بصدق حتى نجاح التحميل
        }
    }
}
