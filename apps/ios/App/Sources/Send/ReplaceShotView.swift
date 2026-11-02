import MaterialsCore
import MediaCore
import PhotosUI
import PostHistoryAPI
import SwiftUI
import UniformTypeIdentifiers

/// «رفع لقطة بديلة» لمادة طلب المحرر تعديلها: ملف واحد يدخل الطابور أصلًا للمادة نفسها، بلا حقول جديدة (كما كان في تدفق
/// الخطوات الأربع). النسخة الخفيفة تُقترح للفيديو كما في الإرسال، والإلغاء يحذف النسخة المحلية وحدها.
struct ReplaceShotView: View {
    let material: PostHistoryAPI.Material

    @EnvironmentObject private var queue: UploadQueueModel
    @Environment(\.dismiss) private var dismiss
    @State private var file: MaterialDraft.PickedFile?
    @State private var lightCopy: ProxyChoice = .originalOnly
    @State private var pickerItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var importing = false
    @State private var busy = false
    @State private var error: LocalizedStringKey?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: VL.Space.s5) {
                    VLCard {
                        VLSectionHeader("a4.replaceShot")
                        Text(verbatim: material.title).vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                    }
                    if let file {
                        HStack(spacing: VL.Space.s4) {
                            LocalThumbnail(relativePath: file.relativePath, isVideo: file.isVideo, width: 64, height: 84, radius: VL.Radius.sm)
                            VStack(alignment: .leading, spacing: VL.Space.s1) {
                                Text(verbatim: file.filename).vlText(.headline).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
                                Text(verbatim: VLFormat.bytes(file.sizeBytes)).vlText(.num).foregroundStyle(Color.vl.textSecondary)
                                    .environment(\.layoutDirection, .leftToRight)
                            }
                        }
                        if file.isVideo {
                            Picker(selection: $lightCopy) {
                                ForEach(ProxyChoice.allCases, id: \.self) { Text(LocalizedStringKey("material.lightCopy." + $0.rawValue)).tag($0) }
                            } label: { Text("material.lightCopy") }
                            .pickerStyle(.menu)
                            .tint(Color.vl.textBrand)
                            .frame(minHeight: VL.Size.touchMin)
                        }
                    }
                    if importing { ProgressView().frame(maxWidth: .infinity) }
                    // قيمة ثابتة قبل الالتقاط: تسمية PhotosPicker مغلّف Sendable لا يقرأ حالة العرض المعزولة.
                    let hasFile = file != nil
                    PhotosPicker(selection: $pickerItem, matching: .any(of: [.videos, .images]), preferredItemEncoding: .current) {
                        Label(LocalizedStringKey(hasFile ? "a1.file.change" : "send.files.pick"), systemImage: "photo.on.rectangle")
                    }
                    .buttonStyle(hasFile ? AnyButtonStyle(VLButtonStyle(kind: .outline)) : AnyButtonStyle(VLButtonStyle(kind: .solid)))
                    .disabled(importing || busy)
                    Button { showFileImporter = true } label: { Label("material.file.fromFiles", systemImage: "folder") }
                        .buttonStyle(.vlGhost)
                        .disabled(importing || busy)
                    if let error { VLNote(tone: .danger, systemImage: "exclamationmark.triangle", text: Text(error)) }
                }
                .padding(VL.Space.s5)
            }
            .safeAreaInset(edge: .bottom) {
                Button { Task { await submit() } } label: { Text(LocalizedStringKey(busy ? "send.sending" : "replace.submit")) }
                    .buttonStyle(.vlSolid)
                    .disabled(file == nil || busy || importing)
                    .padding(VL.Space.s5)
                    .background(Color.vl.bgBase.ignoresSafeArea(edges: .bottom))
            }
            .vlScreen()
            .navigationTitle("a4.replaceShot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("material.cancel") { cancel() }.disabled(busy)
                }
            }
            .interactiveDismissDisabled(file != nil || busy || importing)
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task { await importPicked(item) }
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.movie, .image], allowsMultipleSelection: false) { result in
                guard case .success(let urls) = result, let url = urls.first else { return }
                Task {
                    let scoped = url.startAccessingSecurityScopedResource()
                    await replace(with: url)
                    if scoped { url.stopAccessingSecurityScopedResource() }
                }
            }
        }
    }

    private func importPicked(_ item: PhotosPickerItem) async {
        pickerItem = nil
        guard let picked = try? await item.loadTransferable(type: PickedFile.self) else { error = "material.error.import"; return }
        await replace(with: picked.url)
        try? FileManager.default.removeItem(at: picked.url)
    }

    /// الملف الجديد يحلّ محل السابق ونسخته المحلية.
    private func replace(with url: URL) async {
        importing = true
        defer { importing = false }
        do {
            let imported = try await FileImport.importFile(url)
            if let old = file { UploadServices.shared.deleteLocalCopy(relativePath: old.relativePath) }
            file = imported
            error = nil
            if imported.isVideo {
                let context = await DeviceConditions.context(isVideo: true, durationSeconds: imported.durationSeconds ?? 0, priority: material.priority)
                lightCopy = ProxyPolicy.suggest(context)
            } else {
                lightCopy = .originalOnly
            }
        } catch {
            self.error = "material.error.import"
        }
    }

    private func submit() async {
        guard let file else { return }
        busy = true
        defer { busy = false }
        do {
            try await queue.enqueue(relativePath: file.relativePath, materialId: material.id, filename: file.filename, mimeType: file.mimeType,
                                    lightCopy: file.isVideo ? lightCopy : .originalOnly, title: material.title, priority: material.priority)
            dismiss()
        } catch {
            self.error = "material.error.create"
        }
    }

    private func cancel() {
        if let file { UploadServices.shared.deleteLocalCopy(relativePath: file.relativePath) }
        dismiss()
    }
}
