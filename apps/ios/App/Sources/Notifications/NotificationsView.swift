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

/// 11 · الإشعارات (docs/design/specs/reporter-v2.md): بطاقة لكل إشعار بأيقونة نوعه ونغمته، والعنوان ووقته. القائمة داخل التطبيق
/// خلف الدخول؛ إشعار شاشة القفل يحمل رقم المادة وحالتها فقط (docs/security/threat-model.md).
struct NotificationsView: View {
    @EnvironmentObject private var model: NotificationsModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: VL.Space.s3) {
                if model.failed { VLNote(tone: .warn, systemImage: "exclamationmark.triangle", text: Text("notifications.loadFailed")) }
                if model.items.isEmpty, !model.failed {
                    VLEmptyState(title: "notifications.empty", message: "notifications.empty.body")
                }
                ForEach(model.items, id: \.id) { n in
                    // لمسة على البطاقة تفتحها؛ وزرّ «أقرّ الاستلام» داخلها يبقى زرًّا مستقلًا.
                    NotificationRow(notification: n)
                        .onTapGesture { Task { await model.open(n.id) } }
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { Task { await model.open(n.id) } }
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
        .navigationBarTitleDisplayMode(.large)
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
    }
}

struct NotificationRow: View {
    let notification: PostHistoryAPI.Notification
    @EnvironmentObject private var model: NotificationsModel

    private var unread: Bool { notification.state == .sent || notification.state == .delivered }

    /// أيقونة النوع ونغمته من نوع حدث Outbox الذي ولّد الإشعار؛ لا يُعتمد على اللون وحده (العنوان يقول ما حدث).
    private var kind: (image: String, tone: VLTone) {
        switch notification.type {
        case "material.change_requested": return ("pencil", .warn)
        case "material.accepted_for_production", "material.published", "material.acknowledged", "upload.verified": return ("checkmark", .ok)
        case "catalog.listing_changed", "license.issued": return ("key", .brand)
        case "upload.failed", "material.urgent_received": return ("exclamationmark.triangle", .danger)
        default: return ("bell", .muted)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: VL.Space.s4) {
            Image(systemName: kind.image)
                .foregroundStyle(kind.tone.color)
                .frame(width: 36, height: 36)
                .background(Color.vl.bgSunken, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: VL.Space.s1) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: VL.Space.s3) {
                        title
                        Spacer(minLength: VL.Space.s3)
                        time
                    }
                    VStack(alignment: .leading, spacing: VL.Space.s1) {
                        title
                        time
                    }
                }
                if unread {
                    StateBadge(labelKey: "notifications.unread", tone: .brand, systemImage: "circle.fill")
                }
                if notification.assignmentState == .assigned {
                    Button("notifications.acknowledge") { Task { await model.acknowledge(notification.id) } }
                        .buttonStyle(VLButtonStyle(kind: .outline, size: .small, fullWidth: false))
                }
            }
        }
        .padding(VL.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous)
            .strokeBorder(unread ? Color.vl.actionPrimary : Color.vl.borderLine, lineWidth: unread ? VL.Border.field : VL.Border.hairline))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // غير المقروء أثقل وزنًا وبشارة «جديد» (لا يُعتمد على الإطار الملوّن وحده).
    private var title: some View {
        Text(notification.title ?? "").vlText(unread ? .headline : .body).foregroundStyle(Color.vl.textPrimary)
            .multilineTextAlignment(.leading)
    }

    private var time: some View {
        Text(notification.createdAt, style: .relative).vlText(.caption).foregroundStyle(Color.vl.textSecondary)
    }
}
