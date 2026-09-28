//
//  WorkflowOpsDTO.swift
//  EMSOperations
//
//  نماذج سير العمل الرسمي (docs/native-ios-platform-parity.md §13) —
//  مطابقة لـWorkflowService: نسخ المناوبة (shift_workflows) + حقول المشرف
//  (fields_json — قائمة بيضاء سيرفرية صارمة) + الاعتماد/إعادة الإصدار.
//  اللقطة (snapshot) تُقرأ خامًا عند الحاجة — لا نموذج انتقائي لها هنا.
//

import Foundation

// MARK: - نسخة سير عمل (صف shift_workflows)
struct WorkflowVersionDTO: Decodable, Identifiable {
    let id: Int?
    let shiftId: Int?
    let versionNo: Int?
    let status: String?           // draft | approved | sent | cancelled
    let refNo: String?
    let reissueReason: String?
    let createdByName: String?
    let createdAt: String?
    let approvedByName: String?
    let approvedAt: String?
    let sentAt: String?
    let acknowledgedAt: String?
    /// حقول المشرف JSON خامًا (summary/operationalNotes/keyEvents/issues/
    /// recommendations/reviewedBy) — تُفك نصيًا عند العرض.
    let fieldsJson: String?

    enum CodingKeys: String, CodingKey {
        case id, status
        case shiftId = "shift_id"
        case versionNo = "version_no"
        case refNo = "ref_no"
        case reissueReason = "reissue_reason"
        case createdByName = "created_by_name"
        case createdAt = "created_at"
        case approvedByName = "approved_by_name"
        case approvedAt = "approved_at"
        case sentAt = "sent_at"
        case acknowledgedAt = "acknowledged_at"
        case fieldsJson = "fields_json"
    }

    /// حقول المشرف مفكوكة — عرض فقط.
    var fields: [String: String] {
        guard let fieldsJson, let data = fieldsJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (key, value) in obj {
            if let s = value as? String { out[key] = s }
            else if let a = value as? [String] { out[key] = a.joined(separator: "، ") }
        }
        return out
    }

    var statusTitle: String {
        switch status {
        case "draft": return "مسودة"
        case "approved": return "معتمدة"
        case "sent": return "مُرسلة"
        case "cancelled": return "ملغاة"
        default: return status ?? "—"
        }
    }
}

// MARK: - GET /api/workflow/shift/:shiftId
struct WorkflowListDTO: Decodable {
    let success: Bool?
    let shiftId: Int?
    let versions: [WorkflowVersionDTO]?
    let shiftStatus: String?
}

// MARK: - GET /api/workflow/version/:id
struct WorkflowDetailDTO: Decodable {
    let success: Bool?
    let workflow: WorkflowVersionDTO?
}

// MARK: - PUT /api/workflow/version/:id — القائمة البيضاء السيرفرية حصرًا
struct WorkflowFieldsRequest: Encodable {
    var summary: String? = nil
    var operationalNotes: String? = nil
    var keyEvents: String? = nil
    var issues: String? = nil
    var recommendations: String? = nil
    var reviewedBy: [String]? = nil

    /// الجهات المعتمدة سيرفريًا (REVIEWER_WHITELIST).
    static let reviewerOptions = ["قائد المنطقة", "كبير المسعفين", "الإداري المناوب",
                                  "مشرف العمليات", "مدير القطاع", "المناوبة الإداري"]
}

// MARK: - POST /api/workflow/version/:id/reissue
struct WorkflowReissueRequest: Encodable {
    var reason: String? = nil
}

// MARK: - نتيجة عامة
struct WorkflowActionResponseDTO: Decodable {
    let success: Bool?
    let error: String?
    let changed: [String]?
    let workflow: WorkflowVersionDTO?
}
