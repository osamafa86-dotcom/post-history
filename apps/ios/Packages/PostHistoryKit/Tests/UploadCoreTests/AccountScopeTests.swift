import XCTest
import PostHistoryAPI
@testable import UploadCore

/// سجلات الرفع لصاحبها وحده (ADR 0091): لا تُعرض لحساب آخر، ولا تُرسل طلباتها المصادَق عليها باسم غيره؛ تنتظر صاحبها ونقل tus يكمل.
final class AccountScopeTests: XCTestCase {
    typealias Harness = UploadEngineTests.Harness

    private func record(owner: UUID?, phase: UploadPhase = .transferring, kind: UploadSessionCreate.Kind = .original) -> UploadRecord {
        var r = UploadRecord(materialId: UUID(), kind: kind, sourcePath: "Uploads/a.mov", filename: "a.mov", mimeType: "video/quicktime", sizeBytes: 10)
        r.ownerAccount = owner
        r.phase = phase
        return r
    }

    private func enqueue(_ h: Harness, owner: UUID?) async throws -> UploadRecord {
        await h.engine.resumeAll()
        return try await h.engine.enqueue(sourcePath: h.source.path, materialId: UUID(), kind: .original, filename: "clip.mov",
                                          mimeType: "video/quicktime", ownerAccount: owner)
    }

    private func waitForOwner(_ h: Harness, _ id: UUID) async -> Bool {
        for _ in 0..<400 {
            if await h.engine.waitingForOwner().contains(id) { return true }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return false
    }

    // MARK: القاعدة

    func testARecordBelongsOnlyToItsOwnerAndOldRecordsOnlyToTheSoleAccount() {
        let a = UUID(), b = UUID()
        XCTAssertTrue(AccountScope(current: a, sole: nil).owns(a))
        XCTAssertFalse(AccountScope(current: b, sole: nil).owns(a), "another account's record")
        XCTAssertFalse(AccountScope(current: nil, sole: a).owns(a), "nobody signed in")
        // سجل من إصدار سابق بلا مالك.
        XCTAssertTrue(AccountScope(current: a, sole: a).owns(nil), "the only account that ever signed in on the device")
        XCTAssertFalse(AccountScope(current: a, sole: nil).owns(nil), "more than one account signed in: hidden from all")
        XCTAssertFalse(AccountScope(current: nil, sole: a).owns(nil))
    }

    func testOnlyTheSignedInAccountsRecordsAreShownAndCounted() {
        let a = UUID(), b = UUID()
        let mine = record(owner: a), theirs = record(owner: b), old = record(owner: nil)
        let done = record(owner: a, phase: .verified(receiptNumber: "R-1")), proxy = record(owner: a, kind: .proxy)
        let all = [mine, theirs, old, done, proxy]
        XCTAssertEqual(AccountScope(current: a).visible(all).map(\.id), [mine.id, done.id, proxy.id])
        XCTAssertEqual(AccountScope(current: a, sole: a).visible(all).map(\.id), [mine.id, old.id, done.id, proxy.id])
        XCTAssertEqual(AccountScope(current: b).visible(all).map(\.id), [theirs.id])
        XCTAssertTrue(AccountScope().visible(all).isEmpty, "signed out: nothing is shown")
        XCTAssertEqual(AccountScope(current: a).pendingOriginals(all), 1, "only this account's unfinished originals")
        XCTAssertEqual(AccountScope(current: b).pendingOriginals(all), 1)
        XCTAssertEqual(AccountScope().pendingOriginals(all), 0)
    }

    func testOldRecordsDecodeWithoutAnOwner() throws {
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record(owner: UUID()))) as! [String: Any]
        json["ownerAccount"] = nil
        let decoded = try JSONDecoder().decode(UploadRecord.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.ownerAccount)
    }

    // MARK: المعرّف المحلي

    func testEachAccountGetsAStableOpaqueLocalIdAndTheSoleOneIsKnown() throws {
        let serverA = UUID(), serverB = UUID()
        var accounts = LocalAccounts()
        XCTAssertNil(accounts.sole)
        XCTAssertEqual(accounts.scope(signedIn: serverA), AccountScope(), "an account that never signed in has no local id")
        let a = accounts.register(serverAccount: serverA)
        XCTAssertNotEqual(a, serverA, "the local id is not the server id")
        XCTAssertEqual(accounts.register(serverAccount: serverA), a, "the same account keeps its local id")
        XCTAssertEqual(accounts.sole, a)
        XCTAssertEqual(accounts.scope(signedIn: serverA), AccountScope(current: a, sole: a))
        let b = accounts.register(serverAccount: serverB)
        XCTAssertNotEqual(a, b)
        XCTAssertNil(accounts.sole, "two accounts: old records belong to neither")
        XCTAssertEqual(accounts.scope(signedIn: serverB), AccountScope(current: b, sole: nil))
        XCTAssertEqual(accounts.scope(signedIn: nil), AccountScope(current: nil, sole: nil))
        XCTAssertEqual(accounts.count, 2)
    }

    func testTheAccountsFileHoldsOnlyADigestOfTheServerId() throws {
        let dir = Fixtures.tempDir("accounts")
        let store = LocalAccountsStore(fileURL: dir.appendingPathComponent("local-accounts"))
        var accounts = try XCTUnwrap(store.load(), "a missing file is an empty registry")
        let serverA = UUID()
        let a = accounts.register(serverAccount: serverA)
        try store.save(accounts)
        let text = try String(contentsOf: store.fileURL, encoding: .utf8)
        XCTAssertFalse(text.lowercased().contains(serverA.uuidString.lowercased()), "the server id is stored only as a salted digest")
        XCTAssertEqual(try XCTUnwrap(store.load()).localId(serverAccount: serverA), a)
        XCTAssertNotEqual(store.fileURL.pathExtension, "json", "the upload state store reads every JSON file in its folder as a record")
        try Data("not json".utf8).write(to: store.fileURL)
        XCTAssertNil(store.load(), "an unreadable file is not replaced by an empty registry")
    }

    // MARK: النواة

    func testAnotherAccountsRecordWaitsWithoutRequestingThenResumesForItsOwner() async throws {
        let a = UUID(), b = UUID()
        let h = Harness(name: "owner-waits")
        await h.engine.setAccountScope(AccountScope(current: b))
        let rec = try await enqueue(h, owner: a)
        let waiting = await waitForOwner(h, rec.id)
        XCTAssertTrue(waiting)
        let parked = await h.engine.record(rec.id)
        XCTAssertEqual(parked?.phase, .creatingSession, "hashed locally, then waits: not failed")
        XCTAssertEqual(parked?.attempt, 0, "no retry is spent")
        XCTAssertTrue(h.api.createBodies.isEmpty, "no upload session is created with another account's credentials")
        await h.engine.setAccountScope(AccountScope(current: a))
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.api.createBodies.count, 1)
    }

    func testTheTransferContinuesAfterLogoutAndOnlyTheServerStepsWaitForTheOwner() async throws {
        let a = UUID()
        let h = Harness(name: "owner-transfer", script: [.hang])
        await h.engine.setAccountScope(AccountScope(current: a, sole: a))
        let rec = try await enqueue(h, owner: a)
        for _ in 0..<400 where h.transport.patches.isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }
        // الخروج والجزء الأول في الطريق.
        await h.engine.setAccountScope(AccountScope(current: nil, sole: a))
        await h.transport.finishHanging(accepting: h.bytes.prefix(4))
        let waiting = await waitForOwner(h, rec.id)
        XCTAssertTrue(waiting)
        XCTAssertEqual(h.transport.serverBytes, h.bytes, "the tus transfer with the upload token went on")
        XCTAssertTrue(h.api.completeCalls.isEmpty, "the authenticated steps wait for the owner")
        XCTAssertEqual(h.api.polls, 0)
        let parked = await h.engine.record(rec.id)
        XCTAssertEqual(parked?.phase, .completing)
        await h.engine.setAccountScope(AccountScope(current: a, sole: a))
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
    }

    func testTheIngestTokenIsNotRequestedForAnotherAccount() async throws {
        let a = UUID(), b = UUID()
        let tokens = FakeIngestTokens()
        let h = Harness(name: "owner-ingest", script: [.hang], ingest: tokens)
        h.api.ingestTokenRequired = true
        h.transport.validIngestToken = "ingest-1"
        await h.engine.setAccountScope(AccountScope(current: a))
        let rec = try await enqueue(h, owner: a)
        for _ in 0..<400 where h.transport.patches.isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(tokens.issued, 1)
        await h.engine.setAccountScope(AccountScope(current: b))
        await h.transport.finishHanging(accepting: h.bytes.prefix(4))
        let waiting = await waitForOwner(h, rec.id)
        XCTAssertTrue(waiting, "the next chunk needs a gateway token in the owner's name")
        XCTAssertEqual(tokens.issued, 1, "no gateway token is requested with another account's credentials")
        await h.engine.setAccountScope(AccountScope(current: a))
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.serverBytes, h.bytes)
    }

    func testAnOldRecordWithoutAnOwnerRequestsOnlyForTheSoleAccount() async throws {
        let a = UUID()
        let h = Harness(name: "owner-legacy")
        await h.engine.setAccountScope(AccountScope(current: a, sole: nil))
        let rec = try await enqueue(h, owner: nil)
        let waiting = await waitForOwner(h, rec.id)
        XCTAssertTrue(waiting, "two accounts have signed in: nobody's credentials are used for it")
        XCTAssertTrue(h.api.createBodies.isEmpty)
        await h.engine.setAccountScope(AccountScope(current: a, sole: a))
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
    }

    func testRetryKeepsTheOwnerAndNoScopeMeansNoGate() async throws {
        let a = UUID()
        let h = Harness(name: "owner-retry")
        h.api.createError = .status(400)
        let rec = try await enqueue(h, owner: a)
        let failed = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(failed?.phase, .failed(.rejected), "without a scope (tests, before the app sets one) nothing waits")
        h.api.createError = nil
        let fresh = try await h.engine.retry(rec.id)
        XCTAssertEqual(fresh?.ownerAccount, a)
    }
}
