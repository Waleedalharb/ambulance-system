//
//  SmartOpsDTO.swift
//  EMSOperations
//
//  نماذج «اسأل المشغل الذكي» وذاكرة القرار وأنماطه
//  (docs/native-ios-platform-parity.md §18) — كلها authenticate فقط:
//  POST /api/smart-operator/ask          (server.js:7634 — smart-ask-service)
//  GET  /api/smart-operator/memory       (server.js:7596 — decision-memory-service)
//  GET  /api/smart-operator/memory/patterns (server.js:7613)
//  قانون الصدق سيرفري: لا رقم ولا اسم يُختلق — العميل يعرض نص الخادم كما هو.
//

import Foundation

// MARK: - POST /api/smart-operator/ask
/// طلب: { question } — الإجابة حتمية من التقييم الحالي + أنماط الذاكرة.
struct SmartAskRequestDTO: Encodable {
    let question: String
}

/// استجابة: { success, data: { family: String?, text: String } }
/// (smart-ask-service.js:115 — family=null لسؤال خارج النطاق).
struct SmartAskResponseDTO: Decodable {
    struct Answer: Decodable {
        let family: String?
        let text: String?
    }
    let success: Bool?
    let data: Answer?
}

// MARK: - GET /api/smart-operator/memory?shiftId=&limit=
/// استجابة: { success, shiftId, records: [...] }
/// سجل الذاكرة من buildRecord (decision-memory-service.js:69).
struct SmartMemoryResponseDTO: Decodable {
    let success: Bool?
    let shiftId: Int?
    let records: [DecisionMemoryRecordDTO]?
}

struct DecisionMemoryRecordDTO: Decodable {
    struct Readiness: Decodable {
        let percent: Int?
        let status: String?
    }
    struct Counts: Decodable {
        let critical: Int?
        let warning: Int?
        let info: Int?
    }
    let id: String?
    let recordedAt: String?         // UTC ISO — مصدر المقارنات
    let recordedAtRiyadh: String?   // عرض فقط (TIME-POLICY)
    let shiftId: Int?
    let shiftType: String?
    let shiftPhase: String?
    let fingerprint: String?
    let readiness: Readiness?
    let summary: String?
    let counts: Counts?
    let riskCodes: [String]?
    let shortageTeams: [String]?
    let vehicleIssues: [String]?
    let completionDelay: Bool?
    // الحمولات الكاملة (risks/recommendations/proactive) محفوظة سيرفريًا —
    // لا تُعرض هنا (بطاقة مركز القرار تعرض التقييم الحي).
}

// MARK: - GET /api/smart-operator/memory/patterns?shiftId=&from=&to=
/// استجابة: { success, scope, records, riskCodes, shortageTeams,
/// vehicleIssues, completionDelays, readiness }
/// (decision-memory-service.js:243).
struct SmartPatternsResponseDTO: Decodable {
    struct ReadinessStats: Decodable {
        let min: Int?
        let avg: Int?
        let samples: Int?
    }
    let success: Bool?
    let records: Int?
    let riskCodes: [String: Int]?
    let shortageTeams: [String: Int]?
    let vehicleIssues: [String: Int]?
    let completionDelays: Int?
    let readiness: ReadinessStats?
}
