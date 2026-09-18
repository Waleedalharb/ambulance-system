//
//  HospitalsOpsView.swift
//  EMSOperations
//
//  مجال المستشفيات (§17): مراقبة (ملخص/تنبيهات/تاريخ رحلة) + سجل المستشفيات.
//  القراءة للجميع (authenticate) — إقرار التنبيه مقيد بـ ops.alerts كما في
//  server.js:5603 حرفيًا. كتابة سجل المستشفيات (POST /api/hospitals admin)
//  غير مبنية — كتابة JSON كاملة قديمة (خطر استبدال الكل).
//

import SwiftUI

struct HospitalsOpsView: View {
    @State private var segment: Segment = .monitor

    enum Segment: String, CaseIterable, Identifiable {
        case monitor, registry
        var id: String { rawValue }
        var title: String { self == .monitor ? "المراقبة" : "السجل" }
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
                case .monitor: HospitalMonitorSegment()
                case .registry: HospitalsRegistrySegment()
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("المستشفيات")
    }
}

// MARK: - قسم المراقبة

struct HospitalMonitorSegment: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = HospitalMonitorViewModel()
    @State private var historyJourney: HospitalMonitorSummaryDTO.Journey?

    private var canAck: Bool { session.permissions.canOpsAlerts }

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
            .sheet(item: $historyJourney) { journey in
                HospitalHistorySheet(journey: journey)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let d = vm.data {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("ملخص النافذة")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Spacer()
                        if let label = d.window?.label {
                            Text(label)
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                    }
                    EMSInfoRow(label: "المنقولون", value: "\(d.totalTransferred ?? 0)")
                    EMSInfoRow(label: "حاليًا بالمستشفى", value: "\(d.currentAtHospital ?? 0)")
                    EMSInfoRow(label: "انقطع رصدهم", value: "\(d.monitoringLost ?? 0)",
                               valueColor: (d.monitoringLost ?? 0) > 0 ? EMSTheme.Colors.danger : EMSTheme.Colors.textPrimary)
                    if let avg = d.avgDwellMin {
                        EMSInfoRow(label: "متوسط البقاء", value: "\(avg) دقيقة")
                    }
                    EMSInfoRow(label: "تجاوزات البقاء", value: "\(d.exceedances ?? 0)")
                    EMSInfoRow(label: "غير مقاس", value: "\(d.unmeasured ?? 0)")
                }
            }

            // التنبيهات
            let alerts = d.alerts ?? []
            EMSSectionHeader(title: "تنبيهات المراقبة (\(d.activeAlerts ?? 0) نشطة)", systemImage: "bell.badge")
            if alerts.isEmpty {
                EMSEmptyView(icon: "bell.slash", title: "لا تنبيهات", detail: "لا تنبيهات في هذه النافذة")
            } else {
                ForEach(alerts) { alert in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                EMSStatusPill(
                                    text: alertStateLabel(alert.state),
                                    tone: alert.state == "resolved" ? .neutral : (alert.state == "acknowledged" ? .monitor : .danger))
                                Spacer()
                                if let dwell = alert.dwellMin {
                                    Text("\(dwell) دقيقة")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.white)
                                }
                            }
                            EMSInfoRow(label: "المنشأة", value: alert.facility ?? "—")
                            if let unit = alert.unitCode {
                                EMSInfoRow(label: "الوحدة", value: unit)
                            }
                            if let raised = alert.firstRaisedAt {
                                EMSInfoRow(label: "رُفع", value: raised)
                            }
                            if alert.state == "acknowledged", let by = alert.ackByName {
                                EMSInfoRow(label: "أقرّه", value: by)
                            }
                            if alert.unreliable == true {
                                EMSInfoRow(label: "الموثوقية", value: "قيمة غير موثوقة (انقطاع رصد)", valueColor: EMSTheme.Colors.warning)
                            }
                            if canAck, alert.state == "open", let id = alert.id {
                                EMSPrimaryButton(title: "إقرار التنبيه", isLoading: vm.isMutating) {
                                    Task { _ = await vm.ack(alertId: id) }
                                }
                            }
                        }
                    }
                }
            }

            // المنشآت
            let facilities = d.facilities ?? []
            if !facilities.isEmpty {
                EMSSectionHeader(title: "المنشآت", systemImage: "building.2")
                ForEach(facilities) { fac in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(fac.facility ?? "—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Spacer()
                                Text("\(fac.cases ?? 0) حالة")
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                            HStack(spacing: 10) {
                                if let avg = fac.avgDwellMin { Text("متوسط \(avg) د") }
                                Text("جارية: \(fac.ongoing ?? 0)")
                                Text("تجاوزات: \(fac.exceedances ?? 0)")
                                if (fac.monitoringLost ?? 0) > 0 {
                                    Text("انقطاع: \(fac.monitoringLost ?? 0)")
                                        .foregroundStyle(EMSTheme.Colors.danger)
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(EMSTheme.Colors.textMuted)

                            let journeys = fac.journeys ?? []
                            if !journeys.isEmpty {
                                Divider().overlay(EMSTheme.Colors.divider)
                                ForEach(journeys) { j in
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(j.unitCode ?? j.key ?? "—")
                                                .font(.caption.weight(.semibold))
                                                .foregroundStyle(.white)
                                            Text(journeyStateLabel(j.episodeState))
                                                .font(.caption2)
                                                .foregroundStyle(j.episodeState == "monitoring-lost" ? EMSTheme.Colors.danger : EMSTheme.Colors.textMuted)
                                        }
                                        Spacer()
                                        if let dwell = j.dwellMin {
                                            Text("\(dwell) د\(j.ongoing == true ? " · جارٍ" : "")\(j.dwellCapped == true ? " · عند آخر مشاهدة" : "")")
                                                .font(.caption2)
                                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                                        } else {
                                            Text("غير مقاس")
                                                .font(.caption2)
                                                .foregroundStyle(EMSTheme.Colors.textMuted)
                                        }
                                        Button {
                                            historyJourney = j
                                        } label: {
                                            Image(systemName: "clock.arrow.circlepath")
                                                .font(.caption)
                                                .foregroundStyle(EMSTheme.Colors.teal)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func alertStateLabel(_ state: String?) -> String {
        switch state {
        case "open": return "مفتوح"
        case "acknowledged": return "مُقَرّ"
        case "resolved": return "محلول"
        default: return state ?? "—"
        }
    }

    private func journeyStateLabel(_ state: String?) -> String {
        switch state {
        case "at-hospital": return "في المستشفى"
        case "monitoring-lost": return "انقطع الرصد"
        case "last-known": return "آخر موقع معروف"
        default: return state ?? "—"
        }
    }
}

struct HospitalHistorySheet: View {
    @Environment(\.dismiss) private var dismiss
    let journey: HospitalMonitorSummaryDTO.Journey
    @State private var entries: [HospitalHistoryEntryDTO]?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.danger)
                        .padding()
                } else if let entries {
                    if entries.isEmpty {
                        Text("لا تاريخ مسجلًا لهذه الرحلة")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                            .padding()
                    } else {
                        List(entries) { e in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(e.at ?? "—")
                                    .font(.caption.weight(.semibold))
                                Text([e.field, e.alert, e.to].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("تاريخ الرحلة")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إغلاق") { dismiss() } }
            }
            .task {
                guard let key = journey.key else { entries = []; return }
                do {
                    let res: HospitalHistoryDTO = try await APIClient.shared.get("/api/hospital-monitor/history", query: ["key": key])
                    entries = res.history ?? []
                } catch let e as APIError {
                    self.error = e.userMessage
                } catch {
                    self.error = APIError.unknown.userMessage
                }
            }
        }
    }
}

@MainActor
final class HospitalMonitorViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: HospitalMonitorSummaryDTO?
    @Published var isMutating = false
    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/hospital-monitor/summary")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func ack(alertId: String) async -> String? {
        guard !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        // معرف التنبيه مركّب (key|dwell-exceed) — ترميز المسار إلزامي
        guard let encoded = alertId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        do {
            let _: HospitalAlertAckDTO = try await api.post("/api/hospital-monitor/alerts/\(encoded)/ack")
            await load()
            return "تم الإقرار"
        } catch {
            return nil
        }
    }
}

// MARK: - قسم السجل

struct HospitalsRegistrySegment: View {
    @StateObject private var vm = HospitalsRegistryViewModel()
    @State private var search = ""

    var body: some View {
        TextField("بحث بالاسم أو التخصص", text: $search)
            .textFieldStyle(.roundedBorder)

        switch vm.state {
        case .loading:
            EMSSkeletonCard(lines: 4)
            EMSSkeletonCard(lines: 3)
        case .failed(let message):
            EMSErrorView(message: message) { Task { await vm.load() } }
        case .loaded:
            let all = vm.data?.data ?? []
            let q = search.trimmingCharacters(in: .whitespaces)
            let filtered = q.isEmpty ? all : all.filter {
                ($0.name ?? "").contains(q) || ($0.specialty ?? "").contains(q)
            }
            if filtered.isEmpty {
                EMSEmptyView(icon: "building.2", title: "لا مستشفيات", detail: "لا مستشفيات مطابقة")
            } else {
                Text("\(filtered.count) مستشفى")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                ForEach(filtered) { h in
                    EMSCard {
                        HStack(spacing: 12) {
                            Image(systemName: "building.2.fill")
                                .font(.title3)
                                .foregroundStyle(EMSTheme.Colors.teal)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(h.name ?? "—")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                Text([hospitalTypeLabel(h.type), h.specialty].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                            }
                            Spacer()
                            if let hours = h.hours, !hours.isEmpty {
                                EMSStatusPill(text: hours, tone: hours == "24 ساعة" ? .normal : .monitor)
                            }
                        }
                    }
                }
            }
        }

        Color.clear.frame(height: 0)
            .task { await vm.load() }
    }

    private func hospitalTypeLabel(_ type: String?) -> String? {
        guard let type else { return nil }
        switch type {
        case "عام": return "مستشفى عام"
        case "متخصص": return "مركز متخصص"
        case "مجمع": return "مجمع طبي"
        case "طوارئ": return "مركز طوارئ"
        default: return type
        }
    }
}

@MainActor
final class HospitalsRegistryViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: HospitalsListDTO?
    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/hospitals")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }
}
