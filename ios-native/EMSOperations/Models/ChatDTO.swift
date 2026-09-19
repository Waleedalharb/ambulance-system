//
//  ChatDTO.swift
//  EMSOperations
//
//  نماذج مجال الدردشة (§19) — مطابقة لأشكال الـBackend المُتحقق منها من
//  المصدر (server.js:14240-14680). معرفات المستخدمين نصية (user_id TEXT) —
//  فك مرن يقبل الرقم والنص. فكّ دفاعي: كل الحقول اختيارية.
//

import Foundation

// MARK: - مشارك (chat_participants + JOIN users)
struct ChatParticipantDTO: Decodable, Identifiable {
    let userId: String?
    let username: String?
    let name: String?
    let role: String?
    let isAdmin: Int?

    var id: String { userId ?? UUID().uuidString }
    var isGroupAdmin: Bool { (isAdmin ?? 0) == 1 }

    enum CodingKeys: String, CodingKey {
        case username, name, role
        case userId = "user_id"
        case isAdmin = "is_admin"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .userId) { userId = s }
        else if let n = try? c.decode(Int.self, forKey: .userId) { userId = String(n) }
        else { userId = nil }
        username = try? c.decode(String.self, forKey: .username)
        name = try? c.decode(String.self, forKey: .name)
        role = try? c.decode(String.self, forKey: .role)
        isAdmin = try? c.decode(Int.self, forKey: .isAdmin)
    }
}

// MARK: - رسالة (chat_messages + sender_name + read_by)
struct ChatMessageDTO: Decodable, Identifiable {
    struct ReadMark: Decodable {
        let userId: String?
        let readAt: String?

        enum CodingKeys: String, CodingKey {
            case userId = "user_id"
            case readAt = "read_at"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let s = try? c.decode(String.self, forKey: .userId) { userId = s }
            else if let n = try? c.decode(Int.self, forKey: .userId) { userId = String(n) }
            else { userId = nil }
            readAt = try? c.decode(String.self, forKey: .readAt)
        }
    }

    let id: Int?
    let conversationId: Int?
    let senderId: String?
    let senderName: String?
    let content: String?
    let type: String?              // text | file
    let fileUrl: String?
    let replyTo: Int?
    let createdAt: String?
    let readBy: [ReadMark]?

    enum CodingKeys: String, CodingKey {
        case id, content, type
        case conversationId = "conversation_id"
        case senderId = "sender_id"
        case senderName = "sender_name"
        case fileUrl = "file_url"
        case replyTo = "reply_to"
        case createdAt = "created_at"
        case readBy = "read_by"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decode(Int.self, forKey: .id)
        conversationId = try? c.decode(Int.self, forKey: .conversationId)
        if let s = try? c.decode(String.self, forKey: .senderId) { senderId = s }
        else if let n = try? c.decode(Int.self, forKey: .senderId) { senderId = String(n) }
        else { senderId = nil }
        senderName = try? c.decode(String.self, forKey: .senderName)
        content = try? c.decode(String.self, forKey: .content)
        type = try? c.decode(String.self, forKey: .type)
        fileUrl = try? c.decode(String.self, forKey: .fileUrl)
        replyTo = try? c.decode(Int.self, forKey: .replyTo)
        createdAt = try? c.decode(String.self, forKey: .createdAt)
        readBy = try? c.decode([ReadMark].self, forKey: .readBy)
    }
}

// MARK: - محادثة (chat_conversations + unread_count + last_message + participants)
struct ChatConversationDTO: Decodable, Identifiable {
    let id: Int?
    let type: String?              // group | private
    let title: String?
    let createdBy: String?
    let unreadCount: Int?
    let lastMessage: ChatMessageDTO?
    let participants: [ChatParticipantDTO]?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, type, title, participants
        case createdBy = "created_by"
        case unreadCount = "unread_count"
        case lastMessage = "last_message"
        case updatedAt = "updated_at"
    }
}

// MARK: - مستخدم للدردشة (/api/chat/users) والمتصلون (/api/chat/online)
struct ChatUserDTO: Decodable, Identifiable {
    let id: String?
    let username: String?
    let name: String?
    let role: String?

    enum CodingKeys: String, CodingKey {
        case id, username, name, role
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) }
        else { id = nil }
        username = try? c.decode(String.self, forKey: .username)
        name = try? c.decode(String.self, forKey: .name)
        role = try? c.decode(String.self, forKey: .role)
    }
}

// MARK: - استجابات
struct ChatConversationsDTO: Decodable {
    let success: Bool?
    let conversations: [ChatConversationDTO]?
}

struct ChatMessagesDTO: Decodable {
    let success: Bool?
    let messages: [ChatMessageDTO]?
    let page: Int?
    let limit: Int?
}

struct ChatUsersDTO: Decodable {
    let success: Bool?
    let users: [ChatUserDTO]?
}

struct ChatOnlineDTO: Decodable {
    let success: Bool?
    let onlineUsers: [ChatUserDTO]?
    let count: Int?
}

struct ChatConversationResponseDTO: Decodable {
    let success: Bool?
    let conversation: ChatConversationDTO?
}

struct ChatMessageResponseDTO: Decodable {
    let success: Bool?
    let message: ChatMessageDTO?
}

// MARK: - طلبات الكتابة (أسماء الحقول مطابقة لـserver.js حرفيًا)
struct ChatGroupCreateRequestDTO: Encodable {
    let title: String
    let participantIds: [String]

    enum CodingKeys: String, CodingKey {
        case title
        case participantIds = "participant_ids"
    }
}

struct ChatPrivateCreateRequestDTO: Encodable {
    let userId: String

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
    }
}

struct ChatMessageRequestDTO: Encodable {
    let content: String
    let type: String?
    /// مسار المرفق المعاد من POST /api/chat/upload (type="file")
    let fileUrl: String?

    enum CodingKeys: String, CodingKey {
        case content, type
        case fileUrl = "file_url"
    }

    init(content: String, type: String? = nil, fileUrl: String? = nil) {
        self.content = content
        self.type = type
        self.fileUrl = fileUrl
    }
}

struct ChatParticipantRequestDTO: Encodable {
    let userId: String

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
    }
}
