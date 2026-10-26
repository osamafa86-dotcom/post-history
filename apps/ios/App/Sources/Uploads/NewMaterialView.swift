import AVFoundation
import FormEngine
import MediaCore
import PhotosUI
import PostHistoryAPI
import SwiftUI
import UniformTypeIdentifiers

/// مادة جديدة: الملف الأصلي (PhotosUI بالترميز الحالي دون تحويل، أو من الملفات) + الحقول الثابتة + النموذج الديناميكي بإصداره، ثم رفع.
struct NewMaterialView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var queue: UploadQueueModel
    @Environment(\.dismiss) private var dismiss

    @State private var pickerItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var picked: (relativePath: String, filename: String, size: Int64, mime: String?)?
    @State private var title = ""
    @State private var materialType: MaterialType = .report
    @State private var governorate = ""
    @State private var city = ""
    @State private var priority: Priority = .normal
    @State private var displayMode: DisplayName.Mode = .network
    @State private var pseudonym = ""
    @State private var sensitivity = Sensitivity(minors: false, injured: false, graphic: false)
    @State private var form: UploadForm?
    @State private var values: [String: FormValue] = [:]
    @State private var errors: [FieldError] = []
    @State private var submitError: LocalizedStringKey?
    @State private var busy = false
    /// النسخة الخفيفة للفيديو (ADR 0075): مقترحة من حالة الجهاز، والمراسل يغيّرها.
    @State private var isVideo = false
    @State private var durationSeconds: Double = 0
    @State private var lightCopy: ProxyChoice = .originalOnly
    @State private var lightCopyChosenByReporter = false

    var body: some View {
        NavigationStack {
            Form {
                Section("material.file") {
                    PhotosPicker(selection: $pickerItem, matching: .any(of: [.videos, .images]), preferredItemEncoding: .current) {
                        Label("material.file.fromPhotos", systemImage: "photo.on.rectangle")
                    }
                    Button { showFileImporter = true } label: { Label("material.file.fromFiles", systemImage: "folder") }
                    if let picked { Text(picked.filename).font(.caption).foregroundStyle(.secondary) }
                }
                if isVideo {
                    Section {
                        Picker("material.lightCopy", selection: Binding(get: { lightCopy }, set: { lightCopy = $0; lightCopyChosenByReporter = true })) {
                            ForEach(ProxyChoice.allCases, id: \.self) { Text(LocalizedStringKey("material.lightCopy." + $0.rawValue)).tag($0) }
                        }
                    } footer: { Text("material.lightCopy.hint") }
                }
                Section("material.fixed") {
                    TextField("material.title", text: $title)
                    Picker("material.type", selection: $materialType) {
                        ForEach(MaterialType.allCases.filter { $0 != .unknownDefaultOpenApi }, id: \.self) { Text(LocalizedStringKey("material.type." + $0.rawValue)).tag($0) }
                    }
                    TextField("material.governorate", text: $governorate)
                    TextField("material.city", text: $city)
                    Picker("material.priority", selection: $priority) {
                        ForEach(Priority.allCases.filter { $0 != .unknownDefaultOpenApi }, id: \.self) { Text(LocalizedStringKey("material.priority." + $0.rawValue)).tag($0) }
                    }
                    Picker("material.displayName", selection: $displayMode) {
                        ForEach(DisplayName.Mode.allCases.filter { $0 != .unknownDefaultOpenApi }, id: \.self) { Text(LocalizedStringKey("material.displayName." + $0.rawValue)).tag($0) }
                    }
                    if displayMode == .pseudonym { TextField("material.pseudonym", text: $pseudonym) }
                }
                Section("material.sensitivity") {
                    Toggle("material.sensitivity.minors", isOn: $sensitivity.minors)
                    Toggle("material.sensitivity.injured", isOn: $sensitivity.injured)
                    Toggle("material.sensitivity.graphic", isOn: $sensitivity.graphic)
                }
                Section("material.dynamic") {
                    if let form {
                        DynamicFormView(form: form, materialType: materialType.rawValue, values: $values, errors: errors)
                    } else {
                        ProgressView()
                    }
                }
                if let submitError { Section { Text(submitError).foregroundStyle(.red) } }
                Section {
                    Button { Task { await submit() } } label: { if busy { ProgressView() } else { Text("material.submit") } }
                        .disabled(busy || picked == nil || title.count < 5 || governorate.isEmpty || city.isEmpty || form == nil)
                }
            }
            .navigationTitle("material.new")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("material.cancel") { dismiss() } } }
            .task(id: materialType) { await loadForm() }
            .onChange(of: pickerItem) { _, item in Task { await importPicked(item) } }
            .onChange(of: priority) { _, _ in Task { await suggestLightCopy() } }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.movie, .image, .audio], allowsMultipleSelection: false) { result in
                guard case .success(let urls) = result, let url = urls.first else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                importFile(url)
            }
        }
    }

    private func loadForm() async {
        form = nil
        do {
            form = try await FormsAPI.getCurrentForm(materialType: materialType, apiConfiguration: app.api)
            errors = []
        } catch {
            submitError = "material.error.formUnavailable"
        }
    }

    /// النسخة الأصلية من PhotosUI تُنقل كملف (`FileRepresentation`) بلا إعادة ترميز.
    private func importPicked(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let picked = try? await item.loadTransferable(type: PickedFile.self) else { return }
        importFile(picked.url)
        // النسخة المؤقتة من Photos لا تبقى خارج سياسة الحذف المحلي.
        try? FileManager.default.removeItem(at: picked.url)
    }

    private func importFile(_ url: URL) {
        do {
            let (path, size) = try UploadServices.shared.importFile(from: url, preferredName: url.lastPathComponent)
            let type = UTType(filenameExtension: url.pathExtension)
            picked = (path, url.lastPathComponent, size, type?.preferredMIMEType)
            isVideo = type?.conforms(to: .movie) ?? false
            lightCopyChosenByReporter = false
            Task { await inspectVideo(relativePath: path) }
        } catch {
            submitError = "material.error.import"
        }
    }

    private func inspectVideo(relativePath: String) async {
        guard isVideo else { lightCopy = .originalOnly; return }
        let asset = AVURLAsset(url: UploadServices.shared.documentsDirectory.appendingPathComponent(relativePath))
        durationSeconds = (try? await asset.load(.duration)).map(CMTimeGetSeconds) ?? 0
        await suggestLightCopy()
    }

    private func suggestLightCopy() async {
        guard isVideo, !lightCopyChosenByReporter else { return }
        lightCopy = ProxyPolicy.suggest(await DeviceConditions.context(isVideo: true, durationSeconds: durationSeconds, priority: priority))
    }

    private func submit() async {
        guard let picked, let form else { return }
        let result = FormValidator.validate(form: form, materialType: materialType.rawValue, values: values)
        errors = result.errors
        guard result.valid else { return }
        busy = true
        defer { busy = false }
        do {
            let visibleKeys = Set(FormValidator.visibleFields(form: form, materialType: materialType.rawValue, values: values).map(\.key))
            let dynamic = values.filter { visibleKeys.contains($0.key) && !$0.value.isEmpty }.mapValues(\.jsonValue)
            let body = MaterialCreate(title: title, materialTypes: [materialType], governorate: governorate, city: city, priority: priority, sensitivity: sensitivity,
                                      displayName: DisplayName(mode: displayMode, pseudonym: displayMode == .pseudonym ? pseudonym : nil),
                                      formVersion: form.version, dynamicFields: dynamic)
            let material = try await MaterialsAPI.createMaterial(idempotencyKey: "material-create-\(UUID().uuidString.lowercased())", materialCreate: body, apiConfiguration: app.api)
            try await queue.enqueue(relativePath: picked.relativePath, materialId: material.id, filename: picked.filename, mimeType: picked.mime,
                                    lightCopy: isVideo ? lightCopy : .originalOnly)
            dismiss()
        } catch {
            submitError = "material.error.create"
        }
    }
}

/// نقل الملف الأصلي من PhotosPicker كملف على القرص (لا بيانات في الذاكرة ولا تحويل).
struct PickedFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString)-\(received.file.lastPathComponent)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedFile(url: copy)
        }
    }
}
