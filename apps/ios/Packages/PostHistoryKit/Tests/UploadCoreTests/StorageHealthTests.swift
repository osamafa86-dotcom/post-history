import XCTest
import PostHistoryAPI
@testable import UploadCore

/// مخزن حالة يفشل حفظه حين يُطلب منه (قرص ممتلئ أو مقفل)، وما سبق حفظه يبقى كما هو.
final class FlakyStateStore: UploadStateStore, @unchecked Sendable {
    struct DiskFull: Error {}
    private let lock = NSLock()
    private let inner = InMemoryUploadStateStore()
    private var failing = false

    var failSaves: Bool {
        get { lock.withLock { failing } }
        set { lock.withLock { failing = newValue } }
    }

    func loadAll() throws -> [UploadRecord] { try inner.loadAll() }
    func save(_ record: UploadRecord) throws {
        if failSaves { throw DiskFull() }
        try inner.save(record)
    }
    func remove(id: UUID) throws { try inner.remove(id: id) }
}

/// ADR 0113 (تعديل 2026-11-11): سجل لا يُقرأ أو لا يُفك ترميزه لا يختفي صامتًا، والحفظ الفاشل يُعلَن ويُعاد.
final class StorageHealthTests: XCTestCase {
    private func record(_ now: Date = Date()) -> UploadRecord {
        UploadRecord(materialId: UUID(), kind: .original, proxyMode: nil, sourcePath: "clip.mov", filename: "clip.mov", mimeType: nil, sizeBytes: 10, now: now)
    }

    private func recordFile(in directory: URL, _ contents: String) throws -> URL {
        let url = directory.appendingPathComponent("\(UUID().uuidString.lowercased()).json")
        try Data(contents.utf8).write(to: url)
        return url
    }

    private func makeEngine(store: any UploadStateStore, dir: URL, timing: UploadEngine.Timing = Fixtures.fastTiming) -> UploadEngine {
        UploadEngine(store: store, secrets: InMemoryUploadSecretStore(), api: FakeUploadAPI(), transport: FakeTransport(script: [.hang]),
                     slicer: ChunkSlicer(chunksDirectory: dir.appendingPathComponent("chunks")), policy: Fixtures.smallChunks, timing: timing)
    }

    func testTheFileStoreCountsWhatItCannotDecodeAndLeavesItOnDisk() throws {
        let dir = Fixtures.tempDir("store-undecodable")
        let store = try FileUploadStateStore(directory: dir)
        let good = record()
        try store.save(good)
        let damaged = try recordFile(in: dir, "{ not a record")
        // شكل أقدم ينقصه ما يلزم السجل اليوم
        let older = try recordFile(in: dir, "{\"id\":\"\(UUID().uuidString)\"}")

        let snapshot = try store.loadSnapshot()
        XCTAssertEqual(snapshot.records.map(\.id), [good.id])
        XCTAssertEqual(snapshot.undecodable, 2)
        XCTAssertEqual(snapshot.unreadable, 0)
        XCTAssertEqual(try store.loadAll().map(\.id), [good.id], "loadAll still returns what it can read")
        XCTAssertTrue(FileManager.default.fileExists(atPath: damaged.path), "kept on disk, not dropped")
        XCTAssertTrue(FileManager.default.fileExists(atPath: older.path), "kept on disk, not dropped")
    }

    func testResumeReportsRecordsItCouldNotDecodeAndStillLoadsTheRest() async throws {
        let dir = Fixtures.tempDir("resume-undecodable")
        let stateDir = dir.appendingPathComponent("state")
        let store = try FileUploadStateStore(directory: stateDir)
        var paused = record()
        paused.isPaused = true
        try store.save(paused)
        _ = try recordFile(in: stateDir, "{ not a record")

        let engine = makeEngine(store: store, dir: dir)
        var events: [UploadEvent] = []
        let stream = await engine.events()
        let collector = Task { for await e in stream { events.append(e); if e == .storageHealthChanged { break } } }
        await engine.resumeAll()

        let health = await engine.storageHealth()
        XCTAssertEqual(health, UploadStorageHealth(unreadableRecords: 0, undecodableRecords: 1, unsavedRecords: 0))
        XCTAssertFalse(health.isHealthy)
        let loaded = await engine.allRecords()
        XCTAssertEqual(loaded.map(\.id), [paused.id], "the readable record is in the queue")
        let announced = await eventually { await engine.storageHealth().undecodableRecords == 1 }
        XCTAssertTrue(announced)
        collector.cancel()
        _ = await collector.result
        XCTAssertTrue(events.contains(.storageHealthChanged), "subscribers are told")
    }

    func testAHealthyStoreReportsNothing() async throws {
        let dir = Fixtures.tempDir("resume-healthy")
        let engine = makeEngine(store: InMemoryUploadStateStore(), dir: dir)
        await engine.resumeAll()
        let health = await engine.storageHealth()
        XCTAssertEqual(health, UploadStorageHealth())
        XCTAssertTrue(health.isHealthy)
    }

    func testAFailedSaveIsAnnouncedKeptInMemoryAndWrittenOnceTheStoreRecovers() async throws {
        let dir = Fixtures.tempDir("save-fails")
        let (source, _) = Fixtures.sourceFile(in: dir, bytes: 10)
        let store = FlakyStateStore()
        var timing = Fixtures.fastTiming
        timing.unsavedRetryInterval = 0.02
        let engine = makeEngine(store: store, dir: dir, timing: timing)
        await engine.resumeAll()
        let rec = try await engine.enqueue(sourcePath: source.path, materialId: UUID(), kind: .original, filename: "clip.mov", mimeType: "video/quicktime")
        // السجل ينقل جزءه الأول والناقل معلّق: آخر ما على القرص حالته أثناء النقل
        _ = await engine.waitUntil(rec.id) { $0.inFlightOffset == 0 }

        store.failSaves = true
        await engine.pause(rec.id)
        let inMemory = await engine.record(rec.id)
        XCTAssertEqual(inMemory?.isPaused, true, "the change is not lost in memory")
        let unsaved = await engine.storageHealth().unsavedRecords
        XCTAssertEqual(unsaved, 1, "the failed save is reported, not swallowed")
        XCTAssertNotEqual(try store.loadAll().first?.isPaused, true, "the disk still holds the earlier state")

        store.failSaves = false
        let recovered = await eventually { await engine.storageHealth().unsavedRecords == 0 }
        XCTAssertTrue(recovered, "the record is written again on its own once the store accepts writes")
        XCTAssertEqual(try store.loadAll().first?.isPaused, true, "the latest state reached the disk")
    }

    func testWipeRemovesRecordFilesItCouldNotDecodeAndResetsTheReport() async throws {
        let dir = Fixtures.tempDir("wipe-undecodable")
        let stateDir = dir.appendingPathComponent("state")
        let store = try FileUploadStateStore(directory: stateDir)
        let damaged = try recordFile(in: stateDir, "{ not a record")
        let engine = makeEngine(store: store, dir: dir)
        await engine.resumeAll()
        let before = await engine.storageHealth()
        XCTAssertEqual(before.undecodableRecords, 1)

        _ = await engine.wipeAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: damaged.path), "an emergency wipe leaves no record file behind")
        let after = await engine.storageHealth()
        XCTAssertEqual(after, UploadStorageHealth())
    }
}
