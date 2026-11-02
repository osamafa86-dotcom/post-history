import XCTest
import PostHistoryAPI
@testable import MaterialsCore

/// واجهة «موادي» بصفحات بطيئة مختارة: تسجّل كل طلب، وتُبطئ ما في `slow` لتداخل التحميلات.
final class SlowPagesAPI: MaterialsListAPI, @unchecked Sendable {
    let lock = NSLock()
    var pages: [String?: MaterialPage] = [:]
    var calls: [String?] = []
    var slow: Set<String?> = []

    func page(cursor: String?, limit: Int) async throws -> MaterialPage {
        let isSlow = lock.withLock { calls.append(cursor); return slow.contains(cursor) }
        if isSlow { try await Task.sleep(nanoseconds: 300_000_000) }
        return lock.withLock { pages[cursor] ?? MaterialPage(items: [], nextCursor: nil) }
    }

    func material(id: UUID) async throws -> Material { throw CancellationError() }

    var recorded: [String?] { lock.withLock { calls } }

    /// ينتظر حتى يبدأ الطلب رقم `count` (لا مهلة ثابتة تتأخر عنها آلة CI بطيئة).
    func waitForCalls(_ count: Int) async throws {
        for _ in 0..<400 where recorded.count < count { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertGreaterThanOrEqual(recorded.count, count, "the slow request never started")
    }
}

/// التحميلات تمر بالترتيب ولا يُفقد طلب (مراجعة الجودة الثانية لـ #465): «الصفحة التالية» أثناء استطلاع جارٍ كانت تعود بلا طلب وبالعدد
/// نفسه، فلا تعود مهمة المعرض المربوطة بالعدد ويدور المؤشر بلا نهاية.
final class MaterialsFeedOrderTests: XCTestCase {
    func testLoadMoreDuringASlowPollWaitsForItThenRequestsTheNextPage() async throws {
        let a = material(), b = material(), c = material(), d = material()
        let api = SlowPagesAPI()
        api.pages[nil] = MaterialPage(items: [a, b], nextCursor: "p2")
        api.pages["p2"] = MaterialPage(items: [c, d], nextCursor: "p3")
        let feed = MaterialsFeed(api: api, pageSize: 2)
        try await feed.refresh()
        api.lock.withLock { api.slow = [nil] }
        async let poll = feed.refreshHead()
        try await api.waitForCalls(2)
        let more = try await feed.loadMore()
        _ = try await poll
        XCTAssertEqual(more.map(\.id), [a.id, b.id, c.id, d.id], "the next page arrives after the poll")
        XCTAssertEqual(api.recorded, [nil, nil, "p2"], "no request is dropped")
        let cursor = await feed.nextCursor
        XCTAssertEqual(cursor, "p3")
    }

    func testAPollDuringASlowLoadMoreWaitsAndMergesWithoutDroppingThePage() async throws {
        let a = material(), b = material(), c = material(), d = material(), new = material()
        let api = SlowPagesAPI()
        api.pages[nil] = MaterialPage(items: [a, b], nextCursor: "p2")
        api.pages["p2"] = MaterialPage(items: [c, d], nextCursor: nil)
        let feed = MaterialsFeed(api: api, pageSize: 2)
        try await feed.refresh()
        api.lock.withLock {
            api.slow = ["p2"]
            api.pages[nil] = MaterialPage(items: [new, a], nextCursor: "q2")
        }
        async let more = feed.loadMore()
        try await api.waitForCalls(2)
        let merged = try await feed.refreshHead()
        _ = try await more
        XCTAssertEqual(merged.map(\.id), [new.id, a.id, b.id, c.id, d.id])
        XCTAssertEqual(api.recorded, [nil, "p2", nil])
        let end = await feed.reachedEnd
        XCTAssertTrue(end, "the end reached by the next page is kept by the merge")
    }

    func testAWipeDuringALoadKeepsTheListEmpty() async throws {
        let a = material(), b = material()
        let api = SlowPagesAPI()
        api.pages[nil] = MaterialPage(items: [a, b], nextCursor: "p2")
        api.slow = [nil]
        let feed = MaterialsFeed(api: api, pageSize: 2)
        async let first = feed.refresh()
        try await api.waitForCalls(1)
        await feed.clear()
        let returned = try await first
        let items = await feed.items
        XCTAssertTrue(items.isEmpty, "what was wiped does not come back")
        XCTAssertTrue(returned.isEmpty)
    }

    func testEveryWaitingLoadRunsInArrivalOrder() async throws {
        let pages = (0..<4).map { _ in material() }
        let api = SlowPagesAPI()
        api.pages[nil] = MaterialPage(items: [pages[0]], nextCursor: "p2")
        api.pages["p2"] = MaterialPage(items: [pages[1]], nextCursor: "p3")
        api.pages["p3"] = MaterialPage(items: [pages[2]], nextCursor: "p4")
        api.pages["p4"] = MaterialPage(items: [pages[3]], nextCursor: nil)
        api.slow = [nil]
        let feed = MaterialsFeed(api: api, pageSize: 1)
        async let first = feed.refresh()
        try await api.waitForCalls(1)
        async let second = feed.loadMore()
        // الثاني ينتظر دوره خلف الأول قبل أن يبدأ الثالث (ترتيب الوصول).
        try await Task.sleep(nanoseconds: 50_000_000)
        async let third = feed.loadMore()
        _ = try await (first, second, third)
        let all = try await feed.loadMore()
        XCTAssertEqual(all.map(\.id), pages.map(\.id))
        XCTAssertEqual(api.recorded, [nil, "p2", "p3", "p4"])
    }
}
