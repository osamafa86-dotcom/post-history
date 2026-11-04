import XCTest
import PostHistoryAPI
import UploadCore
@testable import MaterialsCore

/// ساعة يدوية: الوقت لا يتقدّم إلا بطلب الاختبار.
private final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func bump() { lock.withLock { count += 1 } }
}

/// ما يمر به يُعلَّق حتى `open()` (طلب في الطريق).
private final class Latch: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var arrivals = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    var arrived: Int { lock.withLock { arrivals } }

    func wait() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let now = lock.withLock { () -> Bool in
                arrivals += 1
                if isOpen { return true }
                waiters.append(c)
                return false
            }
            if now { c.resume() }
        }
    }

    func open() {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            isOpen = true
            defer { waiters = [] }
            return waiters
        }
        pending.forEach { $0.resume() }
    }
}

private struct Offline: Error {}

final class RefreshGateTests: XCTestCase {
    /// بناء TestFlight 13: الرئيسية تعيد التحديث مع كل تغيّر حالة تراقبه، والتحديث نفسه يغيّر تلك الحالة (اسم العمل، «جارٍ
    /// التحميل»، القائمة)، فكل دورة تطلق التي بعدها: نحو 76 زوجًا من `GET /auth/me` و`GET /materials` في ثانية. بلا باب يبلغ هذا
    /// الاختبار حدّه (100 دورة، 101 زوج) ويفشل؛ بالباب يُرسل زوج واحد وتهدأ الحلقة في الدورة الثانية.
    func testAHomeThatRefreshesOnEveryStateChangeItCausesSendsOnePairAndSettles() async {
        let clock = ManualClock()
        let profile = RefreshGate(now: { clock.now() })
        let materials = RefreshGate(now: { clock.now() })
        let me = Counter(), list = Counter(), published = Counter()

        // مهمة الرئيسية: الملف الشخصي ثم «موادي»؛ كل ردّ ينشر حالة تراقبها الرئيسية (والقائمة فارغة لحساب بلا مواد).
        func homeTask() async {
            await profile.run(.ifStale) { me.bump(); published.bump() }
            await materials.run(.ifStale) { list.bump(); published.bump() }
        }

        // SwiftUI كما في البناء: كل تغيّر منشور يعيد المهمة، حتى حدّ يمنع الاختبار من الدوران بلا نهاية.
        var reruns = 0
        var seen = published.value
        await homeTask()
        while published.value != seen, reruns < 100 {
            seen = published.value
            reruns += 1
            await homeTask()
        }

        XCTAssertEqual(me.value, 1, "one GET /auth/me, not one per state change")
        XCTAssertEqual(list.value, 1, "one GET /materials, even for an empty list")
        XCTAssertEqual(reruns, 1, "the second run finds both fresh, publishes nothing, and the loop ends")
    }

    /// الرئيسية تظهر وتختفي في الإطار نفسه مرات (عودة بعد غطاء الإرسال): 76 دعوة متزامنة وطلب واحد يشتركن فيه.
    func testConcurrentCallsWhileARequestIsInFlightShareIt() async {
        let gate = RefreshGate()
        let latch = Latch()
        let calls = Counter()
        let outcomes: [RefreshGate.Outcome] = await withTaskGroup(of: RefreshGate.Outcome.self) { group in
            for _ in 0..<76 {
                group.addTask { await gate.run(.ifStale) { calls.bump(); await latch.wait() } }
            }
            while latch.arrived == 0 { await Task.yield() }
            // الدعوات الباقية وصلت الباب قبل أن يعود الطلب.
            try? await Task.sleep(nanoseconds: 50_000_000)
            latch.open()
            var all: [RefreshGate.Outcome] = []
            for await o in group { all.append(o) }
            return all
        }
        XCTAssertEqual(calls.value, 1)
        let sent = await gate.sent
        XCTAssertEqual(sent, 1)
        XCTAssertEqual(outcomes.filter { $0 == .fetched }.count, 1)
        XCTAssertEqual(outcomes.filter { $0 == .joined }.count + outcomes.filter { $0 == .fresh }.count, 75)
    }

    func testAFreshResultIsReusedUntilItAgesEvenWhenTheListIsEmpty() async {
        let clock = ManualClock()
        let gate = RefreshGate(policy: .init(freshFor: 30), now: { clock.now() })
        let calls = Counter()
        let first = await gate.run(.ifStale) { calls.bump() }
        XCTAssertEqual(first, .fetched)
        clock.advance(29)
        let again = await gate.run(.ifStale) { calls.bump() }
        XCTAssertEqual(again, .fresh)
        clock.advance(2)
        let aged = await gate.run(.ifStale) { calls.bump() }
        XCTAssertEqual(aged, .fetched)
        XCTAssertEqual(calls.value, 2)
    }

    func testFailuresBackOffLongerEachTimeAndASuccessClearsIt() async {
        let clock = ManualClock()
        let gate = RefreshGate(policy: .init(freshFor: 30, backoff: [2, 5, 15]), now: { clock.now() })
        let calls = Counter()
        let failing: @Sendable () async throws -> Void = { calls.bump(); throw Offline() }

        let first = await gate.run(.ifStale, failing)
        XCTAssertEqual(first, .failed)
        // كل ظهور في المهلة لا يرسل شيئًا: لا عاصفة إعادة بلا انتظار.
        for _ in 0..<50 {
            let held = await gate.run(.ifStale, failing)
            XCTAssertEqual(held, .backingOff)
        }
        clock.advance(1.9)
        let stillHeld = await gate.run(.poll, failing)
        XCTAssertEqual(stillHeld, .backingOff, "the periodic poll waits for the backoff too")
        clock.advance(0.2)
        let second = await gate.run(.ifStale, failing)
        XCTAssertEqual(second, .failed)
        let failures = await gate.consecutiveFailures
        XCTAssertEqual(failures, 2)
        clock.advance(4.9)
        let heldLonger = await gate.run(.ifStale, failing)
        XCTAssertEqual(heldLonger, .backingOff, "the second backoff is longer than the first")
        clock.advance(0.2)
        let recovered = await gate.run(.ifStale) { calls.bump() }
        XCTAssertEqual(recovered, .fetched)
        let cleared = await gate.retryAfter
        XCTAssertNil(cleared)
        let fresh = await gate.run(.ifStale, failing)
        XCTAssertEqual(fresh, .fresh)
        XCTAssertEqual(calls.value, 3, "two failures and one success, nothing in between")
    }

    func testTheLastBackoffRepeats() {
        let policy = RefreshGate.Policy(backoff: [2, 5])
        XCTAssertEqual(policy.delay(afterFailures: 1), 2)
        XCTAssertEqual(policy.delay(afterFailures: 2), 5)
        XCTAssertEqual(policy.delay(afterFailures: 9), 5)
    }

    func testPollIgnoresFreshnessAndTheUserIgnoresTheBackoff() async {
        let clock = ManualClock()
        let gate = RefreshGate(now: { clock.now() })
        let calls = Counter()
        _ = await gate.run(.ifStale) { calls.bump() }
        let polled = await gate.run(.poll) { calls.bump() }
        XCTAssertEqual(polled, .fetched)
        _ = await gate.run(.poll) { calls.bump(); throw Offline() }
        let pulled = await gate.run(.user) { calls.bump() }
        XCTAssertEqual(pulled, .fetched, "pull to refresh is the reporter's own request")
        XCTAssertEqual(calls.value, 4)
    }

    func testCancellationIsNeitherAFailureNorASuccess() async {
        let gate = RefreshGate()
        let calls = Counter()
        let cancelled = await gate.run(.ifStale) { calls.bump(); throw CancellationError() }
        XCTAssertEqual(cancelled, .cancelled)
        let failures = await gate.consecutiveFailures
        XCTAssertEqual(failures, 0)
        let next = await gate.run(.ifStale) { calls.bump() }
        XCTAssertEqual(next, .fetched, "no backoff and nothing fresh after a cancellation")
        XCTAssertEqual(calls.value, 2)
    }

    /// الخروج أثناء طلب: ردّه لا يجعل الباب طازجًا لمن يدخل بعده، ولا تبقى مهلة فشل لحسابه.
    func testResetDropsTheInFlightResultAndForgetsFreshnessAndBackoff() async {
        let clock = ManualClock()
        let gate = RefreshGate(now: { clock.now() })
        let latch = Latch()
        let calls = Counter()
        _ = await gate.run(.ifStale) { calls.bump(); throw Offline() }
        let held = await gate.run(.ifStale) { calls.bump() }
        XCTAssertEqual(held, .backingOff)
        await gate.reset()
        let pending = Task { await gate.run(.ifStale) { calls.bump(); await latch.wait() } }
        while latch.arrived == 0 { await Task.yield() }
        await gate.reset()
        latch.open()
        let dropped = await pending.value
        XCTAssertEqual(dropped, .dropped)
        let next = await gate.run(.ifStale) { calls.bump() }
        XCTAssertEqual(next, .fetched, "the dropped reply did not make the gate fresh")
        XCTAssertEqual(calls.value, 3)
    }
}

final class SendAccessTests: XCTestCase {
    func testOnlyAReporterRoleSendsFromTheApp() {
        XCTAssertEqual(SendAccess(roles: [.reporter]), .reporter)
        XCTAssertEqual(SendAccess(roles: [.supervisor, .reporter]), .reporter)
        // حساب المشرف التجريبي في البلاغ: supervisor:office بلا دور مراسل.
        XCTAssertEqual(SendAccess(roles: [.supervisor]), .notReporter)
        XCTAssertEqual(SendAccess(roles: [.producer, .editorInChief]), .notReporter)
        XCTAssertEqual(SendAccess(roles: []), .notReporter)
        XCTAssertEqual(SendAccess(roles: [.unknownDefaultOpenApi]), .notReporter)
        XCTAssertTrue(SendAccess.reporter.canSend)
        XCTAssertFalse(SendAccess.notReporter.canSend)
    }

    /// «الحساب لا يرفع» و«تعذّر إثبات الجهاز» سببان بنصّين لا يُخلطان.
    func testTheRoleAndTheAttestationFailuresHaveTheirOwnText() {
        XCTAssertEqual(UploadFailure.notPermitted.textKey, "upload.failure.notPermitted")
        XCTAssertEqual(UploadFailure.deviceNotAttested.textKey, "upload.failure.deviceNotAttested")
        XCTAssertNotEqual(UploadFailure.notPermitted.textKey, UploadFailure.deviceNotAttested.textKey)
        XCTAssertTrue(TextKeys.all.contains(SendAccess.notReporterKey))
        XCTAssertTrue(TextKeys.all.contains(SendAccess.notReporterTitleKey))
    }
}
