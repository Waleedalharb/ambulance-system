//
//  FilesOpsView.swift
//  EMSOperations
//
//  الملفات التشغيلية والمستندات (§22): قائمة الملفات التشغيلية
//  (GET /api/ops-files) + رفع multipart (POST /api/upload-operational —
//  ops.files، حتى 10 ملفات، الأنواع المسموحة سيرفريًا) + تنزيل
//  (GET /api/download-operational/:id عبر ورقة مشاركة النظام) + حذف
//  (DELETE /api/ops-files/:id — ops.files) + المستندات العامة
//  (GET /api/docs + تنزيل/حذف — ops.files).
//

import SwiftUI
import UniformTypeIdentifiers

struct FilesOpsView: View {
    @StateObject private var vm = FilesOpsViewModel()
    @EnvironmentObject private var session: SessionStore
    @State private var shareItems: [Any] = []
    @State private var showUploadSheet = false
    @State private var showFilePicker = false
    @State private var pickedFiles: [URL] = []
    @State private var uploadCategory = ""
    @State private var uploadNote = ""

    /// الأنواع المسموحة — نفس قائمة multer سيرفريًا (opsUpload.fileFilter).
    private static let allowedTypes: [UTType] = [
        .pdf, .jpeg, .png, .gif, .webP,
        UTType("org.openxmlformats.wordprocessingml.document"),
        UTType("com.microsoft.word.doc"),
        UTType("org.openxmlformats.spreadsheetml.sheet"),
        UTType("com.microsoft.excel.xls"),
        UTType("org.openxmlformats.presentationml.presentation"),
        UTType("com.microsoft.powerpoint.ppt")
    ].compactMap { $0 }

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
                    opsFilesSection
                    docsSection
                }
            }
            .padding(EMSTheme.pagePadding)
        }
        .emsPage("الملفات")
        .task { await vm.load() }
        .refreshable { await vm.load() }
        .sheet(isPresented: .init(
            get: { !shareItems.isEmpty },
            set: { if !$0 { shareItems = [] } }
        )) {
            ActivityShareSheet(items: shareItems)
        }
        .sheet(isPresented: $showUploadSheet) {
            uploadSheet
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: Self.allowedTypes,
                      allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { pickedFiles = urls }
        }
    }

    // MARK: - ورقة الرفع (ops.files)

    private var uploadSheet: some View {
        NavigationStack {
            Form {
                Section("الملفات") {
                    Button {
                        showFilePicker = true
                    } label: {
                        Label(pickedFiles.isEmpty ? "اختيار ملفات (حتى 10)" : "\(pickedFiles.count) ملف(ات) مختارة",
                              systemImage: "doc.badge.plus")
                    }
                    ForEach(pickedFiles, id: \.self) { url in
                        Text(url.lastPathComponent)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textSecondary)
                            .lineLimit(1)
                    }
                }
                Section("التصنيف والملاحظة") {
                    TextField("التصنيف (افتراضي: عام)", text: $uploadCategory)
                    TextField("ملاحظة (اختياري)", text: $uploadNote)
                }
                if let msg = vm.infoMessage {
                    Section {
                        Text(msg)
                            .font(.caption)
                            .foregroundStyle(EMSTheme.Colors.textSecondary)
                    }
                }
            }
            .navigationTitle("رفع ملفات تشغيلية")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("إلغاء") { showUploadSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        let files = pickedFiles
                        let category = uploadCategory
                        let note = uploadNote
                        Task {
                            if await vm.upload(files: files, category: category, note: note) {
                                pickedFiles = []
                                uploadCategory = ""
                                uploadNote = ""
                                showUploadSheet = false
                            }
                        }
                    } label: {
                        if vm.isUploading { ProgressView() } else { Text("رفع") }
                    }
                    .disabled(pickedFiles.isEmpty || pickedFiles.count > 10 || vm.isUploading)
                }
            }
        }
    }

    // MARK: - الملفات التشغيلية
    private var opsFilesSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "الملفات التشغيلية", systemImage: "folder.fill")
            if session.permissions.canOpsFiles {
                Button { showUploadSheet = true } label: {
                    Label("رفع ملفات", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(EMSTheme.Colors.teal)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("الرفع يتطلب صلاحية الملفات — التنزيل متاح للجميع.")
                    .font(.caption2)
                    .foregroundStyle(EMSTheme.Colors.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if vm.files.isEmpty {
                EMSEmptyView(icon: "folder", title: "لا توجد ملفات تشغيلية")
            } else {
                ForEach(vm.files) { f in
                    EMSCard {
                        HStack(spacing: 12) {
                            Image(systemName: f.icon)
                                .font(.title3)
                                .foregroundStyle(EMSTheme.Colors.teal)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(f.name ?? "ملف")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .lineLimit(2)
                                Text([f.size, f.date].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                            }
                            Spacer()
                            Button {
                                Task { await download(path: "/api/download-operational/\(f.id)",
                                                      fallback: f.name ?? "file") }
                            } label: {
                                Image(systemName: "arrow.down.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(EMSTheme.Colors.teal)
                            }
                            .buttonStyle(.plain)
                            .disabled(vm.downloadingId == f.id)
                            if session.permissions.canOpsFiles {
                                Button(role: .destructive) {
                                    Task { await vm.deleteOpsFile(f) }
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.subheadline)
                                }
                                .buttonStyle(.plain)
                                .disabled(vm.deletingId == f.id)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - المستندات العامة
    private var docsSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSectionHeader(title: "المستندات العامة", systemImage: "doc.on.doc.fill")
            if vm.docs.isEmpty {
                EMSEmptyView(icon: "doc.on.doc", title: "لا توجد مستندات")
            } else {
                ForEach(vm.docs) { d in
                    EMSCard {
                        HStack(spacing: 12) {
                            Image(systemName: "doc.fill")
                                .font(.title3)
                                .foregroundStyle(EMSTheme.Colors.teal)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(d.filename ?? "مستند")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .lineLimit(2)
                                Text([d.category, d.uploader, d.uploadDate].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption2)
                                    .foregroundStyle(EMSTheme.Colors.textMuted)
                                if let desc = d.description, !desc.isEmpty {
                                    Text(desc)
                                        .font(.caption)
                                        .foregroundStyle(EMSTheme.Colors.textSecondary)
                                        .lineLimit(3)
                                }
                            }
                            Spacer()
                            Button {
                                Task { await download(path: "/api/download-doc/\(d.id)",
                                                      fallback: d.filename ?? "doc") }
                            } label: {
                                Image(systemName: "arrow.down.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(EMSTheme.Colors.teal)
                            }
                            .buttonStyle(.plain)
                            .disabled(vm.downloadingId == d.id)
                            if session.permissions.canOpsFiles {
                                Button(role: .destructive) {
                                    Task { await vm.deleteDoc(d) }
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.subheadline)
                                }
                                .buttonStyle(.plain)
                                .disabled(vm.deletingId == d.id)
                            }
                        }
                    }
                }
            }
        }
    }

    private func download(path: String, fallback: String) async {
        if let url = await vm.download(path: path, fallbackName: fallback) {
            shareItems = [url]
        }
    }
}

// MARK: - ViewModel
@MainActor
final class FilesOpsViewModel: ObservableObject {
    enum LoadState: Equatable { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var files: [OpsFileDTO] = []
    @Published var docs: [OpsDocDTO] = []
    @Published var downloadingId: String? = nil
    @Published var deletingId: String? = nil
    @Published var isUploading = false
    @Published var infoMessage: String? = nil

    private let api = APIClient.shared

    func load() async {
        if state != .loaded { state = .loading }
        do {
            async let filesReq: OpsFilesResponseDTO = api.get("/api/ops-files")
            async let docsReq: OpsDocsResponseDTO = api.get("/api/docs")
            files = (try await filesReq).files ?? []
            docs = (try? await docsReq)?.docs ?? []
            state = .loaded
        } catch let e as APIError {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: e.userMessage) { state = .failed(e.userMessage) }
        } catch {
            if !RefreshFailurePolicy.keepContent(hasContent: state == .loaded, message: APIError.unknown.userMessage) { state = .failed(APIError.unknown.userMessage) }
        }
    }

    /// تنزيل → ملف مؤقت → يعيد URL لورقة المشاركة (نمط WorkflowOps نفسه).
    func download(path: String, fallbackName: String) async -> URL? {
        downloadingId = path
        defer { downloadingId = nil }
        do {
            let file = try await api.download(path)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(file.filename ?? fallbackName)
            try file.data.write(to: url, options: .atomic)
            return url
        } catch let e as APIError {
            state = .failed(e.userMessage)
            return nil
        } catch {
            state = .failed(APIError.unknown.userMessage)
            return nil
        }
    }

    func deleteOpsFile(_ f: OpsFileDTO) async {
        deletingId = f.id
        defer { deletingId = nil }
        do {
            let _: BasicSuccessDTO = try await api.delete("/api/ops-files/\(f.id)")
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    func deleteDoc(_ d: OpsDocDTO) async {
        deletingId = d.id
        defer { deletingId = nil }
        do {
            let _: BasicSuccessDTO = try await api.delete("/api/delete-doc/\(d.id)")
            await load()
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
        }
    }

    /// رفع ملفات تشغيلية (ops.files) — POST /api/upload-operational multipart.
    /// يعيد true عند النجاح ليُغلق السheet. القراءة الأمنية security-scoped.
    func upload(files urls: [URL], category: String, note: String) async -> Bool {
        guard !urls.isEmpty, urls.count <= 10, !isUploading else { return false }
        isUploading = true
        infoMessage = nil
        defer { isUploading = false }
        var payloads: [APIClient.UploadFile] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                let ext = url.pathExtension.lowercased()
                let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
                payloads.append(APIClient.UploadFile(data: data, filename: url.lastPathComponent, mimeType: mime))
            } catch {
                infoMessage = "تعذر قراءة الملف: \(url.lastPathComponent)"
                return false
            }
        }
        var fields: [String: String] = [:]
        if !category.trimmingCharacters(in: .whitespaces).isEmpty { fields["category"] = category }
        if !note.trimmingCharacters(in: .whitespaces).isEmpty { fields["note"] = note }
        do {
            let res: OpsUploadResponseDTO = try await api.upload("/api/upload-operational",
                fileField: "files", files: payloads, fields: fields)
            infoMessage = "تم رفع \(res.count ?? payloads.count) ملف(ات)"
            await load()
            return true
        } catch let e as APIError {
            infoMessage = e.userMessage
            return false
        } catch {
            infoMessage = APIError.unknown.userMessage
            return false
        }
    }
}
