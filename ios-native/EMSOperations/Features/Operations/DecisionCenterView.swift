//
//  DecisionCenterView.swift
//  EMSOperations
//
//  مركز القرار (تفعيل المنصة الأصلية): تقييم المشغل الذكي من
//  GET /api/smart-operator/assessment ← decision-engine (المصدر الوحيد
//  للتقييم والتوصيات — لا توصية ولا مخاطر مخترعة في العميل)، مع سياق
//  المناوبة من GET /api/current-shift. عرض فقط.
//

import SwiftUI

struct DecisionCenterView: View {
    @StateObject private var vm = DecisionCenterViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 3)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    content
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("مركز القرار")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let assessment = vm.assessment {
            summaryCard(assessment)
            risksSection(assessment)
            recommendationsSection(assessment)
            proactiveSection(assessment)
        } else {
            EMSEmptyView(
                icon: "scope",
                title: "لا يوجد تقييم حاليًا",
                detail: "يُولَّد التقييم التشغيلي من المنظومة عند توفر بيانات المناوبة")
        }
    }

    // MARK: - الملخص التنفيذي (جملة الخادم كما هي)

    private func summaryCard(_ a: SmartAssessmentDTO.Assessment) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    EMSectionHeader(title: "التقييم التشغيلي", systemImage: "scope")
                    Spacer()
                    if let status = a.readiness?.status {
                        EMSStatusPill(text: vm.readinessLabel(status), tone: vm.readinessTone(status))
                    }
                }
                if let summary = a.summary {
                    Text(summary)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Divider().overlay(EMSTheme.Colors.divider)
                if let percent = a.readiness?.percent {
                    EMSInfoRow(label: "الجاهزية", value: "\(percent)٪")
                }
                if let shift = a.shift, shift.id != nil {
                    EMSInfoRow(label: "المناوبة", value: [shift.type, shift.date].compactMap { $0 }.joined(separator: " · "))
                } else if let prep = vm.currentShift?.prepShift {
                    EMSInfoRow(label: "القادمة", value: [prep.type, prep.date].compactMap { $0 }.joined(separator: " · "))
                }
                if (a.supportCount ?? 0) > 0 {
                    EMSInfoRow(label: "الداعمون المتاحون", value: "\(a.supportCount ?? 0)")
                }
                if let at = a.generatedAt {
                    Text("وُلِّد: \(at)")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    // MARK: - المخاطر (من المحرك — مرتبة كما وصلت)

    @ViewBuilder
    private func risksSection(_ a: SmartAssessmentDTO.Assessment) -> some View {
        let risks = a.risks ?? []
        if !risks.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "المخاطر القائمة")
                ForEach(risks) { risk in
                    EMSCard {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.subheadline)
                                .foregroundStyle(vm.severityTone(risk.severity).color)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(risk.title ?? "خطر")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.white)
                                    Spacer()
                                    EMSStatusPill(text: vm.severityLabel(risk.severity), tone: vm.severityTone(risk.severity))
                                }
                                if let detail = risk.detail, !detail.isEmpty {
                                    Text(detail)
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                if let team = risk.team {
                                    Text(team)
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - التوصيات (من المحرك — مرتبة بأولويته)

    @ViewBuilder
    private func recommendationsSection(_ a: SmartAssessmentDTO.Assessment) -> some View {
        let recs = a.recommendations ?? []
        if !recs.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "الإجراءات المقترحة")
                ForEach(recs) { rec in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(rec.title ?? "إجراء")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                            if let action = rec.action, !action.isEmpty {
                                Text(action)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - تنبيهات استباقية

    @ViewBuilder
    private func proactiveSection(_ a: SmartAssessmentDTO.Assessment) -> some View {
        let items = a.proactive ?? []
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "متابعات استباقية")
                ForEach(items) { item in
                    EMSCard {
                        HStack(spacing: 10) {
                            Image(systemName: "eye.fill")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.teal)
                            Text(item.text ?? "—")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class DecisionCenterViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var assessment: SmartAssessmentDTO.Assessment?
    @Published var currentShift: CurrentShiftDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            async let assessmentReq: SmartAssessmentDTO = api.get("/api/smart-operator/assessment")
            async let shiftReq: CurrentShiftDTO = api.get("/api/current-shift")
            let (a, s) = try await (assessmentReq, shiftReq)
            assessment = a.data
            currentShift = s
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    // MARK: - عرض التسميات (القيم سيرفرية — التسمية عرضية فقط)

    func readinessLabel(_ status: String) -> String {
        switch status {
        case "stable": return "مستقرة"
        case "attention": return "تحتاج متابعة"
        case "critical": return "حرجة"
        default: return status
        }
    }

    func readinessTone(_ status: String) -> EMSTheme.StatusTone {
        switch status {
        case "stable": return .normal
        case "attention": return .monitor
        case "critical": return .danger
        default: return .neutral
        }
    }

    func severityLabel(_ severity: String?) -> String {
        switch severity {
        case "critical": return "حرج"
        case "warning": return "تحذير"
        case "info": return "معلومة"
        default: return "—"
        }
    }

    func severityTone(_ severity: String?) -> EMSTheme.StatusTone {
        switch severity {
        case "critical": return .danger
        case "warning": return .monitor
        default: return .neutral
        }
    }
}
