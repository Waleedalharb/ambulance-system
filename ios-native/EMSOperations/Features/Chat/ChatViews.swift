//
//  ChatViews.swift
//  EMSOperations
//
//  مجال الدردشة (§19): محادثات جماعية/خاصة، رسائل، مشاركون، متصلون.
//  نظام داخلي عام — كل المسارات authenticate فقط (server.js:14240+).
//  إدارة المشاركين والأرشفة لمسؤول المجموعة (is_admin) كما يفرضه الخادم.
//  مؤجل موثق: رفع المرفقات (POST /api/chat/upload multipart) — يتطلب
//  دعم multipart في APIClient وتحققًا على الجهاز قبل التفعيل.
//

import SwiftUI

// MARK: - قائمة المحادثات

struct ChatView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm = ChatListViewModel()
    @State private var showNewGroup = false
    @State private var showNewPrivate = false

    var body: some View {
        ScrollView {
            VStack(spacing: EMSTheme.spacing) {
                HStack(spacing: 10) {
                    if let count = vm.onlineCount {
                        Label("\(count) متصل الآن", systemImage: "circle.fill")
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.emerald)
                    }
                    Spacer()
                    Button { showNewPrivate = true } label: {
                        Label("خاصة", systemImage: "person.badge.plus")
                            .font(.caption.weight(.semibold))
                    }
                    Button { showNewGroup = true } label: {
                        Label("مجموعة", systemImage: "person.3.fill")
                            .font(.caption.weight(.semibold))
                    }
                }

                if let msg = vm.infoMessage {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.emerald)
                }

                switch vm.state {
                case .loading:
                    EMSSkeletonCard(lines: 4)
                    EMSSkeletonCard(lines: 3)
                case .failed(let message):
                    EMSErrorView(message: message) { Task { await vm.load() } }
                case .loaded:
                    let conversations = vm.data?.conversations ?? []
                    if conversations.isEmpty {
                        EMSEmptyView(
                            icon: "bubble.left.and.bubble.right",
                            title: "لا محادثات",
                            detail: "ابدأ محادثة خاصة أو مجموعة من الأزرار أعلاه")
                    } else {
                        ForEach(conversations) { conv in
                            NavigationLink {
                                ChatConversationView(conversation: conv)
                            } label: {
                                EMSCard {
                                    HStack(spacing: 12) {
                                        Image(systemName: conv.type == "group" ? "person.3.fill" : "person.fill")
                                            .font(.title3)
                                            .foregroundStyle(EMSTheme.Colors.teal)
                                            .frame(width: 28)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(conv.title ?? "محادثة")
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(.white)
                                            if let last = conv.lastMessage {
                                                Text("\(last.senderName ?? ""): \(last.content ?? "")")
                                                    .font(.caption)
                                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                                    .lineLimit(1)
                                            }
                                        }
                                        Spacer()
                                        if let unread = conv.unreadCount, unread > 0 {
                                            Text("\(unread)")
                                                .font(.caption2.weight(.bold))
                                                .foregroundStyle(.white)
                                                .padding(.horizontal, 7)
                                                .padding(.vertical, 3)
                                                .background(EMSTheme.Colors.danger)
                                                .clipShape(Capsule())
                                        }
                                        Image(systemName: "chevron.left")
                                            .font(.caption)
                                            .foregroundStyle(EMSTheme.Colors.textMuted)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .refreshable { await vm.load() }
        .emsPage("المحادثات")
        .task { await vm.load() }
        .sheet(isPresented: $showNewGroup) {
            ChatNewGroupSheet { title, memberIds in
                await vm.createGroup(title: title, participantIds: memberIds)
            }
        }
        .sheet(isPresented: $showNewPrivate) {
            ChatNewPrivateSheet { userId in
                await vm.createPrivate(userId: userId)
            }
        }
    }
}

@MainActor
final class ChatListViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var data: ChatConversationsDTO?
    @Published var onlineCount: Int?
    @Published var infoMessage: String?
    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            async let convReq: ChatConversationsDTO = api.get("/api/chat/conversations")
            async let onlineReq: ChatOnlineDTO = api.get("/api/chat/online")
            let (conv, online) = try await (convReq, onlineReq)
            data = conv
            onlineCount = online.count
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func createGroup(title: String, participantIds: [String]) async -> String? {
        do {
            let _: ChatConversationResponseDTO = try await api.post("/api/chat/conversations",
                body: ChatGroupCreateRequestDTO(title: title, participantIds: participantIds))
            infoMessage = "أُنشئت المجموعة"
            await load()
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    func createPrivate(userId: String) async -> String? {
        do {
            let _: ChatConversationResponseDTO = try await api.post("/api/chat/conversations/private",
                body: ChatPrivateCreateRequestDTO(userId: userId))
            infoMessage = "فُتحت المحادثة"
            await load()
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }
}

// MARK: - منتقي المستخدمين (مشترك بين الإنشاء والإضافة)

struct ChatUserPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let allowsMultiple: Bool
    let onPick: ([String]) async -> String?

    @State private var users: [ChatUserDTO]?
    @State private var selected: Set<String> = []
    @State private var errorMessage: String?
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Group {
                if let users {
                    List(users) { u in
                        Button {
                            guard let id = u.id else { return }
                            if allowsMultiple {
                                if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
                            } else {
                                selected = [id]
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(u.name ?? u.username ?? "—")
                                    if let role = u.role {
                                        Text(role).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if let id = u.id, selected.contains(id) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.blue)
                                }
                            }
                        }
                    }
                } else if let errorMessage {
                    Text(errorMessage).font(.caption).padding()
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إلغاء") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("اختيار") {
                        Task {
                            isSaving = true
                            let result = await onPick(Array(selected))
                            isSaving = false
                            if result != nil { dismiss() }
                        }
                    }
                    .disabled(selected.isEmpty || isSaving)
                }
            }
            .task {
                do {
                    let res: ChatUsersDTO = try await APIClient.shared.get("/api/chat/users")
                    users = res.users ?? []
                } catch let e as APIError {
                    errorMessage = e.userMessage
                } catch {
                    errorMessage = APIError.unknown.userMessage
                }
            }
        }
    }
}

struct ChatNewGroupSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreate: (String, [String]) async -> String?

    @State private var title = ""
    @State private var memberIds: [String] = []
    @State private var showPicker = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("عنوان المجموعة (إلزامي)") {
                    TextField("مثال: مناوبة الخميس", text: $title)
                }
                Section("المشاركون (\(memberIds.count))") {
                    Button("اختيار المشاركين") { showPicker = true }
                }
                if let error = errorMessage {
                    Section { Text(error).font(.caption).foregroundStyle(EMSTheme.Colors.danger) }
                }
            }
            .navigationTitle("مجموعة جديدة")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إلغاء") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("إنشاء") {
                        Task {
                            isSaving = true
                            errorMessage = nil
                            let result = await onCreate(title.trimmingCharacters(in: .whitespaces), memberIds)
                            isSaving = false
                            if result != nil { dismiss() } else { errorMessage = "تعذّر الإنشاء — أضف مشاركًا واحدًا على الأقل" }
                        }
                    }
                    .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty || memberIds.isEmpty)
                }
            }
            .sheet(isPresented: $showPicker) {
                ChatUserPickerSheet(title: "المشاركون", allowsMultiple: true) { ids in
                    memberIds = ids
                    return "تم"
                }
            }
        }
    }
}

struct ChatNewPrivateSheet: View {
    let onCreate: (String) async -> String?

    var body: some View {
        ChatUserPickerSheet(title: "محادثة خاصة", allowsMultiple: false) { ids in
            guard let first = ids.first else { return nil }
            return await onCreate(first)
        }
    }
}

// MARK: - شاشة المحادثة

struct ChatConversationView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var vm: ChatConversationViewModel
    @State private var draft = ""
    @State private var showParticipants = false

    init(conversation: ChatConversationDTO) {
        _vm = StateObject(wrappedValue: ChatConversationViewModel(conversation: conversation))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        switch vm.state {
                        case .loading:
                            EMSSkeletonCard(lines: 3)
                        case .failed(let message):
                            EMSErrorView(message: message) { Task { await vm.load() } }
                        case .loaded:
                            let messages = vm.messages
                            if messages.isEmpty {
                                EMSEmptyView(icon: "bubble.left", title: "لا رسائل", detail: "ابدأ الحديث الآن")
                            } else {
                                ForEach(messages) { msg in
                                    messageBubble(msg)
                                        .id(msg.id)
                                }
                            }
                        }
                    }
                    .padding(EMSTheme.pagePadding)
                }
                .onChange(of: vm.messages.count) { _ in
                    if let last = vm.messages.last?.id {
                        withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                    }
                }
            }

            if let msg = vm.infoMessage {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(EMSTheme.Colors.emerald)
                    .padding(.top, 4)
            }

            HStack(spacing: 8) {
                TextField("اكتب رسالة…", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                Button {
                    let text = draft
                    draft = ""
                    Task { _ = await vm.send(content: text) }
                } label: {
                    Image(systemName: "paperplane.fill")
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || vm.isMutating)
            }
            .padding(.horizontal, EMSTheme.pagePadding)
            .padding(.vertical, 8)
        }
        .emsPage(vm.conversation.title ?? "محادثة")
        .toolbar {
            if vm.conversation.type == "group" {
                ToolbarItem(placement: .primaryAction) {
                    Button { showParticipants = true } label: {
                        Image(systemName: "person.2")
                    }
                }
            }
        }
        .task {
            vm.currentUserId = session.currentUser?.id
            await vm.load()
        }
        .sheet(isPresented: $showParticipants) {
            ChatParticipantsSheet(vm: vm)
        }
    }

    @ViewBuilder
    private func messageBubble(_ msg: ChatMessageDTO) -> some View {
        let isMine = msg.senderId != nil && msg.senderId == session.currentUser?.id
        HStack {
            if isMine { Spacer(minLength: 40) }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                if !isMine, let sender = msg.senderName {
                    Text(sender)
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
                if msg.type == "file", let url = msg.fileUrl {
                    Label("مرفق: \(url.components(separatedBy: "/").last ?? "ملف")", systemImage: "paperclip")
                        .font(.caption)
                        .foregroundStyle(EMSTheme.Colors.teal)
                }
                if let content = msg.content, !content.isEmpty {
                    Text(content)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let at = msg.createdAt {
                    Text(at)
                        .font(.caption2)
                        .foregroundStyle(EMSTheme.Colors.textMuted)
                }
            }
            .padding(10)
            .background(isMine ? EMSTheme.Colors.teal.opacity(0.25) : EMSTheme.Colors.navySoft)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            if !isMine { Spacer(minLength: 40) }
        }
    }
}

// MARK: - إدارة المشاركين (مجموعات)

struct ChatParticipantsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var vm: ChatConversationViewModel
    @State private var showAdd = false

    var body: some View {
        NavigationStack {
            List {
                Section("المشاركون") {
                    ForEach(vm.participants) { p in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name ?? p.username ?? "—")
                                if p.isGroupAdmin {
                                    Text("مسؤول").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if vm.iAmAdmin, !p.isGroupAdmin, let uid = p.userId {
                                Button(role: .destructive) {
                                    Task { _ = await vm.removeParticipant(userId: uid) }
                                } label: {
                                    Image(systemName: "minus.circle")
                                }
                            }
                        }
                    }
                }
                if vm.iAmAdmin {
                    Section {
                        Button("إضافة مشارك") { showAdd = true }
                    }
                }
                Section {
                    Button("مغادرة المجموعة", role: .destructive) {
                        Task {
                            let result = await vm.leave()
                            if result != nil { dismiss() }
                        }
                    }
                    if vm.iAmAdmin {
                        Button("أرشفة المجموعة", role: .destructive) {
                            Task {
                                let result = await vm.archive()
                                if result != nil { dismiss() }
                            }
                        }
                    }
                }
                if let msg = vm.infoMessage {
                    Section { Text(msg).font(.caption) }
                }
            }
            .navigationTitle("المشاركون")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("إغلاق") { dismiss() } }
            }
            .sheet(isPresented: $showAdd) {
                ChatUserPickerSheet(title: "إضافة مشارك", allowsMultiple: false) { ids in
                    guard let first = ids.first else { return nil }
                    return await vm.addParticipant(userId: first)
                }
            }
        }
    }
}

// MARK: - ViewModel المحادثة

@MainActor
final class ChatConversationViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }
    @Published var state: LoadState = .loading
    @Published var messages: [ChatMessageDTO] = []     // تصاعدي للعرض (الخادم يعيد تنازليًا)
    @Published var participants: [ChatParticipantDTO]
    @Published var infoMessage: String?
    @Published var isMutating = false

    let conversation: ChatConversationDTO
    /// هوية المستخدم الحالي — تُمرَّر من العرض (SessionStore.currentUser).
    var currentUserId: String?
    private let api = APIClient.shared

    init(conversation: ChatConversationDTO) {
        self.conversation = conversation
        self.participants = conversation.participants ?? []
    }

    var iAmAdmin: Bool {
        guard let me = currentUserId else { return false }
        return participants.contains { $0.userId == me && $0.isGroupAdmin }
    }

    func load() async {
        guard let cid = conversation.id else { state = .failed("محادثة غير صالحة"); return }
        if messages.isEmpty { state = .loading }
        do {
            let res: ChatMessagesDTO = try await api.get("/api/chat/conversations/\(cid)/messages")
            messages = (res.messages ?? []).reversed()
            state = .loaded
            await markIncomingRead()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    /// تعليم رسائل الآخرين كمقروءة — نفس مسار server.js (PUT /api/chat/messages/:id/read)
    private func markIncomingRead() async {
        guard let me = currentUserId else { return }
        let unread = messages.filter { $0.senderId != me && !($0.readBy ?? []).contains { $0.userId == me } }
        for msg in unread {
            guard let id = msg.id else { continue }
            let _: BasicSuccessDTO? = try? await api.put("/api/chat/messages/\(id)/read")
        }
    }

    func send(content: String) async -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let cid = conversation.id, !isMutating else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let _: ChatMessageResponseDTO = try await api.post("/api/chat/conversations/\(cid)/messages",
                body: ChatMessageRequestDTO(content: trimmed, type: nil))
            await load()
            return "تم"
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    func addParticipant(userId: String) async -> String? {
        guard let cid = conversation.id else { return nil }
        do {
            let _: BasicSuccessDTO = try await api.post("/api/chat/conversations/\(cid)/participants",
                body: ChatParticipantRequestDTO(userId: userId))
            infoMessage = "أُضيف المشارك"
            await refreshParticipants()
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    func removeParticipant(userId: String) async -> String? {
        guard let cid = conversation.id else { return nil }
        do {
            let _: BasicSuccessDTO = try await api.delete("/api/chat/conversations/\(cid)/participants/\(userId)")
            infoMessage = "أُزيل المشارك"
            await refreshParticipants()
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    func leave() async -> String? {
        guard let cid = conversation.id else { return nil }
        do {
            let _: BasicSuccessDTO = try await api.put("/api/chat/conversations/\(cid)/leave")
            infoMessage = "غادرت المجموعة"
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    func archive() async -> String? {
        guard let cid = conversation.id else { return nil }
        do {
            let _: BasicSuccessDTO = try await api.delete("/api/chat/conversations/\(cid)")
            infoMessage = "أُرشفت المجموعة"
            return infoMessage
        } catch let e as APIError {
            infoMessage = e.userMessage
            return nil
        } catch {
            infoMessage = APIError.unknown.userMessage
            return nil
        }
    }

    private func refreshParticipants() async {
        // إعادة جلب قائمة المحادثات لتحديث المشاركين (الخادم لا يعيدهم من مسار الإضافة)
        guard let cid = conversation.id else { return }
        if let res: ChatConversationsDTO = try? await api.get("/api/chat/conversations"),
           let updated = res.conversations?.first(where: { $0.id == cid }) {
            participants = updated.participants ?? []
        }
    }
}
