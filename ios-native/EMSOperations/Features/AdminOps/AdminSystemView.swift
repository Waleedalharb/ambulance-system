//
//  AdminSystemView.swift
//  EMSOperations
//
//  الإعدادات والمراقبة (§20): الساعات الشهرية المطلوبة (قراءة للجميع،
//  كتابة admin/director) + استخدام القرص (admin/director) + سجل التدقيق
//  العام (قراءة — authenticate). المراقبة التقنية العميقة
//  (admin/monitor/*) والإصلاح/التدمير مؤجلة — تخريبية ولا تُدار من تطبيق.
//

import SwiftUI

struct AdminSystemView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = AdminSystemViewModel()

    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?
    @State private var hoursText = ""

    private var canWrite: Bool { session.permissions.isAdminOrDirector }

    var body: some View {
        Group {
            switch vm.state {
            case .loading:
                VStack(spacing: EMSTheme.spacing) { EMSSkeletonCard(lines: 3); EMSSkeletonCard(lines: 4) }
                    .padding(EMSTheme.pagePadding)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.reload(showLoading: true) } }
                    .padding(EMSTheme.pagePadding)
            case .loaded:
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .emsPage("الإعدادات والمراقبة")
        .task { await vm.load() }
    }

    private var content: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                hoursCard
                diskCard
                auditSection
                if let infoMessage {
                    Text(infoMessage).font(.caption).foregroundStyle(EMSTheme.Colors.emerald)
                        .multilineTextAlignment(.center)
                }
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(EMSTheme.Colors.danger)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.reload() }
    }

    // MARK: - الساعات الشهرية

    private var hoursCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "الساعات المطلوبة شهريًا", systemImage: "clock.badge.checkmark")
                if let value = vm.monthlyHours {
                    // تنسيق مسبق محليًا — specifier داخل interpolation ViewBuilder غير مضمون التحليل.
                    let formattedHours = String(format: "%.0f", value)
                    EMSInfoRow(label: "القيمة الحالية", value: "\(formattedHours) ساعة")
                }
                if canWrite {
                    HStack(spacing: 8) {
                        TextField("قيمة جديدة (1–744)", text: $hoursText)
                            .textFieldStyle(.roundedBorder)
                            .keyboardType(.numberPad)
                        Button {
                            working = true
                            infoMessage = nil
                            errorMessage = nil
                            Task {
                                do {
                                    try await vm.setMonthlyHours(Double(hoursText) ?? 0)
                                    infoMessage = "تم حفظ المطلوب الشهري"
                                } catch let e as APIError {
                                    errorMessage = e.userMessage
                                } catch {
                                    errorMessage = APIError.unknown.userMessage
                                }
                                working = false
                            }
                        } label: {
                            if working { ProgressView().tint(.white) } else { Text("حفظ") }
                        }
                        .frame(width: 72, height: 36)
                        .background(EMSTheme.Colors.teal)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .disabled(working)
                    }
                    Text("رقم موجب بين 1 و 744 (ساعات الشهر) — الخادم يرفض غير ذلك.")
                        .font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    // MARK: - القرص

    private var diskCard: some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                EMSectionHeader(title: "استخدام القرص", systemImage: "internaldrive")
                if let disk = vm.disk {
                    EMSInfoRow(label: "الإجمالي", value: disk.total ?? "—")
                    EMSInfoRow(label: "المستخدم", value: disk.used ?? "—")
                    EMSInfoRow(label: "المتاح", value: disk.available ?? "—")
                    EMSInfoRow(label: "النسبة", value: disk.percent ?? "—")
                } else {
                    Text("تعذر جلب معلومات القرص")
                        .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
    }

    // MARK: - سجل التدقيق

    private var auditSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            EMSectionHeader(title: "سجل التدقيق", systemImage: "doc.text.magnifyingglass")
            if vm.auditLogs.isEmpty {
                Text("لا توجد سجلات")
                    .font(.caption).foregroundStyle(EMSTheme.Colors.textMuted)
            } else {
                ForEach(vm.auditLogs, id: \.stableId) { entry in
                    EMSCard {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(entry.action ?? "—")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(EMSTheme.Colors.textPrimary)
                                Spacer()
                                if let ts = entry.timestamp {
                                    Text(ts).font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                            if let details = entry.details, !details.isEmpty {
                                Text(details)
                                    .font(.caption)
                                    .foregroundStyle(EMSTheme.Colors.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: 8) {
                                if let user = entry.user {
                                    Text(user).font(.caption2).foregroundStyle(EMSTheme.Colors.teal)
                                }
                                if let category = entry.category {
                                    Text(category).font(.caption2).foregroundStyle(EMSTheme.Colors.textMuted)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class AdminSystemViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var monthlyHours: Double?
    @Published private(set) var disk: DiskUsageDTO.Disk?
    @Published private(set) var auditLogs: [AuditLogEntryDTO] = []

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            let hours: MonthlyHoursDTO = try await api.get("/api/settings/monthly-required-hours")
            monthlyHours = hours.value
            // القرص وسجل التدقيق إثراء — فشلهما لا يسقط الشاشة
            if let res: DiskUsageDTO = try? await api.get("/api/disk-usage") {
                disk = res.disk
            }
            if let res: AuditLogResponseDTO = try? await api.get("/api/audit-log") {
                auditLogs = res.logs ?? []
            }
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func setMonthlyHours(_ value: Double) async throws {
        let res: MonthlyHoursDTO = try await api.put("/api/settings/monthly-required-hours",
                                                     body: MonthlyHoursRequestDTO(value: value))
        if res.success == false { throw APIError.server("فشل في حفظ المطلوب الشهري") }
        monthlyHours = res.value
    }
}
