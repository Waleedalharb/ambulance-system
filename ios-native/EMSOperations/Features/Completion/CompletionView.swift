//
//  CompletionView.swift
//  EMSOperations
//
//  التكميل (قسم 14 / D10): جلسة فحص جاهزية الفرقة من /api/my/check-session.
//  يعرض بنود الجلسة ويرسل نتيجة كل بند ثم التأكيد النهائي.
//  الحالات الخاصة: no_assignment (لا تكليف) / not_field_team (ليس فريقًا ميدانيًا).
//

import SwiftUI

struct CompletionView: View {
    @StateObject private var vm = CompletionViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 2)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .noAssignment:
                    EMSEmptyView(
                        icon: "calendar.badge.exclamationmark",
                        title: "لا يوجد تكليف ميداني اليوم",
                        detail: "التكميل مرتبط بتكليفك الفعلي في المناوبة الحالية")
                case .notFieldTeam:
                    EMSEmptyView(
                        icon: "person.2.slash",
                        title: "التكميل متاح للفرق الميدانية فقط",
                        detail: "تكليفك الحالي ليس ضمن فرقة ميدانية")
                case .session:
                    sessionContent
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("التكميل")
        .task { await vm.load() }
        .alert("تم التأكيد", isPresented: $vm.showConfirmed) {
            Button("حسنًا") { Task { await vm.load() } }
        } message: {
            Text("سُجّل تأكيد جاهزية الفرقة بنجاح.")
        }
    }

    // MARK: - محتوى الجلسة

    @ViewBuilder
    private var sessionContent: some View {
        if let team = vm.check?.team {
            EMSCard {
                VStack(alignment: .leading, spacing: 8) {
                    EMSectionHeader(title: "جلسة الفحص الحالية", systemImage: "checklist.checked")
                    EMSInfoRow(label: "الفرقة", value: team.name ?? "—")
                    EMSInfoRow(label: "المركز", value: team.center ?? "—")
                    if let v = vm.check?.vehicle {
                        EMSInfoRow(label: "المركبة", value: v.displayName)
                    }
                    if let status = vm.check?.session?.status {
                        EMSInfoRow(label: "حالة الجلسة", value: status)
                    }
                }
            }
        }

        if vm.items.isEmpty {
            EMSEmptyView(
                icon: "tray",
                title: "لا توجد بنود فحص معرّفة لهذه الجلسة",
                detail: "يمكنك تأكيد الجاهزية مباشرة")
        } else {
            EMSCard {
                VStack(alignment: .leading, spacing: 12) {
                    EMSectionHeader(title: "بنود الفحص")
                    ForEach(vm.items) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.label ?? item.itemKey ?? "بند")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.white)
                            Picker("النتيجة", selection: vm.binding(for: item)) {
                                Text("سليم").tag("ok")
                                Text("ملاحظة").tag("issue")
                            }
                            .pickerStyle(.segmented)
                        }
                        if item.id != vm.items.last?.id {
                            Divider().overlay(EMSTheme.Colors.divider)
                        }
                    }
                }
            }
        }

        if let error = vm.submitError {
            Text(error)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        EMSPrimaryButton(
            title: "تأكيد الجاهزية",
            isLoading: vm.isSubmitting
        ) {
            Task { await vm.submitAll() }
        }
    }
}

// MARK: - ViewModel

@MainActor
final class CompletionViewModel: ObservableObject {
    enum State: Equatable {
        case loading
        case failed(String)
        case noAssignment
        case notFieldTeam
        case session
    }

    @Published var state: State = .loading
    @Published var check: CheckSessionDTO?
    @Published var items: [CheckSessionDTO.Item] = []
    @Published var results: [String: String] = [:]
    @Published var isSubmitting = false
    @Published var submitError: String?
    @Published var showConfirmed = false

    private let api = APIClient.shared

    func load() async {
        state = .loading
        submitError = nil
        do {
            let dto: CheckSessionDTO = try await api.get("/api/my/check-session")
            check = dto
            switch dto.state {
            case "no_assignment": state = .noAssignment
            case "not_field_team": state = .notFieldTeam
            default:
                items = dto.session?.items ?? []
                for item in items {
                    if let key = item.itemKey {
                        results[key] = item.result ?? "ok"
                    }
                }
                state = .session
            }
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func binding(for item: CheckSessionDTO.Item) -> Binding<String> {
        Binding(
            get: { self.results[item.itemKey ?? ""] ?? "ok" },
            set: { self.results[item.itemKey ?? ""] = $0 }
        )
    }

    func submitAll() async {
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }
        do {
            for item in items {
                guard let key = item.itemKey else { continue }
                let body = CheckItemRequest(itemKey: key, result: results[key] ?? "ok", note: nil)
                let _: SimpleSuccess = try await api.post("/api/my/check-session/items", body: body)
            }
            let _: CheckConfirmResponse = try await api.post("/api/my/check-session/confirm")
            showConfirmed = true
        } catch let e as APIError {
            submitError = e.userMessage
        } catch {
            submitError = APIError.unknown.userMessage
        }
    }
}
