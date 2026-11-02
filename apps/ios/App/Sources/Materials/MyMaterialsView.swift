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

/// «موادي» بقائمتها وخطها الزمني كما كانت (A4)، بالهوية v2: فلاتر برقاقات، وبطاقات بالحالات الثلاث شاراتٍ منفصلة بأيقونة وكلمة.
/// معرض «موادي» (07) وتفاصيل المادة والمشغّل في الطلب التالي (ADR 0088).
struct MyMaterialsView: View {
    enum Filter: Hashable { case all, needsAction, urgent }

    @EnvironmentObject private var model: MyMaterialsModel
    @EnvironmentObject private var queue: UploadQueueModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var focus: UUID?
    var onNewMaterial: () -> Void = {}

    @State private var filter: Filter = .all
    @State private var expanded: UUID?
    @State private var trackFilter: [UUID: MaterialStatus.Track] = [:]
    @State private var replacing: PostHistoryAPI.Material?

    private var visible: [PostHistoryAPI.Material] {
        switch filter {
        case .all: return model.items
        case .needsAction: return model.items.filter(\.needsAction)
        case .urgent: return model.items.filter { $0.priority == .urgent }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VL.Space.s4) {
                VLFilterChips(groupLabel: "materials.filter", options: [
                    (Filter.all, Text("materials.tab.count \(Text("materials.tab.all")) \(model.items.count)")),
                    (Filter.needsAction, Text("materials.tab.count \(Text("materials.tab.needsAction")) \(model.items.filter(\.needsAction).count)")),
                    (Filter.urgent, Text("material.priority.urgent")),
                ], selection: $filter)
                if model.failed, let updated = model.lastUpdated {
                    VLNote(tone: .warn, systemImage: "clock.arrow.circlepath",
                           text: Text("materials.stale \(VLFormat.time(updated))"), actionKey: "materials.refresh") {
                        Task { await model.refresh() }
                    }
                }
                if model.failed, model.lastUpdated == nil {
                    VLNote(tone: .warn, systemImage: "wifi.slash", text: Text("materials.loadFailed"))
                }
                if visible.isEmpty, !model.loading, !model.failed {
                    VLEmptyState(title: "mine.empty.title", message: "mine.empty") {
                        if filter == .all { Button("home.send", action: onNewMaterial).buttonStyle(.vlPrimary) }
                    }
                }
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
        .navigationTitle("materials.title")
        .navigationBarTitleDisplayMode(.large)
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
        .onChange(of: focus) { _, id in if let id { filter = .all; expanded = id } }
        .sheet(item: $replacing) { m in ReplaceShotView(material: m) }
    }

    private func header(_ m: PostHistoryAPI.Material) -> some View {
        HStack(alignment: .top, spacing: VL.Space.s3) {
            Text(verbatim: m.title).vlText(.headline).foregroundStyle(Color.vl.textPrimary).multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            PriorityBadge(priority: m.priority)
        }
    }

    private func collapsedCard(_ m: PostHistoryAPI.Material) -> some View {
        Button { VLMotion.animate(reduceMotion) { expanded = m.id } } label: {
            VLCard {
                header(m)
                ThreeStateBadges(status: MaterialStatus(m), axis: .horizontal)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("materials.expand.hint"))
    }

    private func expandedCard(_ m: PostHistoryAPI.Material) -> some View {
        let timeline = model.timelines[m.id]
        return VLCard(border: .vl.borderEdge) {
            header(m)
            ThreeStateBadges(status: MaterialStatus(m), axis: .horizontal) { track in
                trackFilter[m.id] = trackFilter[m.id] == track ? nil : track
            }
            if let note = timeline?.supervisorNote(for: m) {
                VLNote(tone: .warn, systemImage: "pencil", text: Text("materials.supervisorNote \(note.reason)"))
            }
            timelineView(m, timeline)
            primaryAction(m)
        }
    }

    @ViewBuilder private func timelineView(_ m: PostHistoryAPI.Material, _ timeline: MaterialTimeline?) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            HStack {
                VLSectionHeader("timeline.title")
                Spacer()
                if let track = trackFilter[m.id] {
                    Button { trackFilter[m.id] = nil } label: { Label(LocalizedStringKey(track.labelKey), systemImage: "xmark.circle.fill") }
                        .buttonStyle(.vlGhost)
                        .accessibilityLabel(Text("timeline.filter.clear"))
                }
            }
            if let timeline {
                let events = timeline.filtered(trackFilter[m.id].map(Self.apiTrack))
                if events.isEmpty { Text("timeline.empty").vlText(.body).foregroundStyle(Color.vl.textSecondary) }
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
            Button { replacing = m } label: { Label("a4.replaceShot", systemImage: "arrow.triangle.2.circlepath.camera") }.buttonStyle(.vlSolid)
        case .showReceipt:
            Button { queue.presentedReceipt = ReceiptTarget(materialId: m.id, recordId: queue.records.first { $0.materialId == m.id && $0.kind == .original }?.id) } label: {
                Label("a4.showReceipt", systemImage: "doc.text")
            }.buttonStyle(.vlOutline)
        case .none:
            EmptyView()
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
private struct TimelineEventRow: View {
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
