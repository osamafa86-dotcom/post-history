import XCTest
import PostHistoryAPI
@testable import MaterialsCore

/// واجهة «موادي» بصفحات بطيئة مختارة: تسجّل كل طلب، وتُبطئ ما في `slow` لتداخل التحميلات، وتُمسك ما في `held` حتى يفلته الاختبار
/// بـ `release(_:)` (ترتيب حتمي بلا مهلة ثابتة). و`sequence` ردود متتالية لمؤشر واحد، ثم `pages`.
final class SlowPagesAPI: MaterialsListAPI, @unchecked Sendable {
    let lock = NSLock()
    var pages: [String?: MaterialPage] = [:]
    var sequence: [String?: [MaterialPage]] = [:]
    var calls: [String?] = []
    var slow: Set<String?> = []
    var held: Set<String?> = []

    func page(cursor: String?, limit: Int) async throws -> MaterialPage {
        let isSlow = lock.withLock { calls.append(cursor); return slow.contains(cursor) }
        if isSlow { try await Task.sleep(nanoseconds: 300_000_000) }
        while lock.withLock({ held.contains(cursor) }) { try await Task.sleep(nanoseconds: 2_000_000) }
        return lock.withLock {
            if var next = sequence[cursor], !next.isEmpty {
                let page = next.removeFirst()
                sequence[cursor] = next
                return page
            }
            return pages[cursor] ?? MaterialPage(items: [], nextCursor: nil)
        }
    }

    func material(id: UUID) async throws -> Material { throw CancellationError() }

    var recorded: [String?] { lock.withLock { calls } }

    func hold(_ cursor: String?) { lock.withLock { _ = held.insert(cursor) } }
    func release(_ cursor: String?) { lock.withLock { _ = held.remove(cursor) } }

    /// ينتظر حتى يبدأ الطلب رقم `count` (لا مهلة ثابتة تتأخر عنها آلة CI بطيئة).
    func waitForCalls(_ count: Int) async throws {
        for _ in 0..<400 where recorded.count < count { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertGreaterThanOrEqual(recorded.count, count, "the slow request never started")
    }
}

/// ينتظر حتى يصطف `count` تحميلًا خلف الجاري.
func waitForWaiters(_ feed: MaterialsFeed, _ count: Int) async throws {
    for _ in 0..<400 {
        if await feed.waiting >= count { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("the load never queued")
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

    /// ثلاث عمليات مختلفة تصطف خلف تحميل أول ممسَك: «التالية» ثم استطلاع ثم «التالية». الاستطلاع يأتي بجديد أكثر من صفحة فيستبدل
    /// القائمة بمؤشر جديد، فكل ترتيب آخر يغيّر الطلبات ونتيجة كل عملية.
    func testEveryWaitingLoadRunsInArrivalOrder() async throws {
        let a = material(), b = material(), n1 = material(), n2 = material(), q = material()
        let api = SlowPagesAPI()
        api.sequence[nil] = [MaterialPage(items: [a], nextCursor: "p2"), MaterialPage(items: [n1, n2], nextCursor: "q2")]
        api.pages["p2"] = MaterialPage(items: [b], nextCursor: "p3")
        api.pages["q2"] = MaterialPage(items: [q], nextCursor: nil)
        api.hold(nil)
        let feed = MaterialsFeed(api: api, pageSize: 2)
        async let first = feed.refresh()
        try await api.waitForCalls(1)
        async let next = feed.loadMore()
        try await waitForWaiters(feed, 1)
        async let poll = feed.refreshHead()
        try await waitForWaiters(feed, 2)
        async let last = feed.loadMore()
        try await waitForWaiters(feed, 3)
        api.release(nil)
        let (r0, r1, r2, r3) = try await (first, next, poll, last)
        XCTAssertEqual(api.recorded, [nil, "p2", nil, "q2"])
        XCTAssertEqual(r0.map(\.id), [a.id])
        XCTAssertEqual(r1.map(\.id), [a.id, b.id], "the next page runs right after the first load")
        XCTAssertEqual(r2.map(\.id), [n1.id, n2.id], "then the poll")
        XCTAssertEqual(r3.map(\.id), [n1.id, n2.id, q.id], "and the last load follows the poll's cursor")
    }

    /// مراجعة الجودة الثالثة: الجيل يُقرأ عند الدخول، فما اصطف قبل المسح لا يطلب بعده ولا يعيد شيئًا إلى الذاكرة.
    func testLoadsQueuedBeforeAWipeAreDroppedWithoutARequest() async throws {
        let a = material(), b = material()
        let api = SlowPagesAPI()
        api.pages[nil] = MaterialPage(items: [a], nextCursor: "p2")
        api.pages["p2"] = MaterialPage(items: [b], nextCursor: "p3")
        let feed = MaterialsFeed(api: api, pageSize: 1)
        try await feed.refresh()
        api.hold("p2")
        async let inFlight = feed.loadMore()
        try await api.waitForCalls(2)
        async let next = feed.loadMore()
        try await waitForWaiters(feed, 1)
        async let poll = feed.refreshHead()
        try await waitForWaiters(feed, 2)
        async let pull = feed.refresh()
        try await waitForWaiters(feed, 3)
        await feed.clear()
        api.release("p2")
        let (r0, r1, r2, r3) = try await (inFlight, next, poll, pull)
        XCTAssertEqual(api.recorded, [nil, "p2"], "nothing queued before the wipe is requested after it")
        XCTAssertTrue(r0.isEmpty && r1.isEmpty && r2.isEmpty && r3.isEmpty)
        let items = await feed.items
        let cursor = await feed.nextCursor
        XCTAssertTrue(items.isEmpty, "what was wiped does not come back")
        XCTAssertNil(cursor)
    }

    /// مهمة أُلغيت وهي تنتظر دورها (مهمة SwiftUI عند الاختفاء) لا تُرسل طلبها بعده، وتعود بالإلغاء لا بفشل.
    func testALoadCancelledWhileWaitingMakesNoRequest() async throws {
        let a = material()
        let api = SlowPagesAPI()
        api.pages[nil] = MaterialPage(items: [a], nextCursor: "p2")
        api.hold(nil)
        let feed = MaterialsFeed(api: api, pageSize: 1)
        async let first = feed.refresh()
        try await api.waitForCalls(1)
        let waiting = Task { try await feed.loadMore() }
        try await waitForWaiters(feed, 1)
        waiting.cancel()
        api.release(nil)
        _ = try await first
        do {
            _ = try await waiting.value
            XCTFail("a load cancelled while waiting reports its cancellation")
        } catch {
            XCTAssertTrue(LoadOutcome.isCancellation(error))
        }
        XCTAssertEqual(api.recorded, [nil])
    }
}

/// «الصفحة التالية» لا تدور ولا تفشل كذبًا (مراجعة الجودة الثالثة لـ #465): مادة من `reload(id:)` قبل أي صفحة كانت تُبقي القائمة
/// بلا مؤشر بعد الاستطلاع، فتعود «التالية» بلا طلب وتعيد المهمة نفسها بلا نهاية؛ والإلغاء كان يُسجَّل فشلًا.
final class MaterialsFeedPagingTests: XCTestCase {
    func testAPollAfterOnlyAReloadIsAFirstLoadThatSetsTheCursor() async throws {
        let m = material(), b = material(), c = material()
        let api = FakeMaterialsAPI()
        api.detail = m
        api.pages[nil] = MaterialPage(items: [m, b], nextCursor: "p2")
        api.pages["p2"] = MaterialPage(items: [c], nextCursor: nil)
        let feed = MaterialsFeed(api: api, pageSize: 2)
        // إشعار فُتح عند الإطلاق قبل أن تصل أي صفحة.
        try await feed.reload(id: m.id)
        let first = try await feed.refreshHead()
        XCTAssertEqual(first.map(\.id), [m.id, b.id])
        let cursor = await feed.nextCursor
        let end = await feed.reachedEnd
        XCTAssertEqual(cursor, "p2", "the first page's cursor is kept")
        XCTAssertFalse(end)
        let all = try await feed.loadMore()
        XCTAssertEqual(all.map(\.id), [m.id, b.id, c.id])
        XCTAssertEqual(api.calls, [nil, "p2"])
    }

    func testANextPageAfterOnlyAReloadLoadsTheFirstPage() async throws {
        let m = material(), b = material()
        let api = FakeMaterialsAPI()
        api.detail = m
        api.pages[nil] = MaterialPage(items: [b, m], nextCursor: "p2")
        let feed = MaterialsFeed(api: api, pageSize: 2)
        try await feed.reload(id: m.id)
        let first = try await feed.loadMore()
        XCTAssertEqual(first.map(\.id), [b.id, m.id], "a request is made, not an empty return")
        XCTAssertEqual(api.calls, [nil])
        let cursor = await feed.nextCursor
        XCTAssertEqual(cursor, "p2")
    }

    func testProgressChangesOnlyWhenAPageRequestIsMade() async throws {
        let a = material(), b = material()
        let api = FakeMaterialsAPI()
        api.pages[nil] = MaterialPage(items: [a], nextCursor: nil)
        api.detail = b
        let feed = MaterialsFeed(api: api)
        try await feed.refresh()
        let atEnd = await feed.progress
        try await feed.loadMore()
        try await feed.reload(id: b.id)
        let after = await feed.progress
        XCTAssertEqual(after, atEnd, "no page request, so the pager key is unchanged and its task does not restart")
        XCTAssertEqual(api.calls, [nil])
        XCTAssertFalse(after.wantsNextPage(pending: false))
        api.pages[nil] = MaterialPage(items: [a], nextCursor: "p2")
        try await feed.refresh()
        let moved = await feed.progress
        XCTAssertEqual(moved, PageProgress(cursor: "p2", reachedEnd: false, started: true))
    }

    func testTheNextPageIsWantedOnlyWithACursorAndNothingPendingOrFailed() {
        let ready = PageProgress(cursor: "p2", started: true)
        XCTAssertTrue(ready.wantsNextPage(pending: false))
        XCTAssertFalse(ready.wantsNextPage(pending: true), "a page already queued or running")
        XCTAssertFalse(PageProgress(reachedEnd: true, started: true).wantsNextPage(pending: false), "past the last page")
        // الحالة التي كانت تدور: صفحة بلا مؤشر ولا نهاية. لا طلب، فلا يتغيّر المفتاح ولا تعود المهمة.
        XCTAssertFalse(PageProgress(cursor: nil, reachedEnd: false, started: true).wantsNextPage(pending: false))
        XCTAssertTrue(PageProgress().wantsNextPage(pending: false), "before any page the next page is a first load")
        let failed = PageProgress(cursor: "p2", started: true, failed: true)
        XCTAssertFalse(failed.wantsNextPage(pending: false), "after a failure the automatic load stops")
        XCTAssertTrue(failed.wantsNextPage(pending: false, retry: true), "the «load more» button retries")
        XCTAssertFalse(failed.wantsNextPage(pending: true, retry: true))
    }

    func testCancellationIsNotAFailure() {
        XCTAssertTrue(LoadOutcome.isCancellation(CancellationError()))
        XCTAssertTrue(LoadOutcome.isCancellation(URLError(.cancelled)))
        XCTAssertTrue(LoadOutcome.isCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        // العميل المولَّد يلفّ الإلغاء في `ErrorResponse`.
        XCTAssertTrue(LoadOutcome.isCancellation(ErrorResponse.error(-3, nil, nil, CancellationError())))
        XCTAssertTrue(LoadOutcome.isCancellation(ErrorResponse.error(-999, nil, nil, URLError(.cancelled))))
        XCTAssertFalse(LoadOutcome.isCancellation(URLError(.notConnectedToInternet)))
        XCTAssertFalse(LoadOutcome.isCancellation(ErrorResponse.error(500, nil, nil, URLError(.badServerResponse))))
        XCTAssertFalse(LoadOutcome.isCancellation(ErrorResponse.error(-1, nil, nil, URLError(.timedOut))))
    }
}
