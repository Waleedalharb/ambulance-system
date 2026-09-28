//
//  ShiftMatesView.swift
//  EMSOperations
//
//  «زملائي في المناوبة» (قسم 12): الفرقة + القيادة الميدانية + العمليات.
//  الجوال يصل فقط لحامل staff.phone_view (الخادم يطبّق الصلاحية) —
//  نعرض Call/WhatsApp عند وجوده فقط، ولا نتجاوز ذلك أبدًا.
//

import SwiftUI

struct ShiftMatesView: View {
    @StateObject private var vm = ShiftMatesViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                switch vm.state {
                case .loading:
                    EMSSkeletonCard()
                    EMSSkeletonCard()
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    if let m = vm.mates, m.available {
                        if let w = m.window {
                            EMSStatusPill(text: "\(w.label ?? "") · \(w.date ?? "")", tone: w.active == true ? .normal : .action)
                        }
                        if let team = m.team, !team.isEmpty {
                            peopleSection("فرقتي", icon: "person.3.fill", people: team)
                        }
                        if let leadership = m.leadership, !leadership.isEmpty {
                            peopleSection("القيادة الميدانية", icon: "star.fill", people: leadership)
                        }
                        if let ops = m.ops, !ops.isEmpty {
                            peopleSection("العمليات", icon: "headset", people: ops)
                        }
                        if (m.team ?? []).isEmpty && (m.leadership ?? []).isEmpty && (m.ops ?? []).isEmpty {
                            EMSEmptyView(icon: "person.3", title: "لا يوجد طاقم في هذا السياق")
                        }
                    } else {
                        EMSEmptyView(icon: "clock", title: "السياق غير متاح حاليًا")
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("زملائي في المناوبة")
        .task { await vm.load() }
    }

    private func peopleSection(_ title: String, icon: String, people: [ShiftMatesDTO.Person]) -> some View {
        EMSCard {
            VStack(alignment: .leading, spacing: 10) {
                EMSectionHeader(title: title, systemImage: icon)
                ForEach(people) { person in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(person.name)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.white)
                                if person.isMe == true {
                                    Text("(أنا)")
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.teal)
                                }
                            }
                            // نفس صيغة الويب: المسمى · الرمز · الفريق — تمييز حاسم
                            // بين حملة الاسم نفسه (بلاها يبدو شخصان مختلفان «تكرارًا»)
                            Text([person.jobTitle, person.shiftCode, person.teamName]
                                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(EMSTheme.Colors.textMuted)
                        }
                        Spacer()
                        if let phone = person.phone, !phone.isEmpty {
                            EMSContactButtons(phone: phone)
                        }
                    }
                    if person.id != people.last?.id {
                        Divider().overlay(EMSTheme.Colors.divider)
                    }
                }
            }
        }
    }

    /// اتصال/رسالة — المكوّن المشترك EMSContactButtons (DesignSystem/EMSComponents) —
    /// فقط عند وصول الرقم من الخادم (staff.phone_view مطبقة خادميًا).
}

@MainActor
final class ShiftMatesViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var mates: ShiftMatesDTO?

    func load() async {
        if mates == nil { state = .loading }
        do {
            let dto: ShiftMatesDTO = try await APIClient.shared.get("/api/my/shift-mates")
            mates = Self.deduped(dto)
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: mates != nil, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: mates != nil, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    /// dedup بنيوي بمفتاح employeeId — مصدر البيانات أثبتنا خلوه من التكرار،
    /// لكن إن ورد سجل مكرر للشخص نفسه في قسم واحد يُدمج (لا يُخفى شخص مختلف).
    private static func deduped(_ dto: ShiftMatesDTO) -> ShiftMatesDTO {
        func unique(_ people: [ShiftMatesDTO.Person]?) -> [ShiftMatesDTO.Person]? {
            guard let people else { return nil }
            var seen = Set<Int>()
            return people.filter { p in
                guard let id = p.id else { return true }   // بلا معرف يبقى كما هو — لا حذف تخميني
                return seen.insert(id).inserted
            }
        }
        return ShiftMatesDTO(available: dto.available, window: dto.window, me: dto.me,
                             team: unique(dto.team), leadership: unique(dto.leadership), ops: unique(dto.ops))
    }
}
