//
//  SupplementaryViewModel.swift
//  EMSOperations
//
//  «الجدول المرن» (المناوبة التكميلية) — ViewModel مستقل تمامًا عن
//  ScheduleViewModel (قرار معماري معتمد 2026-10-08): لا توسعة للـVM القائم
//  ولا مصدر بيانات موازٍ. كل البيانات من عقد الـBackend فقط:
//  candidates + limits + hours + طلباتي.
//
//  الاختيار Local UI State صِرف — لا يُنشئ أي request عند الضغط على بطاقة،
//  ولا يظهر المختار كمناوبة رسمية إطلاقًا (مصدر الجدول الرسمي لا يُمس).
//  الطلب يُرسل فقط من زر الإرسال (POST /api/my/supplementary-requests).
//

import Foundation

/// منطق الاختيار النقي — بلا شبكة ولا UI، قابل للاختبار مباشرة.
/// قاعدة العقد: طلب حيٌّ واحد لكل يوم (الفهرس الجزئي سيرفريًا) ⇒ الاختيار
/// مفهرس بالتاريخ: اختيار رمز آخر لنفس اليوم يستبدل السابق.
struct SupplementarySelection: Equatable {
    /// date → shiftCode
    private(set) var byDate: [String: String] = [:]
    /// سقف الاختيارات = max_per_month - used عند توفره — لا رقم ثابت في iOS.
    let capacity: Int?

    init(capacity: Int?) { self.capacity = capacity }

    var count: Int { byDate.count }
    var isEmpty: Bool { byDate.isEmpty }

    func isSelected(date: String, shiftCode: String) -> Bool {
        byDate[date] == shiftCode
    }

    /// true إذا أمكن اختيار بطاقة جديدة (يوم جديد) الآن.
    func canSelectMore(currentlySelectedDate: String?) -> Bool {
        guard let capacity else { return true }
        if let d = currentlySelectedDate, byDate[d] != nil { return true } // استبدال ضمن نفس اليوم
        return byDate.count < capacity
    }

    mutating func toggle(date: String, shiftCode: String) {
        if byDate[date] == shiftCode {
            byDate.removeValue(forKey: date)
        } else if canSelectMore(currentlySelectedDate: date) {
            byDate[date] = shiftCode
        }
    }

    mutating func clear() { byDate.removeAll() }

    var pairs: [(date: String, shiftCode: String)] {
        byDate.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }
}

@MainActor
final class SupplementaryViewModel: ObservableObject {

    /// حالات القسم — تشمل 503 (إعدادات غير مكتملة) كحالة مفهومة بلا تفاصيل تقنية.
    enum State: Equatable {
        case loading
        case loaded
        case empty                  // لا candidates ولا طلبات — شهر بلا مقترحات
        case configMissing          // 503 SUPP_CONFIG_MISSING — رسالة غير تقنية
        case forbidden              // 403 — بلا صلاحية بوابة الموظف
        case failed(String)         // خطأ + إعادة المحاولة
    }

    @Published private(set) var state: State = .loading
    @Published private(set) var dto: SupplementaryCandidatesDTO?
    @Published private(set) var myRequests: [SupplementaryRequest] = []
    @Published private(set) var selection = SupplementarySelection(capacity: nil)
    @Published private(set) var submitting = false
    /// نتيجة آخر إرسال — تُعرض كتنبيه أعلى القسم ثم تُستهلك.
    @Published var submitFeedback: Feedback?

    struct Feedback: Equatable {
        let sent: Int
        let failed: Int
        /// أول سبب رفض فوري (submit أعاد status=rejected بأسباب E-4) إن وُجد.
        let firstRejection: String?
    }

    private let api: APIClient

    init(api: APIClient = .shared) { self.api = api }

    // MARK: - مرجعية الرياض (شهر العقد YYYY-MM)

    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "yyyy-MM"
        return f
    }()

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Riyadh")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var currentMonthKey: String { Self.monthFormatter.string(from: Date()) }

    // MARK: - التحميل

    func load() async {
        if dto == nil { state = .loading }
        do {
            let res: SupplementaryCandidatesDTO = try await api.get(
                "/api/my/supplementary-candidates", query: ["month": currentMonthKey])
            dto = res
            // السعة من العقد الفعلي — max_per_month - used (لا رقم ثابت)
            if let maxPerMonth = res.limits?.maxPerMonth, let used = res.limits?.used {
                selection = SupplementarySelection(capacity: Swift.max(0, maxPerMonth - used))
            } else {
                selection = SupplementarySelection(capacity: nil)
            }
            await loadMine()
            state = (res.candidates.isEmpty && myRequests.isEmpty) ? .empty : .loaded
        } catch {
            state = Self.stateForError(error)
        }
    }

    private func loadMine() async {
        do {
            let res: SupplementaryRequestsDTO = try await api.get("/api/my/supplementary-requests")
            myRequests = res.requests
        } catch {
            // فشل «طلباتي» لا يكسر المقترحات — تُعرض القائمة فارغة بصدق
            myRequests = []
        }
    }

    /// تعيين خطأ الشبكة إلى حالة قسم مفهومة — نقي وقابل للاختبار.
    nonisolated static func stateForError(_ error: Error) -> State {
        guard let e = error as? APIError else { return .failed("حدث خطأ غير متوقع.") }
        switch e {
        case .forbidden:
            return .forbidden
        case .serverWithCode(_, let code?) where code == "SUPP_CONFIG_MISSING":
            return .configMissing
        default:
            return .failed(e.userMessage)
        }
    }

    // MARK: - الاختيار (Local UI State فقط — لا request هنا إطلاقًا)

    func toggle(_ candidate: SupplementaryCandidatesDTO.Candidate) {
        guard !submitting else { return }
        selection.toggle(date: candidate.date, shiftCode: candidate.shiftCode)
    }

    func isSelected(_ candidate: SupplementaryCandidatesDTO.Candidate) -> Bool {
        selection.isSelected(date: candidate.date, shiftCode: candidate.shiftCode)
    }

    // MARK: - الإرسال (POST فقط من هنا)

    func submitSelected() async {
        guard !submitting, !selection.isEmpty else { return }
        submitting = true
        defer { submitting = false }
        var sent = 0, failed = 0
        var firstRejection: String?
        for pair in selection.pairs {
            do {
                let res: SupplementarySubmitResponseDTO = try await api.post(
                    "/api/my/supplementary-requests",
                    body: SupplementarySubmitBody(targetDate: pair.date, shiftCode: pair.shiftCode))
                if res.status == "rejected" {
                    failed += 1
                    if firstRejection == nil {
                        firstRejection = (res.reasons ?? []).first.map(SupplementaryReasonText.message(for:))
                    }
                } else {
                    sent += 1
                }
            } catch {
                failed += 1
                if firstRejection == nil { firstRejection = (error as? APIError)?.userMessage }
            }
        }
        selection.clear()
        submitFeedback = Feedback(sent: sent, failed: failed, firstRejection: firstRejection)
        await load()
    }

    // MARK: - الإلغاء

    func cancel(_ request: SupplementaryRequest) async {
        do {
            let _: SupplementaryCancelResponseDTO = try await api.post(
                "/api/my/supplementary-requests/\(request.id)/cancel")
            await load()
        } catch {
            submitFeedback = Feedback(sent: 0, failed: 1,
                                      firstRejection: (error as? APIError)?.userMessage ?? "حدث خطأ غير متوقع.")
        }
    }

    // MARK: - مساعدات عرض (بيانات العقد كما هي — لا اشتقاق محلي)

    /// تاريخ العرض «23-09-2026» بأرقام لاتينية ثابتة.
    func dashedDate(_ raw: String) -> String {
        guard raw.count >= 10 else { return raw }
        let y = raw.prefix(4), m = raw.dropFirst(5).prefix(2), d = raw.dropFirst(8).prefix(2)
        return "\(d)-\(m)-\(y)"
    }

    func weekdayName(_ raw: String) -> String {
        guard let date = Self.dayFormatter.date(from: String(raw.prefix(10))) else { return "—" }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Riyadh") ?? .current
        let names = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]
        let w = cal.component(.weekday, from: date)
        return names[max(0, min(6, w - 1))]
    }

    /// ترجمة أسباب عدم التوفر — من reason codes القادمة من الـBackend فقط.
    func reasonMessages(for entry: SupplementaryCandidatesDTO.Unavailable) -> [String] {
        entry.reasons.map(SupplementaryReasonText.message(for:))
    }
}
