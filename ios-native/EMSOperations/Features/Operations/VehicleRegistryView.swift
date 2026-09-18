//
//  VehicleRegistryView.swift
//  EMSOperations
//
//  السجل المرجعي للمركبات (§10 — admin فقط): GET /api/vehicles/registry
//  + إضافة/تعديل عبر POST/PUT /api/vehicles/registry[/:id]. قانون
//  append-only: لا حذف ولا تعطيل إطلاقًا. البوابة admin صِرفة —
//  الخادم يرفض غيره (authorize(['admin'])).
//

import SwiftUI

struct VehicleRegistryView: View {
    @StateObject private var vm = VehicleRegistryViewModel()

    private enum Sheet: Identifiable {
        case add
        case edit(VehicleRegistryDTO.Item)
        var id: String {
            switch self {
            case .add: return "add"
            case .edit(let v): return "edit-\(v.id)"
            }
        }
    }

    @State private var sheet: Sheet?
    @State private var working = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?

    @State private var plate = ""
    @State private var callSign = ""
    @State private var vehicleType = ""
    @State private var category = ""
    @State private var designation = ""
    @State private var modelYear = ""
    @State private var adminStatus = ""
    @State private var notes = ""

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 4)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load(showLoading: true) } }
                case .loaded:
                    content
                }
                if let infoMessage {
                    Text(infoMessage)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.emerald)
                        .multilineTextAlignment(.center)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.danger)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("السجل المرجعي")
        .task { await vm.load() }
        .sheet(item: $sheet) { sheetContent($0) }
    }

    @ViewBuilder
    private var content: some View {
        HStack {
            Text("\(vm.vehicles.count) مركبة في السجل")
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textMuted)
            Spacer()
            Button {
                plate = ""; callSign = ""; vehicleType = ""; category = ""
                designation = ""; modelYear = ""; adminStatus = ""; notes = ""
                sheet = .add
            } label: {
                Label("إضافة مركبة", systemImage: "plus")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .tint(EMSTheme.Colors.teal)
        }

        if vm.vehicles.isEmpty {
            EMSEmptyView(icon: "truck.box", title: "السجل فارغ")
        } else {
            ForEach(vm.vehicles) { vehicle in
                vehicleCard(vehicle)
            }
        }
    }

    private func vehicleCard(_ vehicle: VehicleRegistryDTO.Item) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(vehicle.callSign ?? vehicle.plateNumber ?? "مركبة")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(EMSTheme.Colors.textPrimary)
                    Spacer()
                    if let status = vehicle.adminStatus, !status.isEmpty {
                        EMSStatusPill(text: status, tone: .neutral)
                    }
                }
                if let plate = vehicle.plateNumber { EMSInfoRow(label: "اللوحة", value: plate) }
                if let type = vehicle.vehicleType { EMSInfoRow(label: "النوع", value: type) }
                if let year = vehicle.modelYear { EMSInfoRow(label: "الموديل", value: "\(year)") }
                if let designation = vehicle.designation { EMSInfoRow(label: "التعيين", value: designation) }
                Button {
                    plate = vehicle.plateNumber ?? ""
                    callSign = vehicle.callSign ?? ""
                    vehicleType = vehicle.vehicleType ?? ""
                    category = vehicle.category ?? ""
                    designation = vehicle.designation ?? ""
                    modelYear = vehicle.modelYear.map(String.init) ?? ""
                    adminStatus = vehicle.adminStatus ?? ""
                    notes = vehicle.notes ?? ""
                    sheet = .edit(vehicle)
                } label: {
                    Label("تعديل", systemImage: "pencil")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(EMSTheme.Colors.teal)
                .disabled(working)
            }
        }
    }

    @ViewBuilder
    private func sheetContent(_ sheet: Sheet) -> some View {
        switch sheet {
        case .add: formSheet(title: "إضافة مركبة", editing: nil)
        case .edit(let v): formSheet(title: "تعديل مركبة", editing: v)
        }
    }

    private func formField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .foregroundStyle(EMSTheme.Colors.textPrimary)
            .padding(12)
            .background(Color.white.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var formValid: Bool {
        !plate.trimmingCharacters(in: .whitespaces).isEmpty &&
        !vehicleType.trimmingCharacters(in: .whitespaces).isEmpty &&
        !category.trimmingCharacters(in: .whitespaces).isEmpty &&
        !designation.trimmingCharacters(in: .whitespaces).isEmpty &&
        (Int(modelYear) ?? 0) >= 1950 && (Int(modelYear) ?? 0) <= 2100
    }

    private func formSheet(title: String, editing item: VehicleRegistryDTO.Item?) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: EMSTheme.spacing) {
                    formField("رقم اللوحة *", text: $plate)
                    formField("الإشارة اللاسلكية (اختياري)", text: $callSign)
                    formField("نوع المركبة *", text: $vehicleType)
                    formField("الفئة *", text: $category)
                    formField("التعيين *", text: $designation)
                    formField("سنة الموديل *", text: $modelYear)
                        .keyboardType(.numberPad)
                    formField("الحالة الإدارية (افتراضي: أساسية)", text: $adminStatus)
                    formField("ملاحظات (اختياري)", text: $notes)
                    EMSPrimaryButton(title: item == nil ? "إضافة" : "حفظ", isLoading: working,
                                     isDisabled: !formValid) {
                        let req = VehicleRegistryRequest(
                            plateNumber: plate.trimmingCharacters(in: .whitespaces),
                            vehicleType: vehicleType.trimmingCharacters(in: .whitespaces),
                            category: category.trimmingCharacters(in: .whitespaces),
                            designation: designation.trimmingCharacters(in: .whitespaces),
                            modelYear: Int(modelYear) ?? 0,
                            callSign: callSign.isEmpty ? nil : callSign.trimmingCharacters(in: .whitespaces),
                            adminStatus: adminStatus.isEmpty ? nil : adminStatus.trimmingCharacters(in: .whitespaces),
                            notes: notes.isEmpty ? nil : notes.trimmingCharacters(in: .whitespaces))
                        let editId = item?.vehicleId
                        self.sheet = nil
                        execute {
                            if let editId {
                                try await vm.update(id: editId, req)
                                return "تم حفظ التعديل"
                            }
                            try await vm.create(req)
                            return "تمت إضافة المركبة"
                        }
                    }
                }
                .padding(EMSTheme.pagePadding)
            }
            .background(EMSBackground())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إلغاء") { self.sheet = nil }
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func execute(_ work: @escaping () async throws -> String?) {
        errorMessage = nil
        working = true
        Task {
            do { infoMessage = try await work() }
            catch let e as APIError { errorMessage = e.userMessage }
            catch { errorMessage = APIError.unknown.userMessage }
            working = false
        }
    }
}

@MainActor
final class VehicleRegistryViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var vehicles: [VehicleRegistryDTO.Item] = []

    private let api = APIClient.shared

    func load(showLoading: Bool = false) async {
        if showLoading || vehicles.isEmpty { state = .loading }
        do {
            let res: VehicleRegistryDTO = try await api.get("/api/vehicles/registry")
            vehicles = res.vehicles ?? []
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func create(_ req: VehicleRegistryRequest) async throws {
        let res: VehicleActionResponseDTO = try await api.post("/api/vehicles/registry", body: req)
        if res.success == false { throw APIError.server(res.error ?? "فشل في إضافة المركبة") }
        await load()
    }

    func update(id: String, _ req: VehicleRegistryRequest) async throws {
        let res: VehicleActionResponseDTO = try await api.put("/api/vehicles/registry/\(id)", body: req)
        if res.success == false { throw APIError.server(res.error ?? "فشل في تعديل المركبة") }
        await load()
    }
}
