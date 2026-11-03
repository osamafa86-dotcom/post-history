import XCTest
import PostHistoryAPI
@testable import UploadCore

/// الإلغاء (ADR 0113، كما في أندرويد ADR 0112): يوقف النقل الجاري، ولا يعود السجل الملغى بحدث متأخر، وتُنهى جلسته على الخادم
/// باسم صاحبها، وما تعذّر إرساله الآن يُحفظ ويُرسل لاحقًا.
final class CancelAbortTests: XCTestCase {
    typealias Harness = UploadEngineTests.Harness

    func testCancelStopsTheTransferEndsTheSessionAndIsNeverRewritten() async throws {
        let h = Harness(name: "cancel-abort", script: [.hang])
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.inFlightOffset == 0 }
        // The offset is set before the transport registers its task, so wait for the chunk to be really in flight.
        for _ in 0..<300 where h.transport.activeKeys.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(h.transport.activeKeys.count, 1)

        await h.engine.cancel(rec.id)
        XCTAssertTrue(h.transport.activeKeys.isEmpty, "the chunk in flight is cancelled")
        XCTAssertEqual(h.api.aborts.map(\.id), [h.api.sessionId], "DELETE /uploads/{id} for the session")
        XCTAssertEqual(h.api.aborts.first?.key, PendingAbort.idempotencyKey(forRecord: rec.id))
        let pending = await h.engine.pendingAborts()
        XCTAssertTrue(pending.isEmpty)

        // the system still delivers the cancelled task's success: it changes nothing
        await h.transport.finishHanging(accepting: h.bytes[0..<4])
        try await Task.sleep(nanoseconds: 100_000_000)
        let after = await h.engine.record(rec.id)
        XCTAssertEqual(after?.phase, .cancelled)
        XCTAssertEqual(try h.sharedStore.loadAll().first?.phase, .cancelled, "not rewritten on disk")
        XCTAssertEqual(h.transport.patches.count, 1, "no further chunk")
        XCTAssertTrue(h.api.completeCalls.isEmpty)
    }

    func testAbortThatCannotBeSentNowIsKeptAndSentLater() async throws {
        let h = Harness(name: "cancel-offline", script: [.hang])
        h.api.abortError = .transport // offline
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.inFlightOffset == 0 }
        await h.engine.cancel(rec.id)
        let kept = await h.engine.pendingAborts()
        XCTAssertEqual(kept.map(\.sessionId), [h.api.sessionId])

        h.api.abortError = .status(503)
        await h.engine.drainAborts()
        let stillKept = await h.engine.pendingAborts()
        XCTAssertEqual(stillKept.count, 1, "server trouble keeps it")

        h.api.abortError = nil // the network is back
        await h.engine.drainAborts()
        let none = await h.engine.pendingAborts()
        XCTAssertTrue(none.isEmpty)
        XCTAssertEqual(h.api.aborts.map(\.key), [PendingAbort.idempotencyKey(forRecord: rec.id)], "the same key on every attempt")
    }

    func testFinalAnswersDropTheAbort() async throws {
        for answer in [UploadAPIError.notFound, .conflict, .unauthorized, .status(400)] {
            let h = Harness(name: "cancel-final", script: [.hang])
            h.api.abortError = answer
            let rec = try await h.enqueue()
            _ = await h.engine.waitUntil(rec.id) { $0.inFlightOffset == 0 }
            await h.engine.cancel(rec.id)
            let left = await h.engine.pendingAborts()
            XCTAssertTrue(left.isEmpty, "\(answer) is the server's last word")
        }
    }

    /// ADR 0093: الطلب باسم صاحب السجل وحده؛ إلغاء سجل حساب خرج قبل أن يُرسل إجهاضه ينتظره.
    func testAbortWaitsForItsOwnerToSignIn() async throws {
        let h = Harness(name: "cancel-owner", script: [.hang])
        let owner = UUID(), other = UUID()
        await h.engine.resumeAll()
        await h.engine.setAccountScope(AccountScope(current: owner))
        let rec = try await h.engine.enqueue(sourcePath: h.source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime",
                                             ownerAccount: owner)
        _ = await h.engine.waitUntil(rec.id) { $0.inFlightOffset == 0 }
        await h.engine.setAccountScope(AccountScope(current: other)) // another reporter signs in on the shared phone
        await h.engine.cancel(rec.id)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(h.api.abortAttempts, 0, "not in another account's name")
        let kept = await h.engine.pendingAborts()
        XCTAssertEqual(kept.map(\.ownerAccount), [owner])

        await h.engine.setAccountScope(AccountScope(current: owner))
        let sent = await eventually { await h.engine.pendingAborts().isEmpty }
        XCTAssertTrue(sent)
        XCTAssertEqual(h.api.aborts.map(\.id), [h.api.sessionId])
    }

    /// إلغاء وصل والجلسة تُنشأ: الإلغاء لم يرَ الجلسة، فالخطوة التي أنشأتها تُجهضها ولا تحفظ رمزها.
    func testCancelWhileTheSessionIsBeingCreatedAbortsTheSessionItCreated() async throws {
        let h = Harness(name: "cancel-creating")
        let gate = Gate()
        h.api.createGate = gate
        let rec = try await h.enqueue()
        let suspended = await eventually { gate.arrived == 1 }
        XCTAssertTrue(suspended)
        await h.engine.cancel(rec.id)
        gate.open()

        let aborted = await eventually { h.api.aborts.count == 1 }
        XCTAssertTrue(aborted)
        XCTAssertEqual(h.api.aborts.first?.id, h.api.sessionId)
        let after = await h.engine.record(rec.id)
        XCTAssertEqual(after?.phase, .cancelled)
        XCTAssertNil(try h.sharedSecrets.token(for: rec.id))
        XCTAssertTrue(h.transport.creates.isEmpty, "no tus upload for a cancelled record")
    }

    func testNoAbortForARecordWithoutASessionAndWipeForgetsKeptOnes() async throws {
        let first = Harness(name: "cancel-nosession")
        let gate = Gate()
        first.api.createGate = gate
        first.api.createError = .status(400)
        let rec = try await first.enqueue()
        _ = await eventually { gate.arrived == 1 }
        // no session yet, and the request that would have made one is refused: nothing on the server to end
        await first.engine.cancel(rec.id)
        gate.open()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(first.api.abortAttempts, 0)

        let h = Harness(name: "cancel-wipe", script: [.hang])
        h.api.abortError = .transport
        let r2 = try await h.enqueue()
        _ = await h.engine.waitUntil(r2.id) { $0.inFlightOffset == 0 }
        await h.engine.cancel(r2.id)
        let kept = await h.engine.pendingAborts()
        XCTAssertEqual(kept.count, 1)
        _ = await h.engine.wipeAll()
        let afterWipe = await h.engine.pendingAborts()
        XCTAssertTrue(afterWipe.isEmpty, "the emergency wipe leaves no trace of the session on the phone")
    }

    func testFileAbortStoreKeepsOneEntryPerSessionOldestFirstAndIsNotARecordFile() throws {
        let dir = Fixtures.tempDir("aborts")
        let store = FileAbortStore(fileURL: dir.appendingPathComponent("pending-aborts"))
        let a = PendingAbort(sessionId: UUID(), ownerAccount: UUID(), idempotencyKey: "k-a", createdAt: Date(timeIntervalSince1970: 2))
        let b = PendingAbort(sessionId: UUID(), ownerAccount: nil, idempotencyKey: "k-b", createdAt: Date(timeIntervalSince1970: 1))
        try store.add(a)
        try store.add(b)
        try store.add(a)
        XCTAssertEqual(try store.all(), [b, a])
        try store.remove(sessionId: b.sessionId)
        XCTAssertEqual(try FileAbortStore(fileURL: store.fileURL).all(), [a], "survives a relaunch")
        let records = try FileUploadStateStore(directory: dir).loadAll()
        XCTAssertTrue(records.isEmpty, "the upload state store does not read it as a record")
        try store.removeAll()
        XCTAssertTrue(try store.all().isEmpty)
    }
}
