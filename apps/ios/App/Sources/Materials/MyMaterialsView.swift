import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UploadCore

/// «موادي»: ما أرسله المراسل وحالاته الثلاث المستقلة والخط الزمني لكل مادة. بلا إحداثيات ولا أسماء مصادر.
@MainActor
final class MyMaterialsModel: ObservableObject {
    @Published private(set) var items: [PostHistoryAPI.Material] = []
    @Published private(set) var reachedEnd = false
    @Published private(set) var failed = false
    @Published private(set) var loading = false
    /// صفحة تالية في الطريق: «لا مواد بهذا الفلتر» لا تُقال قبل أن تنتهي.
    @Published private(set) var loadingMore = false
    /// آخر تحديث ناجح؛ عند الفشل تبقى البيانات المعروضة مع شريط «غير محدّث منذ …».
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var timelines: [UUID: MaterialTimeline] = [:]
    let feed: MaterialsFeed
    private let transitions: @Sendable (UUID) async throws -> [TransitionRecord]
    /// رابط قراءة موقّع لمشتق (`getMaterialFileDownloadUrl`، ≤ 10 دقائق): يُطلب قبيل الاستعمال، ولا يُحفظ ولا يُسجَّل (ADR 0089).
    let downloadURL: @Sendable (_ materialId: UUID, _ fileId: UUID) async throws -> FileDownloadUrl

    init(feed: MaterialsFeed, transitions: @escaping @Sendable (UUID) async throws -> [TransitionRecord] = { _ in [] },
         downloadURL: @escaping @Sendable (UUID, UUID) async throws -> FileDownloadUrl = { _, _ in throw CancellationError() }) {
        self.feed = feed
        self.transitions = transitions
        self.downloadURL = downloadURL
    }

    /// السحب للتحديث: من الأول، وتسقط الصفحات المحمّلة.
    func refresh() async {
        await update { try await $0.refresh() }
    }

    /// الاستطلاع: الصفحة الأولى تُدمج فوق ما حُمّل (`MaterialsFeed.refreshHead`)، فلا يعود المعرض إلى أوله ولا تُعاد صفحاته.
    func poll() async {
        await update { try await $0.refreshHead() }
    }

    /// الظهور (أول مرة، أو الرجوع من التفاصيل): لا طلب إن كان آخر تحديث قريبًا، وإلا استطلاع لا يمس موضع المراسل.
    func refreshIfStale(maxAge: TimeInterval = 30) async {
        if let lastUpdated, !items.isEmpty, Date().timeIntervalSince(lastUpdated) < maxAge { return }
        await poll()
    }

    private func update(_ fetch: (MaterialsFeed) async throws -> [PostHistoryAPI.Material]) async {
        loading = true
        defer { loading = false }
        do {
            items = try await fetch(feed)
            failed = false
            lastUpdated = Date()
        } catch { failed = true }
        reachedEnd = await feed.reachedEnd
    }

    func loadMore() async {
        loadingMore = true
        defer { loadingMore = false }
        do {
            items = try await feed.loadMore()
            failed = false
        } catch { failed = true }
        reachedEnd = await feed.reachedEnd
    }

    /// يحدّث مادة واحدة (شاشة التفاصيل، أو إشعار عن مادة لم تُحمَّل صفحتها)؛ `nil` إن تعذّر.
    @discardableResult
    func reload(_ id: UUID) async -> PostHistoryAPI.Material? {
        let fresh = try? await feed.reload(id: id)
        items = await feed.items
        return fresh
    }

    func loadTimeline(_ id: UUID) async {
        guard let records = try? await transitions(id) else { return }
        timelines[id] = MaterialTimeline(records)
    }

    func clear() async {
        await feed.clear()
        items = []
        timelines = [:]
        reachedEnd = false
        lastUpdated = nil
    }
}

/// 07 · «موادي» معرضًا لا محادثة (design-brief.md §5.3؛ ADR 0089): شبكة بطاقات `MediaCard` 9:16، الأحدث أولًا، مجمّعة بعنوان
/// التغطية (الافتراضي) أو بنوعها، ورقاقات «الكل · فيديو · صور · عاجل» فوقها، وفلاتر التاريخ والنوع والحالة في ورقة «العرض
/// والتصفية». لكل بطاقة حالاتها الثلاث شاراتٍ منفصلة، والحسّاسة بلا معاينة سحابية (07c). السحب يحدّث، والصفحات تُحمَّل عند
/// بلوغ آخرها. المصغّرات من نسخ الهاتف أو من مشتق `thumbnail` متحقَّق، في الذاكرة وحدها.
struct MyMaterialsView: View {
    @EnvironmentObject private var model: MyMaterialsModel
    @EnvironmentObject private var queue: UploadQueueModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var onNewMaterial: () -> Void = {}

    @AppStorage("materials.grouping") private var groupingRaw = GalleryGrouping.coverage.rawValue
    @State private var filter = GalleryFilter()
    @State private var showOptions = false

    private var grouping: GalleryGrouping { GalleryGrouping(rawValue: groupingRaw) ?? .coverage }

    var body: some View {
        let locals = localOriginals
        let sections = MaterialGallery.sections(model.items, grouping: grouping, filter: filter) { m in
            MaterialMedia.kind(of: m, localMimeType: locals[m.id]?.mimeType)
        }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: VL.Space.s6) {
                VLFilterChips(groupLabel: "gallery.quick.label", options: GalleryQuickFilter.allCases.map { quick in
                    (value: quick, label: Text(LocalizedStringKey("gallery.quick.\(quick.rawValue)")))
                }, selection: $filter.quick)
                notes
                if sections.isEmpty { empty }
                ForEach(sections) { section in
                    sectionView(section, locals: locals)
                }
                if !model.reachedEnd, !model.items.isEmpty {
                    // آخر المعرض: الصفحة التالية بالمؤشر القائم (`MaterialsFeed.loadMore`)؛ ومع فلتر يخفي ما حُمّل تُتابع الصفحات.
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: VL.Size.touchMin)
                        .task(id: model.items.count) { if !model.failed { await model.loadMore() } }
                    if model.failed {
                        Button("materials.loadMore") { Task { await model.loadMore() } }.buttonStyle(.vlGhost)
                    }
                }
            }
            .padding(VL.Space.s5)
        }
        .vlScreen()
        .navigationTitle("materials.title")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                VLIconButton(systemImage: "slider.horizontal.3", label: "gallery.options", badge: filter.sheetCount,
                             badgeValue: Text("gallery.options.active \(filter.sheetCount)")) { showOptions = true }
            }
        }
        // السحب وحده يعيد المعرض إلى أوله؛ الظهور والاستطلاع يدمجان الصفحة الأولى ويبقى الموضع والصفحات المحمّلة.
        .refreshable { await model.refresh() }
        .task {
            await model.refreshIfStale()
            // استطلاع كل 30 ثانية ما دامت الشاشة ظاهرة.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard !Task.isCancelled else { break }
                await model.poll()
            }
        }
        .sheet(isPresented: $showOptions) {
            GalleryOptionsSheet(grouping: Binding(get: { grouping }, set: { groupingRaw = $0.rawValue }), filter: $filter)
        }
    }

    /// أصول المواد التي ما زالت نسخها على الهاتف (قراءة سجلات الطابور وحدها)، بقاعدة `LocalOriginals.find`. السجلات تُفهرس بالمادة
    /// مرة واحدة، فلا يتكرر المرور عليها لكل مادة مع كل حدث تقدّم في الطابور.
    private var localOriginals: [UUID: LocalOriginal] {
        let byMaterial = Dictionary(grouping: queue.records.filter { $0.kind == .original }, by: \.materialId)
        let copies = queue.localCopies
        var out: [UUID: LocalOriginal] = [:]
        for m in model.items {
            guard let records = byMaterial[m.id] else { continue }
            if let found = LocalOriginals.find(for: m, in: records, hasLocalCopy: { copies.contains($0.id) }) { out[m.id] = found }
        }
        return out
    }

    @ViewBuilder private var notes: some View {
        if model.failed, let updated = model.lastUpdated {
            VLNote(tone: .warn, systemImage: "clock.arrow.circlepath",
                   text: Text("materials.stale \(VLFormat.time(updated))"), actionKey: "materials.refresh") {
                Task { await model.refresh() }
            }
        }
        if model.failed, model.lastUpdated == nil {
            VLNote(tone: .warn, systemImage: "wifi.slash", text: Text("materials.loadFailed"))
        }
    }

    /// 07b: مراسل بلا مواد يرى ما سيظهر هنا وزرّ الإرسال؛ ومع فلتر لا يطابق شيئًا يُقال ذلك ويُعرض مسحه، لكن بعد أن ينتهي التحميل
    /// وتُجلب كل الصفحات (أو يتعذّر الجلب)، لا والصفحات التالية في الطريق.
    @ViewBuilder private var empty: some View {
        if model.loading || model.loadingMore {
            EmptyView()
        } else if model.items.isEmpty {
            if !model.failed {
                VLEmptyState(title: "mine.empty.title", message: "mine.empty") {
                    Button("home.send", action: onNewMaterial).buttonStyle(.vlPrimary)
                }
            }
        } else if model.reachedEnd || model.failed {
            VLEmptyState(title: "gallery.filtered.empty", message: "gallery.filtered.hint") {
                Button("gallery.clear") { filter = GalleryFilter() }.buttonStyle(.vlOutline)
            }
        }
    }

    private var columns: [GridItem] {
        if dynamicTypeSize >= .accessibility3 { return [GridItem(.flexible(), alignment: .top)] }
        if dynamicTypeSize.isAccessibilitySize {
            return Array(repeating: GridItem(.flexible(), spacing: VL.Space.s4, alignment: .top), count: 2)
        }
        return [GridItem(.adaptive(minimum: 100, maximum: 220), spacing: VL.Space.s4, alignment: .top)]
    }

    private func sectionView(_ section: GallerySection, locals: [UUID: LocalOriginal]) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                heading(section).vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                subtitle(section).vlText(.caption).foregroundStyle(Color.vl.textSecondary)
            }
            LazyVGrid(columns: columns, alignment: .leading, spacing: VL.Space.s5) {
                ForEach(section.materials, id: \.id) { m in
                    NavigationLink(value: HomeRoute.material(m.id)) {
                        GalleryCell(material: m, local: locals[m.id], showsTitle: grouping == .type)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func heading(_ section: GallerySection) -> Text {
        switch section.heading {
        case .coverage(let title): return Text(verbatim: title)
        case .type(let type?): return Text(LocalizedStringKey("material.type.\(type.rawValue)"))
        case .type(nil): return Text("gallery.section.untyped")
        }
    }

    /// «حدث ميداني · اليوم · 3 مواد» بالعنوان، و«اليوم · 3 مواد» بالنوع.
    private func subtitle(_ section: GallerySection) -> Text {
        let dot = Text(verbatim: " \u{00B7} ")
        let day: Text
        switch GalleryDay.of(section.newest, now: Date(), calendar: .current) {
        case .today: day = Text("gallery.day.today")
        case .yesterday: day = Text("gallery.day.yesterday")
        case .date(let date): day = Text(verbatim: VLFormat.day(date))
        }
        let count = Text("gallery.section.count \(section.materials.count)")
        if grouping == .coverage, let type = section.primaryType {
            return Text(LocalizedStringKey("material.type.\(type.rawValue)")) + dot + day + dot + count
        }
        return day + dot + count
    }
}

/// بطاقة مادة في المعرض: المصغّرة (الهاتف أولًا، ثم `thumbnail` الخادم لغير الحسّاسة) والمدة والحالات الثلاث؛ وقارئ الشاشة يقرأ
/// العنوان والنوع والمدة والحساسية والحالات بالترتيب.
struct GalleryCell: View {
    let material: PostHistoryAPI.Material
    let local: LocalOriginal?
    var showsTitle = false

    @EnvironmentObject private var model: MyMaterialsModel
    @State private var image: Image?
    @State private var localDuration: Double?

    private var kind: MediaKind { MaterialMedia.kind(of: material, localMimeType: local?.mimeType) }
    private var preview: PreviewSource { PlaybackSourcePolicy.thumbnail(for: material, local: local) }

    private var durationSeconds: Double? {
        if let ms = MaterialMedia.durationMs(of: material) { return Double(ms) / 1000 }
        return localDuration
    }

    /// المدة على البطاقة للفيديو وحده، ولا شيء بلا مدة معروفة.
    private var durationText: String? {
        guard kind == .video, let seconds = durationSeconds else { return nil }
        let text = VLFormat.duration(seconds)
        return text.isEmpty ? nil : text
    }

    var body: some View {
        let status = MaterialStatus(material)
        MediaCard(kind: kind == .video ? .video : .photo, thumbnail: image, duration: durationText,
                  status: status, sensitive: material.isSensitive, title: showsTitle ? material.title : nil)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText(status))
            .accessibilityHint(Text("gallery.card.hint"))
            .task(id: preview) { await load() }
    }

    /// الحسّاسة تُحمَّل صغيرة جدًا ثم تُموَّه (`MediaCard`)، فلا تفصيل يُستعاد منها؛ وغيرها بحجم البطاقة.
    private var thumbnailPixels: CGFloat { PlaybackSourcePolicy.conceals(material, revealed: false) ? 48 : 480 }

    private func load() async {
        switch preview {
        case .local(let original):
            image = await ThumbnailCache.shared.image(relativePath: original.relativePath, isVideo: !original.isImage, maxPixel: thumbnailPixels)
            if !original.isImage, MaterialMedia.durationMs(of: material) == nil {
                localDuration = await ThumbnailCache.shared.duration(relativePath: original.relativePath)
            }
        case .remote(let fileId):
            let fetch = model.downloadURL
            let materialId = material.id
            image = await ThumbnailCache.shared.remoteImage(fileId: fileId, maxPixel: thumbnailPixels) { try await fetch(materialId, fileId) }
        case .unavailable:
            image = nil
        }
    }

    private func accessibilityText(_ status: MaterialStatus) -> Text {
        let sep = Text("list.separator")
        var text = Text(verbatim: material.title) + sep + Text(LocalizedStringKey("gallery.kind.\(kind.rawValue)"))
        if kind == .video, let d = durationSeconds, d > 0 { text = text + sep + Text(verbatim: VLFormat.duration(d)) }
        if material.isSensitive { text = text + sep + Text("media.sensitive") }
        for track in MaterialStatus.Track.allCases {
            text = text + sep + Text(LocalizedStringKey(track.labelKey)) + Text(verbatim: ": ") + Text(LocalizedStringKey(status.badge(track).labelKey))
        }
        return text
    }
}

/// ورقة «العرض والتصفية»: التجميع (بعنوان التغطية أو بنوعها)، والتاريخ، ونوع التغطية، والحالة. كل مجموعة رقاقات لها اسم
/// لقارئ الشاشة، والمحدَّد بحبر داكن وسمة «محدَّد».
struct GalleryOptionsSheet: View {
    @Binding var grouping: GalleryGrouping
    @Binding var filter: GalleryFilter
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: VL.Space.s6) {
                    group("gallery.grouping") {
                        VLFilterChips(groupLabel: "gallery.grouping", options: GalleryGrouping.allCases.map { g in
                            (value: g, label: Text(LocalizedStringKey("gallery.grouping.\(g.rawValue)")))
                        }, selection: $grouping)
                    }
                    group("gallery.date") {
                        VLFilterChips(groupLabel: "gallery.date", options: GalleryDateRange.allCases.map { r in
                            (value: r, label: Text(LocalizedStringKey("gallery.date.\(r.rawValue)")))
                        }, selection: $filter.dateRange)
                    }
                    group("gallery.type") {
                        VLFilterChips(groupLabel: "gallery.type", options: typeOptions, selection: $filter.coverageType)
                    }
                    group("gallery.state") {
                        VLFilterChips(groupLabel: "gallery.state", options: stateOptions, selection: $filter.state)
                    }
                    if filter.sheetCount > 0 {
                        Button("gallery.clear") {
                            filter.dateRange = .any
                            filter.coverageType = nil
                            filter.state = nil
                        }
                        .buttonStyle(.vlOutline)
                    }
                }
                .padding(VL.Space.s5)
            }
            .vlScreen()
            .navigationTitle("gallery.options")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("gallery.done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var typeOptions: [(value: MaterialType?, label: Text)] {
        var options: [(value: MaterialType?, label: Text)] = [(value: nil, label: Text("gallery.type.any"))]
        for type in MaterialType.allCases where type != .unknownDefaultOpenApi {
            options.append((value: type, label: Text(LocalizedStringKey("material.type.\(type.rawValue)"))))
        }
        return options
    }

    private var stateOptions: [(value: GalleryStateFilter?, label: Text)] {
        var options: [(value: GalleryStateFilter?, label: Text)] = [(value: nil, label: Text("gallery.state.any"))]
        for state in GalleryStateFilter.allCases {
            options.append((value: state, label: Text(LocalizedStringKey("gallery.state.\(state.rawValue)"))))
        }
        return options
    }

    private func group<Content: View>(_ title: LocalizedStringKey, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            VLSectionHeader(title)
            content()
        }
    }
}
