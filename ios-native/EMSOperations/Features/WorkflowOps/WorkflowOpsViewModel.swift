//
//  WorkflowOpsViewModel.swift
//  EMSOperations
//
//  مخزن سير العمل الرسمي (§13): نسخ المناوبة النشطة + إعداد مسودة +
//  تحرير حقول المشرف (قائمة بيضاء سيرفرية) + اعتماد + إعادة إصدار +
//  PDF للمعتمدة. المناوبة تُحسم سيرفريًا (/api/current-shift — لا
//  shiftId من العميل في prepare).
//

import Foundation

@MainActor
final class WorkflowOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var shiftId: Int?
    @Published private(set) var shiftLabel: String?
    @Published private(set) var versions: [WorkflowVersionDTO] = []
    @Published private(set) var shiftStatus: String?

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            let cur: CurrentShiftDTO = try await api.get("/api/current-shift")
            shiftId = cur.shift?.id
            shiftLabel = [cur.shift?.type, cur.shift?.date].compactMap { $0 }.joined(separator: " · ")
            if let id = cur.shift?.id {
                let list: WorkflowListDTO = try await api.get("/api/workflow/shift/\(id)")
                versions = list.versions ?? []
                shiftStatus = list.shiftStatus
            } else {
                versions = []
                shiftStatus = nil
            }
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    // MARK: - الإجراءات (الحسم سيرفري)

    /// إعداد مسودة — idempotent سيرفريًا (يعيد المسودة المفتوحة إن وجدت).
    func prepare() async throws {
        let res: WorkflowActionResponseDTO = try await api.post("/api/workflow/prepare")
        if res.success == false { throw APIError.server(res.error ?? "فشل في إعداد سير العمل") }
        await reload()
    }

    func updateFields(id: Int, _ fields: WorkflowFieldsRequest) async throws {
        let res: WorkflowActionResponseDTO = try await api.put("/api/workflow/version/\(id)", body: fields)
        if res.success == false { throw APIError.server(res.error ?? "فشل في حفظ الحقول") }
        await reload()
    }

    func approve(id: Int) async throws {
        let res: WorkflowActionResponseDTO = try await api.post("/api/workflow/version/\(id)/approve")
        if res.success == false { throw APIError.server(res.error ?? "فشل في اعتماد سير العمل") }
        await reload()
    }

    func reissue(id: Int, reason: String?) async throws {
        let res: WorkflowActionResponseDTO = try await api.post("/api/workflow/version/\(id)/reissue",
                                                                body: WorkflowReissueRequest(reason: reason))
        if res.success == false { throw APIError.server(res.error ?? "فشل في إعادة الإصدار") }
        await reload()
    }

    /// PDF للنسخ المعتمدة فقط (409 سيرفري لغيرها).
    func downloadPdf(id: Int) async throws -> APIClient.DownloadedFile {
        try await api.download("/api/workflow/version/\(id)/pdf")
    }
}
