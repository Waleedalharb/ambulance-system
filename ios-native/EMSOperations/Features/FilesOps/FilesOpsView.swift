//
//  FilesOpsView.swift
//  EMSOperations
//
//  الملفات التشغيلية والمستندات (§22): قائمة الملفات التشغيلية
//  (GET /api/ops-files) + تنزيل (GET /api/download-operational/:id عبر
//  ورقة مشاركة النظام) + حذف (DELETE /api/ops-files/:id — ops.files) +
//  المستندات العامة (GET /api/docs + تنزيل/حذف — ops.files).
//  الرفع multipart مؤجل موثقًا — لا يدعمه APIClient حاليًا.
//

import SwiftUI

struct FilesOpsView: View {
    @StateObject private var vm = FilesOpsViewModel()
    @EnvironmentObject private var session: SessionStore
    @State private var shareItems: [Any] = []

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
    }

    // MARK: - الملفات التشغيلية
    private var opsFilesSection: some View {
        VStack(spacing: EMSTheme.spacing) {
            EMSSectionHeader(title: "الملفات التشغيلية", systemImage: "folder.fill")
            Text("الرفع من الويب حاليًا — التنزيل والحذف متاحان هنا حسب الصلاحية.")
                .font(.caption2)
                .foregroundStyle(EMSTheme.Colors.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
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
            EMSSectionHeader(title: "المستندات العامة", systemImage: "doc.on.doc.fill")
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
    enum LoadState { case loading, loaded, failed(String) }

    @Published var state: LoadState = .loading
    @Published var files: [OpsFileDTO] = []
    @Published var docs: [OpsDocDTO] = []
    @Published var downloadingId: String? = nil
    @Published var deletingId: String? = nil

    private let api = APIClient.shared

    func load() async {
        state = .loading
        do {
            async let filesReq: OpsFilesResponseDTO = api.get("/api/ops-files")
            async let docsReq: OpsDocsResponseDTO = api.get("/api/docs")
            files = (try await filesReq).files ?? []
            docs = (try? await docsReq)?.docs ?? []
            state = .loaded
        } catch let e as APIError {
            state = .failed(e.userMessage)
        } catch {
            state = .failed(APIError.unknown.userMessage)
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
}
