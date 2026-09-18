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

    // MARK: - مجال الذكاء: اسأل والذاكرة (SmartOps)

    func testSmartAskResponseDecodesAnswer() throws {
        let json = #"{"success": true, "data": {"family": "current-risk", "text": "الخطر الأبرز الآن: نقص فرقة — …"}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SmartAskResponseDTO.self, from: json)
        XCTAssertEqual(dto.data?.family, "current-risk")
        XCTAssertEqual(dto.data?.text, "الخطر الأبرز الآن: نقص فرقة — …")
    }

    func testSmartAskOutOfScopeFamilyIsNil() throws {
        // سؤال خارج النطاق ⇒ family=null مع نص اعتذار (smart-ask-service.js:121)
        let json = #"{"success": true, "data": {"family": null, "text": "سؤال خارج نطاق البيانات التشغيلية الحالية."}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SmartAskResponseDTO.self, from: json)
        XCTAssertNil(dto.data?.family)
        XCTAssertNotNil(dto.data?.text)
    }

    func testSmartAskRequestEncodesQuestion() throws {
        let data = try JSONEncoder().encode(SmartAskRequestDTO(question: "ما الخطر الحالي؟"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["question"] as? String, "ما الخطر الحالي؟")
    }

    func testDecisionMemoryRecordDecodes() throws {
        let json = #"{"success": true, "shiftId": 41, "records": [{"id": "dm-1-abc", "recordedAt": "2026-09-18T00:00:00Z", "recordedAtRiyadh": "2026-09-18 03:00:00", "shiftId": 41, "shiftType": "مسائية", "shiftPhase": "active", "fingerprint": "fp1", "readiness": {"percent": 82, "status": "stable"}, "summary": "الوضع مستقر", "counts": {"critical": 0, "warning": 1, "info": 2}, "riskCodes": ["TEAM_UNDERSTAFFED"], "shortageTeams": ["فرقة 3"], "vehicleIssues": [], "completionDelay": false, "risks": [{"code": "X"}], "recommendations": [], "proactive": []}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SmartMemoryResponseDTO.self, from: json)
        let record = try XCTUnwrap(dto.records?.first)
        XCTAssertEqual(record.id, "dm-1-abc")
        XCTAssertEqual(record.readiness?.percent, 82)
        XCTAssertEqual(record.counts?.warning, 1)
        XCTAssertEqual(record.shortageTeams, ["فرقة 3"])
        XCTAssertEqual(record.completionDelay, false)
    }

    func testSmartPatternsResponseDecodes() throws {
        let json = #"{"success": true, "scope": {"shiftId": 41, "from": null, "to": null}, "records": 12, "riskCodes": {"TEAM_MISSING": 3}, "shortageTeams": {"فرقة 3": 2}, "vehicleIssues": {"إسعاف 12": 1}, "completionDelays": 1, "readiness": {"min": 64, "avg": 78, "samples": 12}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SmartPatternsResponseDTO.self, from: json)
        XCTAssertEqual(dto.records, 12)
        XCTAssertEqual(dto.riskCodes?["TEAM_MISSING"], 3)
        XCTAssertEqual(dto.shortageTeams?["فرقة 3"], 2)
        XCTAssertEqual(dto.readiness?.min, 64)
        XCTAssertEqual(dto.readiness?.avg, 78)
    }

    // MARK: - مجال الإدارة (AdminOps)

    func testAdminUsersDecodeFlexibleIds() throws {
        // id نصي ('emp-<code>') أو رقمي — server.js:2000
        let json = #"{"success": true, "users": [{"id": "emp-1042", "username": "1042", "name": "مسعف أول", "role": "operator", "isActive": true}, {"id": 3, "username": "admin", "name": "مدير", "role": "admin", "isActive": true}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(AdminUsersResponseDTO.self, from: json)
        XCTAssertEqual(dto.users?.count, 2)
        XCTAssertEqual(dto.users?[0].stableId, "emp-1042")
        XCTAssertEqual(dto.users?[1].stableId, "3")
        XCTAssertEqual(dto.users?[1].role, "admin")
    }

    func testRoleChangeResponseDecodesSnakeCase() throws {
        let json = #"{"success": true, "changed": true, "oldRole": "viewer", "newRole": "operator", "role_label": "المشغّل", "sessionsRevoked": 2}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(RoleChangeResponseDTO.self, from: json)
        XCTAssertEqual(dto.changed, true)
        XCTAssertEqual(dto.roleLabel, "المشغّل")
        XCTAssertEqual(dto.sessionsRevoked, 2)
    }

    func testCreateUserResponseCarriesTempPassword() throws {
        // tempPassword تُعاد مرة واحدة — server.js:1756
        let json = #"{"success": true, "user": {"id": "emp-1042", "username": "1042", "name": "مسعف", "role": "viewer"}, "employee": {"name": "مسعف", "jobTitle": "مسعف"}, "tempPassword": "Ab3xY9kLm2", "permissionsGranted": []}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(CreateUserResponseDTO.self, from: json)
        XCTAssertEqual(dto.tempPassword, "Ab3xY9kLm2")
        XCTAssertEqual(dto.user?.username, "1042")
    }

    func testAdminEmployeeDecodesServerColumns() throws {
        // أعمدة employeeColumnsFor — server.js:11144-11146
        let json = #"{"success": true, "employees": [{"id": 7, "employee_code": "1042", "name": "مسعف", "job_title": "كبير مسعفين", "symbol": "A1", "is_active": 1, "pattern_code": "P4", "created_at": "2026-01-01", "phone": "5xxxxxxxx", "phone_verified": 1, "phone_verified_by": "admin"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(AdminEmployeesResponseDTO.self, from: json)
        let emp = try XCTUnwrap(dto.employees?.first)
        XCTAssertEqual(emp.employeeCode, "1042")
        XCTAssertTrue(emp.active)
        XCTAssertTrue(emp.verified)
        XCTAssertEqual(emp.patternCode, "P4")
    }

    func testVerifyPhoneRequestConfirmsResponsibility() throws {
        // confirmResponsibility: true إلزامي سيرفريًا — server.js:11223
        let data = try JSONEncoder().encode(VerifyPhoneRequestDTO(confirmResponsibility: true))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["confirmResponsibility"] as? Bool, true)
    }

    func testTransferRequestEncodesContract() throws {
        // teamId + scope + date كلها إلزامية — server.js:12909
        let data = try JSONEncoder().encode(TransferEmployeeRequestDTO(teamId: 4, scope: "from-date", date: "2026-09-20"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["teamId"] as? Int, 4)
        XCTAssertEqual(obj["scope"] as? String, "from-date")
        XCTAssertEqual(obj["date"] as? String, "2026-09-20")
    }

    func testTeamsAndShiftCodesDecode() throws {
        let teamsJson = #"{"success": true, "teams": [{"id": 1, "name": "فرقة 1", "center": "مركز الشفا", "team_type": "عادية", "sort_order": 1, "is_active": 1, "requiredPersonnel": 2}]}"#.data(using: .utf8)!
        let teams = try JSONDecoder().decode(AdminTeamsResponseDTO.self, from: teamsJson)
        XCTAssertEqual(teams.teams?.first?.center, "مركز الشفا")
        XCTAssertEqual(teams.teams?.first?.active, true)

        let codesJson = #"{"success": true, "codes": [{"id": 2, "code": "M1", "name": "صباحية", "time_start": "07:00", "time_end": "19:00", "color": "#2563EB", "status": "دوام"}]}"#.data(using: .utf8)!
        let codes = try JSONDecoder().decode(ShiftCodesResponseDTO.self, from: codesJson)
        XCTAssertEqual(codes.codes?.first?.timeStart, "07:00")
        XCTAssertEqual(codes.codes?.first?.status, "دوام")
    }

    func testSymbolsRegistryAndAuditDecode() throws {
        let json = #"{"success": true, "secretConfigured": true, "symbols": [{"id": 5, "code": "OFF", "name": "إجازة", "symbol_type": "day_code", "source": "custom", "status": "active", "hours": 0, "usage_count": 12}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SymbolsRegistryResponseDTO.self, from: json)
        XCTAssertEqual(dto.secretConfigured, true)
        XCTAssertEqual(dto.symbols?.first?.symbolType, "day_code")
        XCTAssertEqual(dto.symbols?.first?.usageCount, 12)

        let auditJson = #"{"success": true, "log": [{"id": 1, "actor_name": "مدير", "action": "secret_set", "code": null, "created_at": "2026-09-01T10:00:00Z"}]}"#.data(using: .utf8)!
        let audit = try JSONDecoder().decode(SymbolAuditResponseDTO.self, from: auditJson)
        XCTAssertEqual(audit.log?.first?.action, "secret_set")
        XCTAssertEqual(audit.log?.first?.actorName, "مدير")
    }

    func testSymbolUnlockResponseDecodes() throws {
        let json = #"{"success": true, "unlockToken": "abc123", "expiresInMinutes": 15}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(SymbolUnlockResponseDTO.self, from: json)
        XCTAssertEqual(dto.unlockToken, "abc123")
        XCTAssertEqual(dto.expiresInMinutes, 15)
    }

    func testDiskUsageAndAuditLogDecode() throws {
        let diskJson = #"{"success": true, "disk": {"total": "10 GB", "used": "512 MB", "available": "9.5 GB", "percent": "5.0%"}, "storagePath": "/data"}"#.data(using: .utf8)!
        let disk = try JSONDecoder().decode(DiskUsageDTO.self, from: diskJson)
        XCTAssertEqual(disk.disk?.percent, "5.0%")

        let logJson = #"{"success": true, "logs": [{"id": "1", "action": "role_change", "details": "تغيير دور", "category": "permissions", "user": "مدير", "role": "admin", "timestamp": "2026-09-18T00:00:00Z"}]}"#.data(using: .utf8)!
        let log = try JSONDecoder().decode(AuditLogResponseDTO.self, from: logJson)
        XCTAssertEqual(log.logs?.first?.action, "role_change")
        XCTAssertEqual(log.logs?.first?.category, "permissions")
    }

    func testAdminPermissionKeys() {
        XCTAssertTrue(PermissionMapper.canManageUsers(["admin.users_manage"], false))
        XCTAssertFalse(PermissionMapper.canManageUsers(["ops.dispatch"], false))
        XCTAssertTrue(PermissionMapper.canManageSymbols(["symbols.manage"], false))
        XCTAssertFalse(PermissionMapper.canManageSymbols(["admin.users_manage"], false))
        XCTAssertTrue(PermissionMapper.canManageUsers([], true))
    }

    func testAdminRolesLabels() {
        XCTAssertEqual(AdminRoles.label("ops_supervisor"), "مشرف العمليات")
        XCTAssertEqual(AdminRoles.label("field_leadership"), "القيادة الميدانية")
        XCTAssertEqual(AdminRoles.label("unknown"), "unknown")
        XCTAssertEqual(AdminRoles.all.count, 8)
    }

    // MARK: - مجال إشعارات النظام (§5)

    func testNotificationLogEntryDecodesServerColumns() throws {
        // سطر notification_log — db.js:888
        let json = #"{"success": true, "notifications": [{"id": 9, "notification_type": "shift_change", "recipient_id": 7, "recipient_name": "مسعف", "recipient_phone": "5xxxxxxxx", "message": "تغيرت مناوبتك", "channel": "in-app", "status": "delivered", "sent_at": "2026-09-18 10:00:00", "delivered_at": "2026-09-18 10:00:05", "opened_at": null, "error_message": null, "created_at": "2026-09-18 10:00:00"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(NotificationLogResponseDTO.self, from: json)
        let entry = try XCTUnwrap(dto.notifications?.first)
        XCTAssertEqual(entry.recipientId, 7)
        XCTAssertEqual(entry.status, "delivered")
        XCTAssertEqual(entry.statusTitle, "مسلَّم")
        XCTAssertEqual(entry.statusTone, .normal)
        XCTAssertEqual(entry.notificationType, "shift_change")
        XCTAssertNotNil(entry.deliveredAt)
    }

    func testNotificationLogStatusMapping() {
        let cases: [(String, String)] = [
            ("pending", "معلّق"), ("sent", "مرسل"), ("delivered", "مسلَّم"),
            ("read", "مقروء"), ("acknowledged", "مؤكَّد"), ("failed", "فشل")
        ]
        for (raw, title) in cases {
            let json = #"{"id": 1, "status": "\#(raw)"}"#.data(using: .utf8)!
            let entry = try? JSONDecoder().decode(NotificationLogEntryDTO.self, from: json)
            XCTAssertEqual(entry?.statusTitle, title, "status \(raw)")
        }
    }

    func testNotificationSendRequestEncodesSnakeCase() throws {
        // recipient_id + message إلزاميان — server.js:12237
        let data = try JSONEncoder().encode(NotificationSendRequestDTO(recipientId: 7, message: "تنبيه", type: "alert"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["recipient_id"] as? Int, 7)
        XCTAssertEqual(obj["message"] as? String, "تنبيه")
        XCTAssertEqual(obj["type"] as? String, "alert")
        XCTAssertNil(obj["recipientId"]) // لا camelCase في الجسم
    }

    // MARK: - مجال دورة المناوبة (ShiftLifecycle)

    func testShiftLifecycleResultToleratesEngineShapes() throws {
        // نتيجة ShiftService حرة: shift_id أو shiftId أو بلا معرّف
        let snake = #"{"success": true, "shift_id": 41}"#.data(using: .utf8)!
        let camel = #"{"success": true, "shiftId": 42}"#.data(using: .utf8)!
        let bare = #"{"success": false, "error": "المناوبة ليست بانتظار التسليم"}"#.data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder().decode(ShiftLifecycleResultDTO.self, from: snake).shiftId, 41)
        XCTAssertEqual(try JSONDecoder().decode(ShiftLifecycleResultDTO.self, from: camel).shiftId, 42)
        let failed = try JSONDecoder().decode(ShiftLifecycleResultDTO.self, from: bare)
        XCTAssertEqual(failed.success, false)
        XCTAssertEqual(failed.error, "المناوبة ليست بانتظار التسليم")
        XCTAssertNil(failed.shiftId)
    }

    func testEndShiftRequestEncodesNotes() throws {
        let data = try JSONEncoder().encode(EndShiftRequestDTO(handoverNotes: "تسليم نظيف"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["handoverNotes"] as? String, "تسليم نظيف")
    }

    func testEmergencyShiftsDecodeRawSqliteRows() throws {
        // صفوف SQLite خام — server.js:3568
        let json = #"{"success": true, "count": 1, "shifts": [{"id": 41, "shift_name": "مناوبة 41", "shift_date": "2026-09-18", "shift_type": "مسائية", "status": "active", "start_time": "2026-09-18 20:00", "total_reports": 3}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(EmergencyShiftsResponseDTO.self, from: json)
        let shift = try XCTUnwrap(dto.shifts?.first)
        XCTAssertEqual(shift.stableId, 41)
        XCTAssertEqual(shift.shiftType, "مسائية")
        XCTAssertEqual(shift.totalReports, 3)
        XCTAssertEqual(shift.displayName, "مناوبة 41")
    }

    func testEmergencyEditRequestOmitsEmptyFields() throws {
        // edit-shift يبني SET من الحقول الممررة فقط — server.js:3614
        let data = try JSONEncoder().encode(EmergencyShiftRequestDTO(shiftId: 41, shiftType: nil, shiftDate: "2026-09-19"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["shiftId"] as? Int, 41)
        XCTAssertNil(obj["shiftType"])
        XCTAssertEqual(obj["shiftDate"] as? String, "2026-09-19")
    }

    func testShiftLifecyclePermissionKeys() {
        XCTAssertTrue(PermissionMapper.canShiftLifecycle(["shift.lifecycle"], false))
        XCTAssertFalse(PermissionMapper.canShiftLifecycle(["shift.approve"], false))
        XCTAssertTrue(PermissionMapper.canShiftApprove(["shift.approve"], false))
        XCTAssertFalse(PermissionMapper.canShiftApprove(["shift.lifecycle"], false))
        // مفاتيح دورة المناوبة تفتح وحدة العمليات
        XCTAssertTrue(PermissionMapper.canAccessOperations(["shift.lifecycle"], false))
        XCTAssertTrue(PermissionMapper.canAccessOperations(["shift.approve"], false))
    }

    // MARK: - مجال خطوط الأحداث (§14)

    func testOpEventDecodesRawSqliteRow() throws {
        // صف operational_events خام — مخطط db.js
        let json = #"{"id": 7, "shift_id": 41, "domain": "staffing", "entity_id": "أحمد", "entity_name": null, "team_id": "فريق 1", "center": null, "event_type": "arrival", "status": null, "reason": null, "payload": null, "note": "حضر", "actor_id": "3", "actor_name": "مدير", "created_at": "2026-09-18 17:20:00"}"#.data(using: .utf8)!
        let ev = try JSONDecoder().decode(OpEventDTO.self, from: json)
        XCTAssertEqual(ev.rowId, 7)
        XCTAssertEqual(ev.shiftId, 41)
        XCTAssertEqual(ev.entityId, "أحمد")
        XCTAssertEqual(ev.eventType, "arrival")
        XCTAssertEqual(ev.actorName, "مدير")
        XCTAssertNil(ev.entityName)
    }

    func testStaffingTimelineDecodesDerivedRecords() throws {
        // lateRecords/coverageRecords مشتقة سيرفريًا — staffing-events-service.js
        let json = #"{"success": true, "shiftId": 41, "events": [], "lateRecords": [{"employee": "أحمد", "teamId": "فريق 1", "startedAt": "2026-09-18T05:00:00.000Z", "arrivedAt": "2026-09-18T05:20:00.000Z", "durationMinutes": 20, "status": "arrived", "sourceEventType": "late", "jobTitle": "مسعف", "carriedFromShiftId": 40}], "coverageRecords": [{"employee": "سارة", "fromCenter": "مركز الشفا", "coverageType": "volunteer", "coverageTypeLabel": "تطوع", "startedAt": "2026-09-18T06:00:00.000Z", "endedAt": null, "durationMinutes": null, "status": "active", "approvedBy": "مدير"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(StaffingTimelineDTO.self, from: json)
        let late = try XCTUnwrap(dto.lateRecords?.first)
        XCTAssertEqual(late.status, "arrived")
        XCTAssertEqual(late.durationMinutes, 20)
        XCTAssertEqual(late.carriedFromShiftId, 40)
        let cov = try XCTUnwrap(dto.coverageRecords?.first)
        XCTAssertEqual(cov.coverageTypeLabel, "تطوع")
        XCTAssertEqual(cov.status, "active")
        XCTAssertNil(cov.endedAt)
    }

    func testShiftTimelineEventDecodesSnakeCase() throws {
        // صف shift_timeline_events — db.js getByShift
        let json = #"{"id": 3, "shift_id": 41, "event_type": "status", "event_title": "بدء المناوبة", "event_description": null, "event_time": "2026-09-18 05:00:00", "created_by_name": "مدير"}"#.data(using: .utf8)!
        let ev = try JSONDecoder().decode(ShiftTimelineEventDTO.self, from: json)
        XCTAssertEqual(ev.rowId, 3)
        XCTAssertEqual(ev.eventTitle, "بدء المناوبة")
        XCTAssertEqual(ev.eventTime, "2026-09-18 05:00:00")
        XCTAssertEqual(ev.createdByName, "مدير")
    }

    func testShiftEventToleratesNumericAndStringIds() throws {
        // العقد المشتق يعيد id نصيًا (String(rowId)) والصف الخام قد يعيد رقمًا
        let strJson = #"{"id": "1726", "shiftId": 41, "type": "note", "description": "ملاحظة", "timestamp": "2026-09-18T10:00:00.000Z", "createdAt": "2026-09-18T10:00:01.000Z"}"#.data(using: .utf8)!
        let numJson = #"{"id": 1726, "shiftId": 41, "type": "note", "description": "ملاحظة"}"#.data(using: .utf8)!
        let a = try JSONDecoder().decode(ShiftEventDTO.self, from: strJson)
        let b = try JSONDecoder().decode(ShiftEventDTO.self, from: numJson)
        XCTAssertEqual(a.id, "1726")
        XCTAssertEqual(b.id, "1726")
        XCTAssertEqual(a.shiftId, 41)
    }

    func testShiftEventCreateRequestOmitsNilTimestamp() throws {
        // server.js يختم timestamp سيرفريًا عند غيابه — لا يرسل العميل وقتًا
        let data = try JSONEncoder().encode(ShiftEventCreateRequestDTO(type: "note", description: "ملاحظة", timestamp: nil))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["type"] as? String, "note")
        XCTAssertEqual(obj["description"] as? String, "ملاحظة")
        XCTAssertNil(obj["timestamp"])
    }

    // MARK: - مجال العهد والأصول (§16)

    func testAssetDecodesRawSqliteRow() throws {
        // جدول assets — db.js:4248
        let json = #"{"id": 12, "asset_code": "ASSET-0012", "type_name": "جهاز صدمات", "original_name": null, "serial_number": "SN123", "status": "working", "team_name": "فريق 1", "center_name": "مركز الشفا", "custody": "exclusive", "is_new": 0, "needs_review": 1}"#.data(using: .utf8)!
        let asset = try JSONDecoder().decode(AssetDTO.self, from: json)
        XCTAssertEqual(asset.id, 12)
        XCTAssertEqual(asset.assetCode, "ASSET-0012")
        XCTAssertEqual(asset.status, "working")
        XCTAssertEqual(asset.needsReview, 1)
    }

    func testInventoryCycleDecodesSessionProgress() throws {
        // GET /api/assets/inventory/cycles — server.js:6123 يلحق عدادات الجلسات
        let json = #"{"success": true, "cycles": [{"id": 3, "label": "الجرد التأسيسي", "status": "active", "sessions_total": 5, "sessions_submitted": 2, "sessions_approved": 1, "sessions": [{"id": 9, "team_name": "فريق 1", "status": "open", "conductor_name": null}]}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(InventoryCyclesDTO.self, from: json)
        let cycle = try XCTUnwrap(dto.cycles?.first)
        XCTAssertEqual(cycle.sessionsTotal, 5)
        XCTAssertEqual(cycle.sessions?.first?.teamName, "فريق 1")
        XCTAssertEqual(cycle.sessions?.first?.status, "open")
    }

    func testInventoryItemRequestUsesServerFieldNames() throws {
        // server.js:6184 يتوقع asset_id/result/serial_seen/location_note (snake_case)
        let data = try JSONEncoder().encode(InventoryItemRequestDTO(
            assetId: 12, result: "missing", reason: "فُقد أثناء النقل", serialSeen: nil, locationNote: nil, discovered: nil))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["asset_id"] as? Int, 12)
        XCTAssertEqual(obj["result"] as? String, "missing")
        XCTAssertEqual(obj["reason"] as? String, "فُقد أثناء النقل")
        XCTAssertNil(obj["serial_seen"])
    }

    func testDiscrepancyCaseDecodesServerShape() throws {
        // computeDiscrepancies — server.js:6425
        let json = #"{"success": true, "cases": [{"key": "missing-12", "category": "missing", "priority": "high", "suggested_action": "document_missing", "asset_id": 12, "asset_code": "ASSET-0012", "type_name": "جهاز صدمات", "serial_number": "SN123", "status": "missing", "team_name": "فريق 1", "raised_at": "2026-09-01 10:00:00", "explanation": "مفقود منذ الجرد الأخير"}], "category_labels": {"missing": "مفقود"}}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(DiscrepanciesDTO.self, from: json)
        let c = try XCTUnwrap(dto.cases?.first)
        XCTAssertEqual(c.suggestedAction, "document_missing")
        XCTAssertEqual(c.assetId, 12)
        XCTAssertEqual(dto.categoryLabels?["missing"], "مفقود")
    }

    func testAssetsPermissionKeys() {
        XCTAssertTrue(PermissionMapper.canAssetsView(["assets.view"], false))
        XCTAssertFalse(PermissionMapper.canAssetsView(["assets.manage"], false))
        XCTAssertTrue(PermissionMapper.canAssetsManage(["assets.manage"], false))
        // INV_EXEC: الجرد متاح لحامل assets.inventory أو assets.manage
        XCTAssertTrue(PermissionMapper.canAssetsInventory(["assets.inventory"], false))
        XCTAssertTrue(PermissionMapper.canAssetsInventory(["assets.manage"], false))
        XCTAssertFalse(PermissionMapper.canAssetsInventory(["assets.view"], false))
        // مفاتيح العهد تفتح وحدة العمليات
        XCTAssertTrue(PermissionMapper.canAccessOperations(["assets.view"], false))
    }

    // MARK: - مجال المستشفيات (§17)

    func testHospitalDecodesRegistryShape() throws {
        // hospitals.json — حقول الواجهة: name/specialty/type/hours/lat/lng
        let json = #"{"success": true, "data": [{"name": "مستشفى الملك فهد", "specialty": "عام", "type": "عام", "hours": "24 ساعة", "lat": 24.7, "lng": 46.7}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(HospitalsListDTO.self, from: json)
        let h = try XCTUnwrap(dto.data?.first)
        XCTAssertEqual(h.name, "مستشفى الملك فهد")
        XCTAssertEqual(h.type, "عام")
        XCTAssertEqual(h.lat, 24.7)
    }

    func testHospitalMonitorSummaryDecodesFacilitiesAndAlerts() throws {
        // summarize + alertsInWindow — hospital-monitor-service.js
        let json = #"{"success": true, "window": {"label": "current-shift", "from": "2026-09-18T05:00:00.000Z", "to": null}, "totalTransferred": 8, "currentAtHospital": 3, "lastKnownOnly": 4, "monitoringLost": 1, "avgDwellMin": 12.5, "exceedances": 2, "ongoing": 3, "unmeasured": 1, "facilities": [{"facility": "مستشفى الملك فهد", "cases": 5, "avgDwellMin": 11.0, "exceedances": 1, "ongoing": 2, "unmeasured": 0, "monitoringLost": 0, "journeys": [{"key": "k1", "unitCode": "U-12", "episodeState": "at-hospital", "dwellMin": 15.0, "ongoing": true}]}], "alerts": [{"id": "k1|dwell-exceed", "key": "k1", "type": "dwell-exceed", "state": "open", "facility": "مستشفى الملك فهد", "dwellMin": 15.0, "firstRaisedAt": "2026-09-18T10:00:00.000Z", "unreliable": false}], "activeAlerts": 1}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(HospitalMonitorSummaryDTO.self, from: json)
        XCTAssertEqual(dto.totalTransferred, 8)
        XCTAssertEqual(dto.activeAlerts, 1)
        let fac = try XCTUnwrap(dto.facilities?.first)
        XCTAssertEqual(fac.facility, "مستشفى الملك فهد")
        XCTAssertEqual(fac.journeys?.first?.episodeState, "at-hospital")
        let alert = try XCTUnwrap(dto.alerts?.first)
        XCTAssertEqual(alert.id, "k1|dwell-exceed")
        XCTAssertEqual(alert.state, "open")
    }

    func testHospitalHistoryDecodesEntries() throws {
        let json = #"{"success": true, "key": "k1", "history": [{"at": "2026-09-18T10:00:00.000Z", "key": "k1", "field": "alert", "alert": "raised", "dwellMin": 15.0, "facility": "مستشفى الملك فهد"}]}"#.data(using: .utf8)!
        let dto = try JSONDecoder().decode(HospitalHistoryDTO.self, from: json)
        XCTAssertEqual(dto.history?.first?.alert, "raised")
        XCTAssertEqual(dto.history?.first?.dwellMin, 15.0)
    }

    func testOpsAlertsPermissionKey() {
        // إقرار تنبيهات المراقبة مقيد بـ ops.alerts — server.js:5603
        XCTAssertTrue(PermissionMapper.canOpsAlerts(["ops.alerts"], false))
        XCTAssertFalse(PermissionMapper.canOpsAlerts(["ops.dispatch"], false))
    }
}
