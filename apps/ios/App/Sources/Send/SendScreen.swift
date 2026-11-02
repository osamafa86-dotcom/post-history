import FormEngine
import MaterialsCore
import MediaCore
import PhotosUI
import PostHistoryAPI
import SwiftUI
import UniformTypeIdentifiers

/// 04 · شاشة الإرسال الواحدة (docs/design/specs/reporter-v2.md؛ ADR 0088) بدل تدفق الخطوات الأربع: الملفات (حتى 20، مادة لكل ملف
/// بالبيانات نفسها، ADR 0081)، ثم عنوان التغطية ونوعها ووسومها، والمكان المتذكَّر، و«عاجل»، وسؤال الحساسية الواحد،
/// وتحت «المزيد» «مهم» وتاريخ التصوير واسم الظهور وحقول النموذج الاختيارية. «أرسل N مواد» معطّل ونصّه أول ما ينقص.
/// تكفي المراسل نحو ثلاثين ثانية: ما يُتذكَّر يُملأ وحده، والقرار وحده يُطلب منه. لا إحداثيات في هذا الإصدار (ADR 0087 لاحقًا).
struct SendScreen: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var queue: UploadQueueModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var draft: MaterialDraft
    private let opensPicker: Bool
    private let onSent: () -> Void

    /// المسودة بعد ملء المتذكَّر: إغلاق شاشة لم يتغيّر فيها شيء لا يسأل.
    @State private var baseline: MaterialDraft?
    @State private var memory = ReporterMemory()
    @State private var form: UploadForm?
    @State private var formFromCache = false
    @State private var formUnavailable = false
    @State private var busy = false
    @State private var importing = false
    @State private var submitError: LocalizedStringKey?
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showPicker = false
    @State private var showFileImporter = false
    @State private var confirmClose = false
    @State private var editingPlace = false
    @State private var showMore = false
    /// ما في حقل الوسوم ولم يُثبَّت بعد؛ يُثبَّت عند «أرسل» إن صلح، وإلا فهو سبب التعطيل.
    @State private var pendingTag = ""
    /// «مطلوب» تحت حقول النموذج الفارغة يظهر منذ صار النموذج ما يمنع الإرسال، لا من أول الشاشة.
    @State private var revealRequired = false
    /// الحقل الذي تمرّر إليه الشاشة (أول خطأ في النموذج).
    @State private var scrollTarget: String?
    @FocusState private var titleFocused: Bool
    @FocusState private var tagsFocused: Bool

    init(draft: MaterialDraft? = nil, onSent: @escaping () -> Void = {}) {
        _draft = State(initialValue: draft ?? MaterialDraft())
        opensPicker = draft == nil
        self.onSent = onSent
    }

    private var pickLimit: Int { max(1, MaterialDraft.maxFiles - draft.files.count) }
    private var atLimit: Bool { draft.files.count >= MaterialDraft.maxFiles }
    private var draftIsSaved: Bool { queue.drafts.contains { $0.id == draft.id } }
    private var changed: Bool { baseline.map { $0 != draft } ?? draft.hasInput }

    private var primaryType: MaterialType {
        MaterialType.allCases.first { draft.materialTypes.contains($0) && $0 != .unknownDefaultOpenApi } ?? .report
    }

    /// أخطاء نموذج المكتب بترتيب الشاشة (`SendFormCheck`، مختبر): «ناقص» غير «غير صالح»، وكل حقل يعرض خطأه.
    private var formCheck: SendFormCheck? {
        form.map { SendFormCheck(form: $0, materialType: primaryType.rawValue, values: draft.dynamicValues) }
    }

    private var formState: SendReadiness.FormState {
        guard let formCheck else { return formUnavailable ? .unavailable : .loading }
        return formCheck.state
    }

    private var formErrors: [FieldError] { formCheck?.shownErrors(revealRequired: revealRequired) ?? [] }

    private var reason: SendReadiness.Reason? { SendReadiness.firstReason(draft, form: formState, pendingTag: pendingTag) }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: VL.Space.s6) {
                        filesSection
                        TitleField(title: $draft.title, fileCount: draft.files.count, focused: $titleFocused)
                            .onSubmit { tagsFocused = true }
                        CoverageTypePicker(selection: $draft.materialTypes)
                        TagInput(tags: $draft.tags, text: $pendingTag, history: memory.recentTags, focused: $tagsFocused)
                        HStack(alignment: .top, spacing: VL.Space.s3) {
                            LocationChip(governorate: draft.governorate, city: draft.city,
                                         remembered: memory.isRemembered(governorate: draft.governorate, city: draft.city)) { editingPlace = true }
                            UrgentToggle(isOn: Binding(get: { draft.priority == .urgent }, set: { draft.priority = $0 ? .urgent : .normal }))
                        }
                        SensitivityQuestion(draft: $draft)
                        requiredFormFields
                        moreSection
                    }
                    .padding(.horizontal, VL.Space.s5)
                    .padding(.top, VL.Space.s3)
                    .padding(.bottom, VL.Space.s7)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: scrollTarget) { _, target in
                    guard let target else { return }
                    VLMotion.animate(reduceMotion) { proxy.scrollTo(target, anchor: .center) }
                    scrollTarget = nil
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { sendBar }
        .vlScreen()
        .photosPicker(isPresented: $showPicker, selection: $pickerItems, maxSelectionCount: pickLimit, selectionBehavior: .ordered,
                      matching: .any(of: [.videos, .images]), preferredItemEncoding: .current)
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.movie, .image], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result, !urls.isEmpty else { return }
            Task { await importScoped(urls) }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await importPicked(items) }
        }
        .confirmationDialog("a1.close.title", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("a1.saveDraft") { queue.saveDraft(draft); dismiss() }
            Button(LocalizedStringKey(draftIsSaved ? "draft.delete" : "a1.close.discard"), role: .destructive) { discardAndClose() }
            Button("a1.close.keep", role: .cancel) {}
        } message: {
            Text("a1.close.message")
        }
        .sheet(isPresented: $editingPlace) {
            PlaceEditor(governorate: $draft.governorate, city: $draft.city)
        }
        .task { await start() }
        .task(id: primaryType) { await loadForm() }
        .onChange(of: draft.priority) { _, _ in Task { await suggestLightCopy() } }
        .onChange(of: reason) { old, new in
            guard let new, new.isFormError else { return }
            revealRequired = true
            // صار النموذج ما يمنع الإرسال بعد سبب آخر (لا أثناء الكتابة في حقل كان سليمًا): الشاشة تأخذ المراسل إلى أول خطأ.
            if let old, old != new { revealFirstFormError() }
        }
    }

    // MARK: الرأس والملفات

    private var header: some View {
        HStack(spacing: VL.Space.s3) {
            Color.clear.frame(width: VL.Size.touchMin, height: VL.Size.touchMin).accessibilityHidden(true)
            Text("send.title")
                .vlText(.headline)
                .foregroundStyle(Color.vl.textPrimary)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            VLIconButton(systemImage: "xmark", label: "send.close") { requestClose() }
                .disabled(busy || importing)
        }
        .padding(.horizontal, VL.Space.s5)
        .padding(.vertical, VL.Space.s2)
    }

    @ViewBuilder private var filesSection: some View {
        if draft.files.isEmpty, !importing {
            VStack(spacing: VL.Space.s4) {
                Image(systemName: "photo.on.rectangle.angled").font(.largeTitle).foregroundStyle(Color.vl.textSecondary).accessibilityHidden(true)
                Text("send.files.empty").vlText(.body).foregroundStyle(Color.vl.textSecondary).multilineTextAlignment(.center)
                Button { showPicker = true } label: { Label("send.files.pick", systemImage: "photo.on.rectangle") }.buttonStyle(.vlSolid)
                Button { showFileImporter = true } label: { Label("material.file.fromFiles", systemImage: "folder") }.buttonStyle(.vlGhost)
            }
            .padding(VL.Space.s6)
            .frame(maxWidth: .infinity)
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous)
                .strokeBorder(Color.vl.borderEdge, style: StrokeStyle(lineWidth: VL.Border.field, dash: [8, 5])))
        } else {
            VStack(alignment: .leading, spacing: VL.Space.s3) {
                HStack(alignment: .center, spacing: VL.Space.s4) {
                    VStack(alignment: .leading, spacing: VL.Space.s1) {
                        Text("send.files.count \(draft.files.count)").vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                        Text(verbatim: VLFormat.bytes(draft.totalSizeBytes)).vlText(.num).foregroundStyle(Color.vl.textSecondary)
                            .environment(\.layoutDirection, .leftToRight)
                        if importing {
                            HStack(spacing: VL.Space.s2) {
                                ProgressView().controlSize(.small)
                                Text("a1.file.importing").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                            }
                        }
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: VL.Space.s3) {
                            ForEach(draft.files, id: \.relativePath) { file in thumb(file) }
                            if !atLimit { addTile }
                        }
                        .padding(.vertical, VL.Space.s1)
                    }
                }
                if draft.videoCount > 0 { lightCopyLine }
            }
        }
    }

    /// مصغّرة الملف بمدته، وزرّ إزالة (يحذف النسخة المحلية وحدها؛ الأصل في المعرض لا يُمس).
    private func thumb(_ file: MaterialDraft.PickedFile) -> some View {
        LocalThumbnail(relativePath: file.relativePath, isVideo: file.isVideo, width: 64, height: 84, radius: VL.Radius.sm)
            .overlay(alignment: .bottomTrailing) {
                if let d = file.durationSeconds, d > 0 {
                    Text(verbatim: VLFormat.duration(d))
                        .vlText(.caption).monospacedDigit()
                        .foregroundStyle(Color.vl.textOnStore)
                        .padding(.horizontal, VL.Space.s2)
                        .background(Color.vl.bgStore.opacity(0.8), in: Capsule())
                        .environment(\.layoutDirection, .leftToRight)
                        .padding(VL.Space.s1)
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .topTrailing) {
                Button { remove(file) } label: {
                    Image(systemName: "xmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(Color.vl.textOnStore, Color.vl.bgStore.opacity(0.8))
                        .frame(width: VL.Size.touchMin, height: VL.Size.touchMin, alignment: .topTrailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy || importing)
                .accessibilityLabel(Text("send.files.remove \(file.filename)"))
            }
    }

    private var addTile: some View {
        Menu {
            Button { showPicker = true } label: { Label("send.files.pick", systemImage: "photo.on.rectangle") }
            Button { showFileImporter = true } label: { Label("material.file.fromFiles", systemImage: "folder") }
        } label: {
            Image(systemName: "plus")
                .font(.title3)
                .foregroundStyle(Color.vl.textBrand)
                .frame(width: 64, height: 84)
                .overlay(RoundedRectangle(cornerRadius: VL.Radius.sm, style: .continuous)
                    .strokeBorder(Color.vl.borderEdge, style: StrokeStyle(lineWidth: VL.Border.field, dash: [6, 4])))
        }
        .disabled(importing || busy)
        .accessibilityLabel(Text("a1.file.addMore"))
    }

    /// النسخة الخفيفة (ADR 0075): اقتراح من أطول فيديو يسري على كل الفيديوهات، والمراسل يغيّره.
    private var lightCopyLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: VL.Space.s3) {
            Image(systemName: "bolt.horizontal").foregroundStyle(Color.vl.stateOk).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                Text("send.light.mode \(Text(LocalizedStringKey("material.lightCopy." + (draft.lightCopy ?? ProxyChoice.originalOnly.rawValue))))")
                    .vlText(.label).foregroundStyle(Color.vl.textPrimary)
                Text("send.light.note").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
            }
            Spacer(minLength: 0)
            Menu {
                ForEach(ProxyChoice.allCases, id: \.self) { choice in
                    Button(LocalizedStringKey("material.lightCopy." + choice.rawValue)) {
                        draft.lightCopy = choice.rawValue
                        draft.lightCopyChosenByReporter = true
                    }
                }
            } label: {
                Text("a1.lightCopy.change").vlText(.label).foregroundStyle(Color.vl.textBrand).frame(minHeight: VL.Size.touchMin)
            }
        }
        .padding(VL.Space.s3)
        .background(Color.vl.bgSunken, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("material.lightCopy.hint"))
    }

    // MARK: النموذج و«المزيد»

    /// حقول النموذج الإلزامية تظهر فوق زرّ الإرسال لا تحت «المزيد» (reporter-v2.md).
    @ViewBuilder private var requiredFormFields: some View {
        if let form, FormValidator.visibleFields(form: form, materialType: primaryType.rawValue, values: draft.dynamicValues).contains(where: \.required) {
            VStack(alignment: .leading, spacing: VL.Space.s4) {
                VLSectionHeader("send.form.required")
                DynamicFormView(form: form, materialType: primaryType.rawValue, values: $draft.dynamicValues, errors: formErrors, include: { $0.required })
            }
        }
    }

    private var moreSection: some View {
        VStack(alignment: .leading, spacing: VL.Space.s4) {
            Button { VLMotion.animate(reduceMotion) { showMore.toggle() } } label: {
                HStack {
                    Text("send.more").vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                    Spacer()
                    Image(systemName: showMore ? "chevron.up" : "chevron.down").foregroundStyle(Color.vl.textSecondary)
                }
                .frame(minHeight: VL.Size.touchMin)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(Text(LocalizedStringKey(showMore ? "a11y.expanded" : "a11y.collapsed")))
            if showMore {
                VLCard {
                    Toggle(isOn: Binding(get: { draft.priority == .important }, set: { draft.priority = $0 ? .important : .normal })) {
                        VStack(alignment: .leading, spacing: VL.Space.s1) {
                            Text("material.priority.important").vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                            Text("send.more.important.help").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                        }
                    }
                    .tint(Color.vl.actionPrimary)
                    Divider().overlay(Color.vl.borderLine)
                    shotAtEditor
                    Divider().overlay(Color.vl.borderLine)
                    displayNameEditor
                    if let form {
                        if formFromCache { StateBadge(labelKey: "a1.form.cached", tone: .warn, systemImage: "clock") }
                        DynamicFormView(form: form, materialType: primaryType.rawValue, values: $draft.dynamicValues, errors: formErrors, include: { !$0.required })
                    }
                }
            }
            if formUnavailable, form == nil {
                VLNote(tone: .warn, systemImage: "wifi.slash", text: Text("a1.form.unavailable"))
            }
        }
    }

    /// أول خطأ في النموذج بترتيب الشاشة: «المزيد» يُفتح إن كان الحقل تحته ومطويًّا، ثم تمرّر الشاشة إلى الحقل.
    private func revealFirstFormError() {
        guard let check = formCheck, let first = check.first else { return }
        let target = DynamicFormView.anchor(first.field)
        guard check.firstIsUnderMore, !showMore else { scrollTarget = target; return }
        VLMotion.animate(reduceMotion) { showMore = true }
        // يُرسم الحقل تحت «المزيد» أولًا، ثم يُمرَّر إليه.
        Task {
            try? await Task.sleep(for: .milliseconds(150))
            scrollTarget = target
        }
    }

    /// تاريخ التصوير: يُقرأ من الملف، ويُصحَّح هنا لكل ملفات الإرسالة.
    private var shotAtEditor: some View {
        let fromFile = draft.files.compactMap(\.capturedAt).min()
        return VStack(alignment: .leading, spacing: VL.Space.s2) {
            Text("send.more.shotAt").vlText(.headline).foregroundStyle(Color.vl.textPrimary)
            if let fromFile {
                Text("send.more.shotAt.fromFile \(VLFormat.time(fromFile))").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
            } else {
                Text("send.more.shotAt.unknown").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
            }
            Toggle(isOn: Binding(get: { draft.shotAtOverride != nil }, set: { draft.shotAtOverride = $0 ? (fromFile ?? Date()) : nil })) {
                Text("send.more.shotAt.correct").vlText(.body).foregroundStyle(Color.vl.textPrimary)
            }
            .tint(Color.vl.actionPrimary)
            if draft.shotAtOverride != nil {
                DatePicker(selection: Binding(get: { draft.shotAtOverride ?? Date() }, set: { draft.shotAtOverride = $0 }), in: ...Date()) {
                    Text("send.more.shotAt")
                }
                .labelsHidden()
                .tint(Color.vl.actionPrimary)
            }
        }
    }

    /// اسم الظهور: من الإعدادات، ويُغيَّر هنا لهذه الإرسالة وحدها.
    private var displayNameEditor: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            Text("material.displayName").vlText(.headline).foregroundStyle(Color.vl.textPrimary)
            Picker(selection: Binding(get: { draft.displayMode ?? .realName }, set: { draft.displayMode = $0 })) {
                ForEach(DisplayName.Mode.allCases.filter { $0 != .unknownDefaultOpenApi }, id: \.self) {
                    Text(LocalizedStringKey("material.displayName." + $0.rawValue)).tag($0)
                }
            } label: { Text("material.displayName") }
            .pickerStyle(.menu)
            .tint(Color.vl.textBrand)
            .frame(minHeight: VL.Size.touchMin)
            if draft.displayMode == .pseudonym {
                TextField(text: $draft.pseudonym, prompt: Text(verbatim: "")) { Text("material.pseudonym") }
                    .vlInput()
                    .accessibilityLabel(Text("material.pseudonym"))
            }
            Text("send.more.displayName.help").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
        }
    }

    // MARK: الإرسال

    private var sendLabel: LocalizedStringKey {
        if busy { return "send.sending" }
        if importing { return "a1.file.importing" }
        if let reason { return LocalizedStringKey(reason.labelKey) }
        return "send.cta \(draft.files.count)"
    }

    private var sendBar: some View {
        VStack(spacing: VL.Space.s3) {
            if let submitError {
                VLNote(tone: .danger, systemImage: "exclamationmark.triangle", text: Text(submitError))
            }
            Button { Task { await submit() } } label: {
                HStack(spacing: VL.Space.s3) {
                    if busy { ProgressView().tint(Color.vl.textSecondary) }
                    Text(sendLabel)
                }
            }
            .buttonStyle(.vlPrimary)
            .disabled(reason != nil || busy || importing)
        }
        .padding(.horizontal, VL.Space.s5)
        .padding(.vertical, VL.Space.s3)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
        .background(Color.vl.bgBase.ignoresSafeArea(edges: .bottom))
    }

    private func submit() async {
        // وسم كُتب ولم يُثبَّت: لمس «أرسل» لا ينزع التركيز من الحقل، فيُثبَّت هنا قبل الفحص (وما لا يُضاف هو سبب التعطيل).
        guard MaterialTagRules.commitPending(pendingTag, to: &draft.tags) else { return }
        pendingTag = ""
        guard SendReadiness.firstReason(draft, form: formState) == nil, let form else { return }
        submitError = nil
        busy = true
        defer { busy = false }
        var ready = draft
        if ready.priority == nil { ready.priority = .normal }
        ready.formVersion = form.version
        let visible = Set(FormValidator.visibleFields(form: form, materialType: primaryType.rawValue, values: ready.dynamicValues).map(\.key))
        let dynamic = ready.dynamicValues.filter { visible.contains($0.key) && !$0.value.isEmpty }.mapValues(\.jsonValue)
        // اختيار النسخة الخفيفة واحد للإرسالة ويسري على كل فيديو فيها؛ الصور أصلًا فقط.
        let choice = ProxyChoice(rawValue: ready.lightCopy ?? "") ?? .originalOnly
        let api = app.api
        // مادة لكل ملف بالبيانات المشتركة نفسها (ADR 0081)؛ لكل ملف مفتاح إنشاء ثابت، وما دخل الطابور يُسقَط من المسودة.
        // والإرسالة تُسجَّل قبل أول ملف وتُغلق بعد آخره، فيجمعها إيصال واحد (ADR 0088).
        let result = await queue.submit(ready, dynamicFields: dynamic, lightCopy: choice) { key, body in
            try await MaterialsAPI.createMaterial(idempotencyKey: key, materialCreate: body, apiConfiguration: api).id
        }
        if !result.queued.isEmpty {
            app.memory.update { $0.rememberSend(governorate: ready.governorate, city: ready.city, tags: ready.tags) }
        }
        if result.submission.error == nil {
            queue.deleteDraft(ready.id)
            dismiss()
            onSent()
        } else {
            submitError = "material.error.create"
            draft = result.submission.draft
            queue.saveDraft(draft)
        }
    }

    // MARK: الإغلاق

    private func requestClose() {
        if changed { confirmClose = true } else { dismiss() }
    }

    /// التجاهل يحذف النسخ المحلية التي أنشأتها هذه الشاشة (لا الأصل في المعرض)، ومسودتها المحفوظة إن وُجدت.
    /// الرفوعات التي دخلت الطابور من قبل لا تتأثر: ملفاتها نسخ أخرى في سجلاتها.
    private func discardAndClose() {
        for file in draft.files { UploadServices.shared.deleteLocalCopy(relativePath: file.relativePath) }
        queue.deleteDraft(draft.id)
        dismiss()
    }

    // MARK: البدء والملفات والنموذج

    /// يملأ ما يُتذكَّر (المكان واسم الظهور) ثم يفتح المعرض مباشرة لإرسال جديد.
    private func start() async {
        guard baseline == nil else { return }
        memory = app.memory.load()
        memory.prefill(&draft)
        baseline = draft
        if opensPicker, draft.files.isEmpty {
            try? await Task.sleep(for: .milliseconds(300))
            showPicker = true
        }
    }

    /// الأصول المختارة من PhotosUI تُنقل ملفاتٍ (`FileRepresentation`) بلا إعادة ترميز ولا تجريد، واحدًا بعد آخر بترتيب الاختيار.
    private func importPicked(_ items: [PhotosPickerItem]) async {
        pickerItems = []
        importing = true
        defer { importing = false }
        var failed = false
        var imported = false
        for item in items {
            guard draft.files.count < MaterialDraft.maxFiles else { break }
            guard let picked = try? await item.loadTransferable(type: PickedFile.self) else { failed = true; continue }
            if let file = try? await FileImport.importFile(picked.url) {
                draft.files.append(file)
                imported = true
            } else {
                failed = true
            }
            try? FileManager.default.removeItem(at: picked.url)
        }
        submitError = failed ? "material.error.import" : nil
        if imported { await suggestLightCopy() }
    }

    /// ملفات تطبيق «الملفات»: الوصول المحمي بالنطاق يبدأ لكل رابط ويُنهى بعد نسخه.
    private func importScoped(_ urls: [URL]) async {
        importing = true
        defer { importing = false }
        var failed = false
        var imported = false
        for url in urls {
            guard draft.files.count < MaterialDraft.maxFiles else { break }
            let scoped = url.startAccessingSecurityScopedResource()
            if let file = try? await FileImport.importFile(url) {
                draft.files.append(file)
                imported = true
            } else {
                failed = true
            }
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
        submitError = failed ? "material.error.import" : nil
        if imported { await suggestLightCopy() }
    }

    /// إزالة ملف من الإرسالة تحذف نسخته المحلية فقط؛ الأصل في المعرض أو الملفات لا يُمس.
    private func remove(_ file: MaterialDraft.PickedFile) {
        UploadServices.shared.deleteLocalCopy(relativePath: file.relativePath)
        draft.files.removeAll { $0.relativePath == file.relativePath }
        // مسودة محفوظة تشير إلى الملف المحذوف؛ تُحدَّث كي لا تبقى بمرجع ميت.
        if draftIsSaved { queue.saveDraft(draft) }
        Task { await suggestLightCopy() }
    }

    /// الاقتراح من أطول فيديو في الإرسالة ويسري على كل فيديوهاتها؛ اختيار المراسل لا يُستبدل.
    private func suggestLightCopy() async {
        guard !draft.lightCopyChosenByReporter else { return }
        guard let longest = draft.longestVideoSeconds else { draft.lightCopy = ProxyChoice.originalOnly.rawValue; return }
        let context = await DeviceConditions.context(isVideo: true, durationSeconds: longest, priority: draft.priority ?? .normal)
        draft.lightCopy = ProxyPolicy.suggest(context).rawValue
    }

    /// آخر نسخة ناجحة من النموذج لكل نوع تُحفظ مؤقتًا؛ بلا شبكة تُستعمل بشارة «إصدار محفوظ»، وإلا فالإرسال ينتظر.
    private func loadForm() async {
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

/// المحافظة والمدينة نصًّا كما في العقد (لا قائمة فيه، ADR 0076)؛ تُتذكَّران بعد أول إرسال. لا إحداثيات.
struct PlaceEditor: View {
    @Binding var governorate: String
    @Binding var city: String
    @Environment(\.dismiss) private var dismiss
    @State private var g = ""
    @State private var c = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: VL.Space.s5) {
                    Text("send.place.help").vlText(.body).foregroundStyle(Color.vl.textSecondary)
                    VLField(label: Text("material.governorate")) {
                        TextField(text: $g, prompt: Text(verbatim: "")) { Text("material.governorate") }.submitLabel(.next)
                    }
                    VLField(label: Text("material.city")) {
                        TextField(text: $c, prompt: Text(verbatim: "")) { Text("material.city") }.submitLabel(.done)
                    }
                    Button("send.place.done") {
                        governorate = g.trimmingCharacters(in: .whitespacesAndNewlines)
                        city = c.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                    }
                    .buttonStyle(.vlSolid)
                    .disabled(g.trimmingCharacters(in: .whitespaces).isEmpty || c.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(VL.Space.s5)
            }
            .vlScreen()
            .navigationTitle("send.place.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("material.cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .onAppear { g = governorate; c = city }
    }
}
