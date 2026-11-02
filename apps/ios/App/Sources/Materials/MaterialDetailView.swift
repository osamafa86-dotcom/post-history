import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UploadCore

/// 08 · تفاصيل المادة (reporter-v2.md «موادي»؛ ADR 0089): المعاينة والمشغّل، والعنوان وسطر المكان والتاريخ والمدة والنوع، والحالات
/// الثلاث كلٌّ بكلمات بسيطة ومنذ متى، وملاحظة المشرف، والإجراءات («تشغيل ملء الشاشة»، «رفع لقطة بديلة»، «عرض الإيصال»)، ثم نوع
/// التغطية والوسوم (قراءة فقط) والمكان ووقت التصوير والإرسال وأرقام الإيصال، والملفات بحالة رفع كلٍّ على الخادم وعلى الهاتف، والخط
/// الزمني. لا إحداثيات ولا اسم مصدر، ولا مشاركة ولا تصدير.
struct MaterialDetailView: View {
    let materialId: UUID

    @EnvironmentObject private var model: MyMaterialsModel
    @EnvironmentObject private var queue: UploadQueueModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var player = PlayerModel()
    @State private var replacing: PostHistoryAPI.Material?
    @State private var loadFailed = false
    @State private var fullscreen = false
    /// المادة الحسّاسة: لا تُطلب صورتها من الخادم إلا بلمسة «عرض الصورة».
    @State private var stillRequested = false
    @State private var poster: Image?
    @State private var still: Image?
    /// تعذّر جلب الصورة أو قراءتها: حالة خطأ بزرّ «أعد المحاولة» لا مؤشر انتظار بلا نهاية.
    @State private var stillFailed = false
    @State private var stillAttempt = 0
    @State private var localDuration: Double?
    @State private var trackFilter: MaterialStatus.Track?
    /// آخر نسخة معروفة: تحديث المعرض يعيد القائمة إلى صفحتها الأولى، فلا تختفي مادة من صفحة أبعد وهي مفتوحة.
    @State private var snapshot: PostHistoryAPI.Material?

    private var material: PostHistoryAPI.Material? { model.items.first { $0.id == materialId } ?? snapshot }

    /// أصل المادة على الهاتف بما وصل الخادم (`LocalOriginals.find`)، لا أحدث سجل؛ فلا تُعرض لقطة بديلة ردّها الخادم.
    private var local: LocalOriginal? {
        guard let material else { return nil }
        let copies = queue.localCopies
        return LocalOriginals.find(for: material, in: queue.records) { copies.contains($0.id) }
    }

    private var playbackSource: PlaybackSource {
        material.map { PlaybackSourcePolicy.player(for: $0, local: local) } ?? .unavailable
    }

    /// بديل `hls` إن فشل: النسخة الخفيفة المتحقَّقة، مرة واحدة.
    private var fallbackSource: PlaybackSource? {
        material.flatMap { PlaybackSourcePolicy.fallback(after: playbackSource, for: $0) }
    }

    /// ما يُبلَّغ به المشغّل: المصدر وبديله معًا، فتحقّقُ نسخة خفيفة بعد اختيار `hls` يصل المشغّل ولو لم يتغيّر المصدر.
    private struct PlaybackRequest: Equatable {
        let source: PlaybackSource
        let fallback: PlaybackSource?
    }

    private var playbackRequest: PlaybackRequest { PlaybackRequest(source: playbackSource, fallback: fallbackSource) }

    private var knownDuration: Double? {
        material.flatMap(MaterialMedia.durationMs).map { Double($0) / 1000 } ?? localDuration
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VL.Space.s5) {
                if let m = material {
                    content(m)
                } else if loadFailed {
                    VLNote(tone: .warn, systemImage: "wifi.slash", text: Text("detail.loadFailed"), actionKey: "materials.refresh") {
                        Task { await load() }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                        .accessibilityLabel(Text("detail.loading"))
                }
            }
            .padding(VL.Space.s5)
        }
        .vlScreen()
        .navigationTitle("detail.title")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            await load()
            // استطلاع كل 30 ثانية ما دامت الشاشة ظاهرة: تتحدث الحالات، ويظهر المشتق حين يجهز.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard !Task.isCancelled else { break }
                await load()
            }
        }
        .onChange(of: playbackRequest, initial: true) { _, request in configurePlayer(request) }
        .onChange(of: localDuration) { _, _ in configurePlayer(playbackRequest) }
        .onChange(of: scenePhase) { _, phase in if phase != .active { player.pause() } }
        // ملء الشاشة غطاء فوق التفاصيل: لا يوقف التشغيل؛ مغادرة التفاصيل توقفه وتمحو الرابط.
        .onDisappear { if !fullscreen { player.stop() } }
        .sheet(item: $replacing) { m in ReplaceShotView(material: m) }
        .fullScreenCover(isPresented: $fullscreen) {
            FullscreenPlayer(model: player, title: material?.title ?? "")
        }
    }

    private func load() async {
        if let fresh = await model.reload(materialId) { snapshot = fresh }
        loadFailed = material == nil
        await model.loadTimeline(materialId)
    }

    private func configurePlayer(_ request: PlaybackRequest) {
        let fetch = model.downloadURL
        let id = materialId
        player.configure(source: request.source, fallback: request.fallback, knownDurationSeconds: knownDuration) { fileId in
            try await fetch(id, fileId)
        }
    }

    @ViewBuilder private func content(_ m: PostHistoryAPI.Material) -> some View {
        let kind = MaterialMedia.kind(of: m, localMimeType: local?.mimeType)
        let status = MaterialStatus(m)
        Group {
            if kind == .photo { stillView(m) } else { videoView(m) }
        }
        header(m, kind: kind)
        if let note = model.timelines[m.id]?.supervisorNote(for: m) {
            VLNote(tone: .warn, systemImage: "pencil", text: Text("materials.supervisorNote \(note.reason)"))
        }
        statesCard(m, status: status)
        actions(m, kind: kind)
        facts(m, status: status)
        files(m)
        timeline(m)
    }

    // MARK: المعاينة

    @ViewBuilder private func videoView(_ m: PostHistoryAPI.Material) -> some View {
        if player.phase == .idle {
            posterView(m)
        } else {
            InlinePlayer(model: player) { fullscreen = true }
        }
    }

    /// قبل التشغيل: صورة من نسخة الهاتف أو مصغّرة الخادم، وزرّ «تشغيل»؛ أو «قيد المعالجة» صريحة إن لم يوجد ما يُشغَّل. الحسّاسة
    /// مموّهة صغيرة تحت علامتها أيًّا كان مصدرها، و«تشغيل» هو الكشف (`PlaybackSourcePolicy.conceals`).
    private func posterView(_ m: PostHistoryAPI.Material) -> some View {
        let source = PlaybackSourcePolicy.thumbnail(for: m, local: local)
        let concealed = PlaybackSourcePolicy.conceals(m, revealed: false)
        return ZStack {
            Color.vl.bgStore
            if let poster {
                if concealed {
                    poster.resizable().scaledToFill().blur(radius: VL.Space.s5, opaque: true).accessibilityHidden(true)
                    Color.vl.bgStore.opacity(0.5)
                } else {
                    poster.resizable().scaledToFit()
                }
            }
            if player.canPlay {
                VStack(spacing: VL.Space.s4) {
                    if concealed { sensitiveNote }
                    Button { player.play() } label: {
                        Image(systemName: "play.fill")
                            .font(.title.weight(.semibold))
                            .foregroundStyle(Color.vl.bgStore)
                            .frame(width: VL.Space.s11, height: VL.Space.s11)
                            .background(Color.vl.textOnStore, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("player.play"))
                }
            } else {
                processingNote
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .environment(\.colorScheme, .dark)
        .task(id: source) {
            switch source {
            case .local(let original):
                poster = await ThumbnailCache.shared.image(relativePath: original.relativePath, isVideo: true, maxPixel: concealed ? 48 : 900)
                if MaterialMedia.durationMs(of: m) == nil {
                    localDuration = await ThumbnailCache.shared.duration(relativePath: original.relativePath)
                }
            case .remote(let fileId):
                let fetch = model.downloadURL
                let id = m.id
                poster = await ThumbnailCache.shared.remoteImage(fileId: fileId, maxPixel: concealed ? 48 : 900) { try await fetch(id, fileId) }
            case .unavailable:
                poster = nil
            }
        }
    }

    /// طلب الصورة: مصدرها ورقم المحاولة («أعد المحاولة» تعيد الجلب).
    private struct StillRequest: Equatable {
        let source: PreviewSource
        let attempt: Int
    }

    /// مادة صورة: الأصل على الهاتف، أو نسخة الخادم. الحسّاسة مموّهة صغيرة تحت علامتها حتى «عرض الصورة» أيًّا كان مصدرها. الصورة
    /// الكبيرة لا تُخزَّن في ذاكرة المصغّرات، وتعذّر جلبها أو قراءتها حالة خطأ بزرّ «أعد المحاولة» لا انتظار بلا نهاية.
    private func stillView(_ m: PostHistoryAPI.Material) -> some View {
        let source = PlaybackSourcePolicy.still(for: m, local: local, requested: stillRequested)
        let concealed = PlaybackSourcePolicy.conceals(m, revealed: stillRequested)
        let canReveal = concealed && PlaybackSourcePolicy.still(for: m, local: local, requested: true) != .unavailable
        let blurredSource: PreviewSource = concealed ? PlaybackSourcePolicy.thumbnail(for: m, local: local) : .unavailable
        return VStack(alignment: .leading, spacing: VL.Space.s2) {
            ZStack {
                Color.vl.bgStore
                if canReveal {
                    if let poster {
                        poster.resizable().scaledToFill().blur(radius: VL.Space.s5, opaque: true).accessibilityHidden(true)
                        Color.vl.bgStore.opacity(0.5)
                    }
                    VStack(spacing: VL.Space.s4) {
                        sensitiveNote
                        Button("detail.action.show") { stillRequested = true }.buttonStyle(.vlOutlineSmall)
                    }
                } else if let still {
                    still.resizable().scaledToFit()
                        .accessibilityLabel(Text(verbatim: m.title))
                } else if stillFailed {
                    VStack(spacing: VL.Space.s3) {
                        Image(systemName: "exclamationmark.triangle").font(.title2).accessibilityHidden(true)
                        Text("detail.still.failed").vlText(.body).multilineTextAlignment(.center)
                        Button("player.retry") { stillAttempt += 1 }.buttonStyle(.vlOutlineSmall)
                    }
                    .foregroundStyle(Color.vl.textOnStore)
                    .padding(VL.Space.s5)
                } else if source == .unavailable {
                    processingNote
                } else {
                    ProgressView().tint(Color.vl.textOnStore)
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
            .environment(\.colorScheme, .dark)
            if still != nil, !canReveal {
                Text(LocalizedStringKey(local != nil ? "detail.still.original" : "detail.still.server"))
                    .vlText(.caption).foregroundStyle(Color.vl.textSecondary)
            }
        }
        .task(id: StillRequest(source: source, attempt: stillAttempt)) {
            stillFailed = false
            switch source {
            case .local(let original):
                let url = UploadServices.shared.documentsDirectory.appendingPathComponent(original.relativePath)
                still = await MediaImages.downsample(fileURL: url, maxPixel: 1600).map { Image(decorative: $0, scale: 1) }
                stillFailed = still == nil
            case .remote(let fileId):
                let fetch = model.downloadURL
                let id = m.id
                // للعرض وحده: الصورة في حالة الشاشة، لا في ذاكرة المصغّرات.
                guard let lease = (try? await fetch(id, fileId)).flatMap({ SignedURLLease($0) }),
                      let data = await MediaImages.data(lease.url),
                      let image = await MediaImages.downsample(data: data, maxPixel: 1600) else {
                    still = nil
                    stillFailed = !Task.isCancelled
                    return
                }
                still = Image(decorative: image, scale: 1)
            case .unavailable:
                still = nil
            }
        }
        // ما يظهر مموّهًا قبل الكشف: مصغّرة الهاتف وحدها، صغيرة جدًا.
        .task(id: blurredSource) {
            if case .local(let original) = blurredSource {
                poster = await ThumbnailCache.shared.image(relativePath: original.relativePath, isVideo: false, maxPixel: 48)
            } else {
                poster = nil
            }
        }
    }

    private var sensitiveNote: some View {
        VStack(spacing: VL.Space.s2) {
            Image(systemName: "shield").font(.title2)
            Text("media.sensitive.noCloud").vlText(.label)
            Text("media.sensitive.local").vlText(.caption)
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(Color.vl.textOnStore)
        .padding(VL.Space.s5)
        .accessibilityElement(children: .combine)
    }

    /// المكان الوحيد الذي يقول لماذا لا يُشغَّل شيء: لا نسخة على الهاتف ولا مشتق جاهز على الخادم (خادم التجربة بلا عامل وسائط).
    private var processingNote: some View {
        VStack(spacing: VL.Space.s3) {
            Image(systemName: "hourglass").font(.title2).accessibilityHidden(true)
            Text("detail.placeholder.title").vlText(.headline)
            Text("detail.placeholder.body").vlText(.body)
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(Color.vl.textOnStore)
        .padding(VL.Space.s5)
        .accessibilityElement(children: .combine)
    }

    // MARK: الرأس والحالات

    private func header(_ m: PostHistoryAPI.Material, kind: MediaKind) -> some View {
        let dot = Text(verbatim: " \u{00B7} ")
        var meta = Text(verbatim: m.governorate) + dot + Text(verbatim: VLFormat.day(m.shotAt ?? m.createdAt))
        if kind == .video, let d = knownDuration, d > 0 { meta = meta + dot + Text(verbatim: VLFormat.duration(d)) }
        meta = meta + dot + Text(LocalizedStringKey("gallery.kind.\(kind.rawValue)"))
        return VStack(alignment: .leading, spacing: VL.Space.s2) {
            Text(verbatim: m.title).vlText(.title).foregroundStyle(Color.vl.textPrimary).accessibilityAddTraits(.isHeader)
            meta.vlText(.label).foregroundStyle(Color.vl.textSecondary)
            if m.priority != .normal || m.isSensitive {
                HStack(spacing: VL.Space.s4) {
                    PriorityBadge(priority: m.priority)
                    if m.isSensitive { StateBadge(labelKey: "media.sensitive", tone: .warn, systemImage: "shield") }
                }
            }
        }
    }

    /// الحالات الثلاث كما في 08: اسم المسار وشرحه بكلمات بسيطة و«منذ» آخر انتقال عليه، وشارته بأيقونة وكلمة. لمس صفٍّ يصفّي الخط
    /// الزمني بمساره.
    private func statesCard(_ m: PostHistoryAPI.Material, status: MaterialStatus) -> some View {
        VLCard {
            VLSectionHeader("detail.states")
            ForEach(MaterialStatus.Track.allCases, id: \.self) { track in
                Button { trackFilter = trackFilter == track ? nil : track } label: { stateRow(m, track: track, status: status) }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("timeline.filter.hint"))
                    .accessibilityAddTraits(trackFilter == track ? [.isSelected] : [])
                if track != .rights { Divider().overlay(Color.vl.borderLine) }
            }
        }
    }

    private func stateRow(_ m: PostHistoryAPI.Material, track: MaterialStatus.Track, status: MaterialStatus) -> some View {
        let badge = status.badge(track)
        let tone = VLTone(MaterialStatus.signalTone(badge.tone, track: track))
        var explanation = Text(LocalizedStringKey(MaterialStatus.explanationKey(track, of: m)))
        if let since = model.timelines[m.id]?.latest(track)?.occurredAt {
            explanation = explanation + Text(verbatim: " \u{00B7} ") + Text("detail.since \(VLFormat.time(since))")
        }
        let texts = VStack(alignment: .leading, spacing: VL.Space.s1) {
            Text(LocalizedStringKey("detail.track.\(track.rawValue)")).vlText(.headline).foregroundStyle(Color.vl.textPrimary)
            explanation.vlText(.caption).foregroundStyle(Color.vl.textSecondary)
        }
        let mark = StateBadge(labelKey: badge.labelKey, tone: tone, systemImage: track.systemImage(tone))
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: VL.Space.s3) {
                texts
                Spacer(minLength: VL.Space.s3)
                mark
            }
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                texts
                mark
            }
        }
        .frame(minHeight: VL.Size.touchMin)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // MARK: الإجراءات

    @ViewBuilder private func actions(_ m: PostHistoryAPI.Material, kind: MediaKind) -> some View {
        let replace = m.editorialState == .needsChanges || m.technicalState == .failed
        let receipt = m.technicalState == .verified || m.technicalState == .originalReceived
        VStack(spacing: VL.Space.s3) {
            if kind == .video, player.canPlay {
                Button { player.play(); fullscreen = true } label: { Label("detail.action.playFullscreen", systemImage: "play.rectangle") }
                    .buttonStyle(.vlSolid)
            }
            if replace {
                // «الرد على المشرف» مخفي: العقد لا يحمل انتقالًا للرد (قرار للمنسّق، المواصفة A4).
                Button { replacing = m } label: { Label("a4.replaceShot", systemImage: "arrow.triangle.2.circlepath.camera") }
                    .buttonStyle(.vlOutline)
            }
            if receipt {
                // السجل المتحقَّق أو المطابَق، لا أول سجل: الإيصال لا يعرض حذف النسخة لغيره (`LocalCopyPolicy`).
                Button {
                    queue.showReceipt(materialId: m.id, recordId: LocalCopyPolicy.receiptRecord(forMaterial: m.id, in: queue.records)?.id)
                } label: { Label("a4.showReceipt", systemImage: "doc.text") }
                    .buttonStyle(.vlOutline)
            }
        }
    }

    // MARK: البيانات

    private func facts(_ m: PostHistoryAPI.Material, status: MaterialStatus) -> some View {
        var seen = Set<String>()
        let receipts = m.files.compactMap { ($0.receiptNumber ?? "").isEmpty ? nil : $0.receiptNumber }.filter { seen.insert($0).inserted }
        let types = MaterialType.allCases.filter { $0 != .unknownDefaultOpenApi && m.materialTypes.contains($0) }
        return VLCard {
            factRow("detail.field.types") {
                if types.isEmpty {
                    Text("gallery.section.untyped")
                } else {
                    types.dropFirst().reduce(Text(LocalizedStringKey("material.type.\(types[0].rawValue)"))) { text, type in
                        text + Text("list.separator") + Text(LocalizedStringKey("material.type.\(type.rawValue)"))
                    }
                }
            }
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                VLFieldLabel(text: Text("detail.field.tags"))
                let tags = (m.tags ?? []).sorted()
                if tags.isEmpty {
                    Text("detail.tags.none").vlText(.body).foregroundStyle(Color.vl.textSecondary)
                } else {
                    VLFlow(spacing: VL.Space.s2) {
                        ForEach(tags, id: \.self) { tag in
                            Text(verbatim: tag)
                                .vlText(.label)
                                .foregroundStyle(Color.vl.textPrimary)
                                .padding(.horizontal, VL.Space.s4)
                                .padding(.vertical, VL.Space.s2)
                                .background(Color.vl.bgSunken, in: RoundedRectangle(cornerRadius: VL.Radius.chip, style: .continuous))
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            factRow("material.detail.place") { Text(verbatim: "\(m.governorate) \u{00B7} \(m.city)") }
            if let shot = m.shotAt {
                factRow("material.detail.shotAt") { Text(verbatim: VLFormat.time(shot)).environment(\.layoutDirection, .leftToRight) }
            }
            factRow("material.detail.sentAt") { Text(verbatim: VLFormat.time(m.createdAt)).environment(\.layoutDirection, .leftToRight) }
            factRow(receipts.count > 1 ? "detail.field.receipts" : "material.detail.receipt") {
                if receipts.isEmpty {
                    Text("material.detail.noReceipt")
                } else {
                    VStack(alignment: .leading, spacing: VL.Space.s1) {
                        ForEach(receipts, id: \.self) { number in
                            Text(verbatim: number).vlText(.receipt).textSelection(.enabled).environment(\.layoutDirection, .leftToRight)
                        }
                    }
                }
            }
        }
    }

    private func factRow<Value: View>(_ label: LocalizedStringKey, @ViewBuilder value: () -> Value) -> some View {
        let shown = value().vlText(.body).foregroundStyle(Color.vl.textPrimary)
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: VL.Space.s4) {
                Text(label).vlText(.label).foregroundStyle(Color.vl.textSecondary)
                Spacer(minLength: VL.Space.s3)
                shown
            }
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                Text(label).vlText(.label).foregroundStyle(Color.vl.textSecondary)
                shown
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: الملفات

    private func files(_ m: PostHistoryAPI.Material) -> some View {
        let rows = MaterialFileList.rows(m.files)
        let onPhone = queue.records.filter { $0.materialId == m.id }.sorted { $0.createdAt > $1.createdAt }
        return VLCard {
            VLSectionHeader("material.detail.files")
            VLFieldLabel(text: Text("detail.files.onServer"))
            if rows.isEmpty {
                Text("detail.files.empty").vlText(.body).foregroundStyle(Color.vl.textSecondary)
            }
            ForEach(rows) { row in serverFileRow(row) }
            if !onPhone.isEmpty {
                Divider().overlay(Color.vl.borderLine)
                VLFieldLabel(text: Text("detail.files.onPhone"))
                ForEach(onPhone, id: \.id) { rec in phoneFileRow(rec) }
            }
        }
    }

    private func serverFileRow(_ row: MaterialFileRow) -> some View {
        let name: Text = {
            switch row.quality {
            case .lightCopy?, .adaptive?: return PlayerFormat.quality(row.quality!)
            default: return Text(LocalizedStringKey(row.kindKey))
            }
        }()
        var facts: [String] = []
        if let size = row.sizeBytes, size > 0 { facts.append(VLFormat.bytes(Int64(size))) }
        if let ms = row.durationMs, ms > 0 { facts.append(VLFormat.duration(Double(ms) / 1000)) }
        let tone = VLTone(row.tone)
        let mark = StateBadge(labelKey: row.stateKey, tone: tone, systemImage: Self.fileStateImage(row.stateKey))
        let texts = VStack(alignment: .leading, spacing: VL.Space.s1) {
            name.vlText(.body).foregroundStyle(Color.vl.textPrimary)
            if !facts.isEmpty {
                Text(verbatim: facts.joined(separator: " \u{00B7} ")).vlText(.num).foregroundStyle(Color.vl.textSecondary)
                    .environment(\.layoutDirection, .leftToRight)
            }
        }
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: VL.Space.s3) {
                texts
                Spacer(minLength: VL.Space.s3)
                mark
            }
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                texts
                mark
            }
        }
        .accessibilityElement(children: .combine)
    }

    static func fileStateImage(_ key: String) -> String {
        switch key {
        case "material.fileState.verified": return "checkmark"
        case "material.fileState.failed": return "exclamationmark.triangle"
        case "material.fileState.received": return "checkmark.seal"
        case "material.fileState.uploading": return "arrow.up.circle"
        default: return "questionmark.circle"
        }
    }

    /// ملف على الهاتف: نوعه ومرحلة رفعه (ونسبته أثناء النقل)، وهل نسخته باقية على الهاتف. قراءة فقط؛ الإجراءات في شاشة الرفع.
    private func phoneFileRow(_ rec: UploadRecord) -> some View {
        let kindKey: LocalizedStringKey = {
            switch rec.kind {
            case .original: return "material.file.original"
            case .proxy: return "material.file.proxy"
            case .voiceNote: return "material.file.voiceNote"
            default: return "material.file.other"
            }
        }()
        let item = queue.item(rec)
        let status = UploadRowStatus.make(item, network: queue.networkState)
        let kept = queue.localCopies.contains(rec.id)
        return VStack(alignment: .leading, spacing: VL.Space.s1) {
            Text(kindKey).vlText(.body).foregroundStyle(Color.vl.textPrimary)
            HStack(spacing: VL.Space.s2) {
                if let percent = status.percent {
                    Text(verbatim: VLFormat.percent(percent)).vlText(.num).environment(\.layoutDirection, .leftToRight)
                } else {
                    if let image = status.systemImage { Image(systemName: image).imageScale(.small).accessibilityHidden(true) }
                    Text(rec.phase.labelKey).vlText(.label)
                }
            }
            .foregroundStyle(status.tone.color)
            Label { Text(LocalizedStringKey(kept ? "detail.files.localCopy" : "detail.files.noLocalCopy")).vlText(.caption) } icon: {
                Image(systemName: kept ? "iphone" : "iphone.slash").imageScale(.small)
            }
            .labelStyle(VLCompactLabelStyle())
            .foregroundStyle(Color.vl.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: الخط الزمني

    private func timeline(_ m: PostHistoryAPI.Material) -> some View {
        let timeline = model.timelines[m.id]
        return VStack(alignment: .leading, spacing: VL.Space.s3) {
            HStack {
                VLSectionHeader("timeline.title")
                Spacer()
                if let track = trackFilter {
                    Button { trackFilter = nil } label: { Label(LocalizedStringKey(track.labelKey), systemImage: "xmark.circle.fill") }
                        .buttonStyle(.vlGhost)
                        .accessibilityLabel(Text("timeline.filter.clear"))
                }
            }
            if let timeline {
                let events = timeline.filtered(trackFilter.map(Self.apiTrack))
                if events.isEmpty { Text("timeline.empty").vlText(.body).foregroundStyle(Color.vl.textSecondary) }
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    TimelineEventRow(event: event, isLast: index == events.count - 1)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    static func apiTrack(_ t: MaterialStatus.Track) -> TransitionRecord.Track {
        switch t {
        case .technical: return .technical
        case .editorial: return .editorial
        case .rights: return .rights
        }
    }
}

extension MaterialStatus.Track {
    init?(_ track: TransitionRecord.Track) {
        switch track {
        case .technical: self = .technical
        case .editorial: self = .editorial
        case .rights: self = .rights
        default: return nil
        }
    }

    /// أيقونة المسار في الخط الزمني.
    var trackImage: String {
        switch self {
        case .technical: return "film"
        case .editorial: return "pencil"
        case .rights: return "key"
        }
    }
}

/// حدث في الخط الزمني: أيقونة المسار، نقطة وخط، نص الحالة ووقتها. لا يعتمد على اللون وحده.
struct TimelineEventRow: View {
    let event: TransitionRecord
    let isLast: Bool

    var body: some View {
        let track = MaterialStatus.Track(event.track) ?? .technical
        HStack(alignment: .top, spacing: VL.Space.s3) {
            VStack(spacing: VL.Space.s1) {
                Circle().fill(Color.vl.actionPrimary).frame(width: VL.Space.s4, height: VL.Space.s4)
                if !isLast { Rectangle().fill(Color.vl.borderLine).frame(width: VL.Border.field).frame(maxHeight: .infinity) }
            }
            .frame(width: VL.Space.s4)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                Label { Text(LocalizedStringKey(MaterialTimeline.labelKey(event))).vlText(.body).foregroundStyle(Color.vl.textPrimary) } icon: {
                    Image(systemName: track.trackImage).foregroundStyle(Color.vl.textSecondary)
                }
                Text(verbatim: VLFormat.time(event.occurredAt))
                    .vlText(.num).foregroundStyle(Color.vl.textSecondary)
                    .environment(\.layoutDirection, .leftToRight)
            }
            .padding(.bottom, VL.Space.s3)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(LocalizedStringKey(track.labelKey)) + Text(verbatim: ": ") + Text(LocalizedStringKey(MaterialTimeline.labelKey(event))))
    }
}
