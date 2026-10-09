//
//  SupplementaryUITests.swift
//  EMSOperationsUITests
//
//  الاختبار البصري المعزول لقسم «الجدول المرن» (معتمد 2026-10-08):
//  التطبيق يعمل على المحاكي ضد Backend الـworking tree المحلي (:3000)
//  عبر -debug_use_dev_server (DEBUG فقط) — لا تعديل كود، لا إنتاج.
//  اللقطات تُكتب PNG في tmp المحاكي بأسماء flex-NN ثم تُستخرج مضيفيًا.
//  حساب الاختبار: 99101 / test123 (مبذور في البيئة المعزولة).
//

import XCTest

final class SupplementaryUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = true
        app.launchArguments = ["-debug_use_dev_server", "YES"]
        app.launch()
        // اعتراض نافذة إذن الإشعارات النظامية حتى لا تحجب عناصر التطبيق
        addUIInterruptionMonitor(withDescription: "إذن الإشعارات") { alert in
            for label in ["Don’t Allow", "Don't Allow", "عدم السماح"] {
                let b = alert.buttons[label]
                if b.exists { b.tap(); return true }
            }
            return false
        }
    }

    // MARK: - أدوات

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "flex-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("flex-\(name).png")
        try? screenshot.pngRepresentation.write(to: url)
    }

    private func loginIfNeeded() {
        let loginBtn = app.buttons["تسجيل الدخول"]
        if loginBtn.waitForExistence(timeout: 4) {
            app.textFields.firstMatch.tap()
            app.typeText("99101")
            app.secureTextFields.firstMatch.tap()
            app.typeText("test123")
            loginBtn.tap()
        }
        // نافذة البصمة الاختيارية
        let later = app.buttons["لاحقًا"]
        if later.waitForExistence(timeout: 3) { later.tap() }
        let tab = app.tabBars.buttons["مناوباتي"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30), "تبويب مناوباتي لم يظهر بعد الدخول")
        tab.tap()
        XCTAssertTrue(app.staticTexts["الجدول المرن"].waitForExistence(timeout: 30),
                      "قسم الجدول المرن لم يظهر")
    }

    /// العودة لأعلى الصفحة بنقرة شريط الحالة (عنصر نظامي في SpringBoard) —
    /// أسرع من التمرير المتكرر ويتجنب علق XCTest عند «Wait for app to idle».
    private func jumpToTop() {
        XCUIApplication(bundleIdentifier: "com.apple.springboard").statusBars.firstMatch.tap()
        sleep(1)
    }

    private func scrollDown(_ times: Int = 2) {
        for _ in 0..<times { app.scrollViews.firstMatch.swipeUp() }
    }

    private func scrollUp(_ times: Int = 2) {
        for _ in 0..<times { app.scrollViews.firstMatch.swipeDown() }
    }

    /// تمرير تدريجي حتى يظهر العنصر (المحتوى كسول التصيير — العناصر خارج
    /// الشاشة قد لا توجد في شجرة الوصول أصلًا).
    @discardableResult
    private func scrollUntilVisible(_ element: XCUIElement, maxSwipes: Int = 12) -> Bool {
        for _ in 0..<maxSwipes {
            if element.exists { return true }
            app.scrollViews.firstMatch.swipeUp()
            sleep(1) // انتظار اكتمال حركة التمرير وتصيير العناصر الكسولة
        }
        return element.waitForExistence(timeout: 8)
    }

    /// أزرار «اختيار» للبطاقات غير المختارة (label البطاقة يجمع نصوصها).
    private var selectButtons: XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'اختيار' AND NOT (label CONTAINS 'تم الاختيار')"))
    }

    /// أي عنصر (نص أو بطاقة مدمجة) يحتوي النص — SwiftUI قد يدمج نصوص البطاقة في عنصر واحد.
    private func anyText(_ substring: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", substring)).firstMatch
    }

    // MARK: - 1) ظهور البطاقات والعقد البصري + RTL والتمرير

    func test01_candidatesVisible() throws {
        loginIfNeeded()
        scrollDown(3)
        XCTAssertTrue(anyText("تكميلية صباحية").waitForExistence(timeout: 10), "بطاقة CPD غير ظاهرة")
        XCTAssertTrue(anyText("تكميلية ليلية").exists, "بطاقة CPN غير ظاهرة")
        shot("01-candidates")
        // الأيام غير المتاحة بأسباب مترجمة من الـBackend
        scrollDown(6)
        let unavail = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'يوجد طلب أو مناوبة في هذا اليوم' OR label CONTAINS 'لا يحقق فترة الراحة المطلوبة'"))
        XCTAssertTrue(unavail.firstMatch.waitForExistence(timeout: 10), "قائمة غير المتاح وأسبابها غير ظاهرة")
        shot("02-unavailable-reasons")
    }

    // MARK: - 2) اختيار وإلغاء اختيار

    func test02_selectAndDeselect() throws {
        loginIfNeeded()
        scrollDown(2)
        let first = selectButtons.firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10), "لا بطاقة اختيار ظاهرة")
        first.tap()
        // البطاقة نفسها تتحول محليًا إلى «تم الاختيار»
        let chosen = app.buttons.matching(NSPredicate(format: "label CONTAINS 'تم الاختيار'")).firstMatch
        XCTAssertTrue(chosen.waitForExistence(timeout: 5), "البطاقة لم تتحول إلى «تم الاختيار»")
        shot("03-selected-one")
        // التذييل أسفل القسم (كسول التصيير) — مرّر حتى يظهر
        // (الرقم يُصاغ بلغة الجهاز — المطابقة بدونه)
        XCTAssertTrue(scrollUntilVisible(anyText("اختياراتك:")), "ملخص الاختيار لم يظهر")
        XCTAssertTrue(anyText("إرسال طلب المناوبة التكميلية").exists, "زر الإرسال غير ظاهر")
        // إلغاء الاختيار بالضغط على البطاقة نفسها
        jumpToTop()
        scrollDown(2)
        XCTAssertTrue(chosen.waitForExistence(timeout: 5), "البطاقة المختارة غير قابلة للوصول")
        chosen.tap()
        XCTAssertFalse(chosen.waitForExistence(timeout: 3), "البطاقة بقيت مختارة بعد الإلغاء")
        shot("04-deselected")
    }

    // MARK: - 3) اختيار متعدد + استبدال ضمن نفس اليوم

    func test03_multiSelectAndSameDayReplace() throws {
        loginIfNeeded()
        // كل عنصر داخل البطاقة يظهر كعنصر مستقل قابل للضغط — التاريخ «12-10-2026»
        // يوجد مرتين (بطاقتا CPD وCPN لنفس اليوم في البذر المعتمد)
        let dayButtons = app.buttons.matching(NSPredicate(format: "label == '12-10-2026'"))
        XCTAssertTrue(scrollUntilVisible(dayButtons.firstMatch, maxSwipes: 4), "بطاقات 12 أكتوبر غير ظاهرة")
        XCTAssertEqual(dayButtons.count, 2, "المفروض بطاقتان ليوم 12 أكتوبر (CPD وCPN)")
        dayButtons.element(boundBy: 0).tap()
        let chosenNow = app.buttons.matching(NSPredicate(format: "label == 'تم الاختيار'"))
        XCTAssertTrue(chosenNow.firstMatch.waitForExistence(timeout: 5), "الاختيار الأول لم يُسجل")
        // البطاقة الأخرى لنفس اليوم ⇒ استبدال لا إضافة
        dayButtons.element(boundBy: 1).tap()
        sleep(1)
        XCTAssertEqual(chosenNow.count, 1, "اختيار رمز آخر لنفس اليوم يجب أن يبقى بطاقة واحدة مختارة")
        shot("05-same-day-replaced")
        // يوم مختلف ⇒ يُضاف اختيار ثانٍ
        scrollUp(4)
        let other = app.buttons.matching(NSPredicate(format: "label == '09-10-2026'")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 5), "بطاقة 9 أكتوبر غير ظاهرة")
        other.tap()
        XCTAssertTrue(chosenNow.element(boundBy: 1).waitForExistence(timeout: 5), "يوم مختلف يجب أن يضيف اختيارًا ثانيًا")
        shot("06-two-days-selected")
        // تنظيف: إلغاء الكل حتى لا تتأثر الاختبارات اللاحقة
        while chosenNow.firstMatch.exists { chosenNow.firstMatch.tap(); sleep(1) }
    }

    // MARK: - 4) الإرسال ⇒ pending_review + «طلباتي»

    func test04_submitPendingReview() throws {
        loginIfNeeded()
        scrollDown(2)
        let first = selectButtons.firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        let submit = app.buttons.matching(NSPredicate(format: "label CONTAINS 'إرسال طلب المناوبة التكميلية'")).firstMatch
        XCTAssertTrue(scrollUntilVisible(submit), "زر الإرسال لم يظهر")
        shot("07-before-submit")
        submit.tap()
        // التنبيه أعلى القسم — ارجع للأعلى بنقرة شريط الحالة
        jumpToTop()
        XCTAssertTrue(anyText("بانتظار مراجعة المسؤول").waitForExistence(timeout: 20),
                      "تنبيه نجاح الإرسال لم يظهر")
        // «طلباتي» أسفل القسم
        XCTAssertTrue(scrollUntilVisible(anyText("طلباتي")), "قائمة طلباتي غير ظاهرة")
        XCTAssertTrue(anyText("بانتظار المراجعة").waitForExistence(timeout: 10), "حالة pending_review غير ظاهرة")
        shot("08-pending-review")
    }

    // MARK: - 5) إلغاء الطلب

    func test05_cancelRequest() throws {
        loginIfNeeded()
        let cancel = app.buttons["إلغاء الطلب"]
        XCTAssertTrue(scrollUntilVisible(cancel), "زر إلغاء الطلب غير ظاهر")
        shot("09-before-cancel")
        cancel.tap()
        XCTAssertTrue(anyText("ملغى").waitForExistence(timeout: 15), "حالة ملغى لم تظهر بعد الإلغاء")
        shot("10-cancelled")
    }

    // MARK: - 6) الجدول الرسمي لا يتغير إطلاقًا

    func test06_officialScheduleUntouched() throws {
        loginIfNeeded()
        // «المناوبات القادمة» أعلى الصفحة — المبذور: 11 و 13 أكتوبر 2026
        XCTAssertTrue(app.staticTexts["المناوبات القادمة"].waitForExistence(timeout: 15))
        XCTAssertTrue(anyText("11-10-2026").exists, "مناوبة 11 أكتوبر الرسمية مفقودة")
        XCTAssertTrue(anyText("13-10-2026").exists, "مناوبة 13 أكتوبر الرسمية مفقودة")
        shot("11-official-schedule-intact")
    }

    // MARK: - 7) 503 SUPP_CONFIG_MISSING (تُشغَّل منفصلة بعد حذف الإعدادين)

    func test07_configMissing503() throws {
        loginIfNeeded()
        XCTAssertTrue(app.staticTexts["هذه الميزة غير مفعّلة بعد — ستتوفر قريبًا."].waitForExistence(timeout: 20),
                      "رسالة 503 المفهومة لم تظهر")
        shot("12-config-missing")
    }
}
