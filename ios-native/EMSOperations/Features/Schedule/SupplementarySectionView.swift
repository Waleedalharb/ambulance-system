//
//  SupplementarySectionView.swift
//  EMSOperations
//
//  قسم «الجدول المرن» داخل «مناوبتي» (معتمد 2026-10-08) — أسفل
//  «المناوبات القادمة» مباشرة، والجدول الرسمي يبقى واضحًا ومنفصلًا عنه.
//  المرجع البصري: صورة المالك (لقطة مناوبتي) — بلا نسخ تواريخ/ساعات/أرقام
//  منها؛ كل البيانات من GET /api/my/supplementary-candidates + طلباتي.
//
//  القاعدة الذهبية: الاختيار Local UI State فقط — لا request عند الضغط على
//  بطاقة، والمختار لا يظهر كمناوبة رسمية إلا بعد applied من مصدر الجدول
//  الرسمي (قسم «المناوبات القادمة» لا يُمس).
//
//  تجربة «مقعد السينما»: بطاقات واضحة 🟢 متاح / 🔵 تم الاختيار / ⚪ غير متاح،
//  عدّاد «اختياراتك: N»، وزر إرسال واحد.
//

import SwiftUI

struct SupplementarySectionView: View {
    @StateObject private var vm = SupplementaryViewModel()

    private let refBlue = Color(red: 0.36, green: 0.62, blue: 0.98)

    var body: some View {
        VStack(spacing: 10) {
            header
            switch vm.state {
            case .loading:
                EMSSkeletonCard(lines: 3)
            case .configMissing:
                noticeRow(icon: "gearshape", tint: EMSTheme.Colors.warning,
                          text: "هذه الميزة غير مفعّلة بعد — ستتوفر قريبًا.")
            case .forbidden:
                noticeRow(icon: "lock.fill", tint: EMSTheme.Colors.warning,
                          text: APIError.forbidden.userMessage)
            case .failed(let message):
                EMSErrorView(message: message) { Task { await vm.load() } }
            case .empty:
                noticeRow(icon: "calendar.badge.exclamationmark", tint: EMSTheme.Colors.textMuted,
                          text: "لا توجد أيام مقترحة متبقية في هذا الشهر.")
            case .loaded:
                loadedContent
            }
        }
        .padding(12)
        .background(EMSTheme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: EMSTheme.cornerRadius, style: .continuous))
        .task { await vm.load() }
    }

    // MARK: - الترويسة

    private var header: some View {
        // RTL: الأيقونة والعنوان يمينًا — ترتيب القراءة العربية
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 7) {
                Image(systemName: "calendar.badge.plus")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(EMSTheme.Colors.teal)
                    .frame(width: 26, height: 26)
                    .background(EMSTheme.Colors.teal.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text("الجدول المرن")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                Spacer()
            }
            Text("أيام مقترحة يمكنك اختيارها لطلب مناوبة تكميلية")
                .font(.system(size: 10))
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - المحتوى المحمَّل

    @ViewBuilder
    private var loadedContent: some View {
        if let dto = vm.dto {
            if dto.hours != nil || dto.limits != nil {
                guidanceRow(dto)
            }
        }
        if let feedback = vm.submitFeedback {
            feedbackRow(feedback)
        }
        if let dto = vm.dto, !dto.candidates.isEmpty {
            candidatesGrid(dto.candidates)
        } else {
            noticeRow(icon: "calendar.badge.exclamationmark", tint: EMSTheme.Colors.textMuted,
                      text: "لا توجد أيام مقترحة متبقية في هذا الشهر.")
        }
        if let dto = vm.dto, !dto.unavailable.isEmpty {
            unavailableList(dto.unavailable)
        }
        if !vm.myRequests.isEmpty {
            myRequestsList
        }
        selectionFooter
    }

    /// الساعات + العدّاد — معلومات توجيهية فقط (ليست بوابة أهلية)، تُعرض إذا
    /// رجعها الـAPI، وأي حقل غائب يُخفى بصدق.
    private func guidanceRow(_ dto: SupplementaryCandidatesDTO) -> some View {
        HStack(spacing: 9) {
            if let h = dto.hours, h.workedHours != nil || h.requiredHours != nil {
                hoursTile(h)
            }
            if let l = dto.limits, let max = l.maxPerMonth, let used = l.used {
                limitTile(used: used, max: max)
            }
        }
    }

    private func hoursTile(_ h: SupplementaryCandidatesDTO.Hours) -> some View {
        let worked = h.workedHours ?? 0
        let required = h.requiredHours
        let ratio = (required ?? 0) > 0 ? min(1, worked / (required ?? 1)) : 0
        return HStack(spacing: 8) {
            ZStack {
                Circle().stroke(EMSTheme.Colors.navySoft, lineWidth: 5)
                Circle()
                    .trim(from: 0, to: ratio)
                    .stroke(EMSTheme.Colors.teal, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(verbatim: "\(Int(ratio * 100))%")
                    .font(.system(size: 9).weight(.bold).monospacedDigit())
                    .foregroundStyle(.white)
            }
            .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 1) {
                if let required {
                    Text(verbatim: "\(hoursText(worked)) / \(hoursText(required))")
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(.white)
                } else {
                    Text(verbatim: hoursText(worked))
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(.white)
                }
                Text("ساعات الشهر")
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                if let remaining = h.remainingHours {
                    Text("متبقي \(hoursText(remaining)) ساعة")
                        .font(.system(size: 9))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(EMSTheme.Colors.navySoft)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func limitTile(used: Int, max: Int) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "list.number")
                .font(.subheadline)
                .foregroundStyle(refBlue)
                .frame(width: 30, height: 30)
                .background(refBlue.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: "\(used) / \(max)")
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(.white)
                Text("مناوبات تكميلية هذا الشهر")
                    .font(.system(size: 9))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(EMSTheme.Colors.navySoft)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func hoursText(_ hours: Double) -> String {
        hours == hours.rounded() ? "\(Int(hours))" : String(format: "%.1f", hours)
    }

    private func feedbackRow(_ feedback: SupplementaryViewModel.Feedback) -> some View {
        HStack(spacing: 8) {
            Image(systemName: feedback.failed == 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(feedback.failed == 0 ? EMSTheme.Colors.emerald : EMSTheme.Colors.warning)
            VStack(alignment: .leading, spacing: 1) {
                if feedback.sent > 0 {
                    Text("أُرسل \(feedback.sent) طلب — بانتظار مراجعة المسؤول.")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                }
                if feedback.failed > 0 {
                    Text("تعذر إرسال \(feedback.failed) طلب." + (feedback.firstRejection.map { " \($0)" } ?? ""))
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                }
            }
            Spacer()
            Button { vm.submitFeedback = nil } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.textMuted)
            }
            .buttonStyle(.plain)
        }
        .padding(8)
        .background(EMSTheme.Colors.navySoft)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - بطاقات المقترحات (🟢 متاح / 🔵 تم الاختيار)

    private func candidatesGrid(_ candidates: [SupplementaryCandidatesDTO.Candidate]) -> some View {
        let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        return LazyVGrid(columns: columns, spacing: 8) {
            ForEach(candidates) { candidate in
                candidateCard(candidate)
            }
        }
    }

    private func candidateCard(_ c: SupplementaryCandidatesDTO.Candidate) -> some View {
        let selected = vm.isSelected(c)
        return VStack(spacing: 5) {
            // اليوم + التاريخ + أيقونة صباح/ليل (من period السيرفري — لا استنتاج من الرمز)
            HStack {
                Text(vm.weekdayName(c.date))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(selected ? EMSTheme.Colors.navy : .white)
                Spacer(minLength: 2)
                Image(systemName: c.isNight ? "moon.fill" : "sun.max.fill")
                    .font(.caption2)
                    .foregroundStyle(selected ? EMSTheme.Colors.navy : (c.isNight ? refBlue : EMSTheme.Colors.warning))
            }
            Text(verbatim: vm.dashedDate(c.date))
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(selected ? EMSTheme.Colors.navy : EMSTheme.Colors.textSecondary)
            if let name = c.shiftName, !name.isEmpty {
                Text(name)
                    .font(.system(size: 9).weight(.semibold))
                    .foregroundStyle(selected ? EMSTheme.Colors.navy : EMSTheme.Colors.teal)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            if let s = c.timeStart, let e = c.timeEnd {
                Text(verbatim: "\(String(s.prefix(5))) - \(String(e.prefix(5)))")
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundStyle(selected ? EMSTheme.Colors.navy.opacity(0.8) : EMSTheme.Colors.textMuted)
            }
            if let d = c.durationHours {
                Text("\(hoursText(d)) ساعة")
                    .font(.system(size: 9))
                    .foregroundStyle(selected ? EMSTheme.Colors.navy.opacity(0.8) : EMSTheme.Colors.textMuted)
            }
            // حالة التوافق: المقترحات اجتازت E-4 سيرفريًا + فجوة التغطية إن رجعت
            HStack(spacing: 3) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 9))
                Text("متوافق")
                    .font(.system(size: 9).weight(.semibold))
                if c.coverageGap == true {
                    Text("· يغطي فجوة")
                        .font(.system(size: 9))
                }
            }
            .foregroundStyle(selected ? EMSTheme.Colors.navy : EMSTheme.Colors.emerald)
            // زر الاختيار
            Text(selected ? "تم الاختيار" : "اختيار")
                .font(.caption2.weight(.bold))
                .foregroundStyle(selected ? EMSTheme.Colors.navy : EMSTheme.Colors.teal)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(selected ? EMSTheme.Colors.navy.opacity(0.15) : EMSTheme.Colors.teal.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(selected ? Color.clear : EMSTheme.Colors.teal.opacity(0.5), lineWidth: 1)
                )
        }
        .padding(8)
        .background(selected ? EMSTheme.Colors.teal : EMSTheme.Colors.navySoft)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(selected ? EMSTheme.Colors.teal : Color.clear, lineWidth: 1.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onTapGesture { vm.toggle(c) }
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - غير المتاح (⚪ — أسباب الـBackend مترجمة، لا إعادة حساب محلية)

    private func unavailableList(_ entries: [SupplementaryCandidatesDTO.Unavailable]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("أيام غير متاحة حاليًا")
                .font(.system(size: 10).weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textMuted)
            ForEach(entries) { entry in
                HStack(spacing: 7) {
                    Image(systemName: "minus.circle")
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Text(verbatim: vm.dashedDate(entry.date))
                        .font(.system(size: 10).monospacedDigit())
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Text(entry.shiftCode)
                        .font(.system(size: 10).weight(.semibold))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                    Spacer(minLength: 4)
                    Text(vm.reasonMessages(for: entry).joined(separator: " · "))
                        .font(.system(size: 9))
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
        .padding(8)
        .background(EMSTheme.Colors.navySoft.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - طلباتي (الحالات السبع)

    private var myRequestsList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("طلباتي")
                .font(.system(size: 10).weight(.semibold))
                .foregroundStyle(EMSTheme.Colors.textMuted)
            ForEach(vm.myRequests.prefix(5)) { req in
                HStack(spacing: 7) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(verbatim: vm.dashedDate(req.targetDate ?? ""))
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(.white)
                            if let code = req.shiftCode {
                                Text(code)
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(EMSTheme.Colors.teal)
                            }
                        }
                        if let note = req.reviewNote, !note.isEmpty, req.status == "rejected" {
                            Text(note)
                                .font(.system(size: 9))
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 4)
                    EMSStatusPill(text: SupplementaryStatusDisplay.title(for: req.status),
                                  tone: SupplementaryStatusDisplay.tone(for: req.status))
                    if req.isCancellable {
                        Button {
                            Task { await vm.cancel(req) }
                        } label: {
                            Image(systemName: "xmark.circle")
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.danger)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("إلغاء الطلب")
                    }
                }
                if req.id != vm.myRequests.prefix(5).last?.id {
                    Divider().background(EMSTheme.Colors.divider)
                }
            }
        }
        .padding(8)
        .background(EMSTheme.Colors.navySoft.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - تذييل الاختيار والإرسال

    @ViewBuilder
    private var selectionFooter: some View {
        if !vm.selection.isEmpty {
            HStack {
                Text("اختياراتك: \(vm.selection.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(EMSTheme.Colors.teal)
                Spacer()
            }
            Button {
                Task { await vm.submitSelected() }
            } label: {
                HStack(spacing: 6) {
                    if vm.submitting {
                        ProgressView().tint(EMSTheme.Colors.navy)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.caption.weight(.bold))
                    }
                    Text(vm.submitting ? "جارٍ الإرسال…" : "إرسال طلب المناوبة التكميلية (\(vm.selection.count))")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(EMSTheme.Colors.navy)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(EMSTheme.Colors.teal)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(vm.submitting)
        }
    }

    // MARK: - تنبيه بسيط

    private func noticeRow(icon: String, tint: Color, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(tint)
            Text(text)
                .font(.caption)
                .foregroundStyle(EMSTheme.Colors.textSecondary)
            Spacer()
        }
        .padding(.vertical, 6)
    }
}
