//
//  FormsOpsViewModel.swift
//  EMSOperations
//
//  مخزن النماذج التشغيلية (§12): خمسة أنواع عبر FormsService — السجلات
//  حرة الحقول فتُجلب وتُرسل خامًا (postRaw/getRaw) للحفاظ على حقول الويب.
//  الحوادث/التصعيدات/الحالات الإلكترونية تتطلب تحقق CAD (incidents/lookup)
//  قبل الحفظ — نفس قاعدة الويب: لا حفظ بلا بلاغ متحقق منه.
//

import Foundation

/// نوع النموذج التشغيلي — مطابقة form_type في FormsService.
enum OpsFormType: String, CaseIterable, Identifiable {
    case incident = "incident"
    case escalation = "escalation"
    case eCase = "e_case"
    case dailyReport = "daily_report"
    case seniorShift = "senior_shift"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .incident: return "الحوادث"
        case .escalation: return "التصعيدات"
        case .eCase: return "الحالات الإلكترونية"
        case .dailyReport: return "التقارير اليومية"
        case .seniorShift: return "مناوبات الكبار"
        }
    }

    /// مسار القراءة/الإنشاء (الحذف = path + /:id).
    var path: String {
        switch self {
        case .incident: return "/api/incidents"
        case .escalation: return "/api/escalations"
        case .eCase: return "/api/e-cases"
        case .dailyReport: return "/api/daily-reports"
        case .seniorShift: return "/api/senior-shifts"
        }
    }

    /// يتطلب تحقق CAD قبل الحفظ (قاعدة الويب: لا حفظ بلا بلاغ متحقق).
    var requiresLookup: Bool {
        switch self {
        case .incident, .escalation, .eCase: return true
        case .dailyReport, .seniorShift: return false
        }
    }
}

@MainActor
final class FormsOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published private(set) var state: LoadState = .loading
    @Published private(set) var records: [OpsFormType: [FormRecordItem]] = [:]

    private let api = APIClient.shared

    func load() async {
        if case .loaded = state { return }
        await reload(showLoading: true)
    }

    func reload(showLoading: Bool = false) async {
        if showLoading { state = .loading }
        do {
            var result: [OpsFormType: [FormRecordItem]] = [:]
            // تسلسلي متعمد: خمسة مسارات صغيرة — الوضوح أهم من التوازي هنا
            for type in OpsFormType.allCases {
                let raw = try await api.getRaw(type.path)
                if let dict = raw as? [String: Any], let list = dict["records"] as? [[String: Any]] {
                    result[type] = list.map { FormRecordItem.from($0, formType: type.rawValue) }
                } else {
                    result[type] = []
                }
            }
            records = result
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func records(of type: OpsFormType) -> [FormRecordItem] { records[type] ?? [] }

    // MARK: - بحث CAD (ops.forms — قراءة صِرفة)

    func lookup(number: String) async throws -> IncidentLookupDTO {
        try await api.get("/api/incidents/lookup", query: ["number": number])
    }

    // MARK: - إنشاء/حذف (ops.forms — الحسم سيرفري)

    func submit(_ type: OpsFormType, record: [String: Any]) async throws {
        _ = try await api.postRaw(type.path, jsonObject: record)
        await reload()
    }

    func remove(_ type: OpsFormType, id: String) async throws {
        let res: DispatchActionResponseDTO = try await api.delete("\(type.path)/\(id)")
        if res.success == false { throw APIError.server(res.error ?? "فشل في حذف السجل") }
        await reload()
    }
}
