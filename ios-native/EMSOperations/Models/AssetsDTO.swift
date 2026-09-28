//
//  AssetsDTO.swift
//  EMSOperations
//
//  نماذج مجال العهد والأصول (§16) — مطابقة لأشكال الـBackend المُتحقق منها
//  من المصدر (server.js:5881-6780 + db.js:4248-4340). فكّ دفاعي:
//  كل الحقول اختيارية؛ status_labels/category_labels تأتي من الخادم.
//

import Foundation

// MARK: - صف أصل (جدول assets في db.js)
struct AssetDTO: Decodable, Identifiable {
    let rowId: Int?
    let assetCode: String?
    let typeName: String?
    let originalName: String?
    let serialNumber: String?
    let status: String?           // working|damaged|missing|replaced|recalled|out_of_service|unknown
    let teamName: String?
    let centerName: String?
    let custody: String?
    let isNew: Int?
    let needsReview: Int?
    let notes: String?
    let source: String?
    let createdAt: String?
    let updatedAt: String?
    let lastInventoryAt: String?  // يُلحق في قائمة الجلسة المتوقعة

    var id: Int { rowId ?? 0 }

    enum CodingKeys: String, CodingKey {
        case rowId = "id"
        case assetCode = "asset_code"
        case typeName = "type_name"
        case originalName = "original_name"
        case serialNumber = "serial_number"
        case status
        case teamName = "team_name"
        case centerName = "center_name"
        case custody
        case isNew = "is_new"
        case needsReview = "needs_review"
        case notes, source
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastInventoryAt = "last_inventory_at"
    }
}

// MARK: - حدث أصل (جدول asset_events)
struct AssetEventDTO: Decodable, Identifiable {
    let rowId: Int?
    let assetId: Int?
    let eventType: String?
    let fromValue: String?
    let toValue: String?
    let actorName: String?
    let reason: String?
    let createdAt: String?
    // إثراء اللوحة (JOIN assets)
    let assetCode: String?
    let typeName: String?
    let teamName: String?

    var id: String { "\(rowId ?? 0)|\(createdAt ?? "")" }

    enum CodingKeys: String, CodingKey {
        case rowId = "id"
        case assetId = "asset_id"
        case eventType = "event_type"
        case fromValue = "from_value"
        case toValue = "to_value"
        case actorName = "actor_name"
        case reason
        case createdAt = "created_at"
        case assetCode = "asset_code"
        case typeName = "type_name"
        case teamName = "team_name"
    }
}

// MARK: - استبدال (asset_replacements + إثراء old_asset/new_asset)
struct AssetReplacementDTO: Decodable, Identifiable {
    let rowId: Int?
    let oldAssetId: Int?
    let newAssetId: Int?
    let reason: String?
    let actorName: String?
    let createdAt: String?
    let oldAsset: AssetDTO?
    let newAsset: AssetDTO?

    var id: Int { rowId ?? 0 }

    enum CodingKeys: String, CodingKey {
        case rowId = "id"
        case oldAssetId = "old_asset_id"
        case newAssetId = "new_asset_id"
        case reason
        case actorName = "actor_name"
        case createdAt = "created_at"
        case oldAsset = "old_asset"
        case newAsset = "new_asset"
    }
}

// MARK: - GET /api/assets (سجل الأصول)
struct AssetsListDTO: Decodable {
    let success: Bool?
    let rows: [AssetDTO]?
    let total: Int?
    let statusLabels: [String: String]?

    enum CodingKeys: String, CodingKey {
        case success, rows, total
        case statusLabels = "status_labels"
    }
}

// MARK: - GET /api/assets/:id (بطاقة الجهاز)
struct AssetCardDTO: Decodable {
    let success: Bool?
    let asset: AssetDTO?
    let events: [AssetEventDTO]?
    let replacements: [AssetReplacementDTO]?
    let statusLabels: [String: String]?

    enum CodingKeys: String, CodingKey {
        case success, asset, events, replacements
        case statusLabels = "status_labels"
    }
}

// MARK: - GET /api/assets/dashboard (db.Assets.dashboard)
struct AssetsDashboardDTO: Decodable {
    struct Count: Decodable {
        let status: String?
        let centerName: String?
        let teamName: String?
        let typeName: String?
        let c: Int?
        let review: Int?

        enum CodingKeys: String, CodingKey {
            case status, c, review
            case centerName = "center_name"
            case teamName = "team_name"
            case typeName = "type_name"
        }
    }
    struct CycleProgress: Decodable {
        let cycle: InventoryCycleDTO?
        let total: Int?
        let approved: Int?
        let submitted: Int?
    }

    let success: Bool?
    let byStatus: [Count]?
    let byCenter: [Count]?
    let byTeam: [Count]?
    let byType: [Count]?
    let total: Int?
    let noSerial: Int?
    let needsReview: Int?
    let shared: Int?
    let isNew: Int?
    let replacements: Int?
    let recentEvents: [AssetEventDTO]?
    let activeCycle: CycleProgress?
    let lastCycle: InventoryCycleDTO?
    let statusLabels: [String: String]?

    enum CodingKeys: String, CodingKey {
        case success, byStatus, byCenter, byTeam, byType, total, replacements, recentEvents
        case noSerial = "no_serial"
        case needsReview = "needs_review"
        case shared
        case isNew = "is_new"
        case activeCycle
        case lastCycle
        case statusLabels = "status_labels"
    }
}

// MARK: - دورة جرد (inventory_cycles) + تقدم الجلسات
struct InventoryCycleDTO: Decodable, Identifiable {
    struct SessionSummary: Decodable, Identifiable {
        let id: Int?
        let teamName: String?
        let status: String?          // open|submitted|approved
        let conductorName: String?
        let submittedAt: String?
        let approvedAt: String?

        enum CodingKeys: String, CodingKey {
            case id, status
            case teamName = "team_name"
            case conductorName = "conductor_name"
            case submittedAt = "submitted_at"
            case approvedAt = "approved_at"
        }
    }

    let id: Int?
    let label: String?
    let periodStart: String?
    let periodEnd: String?
    let status: String?              // draft|active|closed
    let createdBy: String?
    let createdAt: String?
    let closedAt: String?
    let sessionsTotal: Int?
    let sessionsSubmitted: Int?
    let sessionsApproved: Int?
    let sessions: [SessionSummary]?

    enum CodingKeys: String, CodingKey {
        case id, label, status, sessions
        case periodStart = "period_start"
        case periodEnd = "period_end"
        case createdBy = "created_by"
        case createdAt = "created_at"
        case closedAt = "closed_at"
        case sessionsTotal = "sessions_total"
        case sessionsSubmitted = "sessions_submitted"
        case sessionsApproved = "sessions_approved"
    }
}

struct InventoryCyclesDTO: Decodable {
    let success: Bool?
    let cycles: [InventoryCycleDTO]?
}

// MARK: - جلسة جرد (inventory_sessions) وعناصرها (inventory_items)
struct InventorySessionDTO: Decodable, Identifiable {
    let id: Int?
    let cycleId: Int?
    let teamName: String?
    let conductorName: String?
    let status: String?
    let startedAt: String?
    let submittedAt: String?
    let approvedAt: String?
    let approvedBy: String?

    enum CodingKeys: String, CodingKey {
        case id, status
        case cycleId = "cycle_id"
        case teamName = "team_name"
        case conductorName = "conductor_name"
        case startedAt = "started_at"
        case submittedAt = "submitted_at"
        case approvedAt = "approved_at"
        case approvedBy = "approved_by"
    }
}

struct InventoryItemDTO: Decodable, Identifiable {
    let id: Int?
    let sessionId: Int?
    let assetId: Int?
    let result: String?             // ok|damaged|missing|replaced|needs_review
    let reason: String?
    let serialSeen: String?
    let locationNote: String?
    let replacementAssetId: Int?
    let discovered: Int?
    // إثراء JOIN assets في getBySession
    let assetCode: String?
    let typeName: String?
    let originalName: String?
    let serialNumber: String?
    let baselineStatus: String?

    enum CodingKeys: String, CodingKey {
        case id, result, reason, discovered
        case sessionId = "session_id"
        case assetId = "asset_id"
        case serialSeen = "serial_seen"
        case locationNote = "location_note"
        case replacementAssetId = "replacement_asset_id"
        case assetCode = "asset_code"
        case typeName = "type_name"
        case originalName = "original_name"
        case serialNumber = "serial_number"
        case baselineStatus = "baseline_status"
    }
}

// GET /api/assets/inventory/sessions/:id
struct InventorySessionDetailDTO: Decodable {
    let success: Bool?
    let session: InventorySessionDTO?
    let cycle: InventoryCycleDTO?
    let expected: [AssetDTO]?
    let items: [InventoryItemDTO]?
    let statusLabels: [String: String]?

    enum CodingKeys: String, CodingKey {
        case success, session, cycle, expected, items
        case statusLabels = "status_labels"
    }
}

// GET /api/assets/inventory/sessions/:id/review
struct InventoryReviewDTO: Decodable {
    struct SerialChange: Decodable, Identifiable {
        let assetCode: String?
        let from: String?
        let to: String?
        var id: String { assetCode ?? UUID().uuidString }

        enum CodingKeys: String, CodingKey {
            case assetCode = "asset_code"
            case from, to
        }
    }

    let success: Bool?
    let session: InventorySessionDTO?
    let items: [InventoryItemDTO]?
    let byResult: [String: Int]?
    let unchecked: [AssetDTO]?
    let discovered: [InventoryItemDTO]?
    let serialChanges: [SerialChange]?
    let statusLabels: [String: String]?

    enum CodingKeys: String, CodingKey {
        case success, session, items, byResult, unchecked, discovered, serialChanges
        case statusLabels = "status_labels"
    }
}

// MARK: - فروقات (computeDiscrepancies)
struct DiscrepancyCaseDTO: Decodable, Identifiable {
    let key: String?
    let category: String?           // missing|moved|duplicate_serial|serial_changed|unchecked|damaged
    let priority: String?           // high|medium
    let suggestedAction: String?    // document_missing|transfer|review|review_group
    let assetId: Int?
    let assetCode: String?
    let typeName: String?
    let serialNumber: String?
    let status: String?
    let teamName: String?
    let centerName: String?
    let serialSeen: String?
    let serialFrom: String?
    let raisedAt: String?
    let explanation: String?
    let foundTeam: String?
    let foundNote: String?

    var id: String { key ?? "\(category ?? "؟")|\(assetCode ?? "؟")|\(raisedAt ?? "")" }

    enum CodingKeys: String, CodingKey {
        case key, category, priority, status, explanation
        case suggestedAction = "suggested_action"
        case assetId = "asset_id"
        case assetCode = "asset_code"
        case typeName = "type_name"
        case serialNumber = "serial_number"
        case teamName = "team_name"
        case centerName = "center_name"
        case serialSeen = "serial_seen"
        case serialFrom = "serial_from"
        case raisedAt = "raised_at"
        case foundTeam = "found_team"
        case foundNote = "found_note"
    }
}

struct DiscrepanciesDTO: Decodable {
    let success: Bool?
    let generatedAt: String?
    let cases: [DiscrepancyCaseDTO]?
    let categoryLabels: [String: String]?
    let actionLabels: [String: String]?
    let statusLabels: [String: String]?

    enum CodingKeys: String, CodingKey {
        case success, cases
        case generatedAt = "generated_at"
        case categoryLabels = "category_labels"
        case actionLabels = "action_labels"
        case statusLabels = "status_labels"
    }
}

// MARK: - طلبات الكتابة (أسماء الحقول مطابقة لـserver.js حرفيًا)

struct InventoryCycleCreateRequestDTO: Encodable {
    let label: String
    let periodStart: String?
    let periodEnd: String?

    enum CodingKeys: String, CodingKey {
        case label
        case periodStart = "period_start"
        case periodEnd = "period_end"
    }
}

struct InventoryItemRequestDTO: Encodable {
    let assetId: Int
    let result: String
    let reason: String?
    let serialSeen: String?
    let locationNote: String?
    let discovered: Bool?

    enum CodingKeys: String, CodingKey {
        case result, reason, discovered
        case assetId = "asset_id"
        case serialSeen = "serial_seen"
        case locationNote = "location_note"
    }
}

struct DiscoveredAssetRequestDTO: Encodable {
    let typeName: String
    let originalName: String?
    let serialNumber: String?
    let reason: String?
    let locationNote: String?
    let notes: String?

    enum CodingKeys: String, CodingKey {
        case reason, notes
        case typeName = "type_name"
        case originalName = "original_name"
        case serialNumber = "serial_number"
        case locationNote = "location_note"
    }
}

struct AssetTransferRequestDTO: Encodable {
    let toTeam: String
    let toCenter: String?
    let reason: String

    enum CodingKeys: String, CodingKey {
        case reason
        case toTeam = "to_team"
        case toCenter = "to_center"
    }
}

struct AssetResolveReviewRequestDTO: Encodable {
    let note: String
    let outcome: String?
}

struct AssetDocumentMissingRequestDTO: Encodable {
    let reason: String
}

struct SerialGroupResolveRequestDTO: Encodable {
    let serial: String
    let note: String
}

// MARK: - استجابات الكتابة
struct AssetWriteResponseDTO: Decodable {
    let success: Bool?
    let id: Int?                  // إنشاء دورة
    let sessions: Int?            // تفعيل دورة
    let items: Int?               // إرسال جلسة
    let created: Int?             // اعتماد استيراد
    let batch: Int?               // دفعة استيراد
    let itemId: Int?
    let assetCode: String?
    let resolved: Int?
    let warning: String?

    enum CodingKeys: String, CodingKey {
        case success, id, sessions, items, created, batch, resolved, warning
        case itemId = "item_id"
        case assetCode = "asset_code"
    }
}

// MARK: - GET /api/assets/import/preview (معاينة دفعة الاستيراد)
struct AssetImportPreviewDTO: Decodable {
    let success: Bool?
    let batch: Int?
    let total: Int?
    let sourceFile: String?

    enum CodingKeys: String, CodingKey {
        case success, batch, total
        case sourceFile = "source_file"
    }
}
