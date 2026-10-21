import XCTest
import PostHistoryAPI
@testable import NotificationsCore

final class FakePushAPI: PushDevicesAPI, @unchecked Sendable {
    let lock = NSLock()
    var registered: [(UUID, String)] = []
    var unregistered: [UUID] = []
    var failNext = false
    func register(installationId: UUID, token: String, appVersion: String?) async throws {
        try lock.withLock {
            if failNext { failNext = false; throw URLError(.notConnectedToInternet) }
            registered.append((installationId, token))
        }
    }
    func unregister(installationId: UUID) async throws { lock.withLock { unregistered.append(installationId) } }
}

final class FakeNotificationsAPI: NotificationsListAPI, @unchecked Sendable {
    let lock = NSLock()
    var page = NotificationPage(items: [], nextCursor: nil, unreadCount: 0)
    var reads: [UUID] = []
    var acks: [UUID] = []
    func page(cursor: String?, limit: Int) async throws -> NotificationPage { lock.withLock { page } }
    func markRead(id: UUID) async throws { lock.withLock { reads.append(id) } }
    func acknowledge(id: UUID) async throws { lock.withLock { acks.append(id) } }
}

func note(_ state: PostHistoryAPI.Notification.State = .delivered, assignment: PostHistoryAPI.Notification.AssignmentState? = nil) -> PostHistoryAPI.Notification {
    PostHistoryAPI.Notification(id: UUID(), type: "material.acknowledged", materialId: UUID(), title: "M-42", priority: .normal, state: state,
                                assignmentState: assignment, createdAt: Date())
}

final class NotificationsCoreTests: XCTestCase {
    func testRegistersOnlyAfterSignInWithAGeneratedInstallationIdAndHexToken() async {
        let api = FakePushAPI(), ids = InMemoryInstallationIdStore()
        let r = PushRegistrar(api: api, ids: ids, appVersion: "1.0")
        await r.deviceTokenReceived(Data([0xde, 0xad, 0x01]))
        XCTAssertTrue(api.registered.isEmpty, "nothing is sent before sign-in")
        await r.didSignIn()
        XCTAssertEqual(api.registered.map(\.1), ["dead01"])
        XCTAssertEqual(api.registered.first?.0, try ids.load())
        await r.deviceTokenReceived(Data([0xde, 0xad, 0x01]))
        XCTAssertEqual(api.registered.count, 1, "the same token is not registered twice")
        await r.deviceTokenReceived(Data([0x02]))
        XCTAssertEqual(api.registered.map(\.1), ["dead01", "02"])
        XCTAssertEqual(Set(api.registered.map(\.0)).count, 1, "one installation id for the install")
    }

    func testFailedRegistrationIsRetriedOnTheNextToken() async {
        let api = FakePushAPI()
        api.failNext = true
        let r = PushRegistrar(api: api, ids: InMemoryInstallationIdStore(), appVersion: nil)
        await r.didSignIn()
        await r.deviceTokenReceived(Data([1]))
        let registered = await r.isRegistered
        XCTAssertFalse(registered)
        await r.deviceTokenReceived(Data([1]))
        XCTAssertEqual(api.registered.count, 1)
    }

    func testSignOutUnregistersAndWipeForgetsTheInstallationId() async throws {
        let api = FakePushAPI(), ids = InMemoryInstallationIdStore()
        let r = PushRegistrar(api: api, ids: ids, appVersion: nil)
        await r.didSignIn()
        await r.deviceTokenReceived(Data([1]))
        let first = try XCTUnwrap(ids.load())
        await r.willSignOut()
        XCTAssertEqual(api.unregistered, [first])
        await r.forgetLocally()
        XCTAssertNil(try ids.load())
        await r.didSignIn()
        await r.deviceTokenReceived(Data([1]))
        XCTAssertNotEqual(api.registered.last?.0, first, "a wiped install registers under a new id")
    }

    func testFeedCountsUnreadAndUpdatesLocallyOnReadAndAck() async throws {
        let a = note(.delivered), b = note(.sent, assignment: .assigned), c = note(.read)
        let api = FakeNotificationsAPI()
        api.page = NotificationPage(items: [a, b, c], nextCursor: nil, unreadCount: 2)
        let feed = NotificationsFeed(api: api)
        try await feed.refresh()
        try await feed.markRead(a.id)
        try await feed.markRead(c.id)
        var unread = await feed.unreadCount
        XCTAssertEqual(unread, 1, "reading an already read item does not change the count")
        try await feed.acknowledge(b.id)
        unread = await feed.unreadCount
        XCTAssertEqual(unread, 0)
        let items = await feed.items
        XCTAssertEqual(items.first { $0.id == b.id }?.assignmentState, .acknowledged)
        XCTAssertEqual(api.reads, [a.id, c.id])
        XCTAssertEqual(api.acks, [b.id])
        await feed.clear()
        let cleared = await feed.items
        XCTAssertTrue(cleared.isEmpty)
    }

    func testPushRouteReadsOnlyWhitelistedIdentifiers() {
        let n = UUID(), m = UUID()
        let route = PushRoute(userInfo: ["aps": ["alert": ["title": "M-42"]], "notification_id": n.uuidString, "material_id": m.uuidString,
                                         "type": "material.acknowledged", "priority": "normal"])
        XCTAssertEqual(route?.notificationId, n)
        XCTAssertEqual(route?.materialId, m)
        XCTAssertNil(PushRoute(userInfo: ["aps": [:]]))
        XCTAssertNil(PushRoute(userInfo: ["notification_id": "nope"])?.materialId)
    }
}
