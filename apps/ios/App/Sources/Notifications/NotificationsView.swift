import NotificationsCore
import PostHistoryAPI
import SwiftUI

@MainActor
final class NotificationsModel: ObservableObject {
    @Published private(set) var items: [PostHistoryAPI.Notification] = []
    @Published private(set) var unreadCount = 0
    @Published private(set) var reachedEnd = false
    @Published private(set) var failed = false
    @Published var presented = false
    /// إشعار يخص مادة (مثل «طلب تعديل») فُتح للتو: تفتح «موادي» على المادة موسّعة (المواصفة §4).
    @Published var openedMaterialId: UUID?
    let feed: NotificationsFeed

    init(feed: NotificationsFeed) { self.feed = feed }

    func refresh() async {
        do { items = try await feed.refresh(); failed = false } catch { failed = true }
        await sync()
    }

    func loadMore() async {
        do { items = try await feed.loadMore() } catch { failed = true }
        await sync()
    }

    func open(_ id: UUID) async {
        try? await feed.markRead(id)
        await sync()
        if let materialId = items.first(where: { $0.id == id })?.materialId { openedMaterialId = materialId }
    }

    func acknowledge(_ id: UUID) async {
        try? await feed.acknowledge(id)
        await sync()
    }

    /// من لمس إشعار الهاتف: يُوسم مقروءًا ويُعرض الصندوق.
    func openFromPush(_ route: PushRoute) async {
        presented = true
        await refresh()
        await open(route.notificationId)
        if let materialId = route.materialId { openedMaterialId = materialId }
    }

    func clear() async {
        await feed.clear()
        await sync()
        presented = false
        openedMaterialId = nil
    }

    private func sync() async {
        items = await feed.items
        unreadCount = await feed.unreadCount
        reachedEnd = await feed.reachedEnd
    }
}

struct NotificationsView: View {
    @EnvironmentObject private var model: NotificationsModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: VL.Space.s4) {
                if model.failed { VLAlert(tone: .attention, systemImage: "exclamationmark.triangle.fill", text: "notifications.loadFailed") }
                if model.items.isEmpty, !model.failed {
                    Text("notifications.empty").vlText(.bodyMd).foregroundStyle(Color.vl.textSecondary).padding(VL.Space.s5)
                }
                ForEach(model.items, id: \.id) { n in
                    VLCard { NotificationRow(notification: n) }
                        .contentShape(Rectangle())
                        .onTapGesture { Task { await model.open(n.id) } }
                }
                if !model.reachedEnd, !model.items.isEmpty {
                    Button("notifications.loadMore") { Task { await model.loadMore() } }.buttonStyle(.vlGhost)
                }
            }
            .padding(VL.Space.s5)
        }
        // السحب للتحديث متاح والقائمة فارغة أو قصيرة (نص الفشل يطلبه).
        .scrollBounceBehavior(.always)
        .vlScreen()
        .navigationTitle("notifications.title")
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
    }
}

struct NotificationRow: View {
    let notification: PostHistoryAPI.Notification
    @EnvironmentObject private var model: NotificationsModel

    private var unread: Bool { notification.state == .sent || notification.state == .delivered }

    var body: some View {
        HStack(alignment: .top, spacing: VL.Space.s4) {
            Circle().fill(unread ? Color.vl.bgBrand : Color.clear).frame(width: VL.Space.s3, height: VL.Space.s3).padding(.top, VL.Space.s3)
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                // غير المقروء أثقل وزنًا (لا يُعتمد على النقطة الملوّنة وحدها).
                Text(notification.title ?? "").vlText(unread ? .headingH4 : .bodyMd).foregroundStyle(Color.vl.textPrimary)
                Text(notification.createdAt, style: .relative).vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                if notification.assignmentState == .assigned {
                    Button("notifications.acknowledge") { Task { await model.acknowledge(notification.id) } }
                        .buttonStyle(.vlSecondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
