//
//  OperationsHomeView.swift
//  EMSOperations
//
//  وحدة العمليات — الأساس المعماري (v2 قسم 20/21/22/23).
//  Navigation جاهز لـ: الفرق، الجاهزية، المركبات، الأحداث، مركز القرار، الخريطة.
//  لا بيانات مخترعة: كل شاشة تعرض حالة «قيد التفعيل» حتى يوفر الـBackend
//  مسار القراءة المعتمد، وتُربط حينها دون تغيير الـNavigation.
//

import SwiftUI

struct OperationsHomeView: View {
    private enum OpsModule: Hashable, Identifiable {
        case teams, readiness, vehicles, events, decisionCenter, map
        var id: Self { self }

        var title: String {
            switch self {
            case .teams: return "الفرق"
            case .readiness: return "الجاهزية"
            case .vehicles: return "المركبات"
            case .events: return "الأحداث التشغيلية"
            case .decisionCenter: return "مركز القرار"
            case .map: return "الخريطة"
            }
        }
        var icon: String {
            switch self {
            case .teams: return "person.3.fill"
            case .readiness: return "checklist.checked"
            case .vehicles: return "truck.box.fill"
            case .events: return "bolt.fill"
            case .decisionCenter: return "scope"
            case .map: return "map.fill"
            }
        }
        var detail: String {
            switch self {
            case .teams: return "الفرقة ← المركز ← المركبة ← الجاهزية ← المناوبة"
            case .readiness: return "استعداد الفرق والتكميلات الحالية"
            case .vehicles: return "متاحة · مُسندة · خارج الخدمة · الأحداث الميكانيكية"
            case .events: return "الأحداث التشغيلية المهمة أولًا بأول"
            case .decisionCenter: return "ما الذي يحدث؟ وما الإجراء المتاح؟ — حسب صلاحياتك"
            case .map: return "المراكز والفرق والمركبات على الخريطة"
            }
        }
    }

    private let modules: [OpsModule] = [.teams, .readiness, .vehicles, .events, .decisionCenter, .map]

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
                            Text("البنية جاهزة — تُفعَّل الشاشات تباعًا مع مسارات الـBackend المعتمدة")
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
        .navigationDestination(for: OpsModule.self) { module in
            OperationsModulePlaceholder(title: module.title, icon: module.icon, detail: module.detail)
        }
    }
}

/// شاشة أساس موحدة لوحدات العمليات — تُستبدل بشاشة البيانات عند توفر مسار الـBackend.
private struct OperationsModulePlaceholder: View {
    let title: String
    let icon: String
    let detail: String

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                EMSEmptyView(
                    icon: icon,
                    title: "\(title) — قيد التفعيل",
                    detail: "\(detail). ستُربط هذه الشاشة بمسار الـBackend المعتمد دون أي تغيير في التنقل.")
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage(title)
    }
}
