//
//  BalootCardFaceRenderTests.swift
//  EMSOperationsTests
//
//  لقطة تحقق بصرية (قرار المالك 2026-10-05): تصيير يد ورق حقيقية عبر
//  ImageRenderer من نفس مكوّن الإنتاج BalootCardFace وحفظها PNG على
//  مسار المضيف — للمقارنة المباشرة مع مرجع ورق اللعب التقليدي.
//  لا منطق هنا — تصيير فقط.
//

import XCTest
import SwiftUI
@testable import EMSOperations

final class BalootCardFaceRenderTests: XCTestCase {

    private static func card(_ code: String) -> BalootCardDTO {
        let json = #"{"code":"\#(code)"}"#.data(using: .utf8)!
        return try! JSONDecoder().decode(BalootCardDTO.self, from: json)
    }

    @MainActor
    func testRenderRealisticHand() throws {
        // يد تغطي كل الفئات المطلوبة في مراجعة المالك: A / رقم / J / Q / K
        let codes = ["SA", "H9", "DJ", "CQ", "HK"]
        let view =
            ZStack {
                Color(red: 0.06, green: 0.23, blue: 0.15).ignoresSafeArea()
                HStack(spacing: 10) {
                    ForEach(codes, id: \.self) { code in
                        BalootCardFace(card: Self.card(code), size: .hand)
                    }
                }
                .padding(20)
            }
            .frame(width: 430, height: 170)

        let renderer = ImageRenderer(content: view)
        renderer.scale = 3
        guard let uiImage = renderer.uiImage, let png = uiImage.pngData() else {
            XCTFail("تعذر تصيير اليد"); return
        }
        let out = URL(fileURLWithPath: "/Users/waleedalharbi/Documents/kimi/tasks/2026-10-03/15-57-49-5263b95b/baloot-real-hand.png")
        try png.write(to: out)
    }

    @MainActor
    func testRenderAllThirtyTwoFaces() throws {
        let suits = ["S", "H", "D", "C"]
        let ranks = ["A", "K", "Q", "J", "T", "9", "8", "7"]
        let view =
            ZStack {
                Color(red: 0.06, green: 0.23, blue: 0.15).ignoresSafeArea()
                VStack(spacing: 6) {
                    ForEach(suits, id: \.self) { s in
                        HStack(spacing: 6) {
                            ForEach(ranks, id: \.self) { r in
                                BalootCardFace(card: Self.card("\(s)\(r)"), size: .medium)
                            }
                        }
                    }
                }
                .padding(14)
            }
            .frame(width: 560, height: 390)

        let renderer = ImageRenderer(content: view)
        renderer.scale = 3
        guard let uiImage = renderer.uiImage, let png = uiImage.pngData() else {
            XCTFail("تعذر تصيير المجموعة"); return
        }
        let out = URL(fileURLWithPath: "/Users/waleedalharbi/Documents/kimi/tasks/2026-10-03/15-57-49-5263b95b/baloot-real-all32.png")
        try png.write(to: out)
    }
}
