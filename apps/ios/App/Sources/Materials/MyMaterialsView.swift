import MaterialsCore
import PostHistoryAPI
import SwiftUI

/// «موادي»: ما أرسله المراسل وحالاته الثلاث المستقلة والخط الزمني لكل مادة. بلا إحداثيات ولا أسماء مصادر.
@MainActor
final class MyMaterialsModel: ObservableObject {
    @Published private(set) var items: [PostHistoryAPI.Material] = []
    @Published private(set) var reachedEnd = false
    @Published private(set) var failed = false
    @Published private(set) var loading = false
    /// آخر تحديث ناجح؛ عند الفشل تبقى البيانات المعروضة مع شريط «غير محدّث منذ …».
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var timelines: [UUID: MaterialTimeline] = [:]
    let feed: MaterialsFeed
    private let transitions: @Sendable (UUID) async throws -> [TransitionRecord]

    init(feed: MaterialsFeed, transitions: @escaping @Sendable (UUID) async throws -> [TransitionRecord] = { _ in [] }) {
        self.feed = feed
        self.transitions = transitions
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            items = try await feed.refresh()
            failed = false
            lastUpdated = Date()
        } catch { failed = true }
        reachedEnd = await feed.reachedEnd
    }

    func loadMore() async {
        do { items = try await feed.loadMore() } catch { failed = true }
        reachedEnd = await feed.reachedEnd
    }

    func reload(_ id: UUID) async {
        _ = try? await feed.reload(id: id)
        items = await feed.items
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

/// A4 · موادي — الخط الزمني (docs/design/specs/reporter.md).
struct MyMaterialsView: View {
    enum Tab: Hashable { case all, needsAction }

    @EnvironmentObject private var model: MyMaterialsModel
    @EnvironmentObject private var queue: UploadQueueModel
    @Binding var focus: UUID?
    var onNewMaterial: () -> Void = {}

    @State private var tab: Tab = .all
    @State private var expanded: UUID?
    @State private var trackFilter: [UUID: VLTrack] = [:]
    @State private var replacing: PostHistoryAPI.Material?

    private var visible: [PostHistoryAPI.Material] { tab == .all ? model.items : model.items.filter(\.needsAction) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VL.Space.s4) {
                tabs
                if model.failed, let updated = model.lastUpdated { staleBanner(updated) }
                if model.failed, model.lastUpdated == nil { VLInlineAlert(tone: .attention, systemImage: "wifi.slash", textKey: "materials.loadFailed") }
                if visible.isEmpty, !model.loading, !model.failed { emptyState }
                ForEach(visible, id: \.id) { m in
                    if expanded == m.id { expandedCard(m) } else { collapsedCard(m) }
                }
                if !model.reachedEnd, !model.items.isEmpty {
                    Button("materials.loadMore") { Task { await model.loadMore() } }.buttonStyle(.vlGhost)
                }
            }
            .padding(VL.Space.s5)
        }
        .vlScreen()
        .refreshable { await model.refresh() }
        .task {
            await model.refresh()
            if expanded == nil { expanded = focus ?? model.items.first?.id }
            // استطلاع كل 30 ثانية ما دامت الشاشة ظاهرة.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await model.refresh()
                if let expanded { await model.loadTimeline(expanded) }
            }
        }
        .task(id: expanded) { if let expanded { await model.loadTimeline(expanded) } }
        .onChange(of: focus) { _, id in if let id { tab = .all; expanded = id } }
        .sheet(item: $replacing) { m in NewMaterialFlow(replacing: m) }
    }

    private var tabs: some View {
        HStack(spacing: VL.Space.s3) {
            tabChip(.all, "materials.tab.all", count: model.items.count)
            tabChip(.needsAction, "materials.tab.needsAction", count: model.items.filter(\.needsAction).count)
        }
    }

    private func tabChip(_ t: Tab, _ key: String, count: Int) -> some View {
        let selected = tab == t
        return Button { withAnimation(VL.Easing.standard(VL.Duration.base)) { tab = t } } label: {
            Text("materials.tab.count \(Text(LocalizedStringKey(key))) \(count)")
                .vlText(.labelMd)
                .padding(.horizontal, VL.Space.s4)
                .frame(minHeight: VL.Size.touchMin)
                .foregroundStyle(selected ? Color.vl.textOnBrand : Color.vl.textPrimary)
                .background(selected ? Color.vl.bgBrand : Color.vl.bgSurface, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? Color.clear : Color.vl.borderDefault, lineWidth: VL.Border.hairline))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func staleBanner(_ updated: Date) -> some View {
        HStack {
            Label { Text("materials.stale \(updated.formatted(date: .omitted, time: .shortened))").vlText(.bodySm) } icon: { Image(systemName: "clock.arrow.circlepath") }
                .foregroundStyle(Color.vl.toneAttentionFg)
            Spacer()
            Button("materials.refresh") { Task { await model.refresh() } }.buttonStyle(.vlGhost)
        }
        .padding(VL.Space.s3)
        .background(Color.vl.toneAttentionBg, in: RoundedRectangle(cornerRadius: VL.Radius.md))
    }

    private var emptyState: some View {
        VStack(spacing: VL.Space.s4) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(Color.vl.iconMuted).accessibilityHidden(true)
            Text("materials.empty").vlText(.bodyMd).foregroundStyle(Color.vl.textSecondary)
            Button("material.new", action: onNewMaterial).buttonStyle(.vlPrimary)
        }
        .padding(VL.Space.s8)
        .frame(maxWidth: .infinity)
    }

    private func collapsedCard(_ m: PostHistoryAPI.Material) -> some View {
        Button { withAnimation(VL.Easing.standard(VL.Duration.base)) { expanded = m.id } } label: {
            VLCard {
                HStack(alignment: .top) {
                    Text(verbatim: m.title).vlText(.headingH4).foregroundStyle(Color.vl.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    PriorityBadge(priority: m.priority)
                }
                ThreeStateBadges(status: MaterialStatus(m))
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("materials.expand.hint"))
    }

    private func expandedCard(_ m: PostHistoryAPI.Material) -> some View {
        let status = MaterialStatus(m)
        let timeline = model.timelines[m.id]
        return VLCard(border: .vl.borderStrong) {
            HStack(alignment: .top) {
                Text(verbatim: m.title).vlText(.headingH4).foregroundStyle(Color.vl.textPrimary)
                Spacer(minLength: 0)
                PriorityBadge(priority: m.priority)
            }
            ThreeStateBadges(status: status) { track in
                trackFilter[m.id] = trackFilter[m.id] == track ? nil : track
            }
            if let note = timeline?.supervisorNote(for: m) {
                VStack(alignment: .leading, spacing: VL.Space.s2) {
                    Label { Text(note.occurredAt.formatted(date: .abbreviated, time: .shortened)).vlText(.captionMd) } icon: { Image(systemName: "pencil") }
                        .foregroundStyle(Color.vl.toneAttentionFg)
                    Text(verbatim: note.reason).vlText(.bodySm).foregroundStyle(Color.vl.textPrimary)
                }
                .padding(VL.Space.s4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.vl.toneAttentionBg, in: RoundedRectangle(cornerRadius: VL.Radius.md))
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text("materials.supervisorNote \(note.reason)"))
            }
            timelineView(m, timeline)
            primaryAction(m)
        }
    }

    @ViewBuilder private func timelineView(_ m: PostHistoryAPI.Material, _ timeline: MaterialTimeline?) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            HStack {
                VLOverline("timeline.title")
                Spacer()
                if let track = trackFilter[m.id] {
                    Button { trackFilter[m.id] = nil } label: { Label(LocalizedStringKey(track.labelKey), systemImage: "xmark.circle.fill") }
                        .vlText(.labelSm).buttonStyle(.vlGhost)
                        .accessibilityLabel(Text("timeline.filter.clear"))
                }
            }
            if let timeline {
                let events = timeline.filtered(trackFilter[m.id].map(Self.apiTrack))
                if events.isEmpty { Text("timeline.empty").vlText(.bodySm).foregroundStyle(Color.vl.textSecondary) }
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    TimelineEventRow(event: event, isLast: index == events.count - 1)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    @ViewBuilder private func primaryAction(_ m: PostHistoryAPI.Material) -> some View {
        switch m.primaryAction {
        case .replaceShot:
            // «الرد على المشرف» مخفي: العقد لا يحمل انتقالًا للرد (قرار للمنسّق، المواصفة A4).
            Button { replacing = m } label: { Label("a4.replaceShot", systemImage: "arrow.triangle.2.circlepath.camera") }.buttonStyle(.vlPrimary)
        case .showReceipt:
            Button { queue.presentedReceipt = ReceiptTarget(materialId: m.id, recordId: queue.records.first { $0.materialId == m.id && $0.kind == .original }?.id) } label: {
                Label("a4.showReceipt", systemImage: "doc.text")
            }.buttonStyle(.vlSecondary)
        case .none:
            EmptyView()
        }
    }

    static func apiTrack(_ t: VLTrack) -> TransitionRecord.Track {
        switch t {
        case .technical: return .technical
        case .editorial: return .editorial
        case .rights: return .rights
        }
    }
}

/// حدث في الخط الزمني: أيقونة المسار ولونه، نقطة وخط، نص الحالة ووقتها. لا يعتمد على اللون وحده.
private struct TimelineEventRow: View {
    let event: TransitionRecord
    let isLast: Bool

    var body: some View {
        let track = VLTrack(event.track) ?? .technical
        HStack(alignment: .top, spacing: VL.Space.s3) {
            VStack(spacing: VL.Space.s1) {
                Circle().fill(track.accent).frame(width: VL.Space.s4, height: VL.Space.s4)
                if !isLast { Rectangle().fill(track.subtle).frame(width: VL.Border.regular).frame(maxHeight: .infinity) }
            }
            .frame(width: VL.Space.s4)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                Label { Text(LocalizedStringKey(MaterialTimeline.labelKey(event))).vlText(.bodySm).foregroundStyle(Color.vl.textPrimary) } icon: {
                    Image(systemName: track.systemImage).foregroundStyle(track.accent)
                }
                Text(event.occurredAt.formatted(date: .abbreviated, time: .shortened))
                    .vlText(.monoMd).foregroundStyle(Color.vl.textSecondary)
            }
            .padding(.bottom, VL.Space.s3)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(LocalizedStringKey(track.labelKey)) + Text(verbatim: ": ") + Text(LocalizedStringKey(MaterialTimeline.labelKey(event))))
    }
}
