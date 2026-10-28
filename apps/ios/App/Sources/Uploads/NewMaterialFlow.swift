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
/// `replacing`: «رفع لقطة بديلة» لمادة قائمة — خطوة الملف ثم المراجعة فقط، وبملف واحد.
/// الملفات المختارة (حتى 20) مادة واحدة بعنوان وبيانات واحدة؛ كلٌّ منها يُرفع أصلًا بجلسته (ADR 0081).
/// الورقة لا تُغلق بالسحب متى وُجد إدخال؛ الإغلاق بزر الإلغاء يسأل: مسودة أو تجاهل أو متابعة.
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
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showFileImporter = false
    /// مصغّرات الملفات المختارة بمسارها النسبي (للعرض فقط).
    @State private var thumbnails: [String: Image] = [:]
    @State private var importing = false
    @State private var confirmClose = false

    init(draft: MaterialDraft? = nil, replacing: PostHistoryAPI.Material? = nil) {
        _draft = State(initialValue: draft ?? MaterialDraft())
        self.replacing = replacing
    }

    private var step: Step { Step(rawValue: draft.step) ?? .file }
    private var steps: [Step] { replacing == nil ? Step.allCases : [.file, .review] }
    private var position: Int { (steps.firstIndex(of: step) ?? 0) + 1 }
    /// «لقطة بديلة» ملف واحد؛ المادة الجديدة حتى `MaterialDraft.maxFiles`.
    private var pickLimit: Int { replacing == nil ? max(1, MaterialDraft.maxFiles - draft.files.count) : 1 }
    private var atLimit: Bool { replacing == nil && draft.files.count >= MaterialDraft.maxFiles }
    /// المسودة محفوظة على القرص مسبقًا (فُتحت من قائمة المسودات أو حُفظت من هنا).
    private var draftIsSaved: Bool { queue.drafts.contains { $0.id == draft.id } }

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
                            .disabled(busy || importing)
                    } else {
                        Button("material.cancel") { requestClose() }.disabled(busy || importing)
                    }
                }
                if replacing == nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button("a1.saveDraft") { queue.saveDraft(draft); dismiss() }.buttonStyle(.vlGhost).disabled(busy || importing)
                    }
                }
            }
            // ما دام فيه إدخال لا تُغلق الورقة بسحبٍ عابر أثناء التمرير؛ الإغلاق بزر الإلغاء وبسؤال.
            .interactiveDismissDisabled(draft.hasInput || importing || busy)
            .confirmationDialog("a1.close.title", isPresented: $confirmClose, titleVisibility: .visible) {
                if replacing == nil {
                    Button("a1.saveDraft") { queue.saveDraft(draft); dismiss() }
                }
                Button(LocalizedStringKey(draftIsSaved ? "draft.delete" : "a1.close.discard"), role: .destructive) { discardAndClose() }
                Button("a1.close.keep", role: .cancel) {}
            } message: {
                Text("a1.close.message")
            }
            .onChange(of: pickerItems) { _, items in
                guard !items.isEmpty else { return }
                Task { await importPicked(items) }
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.movie, .image], allowsMultipleSelection: replacing == nil) { result in
                guard case .success(let urls) = result, !urls.isEmpty else { return }
                Task { await importScoped(urls) }
            }
            .task(id: draft.materialTypes) { await loadForm() }
            .onChange(of: draft.priority) { _, _ in Task { await suggestLightCopy() } }
            .task(id: draft.files.map(\.relativePath)) { await loadMissingThumbnails() }
        }
    }

    /// الإلغاء على الخطوة الأولى: بلا إدخال يُغلق مباشرة، وإلا يُسأل المراسل.
    private func requestClose() {
        if draft.hasInput { confirmClose = true } else { dismiss() }
    }

    /// التجاهل يحذف النسخ المحلية التي أنشأتها هذه الورقة (لا الأصل في المعرض)، ومسودتها المحفوظة إن وُجدت.
    /// الرفوعات التي دخلت الطابور من قبل لا تتأثر: ملفاتها نسخ أخرى في سجلاتها.
    private func discardAndClose() {
        for file in draft.files { UploadServices.shared.deleteLocalCopy(relativePath: file.relativePath) }
        if replacing == nil { queue.deleteDraft(draft.id) }
        dismiss()
    }

    // MARK: الخطوة 1 · الملف

    @ViewBuilder private var fileStep: some View {
        if draft.files.isEmpty, !importing {
            VStack(spacing: VL.Space.s4) {
                Image(systemName: "photo.on.rectangle.angled").font(.largeTitle).foregroundStyle(Color.vl.iconMuted)
                Text("a1.file.empty").vlText(.bodyMd).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
                if replacing == nil {
                    Text("a1.file.multiHint").vlText(.captionMd).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
                }
                pickButtons(primary: true)
            }
            .padding(VL.Space.s7)
            .frame(maxWidth: .infinity)
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.lg)
                .strokeBorder(Color.vl.borderStrong, style: StrokeStyle(lineWidth: VL.Border.hairline, dash: [VL.Space.s3, VL.Space.s2])))
        } else {
            VLCard {
                if replacing == nil {
                    Text("a1.files.count \(draft.files.count) \(MaterialDraft.maxFiles)").vlText(.labelMd).foregroundStyle(Color.vl.textSecondary)
                }
                ForEach(draft.files, id: \.relativePath) { file in fileRow(file) }
                if importing {
                    HStack(spacing: VL.Space.s3) {
                        ProgressView()
                        Text("a1.file.importing").vlText(.bodySm).foregroundStyle(Color.vl.textSecondary)
                    }
                }
                if draft.videoCount > 0 { lightCopyLine }
                pickButtons(primary: false)
            }
        }
    }

    /// صف ملف مختار: مصغّرة واسم وحقائق وزر إزالة (يحذف النسخة المحلية فقط).
    private func fileRow(_ file: MaterialDraft.PickedFile) -> some View {
        HStack(alignment: .center, spacing: VL.Space.s4) {
            thumbnailView(for: file)
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                Text(verbatim: file.filename).vlText(.labelLg).foregroundStyle(Color.vl.textPrimary).lineLimit(2)
                Text(verbatim: fileFacts(file)).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
            }
            Spacer(minLength: 0)
            if replacing == nil {
                Button { remove(file) } label: { Label("a1.file.remove", systemImage: "xmark.circle.fill").labelStyle(.iconOnly) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.vl.iconMuted)
                    .frame(minWidth: VL.Size.touchMin, minHeight: VL.Size.touchMin)
                    .disabled(busy || importing)
            }
        }
    }

    private func thumbnailView(for file: MaterialDraft.PickedFile) -> some View {
        Group {
            if let image = thumbnails[file.relativePath] {
                image.resizable().scaledToFill()
            } else {
                Color.vl.bgSubtle.overlay(Image(systemName: file.isVideo ? "video" : "photo").foregroundStyle(Color.vl.iconMuted))
            }
        }
        .frame(width: VL.Size.thumbW / 2, height: VL.Size.thumbH / 2)
        .clipShape(RoundedRectangle(cornerRadius: VL.Radius.md))
        .accessibilityHidden(true)
    }

    private func pickButtons(primary: Bool) -> some View {
        VStack(spacing: VL.Space.s3) {
            PhotosPicker(selection: $pickerItems, maxSelectionCount: pickLimit, selectionBehavior: .ordered,
                         matching: .any(of: [.videos, .images]), preferredItemEncoding: .current) {
                Label(LocalizedStringKey(primary ? "a1.file.pick" : (replacing == nil ? "a1.file.addMore" : "a1.file.change")), systemImage: "photo.on.rectangle")
            }
            .buttonStyle(primary ? AnyButtonStyle(VLPrimaryButtonStyle()) : AnyButtonStyle(VLSecondaryButtonStyle()))
            .disabled(importing || atLimit)
            Button { showFileImporter = true } label: { Label("material.file.fromFiles", systemImage: "folder") }
                .buttonStyle(.vlGhost)
                .disabled(importing || atLimit)
        }
    }

    private var lightCopyLine: some View {
        HStack(spacing: VL.Space.s3) {
            Image(systemName: "bolt.horizontal.fill").foregroundStyle(Color.vl.iconBrand)
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                Text("material.lightCopy").vlText(.labelMd).foregroundStyle(Color.vl.textPrimary)
                Text(LocalizedStringKey("material.lightCopy." + (draft.lightCopy ?? ProxyChoice.originalOnly.rawValue)))
                    .vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                if draft.videoCount > 1 {
                    Text("a1.lightCopy.allVideos").vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                }
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
            if draft.files.count > 1 {
                Text("a1.review.files \(draft.files.count) \(ByteCountFormatter.string(fromByteCount: draft.totalSizeBytes, countStyle: .file))").vlText(.bodyMd)
            }
            ForEach(draft.files, id: \.relativePath) { f in
                if draft.files.count > 1 {
                    Text(verbatim: f.filename).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                } else {
                    Text(verbatim: f.filename).vlText(.bodyMd)
                }
            }
            Text(uploadPlanKey).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
        }
    }

    private var uploadPlanKey: LocalizedStringKey {
        let choice = ProxyChoice(rawValue: draft.lightCopy ?? "") ?? .originalOnly
        return draft.videoCount > 0 && choice != .originalOnly ? "a1.review.plan.lightThenOriginal" : "a1.review.plan.originalOnly"
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
                Button("a1.next") { go(by: 1) }.buttonStyle(.vlPrimary).disabled(importing)
                if step == .file, draft.files.isEmpty {
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
        guard !draft.files.isEmpty else { issues = [.fileMissing]; return }
        // اختيار النسخة الخفيفة واحد للمجموعة ويسري على كل فيديو فيها؛ الصور أصلًا فقط.
        let choice = ProxyChoice(rawValue: draft.lightCopy ?? "") ?? .originalOnly
        // ما لم يدخل الطابور بعد: عند فشل في المنتصف تبقى هذه الملفات وحدها في المسودة فلا يُرفع ملف مرتين.
        var pending = draft.files
        do {
            if let replacing {
                guard let file = pending.first else { return }
                try await queue.enqueue(relativePath: file.relativePath, materialId: replacing.id, filename: file.filename, mimeType: file.mimeType,
                                        lightCopy: file.isVideo ? choice : .originalOnly, title: replacing.title, priority: replacing.priority)
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
            // المادة واحدة، وكل ملف أصلٌ بجلسته بترتيب اختياره.
            while let file = pending.first {
                try await queue.enqueue(relativePath: file.relativePath, materialId: material.id, filename: file.filename, mimeType: file.mimeType,
                                        lightCopy: file.isVideo ? choice : .originalOnly, title: body.title, priority: body.priority)
                pending.removeFirst()
            }
            queue.deleteDraft(draft.id)
            dismiss()
        } catch {
            submitError = "material.error.create"
            draft.files = pending
            queue.saveDraft(draft)
        }
    }

    // MARK: الملف والنموذج والنسخة الخفيفة

    /// الأصول المختارة من PhotosUI تُنقل ملفاتٍ (`FileRepresentation`) بلا إعادة ترميز ولا تجريد، واحدًا بعد آخر بترتيب الاختيار.
    private func importPicked(_ items: [PhotosPickerItem]) async {
        pickerItems = []
        importing = true
        defer { importing = false }
        var failed = false
        var imported = false
        for item in items {
            guard draft.files.count < maxFilesNow else { break }
            guard let picked = try? await item.loadTransferable(type: PickedFile.self) else { failed = true; continue }
            if await importFile(picked.url) { imported = true } else { failed = true }
            try? FileManager.default.removeItem(at: picked.url)
        }
        if failed { submitError = "material.error.import" }
        if imported { await suggestLightCopy() }
    }

    /// ملفات تطبيق «الملفات»: الوصول المحمي بالنطاق يبدأ لكل رابط ويُنهى بعد نسخه.
    private func importScoped(_ urls: [URL]) async {
        importing = true
        defer { importing = false }
        var failed = false
        var imported = false
        for url in urls {
            guard draft.files.count < maxFilesNow else { break }
            let scoped = url.startAccessingSecurityScopedResource()
            if await importFile(url) { imported = true } else { failed = true }
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
        if failed { submitError = "material.error.import" }
        if imported { await suggestLightCopy() }
    }

    /// الحدّ الجاري: ملف واحد في «لقطة بديلة»، وإلا `MaterialDraft.maxFiles`.
    private var maxFilesNow: Int { replacing == nil ? MaterialDraft.maxFiles : Int.max }

    /// ينسخ ملفًا إلى مجلد الرفع ويضيفه إلى المسودة. في «لقطة بديلة» يحلّ محل السابق ونسخته المحلية.
    @discardableResult
    private func importFile(_ url: URL) async -> Bool {
        do {
            let (path, size) = try UploadServices.shared.importFile(from: url, preferredName: url.lastPathComponent)
            let type = UTType(filenameExtension: url.pathExtension)
            let isVideo = type?.conforms(to: .movie) ?? false
            var duration: Double?
            if isVideo {
                let asset = AVURLAsset(url: UploadServices.shared.documentsDirectory.appendingPathComponent(path))
                duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds)
            }
            if replacing != nil {
                for old in draft.files { UploadServices.shared.deleteLocalCopy(relativePath: old.relativePath) }
                draft.files = []
                draft.lightCopyChosenByReporter = false
            }
            draft.files.append(.init(relativePath: path, filename: url.lastPathComponent, sizeBytes: size, mimeType: type?.preferredMIMEType,
                                     isVideo: isVideo, durationSeconds: duration))
            issues = []
            return true
        } catch {
            return false
        }
    }

    /// إزالة ملف من المجموعة تحذف نسخته المحلية فقط؛ الأصل في المعرض أو الملفات لا يُمس.
    private func remove(_ file: MaterialDraft.PickedFile) {
        UploadServices.shared.deleteLocalCopy(relativePath: file.relativePath)
        draft.files.removeAll { $0.relativePath == file.relativePath }
        thumbnails[file.relativePath] = nil
        // مسودة محفوظة تشير إلى الملف المحذوف؛ تُحدَّث كي لا تبقى بمرجع ميت.
        if draftIsSaved { queue.saveDraft(draft) }
        Task { await suggestLightCopy() }
    }

    /// الاقتراح من أطول فيديو في المجموعة ويسري على كل فيديوهاتها؛ اختيار المراسل لا يُستبدل.
    private func suggestLightCopy() async {
        guard !draft.lightCopyChosenByReporter else { return }
        guard let longest = draft.longestVideoSeconds else { draft.lightCopy = ProxyChoice.originalOnly.rawValue; return }
        let context = await DeviceConditions.context(isVideo: true, durationSeconds: longest, priority: draft.priority ?? .normal)
        draft.lightCopy = ProxyPolicy.suggest(context).rawValue
    }

    /// مصغّرات محلية للعرض فقط؛ لا تخرج من الجهاز. تُحمَّل الناقصة وتُترك مصغّرات الملفات المزالة.
    private func loadMissingThumbnails() async {
        let present = Set(draft.files.map(\.relativePath))
        thumbnails = thumbnails.filter { present.contains($0.key) }
        for file in draft.files where thumbnails[file.relativePath] == nil {
            if let image = await makeThumbnail(for: file) { thumbnails[file.relativePath] = image }
        }
    }

    private func makeThumbnail(for file: MaterialDraft.PickedFile) async -> Image? {
        let url = UploadServices.shared.documentsDirectory.appendingPathComponent(file.relativePath)
        if file.isVideo {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: VL.Size.thumbW, height: VL.Size.thumbH)
            if let cg = try? await generator.image(at: .zero).image { return Image(decorative: cg, scale: 1) }
        } else if let ui = UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: VL.Size.thumbW, height: VL.Size.thumbH)) {
            return Image(uiImage: ui)
        }
        return nil
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
