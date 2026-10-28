import AVFoundation
import FormEngine
import MaterialsCore
import MediaCore
import PhotosUI
import PostHistoryAPI
import SwiftUI
import UniformTypeIdentifiers

/// A1 · مادة جديدة بأربع خطوات (docs/design/specs/reporter.md): الملف → البيانات → نموذج المكتب → مراجعة وإرسال.
/// «حفظ مسودة» متاح دائمًا والمسودة على الجهاز فقط. الأصل يُرفع كما صُوِّر؛ لا إحداثيات ولا معرّف جهاز.
/// `replacing`: «رفع لقطة بديلة» لمادة قائمة — خطوة الملف ثم المراجعة فقط.
struct NewMaterialFlow: View {
    enum Step: Int, CaseIterable {
        case file = 1, fields, form, review
        var titleKey: String {
            switch self {
            case .file: return "a1.step.file"
            case .fields: return "a1.step.fields"
            case .form: return "a1.step.form"
            case .review: return "a1.step.review"
            }
        }
    }

    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var queue: UploadQueueModel
    @Environment(\.dismiss) private var dismiss

    @State private var draft: MaterialDraft
    let replacing: PostHistoryAPI.Material?
    @State private var form: UploadForm?
    @State private var formFromCache = false
    @State private var formUnavailable = false
    @State private var formErrors: [FieldError] = []
    @State private var issues: [DraftValidator.Issue] = []
    @State private var submitError: LocalizedStringKey?
    @State private var busy = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var thumbnail: Image?

    init(draft: MaterialDraft? = nil, replacing: PostHistoryAPI.Material? = nil) {
        _draft = State(initialValue: draft ?? MaterialDraft())
        self.replacing = replacing
    }

    private var step: Step { Step(rawValue: draft.step) ?? .file }
    private var steps: [Step] { replacing == nil ? Step.allCases : [.file, .review] }
    private var position: Int { (steps.firstIndex(of: step) ?? 0) + 1 }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VLStepper(step: position, total: steps.count, titleKey: step.titleKey)
                    .padding(.horizontal, VL.Space.s5).padding(.vertical, VL.Space.s4)
                ScrollView {
                    VStack(alignment: .leading, spacing: VL.Space.s5) {
                        switch step {
                        case .file: fileStep
                        case .fields: fieldsStep
                        case .form: formStep
                        case .review: reviewStep
                        }
                    }
                    .padding(VL.Space.s5)
                }
                bottomBar
            }
            .vlScreen()
            .navigationTitle(LocalizedStringKey(replacing == nil ? "material.new" : "a4.replaceShot"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if position > 1 {
                        Button { go(by: -1) } label: { Label("a1.back", systemImage: "chevron.backward") }
                    } else {
                        Button("material.cancel") { dismiss() }
                    }
                }
                if replacing == nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button("a1.saveDraft") { queue.saveDraft(draft); dismiss() }.buttonStyle(.vlGhost)
                    }
                }
            }
            .onChange(of: pickerItem) { _, item in Task { await importPicked(item) } }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.movie, .image], allowsMultipleSelection: false) { result in
                guard case .success(let urls) = result, let url = urls.first else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                Task { await importFile(url) }
            }
            .task(id: draft.materialTypes) { await loadForm() }
            .onChange(of: draft.priority) { _, _ in Task { await suggestLightCopy() } }
            .task { await loadThumbnail() }
        }
    }

    // MARK: الخطوة 1 · الملف

    @ViewBuilder private var fileStep: some View {
        if let file = draft.file {
            VLCard {
                HStack(alignment: .top, spacing: VL.Space.s4) {
                    thumbnailView
                    VStack(alignment: .leading, spacing: VL.Space.s2) {
                        Text(verbatim: file.filename).vlText(.labelLg).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
                        Text(verbatim: fileFacts(file)).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                    }
                }
                if file.isVideo { lightCopyLine }
                pickButtons(primary: false)
            }
        } else {
            VStack(spacing: VL.Space.s4) {
                Image(systemName: "photo.on.rectangle.angled").font(.largeTitle).foregroundStyle(Color.vl.iconMuted)
                Text("a1.file.empty").vlText(.bodyMd).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
                pickButtons(primary: true)
            }
            .padding(VL.Space.s7)
            .frame(maxWidth: .infinity)
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.lg)
                .strokeBorder(Color.vl.borderStrong, style: StrokeStyle(lineWidth: VL.Border.hairline, dash: [VL.Space.s3, VL.Space.s2])))
        }
    }

    @ViewBuilder private var thumbnailView: some View {
        if let thumbnail {
            thumbnail.resizable().scaledToFill()
                .frame(width: VL.Size.thumbW / 2, height: VL.Size.thumbH / 2)
                .clipShape(RoundedRectangle(cornerRadius: VL.Radius.md))
                .accessibilityHidden(true)
        }
    }

    private func pickButtons(primary: Bool) -> some View {
        VStack(spacing: VL.Space.s3) {
            PhotosPicker(selection: $pickerItem, matching: .any(of: [.videos, .images]), preferredItemEncoding: .current) {
                Label(LocalizedStringKey(primary ? "a1.file.pick" : "a1.file.change"), systemImage: "photo.on.rectangle")
            }
            .buttonStyle(primary ? AnyButtonStyle(VLPrimaryButtonStyle()) : AnyButtonStyle(VLSecondaryButtonStyle()))
            Button { showFileImporter = true } label: { Label("material.file.fromFiles", systemImage: "folder") }.buttonStyle(.vlGhost)
        }
    }

    private var lightCopyLine: some View {
        HStack(spacing: VL.Space.s3) {
            Image(systemName: "bolt.horizontal.fill").foregroundStyle(Color.vl.iconBrand)
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                Text("material.lightCopy").vlText(.labelMd).foregroundStyle(Color.vl.textPrimary)
                Text(LocalizedStringKey("material.lightCopy." + (draft.lightCopy ?? ProxyChoice.originalOnly.rawValue)))
                    .vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
            }
            Spacer()
            Menu {
                ForEach(ProxyChoice.allCases, id: \.self) { choice in
                    Button(LocalizedStringKey("material.lightCopy." + choice.rawValue)) {
                        draft.lightCopy = choice.rawValue
                        draft.lightCopyChosenByReporter = true
                    }
                }
            } label: { Text("a1.lightCopy.change").vlText(.labelMd) }
            .frame(minHeight: VL.Size.touchMin)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("material.lightCopy.hint"))
    }

    private func fileFacts(_ f: MaterialDraft.PickedFile) -> String {
        var parts = [ByteCountFormatter.string(fromByteCount: f.sizeBytes, countStyle: .file)]
        if let d = f.durationSeconds, d.isFinite, d > 0 {
            parts.append(Duration.seconds(d).formatted(.time(pattern: d >= 3600 ? .hourMinuteSecond : .minuteSecond)))
        }
        return parts.joined(separator: " · ")
    }

    // MARK: الخطوة 2 · البيانات

    @ViewBuilder private var fieldsStep: some View {
        field("material.title", issue: .titleLength) {
            TextField("material.title", text: $draft.title, axis: .vertical)
                .vlInput(invalid: issues.contains(.titleLength))
            Text(verbatim: "\(DraftValidator.titleLength(draft.title))/\(DraftValidator.titleRange.upperBound)")
                .vlText(.captionMd).foregroundStyle(Color.vl.textMuted).environment(\.layoutDirection, .leftToRight)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        field("material.type", issue: .typeMissing) {
            VLChips(options: MaterialType.allCases.filter { $0 != .unknownDefaultOpenApi }.map { ($0, "material.type." + $0.rawValue) },
                    selection: $draft.materialTypes)
        }
        // المحافظة والمدينة نصًّا كما في العقد (لا قائمة فيه)، ولا إحداثيات افتراضيًا.
        field("material.governorate", issue: .governorateMissing) {
            TextField("material.governorate", text: $draft.governorate).vlInput(invalid: issues.contains(.governorateMissing))
        }
        field("material.city", issue: .cityMissing) {
            TextField("material.city", text: $draft.city).vlInput(invalid: issues.contains(.cityMissing))
        }
        field("material.priority", issue: .priorityMissing) {
            VLSegmented(options: [Priority.normal, .important, .urgent].map { ($0, "material.priority." + $0.rawValue) },
                        selection: $draft.priority, tone: PriorityBadge.tone)
        }
        field("material.sensitivity", issue: .sensitivityUnanswered) {
            sensitivityQuestion("material.sensitivity.minors", $draft.minors)
            sensitivityQuestion("material.sensitivity.injured", $draft.injured)
            sensitivityQuestion("material.sensitivity.graphic", $draft.graphic)
        }
        field("material.displayName", issue: draft.displayMode == .pseudonym ? .pseudonymMissing : .displayNameMissing) {
            Picker("material.displayName", selection: $draft.displayMode) {
                Text("a1.choose").tag(DisplayName.Mode?.none)
                ForEach(DisplayName.Mode.allCases.filter { $0 != .unknownDefaultOpenApi }, id: \.self) {
                    Text(LocalizedStringKey("material.displayName." + $0.rawValue)).tag(DisplayName.Mode?.some($0))
                }
            }
            .pickerStyle(.menu)
            if draft.displayMode == .pseudonym {
                TextField("material.pseudonym", text: $draft.pseudonym).vlInput(invalid: issues.contains(.pseudonymMissing))
            }
        }
    }

    /// سؤال حساسية إلزامي بلا قيمة افتراضية؛ قارئ الشاشة يعلن «مطلوب».
    private func sensitivityQuestion(_ key: String, _ answer: Binding<Bool?>) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            Text(LocalizedStringKey(key)).vlText(.bodyMd).foregroundStyle(Color.vl.textPrimary)
            VLSegmented(options: [(true, "a1.yes"), (false, "a1.no")], selection: answer) { yes in yes ? .attention : .neutral }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(LocalizedStringKey(key)))
        .accessibilityValue(Text(LocalizedStringKey(answer.wrappedValue == nil ? "a1.required" : answer.wrappedValue == true ? "a1.yes" : "a1.no")))
    }

    private func field<Content: View>(_ labelKey: String, issue: DraftValidator.Issue, @ViewBuilder content: () -> Content) -> some View {
        let failing = issues.contains(issue)
        return VStack(alignment: .leading, spacing: VL.Space.s3) {
            Text(LocalizedStringKey(labelKey)).vlText(.labelLg).foregroundStyle(failing ? Color.vl.textDanger : Color.vl.textPrimary)
            content()
            if failing {
                Label(LocalizedStringKey(issue.labelKey), systemImage: "exclamationmark.circle").vlText(.captionMd).foregroundStyle(Color.vl.textDanger)
            }
        }
    }

    // MARK: الخطوة 3 · نموذج المكتب

    @ViewBuilder private var formStep: some View {
        if let form {
            if formFromCache { StateBadge(labelKey: "a1.form.cached", tone: .attention) }
            DynamicFormView(form: form, materialType: primaryType.rawValue, values: $draft.dynamicValues, errors: formErrors)
        } else if formUnavailable {
            VLInlineAlert(tone: .attention, systemImage: "wifi.slash", textKey: "a1.form.unavailable")
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    private var primaryType: MaterialType {
        MaterialType.allCases.first { draft.materialTypes.contains($0) && $0 != .unknownDefaultOpenApi } ?? .report
    }

    // MARK: الخطوة 4 · مراجعة

    @ViewBuilder private var reviewStep: some View {
        if let replacing {
            VLCard {
                VLOverline("a4.replaceShot")
                Text(verbatim: replacing.title).vlText(.headingH4).foregroundStyle(Color.vl.textPrimary)
            }
        } else {
            summary(.fields) {
                Text(verbatim: draft.title).vlText(.bodyMd)
                Text(verbatim: "\(draft.governorate) · \(draft.city)").vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                if let p = draft.priority { PriorityBadge(priority: p) }
            }
            summary(.form) {
                Text("a1.review.formFields \(draft.dynamicValues.filter { !$0.value.isEmpty }.count)").vlText(.bodySm)
            }
        }
        summary(.file) {
            if let f = draft.file {
                Text(verbatim: f.filename).vlText(.bodyMd)
                Text(uploadPlanKey).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
            }
        }
    }

    private var uploadPlanKey: LocalizedStringKey {
        let choice = ProxyChoice(rawValue: draft.lightCopy ?? "") ?? .originalOnly
        return draft.file?.isVideo == true && choice != .originalOnly ? "a1.review.plan.lightThenOriginal" : "a1.review.plan.originalOnly"
    }

    private func summary<Content: View>(_ target: Step, @ViewBuilder content: () -> Content) -> some View {
        VLCard {
            HStack {
                VLOverline(target.titleKey)
                Spacer()
                Button("a1.edit") { draft.step = target.rawValue }.buttonStyle(.vlGhost)
            }
            content()
        }
    }

    // MARK: الإجراء الأساسي

    private var bottomBar: some View {
        VStack(spacing: VL.Space.s3) {
            if !issues.isEmpty || submitError != nil || !formErrors.isEmpty {
                VLInlineAlert(tone: .bad, systemImage: "exclamationmark.triangle.fill",
                              textKey: submitError == nil ? "a1.errors.summary" : "material.error.create")
            }
            if step == .review {
                Button { Task { await submit() } } label: {
                    Text(LocalizedStringKey(busy ? "a1.submitting" : "material.submit"))
                }
                .buttonStyle(.vlPrimary)
                .disabled(busy || (replacing == nil && formUnavailable && form == nil))
            } else {
                Button("a1.next") { go(by: 1) }.buttonStyle(.vlPrimary)
                if step == .file, draft.file == nil {
                    Text("a1.next.needsFile").vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                }
            }
        }
        .padding(VL.Space.s5)
        .background(Color.vl.bgSurface.ignoresSafeArea(edges: .bottom))
    }

    private func go(by delta: Int) {
        guard let index = steps.firstIndex(of: step) else { return }
        if delta > 0 {
            guard validate(step) else { return }
        }
        let next = min(max(index + delta, 0), steps.count - 1)
        withAnimation(VL.Easing.standard(VL.Duration.base)) { draft.step = steps[next].rawValue }
        issues = []
        formErrors = []
    }

    private func validate(_ s: Step) -> Bool {
        switch s {
        case .file: issues = DraftValidator.fileIssues(draft)
        case .fields: issues = DraftValidator.fieldIssues(draft)
        case .form:
            guard let form else { return !formUnavailable }
            formErrors = FormValidator.validate(form: form, materialType: primaryType.rawValue, values: draft.dynamicValues).errors
            return formErrors.isEmpty
        case .review: return true
        }
        return issues.isEmpty
    }

    private func submit() async {
        submitError = nil
        busy = true
        defer { busy = false }
        guard let file = draft.file else { issues = [.fileMissing]; return }
        let lightCopy = file.isVideo ? (ProxyChoice(rawValue: draft.lightCopy ?? "") ?? .originalOnly) : .originalOnly
        do {
            if let replacing {
                try await queue.enqueue(relativePath: file.relativePath, materialId: replacing.id, filename: file.filename, mimeType: file.mimeType,
                                        lightCopy: lightCopy, title: replacing.title, priority: replacing.priority)
                dismiss()
                return
            }
            guard let form, FormValidator.validate(form: form, materialType: primaryType.rawValue, values: draft.dynamicValues).valid else {
                draft.step = Step.form.rawValue
                return
            }
            draft.formVersion = form.version
            let visible = Set(FormValidator.visibleFields(form: form, materialType: primaryType.rawValue, values: draft.dynamicValues).map(\.key))
            let dynamic = draft.dynamicValues.filter { visible.contains($0.key) && !$0.value.isEmpty }.mapValues(\.jsonValue)
            guard let body = DraftValidator.materialCreate(draft, dynamicFields: dynamic) else {
                issues = DraftValidator.fieldIssues(draft)
                draft.step = Step.fields.rawValue
                return
            }
            // المفتاح ثابت للمسودة: إعادة الإرسال بعد انقطاع تعيد المادة نفسها ولا تنشئ ثانية.
            let material = try await MaterialsAPI.createMaterial(idempotencyKey: draft.createIdempotencyKey, materialCreate: body, apiConfiguration: app.api)
            draft.createdMaterialId = material.id
            try await queue.enqueue(relativePath: file.relativePath, materialId: material.id, filename: file.filename, mimeType: file.mimeType,
                                    lightCopy: lightCopy, title: body.title, priority: body.priority)
            queue.deleteDraft(draft.id)
            dismiss()
        } catch {
            submitError = "material.error.create"
            queue.saveDraft(draft)
        }
    }

    // MARK: الملف والنموذج والنسخة الخفيفة

    /// النسخة الأصلية من PhotosUI تُنقل كملف (`FileRepresentation`) بلا إعادة ترميز ولا تجريد.
    private func importPicked(_ item: PhotosPickerItem?) async {
        guard let item, let picked = try? await item.loadTransferable(type: PickedFile.self) else { return }
        await importFile(picked.url)
        try? FileManager.default.removeItem(at: picked.url)
    }

    private func importFile(_ url: URL) async {
        do {
            let (path, size) = try UploadServices.shared.importFile(from: url, preferredName: url.lastPathComponent)
            let type = UTType(filenameExtension: url.pathExtension)
            let isVideo = type?.conforms(to: .movie) ?? false
            var duration: Double?
            if isVideo {
                let asset = AVURLAsset(url: UploadServices.shared.documentsDirectory.appendingPathComponent(path))
                duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds)
            }
            if let old = draft.file { UploadServices.shared.deleteLocalCopy(relativePath: old.relativePath) }
            draft.file = .init(relativePath: path, filename: url.lastPathComponent, sizeBytes: size, mimeType: type?.preferredMIMEType,
                               isVideo: isVideo, durationSeconds: duration)
            draft.lightCopyChosenByReporter = false
            issues = []
            await loadThumbnail()
            await suggestLightCopy()
        } catch {
            submitError = "material.error.import"
        }
    }

    private func suggestLightCopy() async {
        guard let file = draft.file, !draft.lightCopyChosenByReporter else { return }
        guard file.isVideo else { draft.lightCopy = ProxyChoice.originalOnly.rawValue; return }
        let context = await DeviceConditions.context(isVideo: true, durationSeconds: file.durationSeconds ?? 0, priority: draft.priority ?? .normal)
        draft.lightCopy = ProxyPolicy.suggest(context).rawValue
    }

    /// مصغّرة محلية للعرض فقط؛ لا تخرج من الجهاز.
    private func loadThumbnail() async {
        guard let file = draft.file else { thumbnail = nil; return }
        let url = UploadServices.shared.documentsDirectory.appendingPathComponent(file.relativePath)
        if file.isVideo {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: VL.Size.thumbW, height: VL.Size.thumbH)
            if let cg = try? await generator.image(at: .zero).image { thumbnail = Image(decorative: cg, scale: 1) }
        } else if let ui = UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: VL.Size.thumbW, height: VL.Size.thumbH)) {
            thumbnail = Image(uiImage: ui)
        }
    }

    /// آخر نسخة ناجحة من النموذج لكل نوع تُحفظ مؤقتًا؛ بلا شبكة تُستعمل بشارة «إصدار محفوظ»، وإلا فالمسودة فقط.
    private func loadForm() async {
        guard replacing == nil else { return }
        let type = primaryType
        do {
            let fresh = try await FormsAPI.getCurrentForm(materialType: type, apiConfiguration: app.api)
            form = fresh
            formFromCache = false
            formUnavailable = false
            FormCache.save(fresh, type: type)
        } catch {
            if let cached = FormCache.load(type: type) {
                form = cached
                formFromCache = true
                formUnavailable = false
            } else {
                form = nil
                formUnavailable = true
            }
        }
    }
}

/// نماذج المكتب المحفوظة مؤقتًا (لا بيانات مراسل فيها)؛ في مجلد Caches الذي يمحوه المسح الطارئ.
enum FormCache {
    private static func url(_ type: MaterialType) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("FormCache-\(type.rawValue).json")
    }

    static func save(_ form: UploadForm, type: MaterialType) {
        guard let data = try? CodableHelper().jsonEncoder.encode(form) else { return }
        try? data.write(to: url(type), options: .atomic)
    }

    static func load(type: MaterialType) -> UploadForm? {
        guard let data = try? Data(contentsOf: url(type)) else { return nil }
        return try? CodableHelper().jsonDecoder.decode(UploadForm.self, from: data)
    }
}

/// غلاف نمط زر يسمح باختيار النمط في الوقت التشغيلي.
struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
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
