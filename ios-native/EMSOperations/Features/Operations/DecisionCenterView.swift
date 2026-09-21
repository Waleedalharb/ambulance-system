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
            askSection
            memorySection
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

    // MARK: - اسأل المشغل الذكي (§18 — إجابة حتمية سيرفرية، لا LLM في العميل)

    private var askSection: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "اسأل المشغل الذكي", systemImage: "bubble.left.and.bubble.right.fill")
                // اقتراحات = عائلات الأسئلة المدعومة سيرفريًا (smart-ask-service FAMILIES)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(vm.suggestedQuestions, id: \.self) { q in
                            Button(q) { vm.question = q }
                                .font(.caption2)
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(EMSTheme.Colors.navySoft)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                                .clipShape(Capsule())
                        }
                    }
                }
                HStack(spacing: 8) {
                    TextField("اكتب سؤالًا تشغيليًا…", text: $vm.question)
                        .textFieldStyle(.roundedBorder)
                        .font(.subheadline)
                    Button {
                        Task { await vm.ask() }
                    } label: {
                        if vm.asking { ProgressView().tint(.white) }
                        else { Image(systemName: "paperplane.fill") }
                    }
                    .frame(width: 44, height: 36)
                    .background(EMSTheme.Colors.teal)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .disabled(vm.asking || vm.question.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let answer = vm.askAnswer {
                    Divider().overlay(EMSTheme.Colors.divider)
                    Text(answer)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let askError = vm.askError {
                    Text(askError)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.danger)
                }
            }
        }
    }

    // MARK: - ذاكرة القرار وأنماطها (قراءة — authenticate)

    @ViewBuilder
    private var memorySection: some View {
        if let patterns = vm.patterns {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    EMSectionHeader(title: "أنماط القرار", systemImage: "chart.bar.fill")
                    EMSInfoRow(label: "سجلّات المناوبة", value: "\(patterns.records ?? 0)")
                    if let r = patterns.readiness {
                        if let min = r.min { EMSInfoRow(label: "أدنى جاهزية", value: "\(min)٪") }
                        if let avg = r.avg { EMSInfoRow(label: "متوسط الجاهزية", value: "\(avg)٪") }
                    }
                    if (patterns.completionDelays ?? 0) > 0 {
                        EMSInfoRow(label: "تأخر تكميل", value: "×\(patterns.completionDelays ?? 0)")
                    }
                    if let teams = patterns.shortageTeams, !teams.isEmpty {
                        EMSInfoRow(label: "نقص متكرر",
                                   value: teams.sorted { $0.value > $1.value }.map { "\($0.key) (×\($0.value))" }.joined(separator: "، "))
                    }
                    if let vehicles = patterns.vehicleIssues, !vehicles.isEmpty {
                        EMSInfoRow(label: "أعطال مركبات",
                                   value: vehicles.sorted { $0.value > $1.value }.map { "\($0.key) (×\($0.value))" }.joined(separator: "، "))
                    }
                }
            }
        }
        if !vm.memory.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "ذاكرة القرار")
                ForEach(vm.memory, id: \.id) { record in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                if let status = record.readiness?.status {
                                    EMSStatusPill(text: vm.readinessLabel(status), tone: vm.readinessTone(status))
                                }
                                Spacer()
                                if let at = record.recordedAtRiyadh ?? record.recordedAt {
                                    Text(at)
                                        .font(.caption2)
                                        .foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            if let summary = record.summary, !summary.isEmpty {
                                Text(summary)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let counts = record.counts {
                                Text("مخاطر: حرج \(counts.critical ?? 0) · تحذير \(counts.warning ?? 0) · معلومة \(counts.info ?? 0)")
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                        }
                    }
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

    // «اسأل» + الذاكرة (§18)
    @Published var question = ""
    @Published var asking = false
    @Published var askAnswer: String?
    @Published var askError: String?
    @Published private(set) var memory: [DecisionMemoryRecordDTO] = []
    @Published private(set) var patterns: SmartPatternsResponseDTO?

    /// عائلات الأسئلة المدعومة سيرفريًا (smart-ask-service.js FAMILIES) —
    /// اقتراحات نصية فقط؛ الكشف والإجابة سيرفيان بالكامل.
    let suggestedQuestions = [
        "ماذا أفعل الآن؟", "ما الخطر الحالي؟", "من يحتاج دعمًا؟",
        "هل الجاهزية مقبولة؟", "أي مركز به نقص؟",
        "ما الذي يمنع الجاهزية الكاملة؟", "أي طلب تكميل يحتاج انتباهًا؟",
        "ماذا حدث في هذه المناوبة؟"
    ]

    private let api = APIClient.shared

    /// المناوبة المرجعية للذاكرة: النشطة من التقييم ثم من current-shift.
    private var memoryShiftId: Int? {
        assessment?.shift?.id ?? currentShift?.shift?.id
    }

    func load() async {
        if state != .loaded { state = .loading }
        do {
            async let assessmentReq: SmartAssessmentDTO = api.get("/api/smart-operator/assessment")
            async let shiftReq: CurrentShiftDTO = api.get("/api/current-shift")
            let (a, s) = try await (assessmentReq, shiftReq)
            assessment = a.data
            currentShift = s
            state = .loaded
            // الذاكرة إثراء اختياري — فشلها لا يسقط التقييم (نفس روح الخادم)
            await loadMemory()
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    private func loadMemory() async {
        guard let shiftId = memoryShiftId else {
            memory = []
            patterns = nil
            return
        }
        let q = ["shiftId": "\(shiftId)"]
        if let res: SmartMemoryResponseDTO = try? await api.get("/api/smart-operator/memory", query: q) {
            // الأحدث أولًا — listByShift يعيد ترتيب الملف (الأقدم أولًا)
            memory = (res.records ?? []).reversed()
        }
        if let res: SmartPatternsResponseDTO = try? await api.get("/api/smart-operator/memory/patterns", query: q) {
            patterns = res
        }
    }

    /// سؤال المشغل الذكي — إجابة الخادم تُعرض حرفيًا (قانون الصدق).
    func ask() async {
        let q = question.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        asking = true
        askError = nil
        defer { asking = false }
        do {
            let res: SmartAskResponseDTO = try await api.post("/api/smart-operator/ask",
                                                              body: SmartAskRequestDTO(question: q))
            askAnswer = res.data?.text ?? "لا إجابة من الخادم."
        } catch let e as APIError {
            askError = e.userMessage
        } catch {
            askError = APIError.unknown.userMessage
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
