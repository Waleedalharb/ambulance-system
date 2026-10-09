//
//  SupplementaryTests.swift
//  EMSOperationsTests
//
//  اختبارات «الجدول المرن» (المناوبة التكميلية — معتمد 2026-10-08):
//  فك عقد candidates/unavailable (CPD/CPN)، ترجمة reason codes مع fallback
//  آمن، منطق الاختيار (يوم واحد/تاريخ + السعة من limits العقد)، جسم التقديم
//  snake_case، عرض الحالات السبع، تعيين أخطاء 401/403/503، وضمان عدم ظهور
//  المختار كمناوبة رسمية قبل applied. لا شبكة — نماذج ومنطق نقي فقط.
//

import XCTest
@testable import EMSOperations

final class SupplementaryTests: XCTestCase {

    // MARK: - فك عقد المقترحات (CPD صباحية / CPN ليلية)

    private let candidatesJSON = #"""
{
        "success": true,
        "month": "2026-10",
        "limits": { "max_per_month": 10, "used": 3 },
        "hours": { "required_hours": 168, "worked_hours": 192, "remaining_hours": -24 },
        "candidates": [
            { "date": "2026-10-12", "shift_code": "CPN", "shift_name": "تكميلية ليلية",
              "time_start": "17:00", "time_end": "05:00", "duration_hours": 12,
              "period": "night", "coverage_gap": true },
            { "date": "2026-10-14", "shift_code": "CPD", "shift_name": "تكميلية صباحية",
              "time_start": "05:00", "time_end": "17:00", "duration_hours": 12,
              "period": "day", "coverage_gap": false }
        ],
        "unavailable": [
            { "date": "2026-10-10", "shift_code": "CPN",
              "reasons": ["MULTIPLE_SHIFTS_SAME_DAY"] },
            { "date": "2026-10-15", "shift_code": "CPD",
              "reasons": ["REST_BELOW_MINIMUM"] }
        ]
    }
"""#

    func testCandidatesDTODecodesCPDAndCPN() throws {
        let dto = try JSONDecoder().decode(SupplementaryCandidatesDTO.self, from: Data(candidatesJSON.utf8))
        XCTAssertEqual(dto.month, "2026-10")
        XCTAssertEqual(dto.limits?.maxPerMonth, 10)
        XCTAssertEqual(dto.limits?.used, 3)
        XCTAssertEqual(dto.hours?.requiredHours, 168)
        XCTAssertEqual(dto.candidates.count, 2)

        let cpn = dto.candidates[0]
        XCTAssertEqual(cpn.shiftCode, "CPN")
        XCTAssertEqual(cpn.shiftName, "تكميلية ليلية")
        XCTAssertEqual(cpn.timeStart, "17:00")
        XCTAssertEqual(cpn.timeEnd, "05:00")
        XCTAssertEqual(cpn.durationHours, 12)
        XCTAssertTrue(cpn.isNight)
        XCTAssertEqual(cpn.coverageGap, true)

        let cpd = dto.candidates[1]
        XCTAssertEqual(cpd.shiftCode, "CPD")
        XCTAssertFalse(cpd.isNight)
        XCTAssertEqual(cpd.coverageGap, false)
    }

    func testUnavailableDecodesReasonCodes() throws {
        let dto = try JSONDecoder().decode(SupplementaryCandidatesDTO.self, from: Data(candidatesJSON.utf8))
        XCTAssertEqual(dto.unavailable.count, 2)
        XCTAssertEqual(dto.unavailable[0].reasons, ["MULTIPLE_SHIFTS_SAME_DAY"])
        XCTAssertEqual(dto.unavailable[1].reasons, ["REST_BELOW_MINIMUM"])
    }

    func testCandidatesDTOToleratesMissingOptionalBlocks() throws {
        // بلا limits/hours — العقد يسمح بغيابها (معلومات توجيهية فقط)
        let json = #"{"success": true, "month": "2026-10", "candidates": [], "unavailable": []}"#
        let dto = try JSONDecoder().decode(SupplementaryCandidatesDTO.self, from: Data(json.utf8))
        XCTAssertNil(dto.limits)
        XCTAssertNil(dto.hours)
        XCTAssertTrue(dto.candidates.isEmpty)
    }

    // MARK: - ترجمة reason codes + fallback آمن

    func testKnownReasonCodesTranslate() {
        XCTAssertEqual(SupplementaryReasonText.message(for: "REST_BELOW_MINIMUM"), "لا يحقق فترة الراحة المطلوبة")
        XCTAssertEqual(SupplementaryReasonText.message(for: "COVERAGE_BELOW_MINIMUM"), "التغطية التشغيلية لا تسمح")
        XCTAssertEqual(SupplementaryReasonText.message(for: "CONSECUTIVE_NIGHTS_EXCEEDED"), "يتجاوز الحد المسموح للمناوبات الليلية المتتالية")
    }

    func testUnknownReasonCodeFallsBackSafely() {
        // code غير معروف يُعرض كما هو — لا حذف للخيار ولا افتراض معنى
        XCTAssertEqual(SupplementaryReasonText.message(for: "SOME_FUTURE_CODE"), "SOME_FUTURE_CODE")
    }

    // MARK: - منطق الاختيار (Local UI State)

    func testSelectionToggleSelectsAndDeselects() {
        var sel = SupplementarySelection(capacity: nil)
        sel.toggle(date: "2026-10-12", shiftCode: "CPN")
        XCTAssertTrue(sel.isSelected(date: "2026-10-12", shiftCode: "CPN"))
        XCTAssertEqual(sel.count, 1)
        sel.toggle(date: "2026-10-12", shiftCode: "CPN")
        XCTAssertTrue(sel.isEmpty)
    }

    func testSelectionReplacesWithinSameDate() {
        // العقد: طلب حيٌّ واحد لكل يوم — اختيار CPD بعد CPN لنفس اليوم يستبدله
        var sel = SupplementarySelection(capacity: nil)
        sel.toggle(date: "2026-10-12", shiftCode: "CPN")
        sel.toggle(date: "2026-10-12", shiftCode: "CPD")
        XCTAssertEqual(sel.count, 1)
        XCTAssertTrue(sel.isSelected(date: "2026-10-12", shiftCode: "CPD"))
        XCTAssertFalse(sel.isSelected(date: "2026-10-12", shiftCode: "CPN"))
    }

    func testMultipleSelectionRespectsCapacityFromContract() {
        // السعة = max_per_month - used = 10 - 3 = 7 — لا رقم ثابت في iOS
        var sel = SupplementarySelection(capacity: 7)
        for day in 12...18 {
            sel.toggle(date: "2026-10-\(day)", shiftCode: "CPD")
        }
        XCTAssertEqual(sel.count, 7)
        sel.toggle(date: "2026-10-19", shiftCode: "CPD") // فوق السعة — يُتجاهل
        XCTAssertEqual(sel.count, 7)
        XCTAssertFalse(sel.isSelected(date: "2026-10-19", shiftCode: "CPD"))
        // الاستبدال ضمن يوم مختار يبقى مسموحًا حتى عند بلوغ السعة
        sel.toggle(date: "2026-10-12", shiftCode: "CPN")
        XCTAssertTrue(sel.isSelected(date: "2026-10-12", shiftCode: "CPN"))
    }

    func testZeroCapacityBlocksNewSelections() {
        var sel = SupplementarySelection(capacity: 0)
        sel.toggle(date: "2026-10-12", shiftCode: "CPD")
        XCTAssertTrue(sel.isEmpty)
    }

    // MARK: - جسم التقديم يطابق العقد (snake_case)

    func testSubmitBodyEncodesSnakeCase() throws {
        let body = SupplementarySubmitBody(targetDate: "2026-10-12", shiftCode: "CPN")
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: String]
        XCTAssertEqual(obj?["target_date"], "2026-10-12")
        XCTAssertEqual(obj?["shift_code"], "CPN")
        XCTAssertNil(obj?["targetDate"])
    }

    func testSubmitResponseDecodesPendingAndRejected() throws {
        let pending = try JSONDecoder().decode(SupplementarySubmitResponseDTO.self,
            from: Data(#"{"success": true, "id": 7, "status": "pending_review"}"#.utf8))
        XCTAssertEqual(pending.status, "pending_review")
        XCTAssertEqual(pending.id, 7)

        let rejected = try JSONDecoder().decode(SupplementarySubmitResponseDTO.self,
            from: Data(#"{"success": true, "id": 8, "status": "rejected", "reasons": ["REST_BELOW_MINIMUM"]}"#.utf8))
        XCTAssertEqual(rejected.status, "rejected")
        XCTAssertEqual(rejected.reasons, ["REST_BELOW_MINIMUM"])
    }

    // MARK: - الحالات السبع + isApplied (القاعدة الذهبية)

    func testAllSevenStatusesDisplay() {
        let expected: [String: String] = [
            "pending_review": "بانتظار المراجعة",
            "approved": "معتمد — بانتظار التطبيق",
            "applied": "مطبَّق في الجدول",
            "rejected": "مرفوض",
            "cancelled": "ملغى",
            "expired": "منتهي",
            "escalated": "مصعَّد للمراجعة"
        ]
        for (raw, title) in expected {
            XCTAssertEqual(SupplementaryStatusDisplay.title(for: raw), title, raw)
        }
        // حالة غير معروفة تُعرض بنصها الخام — لا افتراض معنى
        XCTAssertEqual(SupplementaryStatusDisplay.title(for: "future_status"), "future_status")
    }

    func testRequestDecodesAndIsAppliedGate() throws {
        // القاعدة: لا يُعامل كمناوبة رسمية إلا applied — pending/approved لا
        let json = #"""
{"success": true, "requests": [
            { "id": 1, "target_date": "2026-10-12", "shift_code": "CPN", "status": "pending_review", "team_name": "جنوب 1" },
            { "id": 2, "target_date": "2026-10-13", "shift_code": "CPD", "status": "approved" },
            { "id": 3, "target_date": "2026-10-14", "shift_code": "CPD", "status": "applied", "roster_id": 55, "applied_at": "2026-10-10 12:00:00" },
            { "id": 4, "target_date": "2026-10-15", "shift_code": "CPD", "status": "rejected", "review_note": "التغطية لا تسمح" }
        ]}
"""#
        let dto = try JSONDecoder().decode(SupplementaryRequestsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(dto.requests.count, 4)
        XCTAssertFalse(dto.requests[0].isApplied)
        XCTAssertFalse(dto.requests[1].isApplied)   // approved ≠ مطبَّق — المصدر النهائي الجدول الرسمي
        XCTAssertTrue(dto.requests[2].isApplied)
        XCTAssertEqual(dto.requests[2].rosterId, 55)
        XCTAssertEqual(dto.requests[3].reviewNote, "التغطية لا تسمح")
        XCTAssertTrue(dto.requests[0].isCancellable)
        XCTAssertFalse(dto.requests[2].isCancellable)
    }

    // MARK: - تعيين أخطاء الشبكة لحالات القسم (401/403/503)

    func testForbiddenMapsToForbiddenState() {
        XCTAssertEqual(SupplementaryViewModel.stateForError(APIError.forbidden), .forbidden)
    }

    func testConfigMissing503MapsToFriendlyState() {
        let err = APIError.serverWithCode("خدمة المناوبة التكميلية غير مهيأة", "SUPP_CONFIG_MISSING")
        XCTAssertEqual(SupplementaryViewModel.stateForError(err), .configMissing)
    }

    func testOtherServerCodesMapToFailedWithMessage() {
        let err = APIError.serverWithCode("بلغت الحد الشهري", "SUPP_MONTHLY_LIMIT")
        XCTAssertEqual(SupplementaryViewModel.stateForError(err), .failed("بلغت الحد الشهري"))
    }

    func testUnauthenticatedMapsToFailedWithSessionMessage() {
        // 401 تُدار جلستها عالميًا (authFailureHandler) — والقسم يعرض رسالة مفهومة
        XCTAssertEqual(SupplementaryViewModel.stateForError(APIError.unauthenticated),
                       .failed(APIError.unauthenticated.userMessage))
    }

    func testOfflineMapsToFailedWithRetryMessage() {
        XCTAssertEqual(SupplementaryViewModel.stateForError(APIError.offline),
                       .failed(APIError.offline.userMessage))
    }

    // MARK: - APIError الجديدة (serverWithCode)

    func testServerWithCodeUserMessage() {
        XCTAssertEqual(APIError.serverWithCode("رسالة الخادم", "X").userMessage, "رسالة الخادم")
        XCTAssertEqual(APIError.serverWithCode("", "X").userMessage, APIError.server("").userMessage)
    }

    // MARK: - انحدار 2026-10-08: weekdayName — الأيام السبعة (خلل «الثلاثاء» المفقود)

    /// الأسبوع 2026-10-04 (أحد) … 2026-10-10 (سبت) — السبت هو الذي كان يحطم
    /// «مناوبتي» بفهرس خارج الحدود، والثلاثاء كان يُسمّى خطأً.
    private let weekCases: [(String, String)] = [
        ("2026-10-04", "الأحد"),
        ("2026-10-05", "الاثنين"),
        ("2026-10-06", "الثلاثاء"),
        ("2026-10-07", "الأربعاء"),
        ("2026-10-08", "الخميس"),
        ("2026-10-09", "الجمعة"),
        ("2026-10-10", "السبت")
    ]

    @MainActor
    func testScheduleViewModelWeekdayNamesAllSevenDays() {
        let vm = ScheduleViewModel()
        for (date, expected) in weekCases {
            XCTAssertEqual(vm.weekdayName(date), expected, date)
        }
    }

    @MainActor
    func testSupplementaryViewModelWeekdayNamesAllSevenDays() {
        let vm = SupplementaryViewModel()
        for (date, expected) in weekCases {
            XCTAssertEqual(vm.weekdayName(date), expected, date)
        }
    }
}
