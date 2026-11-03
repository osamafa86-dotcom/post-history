import XCTest
import UploadCore
@testable import MaterialsCore

/// الإيصال لصاحبه وحده (ADR 0093): يُعرض للحساب الداخل، وينتظر صاحبه إن كان لغيره أو والكل خارج، ويعود إلى الانتظار عند الخروج.
final class ReceiptInboxTests: XCTestCase {
    struct Target: Equatable, Sendable { let name: String }

    func testAReceiptForTheSignedInAccountIsShownAtOnce() {
        let a = UUID()
        var inbox = ReceiptInbox<Target>()
        XCTAssertEqual(inbox.arrive(Target(name: "r1"), owner: a, scope: AccountScope(current: a)), Target(name: "r1"))
        XCTAssertEqual(inbox.count, 0)
    }

    func testAReceiptForAnotherAccountWaitsForItsOwnerAndNobodyElse() {
        let a = UUID(), b = UUID()
        var inbox = ReceiptInbox<Target>()
        let whileB = AccountScope(current: b)
        XCTAssertNil(inbox.arrive(Target(name: "a1"), owner: a, scope: whileB), "B does not see A's receipt")
        XCTAssertNil(inbox.arrive(Target(name: "a2"), owner: a, scope: AccountScope()), "nor does anyone while signed out")
        XCTAssertNil(inbox.next(for: whileB))
        XCTAssertNil(inbox.next(for: AccountScope()))
        let whileA = AccountScope(current: a)
        XCTAssertEqual(inbox.next(for: whileA), Target(name: "a1"), "A gets them when A signs in, oldest first")
        XCTAssertEqual(inbox.next(for: whileA), Target(name: "a2"))
        XCTAssertNil(inbox.next(for: whileA))
    }

    func testAReceiptShownAtLogoutGoesBackToWaitOnceAndAWipeDropsAll() {
        let a = UUID(), b = UUID()
        var inbox = ReceiptInbox<Target>()
        inbox.hold(Target(name: "a1"), owner: a)
        inbox.hold(Target(name: "a1"), owner: a)
        XCTAssertEqual(inbox.count, 1, "the same receipt waits once")
        XCTAssertNil(inbox.next(for: AccountScope(current: b)))
        inbox.removeAll()
        XCTAssertNil(inbox.next(for: AccountScope(current: a)), "the emergency wipe leaves no receipt waiting")
    }

    func testAnOlderReceiptWithoutAnOwnerWaitsForTheSoleAccountOnly() {
        let a = UUID()
        var inbox = ReceiptInbox<Target>()
        XCTAssertNil(inbox.arrive(Target(name: "old"), owner: nil, scope: AccountScope(current: a, sole: nil)))
        XCTAssertNil(inbox.next(for: AccountScope(current: a, sole: nil)))
        XCTAssertEqual(inbox.next(for: AccountScope(current: a, sole: a)), Target(name: "old"))
    }
}
