import XCTest
import PostHistoryAPI
@testable import UploadCore

final class UploadEngineTests: XCTestCase {
    struct Harness {
        let dir: URL
        let source: URL
        let bytes: Data
        let store = InMemoryUploadStateStore()
        let secrets = InMemoryUploadSecretStore()
        let api = FakeUploadAPI()
        let transport: FakeTransport
        let engine: UploadEngine
        var chunksDir: URL { dir.appendingPathComponent("chunks") }

        init(name: String, size: Int = 10, script: [FakeTransport.Behavior] = [], policy: ChunkSizePolicy = Fixtures.smallChunks,
             store: InMemoryUploadStateStore? = nil, secrets: InMemoryUploadSecretStore? = nil, dir: URL? = nil, environment: UploadEngine.Environment = .init(),
             ingest: (any IngestTokenProvider)? = nil, timing: UploadEngine.Timing = Fixtures.fastTiming) {
            self.dir = dir ?? Fixtures.tempDir(name)
            (source, bytes) = dir == nil ? Fixtures.sourceFile(in: self.dir, bytes: size) : (self.dir.appendingPathComponent("clip.mov"), try! Data(contentsOf: self.dir.appendingPathComponent("clip.mov")))
            transport = FakeTransport(script: script)
            let s = store ?? InMemoryUploadStateStore()
            let k = secrets ?? InMemoryUploadSecretStore()
            engine = UploadEngine(store: s, secrets: k, api: api, transport: transport, ingestTokens: ingest, slicer: ChunkSlicer(chunksDirectory: self.dir.appendingPathComponent("chunks")),
                                  policy: policy, timing: timing, environment: environment)
            _store = s; _secrets = k
        }
        private let _store: InMemoryUploadStateStore
        private let _secrets: InMemoryUploadSecretStore
        var sharedStore: InMemoryUploadStateStore { _store }
        var sharedSecrets: InMemoryUploadSecretStore { _secrets }

        func enqueue() async throws -> UploadRecord {
            await engine.resumeAll()
            return try await engine.enqueue(sourcePath: source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime")
        }

        var chunkFiles: [String] { (try? FileManager.default.contentsOfDirectory(atPath: chunksDir.path)) ?? [] }
    }

    func testHappyPathSlicesSequentiallyReportsHashAndShowsReceipt() async throws {
        let h = Harness(name: "happy")
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.serverBytes, h.bytes)
        XCTAssertEqual(h.transport.patches.map(\.offset), [0, 4, 8])
        XCTAssertEqual(h.transport.patches.map(\.length), [4, 4, 2])
        let sha = SHA256Stream.hex(of: h.bytes)
        XCTAssertEqual(h.api.createBodies.first?.clientSha256, sha)
        XCTAssertEqual(h.api.completeCalls, [sha])
        XCTAssertEqual(h.transport.creates.first?.metadata["upload_session_id"], h.api.sessionId.uuidString.lowercased())
        XCTAssertEqual(h.transport.creates.first?.length, 10)
        XCTAssertEqual(h.transport.creates.first?.token, h.api.token)
        XCTAssertTrue(h.chunkFiles.isEmpty, "chunk files are deleted once the server confirms them")
        XCTAssertNil(try h.sharedSecrets.token(for: rec.id), "the upload token is dropped after the receipt")
    }

    func testResumesFromServerOffsetAfterInterruptionMidChunk() async throws {
        // الجزء الثاني يصل منه بايت واحد ثم ينقطع الاتصال: يُستأنف من موضع الخادم (5) لا من بداية الجزء ولا من الصفر.
        let h = Harness(name: "partial", script: [.ok, .partial(1), .ok, .ok])
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.patches.map(\.offset), [0, 4, 5, 9])
        XCTAssertEqual(h.transport.serverBytes, h.bytes)
        XCTAssertEqual(h.transport.headCalls, 1)
        XCTAssertTrue(h.chunkFiles.isEmpty)
    }

    func testOffsetMismatchTriggersHeadAndRetry() async throws {
        let h = Harness(name: "mismatch", script: [.ok, .fail(.offsetMismatch), .ok, .ok])
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.patches.map(\.offset), [0, 4, 4, 8])
        XCTAssertEqual(h.transport.serverBytes, h.bytes)
    }

    func testKilledAppRelaunchesAndResumesFromLastConfirmedOffset() async throws {
        // المحاولة الأولى: الجزء الثاني يُجدوَل ثم "يُقتل" التطبيق (لا حدث). التشغيل الثاني من المخزن نفسه يستأنف من موضع الخادم.
        let first = Harness(name: "kill", script: [.ok, .hang])
        let rec = try await first.enqueue()
        let stuck = await first.engine.waitUntil(rec.id) { $0.inFlightOffset == 4 }
        XCTAssertEqual(stuck?.confirmedOffset, 4)
        XCTAssertEqual(first.chunkFiles.count, 2, "window of two prepared chunks on disk")

        let second = Harness(name: "kill", store: first.sharedStore, secrets: first.sharedSecrets, dir: first.dir)
        second.transport.created = true // the upload exists on the server across the relaunch
        second.transport.uploadURL = first.transport.uploadURL
        second.transport.serverBytes = first.transport.serverBytes
        second.transport.serverOffset = 4 // the killed task never reached the server
        await second.engine.resumeAll()
        let done = await second.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(second.transport.headCalls, 1)
        XCTAssertEqual(second.transport.patches.map(\.offset), [4, 8], "resumes at the confirmed offset, never from zero")
        XCTAssertEqual(second.transport.serverBytes, first.bytes)
        XCTAssertEqual(second.api.createBodies.count, 0, "no second upload session")
    }

    func testRelaunchWaitsForBackgroundTaskStillRunningThenContinues() async throws {
        let first = Harness(name: "bg", script: [.ok, .hang])
        let rec = try await first.enqueue()
        _ = await first.engine.waitUntil(rec.id) { $0.inFlightOffset == 4 }

        let second = Harness(name: "bg", store: first.sharedStore, secrets: first.sharedSecrets, dir: first.dir)
        second.transport.created = true // the upload exists on the server across the relaunch
        second.transport.uploadURL = first.transport.uploadURL
        second.transport.serverBytes = first.transport.serverBytes
        second.transport.serverOffset = 4
        second.transport.activeKeys = [TusTaskKey(uploadId: rec.id, offset: 4)]
        second.transport.pendingKeys = [TusTaskKey(uploadId: rec.id, offset: 4)]
        await second.engine.resumeAll()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(second.transport.patches.count, 0, "an in-flight background task is not resent")
        XCTAssertEqual(second.transport.headCalls, 0)
        await second.transport.finishHanging(accepting: first.bytes[4..<8])
        let done = await second.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(second.transport.patches.map(\.offset), [8])
        XCTAssertEqual(second.transport.serverBytes, first.bytes)
    }

    func testRebootThatClearsChunkFilesReslicesFromServerOffset() async throws {
        let first = Harness(name: "reboot", script: [.ok, .hang])
        let rec = try await first.enqueue()
        _ = await first.engine.waitUntil(rec.id) { $0.inFlightOffset == 4 }
        try FileManager.default.removeItem(at: first.chunksDir)

        let second = Harness(name: "reboot", store: first.sharedStore, secrets: first.sharedSecrets, dir: first.dir)
        second.transport.created = true // the upload exists on the server across the relaunch
        second.transport.uploadURL = first.transport.uploadURL
        second.transport.serverBytes = first.transport.serverBytes + first.bytes[4..<6]
        second.transport.serverOffset = 6 // the system delivered part of the chunk before the reboot
        await second.engine.resumeAll()
        let done = await second.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(second.transport.patches.map(\.offset), [6])
        XCTAssertEqual(second.transport.patches.map(\.length), [4])
        XCTAssertEqual(second.transport.serverBytes, first.bytes)
    }

    func testLostCreateResponseResumesByHeadOnDeterministicURL() async throws {
        // رد إنشاء tus ضاع بعد أن حجز الخادم الجلسة: الإنشاء الثاني يُرفض 403، فيُستأنف من HEAD على الرابط الحتمي لا الفشل كمنتهٍ.
        let h = Harness(name: "lostcreate")
        h.transport.createScript = [.lostResponse]
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.transport.creates.count, 2, "one retry, rejected by the server's single-create rule")
        XCTAssertEqual(done?.tusUploadURL, URL(string: "https://ingest.example.invalid/files/\(h.api.sessionId.uuidString.lowercased())"))
        XCTAssertEqual(h.transport.headCalls, 1)
        XCTAssertEqual(h.transport.serverBytes, h.bytes)
        XCTAssertEqual(h.api.createBodies.count, 1, "no second upload session")
    }

    func testGoneUploadFailsAsAbortedAndExpiredTokenAsExpired() async throws {
        let gone = Harness(name: "gone", script: [.fail(.gone)])
        let r1 = try await gone.enqueue()
        let d1 = await gone.engine.waitUntil(r1.id) { $0.phase.isTerminal }
        XCTAssertEqual(d1?.phase, .failed(.aborted))
        XCTAssertTrue(gone.chunkFiles.isEmpty)

        let expired = Harness(name: "expired", script: [.fail(.unauthorized)])
        let r2 = try await expired.enqueue()
        let d2 = await expired.engine.waitUntil(r2.id) { $0.phase.isTerminal }
        XCTAssertEqual(d2?.phase, .failed(.expired))
    }

    func testCompleteConflictOnTusdPathStillWaitsForVerification() async throws {
        let h = Harness(name: "conflict")
        h.api.completeError = .conflict
        h.api.states = [.in_progress_placeholder, .completed, .verified].compactMap { $0 }
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.api.completeCalls.count, 1)
        XCTAssertGreaterThanOrEqual(h.api.polls, 3)
    }

    func testServerChecksumMismatchAndDeduplication() async throws {
        let bad = Harness(name: "sha")
        bad.api.states = [.failed]; bad.api.failureReason = .checksumMismatch
        let r1 = try await bad.enqueue()
        let d1 = await bad.engine.waitUntil(r1.id) { $0.phase.isTerminal }
        XCTAssertEqual(d1?.phase, .failed(.checksumMismatch))

        let dup = Harness(name: "dup")
        dup.api.states = [.deduplicated]
        let r2 = try await dup.enqueue()
        let d2 = await dup.engine.waitUntil(r2.id) { $0.phase.isTerminal }
        XCTAssertEqual(d2?.phase, .deduplicated(duplicateOfFileId: UUID(uuidString: "11111111-1111-4111-8111-111111111111")))
    }

    func testTransientCreateErrorIsRetriedWithSameIdempotencyKey() async throws {
        let h = Harness(name: "retry")
        h.api.createFailuresBeforeSuccess = 2
        var events: [UploadEvent] = []
        let stream = await h.engine.events()
        let collector = Task { for await e in stream { events.append(e); if case .phaseChanged(_, let p) = e, p.isTerminal { break } } }
        let rec = try await h.enqueue()
        let done = await h.engine.waitUntil(rec.id) { $0.phase.isTerminal }
        _ = await collector.result
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(h.api.createBodies.count, 3)
        XCTAssertEqual(events.filter { if case .retryScheduled = $0 { return true } else { return false } }.count, 2)
        XCTAssertEqual(done?.attempt, 0, "attempt counter resets after progress")
    }

    func testCancelDiscardsChunksAndToken() async throws {
        let h = Harness(name: "cancel", script: [.hang])
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.inFlightOffset == 0 }
        await h.engine.cancel(rec.id)
        let r = await h.engine.record(rec.id)
        XCTAssertEqual(r?.phase, .cancelled)
        XCTAssertTrue(h.chunkFiles.isEmpty)
        XCTAssertNil(try h.sharedSecrets.token(for: rec.id))
        try await h.engine.remove(rec.id)
        let gone = await h.engine.record(rec.id)
        XCTAssertNil(gone)
    }

    func testFileStoreRoundTripAndNoSecretsInside() throws {
        let dir = Fixtures.tempDir("store")
        let store = try FileUploadStateStore(directory: dir)
        var rec = UploadRecord(materialId: UUID(), kind: .proxy, proxyMode: .urgent, sourcePath: "Uploads/a.mov", filename: "a.mov", mimeType: "video/mp4", sizeBytes: 123)
        rec.phase = .transferring
        rec.remote = RemoteSession(uploadSessionId: UUID(), tusEndpoint: URL(string: "https://ingest.example.invalid/files/")!, tusMetadata: ["upload_session_id": "x"], partSizeBytes: 16 << 20, checksumAlgorithm: "sha256", expiresAt: Date(), uploadTokenExpiresAt: Date())
        rec.prepared = [PreparedChunk(offset: 0, length: 64, fileName: "p.part")]
        try store.save(rec)
        let loaded = try store.loadAll()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.id, rec.id)
        XCTAssertEqual(loaded.first?.prepared, rec.prepared)
        XCTAssertEqual(loaded.first?.phase, .transferring)
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("\(rec.id.uuidString.lowercased()).json"))) as? [String: Any]
        func keys(_ any: Any) -> [String] {
            if let d = any as? [String: Any] { return d.keys.map { $0 } + d.values.flatMap(keys) }
            if let a = any as? [Any] { return a.flatMap(keys) }
            return []
        }
        XCTAssertFalse(keys(object as Any).contains { $0 == "uploadToken" || $0 == "token" }, "no token is persisted in the state file")
        try store.remove(id: rec.id)
        XCTAssertEqual(try store.loadAll().count, 0)
    }

    func testChunkSizePolicyAndPlanner() {
        let p = ChunkSizePolicy()
        XCTAssertEqual(p.chunkSize(background: false, measuredUplinkBytesPerSecond: 10_000_000), 8 << 20)
        XCTAssertEqual(p.chunkSize(background: true, measuredUplinkBytesPerSecond: nil), 64 << 20)
        XCTAssertEqual(p.chunkSize(background: true, measuredUplinkBytesPerSecond: 1_048_576), 120 << 20) // ~دقيقتان على 1 MiB/s
        XCTAssertEqual(p.chunkSize(background: true, measuredUplinkBytesPerSecond: 50_000), 64 << 20) // لا يقل عن الحد الأدنى
        XCTAssertEqual(p.chunkSize(background: true, measuredUplinkBytesPerSecond: 104_857_600), 512 << 20) // لا يتجاوز الحد الأقصى

        let plan = ChunkPlanner.chunksToPrepare(sizeBytes: 10, confirmedOffset: 4, chunkSize: 4, prepared: [], window: 2)
        XCTAssertEqual(plan.map(\.offset), [4, 8])
        XCTAssertEqual(plan.map(\.length), [4, 2])
        let prepared = [PreparedChunk(offset: 4, length: 4, fileName: "a"), PreparedChunk(offset: 8, length: 2, fileName: "b")]
        XCTAssertEqual(ChunkPlanner.reconcile(prepared: prepared, serverOffset: 8).keep.map(\.offset), [8])
        XCTAssertEqual(ChunkPlanner.reconcile(prepared: prepared, serverOffset: 5).keep.count, 0)
        XCTAssertEqual(ChunkPlanner.chunksToPrepare(sizeBytes: 10, confirmedOffset: 4, chunkSize: 4, prepared: prepared, window: 2).count, 0)
    }

    func testTusHeadersAndTaskKey() {
        let key = TusTaskKey(uploadId: UUID(), offset: 1234)
        XCTAssertEqual(TusTaskKey(key.description), key)
        XCTAssertNil(TusTaskKey("garbage"))
        let create = TusCreateRequest(endpoint: URL(string: "https://x.invalid/files/")!, token: "t", length: 1, metadata: ["upload_session_id": "abc", "filename": "IMG.MOV"])
        XCTAssertEqual(create.metadataHeader, "filename SU1HLk1PVg==,upload_session_id YWJj")
        XCTAssertEqual(TusError.fromStatus(409), .offsetMismatch)
        XCTAssertEqual(TusError.fromStatus(423), .locked)
        XCTAssertEqual(TusError.fromStatus(410), .gone)
        XCTAssertFalse(TusError.http(500).isRetryable)
        XCTAssertTrue(TusError.checksumMismatch.isRetryable)
    }

    func testStreamingSHA256MatchesKnownVector() throws {
        let dir = Fixtures.tempDir("sha")
        let url = dir.appendingPathComponent("abc.txt")
        try Data("abc".utf8).write(to: url)
        XCTAssertEqual(try SHA256Stream.hex(of: url), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(try SHA256Stream.base64(of: url, offset: 1, length: 2), Data(try SHA256Stream.digest(of: url, offset: 1, length: 2)).base64EncodedString())
        XCTAssertThrowsError(try SHA256Stream.base64(of: url, offset: 1, length: 5))
    }
}

private extension UploadSession.State {
    static var in_progress_placeholder: UploadSession.State? { .inProgress }
}

final class UploadWipeTests: XCTestCase {
    func testWipeAllCancelsTransfersAndRemovesStateChunksAndTokens() async throws {
        let h = UploadEngineTests.Harness(name: "wipe", script: [.hang])
        let rec = try await h.enqueue()
        _ = await h.engine.waitUntil(rec.id) { $0.inFlightOffset == 0 }
        XCTAssertFalse(h.chunkFiles.isEmpty)
        XCTAssertNotNil(try h.sharedSecrets.token(for: rec.id))
        XCTAssertEqual(h.transport.activeKeys.count, 1)

        let wiped = await h.engine.wipeAll()
        XCTAssertEqual(wiped, 1)
        XCTAssertTrue(h.chunkFiles.isEmpty, "chunk files removed")
        XCTAssertNil(try h.sharedSecrets.token(for: rec.id), "upload token removed")
        XCTAssertEqual(try h.sharedStore.loadAll().count, 0, "state removed")
        XCTAssertTrue(h.transport.activeKeys.isEmpty, "background transfer cancelled")
        let records = await h.engine.allRecords()
        XCTAssertTrue(records.isEmpty)
        // a late event from the cancelled task is ignored
        await h.transport.finishHanging(accepting: h.bytes[0..<4])
        let after = await h.engine.allRecords()
        XCTAssertTrue(after.isEmpty)
    }
}
