//
//  EMSTheme.swift
//  EMSOperations
//
//  نظام التصميم (قسم 33): الهوية المعتمدة — Navy/Teal/Emerald/White/Black.
//  هادئة وواضحة؛ لا ألوان صارخة إلا للضرورة التشغيلية.
//

import SwiftUI

enum EMSTheme {
    enum Colors {
        static let navy = Color(red: 0.027, green: 0.059, blue: 0.125)      // #070F20
        static let navySoft = Color(red: 0.06, green: 0.10, blue: 0.19)
        static let card = Color(red: 0.09, green: 0.14, blue: 0.24)
        static let teal = Color(red: 0.10, green: 0.72, blue: 0.66)
        static let emerald = Color(red: 0.13, green: 0.77, blue: 0.45)
        static let textPrimary = Color.white
        static let textSecondary = Color.white.opacity(0.72)
        static let textMuted = Color.white.opacity(0.5)
        static let danger = Color(red: 0.94, green: 0.36, blue: 0.36)
        static let warning = Color(red: 0.96, green: 0.72, blue: 0.25)
        static let divider = Color.white.opacity(0.10)
    }

    /// حالات التشغيل: Normal/Monitor/Action (قسم 33).
    enum StatusTone {
        case normal, monitor, action, danger, neutral
        var color: Color {
            switch self {
            case .normal: return Colors.emerald
            case .monitor: return Colors.warning
            case .action: return Colors.teal
            case .danger: return Colors.danger
            case .neutral: return Colors.textMuted
            }
        }
    }

    static let cornerRadius: CGFloat = 16
    static let cardPadding: CGFloat = 16
    static let pagePadding: CGFloat = 16
    static let spacing: CGFloat = 12
}

/// أسماء مختصرة مستخدمة عبر الواجهات
typealias EMSTypography = EMSTheme.Type

extension EMSTheme {
    static let titleArabic = Font.system(.title3, design: .default, weight: .bold)
    static let headlineArabic = Font.system(.headline, weight: .semibold)
    static let bodyArabic = Font.system(.body)
    static let captionArabic = Font.system(.caption)
    static let captionLatin = Font.system(.caption, design: .monospaced)
}
