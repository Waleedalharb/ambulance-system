//
//  AdminNavUITests.swift
//  EMSOperationsUITests
//
//  اختبار إصلاح تنقل مركز الإدارة (مستخلص 131cb29 — 2026-10-13):
//  تسجيل .navigationDestination في جذر ستاك «المزيد» (ProfileView) بدل
//  AdminHubView المدفوعة. يعمل على المحاكي ضد Backend محلي معزول (:3000)
//  عبر -debug_use_dev_server — لا إنتاج، لا تعديل كود منتج.
//  الحسابات (بذر معزول): 4252/test123 إداري (موظف مرتبط) · 99101/test123 عادي.
//

import XCTest

final class AdminNavUITests: XCTestCase {
    let app = XCUIApplication()

    /// الموديولات الثمانية: عنوان البطاقة في المركز → عنوان الشاشة المدفوعة
    private let modules: [(card: String, page: String)] = [
        ("المستخدمون والأدوار", "المستخدمون"),
        ("الصلاحيات الفردية", "الصلاحيات الفردية"),
        ("الموظفون", "الموظفون"),
        ("الفرق والرموز والأنماط", "الفرق والرموز"),
        ("رموز الجداول", "رموز الجداول"),
        ("إشعارات النظام", "إشعارات النظام"),
        ("الإعدادات والمراقبة", "الإعدادات والمراقبة"),
        ("مراجعة الطلبات والإعلانات", "مراجعة الطلبات")
    ]

    override func setUpWithError() throws {
        continueAfterFailure = true
        app.launchArguments = ["-debug_use_dev_server", "YES"]
        app.launch()
        addUIInterruptionMonitor(withDescription: "إذن الإشعارات") { alert in
            for label in ["Don’t Allow", "Don't Allow", "عدم السماح"] {
                let b = alert.buttons[label]
                if b.exists { b.tap(); return true }
            }
            return false
        }
    }

    // MARK: - أدوات

    private func anyText(_ substring: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", substring)).firstMatch
    }

    /// نافذة إذن الإشعارات تخص SpringBoard (لا التطبيق) — مراقب المقاطعة لا
    /// يُطلق قبل أول تفاعل، لذا نفحص صراحة ونرفض الإذن إن ظهرت.
    private func dismissSystemPermissionAlert() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Don’t Allow", "Don't Allow", "عدم السماح"] {
            let b = springboard.alerts.buttons[label]
            if b.waitForExistence(timeout: 2) { b.tap(); return }
        }
    }

    private func login(_ username: String, _ password: String) {
        let loginBtn = app.buttons["تسجيل الدخول"]
        // عزل الجلسات: uninstall على المحاكي لا يمحو Keychain دائمًا، فقد
        // يُستأنف التطبيق بجلسة الاختبار السابق (ظهر في test03: دخل بـ4252
        // بدل 99101 لأن زر الدخول لم يظهر فتخطّى إدخال البيانات بصمت).
        if !loginBtn.waitForExistence(timeout: 5), app.tabBars.buttons["المزيد"].exists {
            logout()
        }
        if loginBtn.waitForExistence(timeout: 5) {
            app.textFields.firstMatch.tap()
            app.typeText(username)
            app.secureTextFields.firstMatch.tap()
            app.typeText(password)
            loginBtn.tap()
        }
        let later = app.buttons["لاحقًا"]
        if later.waitForExistence(timeout: 3) { later.tap() }
        XCTAssertTrue(app.tabBars.buttons["المزيد"].waitForExistence(timeout: 30),
                      "شريط التبويبات لم يظهر بعد الدخول")
        dismissSystemPermissionAlert()
        dismissSystemPermissionAlert()
    }

    private func logout() {
        openProfile()
        let logoutBtn = app.buttons.matching(NSPredicate(format: "label CONTAINS 'تسجيل الخروج'")).firstMatch
        for _ in 0..<10 where !logoutBtn.exists {
            if app.scrollViews.firstMatch.exists {
                app.scrollViews.firstMatch.swipeUp()
            } else {
                app.swipeUp()
            }
            sleep(1)
        }
        if logoutBtn.waitForExistence(timeout: 5) {
            logoutBtn.tap()
            // نافذة التأكيد تعرض زر «تسجيل الخروج» ثانيًا فوق زر الصفحة نفسه —
            // الترتيب الشجري غير مضمون، لذا نختار الزر القابل للنقر فعليًا
            // (حجاب النافذة يجعل زر الصفحة غير hittable). والنقرة إحداثية
            // لأن hit-point العنصري يفشل ({-1,-1}) داخل confirmationDialog
            // على محاكي iOS 27 — عائق XCUITest لا التطبيق.
            let matches = app.buttons.matching(NSPredicate(format: "label == 'تسجيل الخروج'"))
            _ = matches.element(boundBy: 0).waitForExistence(timeout: 4)
            sleep(1)
            for i in 0..<matches.count {
                let b = matches.element(boundBy: i)
                if b.exists && b.isHittable {
                    b.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    break
                }
            }
        }
        XCTAssertTrue(app.buttons["تسجيل الدخول"].waitForExistence(timeout: 15),
                      "لم تظهر شاشة الدخول بعد تسجيل الخروج")
    }

    /// «المزيد» في هذا التطبيق = تبويب Overflow القياسي لـTabView (أكثر من 5
    /// تبويبات) — ProfileView تسكن خلف صف «حسابي» داخله.
    private func openProfile() {
        app.tabBars.buttons["المزيد"].tap()
        sleep(1)
        dismissSystemPermissionAlert()
        // صفوف شاشة «المزيد» SwiftUI مخصصة — ليست UITableView cells بالضرورة
        let row = anyText("حسابي")
        if row.waitForExistence(timeout: 8) { row.tap(); sleep(2) }
        dismissSystemPermissionAlert()
    }

    /// بطاقة مركز الإدارة في «المزيد» (كسولة التصيير — مرّر حتى تظهر)
    private var adminCard: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'مركز الإدارة'")).firstMatch
    }

    @discardableResult
    private func scrollUntilVisible(_ element: XCUIElement, maxSwipes: Int = 10) -> Bool {
        for _ in 0..<maxSwipes {
            if element.exists { return true }
            if app.scrollViews.firstMatch.exists {
                app.scrollViews.firstMatch.swipeUp()
            } else {
                app.swipeUp()
            }
            sleep(1)
        }
        return element.waitForExistence(timeout: 8)
    }

    private func goBack() {
        sleep(2) // انتظار اكتمال حركة الدفع — النقرة المبكرة تصيب زر الشاشة التحتية
        // عائق أداة اختبار (iOS 27 Simulator): النقرة العنصرية .tap() على دائرة
        // الرجوع الزجاجية الجديدة لا تُفعّلها — أثبته المسبار P3 (METHOD-A لا
        // يفعل شيئًا). النقرة الإحداثية الخام على موضع الدائرة تحاكي إصبع
        // المستخدم فعليًا وتعمل (METHOD-C) — لذا نستخدمها هنا لقياس سلوك
        // التطبيق الحقيقي لا سلوك XCUITest. الدائرة أعلى يمين الشاشة (RTL).
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.095)).tap()
        sleep(1)
    }

    /// علامة التواجد داخل مركز الإدارة: عنوان أول موديول (بطاقة «مركز الإدارة»
    /// نفسها موجودة أيضًا في «المزيد» فلا تصلح وحدها علامة).
    private var hubMarker: XCUIElement { anyText("الإجراءات الحساسة موثقة") }

    // MARK: - 1) فتح المركز من أول ضغطة والرجوع — 10 مرات متتالية

    func test01_openAndBackTenTimes() throws {
        login("4252", "test123")
        openProfile()
        XCTAssertTrue(scrollUntilVisible(adminCard), "بطاقة مركز الإدارة غير ظاهرة للإداري")
        for round in 1...10 {
            adminCard.tap()
            XCTAssertTrue(hubMarker.waitForExistence(timeout: 10),
                          "المحاولة \(round): المركز لم يفتح من أول ضغطة")
            goBack()
            XCTAssertTrue(adminCard.waitForExistence(timeout: 10),
                          "المحاولة \(round): لم نعد لشاشة «المزيد» بعد الرجوع")
        }
        logout()
    }

    // MARK: - 2) الموديولات الثمانية — فتح ورجوع طبيعي

    func test02_allEightModules() throws {
        login("4252", "test123")
        openProfile()
        XCTAssertTrue(scrollUntilVisible(adminCard), "بطاقة مركز الإدارة غير ظاهرة")
        adminCard.tap()
        XCTAssertTrue(hubMarker.waitForExistence(timeout: 10), "المركز لم يفتح")
        for (card, page) in modules {
            let link = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", card)).firstMatch
            XCTAssertTrue(scrollUntilVisible(link, maxSwipes: 8), "بطاقة «\(card)» غير ظاهرة في المركز")
            link.tap()
            XCTAssertTrue(anyText(page).waitForExistence(timeout: 12),
                          "شاشة «\(page)» لم تفتح")
            goBack()
            XCTAssertTrue(hubMarker.waitForExistence(timeout: 10),
                          "لم نعد لمركز الإدارة بعد «\(page)»")
        }
        goBack() // رجوع من المركز إلى «المزيد»
        XCTAssertTrue(adminCard.waitForExistence(timeout: 10), "لم نعد لشاشة «المزيد»")
        logout()
    }

    // MARK: - 3) حساب بلا صلاحيات إدارية — لا بطاقة مركز إدارة

    func test03_noAdminCardForNonAdmin() throws {
        login("99101", "test123")
        openProfile()
        // مرّر الصفحة كاملة للتأكد من عدم وجود البطاقة في أي موضع
        for _ in 0..<6 {
            if app.scrollViews.firstMatch.exists {
                app.scrollViews.firstMatch.swipeUp()
            } else {
                app.swipeUp()
            }
            sleep(1)
        }
        XCTAssertFalse(anyText("مركز الإدارة").exists,
                       "بطاقة مركز الإدارة ظهرت لحساب بلا صلاحيات إدارية")
        logout()
    }

    // MARK: - 4) تراجع: «مناوبتي» والإشعارات يعملان بعد الجولات

    /// مسبار مؤقت 2: ماذا يحدث فعليًا عند الضغط على زر الرجوع في شاشة موديول
    /// نسخة متعددة الطرق: يجرّب كل وسيلة رجوع بالتتابع ويحدد أيها يعمل فعلًا
    func test98_probeBack() throws {
        func state(_ tag: String) {
            print("\(tag) hub:", hubMarker.exists,
                  "onModule:", anyText("إنشاء حساب موظف").exists,
                  "onProfile:", anyText("تغيير كلمة المرور").exists,
                  "onMoreList:", anyText("البلوت").exists,
                  "bars:", app.navigationBars.count)
        }
        login("4252", "test123")
        openProfile()
        _ = scrollUntilVisible(adminCard)
        adminCard.tap()
        _ = hubMarker.waitForExistence(timeout: 10)
        sleep(2)
        let link = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "المستخدمون والأدوار")).firstMatch
        _ = scrollUntilVisible(link, maxSwipes: 8)
        link.tap()
        _ = anyText("إنشاء حساب موظف").waitForExistence(timeout: 12)
        sleep(3)
        state("P3-ONMODULE")
        for i in 0..<app.navigationBars.count {
            let bb = app.navigationBars.element(boundBy: i).buttons
            for j in 0..<bb.count {
                let b = bb.element(boundBy: j)
                print("P3-BAR\(i)-BTN\(j): [\(b.label)] frame=\(b.frame) hittable=\(b.isHittable)")
            }
        }
        // أ) الطريقة الحالية: آخر شريط تنقل، أول زر
        if app.navigationBars.count > 0 {
            app.navigationBars.element(boundBy: app.navigationBars.count - 1).buttons.element(boundBy: 0).tap()
            _ = hubMarker.waitForExistence(timeout: 3)
            state("P3-AFTER-A-navbarBtn")
            if hubMarker.exists { print("P3-RESULT: METHOD-A WORKS"); return }
        }
        // ب) الزر المسمى بعنوان الشاشة مباشرة
        let titled = app.buttons["المستخدمون"]
        if titled.exists {
            titled.tap()
            _ = hubMarker.waitForExistence(timeout: 3)
            state("P3-AFTER-B-titledBtn")
            if hubMarker.exists { print("P3-RESULT: METHOD-B WORKS"); return }
        }
        // ج) نقرة إحداثيات على موضع الدائرة المرئية (أعلى يمين الشاشة RTL)
        let circle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.095))
        circle.tap()
        _ = hubMarker.waitForExistence(timeout: 3)
        state("P3-AFTER-C-coordinate")
        if hubMarker.exists { print("P3-RESULT: METHOD-C WORKS"); return }
        // د) سحبة الرجوع من الحافة اليمنى (RTL)
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5))
        let mid = app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
        edge.press(forDuration: 0.1, thenDragTo: mid)
        _ = hubMarker.waitForExistence(timeout: 3)
        state("P3-AFTER-D-edgeSwipe")
        print(hubMarker.exists ? "P3-RESULT: METHOD-D WORKS" : "P3-RESULT: ALL METHODS FAILED")
    }

    /// مسبار مؤقت: يكشف بنية أشرطة التنقل وأزرار الرجوع في المركز والموديول
    func test99_probe() throws {
        login("4252", "test123")
        openProfile()
        _ = scrollUntilVisible(adminCard)
        adminCard.tap()
        _ = hubMarker.waitForExistence(timeout: 10)
        sleep(2)
        print("PROBE-HUB-BARS:", app.navigationBars.count)
        for i in 0..<app.navigationBars.count {
            let labels = app.navigationBars.element(boundBy: i).buttons.allElementsBoundByIndex.map { $0.label }
            print("PROBE-HUB-BAR", i, labels)
        }
        let link = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "المستخدمون والأدوار")).firstMatch
        _ = scrollUntilVisible(link, maxSwipes: 8)
        link.tap()
        _ = anyText("المستخدمون").waitForExistence(timeout: 12)
        sleep(2)
        print("PROBE-MOD-BARS:", app.navigationBars.count)
        for i in 0..<app.navigationBars.count {
            let labels = app.navigationBars.element(boundBy: i).buttons.allElementsBoundByIndex.map { $0.label }
            print("PROBE-MOD-BAR", i, labels)
        }
        print("PROBE-MOD-TOPBTNS:", app.buttons.allElementsBoundByIndex.prefix(10).map { $0.label })
    }

    func test04_regressionTabs() throws {
        login("99101", "test123")
        app.tabBars.buttons["مناوباتي"].tap()
        XCTAssertTrue(anyText("المناوبات القادمة").waitForExistence(timeout: 20),
                      "شاشة مناوباتي لم تفتح — تراجع محتمل")
        // «الإشعارات» تبويب فائض ضمن قائمة «المزيد» (ثمانية تبويبات > خمسة —
        // بنية قائمة قبل الإصلاح ولم تتغير): يُفتح من صفّه في القائمة، ولا
        // يوجد له زر في شريط التبويبات — الدليل: No matches for "إشعارات"
        // IN identifiers في tabBars، ولقطات القائمة تُظهر صفه فيها.
        app.tabBars.buttons["المزيد"].tap()
        sleep(1)
        let notifRow = anyText("الإشعارات")
        XCTAssertTrue(notifRow.waitForExistence(timeout: 8),
                      "صف «الإشعارات» غير ظاهر في قائمة المزيد — تراجع محتمل")
        notifRow.tap()
        sleep(2)
        XCTAssertTrue(anyText("إشعارات").waitForExistence(timeout: 15),
                      "شاشة الإشعارات لم تفتح — تراجع محتمل")
        logout()
    }
}
