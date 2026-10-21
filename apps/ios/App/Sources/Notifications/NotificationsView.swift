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
    }

    func clear() async {
        await feed.clear()
        await sync()
        presented = false
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
        List {
            if model.failed { Text("notifications.loadFailed").foregroundStyle(.secondary) }
            if model.items.isEmpty, !model.failed { Text("notifications.empty").foregroundStyle(.secondary) }
            ForEach(model.items, id: \.id) { n in
                NotificationRow(notification: n)
                    .contentShape(Rectangle())
                    .onTapGesture { Task { await model.open(n.id) } }
            }
            if !model.reachedEnd, !model.items.isEmpty {
                Button("notifications.loadMore") { Task { await model.loadMore() } }
            }
        }
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
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(unread ? Color.accentColor : .clear).frame(width: 8, height: 8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                Text(notification.title ?? "").font(unread ? .headline : .body)
                Text(notification.createdAt, style: .relative).font(.caption).foregroundStyle(.secondary)
                if notification.assignmentState == .assigned {
                    Button("notifications.acknowledge") { Task { await model.acknowledge(notification.id) } }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
