import XCTest
import PostHistoryAPI
@testable import UploadCore

/// إيقاف مؤقت واستئناف وإعادة محاولة من شاشة الرفع (المواصفة A2).
final class PauseRetryTests: XCTestCase {
    typealias Harness = UploadEngineTests.Harness

    func testPauseStopsNewPartsAndResumeContinuesFromTheServerOffset() async throws {
        let h = Harness(name: "pause", script: [.ok, .hang])
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.confirmedOffset == 4 && $0.inFlightOffset == 4 }
        await h.engine.pause(rec.id)
        let paused = await h.engine.record(rec.id)
        XCTAssertEqual(paused?.isPaused, true)
        XCTAssertNil(paused?.inFlightOffset)
        let patchesWhilePaused = h.transport.patches.count
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(h.transport.patches.count, patchesWhilePaused, "no part is scheduled while paused")
        XCTAssertTrue(h.transport.activeKeys.isEmpty, "the running part was cancelled")

        await h.engine.resume(rec.id)
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.serverBytes, h.bytes, "the cancelled part is sent again from the server offset, nothing lost")
        XCTAssertNil(done?.isPaused)
    }

    func testPausedRecordStaysPausedAcrossRelaunch() async throws {
        let store = InMemoryUploadStateStore()
        let first = Harness(name: "pause-relaunch", script: [.ok, .hang], store: store)
        let rec = try await first.enqueue()
        _ = await first.engine.waitUntil(rec.id) { $0.inFlightOffset == 4 }
        await first.engine.pause(rec.id)

        let relaunched = Harness(name: "pause-relaunch", store: store, secrets: first.sharedSecrets, dir: first.dir)
        await relaunched.engine.resumeAll()
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(relaunched.transport.patches.isEmpty, "a paused upload does not restart by itself")
        let after = await relaunched.engine.record(rec.id)
        XCTAssertEqual(after?.isPaused, true)
    }

    func testRetryAfterFailureStartsAFreshRecordForTheSameFile() async throws {
        let h = Harness(name: "retry", script: [.fail(.gone)])
        let rec = try await h.enqueue()
        let failed = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(failed?.phase, .failed(.aborted))

        let fresh = try await h.engine.retry(rec.id)
        XCTAssertNotNil(fresh)
        XCTAssertNotEqual(fresh?.id, rec.id)
        XCTAssertEqual(fresh?.materialId, rec.materialId)
        let old = await h.engine.record(rec.id)
        XCTAssertNil(old, "the failed record is removed")
        _ = await h.engine.waitUntil(fresh!.id) { $0.phase != .hashing }
        XCTAssertEqual(h.api.createBodies.count, 2, "a new session is created")
    }

    func testRetryIsRefusedWhenTheLocalCopyIsGone() async throws {
        let h = Harness(name: "retry-gone", script: [.fail(.gone)])
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        try FileManager.default.removeItem(at: h.source)
        let fresh = try await h.engine.retry(rec.id)
        XCTAssertNil(fresh)
    }
}
