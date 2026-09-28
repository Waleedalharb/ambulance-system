//
//  FilesOpsDTO.swift
//  EMSOperations
//
//  نماذج الملفات التشغيلية والمستندات العامة (§22) — مطابقة لمعالجات
//  server.js (ops-files / docs). الرفع multipart مؤجل موثقًا — APIClient
//  لا يدعم multipart حاليًا؛ القراءة/التنزيل/الحذف فقط.
//

import Foundation

// MARK: - GET /api/ops-files → {success, files[]} (server.js:9788)
/// الخادم يسوي الحقول للعرض مباشرة (type/size/date) — لا حساب في العميل.
struct OpsFileDTO: Decodable, Identifiable {
    let id: String
    let name: String?
    let type: String?      // pdf | img | word | excel | ppt
    let size: String?      // منسّق سيرفريًا ("1.2 MB" / "340 KB")
    let date: String?
    let url: String?       // /api/download-operational/:id

    private enum CodingKeys: String, CodingKey {
        case id, name, type, size, date, url
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) }
        else { id = UUID().uuidString }
        name = try? c.decode(String.self, forKey: .name)
        type = try? c.decode(String.self, forKey: .type)
        size = try? c.decode(String.self, forKey: .size)
        date = try? c.decode(String.self, forKey: .date)
        url = try? c.decode(String.self, forKey: .url)
    }

    var icon: String {
        switch type {
        case "img": return "photo.fill"
        case "word": return "doc.text.fill"
        case "excel": return "tablecells.fill"
        case "ppt": return "play.rectangle.fill"
        default: return "doc.fill"
        }
    }
}

struct OpsFilesResponseDTO: Decodable {
    let success: Bool?
    let files: [OpsFileDTO]?
}

// MARK: - GET /api/docs → {success, docs[]} (server.js:8071)
/// حقول العنصر من مستهلك الويب (app.js renderDocsList).
struct OpsDocDTO: Decodable, Identifiable {
    let id: String
    let filename: String?
    let category: String?
    let description: String?
    let priority: String?
    let uploadDate: String?
    let uploader: String?

    private enum CodingKeys: String, CodingKey {
        case id, filename, category, description, priority, uploadDate, uploader
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) }
        else { id = UUID().uuidString }
        filename = try? c.decode(String.self, forKey: .filename)
        category = try? c.decode(String.self, forKey: .category)
        description = try? c.decode(String.self, forKey: .description)
        priority = try? c.decode(String.self, forKey: .priority)
        uploadDate = try? c.decode(String.self, forKey: .uploadDate)
        uploader = try? c.decode(String.self, forKey: .uploader)
    }
}

struct OpsDocsResponseDTO: Decodable {
    let success: Bool?
    let docs: [OpsDocDTO]?
}

// MARK: - POST /api/upload-operational → {success, count, files[]} (server.js:9712)
/// multipart: حقل الملفات "files" (حتى 10) + حقول uploader/category/note.
struct OpsUploadResponseDTO: Decodable {
    let success: Bool?
    let count: Int?
}

// MARK: - POST /api/chat/upload → {success, fileUrl, filename, storedName, size} (server.js:14642)
/// multipart: حقل ملف واحد "file". المسار المعاد يُرسل لاحقًا في file_url للرسالة.
struct ChatUploadResponseDTO: Decodable {
    let success: Bool?
    let fileUrl: String?
    let filename: String?
    let storedName: String?
    let size: Int?
}
