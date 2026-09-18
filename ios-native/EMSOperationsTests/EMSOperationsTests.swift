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

    // MARK: - مجال الجداول (ScheduleOps)

    func testRosterMonthDTODecodesSnakeCase() throws {
        let json = #"{"success": true, "roster": [{"id": 7, "employee_id": 42, "team_id": 3, "shift_date": "2026-09-05", "shift_code": "M1", "month": 9, "year": 2026, "employee_name": "محمد", "employee_code": "E-1042", "team_name": "جنوب 2"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(RosterMonthDTO.self, from: json)
        let e = try XCTUnwrap(dto.roster?.first)
        XCTAssertEqual(e.id, 7)
        XCTAssertEqual(e.employeeId, 42)
        XCTAssertEqual(e.shiftDate, "2026-09-05")
        XCTAssertEqual(e.shiftCode, "M1")
        XCTAssertEqual(e.employeeCode, "E-1042")
        XCTAssertEqual(e.teamName, "جنوب 2")
        XCTAssertEqual(e.stableId, "7")
    }

    func testRosterEntryStableIdFallsBackWithoutId() throws {
        let json = #"{"employee_id": 42, "shift_date": "2026-09-05", "shift_code": "M1"}"#.data(using: .utf8)!
        let e = try JSONDecoder().decode(RosterMonthDTO.Entry.self, from: json)
        XCTAssertNil(e.id)
        XCTAssertEqual(e.stableId, "42-2026-09-05")
    }

    func testShiftCodesDTODisplayLabel() throws {
        let json = #"{"success": true, "codes": [{"id": 1, "code": "M1", "name": "صباحية", "time_start": "07:00", "time_end": "19:00", "color": "#22c55e", "status": "active"}, {"id": 2, "code": "N1", "name": null, "status": "active"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ShiftCodesDTO.self, from: json)
        XCTAssertEqual(dto.codes?.count, 2)
        let m1 = try XCTUnwrap(dto.codes?.first)
        XCTAssertEqual(m1.displayLabel, "M1 — صباحية")
        XCTAssertEqual(m1.timeStart, "07:00")
        let n1 = try XCTUnwrap(dto.codes?.last)
        XCTAssertEqual(n1.displayLabel, "N1")
    }

    func testRosterAuditLogDecodesBeforeAfter() throws {
        let json = #"{"success": true, "entries": [{"id": 9, "roster_id": 7, "employee_id": 42, "team_id": 3, "shift_date": "2026-09-05", "old_shift_code": "M1", "new_shift_code": "N1", "old_team_id": 3, "new_team_id": 3, "changed_by": "admin", "changed_by_name": "المدير", "change_type": "edit", "reason": "تعديل خلية", "created_at": "2026-09-05 10:00:00"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(RosterAuditLogDTO.self, from: json)
        let e = try XCTUnwrap(dto.entries?.first)
        XCTAssertEqual(e.oldShiftCode, "M1")
        XCTAssertEqual(e.newShiftCode, "N1")
        XCTAssertEqual(e.changeType, "edit")
        XCTAssertEqual(e.changedByName, "المدير")
    }

    func testRosterValidateResponseDecodesConflicts() throws {
        let json = #"{"success": true, "valid": false, "conflicts": [{"type": "duplicate", "message": "يوجد سجل لهذا الموظف في هذا التاريخ", "employee_id": 42, "shift_date": "2026-09-05"}, {"type": "invalid_code", "message": "رمز غير معروف", "employee_id": 42, "shift_date": "2026-09-06"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(RosterValidateResponseDTO.self, from: json)
        XCTAssertEqual(dto.valid, false)
        XCTAssertEqual(dto.conflicts?.count, 2)
        XCTAssertEqual(dto.conflicts?.first?.type, "duplicate")
    }

    func testRosterDraftPendingLogic() throws {
        let pending = #"{"id": 1, "draft_data_json": "[]", "operation_type": "edit", "created_at": "2026-09-05 10:00:00"}"#.data(using: .utf8)!
        let d1 = try JSONDecoder().decode(RosterDraftsDTO.Draft.self, from: pending)
        XCTAssertTrue(d1.isPending)
        let applied = #"{"id": 2, "applied_at": "2026-09-05 11:00:00"}"#.data(using: .utf8)!
        let d2 = try JSONDecoder().decode(RosterDraftsDTO.Draft.self, from: applied)
        XCTAssertFalse(d2.isPending)
    }

    func testRosterCellUpdateRequestEncodesCamelCase() throws {
        let req = RosterCellUpdateRequest(employeeCode: "E-1042", date: "2026-09-05", shiftCode: "M1")
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        // الخادم يتوقع camelCase هنا حرفيًا (validateBody في PUT /cell)
        XCTAssertEqual(obj["employeeCode"] as? String, "E-1042")
        XCTAssertEqual(obj["shiftCode"] as? String, "M1")
        XCTAssertNil(obj["employee_code"])
    }

    func testSchedulePermissionKeysGrantAndWithhold() {
        let all: [(String, ([String], Bool) -> Bool)] = [
            ("schedule.edit_cell", PermissionMapper.canEditScheduleCell),
            ("schedule.employees", PermissionMapper.canManageScheduleEmployees),
            ("schedule.import", PermissionMapper.canImportSchedule),
            ("schedule.bulk_update", PermissionMapper.canBulkUpdateSchedule),
            ("schedule.swap", PermissionMapper.canSwapSchedule),
            ("schedule.sync", PermissionMapper.canSyncSchedule),
            ("schedule.export", PermissionMapper.canExportSchedule),
            ("schedule.clear", PermissionMapper.canClearSchedule)
        ]
        for (key, check) in all {
            XCTAssertTrue(check([key], false), "المفتاح \(key) يجب أن يُمنح")
            XCTAssertFalse(check([], false), "المفتاح \(key) يجب أن يُحجب")
            XCTAssertTrue(check([], true), "النجمة تمنح \(key)")
        }
        // مفتاح مشابه لا يفتح آخر — لا مطابقة جزئية
        XCTAssertFalse(PermissionMapper.canEditScheduleCell(["schedule.edit"], false))
        XCTAssertFalse(PermissionMapper.canViewSchedules(["schedule.view_all"], false))
    }

    @MainActor
    func testDraftChangesDecodesArrayAndWrappedAndGarbage() {
        let arr = #"[{"roster_id": 7, "shift_code": "M1"}]"#
        let changes = ScheduleOpsViewModel.decodeDraftChanges(arr)
        XCTAssertEqual(changes?.count, 1)
        XCTAssertEqual(changes?.first?.roster_id, 7)
        let wrapped = #"{"changes": [{"roster_id": 9, "shift_code": "N1"}]}"#
        XCTAssertEqual(ScheduleOpsViewModel.decodeDraftChanges(wrapped)?.first?.roster_id, 9)
        XCTAssertNil(ScheduleOpsViewModel.decodeDraftChanges("ليست JSON"))
        XCTAssertNil(ScheduleOpsViewModel.decodeDraftChanges(nil))
        XCTAssertNil(ScheduleOpsViewModel.decodeDraftChanges("[]"))
    }

    // MARK: - مجال التكميل العملياتي (CompletionOps)

    func testSupportPoolDTODecodesVolunteerFlag() throws {
        let json = #"{"success": true, "shiftId": 41, "supporters": [{"name": "محمد", "employeeCode": "E-1", "jobTitle": "مسعف", "team": "جنوب 2", "shiftCode": "M1", "sourceUnit": "جنوب 2", "kind": "field"}, {"name": "خالد", "team": null, "shiftCode": "V", "sourceUnit": null, "kind": null, "volunteer": true}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SupportPoolDTO.self, from: json)
        XCTAssertEqual(dto.supporters?.count, 2)
        XCTAssertEqual(dto.supporters?.first?.team, "جنوب 2")
        XCTAssertEqual(dto.supporters?.last?.volunteer, true)
        XCTAssertNil(dto.supporters?.last?.team)
    }

    func testVolunteerCandidatesDTODecodes() throws {
        let json = #"{"success": true, "shiftId": 41, "candidates": [{"name": "سعود", "employeeCode": "E-9", "jobTitle": "مسعف", "dayCode": "V"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(VolunteerCandidatesDTO.self, from: json)
        let c = try XCTUnwrap(dto.candidates?.first)
        XCTAssertEqual(c.name, "سعود")
        XCTAssertEqual(c.dayCode, "V")
    }

    func testShiftEventsDTODecodesStringId() throws {
        let json = #"{"success": true, "events": [{"id": "1726000000000", "type": "logistics", "description": "تجهيز", "timestamp": "2026-09-18T08:00:00Z"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ShiftEventsDTO.self, from: json)
        let e = try XCTUnwrap(dto.events?.first)
        XCTAssertEqual(e.id, "1726000000000")
        XCTAssertEqual(e.type, "logistics")
    }

    func testCompletionSaveResponseDecodesStamp() throws {
        let json = #"{"success": true, "message": "تم حفظ التكميل", "appended": 2, "corrected": true, "stampedShiftType": "صباحية", "stampedShiftDate": "2026-09-18"}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(CompletionSaveResponseDTO.self, from: json)
        XCTAssertEqual(dto.appended, 2)
        XCTAssertEqual(dto.corrected, true)
        XCTAssertEqual(dto.stampedShiftType, "صباحية")
    }

    func testPersonEventRequestOmitsNilFields() throws {
        let req = PersonEventRequest(type: "absence", employeeName: "محمد", teamId: "جنوب 2", reason: "ظرف")
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["type"] as? String, "absence")
        XCTAssertEqual(obj["employeeName"] as? String, "محمد")
        XCTAssertNil(obj["arrivalAt"])
        XCTAssertNil(obj["corrects"])
    }

    func testCompletionPermissionKeys() {
        XCTAssertTrue(PermissionMapper.canCompleteOps(["ops.completion"], false))
        XCTAssertFalse(PermissionMapper.canCompleteOps(["ops.execute"], false))
        XCTAssertTrue(PermissionMapper.canCompleteOps([], true))
        XCTAssertTrue(PermissionMapper.canVolunteers(["ops.volunteers"], false))
        XCTAssertFalse(PermissionMapper.canVolunteers(["ops.completion"], false))
        XCTAssertTrue(PermissionMapper.canVolunteers([], true))
    }

    // MARK: - مجال التمركز والذروة (PositioningOps)

    func testUnitLocationsDTODecodes() throws {
        let json = #"{"success": true, "locations": {"الرياض": {"إسعاف 12": [24.7136, 46.6753]}}, "addresses": {"إسعاف 12": "حي النرجس"}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(UnitLocationsDTO.self, from: json)
        XCTAssertEqual(dto.locations?["الرياض"]?["إسعاف 12"]?.first, 24.7136)
        XCTAssertEqual(dto.addresses?["إسعاف 12"], "حي النرجس")
    }

    func testPeakDataDTODecodesMissionsAlertsLogs() throws {
        let json = #"{"success": true, "data": {"missions": [{"id": "m1", "location": "طريق الملك فهد", "unit": "إسعاف 7", "startTime": "18:00", "endTime": "23:00", "priority": "عالية", "status": "active"}], "alerts": [{"id": "a1", "title": "ازدحام", "priority": "عالية", "status": "open", "missionId": "m1"}], "logs": [{"id": "l1", "icon": "📍", "action": "تمركز", "time": "18:05"}]}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(PeakDataDTO.self, from: json)
        XCTAssertEqual(dto.data?.missions?.first?.unit, "إسعاف 7")
        XCTAssertEqual(dto.data?.alerts?.first?.missionId, "m1")
        XCTAssertEqual(dto.data?.logs?.first?.action, "تمركز")
    }

    func testPeakMissionRequestOmitsNilFields() throws {
        let req = PeakMissionRequest(location: "الموقع", unit: "إسعاف 3", startTime: "18:00", endTime: "22:00")
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["location"] as? String, "الموقع")
        XCTAssertNil(obj["priority"])
        XCTAssertNil(obj["lat"])
    }

    func testDeployPermissionKey() {
        XCTAssertTrue(PermissionMapper.canDeployOps(["ops.deployments"], false))
        XCTAssertFalse(PermissionMapper.canDeployOps(["ops.execute"], false))
        XCTAssertFalse(PermissionMapper.canDeployOps([], false))
        XCTAssertTrue(PermissionMapper.canDeployOps([], true))
    }

    // MARK: - مجال البلاغات والتوزيع (DispatchOps)

    func testCadSummaryDTODecodes() throws {
        let json = #"{"success": true, "total": 5, "incidentsCount": 4, "activeCount": 2, "manualCount": 1, "byType": {"medical": 3}, "byCrew": {"جنوب 2": 2}, "incidents": [{"number": "10234", "type": "medical", "status": "active", "district": "النرجس", "severity": "yellow", "bestArrivalMin": 7.5, "crews": [{"unit": "جنوب 2", "counted": true, "manualCancelled": false, "respArrivalMin": 7.5}]}], "responseTime": {"arrival": {"avg": 8.2, "count": 3}, "mubashara": {"avg": 11.0, "count": 2}}, "mapStatus": {"sectorStatus": "yellow", "topDistrict": {"name": "النرجس", "count": 2}, "positionedCount": 2, "noLocationCount": 0}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(CadSummaryDTO.self, from: json)
        XCTAssertEqual(dto.total, 5)
        XCTAssertEqual(dto.activeCount, 2)
        XCTAssertEqual(dto.byCrew?["جنوب 2"], 2)
        let incident = try XCTUnwrap(dto.incidents?.first)
        XCTAssertEqual(incident.number, "10234")
        XCTAssertEqual(incident.severity, "yellow")
        XCTAssertEqual(incident.crews?.first?.counted, true)
        XCTAssertEqual(dto.responseTime?.arrival?.avg, 8.2)
        XCTAssertEqual(dto.mapStatus?.topDistrict?.name, "النرجس")
    }

    func testReportEntryListDTODecodes() throws {
        let json = #"{"success": true, "records": [{"id": "1726600000000", "reportNumber": "5521", "type": "حادث مروري", "location": "طريق الملك فهد", "priority": "عاجل", "center": "الشفاء", "unit": "جنوب 8", "dispatchTime": "14:05", "arrivalTime": "14:20", "responseSeconds": 900, "date": "2026-09-18"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ReportEntryListDTO.self, from: json)
        let entry = try XCTUnwrap(dto.records?.first)
        XCTAssertEqual(entry.serverId, "1726600000000")
        XCTAssertEqual(entry.type, "حادث مروري")
        XCTAssertEqual(entry.priority, "عاجل")
        XCTAssertEqual(entry.responseSeconds, 900)
    }

    func testReportEntryRequestOmitsNilFields() throws {
        let req = ReportEntryRequest(type: "حالة مرضية", center: "الشفاء", unit: "جنوب 8",
                                     dispatchTime: "14:00", arrivalTime: "14:15")
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["type"] as? String, "حالة مرضية")
        XCTAssertEqual(obj["unit"] as? String, "جنوب 8")
        XCTAssertNil(obj["reportNumber"])
        XCTAssertNil(obj["notes"])
        // التاريخ والطابع والمناوبة تُختم سيرفريًا — لا تُرسل من العميل
        XCTAssertNil(obj["date"])
        XCTAssertNil(obj["timestamp"])
        XCTAssertNil(obj["shiftId"])
    }

    func testDispatchPermissionKeys() {
        XCTAssertTrue(PermissionMapper.canDispatch(["ops.dispatch"], false))
        XCTAssertFalse(PermissionMapper.canDispatch(["ops.reports"], false))
        XCTAssertTrue(PermissionMapper.canDispatch([], true))
        XCTAssertTrue(PermissionMapper.canRevertReports(["ops.report_revert"], false))
        XCTAssertFalse(PermissionMapper.canRevertReports(["ops.dispatch"], false))
        XCTAssertTrue(PermissionMapper.canReportDetail(["ops.report_detail"], false))
        XCTAssertFalse(PermissionMapper.canReportDetail(["ops.dispatch"], false))
        // ops.report_revert يفتح وحدة العمليات مثل باقي مفاتيح ops.*
        XCTAssertTrue(PermissionMapper.canAccessOperations(["ops.report_revert"], false))
    }

    // MARK: - مجال المركبات (VehiclesOps)

    func testVehicleHistoryDTODecodes() throws {
        let json = #"{"success": true, "vehicle": {"id": "veh_1", "name": "إسعاف 12", "plateNumber": "أ ب ج 1234", "vehicleType": "إسعاف", "modelYear": 2023, "designation": "أساسية"}, "current": {"status": "active", "teamId": 3, "teamName": "جنوب 2"}, "events": [{"id": 9, "domain": "vehicle", "eventType": "assignment", "teamId": 3, "teamName": "جنوب 2", "shiftDate": "2026-09-18", "actorName": "مشرف", "createdAt": "2026-09-18T06:00:00Z", "createdAtRiyadh": "2026-09-18 09:00:00"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(VehicleHistoryDTO.self, from: json)
        XCTAssertEqual(dto.vehicle?.plateNumber, "أ ب ج 1234")
        XCTAssertEqual(dto.current?.teamName, "جنوب 2")
        let event = try XCTUnwrap(dto.events?.first)
        XCTAssertEqual(event.eventType, "assignment")
        XCTAssertEqual(event.teamId, 3)
        XCTAssertEqual(event.createdAtRiyadh, "2026-09-18 09:00:00")
    }

    func testVehicleRegistryDTODecodesSnakeCase() throws {
        let json = #"{"success": true, "vehicles": [{"id": "veh_1", "plate_number": "1234", "call_sign": "إسعاف 12", "vehicle_type": "إسعاف", "model_year": 2023, "category": "نوع أ", "designation": "أساسية", "admin_status": "أساسية", "sort_order": 1}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(VehicleRegistryDTO.self, from: json)
        let item = try XCTUnwrap(dto.vehicles?.first)
        XCTAssertEqual(item.plateNumber, "1234")
        XCTAssertEqual(item.modelYear, 2023)
        XCTAssertEqual(item.adminStatus, "أساسية")
    }

    func testVehicleRegistryRequestEncodesSnakeCase() throws {
        let req = VehicleRegistryRequest(plateNumber: "1234", vehicleType: "إسعاف",
                                         category: "نوع أ", designation: "أساسية", modelYear: 2023)
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["plate_number"] as? String, "1234")
        XCTAssertEqual(obj["model_year"] as? Int, 2023)
        XCTAssertNil(obj["call_sign"])
        XCTAssertNil(obj["notes"])
    }

    func testVehicleStatusEventRequestOmitsNil() throws {
        let req = VehicleStatusEventRequest(vehicleId: "veh_1", status: "active")
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["status"] as? String, "active")
        XCTAssertNil(obj["reason"]) // السبب يُرسل فقط عند breakdown/out_of_service
        XCTAssertNil(obj["note"])
    }

    func testVehicleOpsPermissionKey() {
        XCTAssertTrue(PermissionMapper.canVehicleOps(["ops.vehicles"], false))
        XCTAssertFalse(PermissionMapper.canVehicleOps(["ops.dispatch"], false))
        XCTAssertTrue(PermissionMapper.canVehicleOps([], true))
    }

    // MARK: - مجال النماذج التشغيلية (FormsOps)

    func testIncidentLookupDTODecodes() throws {
        let json = #"{"success": true, "found": true, "number": "10234", "shiftId": 41, "incident": {"number": "10234", "type": "medical", "address": "طريق الملك فهد", "district": "النرجس", "status": "active", "cadCreatedAtRaw": "18/09/2026 14:05"}, "units": [{"unit": "جنوب 2", "respArrivalMin": 7.5, "counted": true}], "bestArrivalMin": 7.5, "timeCompleteness": {"state": "complete", "missing": []}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(IncidentLookupDTO.self, from: json)
        XCTAssertEqual(dto.found, true)
        XCTAssertEqual(dto.incident?.district, "النرجس")
        XCTAssertEqual(dto.units?.first?.counted, true)
        XCTAssertEqual(dto.bestArrivalMin, 7.5)
        XCTAssertEqual(dto.timeCompleteness?.state, "complete")
    }

    func testFormRecordItemProjectionKeepsKnownFieldsInOrder() {
        let item = FormRecordItem.from([
            "id": "123", "reportNumber": "5521", "type": "تصادم مروري",
            "location": "طريق الملك فهد", "injuries": 2, "agencies": ["المرور", "الدفاع المدني"],
            "unknownFutureField": "x" // حقل مستقبلي — لا يكسر الإسقاط
        ], formType: "escalation")
        XCTAssertEqual(item.id, "123")
        XCTAssertEqual(item.title, "بلاغ 5521")
        XCTAssertEqual(item.rows.first?.label, "رقم البلاغ")
        XCTAssertTrue(item.rows.contains { $0.label == "الإصابات" && $0.value == "2" })
        XCTAssertTrue(item.rows.contains { $0.label == "الجهات" && $0.value == "المرور، الدفاع المدني" })
        // ترتيب الحقول يتبع تعريف النوع لا الأبجدية
        let labels = item.rows.map(\.label)
        XCTAssertLessThan(labels.firstIndex(of: "رقم البلاغ")!, labels.firstIndex(of: "الجهات")!)
    }

    func testOpsFormTypePaths() {
        XCTAssertEqual(OpsFormType.incident.path, "/api/incidents")
        XCTAssertEqual(OpsFormType.eCase.path, "/api/e-cases")
        XCTAssertEqual(OpsFormType.dailyReport.path, "/api/daily-reports")
        XCTAssertTrue(OpsFormType.escalation.requiresLookup)
        XCTAssertFalse(OpsFormType.seniorShift.requiresLookup)
    }

    func testFormsPermissionKey() {
        XCTAssertTrue(PermissionMapper.canForms(["ops.forms"], false))
        XCTAssertFalse(PermissionMapper.canForms(["ops.dispatch"], false))
        XCTAssertTrue(PermissionMapper.canForms([], true))
    }

    // MARK: - مجال سير العمل (WorkflowOps)

    func testWorkflowVersionDTODecodesSnakeCaseAndFields() throws {
        let json = #"{"id": 7, "shift_id": 41, "version_no": 2, "status": "approved", "ref_no": "WF-41-2", "created_by_name": "مشرف", "approved_by_name": "كبير المسعفين", "fields_json": "{\"summary\":\"مناوبة هادئة\",\"reviewedBy\":[\"مدير القطاع\"]}"}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(WorkflowVersionDTO.self, from: json)
        XCTAssertEqual(dto.shiftId, 41)
        XCTAssertEqual(dto.versionNo, 2)
        XCTAssertEqual(dto.status, "approved")
        XCTAssertEqual(dto.statusTitle, "معتمدة")
        XCTAssertEqual(dto.refNo, "WF-41-2")
        XCTAssertEqual(dto.fields["summary"], "مناوبة هادئة")
        XCTAssertEqual(dto.fields["reviewedBy"], "مدير القطاع")
    }

    func testWorkflowFieldsRequestEncodesWhitelistOnly() throws {
        let req = WorkflowFieldsRequest(summary: "ملخص", reviewedBy: ["مدير القطاع"])
        let data = try JSONEncoder().encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["summary"] as? String, "ملخص")
        XCTAssertEqual(obj["reviewedBy"] as? [String], ["مدير القطاع"])
        XCTAssertNil(obj["operationalNotes"])
        XCTAssertNil(obj["issues"])
    }

    func testWorkflowPermissionKeys() {
        XCTAssertTrue(PermissionMapper.canViewWorkflow(["workflow.view"], false))
        XCTAssertFalse(PermissionMapper.canViewWorkflow(["workflow.manage"], false))
        XCTAssertTrue(PermissionMapper.canManageWorkflow(["workflow.manage"], false))
        XCTAssertTrue(PermissionMapper.canApproveWorkflow(["workflow.approve"], false))
        XCTAssertFalse(PermissionMapper.canApproveWorkflow(["workflow.manage"], false))
        // workflow.view يفتح وحدة العمليات (سير العمل داخل غرفة العمليات)
        XCTAssertTrue(PermissionMapper.canAccessOperations(["workflow.view"], false))
    }

    // MARK: - مجال الأرشيف (ArchiveOps)

    func testArchiveListResponseDecodesSnakeCase() throws {
        let json = #"{"success": true, "total": 3, "page": 1, "total_pages": 2, "shifts": [{"id": 41, "shiftName": "مناوبة مسائية", "shiftDate": "2026-09-10", "shiftType": "مسائية", "shiftDay": "الخميس", "startTime": "20:00", "totalReports": 12, "generalNotes": "", "lastUpdate": "2026-09-11T08:00:00Z", "status": "archived", "archivedAt": "2026-09-11T08:00:00Z", "createdAt": "2026-09-10T20:00:00Z"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ArchiveListResponseDTO.self, from: json)
        XCTAssertEqual(dto.total, 3)
        XCTAssertEqual(dto.totalPages, 2)
        let shift = try XCTUnwrap(dto.shifts?.first)
        XCTAssertEqual(shift.id, 41)
        XCTAssertEqual(shift.shiftName, "مناوبة مسائية")
        XCTAssertTrue(shift.isArchived)
        XCTAssertEqual(shift.statusTitle, "مؤرشفة")
        XCTAssertEqual(shift.totalReports, 12)
    }

    func testArchiveShiftDefaultsActiveStatus() throws {
        // normalizeShiftRow يعطي status='active' افتراضيًا — لكن الصف القديم قد يفتقده
        let json = #"{"id": 7, "shiftDate": "2026-09-01", "totalReports": 0}"#.data(using: .utf8)!
        let shift = try JSONDecoder().decode(ArchiveShiftDTO.self, from: json)
        XCTAssertFalse(shift.isArchived)
        XCTAssertEqual(shift.statusTitle, "نشطة")
        XCTAssertEqual(shift.displayName, "مناوبة #7")
    }

    func testVerifyArchiveResponseDecodesChecks() throws {
        let json = #"{"success": true, "shiftId": 41, "passed": false, "timestamp": "2026-09-18T00:00:00Z", "checks": {"hashMatch": {"passed": true}, "dataLinkage": {"passed": false, "issues": ["2 سجل تكميل غير مرتبط"]}, "fileIntegrity": {"passed": true, "checked": 5}, "dataCompleteness": {"passed": true}, "noDuplicates": {"passed": true, "duplicateCount": 0}}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(VerifyArchiveResponseDTO.self, from: json)
        XCTAssertEqual(dto.passed, false)
        XCTAssertEqual(dto.checks?.count, 5)
        XCTAssertEqual(dto.checks?["dataLinkage"]??.issues?.first, "2 سجل تكميل غير مرتبط")
        XCTAssertEqual(dto.checks?["fileIntegrity"]??.checked, 5)
        XCTAssertEqual(dto.checks?["hashMatch"]??.passed, true)
    }

    func testArchiveLogEntryToleratesMissingDetails() throws {
        // details حرة الشكل — سطر بلا details أو بحقول ناقصة لا يسقط الفكّ
        let json = #"{"success": true, "shiftId": 41, "logs": [{"id": "1700000000000-ab12cd", "timestamp": "2026-09-11T08:00:00Z", "operation": "archive", "shiftId": 41, "user": {"id": 3, "name": "مشرف", "role": "admin"}}, {"timestamp": "2026-09-11T08:01:00Z", "operation": "verify", "shiftId": 41, "details": {"status": "passed"}}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ArchiveLogResponseDTO.self, from: json)
        let logs = try XCTUnwrap(dto.logs)
        XCTAssertEqual(logs.count, 2)
        XCTAssertEqual(logs[0].operationTitle, "أرشفة")
        XCTAssertEqual(logs[0].user?.name, "مشرف")
        XCTAssertNil(logs[0].details)
        XCTAssertEqual(logs[1].operationTitle, "التحقق من السلامة")
        XCTAssertEqual(logs[1].details?.summary, "passed")
        XCTAssertFalse(logs[1].stableId.isEmpty)
    }

    func testArchiveActionResponseDecodesEngineResult() throws {
        let json = #"{"success": true, "shiftId": 41, "message": "تمت إعادة الأرشفة بنجاح", "snapshotHash": "abc123", "duration": 1540}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(ArchiveActionResponseDTO.self, from: json)
        XCTAssertEqual(dto.success, true)
        XCTAssertEqual(dto.snapshotHash, "abc123")
        XCTAssertEqual(dto.duration, 1540)
    }

    func testArchiveRequestEncodesReason() throws {
        let data = try JSONEncoder().encode(ArchiveRequestDTO(reason: "أرشفة مباشرة"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["reason"] as? String, "أرشفة مباشرة")
    }
}
