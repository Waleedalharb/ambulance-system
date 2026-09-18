//
//  FormsOpsDTO.swift
//  EMSOperations
//
//  نماذج مجال النماذج التشغيلية (docs/native-ios-platform-parity.md §12) —
//  incidents / escalations / e-cases / daily-reports / senior-shifts عبر
//  FormsService (عقد حر — السجلات تُدار خامًا للحفاظ على حقول الويب).
//  بحث CAD (incidents/lookup) نموذج مثبت لأنه بوابة التحقق قبل الحفظ.
//

import Foundation

// MARK: - GET /api/incidents/lookup — بحث CAD الخفيف (ops.forms)
struct IncidentLookupDTO: Decodable {
    struct Incident: Decodable {
        let number: String?
        let code: String?
        let type: String?
        let cadCreatedAtRaw: String?
        let status: String?
        let address: String?
        let district: String?
        let street: String?
        let city: String?
        let description: String?
        let lat: Double?
        let lng: Double?
    }
    struct Unit: Decodable, Identifiable {
        var id: String { unit ?? UUID().uuidString }
        let unit: String?
        let respArrivalMin: Double?
        let respMubasharaMin: Double?
        let counted: Bool?
    }
    struct TimeCompleteness: Decodable {
        let state: String?        // complete | partial | missing
        let missing: [String]?
    }
    let success: Bool?
    let found: Bool?
    let number: String?
    let shiftId: Int?
    let incident: Incident?
    let units: [Unit]?
    let bestArrivalMin: Double?
    let timeCompleteness: TimeCompleteness?
}

// MARK: - عرض السجلات الحرة — إسقاط متسامح من مفاتيح العقد الحر
/// سجل نموذج خام (من getRaw) مع إسقاط عرضي: عنوان + صفوف معلومات
/// مرتبة بترجمة عربية للمفاتيح المعروفة. لا فكّ انتقائي يسقط حقولًا.
struct FormRecordItem: Identifiable {
    let id: String
    let title: String
    let rows: [(label: String, value: String)]

    /// الحقول المعروفة بترتيب عرض نموذج الويب لكل نوع — مطابقة لكائنات
    /// الحفظ في public/js/app.js (saveIncident/saveEscalation/saveECase/
    /// saveDailyReport/saveSenior). مصفوفة مرتبة لا قاموس (ترتيب العرض مهم).
    static let fieldLabels: [String: [(key: String, label: String)]] = [
        "incident": [
            ("reportNumber", "رقم البلاغ"), ("type", "النوع"), ("dateTime", "التاريخ والوقت"),
            ("location", "الموقع"), ("center", "المركز"), ("unit", "الفرقة"),
            ("patientName", "اسم المريض"), ("age", "العمر"), ("gender", "الجنس"),
            ("description", "الوصف"), ("actions", "الإجراءات")
        ],
        "escalation": [
            ("reportNumber", "رقم البلاغ"), ("eventType", "نوع الحدث"), ("dateTime", "التاريخ والوقت"),
            ("location", "الموقع"), ("injuries", "الإصابات"), ("deaths", "الوفيات"),
            ("agencies", "الجهات"), ("details", "التفاصيل")
        ],
        "e_case": [
            ("reportNumber", "رقم البلاغ"), ("dateTime", "التاريخ والوقت"), ("location", "الموقع"),
            ("unit", "الفرقة"), ("age", "العمر"), ("gender", "الجنس"),
            ("responseTime", "الاستجابة (د)"), ("hospital", "المستشفى"),
            ("outcome", "النتيجة"), ("notes", "ملاحظات")
        ],
        "daily_report": [
            ("reportNumber", "رقم التقرير"), ("date", "التاريخ"),
            ("responseTeams", "فرق الاستجابة"), ("air", "الإسعاف الجوي"),
            ("borderReports", "بلاغات الحدود"), ("paths", "المسارات"),
            ("formFill", "تعبئة النماذج"), ("summary", "الملخص")
        ],
        "senior_shift": [
            ("workingCars", "سيارات عاملة"), ("brokenCars", "متعطلة"), ("reserveCars", "احتياط"),
            ("overlapTeams", "فرق الأوفرلاب"), ("overlapAreas", "النطاقات"), ("notes", "ملاحظات"),
            ("asstName", "مساعد كبير المسعفين"), ("asstDate", "تاريخ المساعد"),
            ("chiefName", "كبير المسعفين"), ("chiefDate", "تاريخ الكبير"),
            ("cmdrName", "قائد القطاع"), ("cmdrDate", "تاريخ القائد")
        ]
    ]

    static func stringValue(_ v: Any?) -> String? {
        switch v {
        case let s as String: return s.isEmpty ? nil : s
        case let i as Int: return String(i)
        case let d as Double: return d.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(d)) : String(d)
        case let a as [Any]: return a.compactMap { stringValue($0) }.joined(separator: "، ")
        default: return nil
        }
    }

    static func from(_ dict: [String: Any], formType: String) -> FormRecordItem {
        let id = stringValue(dict["id"]) ?? UUID().uuidString
        var rows: [(label: String, value: String)] = []
        for field in fieldLabels[formType] ?? [] {
            if let v = stringValue(dict[field.key]) { rows.append((field.label, v)) }
        }
        let title = stringValue(dict["reportNumber"]).map { "بلاغ \($0)" }
            ?? stringValue(dict["date"]).map { "تقرير \($0)" }
            ?? stringValue(dict["asstName"]).map { "مناوبة كبار — \($0)" }
            ?? "سجل \(id)"
        return FormRecordItem(id: id, title: title, rows: rows)
    }
}
