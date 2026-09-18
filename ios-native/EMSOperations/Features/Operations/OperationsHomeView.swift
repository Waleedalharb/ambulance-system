//
//  OperationsHomeView.swift
//  EMSOperations
//
//  وحدة العمليات (تفعيل المنصة الأصلية — docs/native-platform-activation.md):
//  الفرق، الجاهزية، المركبات، الأحداث، مركز القرار، الخريطة — كلها شاشات
//  بيانات حقيقية مربوطة بمسارات قراءة قائمة في الـBackend (عرض فقط).
//

import SwiftUI

struct OperationsHomeView: View {
    private enum OpsModule: Hashable, Identifiable {
        case teams, readiness, completion, vehicles, events, decisionCenter, map, positioning, dispatch, forms, workflow
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
            }
        }
        var icon: String {
            switch self {
            case .teams: return "person.3.fill"
            case .readiness: return "checklist.checked"
            case .completion: return "person.crop.circle.badge.checkmark"
            case .vehicles: return "truck.box.fill"
            case .events: return "bolt.fill"
            case .decisionCenter: return "scope"
            case .map: return "map.fill"
            case .positioning: return "mappin.and.ellipse"
            case .dispatch: return "megaphone.fill"
            case .forms: return "doc.text.fill"
            case .workflow: return "checkmark.doc.fill"
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
            }
        }
    }

    private let modules: [OpsModule] = [.dispatch, .teams, .readiness, .completion, .vehicles, .events, .decisionCenter, .map, .positioning, .forms, .workflow]

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                EMSCard {
                    HStack(spacing: 12) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.title2)
                            .foregroundStyle(EMSTheme.Colors.teal)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("غرفة العمليات")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(.white)
                            Text("بيانات حية من المنظومة — عرض فقط حسب صلاحياتك")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                    }
                }

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
        .emsPage("العمليات")
        .onAppear {
            #if DEBUG
            // علامة النسخة الحية: وجود هذا السطر في السجل يثبت أن البناء يحتوي
            // شاشات البيانات الحقيقية (ee41e8c+) — نسخة «قيد التفعيل» لا تملكه.
            AppLogger.ui.info("OperationsHomeView LIVE-DATA build appeared — 11 modules wired to Backend APIs")
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
            }
        }
    }
}
