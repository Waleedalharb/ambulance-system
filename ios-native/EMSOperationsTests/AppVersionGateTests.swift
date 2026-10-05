//
//  AppVersionGateTests.swift
//  EMSOperationsTests
//
//  اختبارات منظومة Version Update & Force Update (قرار المالك §17/§18):
//  مقارنة الإصدارات الرقمية (2.9.0 مقابل 2.10.0)، مصفوفة قرار الإنفاذ
//  (force/soft/normal)، فك DTO الاستجابة، وسلوك البوابة عند فشل الشبكة
//  (كاش آخر سياسة ≤ 72 ساعة ثم شاشة Retry — ليس Force تلقائيًا).
//  لا شبكة — fetch يُحقن.
//

import XCTest
@testable import EMSOperations

final class AppVersionGateTests: XCTestCase {

    private func info(latest: String, minimum: String, force: Bool = false) -> AppVersionInfo {
        AppVersionInfo(platform: "ios", latestVersion: latest, minimumVersion: minimum,
                       forceUpdate: force, appStoreUrl: "https://apps.apple.com/app/id1",
                       message: nil)
    }

    // MARK: - المقارنة الرقمية

    func testNumericCompare_2_10_greaterThan_2_9() {
        // مقارنة نصية كانت ستجعل 2.10.0 أصغر من 2.9.0 — هذا هو جوهر الاختبار
        XCTAssertEqual(AppVersionComparator.compare("2.10.0", "2.9.0"), .orderedDescending)
        XCTAssertEqual(AppVersionComparator.compare("2.9.0", "2.10.0"), .orderedAscending)
    }

    func testCompareEqualAndPadding() {
        XCTAssertEqual(AppVersionComparator.compare("2.5.0", "2.5.0"), .orderedSame)
        XCTAssertEqual(AppVersionComparator.compare("2.5", "2.5.0"), .orderedSame)   // بادئة صفرية
        XCTAssertEqual(AppVersionComparator.compare("1.0", "1.0.1"), .orderedAscending)
    }

    func testCompareMajorMinorPatch() {
        XCTAssertEqual(AppVersionComparator.compare("3.0.0", "2.99.99"), .orderedDescending)
        XCTAssertEqual(AppVersionComparator.compare("2.5.1", "2.5.0"), .orderedDescending)
    }

    // MARK: - مصفوفة قرار الإنفاذ (§17)

    func testDecide_forceWhenBelowMinimum() {
        // Test 1: installed 2.4.0 · latest 2.5.0 · minimum 2.5.0 → FORCE
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.4.0", info: info(latest: "2.5.0", minimum: "2.5.0")), .forceUpdate)
    }

    func testDecide_softWhenBetweenMinimumAndLatest() {
        // Test 2: installed 2.4.0 · latest 2.5.0 · minimum 2.4.0 → SOFT
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.4.0", info: info(latest: "2.5.0", minimum: "2.4.0")), .softUpdate)
    }

    func testDecide_normalWhenEqualLatest() {
        // Test 3: installed 2.5.0 · latest 2.5.0 · minimum 2.5.0 → NORMAL
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.5.0", info: info(latest: "2.5.0", minimum: "2.5.0")), .normal)
    }

    func testDecide_normalWhenAboveLatest() {
        // Test 4: installed 2.6.0 · latest 2.5.0 · minimum 2.5.0 → NORMAL (الأحدث ليس مشكلة)
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.6.0", info: info(latest: "2.5.0", minimum: "2.5.0")), .normal)
    }

    func testDecide_forceFlagForcesEvenAboveMinimum() {
        // §9: forceUpdate = true مع وجود إصدار أحدث → FORCE حتى لو >= minimum
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.4.0", info: info(latest: "2.5.0", minimum: "2.4.0", force: true)), .forceUpdate)
    }

    func testDecide_forceFlagDoesNothingWhenAlreadyLatest() {
        // forceUpdate لكن لا يوجد إصدار أحدث — لا حاجز بلا هدف
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.5.0", info: info(latest: "2.5.0", minimum: "2.4.0", force: true)), .normal)
    }

    func testDecide_equalMinimumIsSupported() {
        // installed == minimum → مدعوم (soft إن وُجد أحدث)
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.4.0", info: info(latest: "2.4.0", minimum: "2.4.0")), .normal)
    }

    func testDecide_numericNotLexical() {
        // minimum 2.10.0 مع installed 2.9.0 → FORCE (نصيًا كانت ستمرّ خطأً)
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.9.0", info: info(latest: "2.10.0", minimum: "2.10.0")), .forceUpdate)
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.10.0", info: info(latest: "2.10.0", minimum: "2.9.0")), .normal)
    }

    func testDecide_minimumVersionIsPrimaryGate_neverFlagAlone() {
        // قرار المالك: الشرط الأساسي للمنع installedVersion < minimumVersion —
        // forceUpdate = false لا يسمح إطلاقًا لنسخة أدنى من minimum بالدخول.
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.4.0", info: info(latest: "2.6.0", minimum: "2.5.0", force: false)), .forceUpdate,
                       "نسخة أدنى من minimum تُمنع حتى مع forceUpdate = false")
        // والعكس: نسخة >= minimum مع flag = false لا تُحجب قسريًا — Soft فقط.
        XCTAssertEqual(AppVersionEnforcement.decide(installed: "2.5.0", info: info(latest: "2.6.0", minimum: "2.5.0", force: false)), .softUpdate,
                       "forceUpdate مجرد flag إضافي — ليس هو البوابة الأساسية")
    }

    // MARK: - فك DTO الاستجابة (عقد الخادم)

    func testVersionInfoDecodesServerContract() throws {
        let json = #"""
        {"platform": "ios", "latestVersion": "2.5.0", "minimumVersion": "2.5.0",
         "forceUpdate": true, "appStoreUrl": "https://apps.apple.com/app/id1",
         "message": "تحديث التطبيق مطلوب للمتابعة."}
        """#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(AppVersionInfo.self, from: json)
        XCTAssertEqual(decoded.latestVersion, "2.5.0")
        XCTAssertEqual(decoded.minimumVersion, "2.5.0")
        XCTAssertTrue(decoded.forceUpdate)
        XCTAssertEqual(decoded.platform, "ios")
    }

    // MARK: - سلوك البوابة (fetch مُحقن — بلا شبكة)

    @MainActor
    func testGateAllowsWhenNormal() async {
        let gate = AppVersionGate(fetch: { self.info(latest: "0.0.1", minimum: "0.0.1") }, recheckDebounce: 0)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .allowed)
        XCTAssertFalse(gate.showSoftPrompt)
    }

    @MainActor
    func testGateBlocksWhenForced() async {
        let gate = AppVersionGate(fetch: { self.info(latest: "99.0.0", minimum: "99.0.0") }, recheckDebounce: 0)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .forceUpdate)
        XCTAssertFalse(gate.allowsEntry)
    }

    @MainActor
    func testGateSoftPromptShownOnce() async {
        // الإصدار المثبت في حزمة الاختبارات غالبًا فارغ/قديم → latest أعلى يعطي soft
        let gate = AppVersionGate(fetch: { self.info(latest: "99.0.0", minimum: "0.0.1") }, recheckDebounce: 0)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .allowed)
        XCTAssertTrue(gate.showSoftPrompt)
        gate.showSoftPrompt = false
        await gate.check(force: true)
        XCTAssertFalse(gate.showSoftPrompt, "التنبيه مرة واحدة لكل إصدار في كل إقلاع")
    }

    @MainActor
    func testGateNetworkFailureWithoutCacheShowsRetry() async {
        struct FakeError: Error {}
        AppVersionService.clearCache()
        let gate = AppVersionGate(fetch: { throw FakeError() }, recheckDebounce: 0)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .checkFailed, "فشل الشبكة ≠ Force Update — شاشة Retry")
        XCTAssertFalse(gate.allowsEntry)
    }

    @MainActor
    func testGateNetworkFailureWithFreshCacheAppliesCachedPolicy() async {
        struct FakeError: Error {}
        AppVersionService.clearCache()
        // سياسة مخزنة ناجحة سابقًا تمنع — تُطبَّق حتى بلا اتصال
        AppVersionService.cache(info(latest: "99.0.0", minimum: "99.0.0"))
        let gate = AppVersionGate(fetch: { throw FakeError() }, recheckDebounce: 0)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .forceUpdate, "نسخة صارت ممنوعة تبقى ممنوعة بلا إنترنت (كاش ≤ 72 ساعة)")
        AppVersionService.clearCache()
    }

    @MainActor
    func testGateRetryAfterFailureSucceeds() async {
        struct FakeError: Error {}
        AppVersionService.clearCache()
        var shouldFail = true
        let gate = AppVersionGate(fetch: {
            if shouldFail { throw FakeError() }
            return self.info(latest: "0.0.1", minimum: "0.0.1")
        }, recheckDebounce: 0)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .checkFailed)
        shouldFail = false
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .allowed, "Retry ينجح بعد عودة الشبكة — بلا Loop ولا Crash")
        AppVersionService.clearCache()
    }

    // MARK: - سلوك 404 (توافقية التدشين مقابل السلوك النهائي)

    @MainActor
    func testGateNotFoundAllowsOnlyDuringInitialRolloutCompat() async {
        // مرحلة ما قبل نشر الـEndpoint: خادم قديم بلا المسار → سماح مؤقت
        // حتى لا يُحجب مستخدمو النسخة الحالية (AppVersioningConfig).
        AppVersionService.clearCache()
        let gate = AppVersionGate(fetch: { throw APIError.notFound },
                                  recheckDebounce: 0,
                                  allowNotFoundFallback: true)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .allowed, "404 قبل نشر المسار = سماح توافقي مؤقت")
        XCTAssertTrue(gate.allowsEntry)
        AppVersionService.clearCache()
    }

    @MainActor
    func testGateNotFoundAfterDeploymentIsConfigurationError() async {
        // السلوك النهائي بعد نشر المسار: 404 = خطأ إعداد يحجب الدخول —
        // ليس Allow دائمًا ولا طريقة لتجاوز التحديث الإجباري.
        AppVersionService.clearCache()
        let gate = AppVersionGate(fetch: { throw APIError.notFound },
                                  recheckDebounce: 0,
                                  allowNotFoundFallback: false)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .configurationError)
        XCTAssertFalse(gate.allowsEntry, "404 بعد النشر يحجب الدخول — لا تجاوز")
        AppVersionService.clearCache()
    }

    @MainActor
    func testGateConfigurationErrorRecoversWhenEndpointBack() async {
        // Retry من خطأ الإعداد ينجح فور عودة المسار للعمل.
        AppVersionService.clearCache()
        var missing = true
        let gate = AppVersionGate(fetch: {
            if missing { throw APIError.notFound }
            return self.info(latest: "0.0.1", minimum: "0.0.1")
        }, recheckDebounce: 0, allowNotFoundFallback: false)
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .configurationError)
        missing = false
        await gate.check(force: true)
        XCTAssertEqual(gate.state, .allowed)
        AppVersionService.clearCache()
    }
}
