//
//  OpsReadinessView.swift
//  EMSOperations
//
//  الجاهزية (تفعيل المنصة الأصلية): حالة الفرق وعدّادات القوى من
//  GET /api/staffing/state ← deriveTeamReadiness (المصدر الوحيد للاشتقاق).
//  عرض فقط — لا قرار حالة ولا تكميل من التطبيق في هذه المرحلة.
//

import SwiftUI

struct OpsReadinessView: View {
    @StateObject private var vm = OpsReadinessViewModel()

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
        .emsPage("الجاهزية")
        .task { await vm.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let wf = vm.data?.workforce {
            workforceCard(wf)
        }
        teamsSection
    }

    // MARK: - عدّادات القوى (من workforce كما يشتقها الخادم)

    private func workforceCard(_ wf: StaffingStateDTO.Workforce) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: "القوى البشرية", systemImage: "person.3.sequence.fill")
                HStack(spacing: 14) {
                    counter(wf.readyTeams, "جاهزة", EMSTheme.Colors.emerald)
                    counter(wf.missingTeams, "ناقصة", EMSTheme.Colors.warning)
                    counter(wf.offlineTeams, "خارج الخدمة", EMSTheme.Colors.danger)
                    counter(wf.pendingTeams, "بانتظار التكميل", EMSTheme.Colors.textMuted)
                    Spacer()
                }
                Divider().overlay(EMSTheme.Colors.divider)
                EMSInfoRow(label: "الكادر الحاضر", value: "\(wf.totalStaff ?? 0) من \(wf.totalRequired ?? 0)")
                EMSInfoRow(label: "الكادر المجدول", value: "\(wf.scheduledStaff ?? 0)")
                if (wf.supporters ?? 0) > 0 {
                    EMSInfoRow(label: "الداعمون", value: "\(wf.supporters ?? 0)")
                }
                if (wf.absentees ?? 0) > 0 {
                    EMSInfoRow(label: "غياب/تأخر مفتوح", value: "\(wf.absentees ?? 0)")
                }
                EMSInfoRow(label: "السيارات العاملة", value: "\(wf.totalCars ?? 0)")
                if let rate = wf.operationalReadinessRate {
                    EMSInfoRow(label: "الجاهزية التشغيلية", value: "\(rate)٪")
                } else if let rate = wf.readinessRate {
                    EMSInfoRow(label: "نسبة الجاهزية", value: "\(rate)٪")
                }
            }
        }
    }

    private func counter(_ value: Int?, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value ?? 0)")
                .font(.title3.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - الفرق (ترتيب طبيعي — نفس دلالة الخادم)

    @ViewBuilder
    private var teamsSection: some View {
        let names = vm.data?.sortedTeamNames ?? []
        if names.isEmpty {
            EMSEmptyView(
                icon: "checklist",
                title: "لا توجد خطة فرق لهذه المناوبة",
                detail: "تظهر الفرق هنا عند جدولة كادر المناوبة الحالية")
        } else {
            ForEach(names, id: \.self) { name in
                if let team = vm.data?.teams?[name] {
                    teamCard(name: name, team: team)
                }
            }
        }
    }

    private func teamCard(name: String, team: StaffingStateDTO.TeamReadiness) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(name)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white)
                    Spacer()
                    EMSStatusPill(text: vm.statusLabel(team.status), tone: vm.statusTone(team.status))
                }
                HStack(spacing: 6) {
                    Text("\(team.activeCount ?? 0)/\(team.requiredPersonnel ?? 0)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                    if let center = team.center {
                        Text("·")
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        Text(center)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                    if let vehicle = team.vehicleId {
                        Text("·")
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                        Text(vehicle)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textMuted)
                    }
                }
                if let reason = team.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let absentees = team.absentees, !absentees.isEmpty {
                    Divider().overlay(EMSTheme.Colors.divider)
                    ForEach(absentees) { a in
                        HStack(spacing: 6) {
                            Image(systemName: a.type == "late" ? "clock.badge.exclamationmark" : "person.fill.xmark")
                                .font(.caption2)
                                .foregroundStyle(EMSTheme.Colors.warning)
                            Text(a.name ?? "—")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textSecondary)
                            if let reason = a.reason, !reason.isEmpty {
                                Text("— \(reason)")
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                    .lineLimit(1)
                            }
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
final class OpsReadinessViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published var state: LoadState = .loading
    @Published var data: StaffingStateDTO?

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            data = try await api.get("/api/staffing/state")
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    // MARK: - عرض الحالات (القيم سيرفرية — التسمية عرضية فقط)

    func statusLabel(_ status: String?) -> String {
        switch status {
        case "ready": return "جاهزة"
        case "missing": return "ناقصة"
        case "offline": return "خارج الخدمة"
        case "pending": return "بانتظار التكميل"
        default: return "—"
        }
    }

    func statusTone(_ status: String?) -> EMSTheme.StatusTone {
        switch status {
        case "ready": return .normal
        case "missing": return .monitor
        case "offline": return .danger
        default: return .neutral
        }
    }
}
