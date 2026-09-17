//
//  EMSOperationsTests.swift
//  EMSOperationsTests
//
//  اختبارات وحدات أساسية: فك DTOs + توجيه DeepLink + رسائل الأخطاء.
//  لا شبكة ولا Keychain — نماذج ومنطق نقي فقط.
//

import XCTest
@testable import EMSOperations

final class EMSOperationsTests: XCTestCase {

    // MARK: - AuthUser: فك مرن للـid (نص أو رقم)

    func testAuthUserDecodesNumericId() throws {
        let json = #"{"id": 42, "username": "u1", "name": "موظف", "role": "user"}"#.data(using: .utf8)!
        let user = try JSONDecoder().decode(AuthUser.self, from: json)
        XCTAssertEqual(user.id, "42")
        XCTAssertEqual(user.name, "موظف")
        XCTAssertEqual(user.role, "user")
    }

    func testAuthUserDecodesStringId() throws {
        let json = #"{"id": "abc", "name": "موظف", "role": "admin"}"#.data(using: .utf8)!
        let user = try JSONDecoder().decode(AuthUser.self, from: json)
        XCTAssertEqual(user.id, "abc")
        XCTAssertNil(user.username)
    }

    // MARK: - LoginResponse

    func testLoginResponseDecodes() throws {
        let json = #"{"success": true, "accessToken": "a", "refreshToken": "r", "user": {"id": 1, "name": "ن", "role": "user"}}"#.data(using: .utf8)!
        let res = try JSONDecoder().decode(LoginResponse.self, from: json)
        XCTAssertTrue(res.success)
        XCTAssertEqual(res.accessToken, "a")
        XCTAssertEqual(res.user.id, "1")
    }

    // MARK: - ScheduleDTO

    func testScheduleDTODecodesDays() throws {
        let json = #"{"month": 9, "year": 2026, "days": [{"date": "2026-09-01", "shiftCode": "M", "shiftName": "صباحية", "teamName": "جنوب 1"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ScheduleDTO.self, from: json)
        XCTAssertEqual(dto.month, 9)
        XCTAssertEqual(dto.days.count, 1)
        XCTAssertEqual(dto.days[0].teamName, "جنوب 1")
    }

    // MARK: - Notifications: حالات read/ack

    func testNotificationStatusHelpers() throws {
        let json = #"{"notifications": [{"id": 1, "message": "m", "status": "acknowledged"}, {"id": 2, "message": "m", "status": "unread"}], "unreadCount": 1}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(PortalNotificationsDTO.self, from: json)
        XCTAssertTrue(dto.notifications[0].isAcked)
        XCTAssertTrue(dto.notifications[0].isRead)
        XCTAssertFalse(dto.notifications[1].isRead)
        XCTAssertEqual(dto.unreadCount, 1)
    }

    // MARK: - VehicleDTO: مفاتيح snake_case

    func testVehicleDTODecodesSnakeCase() throws {
        let json = #"{"vehicles": [{"id": 7, "name": "إسعاف 3", "call_sign": "S3", "plate_number": "1234", "status": "ready"}], "available": true}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(VehicleDTO.self, from: json)
        XCTAssertEqual(dto.vehicles?.first?.callSign, "S3")
        XCTAssertEqual(dto.vehicles?.first?.plateNumber, "1234")
        XCTAssertEqual(dto.vehicles?.first?.displayName, "إسعاف 3")
    }

    // MARK: - CheckSessionDTO: الحالات الخاصة

    func testCheckSessionNoAssignment() throws {
        let json = #"{"state": "no_assignment", "today": "2026-09-17"}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(CheckSessionDTO.self, from: json)
        XCTAssertEqual(dto.state, "no_assignment")
        XCTAssertNil(dto.session)
    }

    func testCheckSessionWithItems() throws {
        let json = #"{"team": {"id": 1, "name": "جنوب 1"}, "session": {"id": 9, "status": "open", "items": [{"item_key": "oxygen", "label": "الأكسجين"}]}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(CheckSessionDTO.self, from: json)
        XCTAssertNil(dto.state)
        XCTAssertEqual(dto.session?.items?.first?.itemKey, "oxygen")
        XCTAssertEqual(dto.session?.items?.first?.label, "الأكسجين")
    }

    // MARK: - CheckItemRequest: ترميز snake_case

    func testCheckItemRequestEncodesSnakeCase() throws {
        let body = CheckItemRequest(itemKey: "oxygen", result: "ok", note: nil)
        let data = try JSONEncoder().encode(body)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["item_key"] as? String, "oxygen")
        XCTAssertEqual(obj?["result"] as? String, "ok")
        XCTAssertNil(obj?["note"])
    }

    // MARK: - DeepLinkRouter

    @MainActor
    func testDeepLinkRouterScheduleChange() {
        let router = DeepLinkRouter()
        router.route(kind: "schedule_change")
        XCTAssertEqual(router.pending?.destination, .scheduleChanges)
    }

    @MainActor
    func testDeepLinkRouterDefault() {
        let router = DeepLinkRouter()
        router.route(kind: "announcement")
        XCTAssertEqual(router.pending?.destination, .notifications)
        router.route(kind: nil)
        XCTAssertEqual(router.pending?.destination, .notifications)
    }

    // MARK: - APIError: رسائل عربية غير فارغة

    func testAPIErrorMessagesAreArabicAndNonEmpty() {
        let cases: [APIError] = [
            .offline, .timeout, .unauthenticated, .forbidden,
            .noEmployee, .notFound, .decoding, .unknown,
            .badRequest("سبب"), .server("HTTP 500")
        ]
        for error in cases {
            XCTAssertFalse(error.userMessage.isEmpty, "\(error) يجب أن يحمل رسالة")
        }
        XCTAssertEqual(APIError.badRequest("سبب").userMessage, "سبب")
        XCTAssertEqual(APIError.badRequest("").userMessage, "بيانات غير مكتملة.")
    }

    // MARK: - MePermissionsDTO: مفاتيح snake_case (mePayload)

    func testMePermissionsDTODecodes() throws {
        let json = #"{"role": "user", "role_label": "مستخدم", "permissions": ["ops.my_portal", "ops.completion"], "permissions_star": false, "permissions_granted": ["ops.my_portal"], "permissions_revoked": []}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(MePermissionsDTO.self, from: json)
        XCTAssertEqual(dto.roleLabel, "مستخدم")
        XCTAssertEqual(dto.permissions?.count, 2)
        XCTAssertEqual(dto.permissionsStar, false)
    }

    // MARK: - PermissionMapper (v2 قسم 6 — خرائط القدرات)

    func testPermissionMapperStarGrantsEverything() {
        XCTAssertTrue(PermissionMapper.canAccessEmployeePortal([], star: true))
        XCTAssertTrue(PermissionMapper.canAccessOperations([], star: true))
        XCTAssertTrue(PermissionMapper.canViewIndicators([], star: true))
        XCTAssertTrue(PermissionMapper.canViewPhones([], star: true))
    }

    func testPermissionMapperEmployeePortalKey() {
        XCTAssertTrue(PermissionMapper.canAccessEmployeePortal(["ops.my_portal"], star: false))
        XCTAssertFalse(PermissionMapper.canAccessEmployeePortal(["ops.reports"], star: false))
        XCTAssertFalse(PermissionMapper.canAccessEmployeePortal([], star: false))
    }

    func testPermissionMapperOperationsKeys() {
        XCTAssertTrue(PermissionMapper.canAccessOperations(["ops.dispatch"], star: false))
        XCTAssertTrue(PermissionMapper.canAccessOperations(["ops.execute"], star: false))
        XCTAssertFalse(PermissionMapper.canAccessOperations(["ops.my_portal"], star: false))
        XCTAssertFalse(PermissionMapper.canAccessOperations(["schedule.view"], star: false))
    }

    func testPermissionMapperIndicatorsAndPhones() {
        XCTAssertTrue(PermissionMapper.canViewIndicators(["indicators.contribution"], star: false))
        XCTAssertFalse(PermissionMapper.canViewIndicators(["ops.reports"], star: false))
        XCTAssertTrue(PermissionMapper.canViewPhones(["staff.phone_view"], star: false))
        XCTAssertFalse(PermissionMapper.canViewPhones([], star: false))
    }

    // MARK: - ScheduleChangesDTO: فك Before/After (v2 قسم 13)

    func testScheduleChangesDTODecodes() throws {
        let json = #"{"changes": [{"id": 5, "date": "2026-09-20", "oldShiftCode": "D", "newShiftCode": "N", "oldTeam": "جنوب 4", "newTeam": "جنوب 7", "changeLabel": "تعديل", "reason": "تغطية", "revisionId": 12}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ScheduleChangesDTO.self, from: json)
        let change = try XCTUnwrap(dto.changes.first)
        XCTAssertEqual(change.oldTeam, "جنوب 4")
        XCTAssertEqual(change.newTeam, "جنوب 7")
        XCTAssertEqual(change.revisionId, 12)
    }

    // MARK: - AssignmentsDTO: فك مرن

    func testAssignmentsDTOToleratesMissingFields() throws {
        let json = #"{"periods": [{"date": "2026-09-21"}], "available": true}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(AssignmentsDTO.self, from: json)
        XCTAssertEqual(dto.periods?.count, 1)
        XCTAssertNil(dto.periods?.first?.teamName)
    }
}
