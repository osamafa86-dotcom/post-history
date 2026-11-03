import XCTest
import PostHistoryAPI
@testable import UploadCore

/// خادم tus محاكى لعدة رفوع: لكل رفع رابطه وموضعه. `holding`: نتائج PATCH تُمسك حتى `releaseHeld()` (جزء في الطريق).
final class MultiUploadTransport: TusTransport, @unchecked Sendable {
    let lock = NSLock()
    weak var delegate: TusTransportDelegate?
    private var lengths: [URL: Int64] = [:]
    private var offsets: [URL: Int64] = [:]
    /// أكثر عدد رفوع مفتوحة (أُنشئت ولم تكتمل على الخادم) لحظة كل إنشاء.
    private(set) var maxOpen = 0
    /// روابط PATCH بترتيب وصولها.
    private(set) var patchLog: [URL] = []
    var holding = false
    private var held: [(TusTaskKey, TusPatchOutcome)] = []

    func setDelegate(_ delegate: TusTransportDelegate?) async { lock.withLock { self.delegate = delegate } }

    func createUpload(_ request: TusCreateRequest) async throws -> URL {
        lock.withLock {
            let url = request.endpoint.appendingPathComponent(request.metadata["upload_session_id"] ?? UUID().uuidString.lowercased())
            lengths[url] = request.length
            offsets[url] = 0
            maxOpen = max(maxOpen, lengths.filter { offsets[$0.key, default: 0] < $0.value }.count)
            return url
        }
    }

    func currentOffset(uploadURL: URL, token: String, ingestToken: String?) async throws -> Int64 {
        try lock.withLock {
            guard let offset = offsets[uploadURL] else { throw TusError.gone }
            return offset
        }
    }

    func schedulePatch(_ request: TusPatchRequest) async throws {
        let data = try Data(contentsOf: request.chunkFile)
        let (target, outcome): (TusTransportDelegate?, TusPatchOutcome?) = lock.withLock {
            patchLog.append(request.uploadURL)
            let current = offsets[request.uploadURL, default: 0]
            let outcome: TusPatchOutcome
            if request.chunk.offset != current {
                outcome = .failed(.offsetMismatch)
            } else {
                offsets[request.uploadURL] = current + Int64(data.count)
                outcome = .completed(newOffset: current + Int64(data.count))
            }
            if holding { held.append((request.key, outcome)); return (delegate, nil) }
            return (delegate, outcome)
        }
        if let outcome { Task { await target?.patchDidFinish(request.key, outcome) } }
    }

    func releaseHeld() async {
        let (target, pending): (TusTransportDelegate?, [(TusTaskKey, TusPatchOutcome)]) = lock.withLock {
            holding = false
            defer { held = [] }
            return (delegate, held)
        }
        for (key, outcome) in pending { await target?.patchDidFinish(key, outcome) }
    }

    var heldCount: Int { lock.withLock { held.count } }
    func activePatchKeys() async -> Set<TusTaskKey> { [] }
    func cancel(uploadId: UUID) async {}
}

/// خادم `/uploads` محاكى بجلسة جديدة لكل مادة، يتحقق من الأصل فور السؤال عن الإيصال.
final class SequentialUploadAPI: UploadAPI, @unchecked Sendable {
    let lock = NSLock()
    /// مواد الجلسات بترتيب إنشائها.
    private(set) var createdMaterials: [UUID] = []
    private var sessions: [UUID: UUID] = [:]

    func createSession(idempotencyKey: String, _ body: UploadSessionCreate) async throws -> UploadSessionCreated {
        let id = UUID()
        lock.withLock { createdMaterials.append(body.materialId); sessions[id] = body.materialId }
        return UploadSessionCreated(id: id, materialId: body.materialId, kind: body.kind == .proxy ? .proxy : .original, state: .created, sizeBytes: body.sizeBytes,
                                    tusEndpoint: "https://ingest.example.invalid/files/", tusMetadata: UploadSessionTusMetadata(uploadSessionId: id),
                                    partSizeBytes: 16_777_216, bytesReceived: 0, expiresAt: Date().addingTimeInterval(3600), createdAt: Date(),
                                    uploadToken: "upload-token-\(id.uuidString.lowercased())", uploadTokenExpiresAt: Date().addingTimeInterval(3600))
    }

    func session(id: UUID) async throws -> UploadSession {
        UploadSession(id: id, materialId: lock.withLock { sessions[id] } ?? UUID(), kind: .original, state: .verified, sizeBytes: 1,
                      tusEndpoint: "https://ingest.example.invalid/files/", tusMetadata: UploadSessionTusMetadata(uploadSessionId: id),
                      partSizeBytes: 16_777_216, bytesReceived: 1, expiresAt: Date(), receiptNumber: "R-202611-000001", createdAt: Date())
    }

    func complete(idempotencyKey: String, id: UUID, reportedSha256: String?) async throws {}
    func abort(idempotencyKey: String, id: UUID) async throws {}

    /// مادة رابط رفع tus (آخر مقطع فيه معرّف الجلسة).
    func material(ofUploadURL url: URL) -> UUID? {
        UUID(uuidString: url.lastPathComponent).flatMap { id in lock.withLock { sessions[id] } }
    }
}

/// الطابور كله (ADR 0113): حتى `maxConcurrentTransfers` سجلات تُبصم وتُنقل في وقت واحد بترتيب الطابور، والأجزاء على القرص من
/// ميزانية مشتركة، وامتلاء القرص انتظار يُعاد لا فشل.
final class TransferQueueTests: XCTestCase {
    struct Queue {
        let dir = Fixtures.tempDir("queue")
        let source: URL
        let bytes: Data
        let api = SequentialUploadAPI()
        let transport = MultiUploadTransport()
        let engine: UploadEngine
        var chunkFiles: [String] { (try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("chunks").path)) ?? [] }

        init(cap: Int, budget: Int64? = nil, size: Int = 10) {
            (source, bytes) = Fixtures.sourceFile(in: dir, bytes: size)
            var policy = Fixtures.smallChunks
            policy.maxConcurrentTransfers = cap
            if let budget { policy.sharedChunkBudgetBytes = budget }
            let clock = TestClock()
            var env = UploadEngine.Environment()
            env.now = { clock.now() }
            engine = UploadEngine(store: InMemoryUploadStateStore(), secrets: InMemoryUploadSecretStore(), api: api, transport: transport,
                                  slicer: ChunkSlicer(chunksDirectory: dir.appendingPathComponent("chunks")), policy: policy,
                                  timing: Fixtures.fastTiming, environment: env)
        }

        func enqueue(_ kind: UploadSessionCreate.Kind = .original) async throws -> UploadRecord {
            try await engine.enqueue(sourcePath: source.path, materialId: UUID(), kind: kind, filename: "clip.mov", mimeType: "video/quicktime",
                                     proxyMode: kind == .proxy ? .urgent : nil)
        }

        func allTerminal(_ ids: [UUID]) async -> Bool {
            await eventually { await engine.allRecords().filter { ids.contains($0.id) }.allSatisfy { $0.phase.isTerminal } }
        }
    }

    func testOneTransferAtATimeInQueueOrder() async throws {
        let q = Queue(cap: 1)
        await q.engine.resumeAll()
        let recs = [try await q.enqueue(), try await q.enqueue(), try await q.enqueue()]
        let finished = await q.allTerminal(recs.map(\.id))
        XCTAssertTrue(finished)
        for rec in recs {
            let done = await q.engine.record(rec.id)
            XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202611-000001"))
        }
        XCTAssertEqual(q.api.createdMaterials, recs.map(\.materialId), "sessions in the order the files entered the queue")
        XCTAssertEqual(q.transport.maxOpen, 1, "the next upload starts after the previous one reached the server in full")
    }

    func testTwoTransfersAtMostAndTheRestWaitWithoutASession() async throws {
        let q = Queue(cap: 2)
        await q.engine.resumeAll()
        q.transport.holding = true
        let recs = [try await q.enqueue(), try await q.enqueue(), try await q.enqueue(), try await q.enqueue()]
        let bothInFlight = await eventually { q.transport.heldCount == 2 }
        XCTAssertTrue(bothInFlight)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(Set(q.api.createdMaterials), Set(recs.prefix(2).map(\.materialId)), "only the first two have a session")
        let waiting = await q.engine.waitingForTransferSlot()
        XCTAssertEqual(waiting, Set(recs.suffix(2).map(\.id)), "the other two wait their turn")
        for rec in recs.suffix(2) {
            let r = await q.engine.record(rec.id)
            XCTAssertEqual(r?.phase, .hashing, "not even hashed while waiting: no read of the whole file in parallel")
        }

        await q.transport.releaseHeld()
        let finished = await q.allTerminal(recs.map(\.id))
        XCTAssertTrue(finished)
        XCTAssertLessThanOrEqual(q.transport.maxOpen, 2)
        XCTAssertEqual(Set(q.api.createdMaterials.suffix(2)), Set(recs.suffix(2).map(\.materialId)))
        let none = await q.engine.waitingForTransferSlot()
        XCTAssertTrue(none.isEmpty)
    }

    /// النسخة الخفيفة أولًا (ADR 0075) ولو امتلأت الأماكن: الأصل الجاري يتخلى عن مكانه عند حدّ الجزء التالي ثم يكمل.
    func testLightCopyTakesTheSlotAtTheNextChunkBoundary() async throws {
        let q = Queue(cap: 1)
        await q.engine.resumeAll()
        q.transport.holding = true
        let original = try await q.enqueue(.original)
        let firstChunk = await eventually { q.transport.heldCount == 1 }
        XCTAssertTrue(firstChunk)
        let proxy = try await q.enqueue(.proxy)
        try await Task.sleep(nanoseconds: 100_000_000)
        let waiting = await q.engine.waitingForTransferSlot()
        XCTAssertEqual(waiting, [proxy.id])

        await q.transport.releaseHeld()
        let finished = await q.allTerminal([original.id, proxy.id])
        XCTAssertTrue(finished)
        var runs: [UUID] = []
        for material in q.transport.patchLog.compactMap(q.api.material(ofUploadURL:)) where runs.last != material { runs.append(material) }
        XCTAssertEqual(runs, [original.materialId, proxy.materialId, original.materialId],
                       "one chunk of the original, then the whole light copy, then the rest of the original")
    }

    func testChunksOnDiskStayWithinTheSharedBudget() async throws {
        // جزء من 4 بايت ونافذة من جزءين لكل سجل؛ الميزانية ثلاثة أجزاء للطابور كله، لا أربعة.
        let q = Queue(cap: 2, budget: 12, size: 20)
        await q.engine.resumeAll()
        q.transport.holding = true
        let a = try await q.enqueue()
        let b = try await q.enqueue()
        let bothInFlight = await eventually { q.transport.heldCount == 2 }
        XCTAssertTrue(bothInFlight)
        XCTAssertEqual(q.chunkFiles.count, 3, "each transfer has its chunk in flight, and one look-ahead chunk for the queue")

        await q.transport.releaseHeld()
        let finished = await q.allTerminal([a.id, b.id])
        XCTAssertTrue(finished)
        for id in [a.id, b.id] {
            let done = await q.engine.record(id)
            XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202611-000001"))
        }
        XCTAssertTrue(q.chunkFiles.isEmpty)
    }

    func testSharedBudgetLimitsLookAheadButNeverTheFirstChunk() {
        let one = [PreparedChunk(offset: 0, length: 64, fileName: "a")]
        XCTAssertEqual(ChunkPlanner.chunksToPrepare(sizeBytes: 1000, confirmedOffset: 0, chunkSize: 64, prepared: [], window: 2, budgetBytes: 100).map(\.offset), [0])
        XCTAssertEqual(ChunkPlanner.chunksToPrepare(sizeBytes: 1000, confirmedOffset: 0, chunkSize: 64, prepared: [], window: 2, budgetBytes: -500).map(\.offset), [0],
                       "a transfer with nothing on disk always gets its next chunk, or it would never move")
        XCTAssertTrue(ChunkPlanner.chunksToPrepare(sizeBytes: 1000, confirmedOffset: 0, chunkSize: 64, prepared: one, window: 2, budgetBytes: 63).isEmpty)
        XCTAssertEqual(ChunkPlanner.chunksToPrepare(sizeBytes: 1000, confirmedOffset: 0, chunkSize: 64, prepared: [], window: 2, budgetBytes: 128).map(\.offset), [0, 64])
        let policy = ChunkSizePolicy()
        XCTAssertEqual(policy.maxConcurrentTransfers, 2)
        XCTAssertEqual(policy.sharedChunkBudgetBytes, 3 * policy.backgroundMinBytes, "three background chunks for the whole queue")
    }

    // MARK: امتلاء القرص

    func testDiskFullWhilePreparingAChunkWaitsAndRetriesInsteadOfFailing() async throws {
        let dir = Fixtures.tempDir("enospc")
        let (source, bytes) = Fixtures.sourceFile(in: dir, bytes: 10)
        let chunks = dir.appendingPathComponent("chunks")
        let full = FlagBox(true)
        let slicer = ChunkSlicer(chunksDirectory: chunks) { handle, data in
            if full.value { throw CocoaError(.fileWriteOutOfSpace) }
            try handle.write(contentsOf: data)
        }
        let transport = FakeTransport()
        var timing = Fixtures.fastTiming
        timing.retryDelays = [0.05]
        let engine = UploadEngine(store: InMemoryUploadStateStore(), secrets: InMemoryUploadSecretStore(), api: FakeUploadAPI(), transport: transport,
                                  slicer: slicer, policy: Fixtures.smallChunks, timing: timing)
        await engine.resumeAll()
        let rec = try await engine.enqueue(sourcePath: source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime")

        let waiting = await eventually { await engine.waitingForSpace().contains(rec.id) }
        XCTAssertTrue(waiting, "the screen can say the phone is full")
        let stuck = await engine.record(rec.id)
        XCTAssertEqual(stuck?.phase, .transferring, "never source_missing: the original is intact")
        XCTAssertEqual(stuck?.lastErrorCode, "outOfSpace")
        XCTAssertTrue(((try? FileManager.default.contentsOfDirectory(atPath: chunks.path)) ?? []).isEmpty, "the half-written chunk is removed")

        full.value = false // the reporter freed some space
        let done = await engine.waitUntil(rec.id) { $0.phase.isTerminal }
        XCTAssertEqual(done?.phase, .verified(receiptNumber: "R-202610-000042"))
        XCTAssertEqual(transport.serverBytes, bytes)
        let cleared = await engine.waitingForSpace()
        XCTAssertTrue(cleared.isEmpty)
    }

    func testOutOfSpaceIsRecognisedHoweverThePlatformReportsIt() {
        let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))
        XCTAssertTrue(UploadError.isOutOfSpace(CocoaError(.fileWriteOutOfSpace)))
        XCTAssertTrue(UploadError.isOutOfSpace(posix))
        XCTAssertTrue(UploadError.isOutOfSpace(NSError(domain: NSPOSIXErrorDomain, code: Int(EDQUOT))))
        XCTAssertTrue(UploadError.isOutOfSpace(NSError(domain: NSCocoaErrorDomain, code: CocoaError.Code.fileWriteUnknown.rawValue,
                                                       userInfo: [NSUnderlyingErrorKey: posix])))
        XCTAssertTrue(UploadError.isOutOfSpace(UploadError.outOfSpace))
        XCTAssertFalse(UploadError.isOutOfSpace(CocoaError(.fileReadNoSuchFile)), "a missing original is still source_missing")
        XCTAssertFalse(UploadError.isOutOfSpace(UploadError.sourceTruncated))
        XCTAssertFalse(UploadError.isOutOfSpace(TusError.transport("-1001")))
    }
}

final class FlagBox: @unchecked Sendable {
    private let lock = NSLock()
    private var flag: Bool
    init(_ value: Bool) { flag = value }
    var value: Bool {
        get { lock.withLock { flag } }
        set { lock.withLock { flag = newValue } }
    }
}
