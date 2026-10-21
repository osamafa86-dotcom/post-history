import MaterialsCore
import PostHistoryAPI
import SwiftUI

/// «موادي»: ما أرسله المراسل وحالاته الثلاث المستقلة (الملف، التحرير، الحقوق) ورقم الإيصال. بلا إحداثيات.
@MainActor
final class MyMaterialsModel: ObservableObject {
    @Published private(set) var items: [PostHistoryAPI.Material] = []
    @Published private(set) var reachedEnd = false
    @Published private(set) var failed = false
    @Published private(set) var loading = false
    let feed: MaterialsFeed

    init(feed: MaterialsFeed) { self.feed = feed }

    func refresh() async {
        loading = true
        defer { loading = false }
        do { items = try await feed.refresh(); failed = false } catch { failed = true }
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

    func clear() async {
        await feed.clear()
        items = []
        reachedEnd = false
    }
}

struct MyMaterialsView: View {
    @EnvironmentObject private var model: MyMaterialsModel

    var body: some View {
        List {
            if model.failed { Text("materials.loadFailed").foregroundStyle(.secondary) }
            if model.items.isEmpty, !model.loading, !model.failed {
                Text("materials.empty").foregroundStyle(.secondary)
            }
            ForEach(model.items, id: \.id) { m in
                NavigationLink(value: m.id) { MaterialRow(material: m) }
            }
            if !model.reachedEnd, !model.items.isEmpty {
                Button("materials.loadMore") { Task { await model.loadMore() } }
            }
        }
        .navigationTitle("materials.title")
        .navigationDestination(for: UUID.self) { id in MaterialDetailView(id: id) }
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
    }
}

struct MaterialRow: View {
    let material: PostHistoryAPI.Material
    var body: some View {
        let status = MaterialStatus(material)
        VStack(alignment: .leading, spacing: 6) {
            Text(material.title).font(.headline).lineLimit(2)
            Text(material.createdAt, style: .date).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                StatusBadge(badge: status.technical)
                StatusBadge(badge: status.editorial)
                StatusBadge(badge: status.rights)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct StatusBadge: View {
    let badge: MaterialStatus.Badge
    var body: some View {
        Text(LocalizedStringKey(badge.labelKey))
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(badge.tone.color.opacity(0.15), in: Capsule())
            .foregroundStyle(badge.tone.color)
    }
}

extension MaterialStatus.Tone {
    var color: Color {
        switch self {
        case .neutral: return .secondary
        case .progress: return .blue
        case .good: return .green
        case .attention: return .orange
        case .bad: return .red
        }
    }
}

struct MaterialDetailView: View {
    let id: UUID
    @EnvironmentObject private var model: MyMaterialsModel

    var body: some View {
        List {
            if let m = model.items.first(where: { $0.id == id }) {
                let status = MaterialStatus(m)
                Section {
                    Text(m.title).font(.headline)
                    LabeledContent("material.detail.place", value: "\(m.governorate) · \(m.city)")
                    if let shot = m.shotAt { LabeledContent("material.detail.shotAt") { Text(shot, style: .date) } }
                    LabeledContent("material.detail.sentAt") { Text(m.createdAt, style: .date) }
                    LabeledContent("material.detail.receipt") {
                        if let r = status.receiptNumber { Text(r).monospaced().textSelection(.enabled) } else { Text("material.detail.noReceipt") }
                    }
                }
                Section("material.detail.states") {
                    LabeledContent("material.axis.technical") { StatusBadge(badge: status.technical) }
                    LabeledContent("material.axis.editorial") { StatusBadge(badge: status.editorial) }
                    LabeledContent("material.axis.rights") { StatusBadge(badge: status.rights) }
                }
                if !m.files.isEmpty {
                    Section("material.detail.files") {
                        ForEach(m.files, id: \.id) { f in
                            LabeledContent(Self.fileLabel(f.kind)) {
                                Text(f.receiptNumber ?? "").monospaced()
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("materials.title")
        .refreshable { await model.reload(id) }
        .task { await model.reload(id) }
    }

    static func fileLabel(_ kind: MaterialFile.Kind) -> LocalizedStringKey {
        switch kind {
        case .original: return "material.file.original"
        case .proxy: return "material.file.proxy"
        default: return "material.file.other"
        }
    }
}
