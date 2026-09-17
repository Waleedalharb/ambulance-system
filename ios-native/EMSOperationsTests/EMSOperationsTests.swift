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

    // MARK: - OpsDTO: نماذج وحدة العمليات (تفعيل المنصة الأصلية)

    func testOpsTeamsDTODecodesSnakeCase() throws {
        let json = #"{"success": true, "teams": [{"id": 3, "name": "جنوب 2", "center": "مركز النرجس", "team_type": "ميداني", "sort_order": 2, "is_active": 1, "requiredPersonnel": 2}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(OpsTeamsDTO.self, from: json)
        let team = try XCTUnwrap(dto.teams?.first)
        XCTAssertEqual(team.teamId, 3)
        XCTAssertEqual(team.name, "جنوب 2")
        XCTAssertEqual(team.teamType, "ميداني")
        XCTAssertEqual(team.isActive, 1)
        XCTAssertEqual(team.requiredPersonnel, 2)
    }

    func testStaffingStateDTODecodesTeamsDictionary() throws {
        let json = #"{"success": true, "shiftId": 41, "teams": {"جنوب 10": {"status": "missing", "activeCount": 1, "requiredPersonnel": 2, "vacant": 1, "absentees": [{"name": "م", "type": "late"}]}, "جنوب 2": {"status": "ready", "activeCount": 2, "requiredPersonnel": 2, "vehicleOk": true}}, "workforce": {"totalStaff": 3, "totalRequired": 4, "readyTeams": 1, "missingTeams": 1, "operationalReadinessRate": 50}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(StaffingStateDTO.self, from: json)
        XCTAssertEqual(dto.shiftId, 41)
        XCTAssertEqual(dto.teams?["جنوب 2"]?.status, "ready")
        XCTAssertEqual(dto.teams?["جنوب 10"]?.absentees?.first?.type, "late")
        XCTAssertEqual(dto.workforce?.operationalReadinessRate, 50)
        // الفرز الطبيعي: جنوب 2 قبل جنوب 10
        XCTAssertEqual(dto.sortedTeamNames, ["جنوب 2", "جنوب 10"])
    }

    func testVehiclesBoardDTODecodesCountersAndSupport() throws {
        let json = #"{"success": true, "shiftId": 41, "counters": {"active": 8, "reserve": 2, "breakdown": 1, "out_of_service": 1, "unset": 0}, "vehicles": [{"id": "veh_000001", "name": "911", "status": "active", "inWorkshop": false, "teamId": 5}], "unassigned": [{"id": "veh_000009", "name": "احتياط 1", "status": null, "inWorkshop": true}], "support": [{"vehicleId": "veh_000003", "name": "912", "homeTeamId": 3, "targetTeamId": 7, "since": "2026-09-18T08:00:00Z"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(VehiclesBoardDTO.self, from: json)
        XCTAssertEqual(dto.counters?.outOfService, 1)
        let v = try XCTUnwrap(dto.vehicles?.first)
        XCTAssertEqual(v.vehicleId, "veh_000001")
        XCTAssertEqual(v.teamId, 5)
        XCTAssertEqual(v.displayName, "911")
        let s = try XCTUnwrap(dto.support?.first)
        XCTAssertEqual(s.homeTeamId, 3)
        XCTAssertEqual(s.targetTeamId, 7)
        XCTAssertEqual(dto.unassigned?.first?.inWorkshop, true)
    }

    func testTimelineDTODecodesItems() throws {
        let json = #"{"success": true, "data": [{"title": "استلام المناوبة", "desc": "تم", "type": "event", "date": "2026-09-18", "time": "07:00"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(TimelineDTO.self, from: json)
        let item = try XCTUnwrap(dto.data?.first)
        XCTAssertEqual(item.title, "استلام المناوبة")
        XCTAssertEqual(item.type, "event")
    }

    func testCenterGeoDTODecodesCoordinates() throws {
        let json = #"{"success": true, "data": {"مركز النرجس": {"center": [24.8132, 46.6931], "radius": 3000}}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(CenterGeoDTO.self, from: json)
        let center = try XCTUnwrap(dto.data?["مركز النرجس"])
        XCTAssertEqual(center.center?.count, 2)
        XCTAssertEqual(center.center?.first, 24.8132)
        XCTAssertEqual(center.radius, 3000)
    }

    func testSmartAssessmentDTODecodesEngineOutput() throws {
        let json = #"{"success": true, "data": {"generatedAt": "2026-09-18T09:00:00Z", "shift": {"id": 41, "type": "صباحية", "date": "2026-09-18", "status": "active"}, "shiftPhase": "early", "readiness": {"percent": 85, "status": "attention"}, "risks": [{"code": "TEAM_MISSING", "severity": "critical", "team": "جنوب 4", "title": "جنوب 4 ينقصها فرد", "detail": "الغياب المفتوح: م"}], "recommendations": [{"code": "ASSIGN_SUPPORT", "priority": 2, "title": "إسناد دعم", "action": "إسناد داعم لفريق جنوب 4"}], "proactive": [{"code": "LATE_GRACE", "text": "جنوب 2 بانتظار متأخر"}], "summary": "جاهزية 85٪", "supportCount": 3}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SmartAssessmentDTO.self, from: json)
        let a = try XCTUnwrap(dto.data)
        XCTAssertEqual(a.readiness?.percent, 85)
        XCTAssertEqual(a.readiness?.status, "attention")
        XCTAssertEqual(a.risks?.first?.severity, "critical")
        XCTAssertEqual(a.recommendations?.first?.priority, 2)
        XCTAssertEqual(a.supportCount, 3)
    }

    func testCurrentShiftDTODecodesNoneState() throws {
        let json = #"{"success": true, "shift": {"id": null, "status": "none"}, "serverNow": "2026-09-18T06:00:00Z", "prepShift": {"type": "صباحية", "date": "2026-09-18"}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(CurrentShiftDTO.self, from: json)
        XCTAssertEqual(dto.shift?.status, "none")
        XCTAssertNil(dto.shift?.id)
        XCTAssertEqual(dto.prepShift?.type, "صباحية")
    }
}
