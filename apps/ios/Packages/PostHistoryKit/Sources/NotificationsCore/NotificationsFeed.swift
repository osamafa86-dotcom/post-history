import Foundation
import PostHistoryAPI

public protocol NotificationsListAPI: Sendable {
    func page(cursor: String?, limit: Int) async throws -> NotificationPage
    func markRead(id: UUID) async throws
    func acknowledge(id: UUID) async throws
}

public struct GeneratedNotificationsListAPI: NotificationsListAPI {
    private let configuration: PostHistoryAPIAPIConfiguration
    public init(configuration: PostHistoryAPIAPIConfiguration) { self.configuration = configuration }
    public func page(cursor: String?, limit: Int) async throws -> NotificationPage {
        try await NotificationsAPI.listNotifications(cursor: cursor, limit: limit, apiConfiguration: configuration)
    }
    public func markRead(id: UUID) async throws {
        try await NotificationsAPI.readNotification(idempotencyKey: "read-\(id.uuidString.lowercased())", id: id, apiConfiguration: configuration)
    }
    public func acknowledge(id: UUID) async throws {
        try await NotificationsAPI.ackNotification(idempotencyKey: "ack-\(id.uuidString.lowercased())", id: id, apiConfiguration: configuration)
    }
}

/// صندوق الإشعارات داخل التطبيق: الأحدث أولًا بصفحات، وعدد غير المقروء، والقراءة والإقرار محليًا فور النجاح.
public actor NotificationsFeed {
    public private(set) var items: [PostHistoryAPI.Notification] = []
    public private(set) var unreadCount = 0
    public private(set) var reachedEnd = false
    private var nextCursor: String?
    private var loading = false
    private let api: any NotificationsListAPI
    private let pageSize: Int

    public init(api: any NotificationsListAPI, pageSize: Int = 30) {
        self.api = api
        self.pageSize = pageSize
    }

    @discardableResult
    public func refresh() async throws -> [PostHistoryAPI.Notification] {
        guard !loading else { return items }
        loading = true
        defer { loading = false }
        let page = try await api.page(cursor: nil, limit: pageSize)
        items = page.items
        unreadCount = page.unreadCount
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        return items
    }

    @discardableResult
    public func loadMore() async throws -> [PostHistoryAPI.Notification] {
        guard !loading, !reachedEnd, let cursor = nextCursor else { return items }
        loading = true
        defer { loading = false }
        let page = try await api.page(cursor: cursor, limit: pageSize)
        let known = Set(items.map(\.id))
        items.append(contentsOf: page.items.filter { !known.contains($0.id) })
        unreadCount = page.unreadCount
        nextCursor = page.nextCursor
        reachedEnd = page.nextCursor == nil
        return items
    }

    /// يُستدعى عند فتح الإشعار (من القائمة أو من إشعار الهاتف). مفتاح التكرار ثابت لكل إشعار فلا يُحتسب مرتين.
    public func markRead(_ id: UUID) async throws {
        try await api.markRead(id: id)
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        if items[i].state == .sent || items[i].state == .delivered {
            items[i].state = .read
            unreadCount = max(0, unreadCount - 1)
        }
    }

    /// «أقرّ الاستلام» لمهمة مسندة.
    public func acknowledge(_ id: UUID) async throws {
        try await api.acknowledge(id: id)
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        if items[i].state != .read && items[i].state != .acknowledged { unreadCount = max(0, unreadCount - 1) }
        items[i].state = .acknowledged
        if items[i].assignmentState == .assigned { items[i].assignmentState = .acknowledged }
    }

    public func clear() {
        items = []
        unreadCount = 0
        nextCursor = nil
        reachedEnd = false
    }
}

/// ما يأتي في حمولة APNs (القائمة البيضاء في العقد: المعرّفات والنوع والأولوية فقط). ما سواها يُتجاهل.
public struct PushRoute: Equatable, Sendable {
    public var notificationId: UUID
    public var materialId: UUID?

    public init?(userInfo: [AnyHashable: Any]) {
        guard let raw = userInfo["notification_id"] as? String, let id = UUID(uuidString: raw) else { return nil }
        notificationId = id
        materialId = (userInfo["material_id"] as? String).flatMap(UUID.init(uuidString:))
    }
}
