import XCTest
import PostHistoryAPI
@testable import MaterialsCore

/// ما يعرضه «موادي» لا يعود بعد المسح أو الخروج (ملاحظة المراجعة الرابعة لـ #465): تحميل أعاد قائمته قبل `MaterialsFeed.clear()` كان
/// يكتبها في النموذج بعد المسح ويكتب لها «آخر تحديث».
final class MaterialsListStateTests: XCTestCase {
    func testALoadThatReturnedJustBeforeTheWipeIsDroppedAfterIt() async throws {
        // السباق نفسه: الصفحة عادت من المحمّل، ثم مُسحت القائمة والمحمّل، ثم وصلت النتيجة إلى الكتابة.
        let a = material(), b = material()
        let api = FakeMaterialsAPI()
        api.pages[nil] = MaterialPage(items: [a, b], nextCursor: "p2")
        let feed = MaterialsFeed(api: api, pageSize: 2)
        var state = MaterialsListState()
        let ticket = state.ticket()
        let fresh = try await feed.refresh()
        XCTAssertEqual(fresh.map(\.id), [a.id, b.id])
        state.clear()
        await feed.clear()
        let progress = await feed.progress
        let applied = state.settle(ticket, .success(fresh), progress: progress, updatedAt: Date())
        XCTAssertFalse(applied)
        XCTAssertTrue(state.items.isEmpty, "the previous reporter's list does not come back")
        XCTAssertNil(state.lastUpdated, "no «last updated» for a wiped list")
        XCTAssertEqual(state.pages, PageProgress())
    }

    func testAFailureOrAReloadFromBeforeTheWipeLeavesTheNewListAlone() {
        let a = material()
        var state = MaterialsListState()
        let before = state.ticket()
        state.clear()
        XCTAssertFalse(state.settle(before, .failure(URLError(.notConnectedToInternet)), progress: PageProgress()))
        XCTAssertFalse(state.pages.failed, "an old failure does not mark the new list as failed")
        XCTAssertFalse(state.replaceItems(before, with: [a]), "a material reloaded before the wipe is not written back")
        XCTAssertTrue(state.items.isEmpty)
        XCTAssertFalse(state.accepts(before))
    }

    func testALoadStartedAfterTheWipeIsWritten() {
        let a = material()
        var state = MaterialsListState()
        state.clear()
        let after = state.ticket()
        let now = Date()
        XCTAssertTrue(state.settle(after, .success([a]), progress: PageProgress(cursor: "p2", started: true), updatedAt: now))
        XCTAssertEqual(state.items.map(\.id), [a.id])
        XCTAssertEqual(state.lastUpdated, now)
        XCTAssertEqual(state.pages, PageProgress(cursor: "p2", started: true))
    }

    func testSettleKeepsTheListOnFailureAndIgnoresCancellation() {
        let a = material(), b = material()
        var state = MaterialsListState()
        let first = Date(timeIntervalSince1970: 1_000)
        state.settle(state.ticket(), .success([a]), progress: PageProgress(cursor: "p2", started: true), updatedAt: first)
        // الصفحة التالية لا تكتب «آخر تحديث».
        state.settle(state.ticket(), .success([a, b]), progress: PageProgress(cursor: "p3", started: true))
        XCTAssertEqual(state.lastUpdated, first)
        state.settle(state.ticket(), .failure(URLError(.timedOut)), progress: PageProgress(cursor: "p3", started: true))
        XCTAssertEqual(state.items.map(\.id), [a.id, b.id], "a failure keeps what is shown")
        XCTAssertTrue(state.pages.failed)
        state.settle(state.ticket(), .failure(CancellationError()), progress: PageProgress(cursor: "p3", started: true))
        XCTAssertTrue(state.pages.failed, "a cancellation neither clears nor sets the failure")
        state.settle(state.ticket(), .success([a, b]), progress: PageProgress(cursor: "p3", started: true))
        XCTAssertFalse(state.pages.failed, "a success clears it")
        state.settle(state.ticket(), .failure(ErrorResponse.error(-3, nil, nil, CancellationError())),
                     progress: PageProgress(cursor: "p3", started: true))
        XCTAssertFalse(state.pages.failed)
    }
}
